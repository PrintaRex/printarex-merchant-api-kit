import type { CatalogSync } from './catalog-sync.ts';
import type { Db } from './db.ts';
import type { OrderSync } from './order-sync.ts';
import type { ApiInventory, ApiOrder, ApiProduct } from './printarex-client.ts';

/** The events this website acts on. PrintaRex adds event types over time, so unknown types must be accepted too. */
type KnownEvent =
  | { type: 'product.publish_requested' | 'product.updated' | 'product.cost_changed' | 'product.unpublish_requested'; data: { product: ApiProduct } }
  | { type: 'product.deleted'; data: { product_id: string } }
  | { type: 'inventory.updated'; data: { product_id: string; variants: ApiInventory[] } }
  | { type: 'order.cancel_rejected'; data: { order: ApiOrder; message: string } }
  | { type: 'order.payment_failed' | 'order.payment_expired'; data: { order: ApiOrder; retry_url: string } }
  | { type: 'connection.disabled'; data: { reason: string } }
  | { type: 'ping' | 'api_key.expiring'; data: unknown };

export type WebhookEvent = KnownEvent & { id: string; sequence: number | null };

/**
 * Processes verified webhook events after the HTTP response was sent.
 * Delivery is at-least-once and unordered; `Db` decides which events to skip (duplicates and
 * stale sequences) and saves the outcome, so this class only says what each event means.
 */
export class WebhookHandler {
  private queue: Promise<void> = Promise.resolve();
  private readonly db: Db;
  private readonly catalog: CatalogSync;
  private readonly orders: OrderSync;

  constructor(db: Db, catalog: CatalogSync, orders: OrderSync) {
    this.db = db;
    this.catalog = catalog;
    this.orders = orders;
  }

  /** Called after answering 2xx; events run one at a time in arrival order. */
  enqueue(event: WebhookEvent): void {
    this.queue = this.queue.then(() => this.process(event)).catch((error) => console.error('[starter] webhook processing failed', event.type, error));
  }

  idle(): Promise<void> {
    return this.queue;
  }

  private async process(event: WebhookEvent): Promise<void> {
    const receipt = { id: event.id, type: event.type, sequence: event.sequence, resourceKey: productResourceKey(event) };
    if (!this.db.admitEvent(receipt)) return;
    await this.dispatch(event);
    this.db.completeEvent(receipt);
  }

  private async dispatch(event: WebhookEvent): Promise<void> {
    switch (event.type) {
      case 'product.publish_requested':
        return this.catalog.onPublishRequested(event.data.product);
      case 'product.updated':
      case 'product.cost_changed':
        return this.catalog.onProductUpdated(event.data.product);
      case 'product.unpublish_requested':
        return this.catalog.onUnpublishRequested(event.data.product.id);
      case 'product.deleted':
        return this.catalog.onDeleted(event.data.product_id);
      case 'inventory.updated':
        return this.catalog.onInventoryUpdated(event.data.product_id, event.data.variants);
      case 'order.cancel_rejected':
        this.orders.applyIfNewer(event.data.order, event.sequence);
        return this.orders.setNotice(event.data.order.external_order_id, `Cancellation refused: ${event.data.message}`);
      case 'order.payment_failed':
      case 'order.payment_expired':
        this.orders.applyIfNewer(event.data.order, event.sequence);
        return this.orders.setNotice(event.data.order.external_order_id, `PrintaRex could not charge the merchant. Resolve it here: ${event.data.retry_url}`);
      case 'connection.disabled':
        return this.db.update((data) => {
          data.connectionDisabledReason = event.data.reason;
        });
      case 'ping':
      case 'api_key.expiring':
        return;
      default: {
        // Every other order.* / shipment.* / return.* event, including future ones, carries the full current order.
        const otherEvent: { sequence: number | null; data?: { order?: ApiOrder } } = event;
        if (otherEvent.data?.order) this.orders.applyIfNewer(otherEvent.data.order, otherEvent.sequence);
      }
    }
  }
}

function productResourceKey(event: WebhookEvent): string | null {
  const data = event.data as { product?: ApiProduct; product_id?: string } | null;
  const productId = data?.product?.id ?? data?.product_id;
  return productId ? `product:${productId}` : null;
}
