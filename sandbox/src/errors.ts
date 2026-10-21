const STATUS_BY_CODE = {
  variant_unknown: 422,
  multi_provider_cart: 422,
  currency_mismatch: 422,
  destination_uncovered: 422,
  billing_not_available: 422,
  payment_status_unsupported: 422,
  variant_out_of_stock: 422,
  phone_invalid: 422,
  address_invalid: 422,
  too_many_items: 422,
  validation_failed: 422,
  variant_retired: 410,
  external_id_in_use: 409,
  idempotency_key_reuse: 409,
  address_locked: 409,
  address_change_requires_reprice: 409,
  cancel_window_closed: 409,
  payment_in_progress: 409,
  plan_required: 402,
  rate_limited: 429,
  velocity_cap: 429,
  unauthorized: 401,
  key_expired: 401,
  forbidden_scope: 403,
  ip_not_allowed: 403,
  not_found: 404,
  entitlement_unavailable: 503,
  order_intake_paused: 503,
  internal_error: 500,
  payload_too_large: 413,
} as const;

export type ErrorCode = keyof typeof STATUS_BY_CODE;

export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && Object.hasOwn(STATUS_BY_CODE, value);

export const statusOf = (code: ErrorCode): number => STATUS_BY_CODE[code];

export const SCHEMA_MISMATCH = 'The request body does not match the schema.';
export const ORDER_INTAKE_PAUSED_MESSAGE = 'Order intake is paused. Retry after the Retry-After delay.';
export const INVALID_JSON = 'The request body is missing or is not valid JSON.';
export const INTERNAL_ERROR_MESSAGE = 'Something went wrong. Quote the request id to support.';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly field: string | null;
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  readonly details: Record<string, unknown> | null;
  readonly headers: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      field?: string | null;
      status?: number;
      retryAfterSeconds?: number;
      details?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.code = code;
    this.field = options.field ?? null;
    this.status = options.status ?? statusOf(code);
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.details = options.details ?? null;
    this.headers = options.headers ?? {};
  }
}

export const validationFailed = (message: string, field: string | null = null): ApiError =>
  new ApiError('validation_failed', message, { field });

export const notFound = (message: string): ApiError => new ApiError('not_found', message);
