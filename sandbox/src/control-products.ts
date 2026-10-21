import { isTemplateName, TEMPLATES } from './catalog.ts';
import { isWholeNumber, ok, routeList } from './control-route.ts';
import { validationFailed } from './errors.ts';
import { AMOUNT_PATTERN, parseCents } from './money.ts';
import {
  changeProductionCost,
  type CostChange,
  deleteProduct,
  expireListing,
  findProduct,
  publishProduct,
  republishProduct,
  setStock,
  unpublishProduct,
  updateProductDetails,
} from './product-catalogue.ts';
import { productView } from './views.ts';

const { routes, add } = routeList();

add('POST', '/_sandbox/products', (sandbox, _ctx, body) => {
  const template = body.template ?? 'tshirt';
  if (!isTemplateName(template)) throw validationFailed(`template must be one of ${Object.keys(TEMPLATES).join(', ')}.`, 'template');
  return ok(productView(sandbox.view, publishProduct(sandbox, template)));
});

add('POST', '/_sandbox/products/{product_id}/update', (sandbox, ctx, body) => {
  const product = findProduct(sandbox, ctx.params.product_id);
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null;
  const changed = Array.isArray(body.changed) && body.changed.length ? body.changed.map(String) : ['details'];
  updateProductDetails(sandbox, product, { title, changed });
  return ok(productView(sandbox.view, product));
});

add('POST', '/_sandbox/products/{product_id}/unpublish', (sandbox, ctx) => {
  const product = findProduct(sandbox, ctx.params.product_id);
  unpublishProduct(sandbox, product);
  return ok(productView(sandbox.view, product));
});

add('POST', '/_sandbox/products/{product_id}/republish', (sandbox, ctx) => {
  const product = findProduct(sandbox, ctx.params.product_id);
  republishProduct(sandbox, product);
  return ok(productView(sandbox.view, product));
});

add('POST', '/_sandbox/products/{product_id}/delete', (sandbox, ctx) => {
  const product = findProduct(sandbox, ctx.params.product_id);
  deleteProduct(sandbox, product);
  return ok({ deleted: product.id });
});

add('POST', '/_sandbox/products/{product_id}/cost-change', (sandbox, ctx, body) => {
  const product = findProduct(sandbox, ctx.params.product_id);
  if (body.production !== undefined && (typeof body.production !== 'string' || !AMOUNT_PATTERN.test(body.production))) {
    throw validationFailed('production must be a decimal string such as "35.00".', 'production');
  }
  const change: CostChange = typeof body.production === 'string' ? { kind: 'set', productionCents: parseCents(body.production) } : { kind: 'raise_ten_percent' };
  changeProductionCost(sandbox, product, change);
  return ok(productView(sandbox.view, product));
});

add('POST', '/_sandbox/products/{product_id}/stock', (sandbox, ctx, body) => {
  const product = findProduct(sandbox, ctx.params.product_id);
  const quantity = body.quantity;
  if (quantity !== null && !isWholeNumber(quantity, 0)) {
    throw validationFailed('quantity must be a whole number of at least 0, or null when unknown.', 'quantity');
  }
  setStock(sandbox, product, {
    quantity,
    variantId: variantIdFrom(body),
    syncFailed: body.sync_failed === true,
  });
  return ok(productView(sandbox.view, product));
});

add('POST', '/_sandbox/products/{product_id}/expire-listing', (sandbox, ctx) => {
  const product = findProduct(sandbox, ctx.params.product_id);
  expireListing(product);
  return ok(productView(sandbox.view, product));
});

/** No variant id means every variant of the product. */
function variantIdFrom(body: Record<string, unknown>): string | null {
  const variantId = body.variant_id;
  if (variantId === undefined || variantId === null || variantId === '') return null;
  if (typeof variantId !== 'string') throw validationFailed('variant_id must be a string.', 'variant_id');
  return variantId;
}

export const productControlRoutes = routes;
