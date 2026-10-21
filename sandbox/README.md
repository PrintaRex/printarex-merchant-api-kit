# Merchant API sandbox

A local copy of the PrintaRex Merchant API. It behaves like the production service
(same routes, payloads, error codes, webhook signatures, retries and limits) but keeps
everything in memory and lets you trigger every situation on demand.

- API: `http://localhost:8080/merchant/v1`
- Controls: `http://localhost:8080/_sandbox/...` (no key needed; see [Security](#security))
- Contract: `http://localhost:8080/_sandbox/openapi.yaml`

On start it prints a **full-access key**, a **read-only key** and the **webhook secret**.
They only work against this sandbox.

## Settings

Every variable the sandbox reads. A number must be a whole number of 0 or more, or the sandbox
refuses to start.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port inside the container |
| `SANDBOX_PUBLIC_BASE_URL` | `http://localhost:<PORT>` | Address your website uses to reach the sandbox. Image links use it, so it must be reachable from your server. |
| `SANDBOX_PORTAL_BASE_URL` | same as above | Address your browser uses for the stand-in portal pages (`action_url`, `retry_url`) |
| `SANDBOX_STORE_COUNTRY` | `AE` | `AE`, `SA` or `EG`; sets the currency and the coverage list |
| `SANDBOX_STORE_NAME` | `Sandbox Store` | Store name shown by `GET /store` |
| `SANDBOX_STORE_WEBSITE_URL` | `https://merchant.example` | Website address shown for the store |
| `SANDBOX_API_KEY` | random | Full-access key. Pin it with the format `prx_uat_` + 43 base64url characters. Never use a real key. |
| `SANDBOX_READ_ONLY_API_KEY` | random | Read-only key, same format |
| `SANDBOX_WEBHOOK_URL` | none | Your webhook endpoint. Events queue until it is set. It must be an `http://` or `https://` address, or the sandbox refuses to start. Private addresses are allowed here (production needs public `https`). |
| `SANDBOX_WEBHOOK_SECRET` | random | Signing secret (`whsec_` + 43 base64url characters) |
| `SANDBOX_WEBHOOK_RETRY_SECONDS` | `1,5,30,120,360,720,1440` | Retry delays, comma-separated. Production uses the same numbers in minutes. |
| `SANDBOX_WEBHOOK_TIMEOUT_MS` | `10000` | How long the sandbox waits for your endpoint to answer one delivery before it counts as failed |
| `SANDBOX_ASYNC_STEP_MS` | `500` | Delay before the first real order status and the gallery event |
| `SANDBOX_HELD_FIRST_ORDERS` | `10` | First orders held as `on_hold(velocity_review)`, like a new production key. `0` turns it off. |
| `SANDBOX_CANCEL_AUTO_RESOLVE_MS` | `2000` | A cancellation is accepted after this delay unless you choose the outcome |
| `SANDBOX_IMAGE_TTL_SECONDS` | `259200` (72 h) | Lifetime of signed image links |
| `SANDBOX_SEED_PRODUCTS` | `true` | Publish a T-shirt and a mug at start. Only the exact value `false` turns it off. |
| `SANDBOX_LOG_REQUESTS` | `true` | Log every API call and webhook attempt. Only the exact value `false` turns it off. |

## What starts in the sandbox

- One store (`AE`/`AED`, Premium plan, card on file, fulfilment mode `instant`).
- Two print partners (provider groups). Variants of different groups cannot share an order
  (`multi_provider_cart`). The second partner does not ship to the last state in the
  coverage list, so `destination_uncovered` is easy to test.
- A T-shirt (partner 1) and a mug (partner 2), published and announced by webhook.
  The last T-shirt variant is out of stock.

## Control endpoints

All take and return JSON. `{id}` is a PrintaRex id (`prd_...`, `ord_...`).

**Store and keys**

| Call | Effect |
|---|---|
| `GET /_sandbox/state` | Store, products, orders, delivery counts, active faults |
| `POST /_sandbox/reset` | Clear everything and seed again (keys and webhook URL are kept) |
| `PATCH /_sandbox/store` `{payment_method_ready, fulfillment_mode, delay_hours, plan_active, order_intake_paused, auto_routing}` | Change store settings (`plan_active:false` gives `402 plan_required`; `order_intake_paused:true` gives `503`) |
| `POST /_sandbox/keys` `{key:"full"\|"read_only", status:"active"\|"expired"\|"revoked"}` | Expire or revoke a key |
| `POST /_sandbox/api-key/expiring` | Send `api_key.expiring` |
| `POST /_sandbox/connection/disable` `{reason}` | Disable the connection (`plan_lapsed`, `disconnected`, `revoked`, `admin`); `disconnected` also unpublishes every product |
| `POST /_sandbox/connection/enable` | Connect again |

**Products**

| Call | Effect |
|---|---|
| `POST /_sandbox/products` `{template:"tshirt"\|"hoodie"\|"mug"\|"tote"}` | Publish a new product (primary image first, gallery after) |
| `POST /_sandbox/products/{id}/update` `{changed:[...], title?}` | Send `product.updated` |
| `POST /_sandbox/products/{id}/unpublish` | Send `product.unpublish_requested` |
| `POST /_sandbox/products/{id}/republish` | Publish an unpublished product again |
| `POST /_sandbox/products/{id}/delete` | Send `product.deleted` |
| `POST /_sandbox/products/{id}/cost-change` `{production?:"35.00"}` | Change the cost (default +10%) and send `product.cost_changed` |
| `POST /_sandbox/products/{id}/stock` `{variant_id?, quantity, sync_failed?}` | Change stock and send `inventory.updated` |
| `POST /_sandbox/products/{id}/expire-listing` | Turn a `sent` listing into `unconfirmed` (production does this after 72 h) |

**Orders**

| Call | Effect |
|---|---|
| `POST /_sandbox/orders/{id}/advance` | Next step: release hold, provider accepts, charge, ship, deliver |
| `POST /_sandbox/orders/{id}/release` | Resolve the current hold, as the merchant would in the portal |
| `POST /_sandbox/orders/{id}/hold` `{code, detail_code?}` | Put the order on any hold. `payment_failed`/`payment_expired` also send `order.payment_failed`/`order.payment_expired` |
| `POST /_sandbox/orders/{id}/reject` | The merchant declines the order (`rejected`) |
| `POST /_sandbox/orders/{id}/accept` | The provider accepts (`awaiting_payment`) |
| `POST /_sandbox/orders/{id}/charge` | Charge the merchant (`order.charged`, `in_production`, costs become `final`) |
| `POST /_sandbox/orders/{id}/reassign` | Back to `awaiting_provider` with the history note `reassigning` |
| `POST /_sandbox/orders/{id}/ship` `{method:"carrier"\|"own_driver"}` | Add a shipment (`order.shipped`); call twice for two shipments |
| `POST /_sandbox/orders/{id}/deliver` | Deliver open shipments (`order.delivered`) |
| `POST /_sandbox/orders/{id}/shipment-exception` `{kind:"returned"\|"exception"\|"on_hold"}` | Send `shipment.exception` |
| `POST /_sandbox/orders/{id}/cancel-outcome` `{outcome:"accepted"\|"rejected", reason_code?}` | Decide a pending cancellation |
| `POST /_sandbox/orders/{id}/return` `{status, action_required?}` | Change the return state on a delivered order |
| `POST /_sandbox/orders/{id}/returned` | Mark the order `returned` |
| `POST /_sandbox/orders/{id}/refund` `{amount?}` | Send `order.refunded` |

The `action_url` and `retry_url` links open a sandbox page with a button that resolves the hold.

**Webhooks and failures**

| Call | Effect |
|---|---|
| `POST /_sandbox/webhooks/endpoint` `{url?, enabled?}` | Set the webhook URL, or re-enable a disabled endpoint (its backlog is replayed) |
| `POST /_sandbox/webhooks/rotate-secret` | New secret; the old one keeps signing for 24 h (two `v1=` values) |
| `POST /_sandbox/webhooks/faults` `{mode, count?, event_type?}` | Next deliveries are `duplicate`, `out_of_order`, `bad_signature` or `stale_timestamp` |
| `POST /_sandbox/webhooks/flush` | Retry failed deliveries now |
| `POST /_sandbox/webhooks/ping` | Send `ping` |
| `POST /_sandbox/faults` `{code, route?, count?}` | Next API calls fail with this error code, for example `{"code":"entitlement_unavailable","route":"POST /orders"}` |
| `DELETE /_sandbox/faults` | Clear injected API failures |
| `POST /_sandbox/rate-limits` `{general?, orders?, rates?}` | Lower the per-minute limits to test `429` |

To test your own failure handling, make your endpoint return errors or time out: the
sandbox retries, pauses the endpoint after 5 failures in a row, and disables it when a
delivery runs out of attempts, like production.

## Security

The sandbox is a local development tool. It is not built to be shared.

- **The `/_sandbox/*` controls have no password.** Anyone who can reach the port can read and
  change everything. Never expose the sandbox on a shared network or the internet. The compose
  file binds to `127.0.0.1` only. The sandbox also checks the `Host` and `Origin` of control
  requests, so other websites open in your browser cannot drive it.
- **It posts webhooks to any URL you configure,** including private addresses. A hosted sandbox
  could be used to reach internal services (server-side request forgery). This is another
  reason not to host it.
- **Never put a real UAT or production key in `SANDBOX_API_KEY`.** Sandbox keys only look like
  UAT keys. Use the random keys it prints, or values you generate yourself.
- **Everything is kept in memory with no limit.** Restart the sandbox, or call
  `POST /_sandbox/reset`, during long sessions.

## Where the sandbox differs from production

- Data lives in memory and is lost on restart. There is one store.
- Keys use the UAT format and `GET /store` reports `environment: "uat"`.
- Webhook URLs may be `http://` or private addresses; production requires public `https` on port 443.
- Retry delays and the endpoint pause are seconds instead of minutes.
- Production steps after intake happen only when you trigger them. Cancellations are
  accepted after 2 seconds unless you choose an outcome.
- Duplicate keys inside a JSON body are not detected (production refuses them).
- Some validation messages are worded differently. Codes and `field` values match;
  never parse `message`.
- Catalogue, prices and stock are demo data.

## Tests

`test/sandbox.e2e.test.ts` checks every behaviour above over HTTP with a webhook receiver
that verifies signatures. Run it in Docker:

```bash
docker run --rm -v "$PWD/..:/kit" -w /kit/sandbox node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f sh -c 'npm ci && npm test'
```
