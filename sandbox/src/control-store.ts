import type { Sandbox } from './context.ts';
import { faultCount, isOneOf, isWholeNumber, ok, routeList } from './control-route.ts';
import { isErrorCode, validationFailed } from './errors.ts';
import type { FulfillmentMode, KeyRecord } from './state.ts';
import { unpublishProduct } from './product-catalogue.ts';
import { emit } from './webhook-outbox.ts';
import { deliveryView } from './views.ts';

const FULFILLMENT_MODES: readonly FulfillmentMode[] = ['instant', 'manual_approval', 'delayed_auto_submit'];
const KEY_NAMES = ['full', 'read_only'] as const;
const KEY_STATUSES: readonly KeyRecord['status'][] = ['active', 'expired', 'revoked'];
const DISABLE_REASONS = ['plan_lapsed', 'disconnected', 'revoked', 'admin'] as const;

const { routes, add } = routeList();

add('PATCH', '/_sandbox/store', (sandbox, _ctx, body) => {
  const store = sandbox.state.store;
  if (body.fulfillment_mode !== undefined) {
    if (!isOneOf(FULFILLMENT_MODES, body.fulfillment_mode)) throw validationFailed('fulfillment_mode must be instant, manual_approval or delayed_auto_submit.', 'fulfillment_mode');
    store.fulfillmentMode = body.fulfillment_mode;
  }
  for (const [field, property] of [
    ['payment_method_ready', 'paymentMethodReady'],
    ['plan_active', 'planActive'],
    ['order_intake_paused', 'orderIntakePaused'],
    ['auto_routing', 'autoRouting'],
  ] as const) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'boolean') throw validationFailed(`${field} must be true or false.`, field);
    store[property] = body[field];
  }
  if (body.delay_hours !== undefined) {
    if (!isWholeNumber(body.delay_hours, 1)) throw validationFailed('delay_hours must be a positive whole number.', 'delay_hours');
    store.delayHours = body.delay_hours;
  }
  return ok(storeSettings(sandbox));
});

add('POST', '/_sandbox/keys', ({ state, config }, _ctx, body) => {
  if (!isOneOf(KEY_NAMES, body.key)) throw validationFailed('key must be "full" or "read_only".', 'key');
  if (!isOneOf(KEY_STATUSES, body.status)) throw validationFailed('status must be active, expired or revoked.', 'status');
  const record = state.keys.get(body.key === 'full' ? config.fullAccessKey : config.readOnlyKey);
  if (record) record.status = body.status;
  return ok({ key: body.key, status: body.status });
});

add('POST', '/_sandbox/api-key/expiring', (sandbox) => {
  const delivery = emit(sandbox, 'api_key.expiring', null, null, {
    display_prefix: sandbox.config.fullAccessKey.slice(0, 'prx_uat_'.length + 4),
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  return ok(deliveryView(delivery));
});

add('POST', '/_sandbox/connection/disable', (sandbox, _ctx, body) => {
  const reason = body.reason ?? 'disconnected';
  if (!isOneOf(DISABLE_REASONS, reason)) throw validationFailed('reason must be plan_lapsed, disconnected, revoked or admin.', 'reason');
  sandbox.state.store.connected = false;
  if (reason === 'disconnected') {
    for (const product of sandbox.state.products.values()) {
      if (product.status !== 'published') continue;
      unpublishProduct(sandbox, product);
    }
  }
  emit(sandbox, 'connection.disabled', null, null, { reason });
  return ok({ connected: false, reason });
});

add('POST', '/_sandbox/connection/enable', ({ state }) => {
  state.store.connected = true;
  return ok({ connected: true });
});

add('POST', '/_sandbox/faults', ({ state }, _ctx, body) => {
  if (!isErrorCode(body.code)) throw validationFailed('code must be a Merchant API error code, for example entitlement_unavailable.', 'code');
  const count = faultCount(body);
  const faultRoute = typeof body.route === 'string' ? body.route : null;
  state.faults.push({ route: faultRoute, code: body.code, remaining: count });
  return ok({ code: body.code, route: faultRoute, count });
});

add('DELETE', '/_sandbox/faults', ({ state }) => {
  state.faults = [];
  return ok({ faults: [] });
});

add('POST', '/_sandbox/rate-limits', ({ state }, _ctx, body) => {
  for (const rateClass of ['general', 'orders', 'rates'] as const) {
    const value = body[rateClass];
    if (value === undefined) continue;
    if (!isWholeNumber(value, 1)) throw validationFailed(`${rateClass} must be a positive whole number.`, rateClass);
    state.rateLimits[rateClass] = value;
  }
  state.rateWindows.clear();
  return ok(state.rateLimits);
});

export function storeSettings({ state }: Sandbox) {
  return {
    id: state.store.id,
    country: state.store.country,
    currency: state.store.currency,
    fulfillment_mode: state.store.fulfillmentMode,
    payment_method_ready: state.store.paymentMethodReady,
    plan_active: state.store.planActive,
    order_intake_paused: state.store.orderIntakePaused,
    connected: state.store.connected,
  };
}

export const storeControlRoutes = routes;
