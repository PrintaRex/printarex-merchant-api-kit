import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { csrfTokenFor, isAdminRequest, isValidCsrfToken, newOrderId, ORDER_ID_PATTERN } from './access.ts';
import { CatalogSync, IMAGE_CONTENT_TYPES } from './catalog-sync.ts';
import type { StarterConfig } from './config.ts';
import { Db, type LocalOrder, ownEntry } from './db.ts';
import { adminPage, checkoutPage, homePage, orderPage, productPage, quotePage } from './pages.ts';
import { PrintarexApiError, PrintarexClient } from './printarex-client.ts';
import { OrderSync } from './order-sync.ts';
import { allowedProtocols, safeHref } from './safe-url.ts';
import { type WebhookEvent, WebhookHandler } from './webhook-handler.ts';
import { verifyWebhookSignature } from './webhook-verifier.ts';

/** Buyer-facing text for a failed shipping quote. The checkout never shows an invented price. */
const RATE_ERRORS: Record<string, string> = {
  destination_uncovered: 'Sorry, we cannot ship this item to your area yet.',
  address_invalid: 'Please check the state / emirate or city.',
  variant_out_of_stock: 'Sorry, this option just sold out.',
  variant_retired: 'Sorry, this product is no longer available.',
  multi_provider_cart: 'These items ship separately. Please order them one at a time.',
};
const RATES_UNAVAILABLE = 'Shipping prices are unavailable right now. Please try again in a moment.';
const CANCEL_ERRORS: Record<string, string> = {
  cancel_window_closed: 'Too late to cancel: production has started.',
  payment_in_progress: 'Payment is being processed. Try again in a minute.',
};
const INVALID_QUANTITY = 'Choose a quantity of at least 1.';
/**
 * Pages run no scripts and load nothing from other sites. `base-uri` and `object-src` close two
 * ways to change what a page loads without a script. `description_html` is shown as plain text.
 */
const PAGE_CSP = "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
const FORBIDDEN = 'This form has expired. Open the order page again and retry.';

export type Starter = {
  server: Server;
  db: Db;
  webhooks: WebhookHandler;
  orders: OrderSync;
  catalog: CatalogSync;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

/** Everything the page handlers share. */
type Shop = {
  config: StarterConfig;
  db: Db;
  client: PrintarexClient;
  orders: OrderSync;
  webhooks: WebhookHandler;
  storeCountry: () => Promise<string>;
  shippingStates: () => Promise<string[]>;
  linkProtocols: string[];
};

export function createStarter(config: StarterConfig): Starter {
  const db = new Db(config.dataDir);
  const client = new PrintarexClient(config.apiBaseUrl, config.apiKey);
  const catalog = new CatalogSync(config, db, client);
  const orders = new OrderSync(db, client);
  const webhooks = new WebhookHandler(db, catalog, orders);
  // Read once from GET /store and kept; a failed read is not remembered, so the next request tries again.
  let country = '';
  const storeCountry = async () => {
    if (!country) country = (await client.getStore()).data.country;
    return country;
  };
  let states: string[] = [];
  const shippingStates = async () => {
    if (states.length === 0) states = (await client.coverage(await storeCountry())).data.countries[0]?.states.map((state) => state.name) ?? [];
    return states;
  };
  const shop: Shop = { config, db, client, orders, webhooks, storeCountry, shippingStates, linkProtocols: allowedProtocols(config.apiBaseUrl) };
  const timers: NodeJS.Timeout[] = [];

  const server = createServer((request, response) => {
    route(shop, request, response).catch((error) => {
      console.error('[starter] request failed', error);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' }).end('Something went wrong.');
    });
  });

  return {
    server,
    db,
    webhooks,
    orders,
    catalog,
    start: async () => {
      await storeCountry().catch((error) => console.error('[starter] could not read the store country', error));
      await catalog.backfill().catch((error) => console.error('[starter] catalog backfill failed', error));
      timers.push(setInterval(() => void orders.pushDueOrders(), 1000));
      timers.push(setInterval(() => void orders.reconcile().catch((error) => console.error('[starter] reconcile failed', error)), config.reconcileIntervalMs));
    },
    stop: async () => {
      timers.forEach((timer) => clearInterval(timer));
      await webhooks.idle();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
    },
  };
}

async function route(shop: Shop, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://starter.local');
  const method = request.method ?? 'GET';
  const path = url.pathname;
  if (method === 'POST' && path === '/webhooks/printarex') return receiveWebhook(shop, request, response);
  if (method === 'GET' && path === '/') return sendHtml(response, 200, homePage(shop.db.data));
  if (method === 'GET' && path === '/admin') return showAdmin(shop, request, response);
  if (method === 'GET' && path === '/healthz') return sendHtml(response, 200, 'ok');
  if (method === 'GET' && path.startsWith('/images/')) return serveImage(shop, response, path);
  if (method === 'GET' && path.startsWith('/products/')) return showProduct(shop, response, path);
  if (method === 'GET' && path === '/checkout') return showCheckout(shop, response, url.searchParams);
  if (method === 'POST' && path === '/checkout/quote') return quoteShipping(shop, request, response);
  if (method === 'POST' && path === '/checkout/place') return placeOrder(shop, request, response);
  if (path.startsWith('/orders/')) return handleOrder(shop, request, response, path);
  sendHtml(response, 404, 'Not found');
}

/** Verify against the RAW body, answer fast, and do the work afterwards. */
async function receiveWebhook(shop: Shop, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const rawBody = await readRaw(request);
  if (!verifyWebhookSignature(request.headers['printarex-signature'] as string | undefined, rawBody, shop.config.webhookSecrets)) {
    response.writeHead(401).end();
    return;
  }
  response.writeHead(204).end();
  shop.webhooks.enqueue(JSON.parse(rawBody.toString('utf8')) as WebhookEvent);
}

/** Off (404) unless STARTER_ADMIN_TOKEN is set; then it needs that token. */
function showAdmin(shop: Shop, request: IncomingMessage, response: ServerResponse): void {
  const { adminToken } = shop.config;
  if (!adminToken) return sendHtml(response, 404, 'Not found');
  if (!isAdminRequest(request.headers.authorization, adminToken)) {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Starter shop admin", charset="UTF-8"' }).end();
    return;
  }
  sendHtml(response, 200, adminPage(shop.db.data));
}

function serveImage(shop: Shop, response: ServerResponse, path: string): void {
  const [, fileName, extension = ''] = /^\/images\/([\w-]+\.(png|jpg|webp))$/.exec(path) ?? [];
  if (!fileName) return sendHtml(response, 404, 'Not found');
  let file: Buffer;
  try {
    file = readFileSync(join(shop.db.imagesDir, fileName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': IMAGE_CONTENT_TYPES[extension] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }).end(file);
}

function showProduct(shop: Shop, response: ServerResponse, path: string): void {
  const websiteProductId = /^\/products\/([\w-]+)$/.exec(path)?.[1];
  const listing = Object.values(shop.db.data.listings).find((candidate) => candidate.websiteProductId === websiteProductId && candidate.visible);
  if (!websiteProductId || !listing) return sendHtml(response, 404, 'Not found');
  sendHtml(response, 200, productPage(listing));
}

async function showCheckout(shop: Shop, response: ServerResponse, query: URLSearchParams): Promise<void> {
  const variantId = query.get('variant') ?? '';
  const listing = listingOfVariant(shop.db, variantId);
  if (!listing) return sendHtml(response, 404, 'Not found');
  const quantity = parseQuantity(query.get('qty') ?? '1');
  if (quantity === null) return sendHtml(response, 400, INVALID_QUANTITY);
  sendHtml(response, 200, checkoutPage(listing, variantId, quantity, await shop.shippingStates()));
}

async function quoteShipping(shop: Shop, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const fields = await readForm(request);
  const variantId = fields.variant ?? '';
  const state = fields.state ?? '';
  const listing = listingOfVariant(shop.db, variantId);
  if (!listing) return sendHtml(response, 404, 'Not found');
  const quantity = parseQuantity(fields.qty);
  if (quantity === null) return sendHtml(response, 400, INVALID_QUANTITY);
  try {
    const { data } = await shop.client.shippingRates({
      destination: { country: await shop.storeCountry(), state, city: state },
      items: [{ variant_id: variantId, quantity }],
    });
    const standard = data.methods[0];
    if (!standard) return sendHtml(response, 200, quotePage(fields, listing, null, RATES_UNAVAILABLE));
    const shipping = { amount: standard.amount, currency: standard.currency, days: `${standard.delivery_days.min}-${standard.delivery_days.max}` };
    sendHtml(response, 200, quotePage(fields, listing, shipping, null));
  } catch (error) {
    const code = error instanceof PrintarexApiError ? error.code : '';
    sendHtml(response, 200, quotePage(fields, listing, null, RATE_ERRORS[code] ?? RATES_UNAVAILABLE));
  }
}

async function placeOrder(shop: Shop, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const fields = await readForm(request);
  const listing = listingOfVariant(shop.db, fields.variant ?? '');
  const variant = listing?.variants.find((candidate) => candidate.id === fields.variant);
  if (!listing || !variant) return sendHtml(response, 404, 'Not found');
  const quantity = parseQuantity(fields.qty);
  if (quantity === null) return sendHtml(response, 400, INVALID_QUANTITY);
  const country = await shop.storeCountry();
  const order: LocalOrder = {
    id: newOrderId(),
    createdAt: new Date().toISOString(),
    email: fields.email ?? '',
    address: { name: fields.name ?? '', phone: fields.phone?.trim() || null, address1: fields.address1 ?? '', city: fields.state ?? '', state: fields.state ?? '', country },
    items: [{ variantId: variant.id, title: `${listing.title} (${variant.label})`, quantity, unitPrice: variant.price }],
    currency: variant.currency,
    shippingEstimate: fields.shipping ?? '',
    push: { state: 'pending', attempts: 0, nextAttemptAt: null, lastError: null },
    printarex: { orderId: null, status: null, holdReason: null, shipments: [], notice: null },
  };
  shop.orders.enqueue(order);
  await shop.orders.pushDueOrders();
  redirect(response, `/orders/${order.id}`);
}

/** The order id in the link is the secret (a capability URL); the POSTs also need the form token. */
async function handleOrder(shop: Shop, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const [, orderId = '', action] = /^\/orders\/([^/]+)(\/phone|\/cancel)?$/.exec(path) ?? [];
  const order = ORDER_ID_PATTERN.test(orderId) ? ownEntry(shop.db.data.orders, orderId) : undefined;
  if (!order) return sendHtml(response, 404, 'Not found');
  const method = request.method ?? 'GET';
  const printarexOrderId = order.printarex.orderId;
  if (method === 'GET' && !action) {
    const context = { csrfToken: csrfTokenFor(shop.config.sessionSecret, order.id), safeHref: (url: string | null) => safeHref(url, shop.linkProtocols) };
    return sendHtml(response, 200, orderPage(order, context));
  }
  if (method !== 'POST' || !action || !printarexOrderId) return sendHtml(response, 404, 'Not found');
  const fields = await readForm(request);
  if (!isValidCsrfToken(shop.config.sessionSecret, order.id, fields.csrf)) return sendHtml(response, 403, FORBIDDEN);
  const notice = action === '/phone' ? await savePhone(shop, order.id, printarexOrderId, fields.phone ?? '') : await requestCancellation(shop.client, printarexOrderId);
  shop.orders.setNotice(order.id, notice);
  redirect(response, `/orders/${order.id}`);
}

/** Returns the notice to show the shopper. */
async function savePhone(shop: Shop, orderId: string, printarexOrderId: string, phone: string): Promise<string> {
  try {
    await shop.client.updateShippingAddress(printarexOrderId, { phone });
    shop.orders.recordPhone(orderId, phone);
    return 'Phone saved. The order continues shortly.';
  } catch (error) {
    if (error instanceof PrintarexApiError && error.code === 'phone_invalid') {
      return 'That phone number is not valid. Use the international format, for example +971501234567.';
    }
    return 'Could not save the phone. Try again.';
  }
}

/** 202 only means "requested": the answer arrives later as order.cancelled or order.cancel_rejected. */
async function requestCancellation(client: PrintarexClient, printarexOrderId: string): Promise<string> {
  try {
    await client.cancelOrder(printarexOrderId);
    return 'Cancellation requested. We will confirm shortly.';
  } catch (error) {
    const code = error instanceof PrintarexApiError ? error.code : '';
    return CANCEL_ERRORS[code] ?? 'Could not cancel. Try again.';
  }
}

const listingOfVariant = (db: Db, variantId: string) =>
  Object.values(db.data.listings).find((listing) => listing.visible && listing.variants.some((variant) => variant.id === variantId));

/** Buyer input: a whole number of at least 1, or null. */
function parseQuantity(raw: string | undefined): number | null {
  const quantity = Number(raw);
  return raw && /^\d+$/.test(raw) && Number.isSafeInteger(quantity) && quantity >= 1 ? quantity : null;
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  // no-referrer keeps an order link out of the Referer header of any link the shopper follows.
  response
    .writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    })
    .end(body);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { Location: location }).end();
}

async function readForm(request: IncomingMessage): Promise<Record<string, string>> {
  return Object.fromEntries(new URLSearchParams((await readRaw(request)).toString('utf8')));
}

async function readRaw(request: IncomingMessage, cap = 1_048_576): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > cap) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
