import type { Data, Listing, LocalOrder, ReadOnly } from './db.ts';
import type { ApiShipment } from './printarex-client.ts';
import { holdText, statusText } from './hold-reasons.ts';
import { lineTotal } from './money.ts';
import { descriptionParagraphs } from './plain-text.ts';

export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

const layout = (title: string, body: string, banner = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Starter shop</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#1f2937;background:#fafafa}
header{background:#fff;border-bottom:1px solid #e5e7eb;padding:16px 24px;display:flex;gap:24px;align-items:center}
header a{color:#1f2937;text-decoration:none;font-weight:600}
main{max-width:960px;margin:24px auto;padding:0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
.card{background:#fff;border-radius:14px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card img{width:100%;border-radius:8px}
.banner{background:#fef3c7;padding:12px 24px}
.notice{background:#ecfdf5;border-radius:14px;padding:12px 16px;margin:16px 0}
.merchant{background:#f3f4f6;border-radius:14px;padding:12px 16px;margin:16px 0;font-size:14px}
.error{background:#fee2e2;border-radius:14px;padding:12px 16px;margin:16px 0}
button{background:#0F7F5F;color:#fff;border:0;border-radius:14px;padding:10px 16px;font-size:15px;cursor:pointer}
input,select{padding:8px;border:1px solid #d1d5db;border-radius:8px;width:100%;box-sizing:border-box;margin:4px 0 12px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px;border-bottom:1px solid #e5e7eb}
</style></head><body>
<header><a href="/">Starter shop</a><a href="/admin">Admin</a></header>${banner}
<main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;

const connectionBanner = (data: ReadOnly<Data>) =>
  data.connectionDisabledReason
    ? `<div class="banner">The PrintaRex connection is disabled (${escapeHtml(data.connectionDisabledReason)}). New orders cannot be sent.</div>`
    : '';

export function homePage(data: ReadOnly<Data>): string {
  const listings = Object.values(data.listings).filter((listing) => listing.visible);
  const cards = listings
    .map((listing) => {
      const price = listing.variants[0];
      return `<a class="card" href="/products/${escapeHtml(listing.websiteProductId)}" style="color:inherit;text-decoration:none">
        ${listing.images[0] ? `<img src="${escapeHtml(listing.images[0])}" alt="">` : ''}
        <h3>${escapeHtml(listing.title)}</h3><p>${escapeHtml(price?.price)} ${escapeHtml(price?.currency)}</p></a>`;
    })
    .join('');
  return layout('Products', cards ? `<div class="grid">${cards}</div>` : '<p>No products yet. Publish one from PrintaRex (or POST /_sandbox/products on the sandbox).</p>', connectionBanner(data));
}

export function productPage(listing: ReadOnly<Listing>): string {
  const options = listing.variants
    .map((variant) => `<option value="${escapeHtml(variant.id)}" ${variant.available ? '' : 'disabled'}>${escapeHtml(variant.label)} · ${escapeHtml(variant.price)} ${escapeHtml(variant.currency)}${variant.available ? '' : ' (sold out)'}</option>`)
    .join('');
  const gallery = listing.images.map((src) => `<img src="${escapeHtml(src)}" alt="" style="width:120px;border-radius:8px;margin-right:8px">`).join('');
  return layout(
    listing.title,
    `<div>${gallery}</div><div class="card" style="margin-top:16px">${descriptionParagraphs(listing.descriptionHtml).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}
     <form method="get" action="/checkout"><label>Option<select name="variant">${options}</select></label>
     <label>Quantity<input name="qty" type="number" min="1" value="1"></label><button>Buy now</button></form></div>`,
  );
}

export function checkoutPage(listing: ReadOnly<Listing>, variantId: string, quantity: number, states: string[], error = ''): string {
  const variant = listing.variants.find((candidate) => candidate.id === variantId);
  const stateOptions = states.map((state) => `<option>${escapeHtml(state)}</option>`).join('');
  return layout(
    'Checkout',
    `${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
     <p>${escapeHtml(listing.title)} · ${escapeHtml(variant?.label)} × ${quantity}</p>
     <form method="post" action="/checkout/quote" class="card">
       <input type="hidden" name="variant" value="${escapeHtml(variantId)}"><input type="hidden" name="qty" value="${quantity}">
       <label>Full name<input name="name" required></label>
       <label>Email<input name="email" type="email" required></label>
       <label>Phone (optional, E.164 such as +971501234567)<input name="phone"></label>
       <label>Address<input name="address1" required></label>
       <label>State / emirate<select name="state">${stateOptions}</select></label>
       <button>See shipping</button>
     </form>`,
  );
}

export function quotePage(fields: Record<string, string>, listing: ReadOnly<Listing>, shipping: { amount: string; currency: string; days: string } | null, error: string | null): string {
  const variant = listing.variants.find((candidate) => candidate.id === fields.variant);
  const quantity = Number(fields.qty);
  const hidden = Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join('');
  if (!shipping) {
    // Never invent a shipping price: tell the buyer and let them try again.
    return layout('Shipping', `<div class="error">${escapeHtml(error)}</div><form method="get" action="/checkout"><input type="hidden" name="variant" value="${escapeHtml(fields.variant)}"><input type="hidden" name="qty" value="${quantity}"><button>Back</button></form>`);
  }
  if (!variant) throw new Error(`Unknown variant ${fields.variant}`);
  const subtotal = lineTotal(variant.price, quantity);
  return layout(
    'Review and pay',
    `<div class="card"><p>${escapeHtml(listing.title)} · ${escapeHtml(variant.label)} × ${quantity}: ${subtotal} ${escapeHtml(shipping.currency)}</p>
     <p>Shipping: ${escapeHtml(shipping.amount)} ${escapeHtml(shipping.currency)} (${escapeHtml(shipping.days)} days after production)</p>
     <form method="post" action="/checkout/place">${hidden}<input type="hidden" name="shipping" value="${escapeHtml(shipping.amount)}">
     <p class="merchant">Starter only: "Pay" marks the order as paid without a payment gateway. A real website pushes the order to PrintaRex only after its payment provider confirms the payment.</p>
     <button>Pay and place order</button></form></div>`,
  );
}

/** What the order page needs from the server: the form token for this order, and the link policy. */
export type OrderPageContext = { csrfToken: string; safeHref: (url: string | null) => string | null };

export function orderPage(order: ReadOnly<LocalOrder>, context: OrderPageContext): string {
  const remote = order.printarex;
  const hold = remote.holdReason ? holdText(remote.holdReason.code) : null;
  const pushInfo =
    order.push.state === 'failed'
      ? `<div class="error">PrintaRex refused this order: ${escapeHtml(order.push.lastError)}. The starter does not resend a refused order: fix the cause, then place the order again.</div>`
      : order.push.state === 'pending'
        ? `<div class="merchant">Sending to PrintaRex (attempt ${order.push.attempts})${order.push.lastError ? `; last error ${escapeHtml(order.push.lastError)}` : ''}.</div>`
        : '';
  const shipments = remote.shipments
    .map((shipment) =>
      shipment.method === 'own_driver'
        ? `<li>Delivered by the print partner's own driver (no tracking number)${shipment.delivered_at ? ', delivered' : ''}</li>`
        : `<li>${escapeHtml(shipment.carrier)}: ${trackingLink(shipment, context)}${shipment.delivered_at ? ', delivered' : ''}</li>`,
    )
    .join('');
  const csrfField = `<input type="hidden" name="csrf" value="${escapeHtml(context.csrfToken)}">`;
  const phoneForm =
    remote.holdReason?.code === 'missing_phone'
      ? `<form method="post" action="/orders/${escapeHtml(order.id)}/phone" class="card">${csrfField}<label>Phone number for the courier<input name="phone" placeholder="+971501234567" required></label><button>Save phone</button></form>`
      : '';
  const cancellable = remote.orderId && ['received', 'on_hold', 'awaiting_provider'].includes(remote.status ?? '');
  return layout(
    `Order ${order.id}`,
    `${pushInfo}${remote.notice ? `<div class="notice">${escapeHtml(remote.notice)}</div>` : ''}
     <div class="card"><p>Status: <strong>${escapeHtml(statusText(remote.status))}</strong></p>
     ${hold ? `<p>${escapeHtml(hold.shopper)}</p>` : ''}
     ${shipments ? `<ul>${shipments}</ul>` : ''}</div>
     ${phoneForm}
     ${hold && remote.holdReason?.action_required ? `<div class="merchant"><strong>For the merchant:</strong> ${escapeHtml(hold.merchant)}${remote.holdReason.action_url ? ` ${actionLink(remote.holdReason.action_url, context)}` : ''}</div>` : ''}
     ${cancellable ? `<form method="post" action="/orders/${escapeHtml(order.id)}/cancel">${csrfField}<button>Cancel order</button></form>` : ''}`,
  );
}

/** A tracking URL comes from the courier data; anything but a safe link is shown as the plain tracking number. */
function trackingLink(shipment: ReadOnly<ApiShipment>, context: OrderPageContext): string {
  const href = context.safeHref(shipment.tracking_url);
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(shipment.tracking_number)}</a>` : escapeHtml(shipment.tracking_number);
}

function actionLink(actionUrl: string, context: OrderPageContext): string {
  const href = context.safeHref(actionUrl);
  return href ? `<a href="${escapeHtml(href)}">Open in PrintaRex</a>` : escapeHtml(actionUrl);
}

export function adminPage(data: ReadOnly<Data>): string {
  const listings = Object.values(data.listings)
    .map((listing) => `<tr><td>${escapeHtml(listing.title)}</td><td>${escapeHtml(listing.printarexProductId)}</td><td>${escapeHtml(listing.listingState)}</td><td>${listing.visible ? 'visible' : 'hidden'}</td></tr>`)
    .join('');
  const orders = Object.values(data.orders)
    .map((order) => `<tr><td><a href="/orders/${escapeHtml(order.id)}">${escapeHtml(order.id)}</a></td><td>${escapeHtml(order.push.state)}</td><td>${escapeHtml(order.printarex.status)}</td><td>${escapeHtml(order.printarex.holdReason?.code)}</td><td>${escapeHtml(order.push.lastError)}</td></tr>`)
    .join('');
  const events = data.webhookLog
    .slice(0, 30)
    .map((entry) => `<tr><td>${escapeHtml(entry.receivedAt)}</td><td>${escapeHtml(entry.type)}</td><td>${escapeHtml(entry.sequence)}</td><td>${escapeHtml(entry.outcome)}</td></tr>`)
    .join('');
  return layout(
    'Admin',
    `<h2>Listings</h2><table><tr><th>Title</th><th>PrintaRex id</th><th>Listing state</th><th>Shop</th></tr>${listings}</table>
     <h2>Orders</h2><table><tr><th>Order</th><th>Push</th><th>PrintaRex status</th><th>Hold</th><th>Last error</th></tr>${orders}</table>
     <h2>Recent webhooks</h2><table><tr><th>Received</th><th>Type</th><th>Sequence</th><th>Outcome</th></tr>${events}</table>`,
    connectionBanner(data),
  );
}
