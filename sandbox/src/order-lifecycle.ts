import type { Sandbox } from './context.ts';
import { ApiError, validationFailed } from './errors.ts';
import { newOrderId, newShipmentId } from './ids.ts';
import { formatCents, roundToWholeUnits } from './money.ts';
import type { HoldCode, Order, OrderHold, OrderStatus, ReturnInfo, Shipment, WebhookEventType } from './state.ts';
import { orderView } from './views.ts';
import { emit } from './webhook-outbox.ts';

/**
 * The one place that knows which order status may follow which. Callers name a step and pass its inputs;
 * the sequence, status history and webhook events follow from the step.
 */

export const SHIPMENT_EXCEPTION_KINDS = ['returned', 'exception', 'on_hold'] as const;
export type ShipmentExceptionKind = (typeof SHIPMENT_EXCEPTION_KINDS)[number];

const CANCEL_REJECTION_MESSAGES: Record<string, string> = {
  payment_in_progress: "The order's payment is being processed, so it cannot be cancelled now. It continues.",
  cancel_window_closed: 'The order is waiting for a production partner, so it cannot be cancelled automatically. It continues.',
  production_started: 'Production has already started, so the order cannot be cancelled. It continues.',
};

export const isCancelRejectionReason = (value: string): boolean => Object.hasOwn(CANCEL_REJECTION_MESSAGES, value);

export type OrderStep =
  | { name: 'submit' }
  | { name: 'release' }
  | { name: 'accept' }
  | { name: 'charge' }
  | { name: 'reassign' }
  /** `method` defaults to a carrier shipment, which is also what `advance` books. */
  | { name: 'ship'; method?: Shipment['method'] }
  | { name: 'deliver' }
  | { name: 'reject' }
  /** `detailCode` defaults to `declined` for a failed payment and to none otherwise. */
  | { name: 'hold'; code: HoldCode; detailCode?: string }
  | { name: 'report_shipment_exception'; kind: ShipmentExceptionKind }
  | { name: 'request_cancellation' }
  | { name: 'resolve_cancellation'; outcome: 'accepted' }
  | { name: 'resolve_cancellation'; outcome: 'rejected'; reasonCode: string }
  | ({ name: 'return' } & ReturnInfo)
  | { name: 'returned' }
  /** `amountCents` defaults to the order total. */
  | { name: 'refund'; amountCents?: number }
  | { name: 'advance' };

type StepName = OrderStep['name'];
type AdvancingStepName = 'submit' | 'release' | 'accept' | 'charge' | 'ship' | 'deliver';

type StepRule = {
  /** Statuses the step may start from. Absent when the step applies in any status or checks something else. */
  from?: readonly OrderStatus[];
  /** Statuses where `advance` takes this step. */
  advancesFrom?: readonly OrderStatus[];
  /** What else the order must be in, checked together with `from` before a caller looks at the step's inputs. */
  requires?: (order: Order) => void;
};

const requireCancellationWaiting = (order: Order): void => {
  if (!order.cancelRequested) throw validationFailed('No cancellation is waiting. Call POST /merchant/v1/orders/{id}/cancel first.', 'status');
};

/** The transition table: `advance`, the scenario guards and the error text all read from here. */
const STEP_RULES: Record<StepName, StepRule> = {
  submit: { from: ['received'], advancesFrom: ['received'] },
  release: { advancesFrom: ['on_hold'] },
  accept: { from: ['awaiting_provider'], advancesFrom: ['awaiting_provider'] },
  charge: { from: ['awaiting_payment', 'on_hold'], advancesFrom: ['awaiting_payment'] },
  reassign: { from: ['awaiting_payment', 'in_production'] },
  ship: { from: ['in_production', 'shipped'], advancesFrom: ['in_production'] },
  deliver: { advancesFrom: ['shipped'] },
  reject: { from: ['received', 'on_hold'] },
  hold: {},
  report_shipment_exception: {},
  request_cancellation: {},
  resolve_cancellation: { requires: requireCancellationWaiting },
  return: { from: ['delivered'] },
  returned: { from: ['delivered'] },
  refund: {},
  advance: {},
};

const ADVANCING_STEPS: readonly AdvancingStepName[] = ['submit', 'release', 'accept', 'charge', 'ship', 'deliver'];

const APPROVAL_HOLDS = new Set<HoldCode>(['awaiting_approval', 'delayed_submit', 'personalization_review', 'velocity_review']);
const CANCEL_WINDOW_CLOSED = new Set<OrderStatus>(['in_production', 'shipped', 'delivered', 'returned', 'refunded']);
const LOCKED_AFTER_BOOKING = new Set<OrderStatus>(['shipped', 'delivered', 'returned', 'refunded']);

/** Where a new order goes once production has "processed" it: into a velocity review, or by the store's fulfillment mode. */
export type IntakeRoute = 'review_hold' | 'store_fulfillment_mode';

export type NewOrderDetails = Pick<
  Order,
  'externalOrderId' | 'displayNumber' | 'currency' | 'items' | 'costs' | 'requestHash' | 'address' | 'customerEmail' | 'providerGroupId'
>;

/** Production answers before it processes the order, so the first real status arrives later, by webhook. */
export function receiveOrder(sandbox: Sandbox, details: NewOrderDetails, route: IntakeRoute): Order {
  const now = new Date();
  const order: Order = {
    ...details,
    id: newOrderId(),
    status: 'received',
    hold: null,
    returnInfo: null,
    shipments: [],
    estimatedDelivery: null,
    createdAt: now,
    updatedAt: now,
    statusHistory: [{ status: 'received', holdReason: null, note: null, at: now }],
    sequence: 1,
    submitted: false,
    charged: false,
    cancelRequested: false,
  };
  sandbox.later(() => runIntake(sandbox, order, route), sandbox.config.asyncStepMs);
  return order;
}

/** Refuses a step the order cannot take now. Callers with a body to validate call this first, so a refused step never reports a body problem. */
export function requireStep(order: Order, name: StepName): void {
  const rule = STEP_RULES[name];
  if (rule.from && !rule.from.includes(order.status)) {
    throw validationFailed(`This step needs the order to be ${rule.from.join(' or ')}; it is ${order.status}.`, 'status');
  }
  rule.requires?.(order);
}

export function applyStep(sandbox: Sandbox, order: Order, step: OrderStep): void {
  requireStep(order, step.name);
  switch (step.name) {
    case 'submit':
      return submit(sandbox, order);
    case 'release':
      return release(sandbox, order);
    case 'accept':
      return applyChange(sandbox, order, { status: 'awaiting_payment' });
    case 'charge':
      return charge(sandbox, order);
    case 'reassign':
      return applyChange(sandbox, order, { status: 'awaiting_provider' });
    case 'ship':
      return ship(sandbox, order, step.method ?? 'carrier');
    case 'deliver':
      return deliver(sandbox, order);
    case 'reject':
      return applyChange(sandbox, order, { status: 'rejected' });
    case 'hold':
      return hold(sandbox, order, step.code, step.detailCode);
    case 'report_shipment_exception':
      return reportShipmentException(sandbox, order, step.kind);
    case 'request_cancellation':
      return requestCancellation(sandbox, order);
    case 'resolve_cancellation':
      return step.outcome === 'accepted' ? cancelNow(sandbox, order) : rejectCancellation(sandbox, order, step.reasonCode);
    case 'return':
      return applyChange(sandbox, order, { returnInfo: { status: step.status, actionRequired: step.actionRequired } });
    case 'returned':
      return applyChange(sandbox, order, { status: 'returned' });
    case 'refund':
      return refund(sandbox, order, step.amountCents ?? totalCents(order));
    case 'advance':
      return advance(sandbox, order);
  }
}

/** Address edits stop once the order is cancelled, or once the parcel has left. */
export function requireAddressEditable(order: Order): void {
  if (order.status === 'cancelled' || order.status === 'rejected') {
    throw new ApiError('address_locked', 'This order is cancelled, so its address can no longer change.');
  }
  if (LOCKED_AFTER_BOOKING.has(order.status)) throw new ApiError('address_locked', 'The address can no longer change for this order.');
}

function advance(sandbox: Sandbox, order: Order): void {
  const name = ADVANCING_STEPS.find((candidate) => STEP_RULES[candidate].advancesFrom?.includes(order.status));
  if (!name) throw validationFailed(`There is no next step after ${order.status}.`, 'status');
  applyStep(sandbox, order, { name });
}

// ---- Change bookkeeping ------------------------------------------------------

type ExtraEvent = { type: WebhookEventType; data: (order: ReturnType<typeof orderView>) => Record<string, unknown> };
type Change = {
  status?: OrderStatus;
  hold?: OrderHold | null;
  returnInfo?: ReturnInfo | null;
  mutate?: (order: Order) => void;
  events?: ExtraEvent[];
};

/**
 * Applies one change the way the production projection does: the sequence moves once per change,
 * history records status/hold changes, and every event caused by the change shares the sequence.
 */
function applyChange(sandbox: Sandbox, order: Order, change: Change): void {
  const previousStatus = order.status;
  const previousHold = order.hold?.code ?? null;
  const previousReturn = order.returnInfo ? `${order.returnInfo.status}:${order.returnInfo.actionRequired}` : null;
  if (change.status !== undefined) order.status = change.status;
  if (change.hold !== undefined) order.hold = change.hold;
  if (change.status !== undefined && change.status !== 'on_hold' && change.hold === undefined) order.hold = null;
  if (change.returnInfo !== undefined) order.returnInfo = change.returnInfo;
  change.mutate?.(order);
  const statusChanged = order.status !== previousStatus || (order.hold?.code ?? null) !== previousHold;
  const currentReturn = order.returnInfo ? `${order.returnInfo.status}:${order.returnInfo.actionRequired}` : null;
  const returnChanged = currentReturn !== previousReturn;
  const now = new Date();
  if (statusChanged || returnChanged || change.mutate) {
    order.sequence += 1;
    order.updatedAt = now;
  }
  if (statusChanged) {
    const reassigning = order.status === 'awaiting_provider' && (previousStatus === 'awaiting_payment' || previousStatus === 'in_production');
    order.statusHistory.push({
      status: order.status,
      holdReason: order.hold?.code ?? null,
      note: reassigning ? 'reassigning' : null,
      at: now,
    });
  }
  const view = orderView(sandbox.view, order);
  const resourceKey = `order:${order.id}`;
  if (statusChanged) emit(sandbox, 'order.status_changed', resourceKey, order.sequence, { order: view, previous_status: previousStatus });
  if (returnChanged) emit(sandbox, 'return.status_changed', resourceKey, order.sequence, { order: view });
  for (const event of change.events ?? []) emit(sandbox, event.type, resourceKey, order.sequence, event.data(view));
}

// ---- Steps -------------------------------------------------------------------

function runIntake(sandbox: Sandbox, order: Order, route: IntakeRoute): void {
  if (order.status !== 'received') return;
  const mode = sandbox.state.store.fulfillmentMode;
  if (route === 'review_hold') return applyChange(sandbox, order, { status: 'on_hold', hold: { code: 'velocity_review', detailCode: null } });
  if (mode === 'manual_approval') return applyChange(sandbox, order, { status: 'on_hold', hold: { code: 'awaiting_approval', detailCode: null } });
  if (mode === 'delayed_auto_submit') return applyChange(sandbox, order, { status: 'on_hold', hold: { code: 'delayed_submit', detailCode: null } });
  submit(sandbox, order);
}

/** Hands the order to production planning: missing data and payment readiness are checked here. */
function submit(sandbox: Sandbox, order: Order): void {
  const group = sandbox.state.providerGroups.get(order.providerGroupId);
  const product = sandbox.state.products.get(order.items[0]?.productId ?? '');
  const productionDays = product?.baseDays ?? 2;
  const mutate = (target: Order) => {
    target.submitted = true;
    if (group) {
      target.estimatedDelivery = {
        earliest: addDays(productionDays + group.deliveryDays.min),
        latest: addDays(productionDays + group.deliveryDays.max),
      };
    }
  };
  if (!order.address.phone) return applyChange(sandbox, order, { status: 'on_hold', hold: { code: 'missing_phone', detailCode: null }, mutate });
  if (!sandbox.state.store.paymentMethodReady) {
    return applyChange(sandbox, order, { status: 'on_hold', hold: { code: 'payment_method_missing', detailCode: null }, mutate });
  }
  applyChange(sandbox, order, { status: 'awaiting_provider', mutate });
}

const addDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Releases a hold the way the merchant (portal) or PrintaRex would. */
function release(sandbox: Sandbox, order: Order): void {
  const code = order.hold?.code;
  if (!code) throw validationFailed('The order is not on hold.');
  if (APPROVAL_HOLDS.has(code)) return submit(sandbox, order);
  if (code === 'missing_phone' && !sandbox.state.store.paymentMethodReady) {
    return applyChange(sandbox, order, { status: 'on_hold', hold: { code: 'payment_method_missing', detailCode: null } });
  }
  applyChange(sandbox, order, { status: 'awaiting_provider' });
}

function charge(sandbox: Sandbox, order: Order): void {
  const total = totalCents(order);
  const chargedAt = new Date().toISOString();
  applyChange(sandbox, order, {
    status: 'in_production',
    mutate: (target) => {
      target.charged = true;
      target.costs.basis = 'final';
    },
    events: [
      {
        type: 'order.charged',
        data: (view) => ({
          order: view,
          charge: { amount: formatCents(roundToWholeUnits(total)), currency: order.currency, charged_at: chargedAt, invoice_url: null },
        }),
      },
    ],
  });
}

function ship(sandbox: Sandbox, order: Order, method: Shipment['method']): void {
  const shipment: Shipment = {
    id: newShipmentId(),
    method,
    carrier: method === 'carrier' ? 'Sandbox Express' : null,
    trackingNumber: method === 'carrier' ? `SBX${Date.now().toString().slice(-9)}` : null,
    trackingUrl: null,
    shippedAt: new Date(),
    deliveredAt: null,
  };
  if (shipment.trackingNumber) shipment.trackingUrl = `https://tracking.sandbox.invalid/${shipment.trackingNumber}`;
  applyChange(sandbox, order, {
    status: 'shipped',
    mutate: (target) => target.shipments.push(shipment),
    events: [{ type: 'order.shipped', data: (view) => ({ order: view, shipment: view.shipments.find((item) => item.id === shipment.id) }) }],
  });
}

function deliver(sandbox: Sandbox, order: Order): void {
  const pending = order.shipments.filter((shipment) => !shipment.deliveredAt);
  if (pending.length === 0) throw validationFailed('The order has no shipment waiting for delivery. Ship it first.');
  applyChange(sandbox, order, {
    status: 'delivered',
    mutate: () => pending.forEach((shipment) => (shipment.deliveredAt = new Date())),
    events: pending.map((shipment) => ({
      type: 'order.delivered',
      data: (view) => ({ order: view, shipment: view.shipments.find((item) => item.id === shipment.id) }),
    })),
  });
}

function hold(sandbox: Sandbox, order: Order, code: HoldCode, detailCode: string | undefined): void {
  const retryUrl = `${sandbox.config.portalBaseUrl}/_sandbox/portal/orders/${order.id}`;
  const paymentEvent = code === 'payment_failed' ? 'order.payment_failed' : code === 'payment_expired' ? 'order.payment_expired' : null;
  applyChange(sandbox, order, {
    status: 'on_hold',
    hold: { code, detailCode: detailCode ?? (code === 'payment_failed' ? 'declined' : null) },
    events: paymentEvent ? [{ type: paymentEvent, data: (view) => ({ order: view, retry_url: retryUrl }) }] : [],
  });
}

/** Reported by the carrier; the order keeps its status and sequence. */
function reportShipmentException(sandbox: Sandbox, order: Order, kind: ShipmentExceptionKind): void {
  const shipment = order.shipments.at(-1);
  if (!shipment) throw validationFailed('The order has no shipment. Ship it first.', 'status');
  const view = orderView(sandbox.view, order);
  emit(sandbox, 'shipment.exception', `order:${order.id}`, order.sequence, {
    order: view,
    shipment: view.shipments.find((item) => item.id === shipment.id),
    kind,
  });
}

function refund(sandbox: Sandbox, order: Order, amountCents: number): void {
  const amount = formatCents(amountCents);
  applyChange(sandbox, order, {
    status: 'refunded',
    events: [{ type: 'order.refunded', data: (view) => ({ order: view, refund: { status: 'refunded', amount, currency: order.currency } }) }],
  });
}

// ---- Cancellation ------------------------------------------------------------

/** Cancels at once while the order has not reached production planning; otherwise production decides, and the sandbox accepts after a delay. */
function requestCancellation(sandbox: Sandbox, order: Order): void {
  if (order.status === 'cancelled' || order.status === 'rejected') return;
  if (CANCEL_WINDOW_CLOSED.has(order.status)) {
    throw new ApiError('cancel_window_closed', 'Production has started, so the order can no longer be cancelled here.');
  }
  const paymentRunning =
    order.status === 'awaiting_payment' || (order.status === 'on_hold' && (order.hold?.code === 'payment_processing_unavailable' || order.hold?.code === 'payment_review'));
  if (paymentRunning) throw new ApiError('payment_in_progress', 'The payment for this order is being processed. Try again shortly.');
  if (!order.submitted) return cancelNow(sandbox, order);
  order.cancelRequested = true;
  sandbox.later(() => {
    if (order.cancelRequested) cancelNow(sandbox, order);
  }, sandbox.config.cancelAutoResolveMs);
}

function cancelNow(sandbox: Sandbox, order: Order): void {
  applyChange(sandbox, order, {
    status: 'cancelled',
    mutate: (target) => (target.cancelRequested = false),
    events: [
      {
        type: 'order.cancelled',
        data: (view) => ({
          order: view,
          refund: order.charged
            ? { status: 'pending', amount: view.costs.production === null ? null : formatCents(totalCents(order)), currency: order.currency }
            : { status: 'none', amount: null, currency: order.currency },
        }),
      },
    ],
  });
}

function rejectCancellation(sandbox: Sandbox, order: Order, reasonCode: string): void {
  order.cancelRequested = false;
  const view = orderView(sandbox.view, order);
  emit(sandbox, 'order.cancel_rejected', `order:${order.id}`, order.sequence, {
    order: view,
    reason_code: reasonCode,
    message: CANCEL_REJECTION_MESSAGES[reasonCode] ?? 'The order could not be cancelled automatically. It continues; contact support.',
  });
}

const totalCents = (order: Order): number =>
  (order.costs.productionCents ?? 0) + (order.costs.shippingCents ?? 0) + (order.costs.brandingCents ?? 0) + (order.costs.feeCents ?? 0);
