/**
 * The Product catalogue, tested in-process through its interface only (no HTTP).
 *
 * Ways the catalogue could fail, each covered below:
 *  1. An operation changes the public output but forgets to move `sequence` / `updated_at`.
 *  2. An operation moves `sequence` twice (touch inside touch), so the website sees a gap.
 *  3. An operation sends no event, the wrong event type, or an event whose `sequence` differs
 *     from the product's sequence after the change.
 *  4. An operation that is a no-op today (reporting a removal of an unpublished product) starts
 *     moving `sequence` or sending an event.
 *  5. A refused operation (republishing a published product, expiring a listing that is not
 *     `sent`, confirming an unpublished product, an unknown stock variant) changes state or sends
 *     an event before it throws.
 *  6. The publish handshake breaks: the gallery arrives before the primary image, arrives for a
 *     product that was unpublished or deleted meanwhile, or never arrives for a multi-image product.
 *  7. The `inventory.updated` payload drifts from `inventoryView` (extra, missing or reordered keys).
 *  8. Stock changes touch variants outside the targeted one, or leave `syncFailed` stale.
 *  9. A failed listing hands back the monthly publish allowance twice, or goes below zero.
 * 10. Deleting a product leaves it reachable, or the deleted event loses its website id.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createSandbox, type RunningSandbox } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Sandbox } from '../src/context.ts';
import { ApiError } from '../src/errors.ts';
import {
  changeProductionCost,
  confirmListing,
  deleteProduct,
  expireListing,
  failListing,
  publishProduct,
  reportRemoved,
  republishProduct,
  setStock,
  unpublishProduct,
  updateProductDetails,
} from '../src/product-catalogue.ts';
import type { Product } from '../src/state.ts';
import { inventoryView } from '../src/views.ts';
import type { EventData } from './harness.ts';

const ASYNC_STEP_MS = 10;
let running: RunningSandbox;
let sandbox: Sandbox;

before(() => {
  running = createSandbox(loadConfig({ SANDBOX_SEED_PRODUCTS: 'false', SANDBOX_ASYNC_STEP_MS: String(ASYNC_STEP_MS), SANDBOX_LOG_REQUESTS: 'false' }));
  sandbox = running.sandbox;
});

after(() => running.close());

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Sent = { type: string; sequence: number | null; resourceKey: string | null; data: EventData };

/** Events sent while `action` runs, synchronously. */
function eventsDuring(action: () => void): Sent[] {
  const before = sandbox.state.deliveries.length;
  action();
  return sandbox.state.deliveries.slice(before).map((delivery) => ({
    type: delivery.eventType,
    sequence: delivery.sequence,
    resourceKey: delivery.resourceKey,
    data: delivery.data as EventData,
  }));
}

const eventsOf = (product: Product): Sent[] =>
  sandbox.state.deliveries
    .filter((delivery) => delivery.resourceKey === `product:${product.id}`)
    .map((delivery) => ({ type: delivery.eventType, sequence: delivery.sequence, resourceKey: delivery.resourceKey, data: delivery.data as EventData }));

/** A published tshirt whose publish handshake has finished. */
async function settledProduct(template: 'tshirt' | 'mug' = 'tshirt'): Promise<Product> {
  const product = publishProduct(sandbox, template);
  await wait(ASYNC_STEP_MS * 5);
  return product;
}

function assertMovedOnce(product: Product, sequenceBefore: number, events: Sent[]): void {
  assert.equal(product.sequence, sequenceBefore + 1);
  for (const event of events) assert.equal(event.sequence, product.sequence);
}

describe('publish handshake', () => {
  test('announces the primary image first, then the gallery, each at its own sequence', async () => {
    let product: Product | undefined;
    const first = eventsDuring(() => {
      product = publishProduct(sandbox, 'tshirt');
    });
    assert.ok(product);
    assert.deepEqual(first.map((event) => event.type), ['product.publish_requested']);
    assert.equal(first[0]?.sequence, 1);
    assert.equal(first[0]?.data.product?.images.length, 1);
    assert.equal(first[0]?.data.product?.listing_state, 'sent');
    assert.equal(product.images.length, 4);

    await wait(ASYNC_STEP_MS * 5);
    const [, gallery, ...rest] = eventsOf(product);
    assert.equal(rest.length, 0);
    assert.equal(gallery?.type, 'product.updated');
    assert.equal(gallery?.sequence, 2);
    assert.deepEqual(gallery?.data.changed, ['images']);
    assert.equal(gallery?.data.product?.images.length, 4);
    assert.equal(product.sequence, 2);
  });

  test('uses one publish allowance per new product', () => {
    const used = sandbox.state.store.monthlyNewProductsUsed;
    publishProduct(sandbox, 'mug');
    assert.equal(sandbox.state.store.monthlyNewProductsUsed, used + 1);
  });

  test('no gallery event when the product was unpublished before the gallery step', async () => {
    const product = publishProduct(sandbox, 'tshirt');
    const events = eventsDuring(() => unpublishProduct(sandbox, product));
    assert.deepEqual(events.map((event) => event.type), ['product.unpublish_requested']);
    await wait(ASYNC_STEP_MS * 5);
    assert.deepEqual(eventsOf(product).map((event) => event.type), ['product.publish_requested', 'product.unpublish_requested']);
    assert.equal(product.sequence, 2);
  });

  test('no gallery event when the product was deleted before the gallery step', async () => {
    const product = publishProduct(sandbox, 'tshirt');
    deleteProduct(sandbox, product);
    await wait(ASYNC_STEP_MS * 5);
    assert.deepEqual(eventsOf(product).map((event) => event.type), ['product.publish_requested', 'product.deleted']);
  });
});

describe('operations move the sequence once and send their events', () => {
  test('republish', async () => {
    const product = await settledProduct();
    unpublishProduct(sandbox, product);
    const sequenceBefore = product.sequence;
    const events = eventsDuring(() => republishProduct(sandbox, product));
    assert.deepEqual(events.map((event) => event.type), ['product.publish_requested']);
    assertMovedOnce(product, sequenceBefore, events);
    assert.equal(product.status, 'published');
    assert.equal(product.listingState, 'sent');
    assert.equal(events[0]?.data.product?.images.length, 1);
    await wait(ASYNC_STEP_MS * 5);
    assert.equal(product.sequence, sequenceBefore + 2);
  });

  test('republish of a published product is refused without a trace', async () => {
    const product = await settledProduct();
    const sequenceBefore = product.sequence;
    const events = eventsDuring(() => assert.throws(() => republishProduct(sandbox, product), (error) => error instanceof ApiError && error.field === 'product_id'));
    assert.deepEqual(events, []);
    assert.equal(product.sequence, sequenceBefore);
  });

  test('unpublish', async () => {
    const product = await settledProduct();
    const sequenceBefore = product.sequence;
    const events = eventsDuring(() => unpublishProduct(sandbox, product));
    assert.deepEqual(events.map((event) => event.type), ['product.unpublish_requested']);
    assertMovedOnce(product, sequenceBefore, events);
    assert.equal(product.status, 'unpublished');
    assert.equal(events[0]?.data.product?.status, 'unpublished');
  });

  test('delete', async () => {
    const product = await settledProduct();
    confirmListing(product, { websiteProductId: 'web-9', websiteUrl: 'https://shop.example/p/9' });
    const sequenceBefore = product.sequence;
    const events = eventsDuring(() => deleteProduct(sandbox, product));
    assert.deepEqual(events.map((event) => event.type), ['product.deleted']);
    assertMovedOnce(product, sequenceBefore, events);
    assert.deepEqual(events[0]?.data, { product_id: product.id, website_product_id: 'web-9' });
    assert.equal(sandbox.state.products.has(product.id), false);
  });

  test('update details', async () => {
    const product = await settledProduct();
    const sequenceBefore = product.sequence;
    const events = eventsDuring(() => updateProductDetails(sandbox, product, { title: 'Renamed', changed: ['title', 'tags'] }));
    assert.deepEqual(events.map((event) => event.type), ['product.updated']);
    assertMovedOnce(product, sequenceBefore, events);
    assert.equal(product.title, 'Renamed');
    assert.deepEqual(events[0]?.data.changed, ['title', 'tags']);
    assert.equal(events[0]?.data.product?.title, 'Renamed');
  });

  test('update details without a title keeps the title', async () => {
    const product = await settledProduct();
    const title = product.title;
    updateProductDetails(sandbox, product, { title: null, changed: ['details'] });
    assert.equal(product.title, title);
  });

  test('change cost, set and raise', async () => {
    const product = await settledProduct();
    const sequenceBefore = product.sequence;
    const setEvents = eventsDuring(() => changeProductionCost(sandbox, product, { kind: 'set', productionCents: 3500 }));
    assert.deepEqual(setEvents.map((event) => event.type), ['product.cost_changed']);
    assertMovedOnce(product, sequenceBefore, setEvents);
    assert.ok(product.variants.every((variant) => variant.productionCents === 3500));
    assert.equal(setEvents[0]?.data.product?.cost.production, '35.00');

    const raiseEvents = eventsDuring(() => changeProductionCost(sandbox, product, { kind: 'raise_ten_percent' }));
    assert.equal(raiseEvents.length, 1);
    assert.ok(product.variants.every((variant) => variant.productionCents === 3850));
    assert.equal(product.sequence, sequenceBefore + 2);
  });

  test('set stock for one variant', async () => {
    const product = await settledProduct();
    const [target, other] = product.variants;
    assert.ok(target && other);
    const otherBefore = { ...other };
    const sequenceBefore = product.sequence;
    const events = eventsDuring(() => setStock(sandbox, product, { quantity: 7, variantId: target.id, syncFailed: false }));
    assert.deepEqual(events.map((event) => event.type), ['inventory.updated']);
    assertMovedOnce(product, sequenceBefore, events);
    assert.equal(target.quantity, 7);
    assert.deepEqual(other, otherBefore);
  });

  test('set stock for every variant, with a failed sync', async () => {
    const product = await settledProduct();
    const events = eventsDuring(() => setStock(sandbox, product, { quantity: null, variantId: null, syncFailed: true }));
    assert.equal(events.length, 1);
    assert.ok(product.variants.every((variant) => variant.quantity === null && variant.syncFailed));
    assert.ok(events[0]?.data.variants?.every((variant) => variant.available === false && variant.quantity === null));
  });

  test('inventory.updated is the inventoryView of every variant, key order included', async () => {
    const product = await settledProduct();
    const events = eventsDuring(() => setStock(sandbox, product, { quantity: 3, variantId: null, syncFailed: false }));
    const data = events[0]?.data;
    assert.ok(data?.variants?.[0]);
    assert.deepEqual(Object.keys(data), ['product_id', 'variants']);
    assert.deepEqual(Object.keys(data.variants[0]), ['variant_id', 'product_id', 'available', 'quantity', 'updated_at']);
    assert.equal(JSON.stringify(data), JSON.stringify({ product_id: product.id, variants: product.variants.map((variant) => inventoryView(product, variant)) }));
  });

  test('set stock for an unknown variant is refused without a trace', async () => {
    const product = await settledProduct();
    const sequenceBefore = product.sequence;
    const quantities = product.variants.map((variant) => variant.quantity);
    const events = eventsDuring(() =>
      assert.throws(() => setStock(sandbox, product, { quantity: 1, variantId: 'var_missing', syncFailed: false }), (error) => error instanceof ApiError && error.field === 'variant_id'),
    );
    assert.deepEqual(events, []);
    assert.equal(product.sequence, sequenceBefore);
    assert.deepEqual(product.variants.map((variant) => variant.quantity), quantities);
  });

  test('expire listing moves the sequence once and sends no event', async () => {
    const product = await settledProduct();
    const sequenceBefore = product.sequence;
    const events = eventsDuring(() => expireListing(product));
    assert.deepEqual(events, []);
    assert.equal(product.sequence, sequenceBefore + 1);
    assert.equal(product.listingState, 'unconfirmed');
  });

  test('expire listing is refused unless the listing is sent', async () => {
    const product = await settledProduct();
    confirmListing(product, { websiteProductId: 'web-1', websiteUrl: 'https://shop.example/p/1' });
    const sequenceBefore = product.sequence;
    assert.throws(() => expireListing(product), (error) => error instanceof ApiError && error.field === 'listing_state');
    assert.equal(product.sequence, sequenceBefore);
    assert.equal(product.listingState, 'confirmed');
  });

  test('confirm listing moves the sequence once and sends no event', async () => {
    const product = await settledProduct();
    const sequenceBefore = product.sequence;
    const events = eventsDuring(() => confirmListing(product, { websiteProductId: 'web-2', websiteUrl: 'https://shop.example/p/2' }));
    assert.deepEqual(events, []);
    assert.equal(product.sequence, sequenceBefore + 1);
    assert.deepEqual([product.listingState, product.websiteProductId, product.websiteUrl], ['confirmed', 'web-2', 'https://shop.example/p/2']);
  });

  test('confirm listing of an unpublished product is refused without a trace', async () => {
    const product = await settledProduct();
    unpublishProduct(sandbox, product);
    const sequenceBefore = product.sequence;
    assert.throws(() => confirmListing(product, { websiteProductId: 'web-3', websiteUrl: 'https://shop.example/p/3' }), (error) => error instanceof ApiError && error.field === 'product_id');
    assert.equal(product.sequence, sequenceBefore);
    assert.equal(product.websiteProductId, null);
  });

  test('failing a listing gives back the publish allowance once', async () => {
    const product = await settledProduct();
    const used = sandbox.state.store.monthlyNewProductsUsed;
    const sequenceBefore = product.sequence;
    const events = eventsDuring(() => failListing(sandbox, product, 'Website rejected it'));
    assert.deepEqual(events, []);
    assert.equal(product.sequence, sequenceBefore + 1);
    assert.deepEqual([product.listingState, product.listingReason], ['failed', 'Website rejected it']);
    assert.equal(sandbox.state.store.monthlyNewProductsUsed, used - 1);
    failListing(sandbox, product, 'Still failing');
    assert.equal(sandbox.state.store.monthlyNewProductsUsed, used - 1);
    assert.equal(product.sequence, sequenceBefore + 2);
  });

  test('the publish allowance never goes below zero', async () => {
    const product = await settledProduct();
    sandbox.state.store.monthlyNewProductsUsed = 0;
    failListing(sandbox, product, 'No allowance left to give back');
    assert.equal(sandbox.state.store.monthlyNewProductsUsed, 0);
  });

  test('report removed unpublishes a published product, quietly', async () => {
    const product = await settledProduct();
    const sequenceBefore = product.sequence;
    const events = eventsDuring(() => reportRemoved(product));
    assert.deepEqual(events, []);
    assert.equal(product.sequence, sequenceBefore + 1);
    assert.equal(product.status, 'unpublished');
  });

  test('report removed on an unpublished product changes nothing', async () => {
    const product = await settledProduct();
    unpublishProduct(sandbox, product);
    const sequenceBefore = product.sequence;
    const updatedAt = product.updatedAt;
    const events = eventsDuring(() => reportRemoved(product));
    assert.deepEqual(events, []);
    assert.equal(product.sequence, sequenceBefore);
    assert.equal(product.updatedAt, updatedAt);
  });
});
