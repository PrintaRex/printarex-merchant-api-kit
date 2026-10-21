import type { Sandbox } from './context.ts';
import { ApiError, validationFailed } from './errors.ts';
import { jsonBody, optionalJsonBody, type Reply, type RequestContext } from './http.ts';
import { cursorPage, decodeCursor, pageLimit, parseTimestamp } from './paging.ts';
import { CONTROL_CHARACTERS, obj, str } from './shape.ts';
import { confirmListing, failListing, findProduct, findVariant, reportRemoved } from './product-catalogue.ts';
import { inventoryView, productView } from './views.ts';

const LISTING_STATES = new Set(['sent', 'confirmed', 'failed', 'unconfirmed']);

// ---- Merchant API routes ---------------------------------------------------

export function listProducts(sandbox: Sandbox, ctx: RequestContext): Reply {
  const limit = pageLimit(ctx.query);
  const listingState = ctx.query.get('listing_state');
  if (listingState !== null && !LISTING_STATES.has(listingState)) {
    throw validationFailed('listing_state must be one of sent, confirmed, failed, unconfirmed.', 'listing_state');
  }
  const updatedSinceRaw = ctx.query.get('updated_since');
  const updatedSince = updatedSinceRaw === null ? null : parseTimestamp(updatedSinceRaw, 'updated_since');
  const cursor = decodeCursor(ctx.query.get('cursor'));
  const rows = [...sandbox.state.products.values()]
    .filter((product) => listingState === null || product.listingState === listingState)
    .filter((product) => !updatedSince || product.updatedAt >= updatedSince)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id))
    .filter((product) => !cursor || product.updatedAt < cursor.at || (product.updatedAt.getTime() === cursor.at.getTime() && product.id < cursor.id));
  const { page, nextCursor } = cursorPage(rows, limit, (product) => product.updatedAt);
  return { status: 200, body: { data: page.map((product) => productView(sandbox.view, product)), next_cursor: nextCursor } };
}

export function getProduct(sandbox: Sandbox, ctx: RequestContext): Reply {
  return { status: 200, body: productView(sandbox.view, findProduct(sandbox, ctx.params.product_id)) };
}

export function confirmProduct(sandbox: Sandbox, ctx: RequestContext): Reply {
  const product = findProduct(sandbox, ctx.params.product_id);
  const body = jsonBody(ctx, obj({ website_product_id: str, website_url: str }));
  const websiteProductId = body.website_product_id?.trim() ?? '';
  if (!websiteProductId) throw validationFailed('website_product_id is required.', 'website_product_id');
  if (websiteProductId.length > 255 || CONTROL_CHARACTERS.test(websiteProductId)) {
    throw validationFailed('website_product_id must be at most 255 characters without control characters.', 'website_product_id');
  }
  const websiteUrl = body.website_url?.trim() ?? '';
  if (!websiteUrl) throw validationFailed('website_url is required.', 'website_url');
  requireHttpsUrl(websiteUrl);
  confirmListing(product, { websiteProductId, websiteUrl });
  return { status: 200, body: productView(sandbox.view, product) };
}

function requireHttpsUrl(raw: string): void {
  if (raw.length > 2048) throw validationFailed('website_url must be a valid https URL.', 'website_url');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw validationFailed('website_url must be a valid https URL.', 'website_url');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw validationFailed('website_url must be an https URL without credentials.', 'website_url');
  }
}

export function reportPublishFailure(sandbox: Sandbox, ctx: RequestContext): Reply {
  const product = findProduct(sandbox, ctx.params.product_id);
  const body = optionalJsonBody(ctx, obj({ code: str, message: str }));
  if (!body) throw validationFailed('A request body is required.');
  const message = body.message?.trim() ?? '';
  if (!message) throw validationFailed('message is required.', 'message');
  if (message.length > 500) throw validationFailed('message must be at most 500 characters.', 'message');
  if ((body.code?.length ?? 0) > 64) throw validationFailed('code must be at most 64 characters.', 'code');
  failListing(sandbox, product, message);
  return { status: 200, body: productView(sandbox.view, product) };
}

export function reportProductRemoved(sandbox: Sandbox, ctx: RequestContext): Reply {
  const product = findProduct(sandbox, ctx.params.product_id);
  const body = optionalJsonBody(ctx, obj({ reason: str }));
  if ((body?.reason?.length ?? 0) > 500) {
    throw validationFailed('reason must be at most 500 characters.', 'reason');
  }
  reportRemoved(product);
  return { status: 200, body: productView(sandbox.view, product) };
}

export function getInventory(sandbox: Sandbox, ctx: RequestContext): Reply {
  const raw = ctx.query.get('variant_ids');
  if (raw === null || !raw.trim()) throw validationFailed('variant_ids is required.', 'variant_ids');
  const ids = raw.split(',').map((id) => id.trim());
  if (ids.length > 100) throw new ApiError('too_many_items', 'variant_ids can contain at most 100 ids.', { field: 'variant_ids' });
  const data = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const match = findVariant(sandbox.state, id);
    if (match) data.push(inventoryView(match.product, match.variant));
  }
  return { status: 200, body: { data } };
}
