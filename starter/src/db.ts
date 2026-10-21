import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiHoldReason, ApiShipment } from './printarex-client.ts';

/**
 * The starter keeps everything in one JSON file so it runs with no database.
 * A real website uses its own database; what matters is WHAT is stored, not how.
 * The types below are that "what"; the `Db` class after them is the "when to save, and which
 * events to ignore".
 */
export type Listing = {
  printarexProductId: string;
  websiteProductId: string;
  title: string;
  descriptionHtml: string;
  images: string[];
  variants: { id: string; label: string; price: string; currency: string; available: boolean; providerGroupId: string }[];
  productionCost: string | null;
  visible: boolean;
  listingState: string | null;
};

type PushState = 'pending' | 'sent' | 'failed';

export type LocalOrder = {
  id: string;
  createdAt: string;
  email: string;
  address: { name: string; phone: string | null; address1: string; city: string; state: string; country: string };
  items: { variantId: string; title: string; quantity: number; unitPrice: string }[];
  currency: string;
  shippingEstimate: string;
  push: { state: PushState; attempts: number; nextAttemptAt: string | null; lastError: string | null };
  printarex: {
    orderId: string | null;
    status: string | null;
    holdReason: ApiHoldReason | null;
    shipments: ApiShipment[];
    notice: string | null;
  };
};

type WebhookLogEntry = { id: string; type: string; sequence: number | null; receivedAt: string; outcome: string };

export type Data = {
  listings: Record<string, Listing>;
  orders: Record<string, LocalOrder>;
  /** Event ids already processed: delivery is at-least-once, so duplicates are expected. */
  processedEventIds: string[];
  /** Highest `sequence` applied per resource (`product:<id>`, `order:<id>`). */
  sequences: Record<string, number>;
  lastReconciledAt: string | null;
  connectionDisabledReason: string | null;
  webhookLog: WebhookLogEntry[];
};

/** Read-only all the way down: the only way to change stored state is `Db.update`, which also saves it. */
export type ReadOnly<T> = T extends (infer Item)[]
  ? readonly ReadOnly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: ReadOnly<T[Key]> }
    : T;

/** What the webhook handler knows about one delivery before it decides whether to act on it. */
export type EventReceipt = {
  id: string;
  type: string;
  sequence: number | null;
  /** The product or order the event is about (`product:<id>`, `order:<id>`), or null when it is about neither. */
  resourceKey: string | null;
};

/** The highest `sequence` this change brings a resource up to. */
export type AppliedSequence = { resourceKey: string; sequence: number };

const MAX_REMEMBERED_EVENTS = 5000;
const MAX_LOGGED_EVENTS = 100;

const EMPTY: Data = {
  listings: {},
  orders: {},
  processedEventIds: [],
  sequences: {},
  lastReconciledAt: null,
  connectionDisabledReason: null,
  webhookLog: [],
};

/** Own keys only, so an id such as "__proto__" or "constructor" finds nothing. */
export function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A missing file is a fresh start; an unreadable or corrupt one stops startup, so the next save cannot overwrite it. */
function readExisting(file: string): Partial<Data> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Partial<Data>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read ${file}; fix or move it before starting.`, { cause: error });
  }
}

/**
 * The Sync state: everything the website remembers about PrintaRex, plus the three rules that keep
 * it correct. Delivery is at-least-once and unordered, so:
 *
 * 1. De-duplicate on the webhook event id.
 * 2. Drop an event or order whose `sequence` is LOWER than the one already applied for that
 *    resource. Equal is fine: several events from one change share a sequence.
 * 3. Save after every change, in one place, so no caller has to remember to.
 *
 * Callers read through `data` and change state only through `update`, `admitEvent` and `completeEvent`.
 */
export class Db {
  readonly imagesDir: string;
  private readonly file: string;
  private readonly state: Data;

  constructor(dataDir: string) {
    mkdirSync(join(dataDir, 'images'), { recursive: true });
    this.file = join(dataDir, 'db.json');
    this.imagesDir = join(dataDir, 'images');
    this.state = { ...structuredClone(EMPTY), ...readExisting(this.file) };
  }

  get data(): ReadOnly<Data> {
    return this.state;
  }

  /**
   * Applies a change and saves it as one step. Pass `applied` when the change brings a resource up
   * to a `sequence`, so the high-water mark is saved together with the data it describes.
   */
  update(change: (data: Data) => void, applied?: AppliedSequence): void {
    change(this.state);
    if (applied) this.raiseSequence(applied);
    this.persist();
  }

  /** Rule 2. Callers skip events that carry no sequence (connection and ping events have none). */
  isStale(resourceKey: string, sequence: number): boolean {
    return sequence < (this.state.sequences[resourceKey] ?? 0);
  }

  /**
   * Rules 1 and 2 for a webhook delivery. Returns true when the event should be acted on; an event
   * that is ignored is written to the webhook log with the reason.
   */
  admitEvent(receipt: EventReceipt): boolean {
    if (this.state.processedEventIds.includes(receipt.id)) return this.ignoreEvent(receipt, 'duplicate, ignored');
    if (receipt.resourceKey && receipt.sequence !== null && this.isStale(receipt.resourceKey, receipt.sequence)) {
      return this.ignoreEvent(receipt, 'stale sequence, ignored');
    }
    return true;
  }

  /**
   * Call after the event was acted on, not before: if acting on it fails, the same delivery must
   * be allowed to try again.
   */
  completeEvent(receipt: EventReceipt): void {
    this.state.processedEventIds.push(receipt.id);
    if (this.state.processedEventIds.length > MAX_REMEMBERED_EVENTS) this.state.processedEventIds.shift();
    if (receipt.resourceKey && receipt.sequence !== null) this.raiseSequence({ resourceKey: receipt.resourceKey, sequence: receipt.sequence });
    this.logEvent(receipt, 'processed');
    this.persist();
  }

  private ignoreEvent(receipt: EventReceipt, reason: string): false {
    this.logEvent(receipt, reason);
    this.persist();
    return false;
  }

  private logEvent(receipt: EventReceipt, outcome: string): void {
    const { webhookLog } = this.state;
    webhookLog.unshift({ id: receipt.id, type: receipt.type, sequence: receipt.sequence, receivedAt: new Date().toISOString(), outcome });
    webhookLog.length = Math.min(webhookLog.length, MAX_LOGGED_EVENTS);
  }

  /** The mark only moves up: an older delivery must never lower it. */
  private raiseSequence({ resourceKey, sequence }: AppliedSequence): void {
    this.state.sequences[resourceKey] = Math.max(this.state.sequences[resourceKey] ?? 0, sequence);
  }

  /**
   * Writes to a temporary file first, so a crash never leaves half a file. The file holds buyer
   * names, emails, phones and addresses, so only this user may read it. A temporary file left by a
   * crash is removed first: `mode` applies only to a file that is created.
   */
  private persist(): void {
    const temporary = `${this.file}.tmp`;
    rmSync(temporary, { force: true });
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.file);
  }
}
