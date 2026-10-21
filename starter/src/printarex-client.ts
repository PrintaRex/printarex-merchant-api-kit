/**
 * A small client for the PrintaRex Merchant API.
 *
 * - The key goes in the Authorization header only, never in a URL.
 * - Errors come back as {code, message, field, request_id}. Branch on `code`, never on `message`,
 *   and log `request_id` so PrintaRex support can find the request.
 * - Unknown enum values (statuses, hold reasons, event types) must be tolerated.
 */
export type ApiImage = { src: string; position: number };
export type ApiVariant = {
  id: string;
  color: { name: string } | null;
  size: string | null;
  price: string;
  currency: string;
  available: boolean;
  provider_group_id: string;
};
export type ApiProduct = {
  id: string;
  status: string;
  title: string;
  /** Not sanitised by PrintaRex: run it through your platform's HTML sanitiser before showing it. */
  description_html: string;
  images: ApiImage[];
  variants: ApiVariant[];
  cost: { production: string | null };
  listing_state: string | null;
};
export type ApiHoldReason = { code: string; detail_code: string | null; action_required: boolean; action_url: string | null };
export type ApiShipment = {
  method: string;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  delivered_at: string | null;
};
export type ApiOrder = {
  id: string;
  external_order_id: string;
  status: string;
  hold_reason: ApiHoldReason | null;
  shipments: ApiShipment[];
  sequence: number;
};
export type ApiStore = { country: string; currency: string };
export type ApiInventory = { variant_id: string; available: boolean };
export type Page<T> = { data: T[]; next_cursor: string | null };
export type ShippingQuote = { methods: { amount: string; currency: string; delivery_days: { min: number; max: number } }[] };
export type Coverage = { countries: { states: { name: string }[] }[] };
export type ShippingAddress = {
  name: string;
  phone?: string;
  address1: string;
  city: string;
  state: string;
  country: string;
};
export type ShippingRatesRequest = {
  destination: { country: string; state: string; city: string };
  items: { variant_id: string; quantity: number }[];
};
export type OrderCreateRequest = {
  external_order_id: string;
  display_number: string;
  payment_status: 'paid';
  currency: string;
  customer: { email: string };
  shipping_address: ShippingAddress;
  items: { variant_id: string; quantity: number; unit_price: string }[];
};
type ErrorBody = { code?: string; message?: string; field?: string | null; request_id?: string; details?: Record<string, unknown> } | null;

export class PrintarexApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | null;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly details: Record<string, unknown> | null;

  constructor(status: number, body: ErrorBody, retryAfter: string | null) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.code ?? 'unknown_error';
    this.field = body?.field ?? null;
    this.requestId = body?.request_id ?? null;
    this.retryAfterSeconds = retryAfter ? Number(retryAfter) : null;
    this.details = body?.details ?? null;
  }

  /** Worth retrying later with the same request: rate limits, temporary outages, server errors. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class PrintarexClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) throw new PrintarexApiError(response.status, parsed as ErrorBody, response.headers.get('Retry-After'));
    return { status: response.status, data: parsed as T };
  }

  getStore = () => this.request<ApiStore>('GET', '/store');
  getProduct = (productId: string) => this.request<ApiProduct>('GET', `/products/${encodeURIComponent(productId)}`);
  listProducts = (cursor?: string) => this.request<Page<ApiProduct>>('GET', `/products?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  confirmProduct = (productId: string, websiteProductId: string, websiteUrl: string) =>
    this.request<ApiProduct>('POST', `/products/${encodeURIComponent(productId)}/confirmation`, { website_product_id: websiteProductId, website_url: websiteUrl });
  reportPublishFailure = (productId: string, message: string) => this.request<ApiProduct>('POST', `/products/${encodeURIComponent(productId)}/publish-failure`, { message });
  reportRemoved = (productId: string) => this.request<ApiProduct>('POST', `/products/${encodeURIComponent(productId)}/removed`, { reason: 'Removed from the website' });
  shippingRates = (body: ShippingRatesRequest) => this.request<ShippingQuote>('POST', '/shipping/rates', body);
  coverage = (country: string) => this.request<Coverage>('GET', `/shipping/coverage?country=${encodeURIComponent(country)}`);
  createOrder = (body: OrderCreateRequest) => this.request<ApiOrder>('POST', '/orders', body);
  getOrder = (orderId: string) => this.request<ApiOrder>('GET', `/orders/${encodeURIComponent(orderId)}`);
  ordersUpdatedSince = (since: string, cursor?: string) =>
    this.request<Page<ApiOrder>>('GET', `/orders?updated_since=${encodeURIComponent(since)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  cancelOrder = (orderId: string) => this.request<unknown>('POST', `/orders/${encodeURIComponent(orderId)}/cancel`, { reason: 'Requested by the buyer' });
  updateShippingAddress = (orderId: string, patch: Partial<ShippingAddress>) => this.request<ApiOrder>('PATCH', `/orders/${encodeURIComponent(orderId)}/shipping-address`, patch);
}
