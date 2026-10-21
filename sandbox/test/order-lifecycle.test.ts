/**
 * The order lifecycle module, tested in-process through its interface only: receiveOrder, applyStep,
 * requireStep, requireAddressEditable and isCancelRejectionReason. Webhook events are read from the
 * deliveries the module emits; timers the module schedules are held back and run by the test.
 *
 * Ways the lifecycle could fail, each covered below:
 *  1. A step is allowed from a status it should refuse, or refused from one it should allow.
 *  2. A refusal has the wrong code, message, field or status order, or leaves a trace: a moved sequence,
 *     a history entry, or an event for a step that did not happen.
 *  3. `sequence` moves twice for one step, not at all, or the events of one step carry different values.
 *  4. History misses a status change, records a no-op, or loses the `reassigning` note.
 *  5. A hold survives leaving on_hold, or a repeated identical change is recorded again.
 *  6. `advance` takes a different step than the table says, or does not refuse at a final status.
 *  7. A step emits the wrong event type, payload or order: charge amount rounding, one delivered event per
 *     shipment, refund amount, cancellation refund shape.
 *  8. Intake ignores the store mode, the velocity review, a missing phone or a missing payment method,
 *     or acts on an order that already left `received`.
 *  9. Release picks the wrong next status for a hold.
 * 10. Cancellation: a final order errors instead of being accepted, a closed window or a running payment
 *     is not refused, an unsubmitted order waits instead of cancelling, the auto-resolve timer cancels twice
 *     or after the outcome was already decided, or an outcome is accepted when no cancellation is waiting.
 * 11. A shipment exception moves the sequence, or is reported for an order that never shipped.
 * 12. Address edits are allowed after the parcel left, or refused with the wrong message.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createSandbox, type RunningSandbox } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Sandbox } from '../src/context.ts';
import { ApiError } from '../src/errors.ts';
import {
  applyStep,
  type IntakeRoute,
  isCancelRejectionReason,
  type NewOrderDetails,
  type OrderStep,
  receiveOrder,
  requireAddressEditable,
  requireStep,
} from '../src/order-lifecycle.ts';
import type { HoldCode, Order, OrderStatus } from '../src/state.ts';
import type { EventData } from './harness.ts';

let running: RunningSandbox;
let sandbox: Sandbox;
let heldTasks: (() => void)[];
let externalNumber = 0;

before(() => {
  running = createSandbox(loadConfig({ SANDBOX_LOG_REQUESTS: 'false' }));
  sandbox = running.sandbox;
  sandbox.later = (task) => void heldTasks.push(task);
});

after(() => running.close());

beforeEach(() => {
  heldTasks = [];
  sandbox.state.deliveries.length = 0;
  sandbox.state.store.fulfillmentMode = 'instant';
  sandbox.state.store.paymentMethodReady = true;
});

const runHeldTasks = (): void => {
  const tasks = heldTasks.splice(0);
  tasks.forEach((task) => task());
};

function orderDetails(phone: string | null = '+971501234567'): NewOrderDetails {
  const product = [...sandbox.state.products.values()][0];
  const variant = product?.variants[0];
  const group = [...sandbox.state.providerGroups.keys()][0];
  assert.ok(product && variant && group, 'the seeded catalog has a product and a provider group');
  externalNumber += 1;
  return {
    externalOrderId: `LC-${externalNumber}`,
    displayNumber: null,
    currency: 'AED',
    items: [{ variantId: variant.id, productId: product.id, quantity: 1, unitPrice: '79.00', externalLineId: null }],
    costs: { productionCents: 3250, shippingCents: 1500, brandingCents: 0, feeCents: 300, basis: 'estimated' },
    requestHash: `hash-${externalNumber}`,
    address: { name: 'Sara', phone, email: null, address1: 'Marina Walk 1', address2: null, city: 'Dubai', state: 'Dubai', postalCode: null, country: 'AE' },
    customerEmail: 'buyer@example.com',
    providerGroupId: group,
  };
}

/** A new order, still `received`: production has not processed it yet. */
const receive = (route: IntakeRoute = 'store_fulfillment_mode', phone?: string | null): Order => receiveOrder(sandbox, orderDetails(phone), route);

/** A new order after intake: submitted and waiting for a provider. */
function submitted(): Order {
  const order = receive();
  runHeldTasks();
  assert.equal(order.status, 'awaiting_provider');
  return order;
}

const step = (order: Order, orderStep: OrderStep): void => applyStep(sandbox, order, orderStep);

/** Reaches each status through the lifecycle's own steps. */
function orderAt(status: OrderStatus): Order {
  if (status === 'received') return receive();
  if (status === 'rejected') {
    const order = receive();
    step(order, { name: 'reject' });
    return order;
  }
  const order = submitted();
  const path: Record<Exclude<OrderStatus, 'received' | 'rejected'>, OrderStep[]> = {
    awaiting_provider: [],
    awaiting_payment: [{ name: 'accept' }],
    in_production: [{ name: 'accept' }, { name: 'charge' }],
    shipped: [{ name: 'accept' }, { name: 'charge' }, { name: 'ship' }],
    delivered: [{ name: 'accept' }, { name: 'charge' }, { name: 'ship' }, { name: 'deliver' }],
    returned: [{ name: 'accept' }, { name: 'charge' }, { name: 'ship' }, { name: 'deliver' }, { name: 'returned' }],
    refunded: [{ name: 'refund' }],
    on_hold: [{ name: 'hold', code: 'payment_failed' }],
    cancelled: [{ name: 'request_cancellation' }, { name: 'resolve_cancellation', outcome: 'accepted' }],
  };
  path[status].forEach((orderStep) => step(order, orderStep));
  assert.equal(order.status, status);
  return order;
}

const eventsOf = (order: Order) =>
  sandbox.state.deliveries
    .filter((delivery) => delivery.resourceKey === `order:${order.id}`)
    .map((delivery) => ({ type: delivery.eventType, sequence: delivery.sequence, data: delivery.data as EventData }));

const eventTypes = (order: Order): string[] => eventsOf(order).map((event) => event.type);

/** What a step may leave behind: nothing, when it is refused. */
const snapshot = (order: Order) => ({
  status: order.status,
  sequence: order.sequence,
  history: order.statusHistory.length,
  events: sandbox.state.deliveries.length,
});

function assertRefused(order: Order, run: () => void, expected: { code: string; message: string; field: string | null }): void {
  const before = snapshot(order);
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.deepEqual({ code: error.code, message: error.message, field: error.field }, expected);
    return true;
  });
  assert.deepEqual(snapshot(order), before, 'a refused step leaves no trace');
}

const validationFailure = (message: string, field: string | null = null) => ({ code: 'validation_failed', message, field });

describe('transition table', () => {
  const ALL_STATUSES: OrderStatus[] = ['received', 'on_hold', 'awaiting_provider', 'awaiting_payment', 'in_production', 'shipped', 'delivered', 'returned', 'refunded', 'cancelled', 'rejected'];
  const GUARDED: { step: OrderStep; from: OrderStatus[] }[] = [
    { step: { name: 'accept' }, from: ['awaiting_provider'] },
    { step: { name: 'charge' }, from: ['awaiting_payment', 'on_hold'] },
    { step: { name: 'reassign' }, from: ['awaiting_payment', 'in_production'] },
    { step: { name: 'ship' }, from: ['in_production', 'shipped'] },
    { step: { name: 'reject' }, from: ['received', 'on_hold'] },
    { step: { name: 'return', status: 'requested', actionRequired: false }, from: ['delivered'] },
    { step: { name: 'returned' }, from: ['delivered'] },
  ];

  for (const { step: guarded, from } of GUARDED) {
    test(`${guarded.name} is allowed from ${from.join(' or ')} and refused everywhere else`, () => {
      for (const status of ALL_STATUSES) {
        const order = orderAt(status);
        if (from.includes(status)) {
          assert.doesNotThrow(() => step(order, guarded), `${guarded.name} from ${status}`);
        } else {
          assertRefused(order, () => step(order, guarded), validationFailure(`This step needs the order to be ${from.join(' or ')}; it is ${status}.`, 'status'));
        }
      }
    });
  }

  test('requireStep refuses before any input is read and changes nothing', () => {
    const order = submitted();
    assertRefused(order, () => requireStep(order, 'ship'), validationFailure('This step needs the order to be in_production or shipped; it is awaiting_provider.', 'status'));
    assert.doesNotThrow(() => requireStep(order, 'accept'));
    assert.doesNotThrow(() => requireStep(order, 'hold'), 'a step without a table entry is allowed anywhere');
  });

  test('hold and refund have no status guard', () => {
    for (const status of ALL_STATUSES) {
      assert.doesNotThrow(() => step(orderAt(status), { name: 'hold', code: 'payment_review' }), `hold from ${status}`);
      assert.doesNotThrow(() => step(orderAt(status), { name: 'refund' }), `refund from ${status}`);
    }
  });
});

describe('advance', () => {
  const NEXT_STATUS: [OrderStatus, OrderStatus][] = [
    ['received', 'awaiting_provider'],
    ['on_hold', 'awaiting_provider'],
    ['awaiting_provider', 'awaiting_payment'],
    ['awaiting_payment', 'in_production'],
    ['in_production', 'shipped'],
    ['shipped', 'delivered'],
  ];

  for (const [from, to] of NEXT_STATUS) {
    test(`from ${from} it goes to ${to}`, () => {
      const order = orderAt(from);
      step(order, { name: 'advance' });
      assert.equal(order.status, to);
    });
  }

  test('it takes the same step a caller would name, with the same events', () => {
    const viaAdvance = orderAt('awaiting_payment');
    const viaName = orderAt('awaiting_payment');
    step(viaAdvance, { name: 'advance' });
    step(viaName, { name: 'charge' });
    assert.deepEqual(eventTypes(viaAdvance).slice(-2), eventTypes(viaName).slice(-2));
    assert.equal(viaAdvance.sequence, viaName.sequence);
  });

  test('from in_production it ships by carrier', () => {
    const order = orderAt('in_production');
    step(order, { name: 'advance' });
    assert.equal(order.shipments[0]?.method, 'carrier');
    assert.match(order.shipments[0]?.trackingNumber ?? '', /^SBX\d+$/);
  });

  for (const status of ['delivered', 'returned', 'refunded', 'cancelled', 'rejected'] as const) {
    test(`from ${status} it refuses`, () => {
      const order = orderAt(status);
      assertRefused(order, () => step(order, { name: 'advance' }), validationFailure(`There is no next step after ${status}.`, 'status'));
    });
  }
});

describe('sequence and history', () => {
  test('a new order starts at sequence 1 with one history entry', () => {
    const order = receive();
    assert.equal(order.status, 'received');
    assert.equal(order.sequence, 1);
    assert.deepEqual(order.statusHistory.map((entry) => entry.status), ['received']);
    assert.deepEqual(eventTypes(order), [], 'production answers before it processes the order');
  });

  test('one status change moves the sequence once and every event of the step shares it', () => {
    const order = orderAt('awaiting_payment');
    const before = order.sequence;
    step(order, { name: 'charge' });
    assert.equal(order.sequence, before + 1);
    const events = eventsOf(order).slice(-2);
    assert.deepEqual(events.map((event) => event.type), ['order.status_changed', 'order.charged']);
    assert.deepEqual(events.map((event) => event.sequence), [order.sequence, order.sequence]);
    assert.equal(events[0]?.data.previous_status, 'awaiting_payment');
  });

  test('sequences only go up across a full journey', () => {
    const order = orderAt('delivered');
    const sequences = eventsOf(order).map((event) => event.sequence ?? 0);
    assert.deepEqual([...sequences].sort((a, b) => a - b), sequences);
  });

  test('history records each status change with the hold reason', () => {
    const order = submitted();
    step(order, { name: 'hold', code: 'payment_failed' });
    assert.deepEqual(order.statusHistory.map((entry) => [entry.status, entry.holdReason]), [
      ['received', null],
      ['awaiting_provider', null],
      ['on_hold', 'payment_failed'],
    ]);
  });

  test('reassigning leaves the note "reassigning" from awaiting_payment and from in_production, and only there', () => {
    for (const from of ['awaiting_payment', 'in_production'] as const) {
      const order = orderAt(from);
      step(order, { name: 'reassign' });
      assert.equal(order.status, 'awaiting_provider');
      assert.equal(order.statusHistory.at(-1)?.note, 'reassigning');
      assert.ok(order.statusHistory.slice(0, -1).every((entry) => entry.note === null));
    }
  });

  test('leaving on_hold clears the hold', () => {
    const order = orderAt('on_hold');
    assert.equal(order.hold?.code, 'payment_failed');
    step(order, { name: 'charge' });
    assert.equal(order.hold, null);
  });

  test('a hold with the same code again changes nothing but still reports the payment problem', () => {
    const order = submitted();
    step(order, { name: 'hold', code: 'payment_failed' });
    const sequence = order.sequence;
    const history = order.statusHistory.length;
    step(order, { name: 'hold', code: 'payment_failed' });
    assert.equal(order.sequence, sequence);
    assert.equal(order.statusHistory.length, history);
    const [lastEvent] = eventsOf(order).slice(-1);
    assert.deepEqual([lastEvent?.type, lastEvent?.sequence], ['order.payment_failed', sequence]);
    assert.equal(eventTypes(order).filter((type) => type === 'order.status_changed').length, 2);
  });

  test('a return update moves the sequence and emits return.status_changed without touching history', () => {
    const order = orderAt('delivered');
    const [sequence, history] = [order.sequence, order.statusHistory.length];
    step(order, { name: 'return', status: 'requested', actionRequired: true });
    assert.equal(order.sequence, sequence + 1);
    assert.equal(order.statusHistory.length, history);
    assert.deepEqual(order.returnInfo, { status: 'requested', actionRequired: true });
    const [event] = eventsOf(order).slice(-1);
    assert.deepEqual([event?.type, event?.sequence], ['return.status_changed', order.sequence]);
    assert.deepEqual(event?.data.order?.return, { status: 'requested', action_required: true });
  });

  test('repeating the same return update is a no-op', () => {
    const order = orderAt('delivered');
    step(order, { name: 'return', status: 'in_transit', actionRequired: false });
    const before = snapshot(order);
    step(order, { name: 'return', status: 'in_transit', actionRequired: false });
    assert.deepEqual(snapshot(order), before);
  });
});

describe('events per step', () => {
  test('charge rounds the charged amount to whole units and fixes the cost basis', () => {
    const order = orderAt('awaiting_payment');
    step(order, { name: 'charge' });
    const charged = eventsOf(order).find((event) => event.type === 'order.charged');
    assert.deepEqual(
      { ...charged?.data.charge, charged_at: typeof charged?.data.charge?.charged_at },
      { amount: '51.00', currency: 'AED', charged_at: 'string', invoice_url: null },
    );
    assert.equal(order.charged, true);
    assert.equal(charged?.data.order?.costs.basis, 'final');
  });

  test('ship by carrier books tracking, own driver books none', () => {
    const carrier = orderAt('in_production');
    step(carrier, { name: 'ship', method: 'carrier' });
    const own = orderAt('in_production');
    step(own, { name: 'ship', method: 'own_driver' });
    const carrierShipment = eventsOf(carrier).find((event) => event.type === 'order.shipped')?.data.shipment;
    const ownShipment = eventsOf(own).find((event) => event.type === 'order.shipped')?.data.shipment;
    assert.ok(carrierShipment && ownShipment);
    assert.equal(carrierShipment.carrier, 'Sandbox Express');
    assert.equal(carrierShipment.tracking_url, `https://tracking.sandbox.invalid/${carrierShipment.tracking_number}`);
    assert.deepEqual([ownShipment.method, ownShipment.carrier, ownShipment.tracking_number, ownShipment.tracking_url], ['own_driver', null, null, null]);
  });

  test('deliver emits one order.delivered per waiting shipment, all with the sequence of the change', () => {
    const order = orderAt('shipped');
    step(order, { name: 'ship', method: 'own_driver' });
    step(order, { name: 'deliver' });
    const delivered = eventsOf(order).filter((event) => event.type === 'order.delivered');
    assert.equal(delivered.length, 2);
    assert.deepEqual(new Set(delivered.map((event) => event.data.shipment?.id)), new Set(order.shipments.map((shipment) => shipment.id)));
    assert.ok(delivered.every((event) => event.sequence === order.sequence));
    assert.ok(order.shipments.every((shipment) => shipment.deliveredAt));
  });

  test('deliver refuses an order whose shipments were all delivered', () => {
    const order = orderAt('delivered');
    assertRefused(order, () => step(order, { name: 'deliver' }), validationFailure('The order has no shipment waiting for delivery. Ship it first.'));
  });

  test('deliver refuses an order that never shipped', () => {
    const order = orderAt('in_production');
    assertRefused(order, () => step(order, { name: 'deliver' }), validationFailure('The order has no shipment waiting for delivery. Ship it first.'));
  });

  test('hold with a payment code sends the matching event with a retry link, others send none', () => {
    const failed = submitted();
    step(failed, { name: 'hold', code: 'payment_failed' });
    const expired = submitted();
    step(expired, { name: 'hold', code: 'payment_expired', detailCode: 'card_expired' });
    const review = submitted();
    step(review, { name: 'hold', code: 'personalization_review' });
    const failedEvent = eventsOf(failed).find((event) => event.type === 'order.payment_failed');
    assert.equal(failedEvent?.data.retry_url, `${sandbox.config.portalBaseUrl}/_sandbox/portal/orders/${failed.id}`);
    assert.equal(failedEvent?.data.order?.hold_reason?.detail_code, 'declined');
    assert.equal(eventsOf(expired).find((event) => event.type === 'order.payment_expired')?.data.order?.hold_reason?.detail_code, 'card_expired');
    assert.deepEqual(eventTypes(review).slice(-1), ['order.status_changed']);
    assert.equal(review.hold?.detailCode, null);
  });

  test('refund defaults to the order total and honours an explicit amount', () => {
    const whole = submitted();
    step(whole, { name: 'refund' });
    const partial = submitted();
    step(partial, { name: 'refund', amountCents: 2500 });
    assert.deepEqual(eventsOf(whole).slice(-2).map((event) => event.type), ['order.status_changed', 'order.refunded']);
    assert.deepEqual(eventsOf(whole).at(-1)?.data.refund, { status: 'refunded', amount: '50.50', currency: 'AED' });
    assert.equal(eventsOf(partial).at(-1)?.data.refund?.amount, '25.00');
  });

  test('reject and returned move the status with only the status event', () => {
    const rejected = receive();
    step(rejected, { name: 'reject' });
    const returned = orderAt('delivered');
    const before = eventsOf(returned).length;
    step(returned, { name: 'returned' });
    assert.deepEqual(eventTypes(rejected), ['order.status_changed']);
    assert.equal(rejected.status, 'rejected');
    assert.deepEqual(eventsOf(returned).slice(before).map((event) => event.type), ['order.status_changed']);
  });

  test('a shipment exception reports the last shipment without moving status, sequence or history', () => {
    const order = orderAt('shipped');
    const before = snapshot(order);
    step(order, { name: 'report_shipment_exception', kind: 'on_hold' });
    assert.deepEqual(snapshot(order), { ...before, events: before.events + 1 });
    const [event] = eventsOf(order).slice(-1);
    assert.deepEqual([event?.type, event?.sequence, event?.data.kind, event?.data.shipment?.id], ['shipment.exception', order.sequence, 'on_hold', order.shipments[0]?.id]);
  });

  test('a shipment exception needs a shipment', () => {
    const order = orderAt('in_production');
    assertRefused(order, () => step(order, { name: 'report_shipment_exception', kind: 'exception' }), validationFailure('The order has no shipment. Ship it first.', 'status'));
  });
});

describe('intake and release', () => {
  test('intake submits an order of an instant store to awaiting_provider with a delivery estimate', () => {
    const order = receive();
    runHeldTasks();
    assert.equal(order.status, 'awaiting_provider');
    assert.equal(order.submitted, true);
    assert.ok(order.estimatedDelivery);
    assert.deepEqual(eventTypes(order), ['order.status_changed']);
    assert.equal(eventsOf(order)[0]?.data.previous_status, 'received');
  });

  const HELD_AT_INTAKE: { label: string; setup: () => IntakeRoute; phone?: string | null; hold: HoldCode; submitted: boolean }[] = [
    { label: 'a velocity review route', setup: () => 'review_hold', hold: 'velocity_review', submitted: false },
    {
      label: 'manual approval',
      setup: () => {
        sandbox.state.store.fulfillmentMode = 'manual_approval';
        return 'store_fulfillment_mode';
      },
      hold: 'awaiting_approval',
      submitted: false,
    },
    {
      label: 'delayed auto submit',
      setup: () => {
        sandbox.state.store.fulfillmentMode = 'delayed_auto_submit';
        return 'store_fulfillment_mode';
      },
      hold: 'delayed_submit',
      submitted: false,
    },
    { label: 'a missing phone', setup: () => 'store_fulfillment_mode', phone: null, hold: 'missing_phone', submitted: true },
    {
      label: 'a payment method that is not ready',
      setup: () => {
        sandbox.state.store.paymentMethodReady = false;
        return 'store_fulfillment_mode';
      },
      hold: 'payment_method_missing',
      submitted: true,
    },
  ];

  for (const held of HELD_AT_INTAKE) {
    test(`intake holds the order for ${held.label}`, () => {
      const order = receive(held.setup(), held.phone);
      runHeldTasks();
      assert.deepEqual([order.status, order.hold?.code, order.submitted], ['on_hold', held.hold, held.submitted]);
    });
  }

  test('the velocity review wins over the store mode', () => {
    sandbox.state.store.fulfillmentMode = 'manual_approval';
    const order = receive('review_hold');
    runHeldTasks();
    assert.equal(order.hold?.code, 'velocity_review');
  });

  test('intake leaves an order alone that is no longer received', () => {
    const order = receive();
    step(order, { name: 'reject' });
    const before = snapshot(order);
    runHeldTasks();
    assert.deepEqual(snapshot(order), before);
  });

  test('releasing an approval hold submits the order', () => {
    const reviewed = receive('review_hold');
    runHeldTasks();
    step(reviewed, { name: 'release' });
    assert.deepEqual([reviewed.status, reviewed.submitted], ['awaiting_provider', true]);
    sandbox.state.store.fulfillmentMode = 'manual_approval';
    const approval = receive();
    runHeldTasks();
    step(approval, { name: 'release' });
    assert.equal(approval.status, 'awaiting_provider');
  });

  test('releasing a missing_phone hold goes on to payment method check, then to the provider', () => {
    sandbox.state.store.paymentMethodReady = false;
    const order = receive('store_fulfillment_mode', null);
    runHeldTasks();
    assert.equal(order.hold?.code, 'missing_phone');
    step(order, { name: 'release' });
    assert.equal(order.hold?.code, 'payment_method_missing');
    sandbox.state.store.paymentMethodReady = true;
    step(order, { name: 'release' });
    assert.deepEqual([order.status, order.hold], ['awaiting_provider', null]);
  });

  test('releasing a payment hold goes straight to the provider', () => {
    const order = orderAt('on_hold');
    step(order, { name: 'release' });
    assert.equal(order.status, 'awaiting_provider');
  });

  test('release refuses an order that is not on hold', () => {
    const order = submitted();
    assertRefused(order, () => step(order, { name: 'release' }), validationFailure('The order is not on hold.'));
  });

  test('submit takes only a received order', () => {
    const order = receive();
    step(order, { name: 'submit' });
    assert.equal(order.status, 'awaiting_provider');
    assertRefused(order, () => step(order, { name: 'submit' }), validationFailure('This step needs the order to be received; it is awaiting_provider.', 'status'));
  });
});

describe('cancellation', () => {
  test('an order that was not submitted yet is cancelled at once, with no refund', () => {
    const order = receive();
    step(order, { name: 'request_cancellation' });
    assert.equal(order.status, 'cancelled');
    assert.deepEqual(eventTypes(order), ['order.status_changed', 'order.cancelled']);
    assert.deepEqual(eventsOf(order)[1]?.data.refund, { status: 'none', amount: null, currency: 'AED' });
    const before = snapshot(order);
    runHeldTasks();
    assert.deepEqual(snapshot(order), before, 'the intake that was still queued finds a cancelled order');
  });

  test('a submitted order waits for production, then the timer cancels it', () => {
    const order = submitted();
    step(order, { name: 'request_cancellation' });
    assert.deepEqual([order.status, order.cancelRequested], ['awaiting_provider', true]);
    runHeldTasks();
    assert.deepEqual([order.status, order.cancelRequested], ['cancelled', false]);
  });

  test('accepting the outcome cancels once; the timer then does nothing', () => {
    const order = submitted();
    step(order, { name: 'request_cancellation' });
    step(order, { name: 'resolve_cancellation', outcome: 'accepted' });
    const before = snapshot(order);
    runHeldTasks();
    assert.deepEqual(snapshot(order), before);
    assert.equal(eventTypes(order).filter((type) => type === 'order.cancelled').length, 1);
  });

  test('rejecting the outcome keeps the order and its sequence, and says why', () => {
    const order = submitted();
    step(order, { name: 'request_cancellation' });
    const sequence = order.sequence;
    step(order, { name: 'resolve_cancellation', outcome: 'rejected', reasonCode: 'production_started' });
    assert.deepEqual([order.status, order.cancelRequested, order.sequence], ['awaiting_provider', false, sequence]);
    const [event] = eventsOf(order).slice(-1);
    assert.deepEqual([event?.type, event?.sequence, event?.data.reason_code], ['order.cancel_rejected', sequence, 'production_started']);
    assert.equal(event?.data.message, 'Production has already started, so the order cannot be cancelled. It continues.');
    const before = snapshot(order);
    runHeldTasks();
    assert.deepEqual(snapshot(order), before, 'the timer finds no waiting cancellation');
  });

  test('an unknown reason code gets the generic message', () => {
    const order = submitted();
    step(order, { name: 'request_cancellation' });
    step(order, { name: 'resolve_cancellation', outcome: 'rejected', reasonCode: 'bogus' });
    assert.equal(eventsOf(order).at(-1)?.data.message, 'The order could not be cancelled automatically. It continues; contact support.');
    assert.deepEqual([isCancelRejectionReason('payment_in_progress'), isCancelRejectionReason('cancel_window_closed'), isCancelRejectionReason('bogus')], [true, true, false]);
  });

  test('an outcome needs a waiting cancellation, whichever it is', () => {
    const message = 'No cancellation is waiting. Call POST /merchant/v1/orders/{id}/cancel first.';
    const order = submitted();
    assertRefused(order, () => step(order, { name: 'resolve_cancellation', outcome: 'accepted' }), validationFailure(message, 'status'));
    assertRefused(order, () => step(order, { name: 'resolve_cancellation', outcome: 'rejected', reasonCode: 'production_started' }), validationFailure(message, 'status'));
    assertRefused(order, () => requireStep(order, 'resolve_cancellation'), validationFailure(message, 'status'));
  });

  test('a cancelled order that was charged shows a pending refund', () => {
    const order = submitted();
    step(order, { name: 'request_cancellation' });
    step(order, { name: 'accept' });
    step(order, { name: 'charge' });
    step(order, { name: 'resolve_cancellation', outcome: 'accepted' });
    assert.deepEqual(eventsOf(order).at(-1)?.data.refund, { status: 'pending', amount: '50.50', currency: 'AED' });
  });

  for (const status of ['cancelled', 'rejected'] as const) {
    test(`asking to cancel a ${status} order is accepted and changes nothing`, () => {
      const order = orderAt(status);
      const before = snapshot(order);
      step(order, { name: 'request_cancellation' });
      assert.deepEqual(snapshot(order), before);
    });
  }

  for (const status of ['in_production', 'shipped', 'delivered', 'returned', 'refunded'] as const) {
    test(`asking to cancel a ${status} order is refused: the window is closed`, () => {
      const order = orderAt(status);
      assertRefused(
        order,
        () => step(order, { name: 'request_cancellation' }),
        { code: 'cancel_window_closed', message: 'Production has started, so the order can no longer be cancelled here.', field: null },
      );
    });
  }

  test('asking to cancel while a payment runs is refused', () => {
    const paymentRunning = [orderAt('awaiting_payment')];
    for (const code of ['payment_review', 'payment_processing_unavailable'] as const) {
      const order = submitted();
      step(order, { name: 'hold', code });
      paymentRunning.push(order);
    }
    for (const order of paymentRunning) {
      assertRefused(order, () => step(order, { name: 'request_cancellation' }), {
        code: 'payment_in_progress',
        message: 'The payment for this order is being processed. Try again shortly.',
        field: null,
      });
    }
  });

  test('a failed-payment hold does not block a cancellation', () => {
    const order = orderAt('on_hold');
    step(order, { name: 'request_cancellation' });
    assert.equal(order.cancelRequested, true);
  });
});

describe('address edits', () => {
  for (const status of ['received', 'on_hold', 'awaiting_provider', 'awaiting_payment', 'in_production'] as const) {
    test(`allowed while ${status}`, () => {
      assert.doesNotThrow(() => requireAddressEditable(orderAt(status)));
    });
  }

  for (const status of ['shipped', 'delivered', 'returned', 'refunded'] as const) {
    test(`locked once ${status}`, () => {
      assert.throws(() => requireAddressEditable(orderAt(status)), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.deepEqual([error.code, error.message], ['address_locked', 'The address can no longer change for this order.']);
        return true;
      });
    });
  }

  for (const status of ['cancelled', 'rejected'] as const) {
    test(`locked with its own message when ${status}`, () => {
      assert.throws(() => requireAddressEditable(orderAt(status)), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.deepEqual([error.code, error.message], ['address_locked', 'This order is cancelled, so its address can no longer change.']);
        return true;
      });
    });
  }
});
