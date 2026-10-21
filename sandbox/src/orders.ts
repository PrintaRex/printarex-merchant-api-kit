import { createHash } from 'node:crypto';
import { normalizeCity, resolveCity } from './cities.ts';
import type { Sandbox } from './context.ts';
import { ApiError, notFound, ORDER_INTAKE_PAUSED_MESSAGE, SCHEMA_MISMATCH, validationFailed } from './errors.ts';
import { header, jsonBody, optionalJsonBody, parseJsonObject, type Reply, type RequestContext } from './http.ts';
import { AMOUNT_PATTERN, formatCents, parseCents } from './money.ts';
import { applyStep, type IntakeRoute, receiveOrder, requireAddressEditable } from './order-lifecycle.ts';
import { cursorPage, decodeCursor, pageLimit, parseTimestamp } from './paging.ts';
import { findPublishedVariant, sharedProviderGroupId } from './product-catalogue.ts';
import { arr, CONTROL_CHARACTERS, isPlainObject, isPresent, num, obj, type Present, str } from './shape.ts';
import { shippingCents } from './shipping.ts';
import type { KeyRecord, Order, OrderLine, Product, ProviderGroup, SandboxState, ShippingAddress, Variant } from './state.ts';
import { orderView } from './views.ts';

const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const VELOCITY_LINE_QUANTITY_CAP = 50;
const VELOCITY_DAILY_ORDER_CAP = 50;
/** Daily value caps for new keys, per currency. A currency without a cap holds the order instead. */
const VELOCITY_DAILY_VALUE_CAP_CENTS: Record<string, number> = { AED: 1_000_000 };
const CAPS_LIFT_AFTER_CHARGED_ORDERS = 20;
const DUBAI_UTC_OFFSET_MS = 4 * 3_600_000;
const NAME_MAX_LENGTH = 200;
const ADDRESS_LINE_MAX_LENGTH = 255;
const POSTAL_CODE_MAX_LENGTH = 20;

const addressShape = obj({
  name: str,
  phone: str,
  email: str,
  address1: str,
  address2: str,
  city: str,
  state: str,
  postal_code: str,
  country: str,
});

const orderShape = obj({
  external_order_id: str,
  display_number: str,
  payment_status: str,
  currency: str,
  customer: obj({ email: str }),
  shipping_address: addressShape,
  items: arr(obj({ variant_id: str, quantity: num, unit_price: str, external_line_id: str })),
});

type OrderBody = Present<typeof orderShape>;
type ItemBody = NonNullable<OrderBody['items']>[number];

type ValidatedLine = { variantId: string; quantity: number; unitPrice: string; externalLineId: string | null };
type ValidatedOrder = {
  externalOrderId: string;
  displayNumber: string | null;
  currency: string;
  customerEmail: string;
  address: ShippingAddress;
  lines: ValidatedLine[];
};
/** An order line together with the product and variant it resolved to. */
type ResolvedLine = { line: OrderLine; product: Product; variant: Variant };
type ResolvedLines = { lines: ResolvedLine[]; providerGroupId: string };

// ---- POST /orders ------------------------------------------------------------

export function createOrder(sandbox: Sandbox, ctx: RequestContext, key: KeyRecord): Reply {
  const { state } = sandbox;
  const body = jsonBody(ctx, orderShape);
  const idempotencyKey = header(ctx, 'Idempotency-Key');
  if (idempotencyKey !== undefined && idempotencyKey.length > 255) {
    throw validationFailed('Idempotency-Key is at most 255 characters.', 'Idempotency-Key');
  }
  if (state.store.orderIntakePaused) {
    throw new ApiError('order_intake_paused', ORDER_INTAKE_PAUSED_MESSAGE, { retryAfterSeconds: 60 });
  }
  const request = validateShape(body);
  if (!state.store.connected) throw new ApiError('unauthorized', 'This store cannot take orders.');

  const requestHash = hashRequest(body);
  const replayed = findReplayedOrder(state, request.externalOrderId, requestHash);
  if (replayed) return { status: 200, body: orderView(sandbox.view, replayed) };

  if (!state.store.planActive) throw new ApiError('plan_required', 'New orders need an active Premium plan.');
  if (request.currency !== state.store.currency) {
    throw new ApiError('currency_mismatch', 'currency must equal the store currency.', { field: 'currency' });
  }
  request.address.city = canonicalCity(request.address);
  const resolved = resolveLines(sandbox, request.lines);
  const group = coveringGroup(state, resolved.providerGroupId, request.address);

  const orderValueCents = request.lines.reduce((sum, line) => sum + parseCents(line.unitPrice) * line.quantity, 0);
  const intakeRoute = applyVelocityPolicy(sandbox, key, request, orderValueCents);
  const order = receiveOrder(sandbox, {
    externalOrderId: request.externalOrderId,
    displayNumber: request.displayNumber,
    currency: request.currency,
    items: resolved.lines.map(({ line }) => line),
    costs: estimatedCosts(resolved, group),
    requestHash,
    address: request.address,
    customerEmail: request.customerEmail,
    providerGroupId: group.id,
  }, intakeRoute);
  state.orders.set(order.id, order);
  state.ordersByExternalId.set(order.externalOrderId, order.id);
  key.ordersCreated += 1;
  state.velocity.orders += 1;
  state.velocity.valueCents += orderValueCents;

  return {
    status: 201,
    body: orderView(sandbox.view, order),
    headers: { Location: `/merchant/v1/orders/${order.id}` },
  };
}

/** A repeated external_order_id is a safe retry only when the body is the same and the order is not cancelled. */
function findReplayedOrder(state: SandboxState, externalOrderId: string, requestHash: string): Order | null {
  const existing = state.orders.get(state.ordersByExternalId.get(externalOrderId) ?? '');
  if (!existing) return null;
  if (existing.status === 'cancelled') {
    throw new ApiError('external_id_in_use', 'This external_order_id belongs to a cancelled order.', {
      field: 'external_order_id',
      details: { existing_order_id: existing.id },
    });
  }
  if (existing.requestHash !== requestHash) {
    throw new ApiError('idempotency_key_reuse', 'This external_order_id was already used with a different order body.', { field: 'external_order_id' });
  }
  return existing;
}

function canonicalCity(address: ShippingAddress): string {
  const resolution = resolveCity(address.city, address.country);
  if (resolution.kind === 'unsupported_country') {
    throw new ApiError('billing_not_available', 'Orders to this country are not available yet.', { field: 'shipping_address.country' });
  }
  if (resolution.kind === 'unknown_city') {
    throw new ApiError('address_invalid', 'city is not one of the supported cities. See GET /shipping/coverage.', { field: 'shipping_address.city' });
  }
  return resolution.city;
}

/** The order's provider group, when it ships to the address's state (or, for an unknown state, its city). */
function coveringGroup(state: SandboxState, providerGroupId: string, address: ShippingAddress): ProviderGroup {
  const group = state.providerGroups.get(providerGroupId);
  const zone = normalizeCity(address.state, address.country) ?? address.city;
  if (!group || !group.coveredStates.has(zone)) {
    throw new ApiError('destination_uncovered', 'This destination is not covered by the provider. See GET /shipping/coverage.', {
      field: 'shipping_address.state',
    });
  }
  return group;
}

function estimatedCosts(resolved: ResolvedLines, group: ProviderGroup): Order['costs'] {
  const perLine = (centsOf: (line: ResolvedLine) => number) =>
    resolved.lines.reduce((sum, resolvedLine) => sum + centsOf(resolvedLine) * resolvedLine.line.quantity, 0);
  const totalQuantity = resolved.lines.reduce((sum, { line }) => sum + line.quantity, 0);
  return {
    productionCents: perLine(({ variant }) => variant.productionCents),
    shippingCents: shippingCents(group, totalQuantity),
    brandingCents: perLine(({ product }) => product.brandingCents ?? 0),
    feeCents: resolved.lines[0]?.product.orderFeeCents ?? null,
    basis: 'estimated',
  };
}

/** The checks run in the order production reports them: the first problem found is the one returned. */
function validateShape(body: OrderBody): ValidatedOrder {
  const externalOrderId = validateExternalOrderId(body.external_order_id);
  requirePaidStatus(body.payment_status);
  const currency = validateCurrency(body.currency);
  const displayNumber = validateDisplayNumber(body.display_number);
  const customerEmail = validateCustomerEmail(body.customer?.email);
  const lines = validateLines(body.items ?? []);
  return { externalOrderId, displayNumber, currency, customerEmail, address: validateAddress(body.shipping_address ?? {}), lines };
}

function validateExternalOrderId(externalOrderId: string | null | undefined): string {
  if (!externalOrderId || externalOrderId.length > 50 || CONTROL_CHARACTERS.test(externalOrderId)) {
    throw validationFailed('external_order_id is required, at most 50 characters, without control characters.', 'external_order_id');
  }
  return externalOrderId;
}

function requirePaidStatus(paymentStatus: string | null | undefined): void {
  if (!isPresent(paymentStatus)) throw validationFailed('payment_status is required.', 'payment_status');
  if (paymentStatus !== 'paid') throw new ApiError('payment_status_unsupported', 'Only paid orders are accepted.', { field: 'payment_status' });
}

function validateCurrency(currency: string | null | undefined): string {
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw validationFailed('currency must be an ISO 4217 code.', 'currency');
  return currency;
}

function validateDisplayNumber(displayNumber: string | null | undefined): string | null {
  if (!displayNumber?.trim()) return null;
  if (displayNumber.length > 50) throw validationFailed('display_number must be at most 50 characters.', 'display_number');
  return displayNumber;
}

function validateCustomerEmail(email: string | null | undefined): string {
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw validationFailed('customer.email must be a valid email address.', 'customer.email');
  }
  return email;
}

function validateLines(items: readonly ItemBody[]): ValidatedLine[] {
  if (items.length === 0) throw validationFailed('items must contain at least one item.', 'items');
  if (items.length > 100) throw new ApiError('too_many_items', 'items can contain at most 100 items.', { field: 'items' });
  const lineIds = new Set<string>();
  return items.map((item, index) => validateLine(item, index, lineIds));
}

/** `lineIds` collects the `external_line_id` values seen so far, so a repeat is refused. */
function validateLine(item: ItemBody, index: number, lineIds: Set<string>): ValidatedLine {
  const field = (name: string) => `items[${index}].${name}`;
  const variantId = item?.variant_id;
  if (!variantId || variantId.length > 100) throw validationFailed('variant_id is required.', field('variant_id'));
  const quantity = item?.quantity;
  if (!isPresent(quantity) || !Number.isInteger(quantity) || quantity < 1 || quantity > 2_147_483_647) {
    throw validationFailed('quantity must be a whole number of at least 1.', field('quantity'));
  }
  const unitPrice = item?.unit_price;
  if (!unitPrice || !AMOUNT_PATTERN.test(unitPrice) || parseCents(unitPrice) === 0) {
    throw validationFailed('unit_price must be a decimal string greater than 0, for example "49.00".', field('unit_price'));
  }
  const externalLineId = item?.external_line_id ?? null;
  if (externalLineId !== null) {
    if (externalLineId.length > 100) throw validationFailed('external_line_id must be at most 100 characters.', field('external_line_id'));
    if (lineIds.has(externalLineId)) throw validationFailed('external_line_id must be unique within the order.', field('external_line_id'));
    lineIds.add(externalLineId);
  }
  return { variantId, quantity, unitPrice, externalLineId };
}

// ---- Address rules shared by order creation and address edits ------------------

const isUsableName = (value: string): boolean => value.trim() !== '' && value.length <= NAME_MAX_LENGTH;
const isUsableAddressLine = (value: string): boolean =>
  value.trim() !== '' && value.length <= ADDRESS_LINE_MAX_LENGTH && !CONTROL_CHARACTERS.test(value);

function requireShortAddress2(address2: string | null | undefined, field: string): void {
  if (address2 && address2.length > ADDRESS_LINE_MAX_LENGTH) throw new ApiError('address_invalid', 'address2 must be at most 255 characters.', { field });
}

function requireShortPostalCode(postalCode: string | null | undefined, field: string): void {
  if (postalCode && postalCode.length > POSTAL_CODE_MAX_LENGTH) throw validationFailed('postal_code must be at most 20 characters.', field);
}

function requireE164Phone(phone: string | null, field: string): void {
  if (phone === null || !PHONE_PATTERN.test(phone)) throw new ApiError('phone_invalid', 'phone must be in E.164 format, for example +971501234567.', { field });
}

function validateAddress(address: Present<typeof addressShape>): ShippingAddress {
  const text = (name: keyof typeof address): string | null => address[name] ?? null;
  const name = text('name');
  if (name === null || !isUsableName(name)) throw validationFailed('name is required, at most 200 characters.', 'shipping_address.name');
  for (const field of ['address1', 'city', 'state'] as const) {
    const value = text(field);
    if (value === null || !isUsableAddressLine(value)) {
      throw new ApiError('address_invalid', `${field} is required, at most 255 characters.`, { field: `shipping_address.${field}` });
    }
  }
  const address2 = text('address2');
  requireShortAddress2(address2, 'shipping_address.address2');
  const postalCode = text('postal_code');
  requireShortPostalCode(postalCode, 'shipping_address.postal_code');
  const country = text('country');
  if (!country || !country.trim()) throw new ApiError('address_invalid', 'country is required.', { field: 'shipping_address.country' });
  if (!/^[A-Z]{2}$/.test(country)) throw validationFailed('country must be an ISO 3166-1 alpha-2 code.', 'shipping_address.country');
  const phone = text('phone');
  if (phone !== null) requireE164Phone(phone, 'shipping_address.phone');
  return {
    name,
    phone,
    email: text('email'),
    address1: text('address1') ?? '',
    address2,
    city: text('city') ?? '',
    state: text('state') ?? '',
    postalCode,
    country,
  };
}

function resolveLines(sandbox: Sandbox, lines: ValidatedLine[]): ResolvedLines {
  const resolved = lines.map((line, index): ResolvedLine => {
    const field = `items[${index}].variant_id`;
    const { product, variant } = findPublishedVariant(sandbox.state, line.variantId, field);
    if (product.listingState === 'failed') throw new ApiError('variant_unknown', 'This variant is not listed on your website.', { field });
    const orderLine: OrderLine = {
      variantId: line.variantId,
      productId: product.id,
      quantity: line.quantity,
      unitPrice: formatCents(parseCents(line.unitPrice)),
      externalLineId: line.externalLineId,
    };
    return { line: orderLine, product, variant };
  });
  const providerGroupId = sharedProviderGroupId(resolved.map(({ product }) => product));
  if (providerGroupId === null) {
    throw new ApiError('multi_provider_cart', 'All items in one order must be fulfilled by the same provider.', { field: 'items' });
  }
  const requestedByVariant = new Map<string, number>();
  for (const { line } of resolved) requestedByVariant.set(line.variantId, (requestedByVariant.get(line.variantId) ?? 0) + line.quantity);
  resolved.forEach(({ variant }, index) => {
    if (variant.quantity === null || variant.quantity < (requestedByVariant.get(variant.id) ?? 0)) {
      throw new ApiError('variant_out_of_stock', 'This variant does not have enough stock.', { field: `items[${index}].variant_id` });
    }
  });
  return { lines: resolved, providerGroupId };
}

/** New-key limits: the first orders are held for review, and daily caps apply until enough orders were charged. */
function applyVelocityPolicy(sandbox: Sandbox, key: KeyRecord, request: ValidatedOrder, orderValueCents: number): IntakeRoute {
  const { state } = sandbox;
  const today = dubaiDate(new Date());
  if (state.velocity.day !== today) state.velocity = { day: today, orders: 0, valueCents: 0 };
  const chargedOrders = [...state.orders.values()].filter((order) => order.charged).length;
  const capsApply = chargedOrders < CAPS_LIFT_AFTER_CHARGED_ORDERS;
  const capped = (field: string | null) =>
    new ApiError('velocity_cap', 'Order limits for new API keys were reached. Try again after the Retry-After delay.', {
      field,
      retryAfterSeconds: secondsToDubaiMidnight(new Date()),
    });
  const valueCap = VELOCITY_DAILY_VALUE_CAP_CENTS[state.store.currency];
  if (capsApply) {
    if (request.lines.some((line) => line.quantity > VELOCITY_LINE_QUANTITY_CAP)) throw capped('items');
    if (state.velocity.orders + 1 > VELOCITY_DAILY_ORDER_CAP) throw capped(null);
    if (valueCap !== undefined && state.velocity.valueCents + orderValueCents > valueCap) throw capped(null);
  }
  return key.ordersCreated + 1 <= sandbox.config.heldFirstOrders || valueCap === undefined ? 'review_hold' : 'store_fulfillment_mode';
}

function dubaiDate(at: Date): string {
  return new Date(at.getTime() + DUBAI_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

function secondsToDubaiMidnight(at: Date): number {
  const dubaiNow = at.getTime() + DUBAI_UTC_OFFSET_MS;
  const nextMidnight = Math.floor(dubaiNow / 86_400_000 + 1) * 86_400_000;
  return Math.max(1, Math.ceil((nextMidnight - dubaiNow) / 1000));
}

/** SHA-256 of canonical JSON: sorted keys, nulls dropped, numbers and amounts without trailing zeros. Takes the body exactly as sent (the typed body is that same object). */
function hashRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
}

function canonical(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== null && child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([childKey, child]) => [childKey, canonical(child, childKey)]);
    return Object.fromEntries(entries);
  }
  if (key === 'unit_price' && typeof value === 'string' && AMOUNT_PATTERN.test(value)) return String(parseCents(value) / 100);
  return value;
}

// ---- Other order routes ------------------------------------------------------

export function findOrder(sandbox: Sandbox, orderId: string | undefined): Order {
  const order = orderId ? sandbox.state.orders.get(orderId) : undefined;
  if (!order) throw notFound('Order not found.');
  return order;
}

export function getOrder(sandbox: Sandbox, ctx: RequestContext): Reply {
  return { status: 200, body: orderView(sandbox.view, findOrder(sandbox, ctx.params.order_id)) };
}

export function listOrders(sandbox: Sandbox, ctx: RequestContext): Reply {
  const externalId = ctx.query.get('external_id');
  const updatedSinceRaw = ctx.query.get('updated_since');
  if ((externalId === null) === (updatedSinceRaw === null)) throw validationFailed('Send exactly one of external_id and updated_since.');
  if (externalId !== null) {
    const order = sandbox.state.orders.get(sandbox.state.ordersByExternalId.get(externalId) ?? '');
    return { status: 200, body: { data: order ? [orderView(sandbox.view, order)] : [], next_cursor: null } };
  }
  const limit = pageLimit(ctx.query);
  const updatedSince = parseTimestamp(updatedSinceRaw ?? '', 'updated_since');
  const cursor = decodeCursor(ctx.query.get('cursor'));
  const rows = [...sandbox.state.orders.values()]
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id))
    .filter((order) =>
      cursor
        ? order.updatedAt > cursor.at || (order.updatedAt.getTime() === cursor.at.getTime() && order.id > cursor.id)
        : order.updatedAt >= updatedSince,
    );
  const { page, nextCursor } = cursorPage(rows, limit, (order) => order.updatedAt);
  return { status: 200, body: { data: page.map((order) => orderView(sandbox.view, order)), next_cursor: nextCursor } };
}

export function cancelOrder(sandbox: Sandbox, ctx: RequestContext): Reply {
  const order = findOrder(sandbox, ctx.params.order_id);
  const body = optionalJsonBody(ctx, obj({ reason: str }));
  if ((body?.reason?.length ?? 0) > 500) throw validationFailed('reason must be at most 500 characters.', 'reason');
  applyStep(sandbox, order, { name: 'request_cancellation' });
  return { status: 202, body: { order_id: ctx.params.order_id, cancellation_status: 'requested' } };
}

const PATCHABLE = new Set(['name', 'phone', 'address1', 'address2', 'postal_code']);
const REPRICE_FIELDS = new Set(['city', 'state', 'country']);

type AddressPatch = { name?: string | null; address1?: string | null; address2?: string | null; postalCode?: string | null; phone?: string | null };

export function updateShippingAddress(sandbox: Sandbox, ctx: RequestContext): Reply {
  const order = findOrder(sandbox, ctx.params.order_id);
  const patch = parseJsonObject(ctx);
  if (!patch || Object.keys(patch).length === 0) throw validationFailed('Send at least one address field to change.');
  for (const field of Object.keys(patch)) {
    if (!PATCHABLE.has(field) && !REPRICE_FIELDS.has(field)) throw validationFailed(`${field} cannot be changed or is not a known field.`, field);
  }
  rejectDestinationChange(order, patch);
  requireAddressEditable(order);
  const { name, address1, address2, postalCode, phone } = validateAddressPatch(patch);
  if (name) order.address.name = name;
  if (address1) order.address.address1 = address1;
  if (address2 !== undefined) order.address.address2 = address2;
  if (postalCode !== undefined) order.address.postalCode = postalCode;
  if (phone) {
    order.address.phone = phone;
    if (order.hold?.code === 'missing_phone') {
      // Production releases the hold downstream; the new status arrives by webhook.
      sandbox.later(() => order.hold?.code === 'missing_phone' && applyStep(sandbox, order, { name: 'release' }), sandbox.config.asyncStepMs);
    }
  }
  return { status: 200, body: orderView(sandbox.view, order) };
}

/** The order was priced for its destination, so city, state and country may only be repeated, not changed. */
function rejectDestinationChange(order: Order, patch: Record<string, unknown>): void {
  const same = (a: unknown, b: string) => typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
  const cityUnchanged = patch.city === undefined || normalizeCity(String(patch.city), order.address.country) === order.address.city;
  const stateUnchanged = patch.state === undefined || same(patch.state, order.address.state);
  const countryUnchanged = patch.country === undefined || same(patch.country, order.address.country);
  if (!cityUnchanged || !stateUnchanged || !countryUnchanged) {
    throw new ApiError('address_change_requires_reprice', 'city, state and country cannot change: the order was priced for the original destination.');
  }
}

/** Absent fields stay undefined (unchanged); null clears an optional field. */
function validateAddressPatch(patch: Record<string, unknown>): AddressPatch {
  const text = (field: string): string | null | undefined => {
    const value = patch[field];
    if (value === undefined || value === null) return value as null | undefined;
    if (typeof value !== 'string') throw validationFailed(SCHEMA_MISMATCH, field);
    return value;
  };
  const name = text('name');
  if (name !== undefined && (name === null || !isUsableName(name))) throw validationFailed('name must be 1 to 200 characters.', 'name');
  const address1 = text('address1');
  if (address1 !== undefined && (address1 === null || !isUsableAddressLine(address1))) {
    throw new ApiError('address_invalid', 'address1 must be 1 to 255 characters.', { field: 'address1' });
  }
  const address2 = text('address2');
  requireShortAddress2(address2, 'address2');
  const postalCode = text('postal_code');
  requireShortPostalCode(postalCode, 'postal_code');
  const phone = text('phone');
  if (phone !== undefined) requireE164Phone(phone, 'phone');
  return { name, address1, address2, postalCode, phone };
}
