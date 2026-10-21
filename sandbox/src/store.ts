import type { Sandbox } from './context.ts';

export function storeView(sandbox: Sandbox) {
  const store = sandbox.state.store;
  const now = new Date();
  const resetsOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return {
    id: store.id,
    name: store.name,
    website_url: store.websiteUrl,
    country: store.country,
    currency: store.currency,
    environment: 'uat',
    fulfillment_mode: store.fulfillmentMode,
    delay_hours: store.fulfillmentMode === 'delayed_auto_submit' ? store.delayHours : null,
    auto_routing: store.autoRouting,
    payment_method_ready: store.paymentMethodReady,
    listing_limits: {
      monthly_new_products_limit: store.monthlyNewProductsLimit,
      monthly_new_products_used: store.monthlyNewProductsUsed,
      resets_on: resetsOn,
    },
  };
}
