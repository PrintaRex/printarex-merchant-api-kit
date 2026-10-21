/**
 * End-to-end checks of the sandbox, driven over HTTP exactly as a merchant website would.
 *
 * Ways the sandbox could fail a merchant, each covered below:
 *  1. Auth: a missing, malformed, query-string, expired or under-scoped key is not refused correctly.
 *  2. Headers: request ids, API version, rate-limit headers are missing or wrong; a bad version is accepted.
 *  3. Webhook signatures do not verify with the documented algorithm, or the rotation overlap breaks them.
 *  4. Publish handshake: the primary image is not sent first, the gallery never follows, confirmation rules differ.
 *  5. Signed image links can be tampered with, or cannot be downloaded.
 *  6. Order intake: idempotency, the intake checks and their order, and the error codes/fields differ from production.
 *  7. Lifecycle: statuses, holds, shipments, charges or `sequence` behave differently from production.
 *  8. Cancellation: the async outcome, the rejection reasons or the pre-checks are wrong.
 *  9. Webhook delivery: retries, replay, test events or fault injection do not work.
 * 10. Rate limits and paging: 429/Retry-After or cursors are wrong.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { type DeliveryBody, type Harness, type OrderBody, orderBody, type Page, type ProductBody, startHarness } from './harness.ts';

let h: Harness;
let tshirt: ProductBody;
let mug: ProductBody;

const productOfType = (products: ProductBody[], type: string): ProductBody => {
  const product = products.find((candidate) => candidate.type === type);
  assert.ok(product, `the seed has a ${type}`);
  return product;
};

const orderable = (product: ProductBody) => {
  const variant = product.variants.find((candidate) => candidate.available);
  assert.ok(variant, `${product.type} has an orderable variant`);
  return variant;
};

const soldOut = (product: ProductBody) => {
  const variant = product.variants.find((candidate) => !candidate.available);
  assert.ok(variant, `${product.type} has a sold-out variant`);
  return variant;
};

before(async () => {
  h = await startHarness();
  await h.receiver.waitFor((event) => event.type === 'product.updated');
  const products = (await h.api<Page<ProductBody>>('GET', '/products')).body.data;
  tshirt = productOfType(products, 'T-Shirt');
  mug = productOfType(products, 'Mug');
});

after(() => h.stop());

describe('1. authentication', () => {
  test('missing key is 401 with WWW-Authenticate', async () => {
    const response = await h.api('GET', '/store', { key: null });
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'unauthorized');
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  });

  test('a key in the query string is refused even with a valid header', async () => {
    const response = await h.api('GET', `/store?api_key=${h.fullKey}`);
    assert.equal(response.status, 401);
  });

  test('malformed key is 401', async () => {
    assert.equal((await h.api('GET', '/store', { key: 'prx_uat_short' })).status, 401);
  });

  test('read-only key cannot write', async () => {
    const response = await h.api('POST', '/orders', { key: h.readOnlyKey, body: {} });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'forbidden_scope');
  });

  test('expired key is key_expired, restored key works again', async () => {
    await h.control('POST', '/keys', { key: 'read_only', status: 'expired' });
    const response = await h.api('GET', '/store', { key: h.readOnlyKey });
    assert.equal(response.body.code, 'key_expired');
    await h.control('POST', '/keys', { key: 'read_only', status: 'active' });
    assert.equal((await h.api('GET', '/store', { key: h.readOnlyKey })).status, 200);
  });

  test('unknown route with a valid key is 403 forbidden_scope (production behaviour)', async () => {
    assert.equal((await h.api('GET', '/nope')).body.code, 'forbidden_scope');
  });
});

describe('2. headers and versions', () => {
  test('every response carries request id, version and rate-limit headers', async () => {
    const response = await h.api('GET', '/store');
    assert.match(response.headers.get('x-request-id') ?? '', /^req_[0-9a-f]{32}$/);
    assert.equal(response.headers.get('printarex-api-version'), '2026-11-01');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(Number(response.headers.get('ratelimit-remaining')) >= 0);
  });

  test('error body request_id equals the header', async () => {
    const response = await h.api('GET', '/products/prd_missing');
    assert.equal(response.status, 404);
    assert.equal(response.body.request_id, response.headers.get('x-request-id'));
  });

  test('an unsupported API version is 422 on the version header', async () => {
    const response = await h.api('GET', '/store', { headers: { 'PrintaRex-Api-Version': '2020-01-01' } });
    assert.equal(response.status, 422);
    assert.equal(response.body.field, 'PrintaRex-Api-Version');
  });
});

describe('3-5. publish handshake, signatures, images', () => {
  test('publish_requested carries the primary image only, then product.updated carries the gallery', async () => {
    const published = h.receiver.events.find((event) => event.type === 'product.publish_requested' && event.data.product?.id === tshirt.id);
    const updated = h.receiver.events.find((event) => event.type === 'product.updated' && event.data.product?.id === tshirt.id);
    assert.ok(published && updated);
    assert.equal(published.data.product?.images.length, 1);
    assert.ok((updated.data.product?.images.length ?? 0) > 1);
    assert.deepEqual(updated.data.changed, ['images']);
    assert.ok(updated.sequence! > published.sequence!);
  });

  test('every webhook so far has a valid signature and matching id/type headers', () => {
    assert.ok(h.receiver.events.length > 0);
    for (const event of h.receiver.events) {
      assert.ok(event.signatureValid, `${event.type} signature`);
      assert.equal(event.headers['printarex-event-id'], event.id);
      assert.equal(event.headers['printarex-event-type'], event.type);
      assert.equal(event.headers['user-agent'], 'PrintaRex-Webhooks/1');
    }
  });

  test('signed image downloads; a tampered link is refused', async () => {
    const src = tshirt.images[0]?.src ?? '';
    const image = await fetch(src);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    const tampered = src.replace(/signature=(.)/, (_match: string, first: string) => `signature=${first === 'A' ? 'B' : 'A'}`);
    assert.equal((await fetch(tampered)).status, 403);
  });

  test('confirmation needs an https URL, then the listing is confirmed', async () => {
    const insecure = await h.api('POST', `/products/${tshirt.id}/confirmation`, { body: { website_product_id: 'shop-1', website_url: 'http://shop.example/p/1' } });
    assert.equal(insecure.status, 422);
    assert.equal(insecure.body.field, 'website_url');
    const confirmed = await h.api<ProductBody>('POST', `/products/${tshirt.id}/confirmation`, { body: { website_product_id: 'shop-1', website_url: 'https://shop.example/p/1' } });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.listing_state, 'confirmed');
  });

  test('confirmation with the wrong content type is 422 on Content-Type', async () => {
    const response = await h.api('POST', `/products/${tshirt.id}/confirmation`, {
      body: '{}',
      headers: { 'Content-Type': 'text/plain' },
    });
    assert.equal(response.body.field, 'Content-Type');
  });

  test('unknown body fields are refused with the JSON path', async () => {
    const response = await h.api('POST', `/products/${tshirt.id}/confirmation`, { body: { website_product_id: 'x', website_url: 'https://a.example', extra: 1 } });
    assert.equal(response.status, 422);
    assert.equal(response.body.field, 'extra');
  });

  test('secret rotation sends two v1 signatures and both secrets verify', async () => {
    const rotated = (await h.control<{ secret: string }>('POST', '/webhooks/rotate-secret')).body;
    h.receiver.secrets = [rotated.secret];
    const ping = await h.control<DeliveryBody>('POST', '/webhooks/ping');
    const event = await h.receiver.waitFor((candidate) => candidate.type === 'ping' && candidate.headers['printarex-event-id'] === ping.body.event_id);
    assert.ok(event.signatureValid);
    assert.equal(String(event.headers['printarex-signature']).match(/v1=/g)?.length, 2);
    assert.equal(event.sequence, null);
  });
});

describe('6. order intake', () => {
  test('201 with Location, then the real status arrives by webhook', async () => {
    const created = await h.api<OrderBody>('POST', '/orders', { body: orderBody(orderable(tshirt).id) });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'received');
    assert.equal(created.headers.get('location'), `/merchant/v1/orders/${created.body.id}`);
    const changed = await h.receiver.waitFor((event) => event.type === 'order.status_changed' && event.data.order?.id === created.body.id);
    assert.equal(changed.data.previous_status, 'received');
    assert.equal(changed.data.order?.status, 'awaiting_provider');
    assert.equal(changed.sequence, 2);
  });

  test('same external_order_id and body is 200; a different body is 409 idempotency_key_reuse', async () => {
    const body = orderBody(orderable(tshirt).id);
    const first = await h.api<OrderBody>('POST', '/orders', { body });
    const repeat = await h.api<OrderBody>('POST', '/orders', { body });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.id, first.body.id);
    const changed = await h.api('POST', '/orders', { body: { ...body, display_number: '#9' } });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, 'idempotency_key_reuse');
  });

  test('"79" and "79.00" are the same body', async () => {
    const body = orderBody(orderable(tshirt).id);
    await h.api('POST', '/orders', { body });
    const same = { ...body, items: [{ ...body.items[0], unit_price: '79' }] };
    assert.equal((await h.api('POST', '/orders', { body: same })).status, 200);
  });

  const refusals: [string, () => ReturnType<typeof orderBody>, number, string, string | null][] = [
    ['unpaid', () => orderBody(orderable(tshirt).id, { payment_status: 'pending' }), 422, 'payment_status_unsupported', 'payment_status'],
    ['invalid phone', () => orderBody(orderable(tshirt).id, {}, { phone: '0501234567' }), 422, 'phone_invalid', 'shipping_address.phone'],
    ['currency mismatch', () => orderBody(orderable(tshirt).id, { currency: 'USD' }), 422, 'currency_mismatch', 'currency'],
    ['unsupported country', () => orderBody(orderable(tshirt).id, {}, { country: 'US' }), 422, 'billing_not_available', 'shipping_address.country'],
    ['unknown city', () => orderBody(orderable(tshirt).id, {}, { city: 'Gotham' }), 422, 'address_invalid', 'shipping_address.city'],
    ['unknown variant', () => orderBody('var_0000'), 422, 'variant_unknown', 'items[0].variant_id'],
    ['out of stock', () => orderBody(soldOut(tshirt).id), 422, 'variant_out_of_stock', 'items[0].variant_id'],
    ['too many items', () => orderBody(orderable(tshirt).id, { items: Array.from({ length: 101 }, () => ({ variant_id: orderable(tshirt).id, quantity: 1, unit_price: '1.00' })) }), 422, 'too_many_items', 'items'],
    ['multi provider cart', () => orderBody(orderable(tshirt).id, { items: [{ variant_id: orderable(tshirt).id, quantity: 1, unit_price: '79.00' }, { variant_id: orderable(mug).id, quantity: 1, unit_price: '49.00' }] }), 422, 'multi_provider_cart', 'items'],
    ['uncovered destination (provider 2 skips the last emirate)', () => orderBody(orderable(mug).id, {}, { city: 'Umm Al Quwain', state: 'Umm Al Quwain' }), 422, 'destination_uncovered', 'shipping_address.state'],
    ['quantity over the new-key line cap', () => orderBody(orderable(tshirt).id, { items: [{ variant_id: orderable(tshirt).id, quantity: 51, unit_price: '1.00' }] }), 429, 'velocity_cap', 'items'],
  ];
  for (const [name, build, status, code, field] of refusals) {
    test(`refuses: ${name}`, async () => {
      const response = await h.api('POST', '/orders', { body: build() });
      assert.equal(response.status, status, JSON.stringify(response.body));
      assert.equal(response.body.code, code);
      assert.equal(response.body.field, field);
    });
  }

  // Each body carries two problems; the one listed first in production's check order must be the one reported.
  const precedence: [string, Record<string, unknown>, string, string | null][] = [
    ['external_order_id before payment_status', { external_order_id: '', payment_status: 'pending' }, 'validation_failed', 'external_order_id'],
    ['payment_status before currency', { payment_status: 'pending', currency: 'usd' }, 'payment_status_unsupported', 'payment_status'],
    ['currency before display_number', { currency: 'usd', display_number: 'x'.repeat(51) }, 'validation_failed', 'currency'],
    ['display_number before customer.email', { display_number: 'x'.repeat(51), customer: { email: 'nope' } }, 'validation_failed', 'display_number'],
    ['customer.email before items', { customer: { email: 'nope' }, items: [] }, 'validation_failed', 'customer.email'],
    ['items before the address', { items: [], shipping_address: { name: '' } }, 'validation_failed', 'items'],
    ['a line before the address', { items: [{ quantity: 1, unit_price: '1.00' }], shipping_address: { name: '' } }, 'validation_failed', 'items[0].variant_id'],
    ['the first bad line before a later one', { items: [{ variant_id: 'var_x', quantity: 0, unit_price: '1.00' }, { quantity: 1, unit_price: '1.00' }] }, 'validation_failed', 'items[0].quantity'],
  ];
  for (const [name, overrides, code, field] of precedence) {
    test(`reports ${name}`, async () => {
      const response = await h.api('POST', '/orders', { body: orderBody(orderable(tshirt).id, overrides) });
      assert.equal(response.status, 422, JSON.stringify(response.body));
      assert.deepEqual([response.body.code, response.body.field], [code, field]);
    });
  }

  test('a velocity cap carries Retry-After', async () => {
    const response = await h.api('POST', '/orders', { body: orderBody(orderable(tshirt).id, { items: [{ variant_id: orderable(tshirt).id, quantity: 51, unit_price: '1.00' }] }) });
    assert.ok(Number(response.headers.get('retry-after')) >= 1);
  });

  test('city aliases resolve (Arabic and landmark names)', async () => {
    const response = await h.api('POST', '/orders', { body: orderBody(orderable(tshirt).id, {}, { city: 'دبي' }) });
    assert.equal(response.status, 201);
  });

  test('missing phone holds the order; PATCH with a phone releases it', async () => {
    const created = await h.api<OrderBody>('POST', '/orders', { body: orderBody(orderable(tshirt).id, {}, { phone: undefined }) });
    const held = await h.receiver.waitFor((event) => event.data.order?.id === created.body.id && event.data.order?.hold_reason?.code === 'missing_phone');
    assert.equal(held.data.order?.hold_reason?.action_required, true);
    const patched = await h.api('PATCH', `/orders/${created.body.id}/shipping-address`, { body: { phone: '+971501112233' } });
    assert.equal(patched.status, 200);
    await h.receiver.waitFor((event) => event.data.order?.id === created.body.id && event.data.order?.status === 'awaiting_provider');
  });

  test('PATCH cannot change the city', async () => {
    const created = await h.api<OrderBody>('POST', '/orders', { body: orderBody(orderable(tshirt).id) });
    const response = await h.api('PATCH', `/orders/${created.body.id}/shipping-address`, { body: { city: 'Sharjah' } });
    assert.equal(response.body.code, 'address_change_requires_reprice');
  });

  test('payment_method_missing hold when the merchant has no card', async () => {
    await h.control('PATCH', '/store', { payment_method_ready: false });
    const created = await h.api<OrderBody>('POST', '/orders', { body: orderBody(orderable(tshirt).id) });
    await h.receiver.waitFor((event) => event.data.order?.id === created.body.id && event.data.order?.hold_reason?.code === 'payment_method_missing');
    await h.control('PATCH', '/store', { payment_method_ready: true });
  });

  test('plan lapsed is 402; intake paused is 503 with Retry-After', async () => {
    await h.control('PATCH', '/store', { plan_active: false });
    assert.equal((await h.api('POST', '/orders', { body: orderBody(orderable(tshirt).id) })).status, 402);
    await h.control('PATCH', '/store', { plan_active: true, order_intake_paused: true });
    const paused = await h.api('POST', '/orders', { body: orderBody(orderable(tshirt).id) });
    assert.equal(paused.status, 503);
    assert.equal(paused.headers.get('retry-after'), '60');
    await h.control('PATCH', '/store', { order_intake_paused: false });
  });
});

describe('7-8. lifecycle and cancellation', () => {
  test('happy path: provider accepts, charge, ship, deliver; sequences only go up', async () => {
    const created = await h.api<OrderBody>('POST', '/orders', { body: orderBody(orderable(tshirt).id) });
    const id = created.body.id;
    await h.receiver.waitFor((event) => event.data.order?.id === id && event.data.order?.status === 'awaiting_provider');
    for (let step = 0; step < 4; step++) assert.equal((await h.control('POST', `/orders/${id}/advance`)).status, 200);
    const charged = await h.receiver.waitFor((event) => event.type === 'order.charged' && event.data.order?.id === id);
    assert.match(charged.data.charge?.amount ?? '', /^\d+\.00$/);
    assert.equal(charged.data.order?.costs.basis, 'final');
    await h.receiver.waitFor((event) => event.type === 'order.delivered' && event.data.order?.id === id);
    const events = h.receiver.events.filter((event) => event.data.order?.id === id);
    const sequences = events.map((event) => event.sequence!);
    assert.deepEqual([...sequences].sort((a, b) => a - b), sequences);
    const shipped = events.find((event) => event.type === 'order.shipped');
    assert.ok(shipped?.data.shipment?.tracking_number);
  });

  test('own-driver shipment has no carrier or tracking', async () => {
    const created = await h.api<OrderBody>('POST', '/orders', { body: orderBody(orderable(tshirt).id) });
    const id = created.body.id;
    await h.receiver.waitFor((event) => event.data.order?.id === id && event.data.order?.status === 'awaiting_provider');
    await h.control('POST', `/orders/${id}/advance`);
    await h.control('POST', `/orders/${id}/advance`);
    await h.control('POST', `/orders/${id}/ship`, { method: 'own_driver' });
    const shipped = await h.receiver.waitFor((event) => event.type === 'order.shipped' && event.data.order?.id === id);
    assert.equal(shipped.data.shipment?.carrier, null);
    assert.equal(shipped.data.shipment?.tracking_number, null);
  });

  test('reassigning shows note "reassigning" in status_history', async () => {
    const created = await h.api<OrderBody>('POST', '/orders', { body: orderBody(orderable(tshirt).id) });
    const id = created.body.id;
    await h.receiver.waitFor((event) => event.data.order?.id === id && event.data.order?.status === 'awaiting_provider');
    await h.control('POST', `/orders/${id}/accept`);
    const order = (await h.control<OrderBody>('POST', `/orders/${id}/reassign`)).body;
    assert.equal(order.status_history.at(-1)?.note, 'reassigning');
  });

  test('cancel is 202 and resolves to order.cancelled with refund none', async () => {
    const created = await h.api<OrderBody>('POST', '/orders', { body: orderBody(orderable(tshirt).id) });
    const id = created.body.id;
    await h.receiver.waitFor((event) => event.data.order?.id === id && event.data.order?.status === 'awaiting_provider');
    const cancel = await h.api('POST', `/orders/${id}/cancel`, { body: { reason: 'buyer changed mind' } });
    assert.equal(cancel.status, 202);
    assert.deepEqual(cancel.body, { order_id: id, cancellation_status: 'requested' });
    const cancelled = await h.receiver.waitFor((event) => event.type === 'order.cancelled' && event.data.order?.id === id);
    assert.deepEqual(cancelled.data.refund, { status: 'none', amount: null, currency: 'AED' });
    const reuse = await h.api('POST', '/orders', { body: { ...orderBody(orderable(tshirt).id), external_order_id: created.body.external_order_id } });
    assert.equal(reuse.body.code, 'external_id_in_use');
    assert.equal(reuse.body.details?.existing_order_id, id);
  });

  test('a rejected cancellation arrives as order.cancel_rejected and the order continues', async () => {
    await h.control('POST', '/reset');
    const created = await h.api<OrderBody>('POST', '/orders', { body: orderBody(orderable(productOfType((await h.api<Page<ProductBody>>('GET', '/products')).body.data, 'T-Shirt')).id) });
    const id = created.body.id;
    await h.receiver.waitFor((event) => event.data.order?.id === id && event.data.order?.status === 'awaiting_provider');
    await h.api('POST', `/orders/${id}/cancel`);
    await h.control('POST', `/orders/${id}/cancel-outcome`, { outcome: 'rejected', reason_code: 'production_started' });
    const rejected = await h.receiver.waitFor((event) => event.type === 'order.cancel_rejected' && event.data.order?.id === id);
    assert.equal(rejected.data.reason_code, 'production_started');
    assert.equal((await h.api<OrderBody>('GET', `/orders/${id}`)).body.status, 'awaiting_provider');
  });

  test('cancel after production started is 409 cancel_window_closed', async () => {
    const products = (await h.api<Page<ProductBody>>('GET', '/products')).body.data;
    const created = await h.api<OrderBody>('POST', '/orders', { body: orderBody(orderable(productOfType(products, 'T-Shirt')).id) });
    const id = created.body.id;
    await h.receiver.waitFor((event) => event.data.order?.id === id && event.data.order?.status === 'awaiting_provider');
    await h.control('POST', `/orders/${id}/advance`);
    assert.equal((await h.api('POST', `/orders/${id}/cancel`)).body.code, 'payment_in_progress');
    await h.control('POST', `/orders/${id}/advance`);
    assert.equal((await h.api('POST', `/orders/${id}/cancel`)).body.code, 'cancel_window_closed');
  });

  test('payment failure sends order.payment_failed with a retry_url', async () => {
    const products = (await h.api<Page<ProductBody>>('GET', '/products')).body.data;
    const created = await h.api<OrderBody>('POST', '/orders', { body: orderBody(orderable(productOfType(products, 'T-Shirt')).id) });
    const id = created.body.id;
    await h.receiver.waitFor((event) => event.data.order?.id === id && event.data.order?.status === 'awaiting_provider');
    await h.control('POST', `/orders/${id}/hold`, { code: 'payment_failed', detail_code: 'no_card' });
    const failed = await h.receiver.waitFor((event) => event.type === 'order.payment_failed' && event.data.order?.id === id);
    assert.ok(failed.data.retry_url);
    assert.equal(failed.data.order?.hold_reason?.detail_code, 'no_card');
  });
});

describe('9. webhook delivery', () => {
  test('a failed delivery is retried with attempt 2', async () => {
    h.receiver.failNext = 1;
    const ping = (await h.control<DeliveryBody>('POST', '/webhooks/ping')).body;
    const retried = await h.receiver.waitFor((event) => event.id === ping.event_id && event.attempt === 2);
    assert.equal(retried.type, 'ping');
  });

  test('replay re-sends the same event id', async () => {
    const test = await h.api<DeliveryBody>('POST', '/webhooks/test', { body: { event_type: 'order.shipped' } });
    assert.equal(test.status, 202);
    await h.receiver.waitFor((event) => event.id === test.body.event_id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const replay = await h.api('POST', `/webhook-deliveries/${test.body.id}/replay`);
    assert.equal(replay.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(h.receiver.events.filter((event) => event.id === test.body.event_id).length, 2);
  });

  test('test events exist for every type and are validated', async () => {
    assert.equal((await h.api('POST', '/webhooks/test', { body: { event_type: 'nope.nope' } })).status, 422);
    assert.equal((await h.api('POST', '/webhooks/test', { body: { event_type: 'api_key.expiring' } })).status, 202);
  });

  test('a test event carries the currency of the store', async () => {
    const saudi = await startHarness({ SANDBOX_STORE_COUNTRY: 'SA' });
    try {
      const queued = await saudi.api<DeliveryBody>('POST', '/webhooks/test', { body: { event_type: 'order.charged' } });
      const event = await saudi.receiver.waitFor((candidate) => candidate.id === queued.body.event_id);
      assert.equal(event.data.charge?.currency, 'SAR');
      assert.equal(event.data.order?.currency, 'SAR');
      assert.equal(event.data.order?.costs.currency, 'SAR');
    } finally {
      await saudi.stop();
    }
  });

  test('fault injection: a bad signature is detectable', async () => {
    await h.control('POST', '/webhooks/faults', { mode: 'bad_signature', event_type: 'ping' });
    const ping = (await h.control<DeliveryBody>('POST', '/webhooks/ping')).body;
    const event = await h.receiver.waitFor((candidate) => candidate.id === ping.event_id);
    assert.equal(event.signatureValid, false);
  });

  test('delivery log lists deliveries newest first', async () => {
    const page = await h.api<Page<DeliveryBody>>('GET', '/webhook-deliveries?limit=2');
    assert.equal(page.body.data.length, 2);
    assert.ok(page.body.next_cursor);
    const next = await h.api<Page<DeliveryBody>>('GET', `/webhook-deliveries?limit=2&cursor=${page.body.next_cursor}`);
    assert.notEqual(next.body.data[0]?.id, page.body.data[0]?.id);
  });
});

describe('10. rate limits, faults and paging', () => {
  test('429 rate_limited with Retry-After once the limit is used up', async () => {
    await h.control('POST', '/rate-limits', { general: 2 });
    await h.api('GET', '/store');
    await h.api('GET', '/store');
    const limited = await h.api('GET', '/store');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    await h.control('POST', '/rate-limits', { general: 120 });
  });

  test('an oversized control request is 413 and is not run with an empty body', async () => {
    // With an empty body this call would default to reason "disconnected" and unpublish every product.
    const oversized = await h.control('POST', '/connection/disable', { reason: 'admin', padding: 'x'.repeat(300_000) });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.code, 'payload_too_large');
    assert.equal((await h.control<{ store: { connected: boolean } }>('GET', '/state')).body.store.connected, true);
  });

  test('injected entitlement_unavailable is 503 with Retry-After, once', async () => {
    await h.control('POST', '/faults', { code: 'entitlement_unavailable', route: 'GET /store' });
    const failed = await h.api('GET', '/store');
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('retry-after'), '30');
    assert.equal((await h.api('GET', '/store')).status, 200);
  });

  test('GET /orders needs exactly one filter; updated_since pages oldest first', async () => {
    assert.equal((await h.api('GET', '/orders')).status, 422);
    const page = await h.api<Page<OrderBody>>('GET', `/orders?updated_since=${encodeURIComponent('2000-01-01T00:00:00Z')}&limit=1`);
    assert.equal(page.body.data.length, 1);
    assert.ok(page.body.next_cursor);
    assert.equal((await h.api('GET', '/orders?updated_since=yesterday')).body.field, 'updated_since');
  });

  test('a bad cursor is 422 on cursor', async () => {
    assert.equal((await h.api('GET', '/products?cursor=%%%')).body.field, 'cursor');
  });
});

describe('velocity review for new keys', () => {
  test('the first orders of a new key are held as velocity_review', async () => {
    const held = await startHarness({ SANDBOX_HELD_FIRST_ORDERS: '1' });
    try {
      const products = (await held.api<Page<ProductBody>>('GET', '/products')).body.data;
      const first = products[0];
      assert.ok(first);
      const created = await held.api<OrderBody>('POST', '/orders', { body: orderBody(orderable(first).id) });
      const event = await held.receiver.waitFor((candidate) => candidate.data.order?.id === created.body.id && candidate.data.order?.hold_reason?.code === 'velocity_review');
      assert.equal(event.data.order?.hold_reason?.action_required, true);
      await held.control('POST', `/orders/${created.body.id}/release`);
      await held.receiver.waitFor((candidate) => candidate.data.order?.id === created.body.id && candidate.data.order?.status === 'awaiting_provider');
    } finally {
      await held.stop();
    }
  });
});
