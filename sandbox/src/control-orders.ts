import type { Sandbox } from './context.ts';
import { isOneOf, ok, routeList, type ControlHandler } from './control-route.ts';
import { validationFailed } from './errors.ts';
import { AMOUNT_PATTERN, parseCents } from './money.ts';
import { applyStep, isCancelRejectionReason, requireStep, SHIPMENT_EXCEPTION_KINDS, type OrderStep } from './order-lifecycle.ts';
import { findOrder } from './orders.ts';
import { HOLD_CODES, RETURN_STATUSES, type Order } from './state.ts';
import { orderView } from './views.ts';

function orderAction(action: (sandbox: Sandbox, order: Order, body: Record<string, unknown>) => void): ControlHandler {
  return (sandbox, ctx, body) => {
    const order = findOrder(sandbox, ctx.params.order_id);
    action(sandbox, order, body);
    return ok(orderView(sandbox.view, order));
  };
}

/** A route that only names its step; the lifecycle decides whether the order may take it. */
function stepAction(step: OrderStep): ControlHandler {
  return orderAction((sandbox, order) => applyStep(sandbox, order, step));
}

const { routes, add } = routeList();

add('POST', '/_sandbox/orders/{order_id}/advance', stepAction({ name: 'advance' }));

add('POST', '/_sandbox/orders/{order_id}/release', stepAction({ name: 'release' }));

add('POST', '/_sandbox/orders/{order_id}/reject', stepAction({ name: 'reject' }));

add('POST', '/_sandbox/orders/{order_id}/hold', orderAction((sandbox, order, body) => {
  const code = body.code;
  if (!isOneOf(HOLD_CODES, code)) throw validationFailed(`code must be one of ${HOLD_CODES.join(', ')}.`, 'code');
  const detailCode = typeof body.detail_code === 'string' ? body.detail_code : undefined;
  applyStep(sandbox, order, { name: 'hold', code, detailCode });
}));

add('POST', '/_sandbox/orders/{order_id}/accept', stepAction({ name: 'accept' }));

add('POST', '/_sandbox/orders/{order_id}/charge', stepAction({ name: 'charge' }));

add('POST', '/_sandbox/orders/{order_id}/reassign', stepAction({ name: 'reassign' }));

add('POST', '/_sandbox/orders/{order_id}/ship', orderAction((sandbox, order, body) => {
  requireStep(order, 'ship');
  const method = body.method ?? 'carrier';
  if (method !== 'carrier' && method !== 'own_driver') throw validationFailed('method must be carrier or own_driver.', 'method');
  applyStep(sandbox, order, { name: 'ship', method });
}));

add('POST', '/_sandbox/orders/{order_id}/deliver', stepAction({ name: 'deliver' }));

add('POST', '/_sandbox/orders/{order_id}/shipment-exception', orderAction((sandbox, order, body) => {
  const kind = body.kind ?? 'exception';
  if (!isOneOf(SHIPMENT_EXCEPTION_KINDS, kind)) throw validationFailed('kind must be returned, exception or on_hold.', 'kind');
  applyStep(sandbox, order, { name: 'report_shipment_exception', kind });
}));

add('POST', '/_sandbox/orders/{order_id}/cancel-outcome', orderAction((sandbox, order, body) => {
  requireStep(order, 'resolve_cancellation');
  if (body.outcome === 'accepted') return applyStep(sandbox, order, { name: 'resolve_cancellation', outcome: 'accepted' });
  if (body.outcome !== 'rejected') throw validationFailed('outcome must be accepted or rejected.', 'outcome');
  const reasonCode = body.reason_code ?? 'production_started';
  if (typeof reasonCode !== 'string' || !isCancelRejectionReason(reasonCode)) throw validationFailed('reason_code must be production_started, payment_in_progress or cancel_window_closed.', 'reason_code');
  applyStep(sandbox, order, { name: 'resolve_cancellation', outcome: 'rejected', reasonCode });
}));

add('POST', '/_sandbox/orders/{order_id}/return', orderAction((sandbox, order, body) => {
  requireStep(order, 'return');
  const status = body.status;
  if (!isOneOf(RETURN_STATUSES, status)) throw validationFailed(`status must be one of ${RETURN_STATUSES.join(', ')}.`, 'status');
  applyStep(sandbox, order, { name: 'return', status, actionRequired: body.action_required === true });
}));

add('POST', '/_sandbox/orders/{order_id}/returned', stepAction({ name: 'returned' }));

add('POST', '/_sandbox/orders/{order_id}/refund', orderAction((sandbox, order, body) => {
  if (body.amount !== undefined && (typeof body.amount !== 'string' || !AMOUNT_PATTERN.test(body.amount))) {
    throw validationFailed('amount must be a decimal string such as "50.00".', 'amount');
  }
  const amountCents = typeof body.amount === 'string' ? parseCents(body.amount) : undefined;
  applyStep(sandbox, order, { name: 'refund', amountCents });
}));

export const orderControlRoutes = routes;
