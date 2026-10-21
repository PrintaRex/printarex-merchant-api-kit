/**
 * The webhook outbox: the one module that changes a delivery's or the endpoint's state.
 *
 * Callers say what happened (emit an event, replay a delivery, flush, re-enable the endpoint, change
 * its URL or secret, inject a fault). The outbox owns what that means: supersede, retry timing, the
 * pause after repeated failures, disabling the endpoint and replaying its backlog.
 * HTTP sending is plain `fetch` with no seam in front of it; tests point it at a real local receiver.
 */
import { createHmac } from 'node:crypto';
import type { Sandbox } from './context.ts';
import { validationFailed } from './errors.ts';
import { generateWebhookSecret, newUuid } from './ids.ts';
import type { Delivery, SandboxState, WebhookEndpoint, WebhookEventType, WebhookFaultMode } from './state.ts';
import { publicDeliveryStatus } from './views.ts';

/** A newer event of these types replaces an undelivered older one for the same resource. */
const SUPERSEDING_TYPES = new Set<WebhookEventType>(['product.updated', 'product.cost_changed', 'inventory.updated']);
const MAX_ATTEMPTS = 8;
const PAUSE_AFTER_FAILURES = 5;
const MAX_RESPONSE_BYTES = 65_536;
const USER_AGENT = 'PrintaRex-Webhooks/1';
/** Production pauses for 10 minutes; the sandbox uses the same minutes-as-seconds scale as retries. */
const PAUSE_MS = 10_000;
const OUT_OF_ORDER_HOLD_MS = 3000;
const STALE_TIMESTAMP_SKEW_SECONDS = 600;
const PREVIOUS_SECRET_OVERLAP_MS = 24 * 3_600_000;

/** `lastError` values the outbox itself assigns; everything else is a failure reported by the receiver. */
const SUPERSEDED = 'superseded';
const ENDPOINT_DISABLED = 'endpoint_disabled';

/** Waiting for a first attempt or a retry. */
const isQueued = (delivery: Delivery): boolean => delivery.status === 'PENDING' || delivery.status === 'FAILED';

// ---- Recording events ------------------------------------------------------

export function emit(sandbox: Sandbox, type: WebhookEventType, resourceKey: string | null, sequence: number | null, data: unknown): Delivery {
  const { state } = sandbox;
  const now = new Date();
  if (resourceKey && SUPERSEDING_TYPES.has(type)) supersedeQueued(state, type, resourceKey);
  const disabled = state.endpoint.status === 'disabled';
  const delivery: Delivery = {
    id: newUuid(),
    eventId: newUuid(),
    eventType: type,
    resourceKey,
    createdAt: now,
    sequence,
    data,
    status: disabled ? 'DEAD' : 'PENDING',
    attempt: 0,
    responseCode: null,
    lastError: disabled ? ENDPOINT_DISABLED : null,
    lastAttemptAt: null,
    nextAttemptAt: disabled ? null : now,
  };
  state.deliveries.push(delivery);
  return delivery;
}

function supersedeQueued(state: SandboxState, type: WebhookEventType, resourceKey: string): void {
  for (const open of state.deliveries) {
    if (open.eventType === type && open.resourceKey === resourceKey && isQueued(open)) {
      markDead(open, SUPERSEDED);
    }
  }
}

/** Ends a delivery the outbox itself gives up on; `reason` is one of the outbox-assigned `lastError` values. */
function markDead(delivery: Delivery, reason: typeof SUPERSEDED | typeof ENDPOINT_DISABLED): void {
  delivery.status = 'DEAD';
  delivery.lastError = reason;
  delivery.nextAttemptAt = null;
}

// ---- Listing and replay ----------------------------------------------------

/** Superseded deliveries are an internal detail: no listing and no replay ever shows them. */
const isVisible = (delivery: Delivery): boolean => delivery.lastError !== SUPERSEDED;

/** Visible deliveries, newest first. `status` is the public status name, not the internal one. */
export function queryDeliveries(sandbox: Sandbox, filter: { status: string | null; eventType: string | null }): Delivery[] {
  return sandbox.state.deliveries
    .filter(isVisible)
    .filter((delivery) => filter.status === null || publicDeliveryStatus(delivery) === filter.status)
    .filter((delivery) => filter.eventType === null || delivery.eventType === filter.eventType)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
}

/** Queues a finished delivery for a fresh run of attempts. Returns null when there is no such visible delivery. */
export function replay(sandbox: Sandbox, deliveryId: string | undefined): Delivery | null {
  const delivery = sandbox.state.deliveries.find((candidate) => candidate.id === deliveryId);
  if (!delivery || !isVisible(delivery)) return null;
  if (delivery.status === 'DELIVERED' || delivery.status === 'FAILED' || delivery.status === 'DEAD') requeue(delivery);
  return delivery;
}

function requeue(delivery: Delivery): void {
  delivery.status = 'PENDING';
  delivery.attempt = 0;
  delivery.nextAttemptAt = new Date();
  delivery.lastError = null;
}

/** Makes every queued delivery due now and lifts the failure pause. Returns how many are due. */
export function flush(sandbox: Sandbox): number {
  const { endpoint, deliveries } = sandbox.state;
  endpoint.pausedUntil = null;
  let due = 0;
  for (const delivery of deliveries) {
    if (isQueued(delivery)) {
      delivery.nextAttemptAt = new Date();
      due += 1;
    }
  }
  return due;
}

// ---- Endpoint --------------------------------------------------------------

export function setEndpointUrl(sandbox: Sandbox, url: string | null): void {
  if (url !== null) {
    const parsed = URL.parse(url);
    if (parsed?.protocol !== 'https:' && parsed?.protocol !== 'http:') throw validationFailed('url must be an http or https URL.', 'url');
  }
  sandbox.state.endpoint.url = url;
}

/** Re-enabling replays the backlog that was dropped while the endpoint was disabled. Does nothing for an active endpoint. */
export function reenableEndpoint(sandbox: Sandbox): void {
  const { state } = sandbox;
  if (state.endpoint.status !== 'disabled') return;
  Object.assign(state.endpoint, restoreEndpointHealth(state.endpoint));
  for (const delivery of state.deliveries) {
    if (delivery.status === 'DEAD' && delivery.lastError === ENDPOINT_DISABLED) requeue(delivery);
  }
}

/** The endpoint as it is after a fresh start or a re-enable: same URL and secrets, no failure history. */
export function restoreEndpointHealth(endpoint: WebhookEndpoint): WebhookEndpoint {
  return { ...endpoint, status: 'active', consecutiveFailures: 0, pausedUntil: null };
}

/** The old secret keeps signing alongside the new one for a day so a receiver can switch over. */
export function rotateSecret(sandbox: Sandbox): { secret: string; previousSecretValidUntil: Date } {
  const { endpoint } = sandbox.state;
  endpoint.previousSecret = endpoint.secret;
  endpoint.previousSecretUntil = new Date(Date.now() + PREVIOUS_SECRET_OVERLAP_MS);
  endpoint.secret = generateWebhookSecret();
  return { secret: endpoint.secret, previousSecretValidUntil: endpoint.previousSecretUntil };
}

export function setFault(sandbox: Sandbox, fault: { mode: WebhookFaultMode; count: number; eventType: string | null }): void {
  sandbox.state.webhookFault = { mode: fault.mode, remaining: fault.count, eventType: fault.eventType };
}

export function clearFault(sandbox: Sandbox): void {
  sandbox.state.webhookFault = null;
}

function takeFault(sandbox: Sandbox, delivery: Delivery): WebhookFaultMode | null {
  const fault = sandbox.state.webhookFault;
  if (!fault || (fault.eventType !== null && fault.eventType !== delivery.eventType)) return null;
  fault.remaining -= 1;
  if (fault.remaining <= 0) clearFault(sandbox);
  return fault.mode;
}

// ---- Dispatching -----------------------------------------------------------

/** Sends due deliveries one at a time per endpoint, oldest first, like the production dispatcher. */
export function startDispatcher(sandbox: Sandbox): () => void {
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    const next = nextDueDelivery(sandbox);
    if (!next) return;
    busy = true;
    try {
      await deliver(sandbox, next);
    } finally {
      busy = false;
    }
  };
  const interval = setInterval(() => void tick(), 100);
  return () => clearInterval(interval);
}

function nextDueDelivery(sandbox: Sandbox): Delivery | null {
  const { endpoint, deliveries } = sandbox.state;
  const now = Date.now();
  if (!endpoint.url || endpoint.status !== 'active') return null;
  if (endpoint.pausedUntil && endpoint.pausedUntil.getTime() > now) return null;
  let due: Delivery | null = null;
  for (const delivery of deliveries) {
    if (!isQueued(delivery)) continue;
    if (!delivery.nextAttemptAt || delivery.nextAttemptAt.getTime() > now) continue;
    if (!due || delivery.createdAt < due.createdAt) due = delivery;
  }
  return due;
}

function envelope(sandbox: Sandbox, delivery: Delivery) {
  return {
    id: delivery.eventId,
    type: delivery.eventType,
    api_version: sandbox.config.apiVersion,
    created_at: delivery.createdAt.toISOString(),
    attempt: delivery.attempt,
    sequence: delivery.sequence,
    store_id: sandbox.state.store.id,
    data: delivery.data,
  };
}

async function deliver(sandbox: Sandbox, delivery: Delivery): Promise<void> {
  const { state, config } = sandbox;
  const endpoint = state.endpoint;
  const fault = takeFault(sandbox, delivery);
  if (fault === 'out_of_order') {
    // Hold this event back so the next one arrives first.
    delivery.nextAttemptAt = new Date(Date.now() + OUT_OF_ORDER_HOLD_MS);
    sandbox.log(`webhook fault out_of_order: holding ${delivery.eventType} ${delivery.eventId} for 3s`);
    return;
  }
  delivery.status = 'IN_FLIGHT';
  delivery.attempt += 1;
  delivery.lastAttemptAt = new Date();
  const body = JSON.stringify(envelope(sandbox, delivery));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const timestamp = fault === 'stale_timestamp' ? nowSeconds - STALE_TIMESTAMP_SKEW_SECONDS : nowSeconds;
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'PrintaRex-Signature': signatureHeader(signingSecrets(state, fault), timestamp, body),
    'PrintaRex-Event-Id': delivery.eventId,
    'PrintaRex-Event-Type': delivery.eventType,
  };
  const outcome = await post(endpoint.url ?? '', headers, body, config.webhookTimeoutMs);
  if (fault === 'duplicate' && outcome.ok) await post(endpoint.url ?? '', headers, body, config.webhookTimeoutMs);
  delivery.responseCode = outcome.status;
  sandbox.log(`webhook ${delivery.eventType} attempt ${delivery.attempt} -> ${outcome.ok ? 'ok' : outcome.error}${fault ? ` (fault ${fault})` : ''}`);
  if (outcome.ok) {
    delivery.status = 'DELIVERED';
    delivery.lastError = null;
    delivery.nextAttemptAt = null;
    endpoint.consecutiveFailures = 0;
    return;
  }
  recordFailure(sandbox, delivery, outcome.error);
}

function signatureHeader(secrets: string[], timestamp: number, body: string): string {
  const signatures = secrets.map((secret) => `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`);
  return [`t=${timestamp}`, ...signatures].join(',');
}

/** The current secret, plus the previous one while a rotation is in its overlap window. */
function signingSecrets(state: SandboxState, fault: WebhookFaultMode | null): string[] {
  if (fault === 'bad_signature') return ['whsec_wrong_secret'];
  const { secret, previousSecret, previousSecretUntil } = state.endpoint;
  const previousStillValid = previousSecret && previousSecretUntil && previousSecretUntil.getTime() > Date.now();
  return previousStillValid ? [secret, previousSecret] : [secret];
}

function recordFailure(sandbox: Sandbox, delivery: Delivery, error: string): void {
  const endpoint = sandbox.state.endpoint;
  delivery.lastError = error;
  endpoint.consecutiveFailures += 1;
  if (endpoint.consecutiveFailures >= PAUSE_AFTER_FAILURES) endpoint.pausedUntil = new Date(Date.now() + PAUSE_MS);
  const retryDelay = sandbox.config.webhookRetryDelaysMs[delivery.attempt - 1];
  if (delivery.attempt < MAX_ATTEMPTS && retryDelay !== undefined) {
    delivery.status = 'FAILED';
    delivery.nextAttemptAt = new Date(Date.now() + retryDelay);
    return;
  }
  delivery.status = 'DEAD';
  delivery.nextAttemptAt = null;
  if (endpoint.consecutiveFailures >= PAUSE_AFTER_FAILURES) disableEndpoint(sandbox);
}

function disableEndpoint(sandbox: Sandbox): void {
  const { state } = sandbox;
  state.endpoint.status = 'disabled';
  for (const queued of state.deliveries) {
    if (isQueued(queued)) {
      markDead(queued, ENDPOINT_DISABLED);
    }
  }
  sandbox.log('webhook endpoint DISABLED after retries were exhausted (POST /_sandbox/webhooks/endpoint to re-enable)');
}

type PostOutcome = { ok: true; status: number } | { ok: false; status: number | null; error: string };

async function post(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<PostOutcome> {
  try {
    const response = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const tooLarge = await exceedsLimit(response);
    if (tooLarge) return { ok: false, status: response.status, error: 'response_too_large' };
    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status };
    return { ok: false, status: response.status, error: `http_${response.status}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { ok: false, status: null, error: name === 'TimeoutError' ? 'timeout' : 'connection_error' };
  }
}

async function exceedsLimit(response: Response): Promise<boolean> {
  if (!response.body) return false;
  let size = 0;
  for await (const chunk of response.body) {
    size += (chunk as Uint8Array).length;
    if (size > MAX_RESPONSE_BYTES) {
      await response.body.cancel().catch(() => undefined);
      return true;
    }
  }
  return false;
}
