import { randomBytes } from 'node:crypto';
import type { Sandbox } from './context.ts';

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

export type PortalPage = { html: string; contentSecurityPolicy: string };

/**
 * Stand-in for the PrintaRex portal page that `hold_reason.action_url` and `retry_url` point to.
 * In production the merchant resolves the hold there; here one button releases it.
 */
export function renderPortalPage(sandbox: Sandbox, orderId: string): PortalPage {
  const nonce = randomBytes(16).toString('base64');
  const order = sandbox.state.orders.get(orderId);
  const title = order ? `Order ${escapeHtml(order.externalOrderId)}` : 'Order not found';
  const detail = order
    ? `<p>Status: <strong>${escapeHtml(order.status)}</strong>${order.hold ? ` (hold: <strong>${escapeHtml(order.hold.code)}</strong>)` : ''}</p>`
    : '<p>This order does not exist in the sandbox.</p>';
  const action = order?.hold
    ? `<button id="release">Resolve the hold (as the merchant would in the portal)</button>
       <script nonce="${nonce}">
         document.getElementById('release').addEventListener('click', async () => {
           const response = await fetch('/_sandbox/orders/${escapeHtml(order.id)}/release', { method: 'POST' });
           document.body.insertAdjacentHTML('beforeend', '<p>' + (response.ok ? 'Released. Watch your webhooks.' : 'Could not release: ' + response.status) + '</p>');
         });
       </script>`
    : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · PrintaRex sandbox portal</title>
<style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#1f2937}
h1{font-size:22px}button{background:#0F7F5F;color:#fff;border:0;border-radius:14px;padding:12px 16px;font-size:15px;cursor:pointer}
.note{background:#f3f4f6;border-radius:14px;padding:12px 16px;font-size:14px}</style></head>
<body><h1>${title}</h1>${detail}${action}
<p class="note">Sandbox only. In production this link opens the PrintaRex portal, where the merchant fixes the issue.</p></body></html>`;
  return { html, contentSecurityPolicy: contentSecurityPolicy(nonce) };
}

/** Only this page's own script and style may run, it may call back to its own origin, and nothing may frame it. */
const contentSecurityPolicy = (nonce: string): string =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
