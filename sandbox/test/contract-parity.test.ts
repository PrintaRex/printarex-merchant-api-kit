/**
 * Contract parity: every API response and webhook payload the sandbox produces must match the
 * schemas in contract/merchant-api-v1.openapi.yaml. A failure here means the sandbox and the
 * contract drifted apart, and one of them has to change.
 *
 * KNOWN_DIVERGENCES lists places where the production service itself differs from the contract;
 * the sandbox copies production there. Each entry must be resolved in the contract or the service.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { parse } from 'yaml';
import { type DeliveryBody, envelopeOf, type Harness, type InventoryBody, type OrderBody, orderBody, type Page, type ProductBody, startHarness } from './harness.ts';

const KNOWN_DIVERGENCES: Record<string, string> = {
  'sample:order.cancelled': 'The test sample of order.cancelled has no `refund`; the real event has one.',
};

const EVENT_SCHEMAS: Record<string, string> = {
  'product.publish_requested': 'ProductEvent',
  'product.updated': 'ProductEvent',
  'product.unpublish_requested': 'ProductEvent',
  'product.cost_changed': 'ProductEvent',
  'product.deleted': 'ProductDeletedEvent',
  'inventory.updated': 'InventoryUpdatedEvent',
  'order.status_changed': 'OrderStatusChangedEvent',
  'order.payment_failed': 'OrderPaymentProblemEvent',
  'order.payment_expired': 'OrderPaymentProblemEvent',
  'order.charged': 'OrderChargedEvent',
  'order.shipped': 'OrderShipmentEvent',
  'order.delivered': 'OrderShipmentEvent',
  'shipment.exception': 'ShipmentExceptionEvent',
  'order.cancelled': 'OrderRefundEvent',
  'order.refunded': 'OrderRefundEvent',
  'order.cancel_rejected': 'OrderCancelRejectedEvent',
  'return.status_changed': 'ReturnStatusChangedEvent',
  'connection.disabled': 'ConnectionDisabledEvent',
  'api_key.expiring': 'ApiKeyExpiringEvent',
  ping: 'PingEvent',
};

const contract = parse(readFileSync(new URL('../../contract/merchant-api-v1.openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
(addFormatsModule as unknown as (instance: Ajv2020) => void)(ajv);
ajv.addFormat('int64', true);
ajv.addSchema(contract, 'contract');

function check(schemaName: string, value: unknown, label: string): string[] {
  const validate = ajv.getSchema(`contract#/components/schemas/${schemaName}`);
  assert.ok(validate, `schema ${schemaName} exists`);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${label}: ${error.instancePath || '/'} ${error.message}`);
}

let h: Harness;
const problems: string[] = [];
const sampleEventIds = new Map<string, string>();

before(async () => {
  h = await startHarness();
  await h.receiver.waitFor((event) => event.type === 'product.updated');
});

after(() => h.stop());

describe('sandbox output matches the OpenAPI contract', () => {
  test('API responses', async () => {
    const products = (await h.api<Page<ProductBody>>('GET', '/products')).body;
    problems.push(...check('ProductPage', products, 'GET /products'));
    const product = products.data[0];
    const variant = product?.variants.find((candidate) => candidate.available);
    assert.ok(product && variant, 'the seed has an orderable product');
    problems.push(...check('Store', (await h.api('GET', '/store')).body, 'GET /store'));
    problems.push(...check('Product', (await h.api('GET', `/products/${product.id}`)).body, 'GET /products/{id}'));
    const inventory = (await h.api<{ data: InventoryBody[] }>('GET', `/inventory?variant_ids=${variant.id}`)).body;
    for (const item of inventory.data) problems.push(...check('Inventory', item, 'GET /inventory'));
    problems.push(...check('Coverage', (await h.api('GET', '/shipping/coverage')).body, 'GET /shipping/coverage'));
    const rates = await h.api('POST', '/shipping/rates', { body: { destination: { country: 'AE', state: 'Dubai', city: 'Dubai' }, items: [{ variant_id: variant.id, quantity: 1 }] } });
    problems.push(...check('ShippingRatesResponse', rates.body, 'POST /shipping/rates'));
    const created = await h.api<OrderBody>('POST', '/orders', { body: orderBody(variant.id) });
    problems.push(...check('Order', created.body, 'POST /orders'));
    problems.push(...check('Order', (await h.api<OrderBody>('GET', `/orders/${created.body.id}`)).body, 'GET /orders/{id}'));
    problems.push(...check('OrderPage', (await h.api('GET', `/orders?external_id=${created.body.external_order_id}`)).body, 'GET /orders'));
    problems.push(...check('Order', (await h.api('PATCH', `/orders/${created.body.id}/shipping-address`, { body: { name: 'New Name' } })).body, 'PATCH shipping-address'));
    problems.push(...check('CancelResponse', (await h.api('POST', `/orders/${created.body.id}/cancel`)).body, 'POST /orders/{id}/cancel'));
    const deliveries = await h.api<Page<DeliveryBody>>('GET', '/webhook-deliveries');
    problems.push(...check('WebhookDeliveryPage', deliveries.body, 'GET /webhook-deliveries'));
    const delivery = deliveries.body.data[0];
    assert.ok(delivery, 'the seed publish produced webhook deliveries');
    problems.push(...check('WebhookDelivery', (await h.api('POST', `/webhook-deliveries/${delivery.id}/replay`)).body, 'POST /webhook-deliveries/{id}/replay'));
    // A product of its own, so the listing-state calls do not disturb the seeded products the later tests use.
    const listed = (await h.control<ProductBody>('POST', '/products', { template: 'mug' })).body;
    const confirmation = { website_product_id: 'shop-1', website_url: 'https://shop.example/p/1' };
    problems.push(...check('Product', (await h.api('POST', `/products/${listed.id}/confirmation`, { body: confirmation })).body, 'POST /products/{id}/confirmation'));
    problems.push(...check('Product', (await h.api('POST', `/products/${listed.id}/publish-failure`, { body: { message: 'The image upload failed.' } })).body, 'POST /products/{id}/publish-failure'));
    problems.push(...check('Product', (await h.api('POST', `/products/${listed.id}/removed`, { body: { reason: 'The merchant removed it.' } })).body, 'POST /products/{id}/removed'));
    await h.control('POST', `/products/${listed.id}/delete`);
    for (const failing of [
      await h.api('GET', '/store', { key: null }),
      await h.api('POST', '/orders', { body: orderBody(variant.id, { payment_status: 'unpaid' }) }),
      await h.api('GET', '/products/prd_unknown'),
    ]) {
      problems.push(...check('Error', failing.body, `error ${failing.body.code}`));
    }
  });

  test('every webhook event produced by real flows', async () => {
    const products = (await h.api<Page<ProductBody>>('GET', '/products')).body.data;
    const [firstProduct, secondProduct] = products;
    const variant = firstProduct?.variants.find((candidate) => candidate.available);
    assert.ok(firstProduct && secondProduct && variant, 'the seed has two products and an orderable variant');
    const flows = async (configure: (orderId: string) => Promise<void>) => {
      const created = await h.api<OrderBody>('POST', '/orders', { body: orderBody(variant.id) });
      await h.receiver.waitFor((event) => event.data.order?.id === created.body.id && event.data.order.status === 'awaiting_provider');
      await configure(created.body.id);
    };
    await flows(async (id) => {
      for (let step = 0; step < 4; step++) await h.control('POST', `/orders/${id}/advance`);
      await h.control('POST', `/orders/${id}/shipment-exception`, { kind: 'exception' });
      await h.control('POST', `/orders/${id}/return`, { status: 'requested' });
      await h.control('POST', `/orders/${id}/refund`);
    });
    await flows(async (id) => {
      await h.control('POST', `/orders/${id}/hold`, { code: 'payment_failed' });
      await h.control('POST', `/orders/${id}/hold`, { code: 'payment_expired' });
    });
    await flows(async (id) => {
      await h.api('POST', `/orders/${id}/cancel`);
      await h.control('POST', `/orders/${id}/cancel-outcome`, { outcome: 'rejected', reason_code: 'production_started' });
      await h.api('POST', `/orders/${id}/cancel`);
    });
    await h.control('POST', `/products/${firstProduct.id}/cost-change`);
    await h.control('POST', `/products/${firstProduct.id}/stock`, { quantity: 3 });
    await h.control('POST', `/products/${secondProduct.id}/unpublish`);
    await h.control('POST', `/products/${secondProduct.id}/delete`);
    await h.control('POST', '/api-key/expiring');
    await h.control('POST', '/webhooks/ping');
    await h.control('POST', '/connection/disable', { reason: 'admin' });
    await h.control('POST', '/connection/enable');
    await h.receiver.waitFor((event) => event.type === 'connection.disabled');
    await h.receiver.waitFor((event) => event.type === 'order.cancelled');

    const seenTypes = new Set(h.receiver.events.map((event) => event.type));
    assert.deepEqual([...Object.keys(EVENT_SCHEMAS)].filter((type) => !seenTypes.has(type)), [], 'every event type was produced');
    for (const event of h.receiver.events) {
      problems.push(...check(EVENT_SCHEMAS[event.type] ?? 'WebhookEnvelope', envelopeOf(event), `event ${event.type}`));
    }
  });

  test('every /webhooks/test sample', async () => {
    for (const type of Object.keys(EVENT_SCHEMAS)) {
      const queued = await h.api<DeliveryBody>('POST', '/webhooks/test', { body: { event_type: type } });
      sampleEventIds.set(queued.body.event_id, type);
    }
    for (const [eventId, type] of sampleEventIds) {
      const event = await h.receiver.waitFor((candidate) => candidate.id === eventId);
      assert.equal(event.type, type, 'the sample carries the requested event type');
      const errors = check(EVENT_SCHEMAS[type] ?? 'WebhookEnvelope', envelopeOf(event), `sample ${type}`);
      if (errors.length && KNOWN_DIVERGENCES[`sample:${type}`]) continue;
      problems.push(...errors);
    }
  });

  test('no drift', () => {
    assert.deepEqual(problems, []);
  });
});
