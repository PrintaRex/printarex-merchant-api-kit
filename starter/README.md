# Starter shop

A small, working merchant website that sells PrintaRex products through the Merchant API.
It has no framework and no runtime dependencies, so every step of the integration is
visible. Copy the parts you need into your own website.

## Run it

With the sandbox (from the repository root): `./scripts/dev-up.sh`, then open
<http://localhost:3000>.

On its own:

| Variable | Meaning |
|---|---|
| `PRINTAREX_API_BASE_URL` | For example `http://localhost:8080/merchant/v1` |
| `PRINTAREX_API_KEY` | Your API key |
| `PRINTAREX_WEBHOOK_SECRET` | Your webhook signing secret |
| `PRINTAREX_WEBHOOK_PREVIOUS_SECRET` | Optional; the old secret during a rotation |
| `STARTER_SESSION_SECRET` | **Required**, at least 32 characters, no default. Signs the order-page form tokens. Generate one with `openssl rand -base64 32`. The server will not start without it |
| `STARTER_ADMIN_TOKEN` | Optional, at least 32 characters. The password for `/admin`. When it is not set, `/admin` answers 404 (off) |
| `PRINTAREX_IMAGE_HOSTS` | Optional, comma-separated host names (for example `cdn.example.com`). When set, product images are downloaded only from these hosts. Unset means any host, over https |
| `STOREFRONT_BASE_URL` | Public **https** address of your shop, used in product links sent to PrintaRex |
| `PORT` | Default `3000` |
| `STARTER_DATA_DIR` | Where the JSON data file and hosted images go (default `./data`) |
| `RECONCILE_INTERVAL_MS` | How often missed order updates are fetched (default 5 minutes) |

Point your PrintaRex webhook at `<your shop>/webhooks/printarex`.

Keep the two secrets in your secret manager, not in the repository, and use a different value
for each environment.

## Where each rule lives

| What | File |
|---|---|
| Calling the API, reading errors (`code`, `field`, `request_id`), which errors to retry | `src/printarex-client.ts` |
| Verifying webhook signatures on the raw body, rotation overlap, 5-minute window | `src/webhook-verifier.ts` |
| Answering webhooks fast, then processing each event type | `src/app.ts`, `src/webhook-handler.ts` |
| The Sync state: ignoring duplicate event ids, dropping a LOWER `sequence` (equal is fine), saving every change atomically | `src/db.ts` |
| Publish handshake: host the images, confirm or report failure; fresh links when one expired | `src/catalog-sync.ts` |
| Checkout shipping quote without ever inventing a price | `src/app.ts` (`/checkout/quote`) |
| Retry queue for paid orders with the same `external_order_id` and body | `src/order-sync.ts` |
| Order status, shipments (with and without tracking), cancellation; stale orders are dropped with the same sequence rule | `src/order-sync.ts`, `src/pages.ts` |
| What to show for each hold reason, and the merchant's action | `src/hold-reasons.ts` |
| Adding a missing phone through `PATCH /orders/{id}/shipping-address` | `src/app.ts` |
| Order links, form tokens and the admin login | `src/access.ts`, `src/app.ts` (`handleOrder`, `showAdmin`) |
| Refusing unsafe ids, image positions, image downloads and links | `src/catalog-sync.ts`, `src/safe-url.ts` |
| Showing `description_html` as plain text | `src/plain-text.ts` |
| Catching up after missed webhooks (`GET /orders?updated_since`) | `src/order-sync.ts` (`reconcile`) |

## The Sync state

`src/db.ts` is the one place that knows the ordering rules. Delivery is at-least-once and
unordered, so it de-duplicates on the webhook event id and drops anything whose `sequence` is
lower than the one already applied for that product or order. An equal sequence is accepted,
because several events from one change share it. An event id is remembered only after the event
was handled, so a delivery that failed halfway can be retried.

The rest of the code reads the state but cannot change it directly. Every change goes through
one call that applies the change and writes the file in the same step (temporary file, then
rename), so no caller has to remember to save. A missing file is a fresh start; a corrupt one
stops startup instead of being overwritten. With your own database, keep this shape: one
place that decides "seen before?" and "older than what I have?", and one transaction per change.

## What is protected, and what is not

- **Order pages are capability URLs.** The shopper's link `/orders/W-<32 hex characters>` is the
  only thing that unlocks the order page, like the "view your order" links many shops send. The id
  is 128 random bits from `node:crypto`, so it cannot be guessed, and it is a valid
  `external_order_id` (34 characters). Treat the link as a secret: send it only to the buyer
  (confirmation email), never put it in analytics or a public place. Pages are sent with
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Anyone who gets the link can view
  that order and use its forms, so it is not a replacement for a buyer account. Orders saved by
  an older version of the starter have short, guessable ids; their pages answer 404, and `/admin`
  still lists them.
- **The phone and cancel forms carry a token.** It is an HMAC of the order id with
  `STARTER_SESSION_SECRET`, put in a hidden field and compared in constant time. Another website
  cannot post these forms for a buyer, even if it learns the link. A missing, wrong or other-order
  token answers 403.
- **`/admin` is off unless `STARTER_ADMIN_TOKEN` is set.** Then it needs HTTP Basic (any user name,
  the token as the password) or `Authorization: Bearer <token>`, and answers 401 otherwise. The
  token is compared in constant time. There is no rate limit and no session, so use a long random
  token, serve the shop over https only, and put `/admin` behind your own login or network
  rules when real buyers' data is in it.
- **Payloads are untrusted.** Product ids must look like `prd_` plus 32 hex characters and image
  positions must be whole numbers from 1 to 100 before any file name or API path is built; every
  id in an API path is URL-encoded. Image links must be https (http only when the API base URL
  itself is http, which means a local sandbox), are never redirected, are limited to 10 MB while
  streaming, and must be PNG, JPEG or WebP by their first bytes. Stored images are served with
  `X-Content-Type-Options: nosniff`. Tracking and "open in PrintaRex" links become links only
  when they are https (or http for a local sandbox); anything else, such as `javascript:`, is
  shown as text.
- **`description_html` is shown as plain text.** Scripts, styles and tags are removed, a few basic
  entities are decoded, and the result is escaped, in paragraphs. The page policy also sets
  `base-uri 'none'` and `object-src 'none'`. If you want bold text, lists or links from the
  description, run the HTML through a maintained HTML sanitiser instead of writing your own.
- **`db.json` holds buyers' emails, phones and addresses.** It is written with mode `0600`
  (owner only), through a temporary file that has the same mode.
- **The destination country is the store's country** from `GET /store`, read at startup, for
  shipping quotes and orders. Coverage names (states and cities) come from `GET /shipping/coverage`
  for that country.
- **A refused order is not resent.** If PrintaRex refuses an order (an error that retrying cannot fix), the order page
  says so and the buyer must place it again once the cause is fixed. Add a resend action behind
  your admin login if you want one.

## Before you copy it into production

- **Payment:** the starter marks orders as paid without a payment gateway. Push an order
  to PrintaRex only after your payment provider confirms it.
- **Storage:** replace the JSON file with your database. Keep the same records: processed
  event ids, the last `sequence` per product and order, and the order push queue.
- **Images:** serve the downloaded images from your own storage or CDN.
- **Buyers and sessions:** there are no buyer accounts. The order link is the only access
  control, so add accounts, sessions and the access checks of your platform; send order links
  only by email to the buyer.
- **Admin page:** replace the shared token with your own staff login, roles and audit log.
- **Rich descriptions:** use a maintained HTML sanitiser if you want formatting from
  `description_html`.

## Tests

`test/starter.e2e.test.ts` runs the starter against the sandbox and checks the whole
journey: listing, checkout, order push and retry, webhooks, holds, shipping, cancellation,
unpublishing and reconciliation. `test/sync-state.test.ts` checks the Sync state rules on
their own: duplicates, lower and equal sequences, and persistence across a reload (and the
`0600` file mode). `test/hardening.e2e.test.ts` attacks the shop: guessed order ids, forged
forms, the admin login, path-traversal ids and positions, oversized or fake images, hostile
descriptions and links, the store country, and webhook secret rotation with two `v1` values.
`test/pure-functions.test.ts` covers the text conversion, whole-cent totals and the link policy.
