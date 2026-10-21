/**
 * Drives the starter like an attacker and like a careful merchant, against the real sandbox.
 *
 * Ways the starter could fail, each covered below:
 *  1. Order ids can be guessed (time based, short), or two orders made together share one id.
 *  2. An order page, its phone form or its cancel form answers for an id that does not exist.
 *  3. Another website can post the phone or cancel form: no token, a wrong token, or the token of a different order is accepted.
 *  4. `/admin` shows buyer data without a login, answers when it was meant to be off, or accepts a wrong token.
 *  5. The server starts without STARTER_SESSION_SECRET, or with a secret too short to resist guessing.
 *  6. A product id or image position from a payload writes a file outside the images folder, or goes into an API URL unencoded.
 *  7. A product id such as `__proto__` is used as a listing key.
 *  8. An image download follows a redirect, accepts a non-image, a huge body (even without Content-Length), or a scheme or host that is not allowed.
 *  9. Stored images are served with a type the browser may second-guess.
 * 10. `description_html` reaches the page as markup (script, base, meta refresh, inline-styled fake content).
 * 11. db.json, which holds buyer data, is readable by other users.
 * 12. A `javascript:` or `data:` tracking or action link is rendered as a link.
 * 13. The shop still sends the UAE as the destination for a store in another country.
 * 14. A webhook signed with two `v1` values (secret rotation) is refused when only one matches, or accepted when none does.
 * 15. An order id such as `__proto__` from a webhook finds a prototype property instead of an order.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createStarter, type Starter } from '../src/app.ts';
import { CatalogSync, RefusedPayloadError } from '../src/catalog-sync.ts';
import { loadConfig, type StarterConfig } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { type ApiImage, type ApiProduct, PrintarexApiError, PrintarexClient } from '../src/printarex-client.ts';
import { csrfTokenOf, form, type Kit, listen, type SandboxStateView, starterConfig, startSandbox, TEST_ADMIN_TOKEN, TEST_SESSION_SECRET, waitUntil } from './helpers.ts';

let kit: Kit;
let config: StarterConfig;
let starter: Starter;
let shopUrl: string;
let client: PrintarexClient;
let imageServer: Server;
let imageUrl: string;
let targetHits = 0;
const extraServers: Server[] = [];
const extraStarters: Starter[] = [];

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)]);
const shopper = { name: 'Sara Ahmed', email: 'sara@example.com', phone: '+971501234567', address1: 'Marina Walk 1', state: 'Dubai' };

async function streamZeros(response: ServerResponse, totalBytes: number): Promise<void> {
  const chunk = Buffer.alloc(64 * 1024);
  for (let sent = 0; sent < totalBytes && !response.destroyed; sent += chunk.length) {
    if (!response.write(chunk)) await new Promise((resolve) => response.once('drain', resolve));
  }
  response.end();
}

/** A tiny image host: good and bad files, a redirect, and a counter for what the redirect points at. */
function startImageServer(): Server {
  return createServer((request, response) => {
    const path = request.url ?? '';
    const send = (type: string, body: Buffer) => response.writeHead(200, { 'Content-Type': type }).end(body);
    if (path === '/ok.jpg') return send('image/jpeg', JPEG_BYTES);
    if (path === '/ok.webp') return send('image/webp', WEBP_BYTES);
    if (path === '/ok.png') return send('image/png', PNG_BYTES);
    if (path === '/not-an-image.png') return send('image/png', Buffer.from('<html><script>alert(1)</script></html>'));
    if (path === '/redirect.png') return void response.writeHead(302, { Location: '/target.png' }).end();
    if (path === '/target.png') {
      targetHits += 1;
      return send('image/png', PNG_BYTES);
    }
    if (path === '/huge-chunked.png') {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.write(PNG_BYTES);
      return void streamZeros(response, 11 * 1024 * 1024);
    }
    if (path === '/huge-declared.png') {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(20 * 1024 * 1024) });
      return void response.write(PNG_BYTES);
    }
    response.writeHead(404).end();
  });
}

async function placeOrder(overrides: Record<string, string> = {}): Promise<string> {
  const listing = Object.values(starter.db.data.listings).find((candidate) => candidate.title.includes('T-Shirt'))!;
  const variant = listing.variants.find((candidate) => candidate.available)!;
  const response = await fetch(`${shopUrl}/checkout/place`, form({ variant: variant.id, qty: '1', shipping: '15.00', ...shopper, ...overrides }));
  assert.equal(response.status, 303);
  return response.headers.get('location')!.split('/').pop()!;
}

const localOrder = (id: string) => starter.db.data.orders[id]!;
const mugListing = () => Object.values(starter.db.data.listings).find((candidate) => candidate.title.includes('Mug'))!;
const freshMug = async (): Promise<ApiProduct> => structuredClone((await client.getProduct(mugListing().printarexProductId)).data);
const withFirstImage = (product: ApiProduct, image: unknown): ApiProduct => ({ ...product, images: [image as ApiImage] });
const filesIn = (directory: string) => readdirSync(directory).sort();
const basic = (password: string) => `Basic ${Buffer.from(`anyone:${password}`).toString('base64')}`;

async function startExtraStarter(overrides: Partial<StarterConfig>, extraKit: Kit = kit): Promise<{ starter: Starter; url: string; config: StarterConfig }> {
  const extraConfig = starterConfig(extraKit, overrides);
  const extra = createStarter(extraConfig);
  extraStarters.push(extra);
  return { starter: extra, url: await listen(extra.server), config: extraConfig };
}

/** A catalog with one hand-made listing, so a refused update is observable without calling the sandbox. */
function standaloneCatalog(productId: string, overrides: Partial<StarterConfig>): { catalog: CatalogSync; db: Db } {
  const standaloneConfig = starterConfig(kit, overrides);
  const db = new Db(standaloneConfig.dataDir);
  db.update((data) => {
    data.listings[productId] = {
      printarexProductId: productId,
      websiteProductId: `p-${productId.slice(4, 16)}`,
      title: 'Seeded',
      descriptionHtml: '',
      images: [],
      variants: [],
      productionCost: null,
      visible: true,
      listingState: 'confirmed',
    };
  });
  return { catalog: new CatalogSync(standaloneConfig, db, new PrintarexClient(standaloneConfig.apiBaseUrl, standaloneConfig.apiKey)), db };
}

before(async () => {
  kit = await startSandbox();
  config = starterConfig(kit);
  starter = createStarter(config);
  shopUrl = await listen(starter.server);
  client = new PrintarexClient(kit.apiBaseUrl, kit.apiKey);
  imageServer = startImageServer();
  imageUrl = await listen(imageServer);
  await starter.start();
  await kit.control('POST', '/webhooks/endpoint', { url: `${shopUrl}/webhooks/printarex` });
  await waitUntil(() => Object.values(starter.db.data.listings).filter((listing) => listing.images.length > 1).length === 2, 'two listings with galleries');
});

after(async () => {
  await starter.stop();
  for (const extra of extraStarters) await extra.stop();
  for (const server of [imageServer, ...extraServers]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await kit.sandbox.close();
});

describe('order pages are capability URLs, and their forms need a token', () => {
  test('1. order ids are 128 random bits, valid external ids, and orders placed together never collide', async () => {
    const ids = await Promise.all([placeOrder(), placeOrder(), placeOrder()]);
    assert.equal(new Set(ids).size, 3);
    for (const id of ids) {
      assert.match(id, /^W-[0-9a-f]{32}$/);
      assert.ok(id.length <= 50);
    }
    await waitUntil(() => ids.every((id) => localOrder(id).push.state === 'sent'), 'all three pushed');
    const remoteExternalIds = (await kit.control<SandboxStateView>('GET', '/state')).orders.map((order) => order.external_order_id);
    for (const id of ids) assert.ok(remoteExternalIds.includes(id));
  });

  test('2. a guessed, old-style or foreign order id is a 404 on the page and on both forms', async () => {
    const real = await placeOrder();
    const guesses = ['W-MGZ1Q2', `W-${'0'.repeat(32)}`, real.toUpperCase(), real.slice(0, -1), '__proto__', 'constructor', `${real}x`];
    for (const guess of guesses) {
      assert.equal((await fetch(`${shopUrl}/orders/${guess}`)).status, 404, guess);
      assert.equal((await fetch(`${shopUrl}/orders/${guess}/phone`, form({ phone: '+971509998877', csrf: '0'.repeat(64) }))).status, 404, guess);
      assert.equal((await fetch(`${shopUrl}/orders/${guess}/cancel`, form({ csrf: '0'.repeat(64) }))).status, 404, guess);
    }
    const page = await fetch(`${shopUrl}/orders/${real}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  });

  test('3. the phone form needs this order\'s token', async () => {
    const id = await placeOrder({ phone: '' });
    const other = await placeOrder({ phone: '' });
    await waitUntil(() => localOrder(id).printarex.holdReason?.code === 'missing_phone' && localOrder(other).printarex.holdReason?.code === 'missing_phone', 'both held');
    const phone = '+971509998877';
    const otherOrdersToken = await csrfTokenOf(shopUrl, other);
    for (const csrf of [undefined, '', '0'.repeat(64), 'short', otherOrdersToken]) {
      const response = await fetch(`${shopUrl}/orders/${id}/phone`, form(csrf === undefined ? { phone } : { phone, csrf }));
      assert.equal(response.status, 403, String(csrf));
    }
    assert.equal(localOrder(id).address.phone, null);
    assert.equal(localOrder(id).printarex.holdReason?.code, 'missing_phone');
    const accepted = await fetch(`${shopUrl}/orders/${id}/phone`, form({ phone, csrf: await csrfTokenOf(shopUrl, id) }));
    assert.equal(accepted.status, 303);
    await waitUntil(() => localOrder(id).printarex.status === 'awaiting_provider', 'released with the right token');
  });

  test('3. the cancel form needs this order\'s token', async () => {
    const id = await placeOrder();
    const other = await placeOrder();
    await waitUntil(() => localOrder(id).printarex.status === 'awaiting_provider' && localOrder(other).printarex.status === 'awaiting_provider', 'both awaiting_provider');
    const otherOrdersToken = await csrfTokenOf(shopUrl, other);
    for (const csrf of [undefined, '', '0'.repeat(64), otherOrdersToken]) {
      const response = await fetch(`${shopUrl}/orders/${id}/cancel`, form(csrf === undefined ? {} : { csrf }));
      assert.equal(response.status, 403, String(csrf));
    }
    assert.equal(localOrder(id).printarex.notice, null);
    assert.equal(localOrder(id).printarex.status, 'awaiting_provider');
    assert.equal((await fetch(`${shopUrl}/orders/${id}/cancel`, form({ csrf: await csrfTokenOf(shopUrl, id) }))).status, 303);
    assert.equal(localOrder(id).printarex.notice, 'Cancellation requested. We will confirm shortly.');
  });

  test('11. db.json holds buyer data and is readable only by its owner', () => {
    assert.equal(statSync(join(config.dataDir, 'db.json')).mode & 0o777, 0o600);
  });
});

describe('/admin is off by default and protected when on', () => {
  test('4. unset token: 404 whatever the request carries', async () => {
    const { url } = await startExtraStarter({ adminToken: null });
    assert.equal((await fetch(`${url}/admin`)).status, 404);
    assert.equal((await fetch(`${url}/admin`, { headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` } })).status, 404);
  });

  test('4. set token: 401 without it or with a wrong one, 200 with Basic or Bearer', async () => {
    const missing = await fetch(`${shopUrl}/admin`);
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get('www-authenticate') ?? '', /^Basic realm=/);
    for (const authorization of [basic('wrong'), basic(''), basic(TEST_ADMIN_TOKEN.slice(0, -1)), `Bearer wrong`, `Bearer ${TEST_ADMIN_TOKEN}x`, `Basic ${Buffer.from(TEST_ADMIN_TOKEN).toString('base64')}`, TEST_ADMIN_TOKEN, 'Digest abc']) {
      assert.equal((await fetch(`${shopUrl}/admin`, { headers: { Authorization: authorization } })).status, 401, authorization);
    }
    const [order] = Object.keys(starter.db.data.orders);
    for (const authorization of [basic(TEST_ADMIN_TOKEN), `Bearer ${TEST_ADMIN_TOKEN}`]) {
      const response = await fetch(`${shopUrl}/admin`, { headers: { Authorization: authorization } });
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes(order!));
    }
  });

  test('5. the server refuses to start without a session secret, or with a short secret', () => {
    const base = { PRINTAREX_API_BASE_URL: 'http://localhost:8080/merchant/v1', PRINTAREX_API_KEY: 'key', PRINTAREX_WEBHOOK_SECRET: 'whsec_x' };
    assert.throws(() => loadConfig(base), /STARTER_SESSION_SECRET is required/);
    assert.throws(() => loadConfig({ ...base, STARTER_SESSION_SECRET: 'too-short' }), /STARTER_SESSION_SECRET must be at least 32 characters/);
    assert.throws(() => loadConfig({ ...base, STARTER_SESSION_SECRET: TEST_SESSION_SECRET, STARTER_ADMIN_TOKEN: 'too-short' }), /STARTER_ADMIN_TOKEN must be at least 32 characters/);
    const loaded = loadConfig({ ...base, STARTER_SESSION_SECRET: TEST_SESSION_SECRET, PRINTAREX_IMAGE_HOSTS: ' CDN.Example.com, ,images.example ' });
    assert.equal(loaded.adminToken, null);
    assert.deepEqual(loaded.imageHosts, ['cdn.example.com', 'images.example']);
    assert.deepEqual(loadConfig({ ...base, STARTER_SESSION_SECRET: TEST_SESSION_SECRET }).imageHosts, []);
  });
});

describe('data from payloads cannot reach the file system or an API path', () => {
  test('6. a product id that is not prd_ plus 32 hex characters is refused before any file is built', async () => {
    const product = await freshMug();
    const imagesDir = starter.db.imagesDir;
    const filesBefore = [filesIn(config.dataDir), filesIn(imagesDir)];
    for (const id of ['prd_../../../../../x', '../../etc/passwd', 'prd_' + 'a'.repeat(31), 'prd_' + 'A'.repeat(32), 'prd_' + 'a'.repeat(33), '', 'prd_/..%2f' + 'a'.repeat(30)]) {
      await assert.rejects(starter.catalog.onPublishRequested({ ...product, id }), RefusedPayloadError, id);
      await assert.rejects(starter.catalog.onProductUpdated({ ...product, id }), RefusedPayloadError, id);
      assert.throws(() => starter.catalog.onDeleted(id), RefusedPayloadError, id);
      await assert.rejects(starter.catalog.onUnpublishRequested(id), RefusedPayloadError, id);
    }
    assert.equal(existsSync(join(imagesDir, 'p-../../../..-1.png')), false);
    assert.deepEqual([filesIn(config.dataDir), filesIn(imagesDir)], filesBefore);
  });

  test('6. an image position that is not a whole number from 1 to 100 is refused', async () => {
    const product = await freshMug();
    const listingBefore = JSON.stringify(mugListing());
    const filesBefore = filesIn(starter.db.imagesDir);
    for (const position of ['../../escape', '../x', '/../../x', 0, -1, 101, 1.5, '1', null, 1e9]) {
      await assert.rejects(starter.catalog.onProductUpdated(withFirstImage(product, { src: `${imageUrl}/ok.png`, position })), RefusedPayloadError, String(position));
    }
    assert.equal(JSON.stringify(mugListing()), listingBefore);
    assert.deepEqual(filesIn(starter.db.imagesDir), filesBefore);
  });

  test('6. ids are encoded into API paths, so "../orders" cannot reach another route', async () => {
    await assert.rejects(client.getProduct('../orders'), (error: unknown) => error instanceof PrintarexApiError && error.status === 404);
    await assert.rejects(client.getOrder('../products'), (error: unknown) => error instanceof PrintarexApiError && error.status === 404);
  });

  test('7. "__proto__" is never used as a listing key', async () => {
    const product = await freshMug();
    await assert.rejects(starter.catalog.onProductUpdated({ ...product, id: '__proto__' }), RefusedPayloadError);
    assert.throws(() => starter.catalog.onInventoryUpdated('__proto__', []), RefusedPayloadError);
    assert.throws(() => starter.catalog.onDeleted('constructor'), RefusedPayloadError);
    assert.equal(Object.hasOwn(starter.db.data.listings, '__proto__'), false);
    assert.equal(({} as Record<string, unknown>).title, undefined);
  });

  test('15. an order id such as "__proto__" in a webhook finds no order', () => {
    const remote = { id: 'ord_x', external_order_id: '__proto__', status: 'shipped', hold_reason: null, shipments: [], sequence: 1 };
    const ordersBefore = Object.keys(starter.db.data.orders).length;
    assert.equal(starter.orders.applyIfNewer(remote, 1), false);
    assert.equal(starter.orders.applyIfNewer({ ...remote, external_order_id: 'constructor' }, 1), false);
    starter.orders.setNotice('constructor', 'ignored');
    assert.equal(Object.keys(starter.db.data.orders).length, ordersBefore);
  });
});

describe('image downloads are limited', () => {
  // The whole gallery is kept: with fewer images than before, the website keeps the ones it already hosts.
  const mugWithImage = async (path: string): Promise<ApiProduct> => {
    const product = await freshMug();
    return { ...product, images: product.images.map((image) => (image.position === 1 ? { ...image, src: `${imageUrl}${path}` } : image)) };
  };
  const imagesBefore = () => JSON.stringify(mugListing().images);

  test('8. a body that is not an image is refused, whatever its name or Content-Type says', async () => {
    const before = imagesBefore();
    await assert.rejects(starter.catalog.onProductUpdated(await mugWithImage('/not-an-image.png')), /not a PNG, JPEG or WebP/);
    assert.equal(imagesBefore(), before);
  });

  test('8. a body over 10 MB is refused while streaming, with or without Content-Length', async () => {
    const filesBefore = filesIn(starter.db.imagesDir);
    await assert.rejects(starter.catalog.onProductUpdated(await mugWithImage('/huge-chunked.png')), /larger than 10 MB/);
    await assert.rejects(starter.catalog.onProductUpdated(await mugWithImage('/huge-declared.png')), /larger than 10 MB/);
    assert.deepEqual(filesIn(starter.db.imagesDir), filesBefore);
  });

  test('8. a redirect is not followed', async () => {
    targetHits = 0;
    await starter.catalog.onProductUpdated(await mugWithImage('/redirect.png'));
    assert.equal(targetHits, 0);
  });

  test('8. only http(s) links are used, and http only when the API itself is http', async () => {
    for (const src of ['file:///etc/passwd', 'ftp://host/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'not a url']) {
      await assert.rejects(starter.catalog.onProductUpdated(withFirstImage(await freshMug(), { src, position: 1 })), RefusedPayloadError, src);
    }
    const product = await freshMug();
    const { catalog } = standaloneCatalog(product.id, { apiBaseUrl: 'https://api.printarex.example/merchant/v1' });
    await assert.rejects(catalog.onProductUpdated(withFirstImage(product, { src: `${imageUrl}/ok.png`, position: 1 })), /uses http:/);
  });

  test('8. PRINTAREX_IMAGE_HOSTS limits the hosts when set', async () => {
    const product = withFirstImage(await freshMug(), { src: `${imageUrl}/ok.png`, position: 1 });
    const refused = standaloneCatalog(product.id, { imageHosts: ['cdn.example.com'] });
    await assert.rejects(refused.catalog.onProductUpdated(product), /not in PRINTAREX_IMAGE_HOSTS/);
    assert.deepEqual(refused.db.data.listings[product.id]?.images, []);
    const allowed = standaloneCatalog(product.id, { imageHosts: ['127.0.0.1'] });
    await allowed.catalog.onProductUpdated(product);
    assert.deepEqual(allowed.db.data.listings[product.id]?.images, [`/images/p-${product.id.slice(4, 16)}-1.png`]);
  });

  test('8+9. PNG, JPEG and WebP are kept under a name that matches the bytes, and served with nosniff', async () => {
    const expectations = [
      ['/ok.png', 'png', 'image/png', PNG_BYTES],
      ['/ok.jpg', 'jpg', 'image/jpeg', JPEG_BYTES],
      ['/ok.webp', 'webp', 'image/webp', WEBP_BYTES],
    ] as const;
    for (const [path, extension, contentType, bytes] of expectations) {
      await starter.catalog.onProductUpdated(await mugWithImage(path));
      const stored = mugListing().images.find((image) => image.endsWith(`-1.${extension}`));
      assert.ok(stored, path);
      const served = await fetch(`${shopUrl}${stored}`);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), contentType);
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(Buffer.from(await served.arrayBuffer()).equals(bytes));
    }
  });
});

describe('text and links from the API are never trusted as markup', () => {
  test('10. description_html is shown as escaped plain text, and the CSP closes base and object', async () => {
    const product = await freshMug();
    product.description_html =
      '<p>Soft &amp; strong</p><script>alert("x")</script><base href="//evil.example/"><meta http-equiv="refresh" content="0;url=//evil.example">' +
      '<style>body{display:none}</style><div style="position:fixed;inset:0">Fake login</div><p>&lt;script&gt;alert(2)&lt;/script&gt;</p><p>Second paragraph</p>';
    await starter.catalog.onProductUpdated(product);
    const response = await fetch(`${shopUrl}/products/${mugListing().websiteProductId}`);
    const page = await response.text();
    assert.ok(page.includes('<p>Soft &amp; strong</p>'), page);
    assert.ok(page.includes('<p>Second paragraph</p>'));
    assert.ok(page.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
    for (const forbidden of ['<script', '<base', '<meta http-equiv', 'alert("x")', 'display:none', 'position:fixed', '<div style']) assert.ok(!page.includes(forbidden), forbidden);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  test('12. a javascript: or data: tracking or action link is text; safe links stay links', async () => {
    const id = await placeOrder();
    await waitUntil(() => localOrder(id).printarex.status === 'awaiting_provider', 'awaiting_provider');
    const shipment = (trackingNumber: string, trackingUrl: string) => ({ method: 'carrier', carrier: 'Courier', tracking_number: trackingNumber, tracking_url: trackingUrl, delivered_at: null });
    starter.db.update((data) => {
      const stored = data.orders[id]!;
      stored.printarex.shipments = [
        shipment('TRK-JS', 'javascript:alert(1)'),
        shipment('TRK-TAB', 'java\tscript:alert(1)'),
        shipment('TRK-DATA', 'data:text/html,<script>alert(1)</script>'),
        shipment('TRK-HTTP', 'http://track.example/a?x=1&y=2'),
      ];
      stored.printarex.holdReason = { code: 'processing', detail_code: null, action_required: true, action_url: 'javascript:alert(2)' };
    });
    const page = await (await fetch(`${shopUrl}/orders/${id}`)).text();
    assert.ok(!/href="(javascript|java|data):/i.test(page), page);
    assert.ok(!page.includes('Open in PrintaRex</a>'));
    for (const trackingNumber of ['TRK-JS', 'TRK-TAB', 'TRK-DATA']) assert.ok(page.includes(trackingNumber));
    assert.ok(page.includes('<a href="http://track.example/a?x=1&amp;y=2">TRK-HTTP</a>'), page);
    starter.db.update((data) => {
      data.orders[id]!.printarex.holdReason = { code: 'processing', detail_code: null, action_required: true, action_url: 'https://portal.example/orders/1' };
    });
    assert.ok((await (await fetch(`${shopUrl}/orders/${id}`)).text()).includes('<a href="https://portal.example/orders/1">Open in PrintaRex</a>'));
  });
});

describe('the destination country comes from the store', () => {
  test('13. a store in Saudi Arabia quotes, stores and sends orders for SA', async () => {
    const saKit = await startSandbox({ SANDBOX_STORE_COUNTRY: 'SA' });
    const sa = await startExtraStarter({}, saKit);
    await sa.starter.start();
    await waitUntil(() => Object.values(sa.starter.db.data.listings).length === 2, 'two listings');
    const listing = Object.values(sa.starter.db.data.listings).find((candidate) => candidate.title.includes('T-Shirt'))!;
    const variant = listing.variants.find((candidate) => candidate.available)!;
    const checkout = await (await fetch(`${sa.url}/checkout?variant=${variant.id}&qty=1`)).text();
    const state = /<option>([^<]+)<\/option>/.exec(checkout)?.[1];
    assert.ok(state, checkout);
    assert.ok(!checkout.includes('<option>Dubai</option>'));
    assert.ok(checkout.includes('State / emirate'));
    const saShopper = { ...shopper, phone: '+966501234567', state: state! };
    const quote = await (await fetch(`${sa.url}/checkout/quote`, form({ variant: variant.id, qty: '1', ...saShopper }))).text();
    assert.ok(quote.includes('Shipping:') && quote.includes(' SAR'), quote);
    const uae = await (await fetch(`${sa.url}/checkout/quote`, form({ variant: variant.id, qty: '1', ...shopper }))).text();
    assert.ok(uae.includes('Please check the state / emirate or city.'), uae);
    const placed = await fetch(`${sa.url}/checkout/place`, form({ variant: variant.id, qty: '1', shipping: '15.00', ...saShopper }));
    const id = placed.headers.get('location')!.split('/').pop()!;
    assert.equal(sa.starter.db.data.orders[id]?.address.country, 'SA');
    await waitUntil(() => sa.starter.db.data.orders[id]?.push.state === 'sent', 'pushed');
    const remote = [...saKit.sandbox.sandbox.state.orders.values()].find((order) => order.externalOrderId === id);
    assert.equal(remote?.address.country, 'SA');
    await sa.starter.stop();
    await saKit.sandbox.close();
    extraStarters.splice(extraStarters.indexOf(sa.starter), 1);
  });
});

describe('webhook secret rotation', () => {
  const body = (eventId: string) => JSON.stringify({ id: eventId, type: 'ping', sequence: null, data: {} });
  const signature = (secret: string, timestamp: number, rawBody: string) => createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

  test('14. a request with two v1 values is accepted when either matches the current or previous secret, and refused when neither does', async () => {
    const rotating = loadConfig({
      PRINTAREX_API_BASE_URL: kit.apiBaseUrl,
      PRINTAREX_API_KEY: kit.apiKey,
      PRINTAREX_WEBHOOK_SECRET: 'whsec_current_secret_for_the_rotation_test',
      PRINTAREX_WEBHOOK_PREVIOUS_SECRET: 'whsec_previous_secret_for_the_rotation_test',
      STARTER_SESSION_SECRET: TEST_SESSION_SECRET,
      STARTER_DATA_DIR: starterConfig(kit).dataDir,
    });
    assert.equal(rotating.webhookSecrets.length, 2);
    const extra = createStarter(rotating);
    extraStarters.push(extra);
    const url = await listen(extra.server);
    const unknown = 'whsec_somebody_elses_secret';
    const [current, previous] = rotating.webhookSecrets as [string, string];
    const send = async (eventId: string, signingSecrets: string[]) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = body(eventId);
      const header = [`t=${timestamp}`, ...signingSecrets.map((secret) => `v1=${signature(secret, timestamp, rawBody)}`)].join(',');
      return (await fetch(`${url}/webhooks/printarex`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'PrintaRex-Signature': header }, body: rawBody })).status;
    };
    const accepted = [
      ['evt-rotation-previous-second', [unknown, previous]],
      ['evt-rotation-previous-first', [previous, unknown]],
      ['evt-rotation-current-second', [unknown, current]],
      ['evt-rotation-current-first', [current, unknown]],
      ['evt-rotation-both', [previous, current]],
    ] as const;
    for (const [eventId, signingSecrets] of accepted) assert.equal(await send(eventId, [...signingSecrets]), 204, eventId);
    assert.equal(await send('evt-rotation-neither', [unknown, 'whsec_another_wrong_secret']), 401);
    assert.equal(await send('evt-rotation-none', []), 401);
    await extra.webhooks.idle();
    const processed = extra.db.data.webhookLog.filter((entry) => entry.outcome === 'processed').map((entry) => entry.id).sort();
    assert.deepEqual(processed, accepted.map(([eventId]) => eventId).sort());
  });
});
