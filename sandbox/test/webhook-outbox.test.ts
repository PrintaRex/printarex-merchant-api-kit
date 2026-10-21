/**
 * The webhook outbox, tested through its interface (emit, queryDeliveries, replay, flush, setEndpointUrl,
 * reenableEndpoint, rotateSecret, setFault, clearFault, restoreEndpointHealth) against a real local receiver.
 * There is no seam in front of fetch: the receiver is the only adapter.
 *
 * Ways the outbox could fail, each covered below:
 *  1. Supersede: a newer product.updated / product.cost_changed / inventory.updated leaves the older one deliverable,
 *     supersedes a different resource or event type, supersedes an already delivered event, or leaves it in the listing.
 *  2. Retry: a failed attempt is not retried, is retried with the wrong attempt number or event id, keeps retrying
 *     past the schedule instead of going dead, or does not reset the failure count after a success.
 *  3. Pause: five consecutive failures do not stop the dispatcher, or the pause never ends.
 *  4. Disable: the endpoint is not disabled when retries run out after five failures, the queued backlog is still
 *     sent, or events recorded while disabled are sent anyway.
 *  5. Re-enable: the backlog is not replayed, replayed events that really failed are replayed too, the failure
 *     history survives, or re-enabling an active endpoint replays things.
 *  6. Flush: a queued delivery waits out its retry delay, the pause is not lifted, or the due count is wrong.
 *  7. Replay: a finished delivery is not resent with the same event id, a queued one is reset, a superseded or
 *     unknown one is found.
 *  8. Endpoint settings: an unusable URL is accepted, a rotation drops the old secret too early or signs with
 *     the wrong one, a fault is not consumed or not cleared, and a restart keeps the failure history.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { ApiError } from '../src/errors.ts';
import type { Delivery } from '../src/state.ts';
import {
  clearFault,
  emit,
  flush,
  queryDeliveries,
  reenableEndpoint,
  replay,
  restoreEndpointHealth,
  rotateSecret,
  setEndpointUrl,
  setFault,
} from '../src/webhook-outbox.ts';
import { type Harness, startHarness } from './harness.ts';

const FAST_RETRIES = { SANDBOX_WEBHOOK_RETRY_SECONDS: '0.05,0.05,0.05,0.05,0.05,0.05,0.05' };
const NO_FILTER = { status: null, eventType: null };

let harness: Harness | null = null;

async function startOutbox(env: Record<string, string> = {}) {
  harness = await startHarness({ SANDBOX_SEED_PRODUCTS: 'false', ...FAST_RETRIES, ...env });
  const { sandbox } = harness.running;
  return { sandbox, receiver: harness.receiver, endpoint: sandbox.state.endpoint, url: sandbox.state.endpoint.url as string };
}

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

async function eventually(description: string, condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const statusOf = (delivery: Delivery) => delivery.status;

describe('supersede', () => {
  test('a newer event replaces a queued older one of the same type and resource, and nothing else', async () => {
    const { sandbox, receiver, url } = await startOutbox();
    setEndpointUrl(sandbox, null); // nothing is sent while the URL is unset, so deliveries stay queued

    const stale = emit(sandbox, 'inventory.updated', 'prd_A', 1, {});
    const otherResource = emit(sandbox, 'inventory.updated', 'prd_B', 1, {});
    const otherType = emit(sandbox, 'product.updated', 'prd_A', 1, {});
    const current = emit(sandbox, 'inventory.updated', 'prd_A', 2, {});
    const shippedFirst = emit(sandbox, 'order.shipped', 'ord_A', 1, {});
    const shippedSecond = emit(sandbox, 'order.shipped', 'ord_A', 2, {});

    assert.deepEqual([stale.status, stale.lastError, stale.nextAttemptAt], ['DEAD', 'superseded', null]);
    assert.deepEqual([otherResource, otherType, current, shippedFirst, shippedSecond].map(statusOf), Array(5).fill('PENDING'));
    const listed = queryDeliveries(sandbox, NO_FILTER).map((delivery) => delivery.id);
    assert.ok(!listed.includes(stale.id), 'a superseded delivery never appears in the listing');
    assert.equal(listed.length, 5);
    assert.equal(replay(sandbox, stale.id), null);

    setEndpointUrl(sandbox, url);
    await eventually('the five live deliveries', () => receiver.events.length === 5);
    assert.ok(!receiver.events.some((event) => event.id === stale.eventId), 'the superseded event is never sent');
  });

  test('an event that was already delivered is not superseded', async () => {
    const { sandbox, receiver } = await startOutbox();
    const first = emit(sandbox, 'product.cost_changed', 'prd_A', 1, {});
    await eventually('the first delivery', () => first.status === 'DELIVERED');

    emit(sandbox, 'product.cost_changed', 'prd_A', 2, {});
    assert.equal(first.status, 'DELIVERED');
    await eventually('the second delivery', () => receiver.events.length === 2);
  });
});

describe('retry', () => {
  test('a failed attempt is retried with the same event id and the next attempt number, then succeeds', async () => {
    const { sandbox, receiver, endpoint } = await startOutbox();
    receiver.failNext = 1;
    const delivery = emit(sandbox, 'ping', null, null, {});

    await eventually('the retry to land', () => delivery.status === 'DELIVERED');
    assert.deepEqual(receiver.events.map((event) => [event.id, event.attempt, event.signatureValid]), [
      [delivery.eventId, 1, true],
      [delivery.eventId, 2, true],
    ]);
    assert.equal(endpoint.consecutiveFailures, 0, 'a success clears the failure count');
    assert.equal(delivery.lastError, null);
  });

  test('when the retry schedule runs out the delivery is dead and stays dead', async () => {
    const { sandbox, receiver, endpoint } = await startOutbox({ SANDBOX_WEBHOOK_RETRY_SECONDS: '0.05' });
    receiver.failNext = 2;
    const delivery = emit(sandbox, 'ping', null, null, {});

    await eventually('the delivery to die', () => delivery.status === 'DEAD');
    assert.deepEqual([delivery.attempt, delivery.lastError, delivery.responseCode, delivery.nextAttemptAt], [2, 'http_500', 500, null]);
    await pause(300);
    assert.equal(receiver.events.length, 2, 'no attempt after the schedule is exhausted');
    assert.deepEqual([endpoint.status, endpoint.consecutiveFailures, endpoint.pausedUntil], ['active', 2, null]);
  });
});

describe('pause', () => {
  test('five consecutive failures pause the dispatcher until a flush', async () => {
    const { sandbox, receiver, endpoint } = await startOutbox();
    receiver.failNext = 5;
    const delivery = emit(sandbox, 'ping', null, null, {});

    await eventually('five failed attempts', () => receiver.events.length === 5);
    await eventually('the pause to be recorded', () => endpoint.pausedUntil !== null && delivery.status === 'FAILED');
    const pausedFor = (endpoint.pausedUntil as Date).getTime() - Date.now();
    assert.ok(pausedFor > 5000 && pausedFor <= 10_000, `paused for about 10s, got ${pausedFor}ms`);
    await pause(300);
    assert.equal(receiver.events.length, 5, 'nothing is sent while paused, although the retry is due');

    assert.equal(flush(sandbox), 1);
    assert.equal(endpoint.pausedUntil, null);
    await eventually('the retry after the flush', () => delivery.status === 'DELIVERED');
    assert.equal(receiver.events.length, 6);
    assert.equal(endpoint.consecutiveFailures, 0);
  });
});

describe('endpoint disable and re-enable', () => {
  /** Six events, the first five fail with no retries left: the fifth failure disables the endpoint and drops the sixth. */
  async function disableEndpointWithBacklog() {
    const outbox = await startOutbox();
    outbox.sandbox.config.webhookRetryDelaysMs = [];
    outbox.receiver.failNext = 5;
    const failed = Array.from({ length: 5 }, (_, index) => emit(outbox.sandbox, 'order.shipped', `ord_${index}`, 1, {}));
    const backlog = emit(outbox.sandbox, 'order.shipped', 'ord_backlog', 1, {});
    await eventually('the endpoint to be disabled', () => outbox.endpoint.status === 'disabled');
    return { ...outbox, failed, backlog };
  }

  test('disabling drops the backlog and events recorded afterwards, and sends none of them', async () => {
    const { sandbox, receiver, endpoint, failed, backlog } = await disableEndpointWithBacklog();
    const late = emit(sandbox, 'order.delivered', 'ord_late', 1, {});

    assert.deepEqual(failed.map((delivery) => [delivery.status, delivery.lastError, delivery.attempt]), Array(5).fill(['DEAD', 'http_500', 1]));
    for (const dropped of [backlog, late]) {
      assert.deepEqual([dropped.status, dropped.lastError, dropped.attempt, dropped.nextAttemptAt], ['DEAD', 'endpoint_disabled', 0, null]);
    }
    await pause(300);
    assert.equal(receiver.events.length, 5, 'only the five failing attempts were ever sent');
    assert.ok(endpoint.pausedUntil !== null);
    assert.equal(queryDeliveries(sandbox, { status: 'dead', eventType: null }).length, 7);
  });

  test('re-enabling replays only the dropped backlog and clears the failure history', async () => {
    const { sandbox, receiver, endpoint, failed, backlog } = await disableEndpointWithBacklog();
    const late = emit(sandbox, 'order.delivered', 'ord_late', 1, {});

    reenableEndpoint(sandbox);
    assert.deepEqual([endpoint.status, endpoint.consecutiveFailures, endpoint.pausedUntil], ['active', 0, null]);

    await eventually('the backlog to be delivered', () => backlog.status === 'DELIVERED' && late.status === 'DELIVERED');
    assert.deepEqual([backlog.attempt, late.attempt], [1, 1], 'the replayed backlog starts over at attempt 1');
    assert.deepEqual(failed.map(statusOf), Array(5).fill('DEAD'), 'deliveries that really failed stay dead');
    assert.equal(receiver.events.length, 7);
    assert.ok(receiver.events.slice(5).every((event) => event.signatureValid));
  });

  test('re-enabling an active endpoint does nothing', async () => {
    const { sandbox, receiver, endpoint } = await startOutbox();
    const delivery = emit(sandbox, 'ping', null, null, {});
    await eventually('the delivery', () => delivery.status === 'DELIVERED');

    reenableEndpoint(sandbox);
    await pause(300);
    assert.deepEqual([endpoint.status, delivery.attempt, receiver.events.length], ['active', 1, 1]);
  });
});

describe('flush', () => {
  test('a queued delivery waiting out a long retry delay is sent now, and the due count says so', async () => {
    const { sandbox, receiver } = await startOutbox({ SANDBOX_WEBHOOK_RETRY_SECONDS: '60' });
    receiver.failNext = 1;
    const waiting = emit(sandbox, 'ping', null, null, {});
    await eventually('the first attempt to fail', () => waiting.status === 'FAILED');
    const delayMs = (waiting.nextAttemptAt as Date).getTime() - Date.now();
    assert.ok(delayMs > 50_000, `the retry is a minute away, got ${delayMs}ms`);
    const finished = emit(sandbox, 'ping', null, null, {});
    await eventually('the other ping to be delivered', () => finished.status === 'DELIVERED');

    assert.equal(flush(sandbox), 1, 'only the queued delivery is counted');
    await eventually('the flushed retry', () => waiting.status === 'DELIVERED');
    assert.equal(waiting.attempt, 2);
  });

  test('with nothing queued the due count is zero', async () => {
    const { sandbox } = await startOutbox();
    assert.equal(flush(sandbox), 0);
  });
});

describe('replay', () => {
  test('a delivered event is sent again with the same event id, starting at attempt 1', async () => {
    const { sandbox, receiver } = await startOutbox();
    const delivery = emit(sandbox, 'order.shipped', 'ord_A', 1, {});
    await eventually('the first delivery', () => delivery.status === 'DELIVERED');

    assert.equal(replay(sandbox, delivery.id), delivery);
    assert.deepEqual([delivery.status, delivery.attempt], ['PENDING', 0]);
    await eventually('the replay', () => receiver.events.length === 2);
    assert.deepEqual(receiver.events.map((event) => [event.id, event.attempt]), [
      [delivery.eventId, 1],
      [delivery.eventId, 1],
    ]);
  });

  test('a dead event is replayed and its error cleared', async () => {
    const { sandbox, receiver } = await startOutbox({ SANDBOX_WEBHOOK_RETRY_SECONDS: '0.05' });
    receiver.failNext = 2;
    const delivery = emit(sandbox, 'ping', null, null, {});
    await eventually('the delivery to die', () => delivery.status === 'DEAD');

    replay(sandbox, delivery.id);
    assert.equal(delivery.lastError, null);
    await eventually('the replay to land', () => delivery.status === 'DELIVERED');
  });

  test('a queued event is not reset, and an unknown id is not found', async () => {
    const { sandbox } = await startOutbox();
    setEndpointUrl(sandbox, null);
    const queued = emit(sandbox, 'ping', null, null, {});
    queued.attempt = 3; // mid-schedule: a replay must not rewind it

    assert.equal(replay(sandbox, queued.id), queued);
    assert.equal(queued.attempt, 3);
    assert.equal(replay(sandbox, 'no-such-delivery'), null);
    assert.equal(replay(sandbox, undefined), null);
  });
});

describe('endpoint settings', () => {
  test('only http and https URLs are accepted, and null clears the endpoint', async () => {
    const { sandbox, endpoint, url } = await startOutbox();
    for (const unusable of ['ftp://example.com/hook', 'not a url', 'javascript:alert(1)']) {
      assert.throws(
        () => setEndpointUrl(sandbox, unusable),
        (error: unknown) => error instanceof ApiError && error.code === 'validation_failed' && error.field === 'url' && error.message === 'url must be an http or https URL.',
      );
    }
    assert.equal(endpoint.url, url, 'a rejected URL changes nothing');
    setEndpointUrl(sandbox, 'https://example.com/hook');
    assert.equal(endpoint.url, 'https://example.com/hook');
    setEndpointUrl(sandbox, null);
    assert.equal(endpoint.url, null);
  });

  test('after a rotation both secrets sign until the overlap ends; the new one signs alone afterwards', async () => {
    const { sandbox, receiver, endpoint } = await startOutbox();
    const original = endpoint.secret;
    const { secret, previousSecretValidUntil } = rotateSecret(sandbox);
    assert.notEqual(secret, original);
    assert.ok(previousSecretValidUntil.getTime() - Date.now() > 23 * 3_600_000);

    receiver.secrets = [original];
    const signedWithOld = emit(sandbox, 'ping', null, null, {});
    await eventually('a delivery verified with the old secret', () => signedWithOld.status === 'DELIVERED');
    receiver.secrets = [secret];
    const signedWithNew = emit(sandbox, 'ping', null, null, {});
    await eventually('a delivery verified with the new secret', () => signedWithNew.status === 'DELIVERED');
    assert.deepEqual(receiver.events.map((event) => event.signatureValid), [true, true], 'both secrets verify during the overlap');

    endpoint.previousSecretUntil = new Date(Date.now() - 1);
    receiver.secrets = [original];
    const afterOverlap = emit(sandbox, 'ping', null, null, {});
    await eventually('a delivery after the overlap', () => afterOverlap.status === 'DELIVERED');
    assert.equal(receiver.events[2]?.signatureValid, false, 'the old secret no longer signs once the overlap ends');
  });

  test('a fault is consumed by the event it targets and then cleared', async () => {
    const { sandbox, receiver, endpoint } = await startOutbox();
    setFault(sandbox, { mode: 'duplicate', count: 1, eventType: 'order.shipped' });

    const unrelated = emit(sandbox, 'ping', null, null, {});
    await eventually('the unrelated ping', () => unrelated.status === 'DELIVERED');
    assert.equal(receiver.events.length, 1, 'a fault for another event type does not touch it');
    assert.notEqual(sandbox.state.webhookFault, null);

    const targeted = emit(sandbox, 'order.shipped', 'ord_A', 1, {});
    await eventually('the duplicated delivery', () => targeted.status === 'DELIVERED');
    assert.equal(receiver.events.filter((event) => event.id === targeted.eventId).length, 2, 'duplicate sends the event twice');
    assert.equal(sandbox.state.webhookFault, null);
    assert.equal(endpoint.consecutiveFailures, 0);
  });

  test('clearing a fault before it fires leaves deliveries untouched', async () => {
    const { sandbox, receiver } = await startOutbox();
    setFault(sandbox, { mode: 'bad_signature', count: 5, eventType: null });
    clearFault(sandbox);

    const delivery = emit(sandbox, 'ping', null, null, {});
    await eventually('the delivery', () => delivery.status === 'DELIVERED');
    assert.equal(receiver.events[0]?.signatureValid, true);
  });

  test('restoring endpoint health keeps the URL and secrets and forgets the failures', async () => {
    const { endpoint } = await startOutbox();
    const worn = { ...endpoint, status: 'disabled' as const, consecutiveFailures: 7, pausedUntil: new Date() };
    assert.deepEqual(restoreEndpointHealth(worn), { ...endpoint, status: 'active', consecutiveFailures: 0, pausedUntil: null });
  });
});
