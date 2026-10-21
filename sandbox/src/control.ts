import { seedProviderGroups } from './catalog.ts';
import type { Sandbox } from './context.ts';
import { AUTH_MESSAGES } from './auth.ts';
import { orderControlRoutes } from './control-orders.ts';
import { productControlRoutes } from './control-products.ts';
import { type ControlRoute, ok, requireJsonContentType } from './control-route.ts';
import { storeControlRoutes, storeSettings } from './control-store.ts';
import { webhookControlRoutes } from './control-webhooks.ts';
import { INTERNAL_ERROR_MESSAGE, ORDER_INTAKE_PAUSED_MESSAGE } from './errors.ts';
import { matchRoute, parseJsonObject, route, type Reply, type RequestContext } from './http.ts';
import { publishProduct } from './product-catalogue.ts';
import type { SandboxState } from './state.ts';
import { restoreEndpointHealth } from './webhook-outbox.ts';

const DEFAULT_FAULT_MESSAGES: Partial<Record<string, string>> = {
  entitlement_unavailable: 'The plan check could not run. Retry shortly.',
  order_intake_paused: ORDER_INTAKE_PAUSED_MESSAGE,
  internal_error: INTERNAL_ERROR_MESSAGE,
  rate_limited: AUTH_MESSAGES.rate_limited,
};

export function initialiseState(sandbox: Sandbox): void {
  seedProviderGroups(sandbox.state);
  if (sandbox.config.seedProducts) {
    publishProduct(sandbox, 'tshirt');
    publishProduct(sandbox, 'mug');
  }
}

export function resetState(sandbox: Sandbox, fresh: SandboxState): void {
  for (const timer of sandbox.state.timers) clearTimeout(timer);
  const keys = sandbox.state.keys;
  const endpoint = sandbox.state.endpoint;
  Object.assign(sandbox.state, fresh, { keys, endpoint: restoreEndpointHealth(endpoint) });
  for (const record of keys.values()) {
    record.ordersCreated = 0;
    record.status = 'active';
  }
  initialiseState(sandbox);
}

const stateRoutes: ControlRoute[] = [
  route('GET', '/_sandbox/state', ({ sandbox }) => ok(stateSummary(sandbox))),
  route('POST', '/_sandbox/reset', ({ reset }) => {
    reset();
    return ok({ reset: true });
  }),
];

const handlers = [...stateRoutes, ...storeControlRoutes, ...webhookControlRoutes, ...productControlRoutes, ...orderControlRoutes];

export function handleControl(sandbox: Sandbox, ctx: RequestContext, reset: () => void): Reply | null {
  const match = matchRoute(handlers, ctx.method, ctx.path);
  if (!match) return null;
  ctx.params = match.params;
  requireJsonContentType(ctx);
  const body = ctx.method === 'GET' ? {} : (parseJsonObject(ctx) ?? {});
  return match.route.handler({ sandbox, ctx, body, reset });
}

function stateSummary(sandbox: Sandbox) {
  const { state } = sandbox;
  const counts: Record<string, number> = {};
  for (const delivery of state.deliveries) counts[delivery.status] = (counts[delivery.status] ?? 0) + 1;
  return {
    store: storeSettings(sandbox),
    webhook_endpoint: {
      url: state.endpoint.url,
      status: state.endpoint.status,
      consecutive_failures: state.endpoint.consecutiveFailures,
      paused_until: state.endpoint.pausedUntil?.toISOString() ?? null,
    },
    provider_groups: [...state.providerGroups.values()].map((group) => ({ id: group.id, label: group.label })),
    products: [...state.products.values()].map((product) => ({
      id: product.id,
      title: product.title,
      status: product.status,
      listing_state: product.listingState,
      provider_group_id: product.providerGroupId,
      variants: product.variants.map((variant) => ({ id: variant.id, sku: variant.sku, quantity: variant.quantity })),
    })),
    orders: [...state.orders.values()].map((order) => ({
      id: order.id,
      external_order_id: order.externalOrderId,
      status: order.status,
      hold_reason: order.hold?.code ?? null,
      sequence: order.sequence,
      cancel_requested: order.cancelRequested,
    })),
    deliveries: counts,
    webhook_fault: state.webhookFault,
    injected_faults: state.faults,
    rate_limits: state.rateLimits,
  };
}

export const faultMessage = (code: string): string => DEFAULT_FAULT_MESSAGES[code] ?? `Injected sandbox fault: ${code}.`;
