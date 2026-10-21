import type { Sandbox } from './context.ts';
import { notFound, validationFailed } from './errors.ts';
import { jsonBody, type Reply, type RequestContext } from './http.ts';
import { cursorPage, decodeCursor, pageLimit } from './paging.ts';
import { obj, str } from './shape.ts';
import { isWebhookEventType, type WebhookEventType } from './state.ts';
import { deliveryView } from './views.ts';
import { emit, queryDeliveries, replay } from './webhook-outbox.ts';

// ---- Merchant API routes ---------------------------------------------------
// The routes below only validate requests; the outbox owns every delivery state change.

const STATUS_FILTERS = new Set(['pending', 'succeeded', 'failed', 'dead']);
const EVENT_TYPE_PATTERN = /^[a-z_]{1,30}(\.[a-z_]{1,30})?$/;

export function listDeliveries(sandbox: Sandbox, ctx: RequestContext): Reply {
  const limit = pageLimit(ctx.query);
  const status = ctx.query.get('status');
  const eventType = ctx.query.get('event_type');
  if (status !== null && !STATUS_FILTERS.has(status)) throw validationFailed('status must be one of pending, succeeded, failed, dead.', 'status');
  if (eventType !== null && !EVENT_TYPE_PATTERN.test(eventType)) throw validationFailed('event_type is not valid.', 'event_type');
  const cursor = decodeCursor(ctx.query.get('cursor'));
  const rows = queryDeliveries(sandbox, { status, eventType })
    .filter((delivery) => !cursor || delivery.createdAt.getTime() < cursor.at.getTime() || (delivery.createdAt.getTime() === cursor.at.getTime() && delivery.id < cursor.id));
  const { page, nextCursor } = cursorPage(rows, limit, (delivery) => delivery.createdAt);
  return { status: 200, body: { data: page.map(deliveryView), next_cursor: nextCursor } };
}

export function replayDelivery(sandbox: Sandbox, ctx: RequestContext): Reply {
  const delivery = replay(sandbox, ctx.params.delivery_id);
  if (!delivery) throw notFound('Delivery not found.');
  return { status: 202, body: deliveryView(delivery) };
}

export function sendTestEvent(sandbox: Sandbox, ctx: RequestContext): Reply {
  const body = jsonBody(ctx, obj({ event_type: str }));
  const eventType = body.event_type;
  if (!eventType?.trim()) throw validationFailed('event_type is required.', 'event_type');
  if (!isWebhookEventType(eventType)) throw validationFailed('This event type is not supported.', 'event_type');
  const endpoint = sandbox.state.endpoint;
  if (!endpoint.url) throw validationFailed('This store has no webhook endpoint. Set one in the Developers tab first.');
  if (endpoint.status !== 'active') throw validationFailed('The webhook endpoint is not active. Re-enable it in the Developers tab first.');
  const storeLevel = eventType === 'connection.disabled' || eventType === 'api_key.expiring' || eventType === 'ping';
  const delivery = emit(sandbox, eventType, null, storeLevel ? null : 1, sampleData(eventType, sandbox.state.store.currency));
  return { status: 202, body: deliveryView(delivery) };
}

/** Placeholder payloads that match no real product or order (production uses the same ids). */
function sampleData(eventType: WebhookEventType, currency: string): unknown {
  const now = new Date().toISOString();
  const product = {
    id: 'prd_SAMPLE0000', status: 'published', title: 'Sample product', description_html: '<p>Sample</p>', tags: [], type: 'T-Shirt',
    images: [], variants: [{ id: 'var_SAMPLE0000', sku: 'SAMPLE', color: { name: 'White', hex: null }, size: 'M', price: '79.00', currency, provider_group_id: 'pg_SAMPLE0000', weight_grams: null, available: true }],
    production_time: { base_days: 2, bulk_tiers: [] }, cost: { production: '32.00', shipping_from: '15.00', branding: '0.00', order_fee: '3.00', currency },
    listing_state: 'sent', listing_reason: null, website_product_id: null, website_url: null, updated_at: now, sequence: 1,
  };
  const order = (status: string) => ({
    id: 'ord_SAMPLE0000', external_order_id: 'SAMPLE-1', display_number: null, payment_status: 'paid', currency, status, hold_reason: null, return: null,
    items: [{ variant_id: 'var_SAMPLE0000', product_id: 'prd_SAMPLE0000', quantity: 1, unit_price: '79.00', external_line_id: null }],
    shipments: [], costs: { production: '32.00', shipping: '15.00', branding: '0.00', fee: '3.00', currency, basis: 'estimated' },
    estimated_delivery: null, created_at: now, updated_at: now, status_history: [{ status, hold_reason: null, note: null, at: now }], sequence: 1,
  });
  const shipment = { id: 'shp_SAMPLE0000', method: 'carrier', carrier: 'Sample Carrier', tracking_number: 'SAMPLE123', tracking_url: 'https://example.invalid/track/SAMPLE123', shipped_at: now, delivered_at: null };
  const retryUrl = 'https://example.invalid/sample';
  switch (eventType) {
    case 'product.publish_requested':
    case 'product.unpublish_requested':
    case 'product.cost_changed':
      return { product };
    case 'product.updated':
      return { product, changed: ['images'] };
    case 'product.deleted':
      return { product_id: 'prd_SAMPLE0000', website_product_id: null };
    case 'inventory.updated':
      return { product_id: 'prd_SAMPLE0000', variants: [{ variant_id: 'var_SAMPLE0000', product_id: 'prd_SAMPLE0000', available: true, quantity: 10, updated_at: now }] };
    case 'order.status_changed':
      return { order: order('awaiting_provider'), previous_status: 'received' };
    case 'order.payment_failed':
    case 'order.payment_expired':
      return { order: order('on_hold'), retry_url: retryUrl };
    case 'order.charged':
      return { order: order('in_production'), charge: { amount: '50.00', currency, charged_at: now, invoice_url: null } };
    case 'order.shipped':
    case 'order.delivered':
      return { order: order(eventType === 'order.shipped' ? 'shipped' : 'delivered'), shipment };
    case 'shipment.exception':
      return { order: order('shipped'), shipment, kind: 'exception' };
    case 'order.cancelled':
    case 'return.status_changed':
      return { order: order('cancelled') };
    case 'order.cancel_rejected':
      return { order: order('in_production'), reason_code: 'production_started', message: 'Production has already started, so the order cannot be cancelled. It continues.' };
    case 'order.refunded':
      return { order: order('refunded'), refund: { status: 'refunded', amount: '50.00', currency } };
    case 'connection.disabled':
      return { reason: 'disconnected' };
    case 'api_key.expiring':
      return { display_prefix: 'prx_uat_SAMPLE', expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() };
    case 'ping':
      return {};
  }
}

