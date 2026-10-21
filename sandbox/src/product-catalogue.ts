/**
 * The Product catalogue: every operation that changes what a product shows the website.
 *
 * Invariant kept here and nowhere else: one operation moves `sequence` and `updated_at` exactly once
 * and sends the webhook event(s) that describe the change. Callers (HTTP routes, scenario controls)
 * never write to a product or variant themselves.
 */
import { buildProduct, type TemplateName } from './catalog.ts';
import type { Sandbox } from './context.ts';
import { ApiError, notFound, validationFailed } from './errors.ts';
import type { Product, SandboxState, Variant, WebhookEventType } from './state.ts';
import { inventoryView, productView } from './views.ts';
import { emit } from './webhook-outbox.ts';

export type CostChange = { kind: 'set'; productionCents: number } | { kind: 'raise_ten_percent' };

/** `variantId: null` targets every variant of the product. */
export type StockChange = { quantity: number | null; variantId: string | null; syncFailed: boolean };

export type ListingConfirmation = { websiteProductId: string; websiteUrl: string };

export function findProduct(sandbox: Sandbox, productId: string | undefined): Product {
  const product = productId ? sandbox.state.products.get(productId) : undefined;
  if (!product) throw notFound('Product not found.');
  return product;
}

/** Finds a variant in any product of the store. */
export function findVariant(state: SandboxState, variantId: string): { product: Product; variant: Variant } | null {
  for (const product of state.products.values()) {
    const variant = product.variants.find((candidate) => candidate.id === variantId);
    if (variant) return { product, variant };
  }
  return null;
}

/** A variant a buyer can still order from: it exists and its product is published. `field` is the request path named in the error. */
export function findPublishedVariant(state: SandboxState, variantId: string, field: string): { product: Product; variant: Variant } {
  const match = findVariant(state, variantId);
  if (!match) throw new ApiError('variant_unknown', 'This variant does not exist in this store.', { field });
  if (match.product.status !== 'published') throw new ApiError('variant_retired', 'This variant is no longer published.', { field });
  return match;
}

/** The provider group fulfilling every product, or null when they span several groups. */
export function sharedProviderGroupId(products: readonly Product[]): string | null {
  const groupIds = new Set(products.map((product) => product.providerGroupId));
  const [onlyGroupId] = groupIds;
  return groupIds.size === 1 && onlyGroupId !== undefined ? onlyGroupId : null;
}

function touchProduct(product: Product): void {
  product.sequence += 1;
  product.updatedAt = new Date();
}

function emitProductEvent(sandbox: Sandbox, product: Product, type: WebhookEventType, extra: Record<string, unknown> = {}): void {
  touchProduct(product);
  emit(sandbox, type, `product:${product.id}`, product.sequence, { product: productView(sandbox.view, product), ...extra });
}

/**
 * The studio publish flow: `product.publish_requested` with the primary image only, then the full
 * gallery in `product.updated{changed:[images]}`. The listing waits for the website's answer.
 */
export function publishProduct(sandbox: Sandbox, template: TemplateName): Product {
  const product = buildProduct(sandbox.state, template, new Date());
  sandbox.state.products.set(product.id, product);
  sandbox.state.store.monthlyNewProductsUsed += 1;
  announcePublish(sandbox, product);
  return product;
}

export function republishProduct(sandbox: Sandbox, product: Product): void {
  if (product.status === 'published') throw validationFailed('The product is already published.', 'product_id');
  announcePublish(sandbox, product);
}

function announcePublish(sandbox: Sandbox, product: Product): void {
  product.status = 'published';
  product.listingState = 'sent';
  product.listingReason = null;
  touchProduct(product);
  emit(sandbox, 'product.publish_requested', `product:${product.id}`, product.sequence, {
    product: productView(sandbox.view, product, { primaryImageOnly: true }),
  });
  if (product.images.length > 1) {
    sandbox.later(() => {
      if (sandbox.state.products.get(product.id) === product && product.status === 'published') {
        emitProductEvent(sandbox, product, 'product.updated', { changed: ['images'] });
      }
    }, sandbox.config.asyncStepMs);
  }
}

export function unpublishProduct(sandbox: Sandbox, product: Product): void {
  product.status = 'unpublished';
  emitProductEvent(sandbox, product, 'product.unpublish_requested');
}

export function deleteProduct(sandbox: Sandbox, product: Product): void {
  sandbox.state.products.delete(product.id);
  touchProduct(product);
  emit(sandbox, 'product.deleted', `product:${product.id}`, product.sequence, { product_id: product.id, website_product_id: product.websiteProductId });
}

/** `title: null` keeps the current title. */
export function updateProductDetails(sandbox: Sandbox, product: Product, update: { title: string | null; changed: string[] }): void {
  if (update.title !== null) product.title = update.title;
  emitProductEvent(sandbox, product, 'product.updated', { changed: update.changed });
}

export function changeProductionCost(sandbox: Sandbox, product: Product, change: CostChange): void {
  for (const variant of product.variants) {
    variant.productionCents = change.kind === 'set' ? change.productionCents : Math.round(variant.productionCents * 1.1);
  }
  emitProductEvent(sandbox, product, 'product.cost_changed');
}

export function setStock(sandbox: Sandbox, product: Product, change: StockChange): void {
  const targets = change.variantId === null ? product.variants : product.variants.filter((variant) => variant.id === change.variantId);
  if (targets.length === 0) throw validationFailed('variant_id is not a variant of this product.', 'variant_id');
  const now = new Date();
  for (const variant of targets) {
    variant.quantity = change.quantity;
    variant.syncFailed = change.syncFailed;
    variant.updatedAt = now;
  }
  touchProduct(product);
  emit(sandbox, 'inventory.updated', `product:${product.id}`, product.sequence, {
    product_id: product.id,
    variants: product.variants.map((variant) => inventoryView(product, variant)),
  });
}

export function expireListing(product: Product): void {
  if (product.listingState !== 'sent') throw validationFailed('Only a listing in state sent can become unconfirmed.', 'listing_state');
  product.listingState = 'unconfirmed';
  touchProduct(product);
}

export function confirmListing(product: Product, confirmation: ListingConfirmation): void {
  if (product.status !== 'published') throw validationFailed('The product is not published.', 'product_id');
  product.listingState = 'confirmed';
  product.listingReason = null;
  product.websiteProductId = confirmation.websiteProductId;
  product.websiteUrl = confirmation.websiteUrl;
  touchProduct(product);
}

export function failListing(sandbox: Sandbox, product: Product, reason: string): void {
  if (product.listingState !== 'failed') {
    // A failed listing gives back the month's publish allowance.
    sandbox.state.store.monthlyNewProductsUsed = Math.max(0, sandbox.state.store.monthlyNewProductsUsed - 1);
  }
  product.listingState = 'failed';
  product.listingReason = reason;
  touchProduct(product);
}

/** The website took the product down on its own; nothing is sent back to it. */
export function reportRemoved(product: Product): void {
  if (product.status !== 'published') return;
  product.status = 'unpublished';
  touchProduct(product);
}
