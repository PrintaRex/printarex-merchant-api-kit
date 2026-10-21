import { faultCount, isOneOf, ok, routeList } from './control-route.ts';
import { validationFailed } from './errors.ts';
import { WEBHOOK_FAULT_MODES } from './state.ts';
import { deliveryView } from './views.ts';
import { clearFault, emit, flush, reenableEndpoint, rotateSecret, setEndpointUrl, setFault } from './webhook-outbox.ts';

const { routes, add } = routeList();

add('POST', '/_sandbox/webhooks/endpoint', (sandbox, _ctx, body) => {
  if (body.url !== undefined) {
    if (body.url !== null && typeof body.url !== 'string') throw validationFailed('url must be an http or https URL.', 'url');
    setEndpointUrl(sandbox, body.url);
  }
  if (body.enabled === true) reenableEndpoint(sandbox);
  const { url, status } = sandbox.state.endpoint;
  return ok({ url, status });
});

add('POST', '/_sandbox/webhooks/rotate-secret', (sandbox) => {
  const { secret, previousSecretValidUntil } = rotateSecret(sandbox);
  return ok({ secret, previous_secret_valid_until: previousSecretValidUntil.toISOString() });
});

add('POST', '/_sandbox/webhooks/faults', (sandbox, _ctx, body) => {
  if (body.mode === null || body.mode === undefined) {
    clearFault(sandbox);
    return ok({ mode: null });
  }
  if (!isOneOf(WEBHOOK_FAULT_MODES, body.mode)) {
    throw validationFailed('mode must be duplicate, out_of_order, bad_signature, stale_timestamp or null.', 'mode');
  }
  const count = faultCount(body);
  const eventType = typeof body.event_type === 'string' ? body.event_type : null;
  setFault(sandbox, { mode: body.mode, count, eventType });
  return ok({ mode: body.mode, count, event_type: eventType });
});

add('POST', '/_sandbox/webhooks/flush', (sandbox) => ok({ due: flush(sandbox) }));

add('POST', '/_sandbox/webhooks/ping', (sandbox) => ok(deliveryView(emit(sandbox, 'ping', null, null, {}))));

export const webhookControlRoutes = routes;
