import { signedImageUrl } from './images.ts';
import { formatCents, formatNullableCents } from './money.ts';
import type { Delivery, HoldCode, Order, Product, SandboxState, Variant } from './state.ts';

export type ViewContext = { state: SandboxState; publicBaseUrl: string; portalBaseUrl: string; imageTtlSeconds: number };

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** Whether the merchant or the website has to act, per hold reason (production values). */
const ACTION_REQUIRED: Record<HoldCode, boolean> = {
  awaiting_approval: true,
  delayed_submit: true,
  personalization_review: true,
  velocity_review: true,
  missing_phone: true,
  payment_method_missing: true,
  payment_failed: true,
  payment_expired: true,
  payment_review: false,
  payment_processing_unavailable: false,
  provider_selection_required: true,
  processing: false,
};

export const isVariantAvailable = (product: Product, variant: Variant): boolean =>
  product.status === 'published' && (variant.quantity === null ? !variant.syncFailed : variant.quantity > 0);

const sortVariants = (variants: Variant[]): Variant[] =>
  [...variants].sort(
    (a, b) =>
      (a.colorName ?? '').toLowerCase().localeCompare((b.colorName ?? '').toLowerCase()) ||
      (a.size ?? '').localeCompare(b.size ?? '') ||
      a.id.localeCompare(b.id),
  );

export function productView(ctx: ViewContext, product: Product, options: { primaryImageOnly?: boolean } = {}) {
  const { state } = ctx;
  const currency = state.store.currency;
  const group = state.providerGroups.get(product.providerGroupId);
  const expiresAt = new Date(Date.now() + ctx.imageTtlSeconds * 1000);
  const images = options.primaryImageOnly ? product.images.slice(0, 1) : product.images;
  return {
    id: product.id,
    status: product.status,
    title: product.title,
    description_html: product.descriptionHtml,
    tags: product.tags,
    type: product.type,
    images: images.map((image) => ({
      src: signedImageUrl(ctx.publicBaseUrl, product.id, image.position, expiresAt),
      src_expires_at: expiresAt.toISOString(),
      position: image.position,
      variant_ids: image.colorName
        ? product.variants.filter((variant) => variant.colorName?.toLowerCase() === image.colorName?.toLowerCase()).map((variant) => variant.id)
        : [],
      is_default: image.position === 1,
      alt: null,
    })),
    variants: sortVariants(product.variants).map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      color: variant.colorName ? { name: variant.colorName, hex: null } : null,
      size: variant.size,
      price: formatCents(variant.priceCents),
      currency,
      provider_group_id: product.providerGroupId,
      weight_grams: null,
      available: isVariantAvailable(product, variant),
    })),
    production_time: {
      base_days: product.baseDays,
      bulk_tiers: product.bulkTiers.map((tier) => ({ min_quantity: tier.minQuantity, production_days: tier.productionDays })),
    },
    cost: {
      production: formatCents(Math.min(...product.variants.map((variant) => variant.productionCents))),
      shipping_from: group ? formatCents(group.firstItemCents) : null,
      branding: formatNullableCents(product.brandingCents),
      order_fee: formatNullableCents(product.orderFeeCents),
      currency,
    },
    listing_state: product.listingState,
    listing_reason: product.listingReason,
    website_product_id: product.websiteProductId,
    website_url: product.websiteUrl,
    updated_at: product.updatedAt.toISOString(),
    sequence: product.sequence,
  };
}

export function inventoryView(product: Product, variant: Variant) {
  return {
    variant_id: variant.id,
    product_id: product.id,
    available: isVariantAvailable(product, variant),
    quantity: variant.quantity,
    updated_at: variant.updatedAt.toISOString(),
  };
}

export function orderView(ctx: ViewContext, order: Order) {
  const currency = order.currency;
  const hold = order.hold;
  const actionRequired = hold ? ACTION_REQUIRED[hold.code] : false;
  return {
    id: order.id,
    external_order_id: order.externalOrderId,
    display_number: order.displayNumber,
    payment_status: 'paid',
    currency,
    status: order.status,
    hold_reason: hold
      ? {
          code: hold.code,
          detail_code: hold.detailCode,
          action_required: actionRequired,
          action_url: actionRequired ? `${ctx.portalBaseUrl}/_sandbox/portal/orders/${order.id}` : null,
        }
      : null,
    return: order.returnInfo ? { status: order.returnInfo.status, action_required: order.returnInfo.actionRequired } : null,
    items: order.items.map((line) => ({
      variant_id: line.variantId,
      product_id: line.productId,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      external_line_id: line.externalLineId,
    })),
    shipments: order.shipments.map((shipment) => ({
      id: shipment.id,
      method: shipment.method,
      carrier: shipment.carrier,
      tracking_number: shipment.trackingNumber,
      tracking_url: shipment.trackingUrl,
      shipped_at: iso(shipment.shippedAt),
      delivered_at: iso(shipment.deliveredAt),
    })),
    costs: {
      production: formatNullableCents(order.costs.productionCents),
      shipping: formatNullableCents(order.costs.shippingCents),
      branding: formatNullableCents(order.costs.brandingCents),
      fee: formatNullableCents(order.costs.feeCents),
      currency,
      basis: order.costs.basis,
    },
    estimated_delivery: order.estimatedDelivery,
    created_at: order.createdAt.toISOString(),
    updated_at: order.updatedAt.toISOString(),
    status_history: order.statusHistory.map((entry) => ({
      status: entry.status,
      hold_reason: entry.holdReason,
      note: entry.note,
      at: entry.at.toISOString(),
    })),
    sequence: order.sequence,
  };
}

const PUBLIC_DELIVERY_STATUS = {
  PENDING: 'pending',
  IN_FLIGHT: 'pending',
  DELIVERED: 'succeeded',
  FAILED: 'failed',
  DEAD: 'dead',
} as const;

export const publicDeliveryStatus = (delivery: Delivery): string => PUBLIC_DELIVERY_STATUS[delivery.status];

export function deliveryView(delivery: Delivery) {
  const status = publicDeliveryStatus(delivery);
  return {
    id: delivery.id,
    event_id: delivery.eventId,
    event_type: delivery.eventType,
    status,
    attempt: delivery.attempt,
    response_code: delivery.responseCode,
    created_at: delivery.createdAt.toISOString(),
    last_attempt_at: iso(delivery.lastAttemptAt),
    next_attempt_at: status === 'pending' || status === 'failed' ? iso(delivery.nextAttemptAt) : null,
  };
}
