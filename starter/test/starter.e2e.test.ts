/**
 * Runs the starter shop against the real sandbox and drives it like a shopper and a merchant.
 *
 * Ways the starter could fail, each covered below:
 *  1. It never lists published products, does not host the images, or does not confirm the listing.
 *  2. Checkout invents a shipping price when the rates call fails.
 *  3. A paid order is not pushed, is pushed twice, or is lost when PrintaRex is briefly unavailable.
 *  4. Webhooks do not update the order, duplicates are applied twice, or bad signatures are accepted.
 *  5. A missing phone cannot be fixed from the website.
 *  6. Shipping/delivery and cancellation never reach the shopper's order page.
 *  7. Unpublished products stay on sale.
 *  8. Missed webhooks are never recovered (reconcile).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createSandbox, type RunningSandbox } from '../../sandbox/src/app.ts';
import { loadConfig as loadSandboxConfig } from '../../sandbox/src/config.ts';
import { createStarter, type Starter } from '../src/app.ts';
import { Db } from '../src/db.ts';
import { csrfTokenOf, form, type SandboxStateView, TEST_ADMIN_TOKEN, TEST_SESSION_SECRET, waitUntil } from './helpers.ts';

let sandbox: RunningSandbox;
let starter: Starter;
let shopUrl: string;
let sandboxUrl: string;
const artifactsDir = process.env.ARTIFACTS_DIR ?? join(import.meta.dirname, '../../artifacts');

const control = async <T = unknown>(method: string, path: string, body?: unknown) => {
  const response = await fetch(`${sandboxUrl}/_sandbox${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await response.json()) as T;
};

const shopper = { name: 'Sara Ahmed', email: 'sara@example.com', phone: '+971501234567', address1: 'Marina Walk 1', state: 'Dubai' };

async function placeOrder(overrides: Record<string, string> = {}): Promise<string> {
  const listing = Object.values(starter.db.data.listings).find((candidate) => candidate.title.includes('T-Shirt'))!;
  const variant = listing.variants.find((candidate) => candidate.available)!;
  const response = await fetch(`${shopUrl}/checkout/place`, form({ variant: variant.id, qty: '1', shipping: '15.00', ...shopper, ...overrides }));
  assert.equal(response.status, 303);
  return response.headers.get('location')!.split('/').pop()!;
}

const localOrder = (id: string) => starter.db.data.orders[id]!;

before(async () => {
  const sandboxConfig = loadSandboxConfig({
    SANDBOX_ASYNC_STEP_MS: '20',
    SANDBOX_WEBHOOK_RETRY_SECONDS: '0.05,0.05,0.05,0.05,0.05,0.05,0.05',
    SANDBOX_CANCEL_AUTO_RESOLVE_MS: '150',
    SANDBOX_HELD_FIRST_ORDERS: '0',
    SANDBOX_LOG_REQUESTS: 'false',
  });
  sandbox = createSandbox(sandboxConfig);
  await new Promise<void>((resolve) => sandbox.server.listen(0, '127.0.0.1', resolve));
  sandboxUrl = `http://127.0.0.1:${(sandbox.server.address() as AddressInfo).port}`;
  sandbox.sandbox.config.publicBaseUrl = sandboxUrl;
  sandbox.sandbox.view.publicBaseUrl = sandboxUrl;

  starter = createStarter({
    port: 0,
    apiBaseUrl: `${sandboxUrl}/merchant/v1`,
    apiKey: sandboxConfig.fullAccessKey,
    webhookSecrets: [sandboxConfig.webhookSecret],
    storefrontBaseUrl: 'https://shop.example',
    dataDir: mkdtempSync(join(tmpdir(), 'starter-')),
    reconcileIntervalMs: 3_600_000,
    sessionSecret: TEST_SESSION_SECRET,
    adminToken: TEST_ADMIN_TOKEN,
    imageHosts: [],
  });
  await new Promise<void>((resolve) => starter.server.listen(0, '127.0.0.1', resolve));
  shopUrl = `http://127.0.0.1:${(starter.server.address() as AddressInfo).port}`;
  await starter.start();
  await control('POST', '/webhooks/endpoint', { url: `${shopUrl}/webhooks/printarex` });
});

after(async () => {
  await starter.stop();
  await sandbox.close();
});

describe('starter shop against the sandbox', () => {
  test('1. published products are listed, images hosted locally, listings confirmed', async () => {
    await waitUntil(() => Object.values(starter.db.data.listings).filter((listing) => listing.images.length > 1).length === 2, 'two listings with galleries');
    const products = (await control<SandboxStateView>('GET', '/state')).products;
    await waitUntil(async () => (await control<SandboxStateView>('GET', '/state')).products.every((product) => product.listing_state === 'confirmed'), 'confirmed in PrintaRex');
    assert.equal(products.length, 2);
    const listing = Object.values(starter.db.data.listings)[0]!;
    assert.match(listing.images[0]!, /^\/images\//);
    assert.equal((await fetch(`${shopUrl}${listing.images[0]}`)).status, 200);
    const home = await (await fetch(shopUrl)).text();
    assert.ok(home.includes(listing.title));
  });

  test('2. checkout shows the PrintaRex shipping estimate, and never invents one when rates fail', async () => {
    const listing = Object.values(starter.db.data.listings).find((candidate) => candidate.title.includes('T-Shirt'))!;
    const variant = listing.variants.find((candidate) => candidate.available)!;
    const quote = await (await fetch(`${shopUrl}/checkout/quote`, form({ variant: variant.id, qty: '2', ...shopper }))).text();
    assert.ok(quote.includes('Shipping: 20.00 AED'), quote);
    await control('POST', '/faults', { code: 'internal_error', route: 'POST /shipping/rates' });
    const failed = await (await fetch(`${shopUrl}/checkout/quote`, form({ variant: variant.id, qty: '2', ...shopper }))).text();
    assert.ok(failed.includes('Shipping prices are unavailable'));
    assert.ok(!failed.includes('Pay and place order'));
  });

  test('3+4. a paid order is pushed and its status arrives by signed webhook', async () => {
    const id = await placeOrder();
    await waitUntil(() => localOrder(id).printarex.status === 'awaiting_provider', 'awaiting_provider via webhook');
    assert.equal(localOrder(id).push.state, 'sent');
    assert.ok(starter.db.data.webhookLog.some((entry) => entry.type === 'order.status_changed'));
  });

  test('3. a temporary outage keeps the order in the retry queue, then the same order is sent once', async () => {
    await control('POST', '/faults', { code: 'entitlement_unavailable', route: 'POST /orders' });
    const id = await placeOrder();
    assert.equal(localOrder(id).push.state, 'pending');
    assert.match(localOrder(id).push.lastError ?? '', /entitlement_unavailable/);
    starter.db.update((data) => {
      data.orders[id]!.push.nextAttemptAt = new Date().toISOString();
    });
    await starter.orders.pushDueOrders();
    assert.equal(localOrder(id).push.state, 'sent', localOrder(id).push.lastError ?? '');
    const matching = (await control<SandboxStateView>('GET', '/state')).orders.filter((order) => order.external_order_id === id);
    assert.equal(matching.length, 1);
  });

  test('4. duplicate deliveries are ignored and bad signatures are refused', async () => {
    await control('POST', '/webhooks/faults', { mode: 'duplicate', event_type: 'ping' });
    await control('POST', '/webhooks/ping');
    await waitUntil(() => starter.db.data.webhookLog.some((entry) => entry.type === 'ping' && entry.outcome === 'duplicate, ignored'), 'duplicate ignored');
    await control('POST', '/webhooks/faults', { mode: 'bad_signature', event_type: 'ping' });
    const ping = await control<{ id: string }>('POST', '/webhooks/ping');
    await waitUntil(() => sandbox.sandbox.state.deliveries.some((delivery) => delivery.id === ping.id && delivery.responseCode === 401), 'refused with 401');
  });

  test('5. a missing phone is fixed from the order page and the order continues', async () => {
    const id = await placeOrder({ phone: '' });
    await waitUntil(() => localOrder(id).printarex.holdReason?.code === 'missing_phone', 'missing_phone hold');
    const page = await (await fetch(`${shopUrl}/orders/${id}`)).text();
    assert.ok(page.includes('Phone number for the courier'));
    await fetch(`${shopUrl}/orders/${id}/phone`, form({ phone: '+971509998877', csrf: await csrfTokenOf(shopUrl, id) }));
    await waitUntil(() => localOrder(id).printarex.status === 'awaiting_provider', 'released');
  });

  test('6. production, shipping and delivery reach the shopper page', async () => {
    const id = await placeOrder();
    await waitUntil(() => localOrder(id).printarex.status === 'awaiting_provider', 'awaiting_provider');
    const remoteId = localOrder(id).printarex.orderId!;
    for (let step = 0; step < 4; step++) await control('POST', `/orders/${remoteId}/advance`);
    await waitUntil(() => localOrder(id).printarex.status === 'delivered', 'delivered');
    const page = await (await fetch(`${shopUrl}/orders/${id}`)).text();
    assert.ok(page.includes('Delivered'));
    assert.ok(page.includes('Sandbox Express'));
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, 'starter-order-page-delivered.html'), page);
  });

  test('6. cancelling from the shop arrives as cancelled', async () => {
    const id = await placeOrder();
    await waitUntil(() => localOrder(id).printarex.status === 'awaiting_provider', 'awaiting_provider');
    await fetch(`${shopUrl}/orders/${id}/cancel`, form({ csrf: await csrfTokenOf(shopUrl, id) }));
    assert.equal(localOrder(id).printarex.notice, 'Cancellation requested. We will confirm shortly.');
    await waitUntil(() => localOrder(id).printarex.status === 'cancelled', 'cancelled');
  });

  test('7. an unpublished product is taken off sale and reported removed', async () => {
    const listing = Object.values(starter.db.data.listings).find((candidate) => candidate.title.includes('Mug'))!;
    await control('POST', `/products/${listing.printarexProductId}/unpublish`);
    await waitUntil(() => starter.db.data.listings[listing.printarexProductId]?.visible === false, 'hidden');
    assert.equal((await fetch(`${shopUrl}/products/${listing.websiteProductId}`)).status, 404);
  });

  test('8. reconcile recovers a status change whose webhook was missed', async () => {
    const id = await placeOrder();
    await waitUntil(() => localOrder(id).printarex.status === 'awaiting_provider', 'awaiting_provider');
    await control('POST', '/webhooks/endpoint', { url: null });
    await control('POST', `/orders/${localOrder(id).printarex.orderId}/accept`);
    assert.equal(localOrder(id).printarex.status, 'awaiting_provider');
    starter.db.update((data) => {
      data.lastReconciledAt = new Date(Date.now() - 3_600_000).toISOString();
    });
    assert.ok((await starter.orders.reconcile()) >= 1);
    assert.equal(localOrder(id).printarex.status, 'awaiting_payment');
    await control('POST', '/webhooks/endpoint', { url: `${shopUrl}/webhooks/printarex` });
  });

  test('9. a quantity that is not a whole number is refused, and pages forbid scripts', async () => {
    const listing = Object.values(starter.db.data.listings).find((candidate) => candidate.title.includes('T-Shirt'))!;
    const variant = listing.variants.find((candidate) => candidate.available)!;
    const ordersBefore = Object.keys(starter.db.data.orders).length;
    for (const qty of ['abc', '0', '-1', '1.5', '']) {
      const response = await fetch(`${shopUrl}/checkout/place`, form({ variant: variant.id, qty, shipping: '15.00', ...shopper }));
      assert.equal(response.status, 400, `qty "${qty}"`);
    }
    assert.equal(Object.keys(starter.db.data.orders).length, ordersBefore);
    assert.equal((await fetch(`${shopUrl}/checkout?variant=${variant.id}&qty=abc`)).status, 400);
    const page = await fetch(`${shopUrl}/products/${listing.websiteProductId}`);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'none'/);
  });

  test('10. a corrupt data file stops startup instead of being overwritten', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'starter-corrupt-'));
    writeFileSync(join(dataDir, 'db.json'), '{"orders": {"W-1": ');
    assert.throws(() => new Db(dataDir), /Cannot read .*db\.json/);
    assert.equal(readFileSync(join(dataDir, 'db.json'), 'utf8'), '{"orders": {"W-1": ');
    assert.deepEqual(new Db(mkdtempSync(join(tmpdir(), 'starter-fresh-'))).data.orders, {});
  });
});
