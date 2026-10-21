/**
 * The /_sandbox/* surface must not be drivable by a web page the developer visits, and its inputs must be checked
 * before they are used. Ways this could fail, each covered below:
 *  1. A cross-site POST (it carries an Origin) changes the sandbox: redirects webhooks, rotates the secret, resets.
 *  2. A `text/plain` body, the only kind a cross-site form can send, is parsed as JSON and obeyed.
 *  3. A DNS-rebinding page reaches the control endpoints, the portal page, the contract or an image under its own Host.
 *  4. The guard is too strict: curl without an Origin, the portal's bodyless release button, a mapped port
 *     (`-p 18089:8080`) or the compose hostnames (`sandbox:8080`, `localhost:8080`) stop working.
 *  5. The guard is bypassed by an odd Host (path, userinfo, a lookalike of a loopback name) or an Origin of `null`
 *     or another scheme.
 *  6. The portal page lacks its CSP or frame header, or the nonce in the header differs from the script's, so the
 *     release button silently stops working under the policy.
 *  7. Control responses are cacheable, or image links lack `nosniff`.
 *  8. A bad SANDBOX_WEBHOOK_URL is accepted at startup and only fails on the first delivery.
 *  9. A fault `count` of 0, a negative or a non-integer count is accepted and the fault never (or always) fires.
 * 10. A refusal still changes state, or an allowed request is answered differently from before.
 */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createSandbox, type RunningSandbox } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { signedImageUrl } from '../src/images.ts';

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any };
type Call = { method?: string; path: string; headers?: Record<string, string>; body?: string };

let running: RunningSandbox;
let port: number;
let origin: string;

/** node:http, because fetch refuses to set Host and Origin. */
function send({ method = 'GET', path, headers = {}, body }: Call): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json: text.startsWith('{') ? JSON.parse(text) : null });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

const sameOrigin = () => ({ Host: `127.0.0.1:${port}`, Origin: origin });
const json = { 'Content-Type': 'application/json' };

const endpointUrl = () => running.sandbox.state.endpoint.url;

before(async () => {
  running = createSandbox(
    loadConfig({
      SANDBOX_PUBLIC_BASE_URL: 'http://sandbox:8080',
      SANDBOX_PORTAL_BASE_URL: 'http://localhost:8080',
      SANDBOX_WEBHOOK_URL: 'http://127.0.0.1:9/webhooks',
      SANDBOX_ASYNC_STEP_MS: '20',
      SANDBOX_HELD_FIRST_ORDERS: '0',
      SANDBOX_LOG_REQUESTS: 'false',
    }),
  );
  await new Promise<void>((resolve) => running.server.listen(0, '127.0.0.1', resolve));
  port = (running.server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});

after(() => running.close());

describe('cross-site requests (1, 2, 5, 10)', () => {
  test('a cross-origin POST is refused and changes nothing', async () => {
    const before = endpointUrl();
    const reply = await send({
      method: 'POST',
      path: '/_sandbox/webhooks/endpoint',
      headers: { ...json, Host: `127.0.0.1:${port}`, Origin: 'https://evil.example' },
      body: JSON.stringify({ url: 'https://evil.example/steal' }),
    });
    assert.equal(reply.status, 403);
    assert.deepEqual([reply.json.code, reply.json.field], ['forbidden_scope', 'Origin']);
    assert.equal(endpointUrl(), before);
  });

  test('another local site on a different port is cross-origin too', async () => {
    const reply = await send({ method: 'POST', path: '/_sandbox/reset', headers: { Host: `127.0.0.1:${port}`, Origin: 'http://127.0.0.1:3000' } });
    assert.equal(reply.status, 403);
  });

  for (const hostile of ['null', 'file:///tmp/x.html', 'not a url']) {
    test(`Origin "${hostile}" is refused`, async () => {
      const reply = await send({ method: 'POST', path: '/_sandbox/reset', headers: { Host: `127.0.0.1:${port}`, Origin: hostile } });
      assert.equal(reply.status, 403);
    });
  }

  test('a text/plain body is refused as validation_failed on Content-Type and changes nothing', async () => {
    const before = endpointUrl();
    const reply = await send({
      method: 'POST',
      path: '/_sandbox/webhooks/endpoint',
      headers: { 'Content-Type': 'text/plain', ...sameOrigin() },
      body: JSON.stringify({ url: 'https://evil.example/steal' }),
    });
    assert.equal(reply.status, 422);
    assert.deepEqual([reply.json.code, reply.json.field], ['validation_failed', 'Content-Type']);
    assert.equal(endpointUrl(), before);
  });

  test('a body with no Content-Type is refused', async () => {
    const reply = await send({ method: 'POST', path: '/_sandbox/webhooks/endpoint', headers: sameOrigin(), body: '{"url":"https://evil.example"}' });
    assert.equal(reply.status, 422);
  });
});

describe('foreign Host, DNS rebinding (3, 5)', () => {
  const routes: Call[] = [
    { path: '/_sandbox/state' },
    { method: 'POST', path: '/_sandbox/reset' },
    { path: '/_sandbox/openapi.yaml' },
    { path: '/_sandbox/portal/orders/ord_00000000000000000000000000000000' },
    { path: '/_sandbox/images/prd_00000000000000000000000000000000/1.png' },
  ];
  for (const hostile of ['evil.example', 'evil.example:8080', 'localhost.evil.example', 'localhost@evil.example', 'localhost/evil', '127.0.0.1.evil.example:80']) {
    test(`Host "${hostile}" is refused on every /_sandbox route`, async () => {
      for (const call of routes) {
        const reply = await send({ ...call, headers: { Host: hostile } });
        assert.equal(reply.status, 403, `${call.method ?? 'GET'} ${call.path} with Host ${hostile}`);
        assert.deepEqual([reply.json.code, reply.json.field], ['forbidden_scope', 'Host']);
      }
    });
  }
});

describe('allowed callers (4, 10)', () => {
  test('curl with no Origin and a JSON body works, on any loopback name', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, 'LOCALHOST']) {
      const reply = await send({ method: 'POST', path: '/_sandbox/webhooks/endpoint', headers: { ...json, Host: host }, body: JSON.stringify({ url: 'http://127.0.0.1:9/webhooks' }) });
      assert.equal(reply.status, 200, host);
    }
  });

  test('the compose hostnames work with their own origins', async () => {
    for (const [host, siteOrigin] of [['sandbox:8080', 'http://sandbox:8080'], ['localhost:8080', 'http://localhost:8080']] as const) {
      const reply = await send({ path: '/_sandbox/state', headers: { Host: host, Origin: siteOrigin } });
      assert.equal(reply.status, 200, host);
    }
  });

  test('a configured origin may call through a differently mapped port', async () => {
    const reply = await send({ method: 'POST', path: '/_sandbox/webhooks/ping', headers: { Host: `127.0.0.1:${port}`, Origin: 'http://localhost:8080' } });
    assert.equal(reply.status, 200);
  });

  test('a same-origin bodyless POST is allowed (the portal release button)', async () => {
    const reply = await send({ method: 'POST', path: '/_sandbox/webhooks/ping', headers: sameOrigin() });
    assert.equal(reply.status, 200);
  });

  test('a JSON Content-Type with a charset is accepted', async () => {
    const reply = await send({ method: 'POST', path: '/_sandbox/webhooks/endpoint', headers: { 'Content-Type': 'Application/JSON; charset=utf-8', ...sameOrigin() }, body: '{}' });
    assert.equal(reply.status, 200);
  });

  test('control responses, success and error, are never cacheable', async () => {
    const success = await send({ path: '/_sandbox/state', headers: sameOrigin() });
    const unknown = await send({ path: '/_sandbox/nothing-here', headers: sameOrigin() });
    const refused = await send({ path: '/_sandbox/state', headers: { Host: 'evil.example' } });
    assert.deepEqual([success.headers['cache-control'], unknown.headers['cache-control'], refused.headers['cache-control']], ['no-store', 'no-store', 'no-store']);
    assert.deepEqual([unknown.status, unknown.json.code, unknown.json.field], [404, 'not_found', null]);
  });

  test('an unknown path outside the API keeps its 404 envelope', async () => {
    const reply = await send({ path: '/nothing' });
    assert.deepEqual([reply.status, reply.json.code, reply.json.field, typeof reply.json.request_id], [404, 'not_found', null, 'string']);
  });
});

describe('portal page and images (6, 7)', () => {
  test('the page carries a CSP whose nonce matches its script, frame protection, and the release button works', async () => {
    await send({ method: 'PATCH', path: '/_sandbox/store', headers: { ...json, ...sameOrigin() }, body: '{"fulfillment_mode":"manual_approval"}' });
    const orderId = await createHeldOrder();

    const page = await send({ path: `/_sandbox/portal/orders/${orderId}`, headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(page.status, 200);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    const policy = String(page.headers['content-security-policy']);
    const headerNonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
    const scriptNonce = /<script nonce="([^"]+)">/.exec(page.text)?.[1];
    assert.ok(headerNonce, policy);
    assert.equal(scriptNonce, headerNonce);
    assert.equal(/<script(?![^>]*nonce=)/.test(page.text), false, 'every script has a nonce');
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(policy, /default-src 'none'/);
    assert.doesNotMatch(policy, /unsafe-inline/);
    assert.equal(/<style nonce="([^"]+)">/.exec(page.text)?.[1], headerNonce);

    // The page's script does exactly this: a bodyless same-origin POST.
    const release = await send({ method: 'POST', path: `/_sandbox/orders/${orderId}/release`, headers: sameOrigin() });
    assert.equal(release.status, 200);
    assert.notEqual(release.json.status, 'on_hold');
  });

  test('each page load gets a fresh nonce', async () => {
    const nonceOf = async () => /script-src 'nonce-([^']+)'/.exec(String((await send({ path: '/_sandbox/portal/orders/ord_00000000000000000000000000000000', headers: { Host: `127.0.0.1:${port}` } })).headers['content-security-policy']))?.[1];
    assert.notEqual(await nonceOf(), await nonceOf());
  });

  test('image links, including the refusal, carry nosniff', async () => {
    const forbidden = await send({ path: '/_sandbox/images/prd_00000000000000000000000000000000/1.png', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers['x-content-type-options'], 'nosniff');

    const product = [...running.sandbox.state.products.values()][0];
    assert.ok(product?.images[0]);
    const link = new URL(signedImageUrl(origin, product.id, product.images[0].position, new Date(Date.now() + 60_000)));
    const imageUrl = link.pathname + link.search;
    const image = await send({ path: imageUrl, headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(image.status, 200);
    assert.equal(image.headers['x-content-type-options'], 'nosniff');
    assert.equal(image.headers['content-type'], 'image/png');
  });
});

describe('startup and input validation (8, 9)', () => {
  for (const bad of ['not a url', 'ftp://merchant.example/hook', 'javascript:alert(1)', 'merchant.example/hook']) {
    test(`SANDBOX_WEBHOOK_URL "${bad}" fails loadConfig`, () => {
      assert.throws(() => loadConfig({ SANDBOX_WEBHOOK_URL: bad }), /SANDBOX_WEBHOOK_URL must be an http or https URL/);
    });
  }

  test('an http or https SANDBOX_WEBHOOK_URL, or none, is accepted', () => {
    assert.equal(loadConfig({ SANDBOX_WEBHOOK_URL: 'https://merchant.example/hook' }).webhookUrl, 'https://merchant.example/hook');
    assert.equal(loadConfig({ SANDBOX_WEBHOOK_URL: '' }).webhookUrl, null);
    assert.equal(loadConfig({}).webhookUrl, null);
  });

  for (const path of ['/_sandbox/faults', '/_sandbox/webhooks/faults']) {
    const extra = path.includes('webhooks') ? { mode: 'duplicate' } : { code: 'internal_error' };
    for (const count of [0, -1, 1.5, '3', true]) {
      test(`${path} refuses count ${JSON.stringify(count)} on field count`, async () => {
        const reply = await send({ method: 'POST', path, headers: { ...json, ...sameOrigin() }, body: JSON.stringify({ ...extra, count }) });
        assert.equal(reply.status, 422);
        assert.deepEqual([reply.json.code, reply.json.field], ['validation_failed', 'count']);
        assert.deepEqual(running.sandbox.state.faults, []);
        assert.equal(running.sandbox.state.webhookFault, null);
      });
    }

    test(`${path} defaults count to 1 and accepts a positive count`, async () => {
      const omitted = await send({ method: 'POST', path, headers: { ...json, ...sameOrigin() }, body: JSON.stringify(extra) });
      assert.equal(omitted.json.count, 1);
      const three = await send({ method: 'POST', path, headers: { ...json, ...sameOrigin() }, body: JSON.stringify({ ...extra, count: 3 }) });
      assert.equal(three.json.count, 3);
      await send({ method: 'DELETE', path: '/_sandbox/faults', headers: sameOrigin() });
      await send({ method: 'POST', path: '/_sandbox/webhooks/faults', headers: { ...json, ...sameOrigin() }, body: '{"mode":null}' });
    });
  }

  test('wrongly typed values are refused with the existing messages and fields', async () => {
    const cases: { path: string; body: unknown; field: string; message: string; method?: string }[] = [
      { path: '/_sandbox/store', method: 'PATCH', body: { fulfillment_mode: 5 }, field: 'fulfillment_mode', message: 'fulfillment_mode must be instant, manual_approval or delayed_auto_submit.' },
      { path: '/_sandbox/store', method: 'PATCH', body: { delay_hours: 0 }, field: 'delay_hours', message: 'delay_hours must be a positive whole number.' },
      { path: '/_sandbox/keys', body: { key: 'other', status: 'active' }, field: 'key', message: 'key must be "full" or "read_only".' },
      { path: '/_sandbox/keys', body: { key: 'full', status: 'gone' }, field: 'status', message: 'status must be active, expired or revoked.' },
      { path: '/_sandbox/connection/disable', body: { reason: ['admin'] }, field: 'reason', message: 'reason must be plan_lapsed, disconnected, revoked or admin.' },
      { path: '/_sandbox/rate-limits', body: { general: 0 }, field: 'general', message: 'general must be a positive whole number.' },
      { path: '/_sandbox/webhooks/faults', body: { mode: 'sideways' }, field: 'mode', message: 'mode must be duplicate, out_of_order, bad_signature, stale_timestamp or null.' },
      { path: '/_sandbox/webhooks/endpoint', body: { url: 7 }, field: 'url', message: 'url must be an http or https URL.' },
    ];
    for (const { path, body, field, message, method = 'POST' } of cases) {
      const reply = await send({ method, path, headers: { ...json, ...sameOrigin() }, body: JSON.stringify(body) });
      assert.deepEqual([reply.status, reply.json.code, reply.json.field, reply.json.message], [422, 'validation_failed', field, message], path);
    }
  });
});

async function createHeldOrder(): Promise<string> {
  const headers = { Authorization: `Bearer ${running.sandbox.config.fullAccessKey}`, 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` };
  const variant = [...running.sandbox.state.products.values()].flatMap((product) => product.variants).find((candidate) => candidate.quantity !== 0);
  assert.ok(variant);
  const created = await send({
    method: 'POST',
    path: '/merchant/v1/orders',
    headers: { ...headers, 'Idempotency-Key': 'guard-test-order-1' },
    body: JSON.stringify({
      external_order_id: 'GUARD-1',
      payment_status: 'paid',
      currency: running.sandbox.state.store.currency,
      customer: { email: 'buyer@example.com' },
      shipping_address: { name: 'Sara Ahmed', phone: '+971501234567', address1: 'Marina Walk 1', city: 'Dubai', state: 'Dubai', country: 'AE' },
      items: [{ variant_id: variant.id, quantity: 1, unit_price: '79.00' }],
    }),
  });
  assert.equal(created.status, 201, created.text);
  const orderId: string = created.json.id;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const current = await send({ path: `/merchant/v1/orders/${orderId}`, headers });
    if (current.json.status === 'on_hold') return orderId;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The order never went on hold');
}
