import type { SandboxConfig } from './config.ts';
import type { ErrorCode } from './errors.ts';
import { newUuid } from './ids.ts';

const ALL_SCOPES = [
  'store:read',
  'products:read',
  'products:write',
  'orders:read',
  'orders:write',
  'shipping:read',
  'webhooks:manage',
] as const;
export type Scope = (typeof ALL_SCOPES)[number];
const READ_ONLY_SCOPES: Scope[] = ['store:read', 'products:read', 'orders:read', 'shipping:read'];

export type KeyRecord = { scopes: Set<Scope>; status: 'active' | 'expired' | 'revoked'; ordersCreated: number };

export type FulfillmentMode = 'instant' | 'manual_approval' | 'delayed_auto_submit';

export type StoreRecord = {
  id: string;
  name: string;
  websiteUrl: string;
  country: string;
  currency: string;
  fulfillmentMode: FulfillmentMode;
  delayHours: number;
  autoRouting: boolean;
  paymentMethodReady: boolean;
  planActive: boolean;
  orderIntakePaused: boolean;
  connected: boolean;
  monthlyNewProductsLimit: number | null;
  monthlyNewProductsUsed: number;
};

/** A provider (and its location) fulfilling some products. Variants of different groups cannot share an order. */
export type ProviderGroup = {
  id: string;
  label: string;
  /** Canonical state names this provider ships to. */
  coveredStates: Set<string>;
  firstItemCents: number;
  additionalItemCents: number;
  deliveryDays: { min: number; max: number };
};

export type Variant = {
  id: string;
  sku: string;
  colorName: string | null;
  size: string | null;
  priceCents: number;
  productionCents: number;
  quantity: number | null;
  syncFailed: boolean;
  updatedAt: Date;
};

export type ProductImage = { position: number; colorName: string | null; swatchHex: string };

export type Product = {
  id: string;
  status: 'published' | 'unpublished';
  title: string;
  descriptionHtml: string;
  tags: string[];
  type: string;
  providerGroupId: string;
  images: ProductImage[];
  variants: Variant[];
  baseDays: number;
  bulkTiers: { minQuantity: number; productionDays: number }[];
  brandingCents: number | null;
  orderFeeCents: number | null;
  listingState: 'sent' | 'confirmed' | 'failed' | 'unconfirmed' | null;
  listingReason: string | null;
  websiteProductId: string | null;
  websiteUrl: string | null;
  updatedAt: Date;
  sequence: number;
};

export type OrderStatus =
  | 'received'
  | 'on_hold'
  | 'awaiting_provider'
  | 'awaiting_payment'
  | 'in_production'
  | 'shipped'
  | 'delivered'
  | 'returned'
  | 'refunded'
  | 'cancelled'
  | 'rejected';

export const HOLD_CODES = [
  'awaiting_approval',
  'delayed_submit',
  'personalization_review',
  'velocity_review',
  'missing_phone',
  'payment_method_missing',
  'payment_failed',
  'payment_expired',
  'payment_review',
  'payment_processing_unavailable',
  'provider_selection_required',
  'processing',
] as const;
export type HoldCode = (typeof HOLD_CODES)[number];

/** The hold an order is in, with the optional finer reason a payment hold carries. */
export type OrderHold = { code: HoldCode; detailCode: string | null };

export const RETURN_STATUSES = ['requested', 'under_review', 'in_transit', 'received', 'rejected', 'cancelled'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export type ReturnInfo = { status: ReturnStatus; actionRequired: boolean };

export type Shipment = {
  id: string;
  method: 'carrier' | 'own_driver';
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
};

export type ShippingAddress = {
  name: string;
  phone: string | null;
  email: string | null;
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  postalCode: string | null;
  country: string;
};

export type OrderLine = {
  variantId: string;
  productId: string;
  quantity: number;
  unitPrice: string;
  externalLineId: string | null;
};

export type Order = {
  id: string;
  externalOrderId: string;
  displayNumber: string | null;
  currency: string;
  status: OrderStatus;
  hold: OrderHold | null;
  returnInfo: ReturnInfo | null;
  items: OrderLine[];
  shipments: Shipment[];
  costs: { productionCents: number | null; shippingCents: number | null; brandingCents: number | null; feeCents: number | null; basis: 'estimated' | 'final' };
  estimatedDelivery: { earliest: string; latest: string } | null;
  createdAt: Date;
  updatedAt: Date;
  statusHistory: { status: OrderStatus; holdReason: string | null; note: string | null; at: Date }[];
  sequence: number;
  requestHash: string;
  address: ShippingAddress;
  customerEmail: string;
  providerGroupId: string;
  /** False while the order waits for merchant approval and has not reached production planning. */
  submitted: boolean;
  charged: boolean;
  cancelRequested: boolean;
};

export const WEBHOOK_EVENT_TYPES = [
  'product.publish_requested',
  'product.updated',
  'product.unpublish_requested',
  'product.deleted',
  'product.cost_changed',
  'inventory.updated',
  'order.status_changed',
  'order.payment_failed',
  'order.payment_expired',
  'order.charged',
  'order.shipped',
  'order.delivered',
  'shipment.exception',
  'order.cancelled',
  'order.cancel_rejected',
  'order.refunded',
  'return.status_changed',
  'connection.disabled',
  'api_key.expiring',
  'ping',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const isWebhookEventType = (value: string): value is WebhookEventType => (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);

export type DeliveryStatus = 'PENDING' | 'IN_FLIGHT' | 'DELIVERED' | 'FAILED' | 'DEAD';

export type Delivery = {
  id: string;
  eventId: string;
  eventType: WebhookEventType;
  /** Resource the event is about (`order:<id>`, `product:<id>`), used to supersede stale product events. */
  resourceKey: string | null;
  createdAt: Date;
  sequence: number | null;
  data: unknown;
  status: DeliveryStatus;
  attempt: number;
  responseCode: number | null;
  lastError: string | null;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
};

export type WebhookEndpoint = {
  url: string | null;
  status: 'active' | 'disabled';
  consecutiveFailures: number;
  pausedUntil: Date | null;
  secret: string;
  previousSecret: string | null;
  previousSecretUntil: Date | null;
};

export const WEBHOOK_FAULT_MODES = ['duplicate', 'out_of_order', 'bad_signature', 'stale_timestamp'] as const;
export type WebhookFaultMode = (typeof WEBHOOK_FAULT_MODES)[number];

export type InjectedFault = { route: string | null; code: ErrorCode; remaining: number };

export type SandboxState = {
  store: StoreRecord;
  keys: Map<string, KeyRecord>;
  providerGroups: Map<string, ProviderGroup>;
  products: Map<string, Product>;
  orders: Map<string, Order>;
  ordersByExternalId: Map<string, string>;
  deliveries: Delivery[];
  endpoint: WebhookEndpoint;
  webhookFault: { mode: WebhookFaultMode; remaining: number; eventType: string | null } | null;
  faults: InjectedFault[];
  rateLimits: { general: number; orders: number; rates: number };
  rateWindows: Map<string, { startedAt: number; used: number }>;
  velocity: { day: string; orders: number; valueCents: number };
  timers: Set<NodeJS.Timeout>;
};

function currencyOf(country: string): string {
  const currencies: Record<string, string> = { AE: 'AED', SA: 'SAR', EG: 'EGP' };
  const currency = currencies[country];
  if (!currency) throw new Error(`SANDBOX_STORE_COUNTRY must be AE, SA or EG, got "${country}"`);
  return currency;
}

export function createState(config: SandboxConfig): SandboxState {
  return {
    store: {
      id: newUuid(),
      name: config.storeName,
      websiteUrl: config.storeWebsiteUrl,
      country: config.storeCountry,
      currency: currencyOf(config.storeCountry),
      fulfillmentMode: 'instant',
      delayHours: 24,
      autoRouting: true,
      paymentMethodReady: true,
      planActive: true,
      orderIntakePaused: false,
      connected: true,
      monthlyNewProductsLimit: 100,
      monthlyNewProductsUsed: 0,
    },
    keys: new Map([
      [config.fullAccessKey, { scopes: new Set(ALL_SCOPES), status: 'active', ordersCreated: 0 }],
      [config.readOnlyKey, { scopes: new Set(READ_ONLY_SCOPES), status: 'active', ordersCreated: 0 }],
    ]),
    providerGroups: new Map(),
    products: new Map(),
    orders: new Map(),
    ordersByExternalId: new Map(),
    deliveries: [],
    endpoint: {
      url: config.webhookUrl,
      status: 'active',
      consecutiveFailures: 0,
      pausedUntil: null,
      secret: config.webhookSecret,
      previousSecret: null,
      previousSecretUntil: null,
    },
    webhookFault: null,
    faults: [],
    rateLimits: { general: 120, orders: 60, rates: 300 },
    rateWindows: new Map(),
    velocity: { day: '', orders: 0, valueCents: 0 },
    timers: new Set(),
  };
}
