import { type Data, type Db, type LocalOrder, ownEntry, type ReadOnly } from './db.ts';
import { type ApiOrder, type OrderCreateRequest, PrintarexApiError, type PrintarexClient } from './printarex-client.ts';

const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Pushes paid orders to PrintaRex from a retry queue and keeps their status up to date.
 *
 * - `external_order_id` is the idempotency key: a retry with the same body is safe and returns the
 *   same order (200). Never change the body between retries.
 * - Retry only temporary failures (429, 503, 5xx, network). Everything else needs a fix first.
 */
export class OrderSync {
  private readonly db: Db;
  private readonly client: PrintarexClient;

  constructor(db: Db, client: PrintarexClient) {
    this.db = db;
    this.client = client;
  }

  enqueue(order: LocalOrder): void {
    this.db.update((data) => {
      if (ownEntry(data.orders, order.id)) throw new Error(`Order ${order.id} already exists`);
      order.push = { state: 'pending', attempts: 0, nextAttemptAt: new Date().toISOString(), lastError: null };
      data.orders[order.id] = order;
    });
  }

  async pushDueOrders(): Promise<void> {
    const now = Date.now();
    for (const order of Object.values(this.db.data.orders)) {
      if (order.push.state !== 'pending' || !order.push.nextAttemptAt || Date.parse(order.push.nextAttemptAt) > now) continue;
      await this.push(order);
    }
  }

  private async push(order: ReadOnly<LocalOrder>): Promise<void> {
    this.db.update((data) => {
      storedOrder(data, order.id).push.attempts += 1;
    });
    let created: ApiOrder;
    try {
      created = (await this.client.createOrder(this.payload(order))).data;
    } catch (error) {
      this.recordPushFailure(order, error);
      return;
    }
    // Applied without the sequence check: this is the answer to our own request, not a webhook.
    this.db.update(
      (data) => {
        const stored = storedOrder(data, order.id);
        stored.push = { ...stored.push, state: 'sent', nextAttemptAt: null, lastError: null };
        applyRemoteOrder(stored, created);
      },
      { resourceKey: `order:${created.id}`, sequence: created.sequence },
    );
  }

  private recordPushFailure(order: ReadOnly<LocalOrder>, error: unknown): void {
    const retryable = !(error instanceof PrintarexApiError) || error.retryable;
    const message = error instanceof PrintarexApiError ? `${error.code} (${error.field ?? 'no field'}; request ${error.requestId})` : String(error);
    if (!retryable) {
      this.db.update((data) => {
        storedOrder(data, order.id).push = { ...order.push, state: 'failed', nextAttemptAt: null, lastError: message };
      });
      return;
    }
    const backoff = error instanceof PrintarexApiError && error.retryAfterSeconds
      ? error.retryAfterSeconds * 1000
      : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** order.push.attempts);
    this.db.update((data) => {
      storedOrder(data, order.id).push = { ...order.push, nextAttemptAt: new Date(Date.now() + backoff).toISOString(), lastError: message };
    });
  }

  /** The body is rebuilt from stored data, so every retry sends exactly the same request. */
  private payload(order: ReadOnly<LocalOrder>): OrderCreateRequest {
    return {
      external_order_id: order.id,
      display_number: `#${order.id}`,
      payment_status: 'paid',
      currency: order.currency,
      customer: { email: order.email },
      shipping_address: {
        name: order.address.name,
        ...(order.address.phone ? { phone: order.address.phone } : {}),
        address1: order.address.address1,
        city: order.address.city,
        state: order.address.state,
        country: order.address.country,
      },
      items: order.items.map((item) => ({ variant_id: item.variantId, quantity: item.quantity, unit_price: item.unitPrice })),
    };
  }

  /**
   * Applies an order from a webhook, a GET or a reconcile. `Db` decides whether it is stale
   * (delivery is unordered); a stale one is dropped.
   */
  applyIfNewer(remoteOrder: ApiOrder, sequence: number | null): boolean {
    const local = ownEntry(this.db.data.orders, remoteOrder.external_order_id);
    if (!local) return false;
    const resourceKey = `order:${remoteOrder.id}`;
    const arrivedSequence = sequence ?? remoteOrder.sequence;
    if (this.db.isStale(resourceKey, arrivedSequence)) return false;
    // The order body can be newer than the event that carried it, so remember whichever is higher.
    this.db.update((data) => applyRemoteOrder(storedOrder(data, local.id), remoteOrder), {
      resourceKey,
      sequence: Math.max(arrivedSequence, remoteOrder.sequence),
    });
    return true;
  }

  setNotice(externalOrderId: string, notice: string): void {
    this.db.update((data) => {
      const local = ownEntry(data.orders, externalOrderId);
      if (local) local.printarex.notice = notice;
    });
  }

  /** Remembers the phone PrintaRex accepted, so the order page and any retry show the same number. */
  recordPhone(orderId: string, phone: string): void {
    this.db.update((data) => {
      storedOrder(data, orderId).address.phone = phone;
    });
  }

  /** Webhooks can be missed (your site was down): page through recent changes to catch up. */
  async reconcile(): Promise<number> {
    const since = this.db.data.lastReconciledAt ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    let cursor: string | undefined;
    let applied = 0;
    do {
      const page = (await this.client.ordersUpdatedSince(since, cursor)).data;
      for (const order of page.data) if (this.applyIfNewer(order, order.sequence)) applied += 1;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    this.db.update((data) => {
      data.lastReconciledAt = startedAt;
    });
    return applied;
  }
}

function applyRemoteOrder(local: LocalOrder, remote: ApiOrder): void {
  // A notice explains the last action; it is outdated once the status moves on.
  if (local.printarex.status !== null && local.printarex.status !== remote.status) local.printarex.notice = null;
  local.printarex.orderId = remote.id;
  local.printarex.status = remote.status;
  local.printarex.holdReason = remote.hold_reason;
  local.printarex.shipments = remote.shipments;
}

function storedOrder(data: Data, orderId: string): LocalOrder {
  const order = ownEntry(data.orders, orderId);
  if (!order) throw new Error(`Unknown order ${orderId}`);
  return order;
}
