# PrintaRex Merchant API kit

Everything a developer needs to connect their own website to PrintaRex through the
**PrintaRex Merchant API** (the *Custom Website* sales channel):

| Folder | What it is | How you use it |
|---|---|---|
| [`contract/`](contract/) | The OpenAPI 3.1 description of the Merchant API | Read it, generate a client from it |
| [`sandbox/`](sandbox/) | A local copy of the Merchant API that keeps its data in memory | Run it with Docker and build against it |
| [`starter/`](starter/) | A small reference shop that already does the integration correctly | Read it, copy the parts you need |

The same contract, rendered as a readable API reference with the integration guide, is at
**[developers.printarex.com](https://developers.printarex.com)** (UAT: [uat-developers.printarex.com](https://uat-developers.printarex.com)).

## From first line of code to live

1. **Sandbox (on your own).** Build and test the whole integration against the sandbox:
   publishing, shipping quotes, orders, every hold reason, shipping, cancellation, refunds,
   webhook retries and signature checks. Nothing you do here touches PrintaRex.
2. **UAT (with PrintaRex).** When it works in the sandbox, PrintaRex gives you a UAT account.
   You create a `prx_uat_` key, publish one design, push a few test orders, and we produce
   and ship them with you.
3. **Production.** Create a `prx_live_` key and go live. Automatic checks protect new keys
   (the first orders are held for your approval, and daily limits apply).

## Quick start

You need Docker and a POSIX shell (macOS, Linux, or WSL on Windows). Nothing else.

```bash
./scripts/dev-up.sh
```

This starts the sandbox on <http://localhost:8080> and the starter shop on
<http://localhost:3000>, with a fresh sandbox key, webhook secret, session secret and admin
token. The script prints the key, the secret and the admin token; use the admin token to open
`/admin` on the shop. Open the shop, buy something, then move the order along with the
sandbox controls:

```bash
curl -s localhost:8080/_sandbox/state                         # products, orders, webhook deliveries
curl -s -X POST localhost:8080/_sandbox/orders/<order_id>/advance   # next production step
```

**Windows without WSL.** Skip the script. Make four random values, set them as the
environment variables below, then run `docker compose up --build`:

```bash
docker run --rm node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

| Variable | Value |
|---|---|
| `SANDBOX_API_KEY` | `prx_uat_` followed by one random value (43 characters) |
| `SANDBOX_WEBHOOK_SECRET` | `whsec_` followed by one random value (43 characters) |
| `STARTER_SESSION_SECRET` | one random value; it signs the shop's CSRF tokens |
| `STARTER_ADMIN_TOKEN` | one random value; it opens `/admin` on the shop |

Both ports are bound to `127.0.0.1` only. The `/_sandbox/*` controls have no password, so
nobody else on your network may reach them.

To run only the sandbox against your own website:

```bash
docker build -f sandbox/Dockerfile -t printarex-merchant-api-sandbox .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e SANDBOX_WEBHOOK_URL=http://host.docker.internal:3000/your/webhook/path \
  printarex-merchant-api-sandbox
```

The sandbox prints its API key and webhook secret when it starts. See
[`sandbox/README.md`](sandbox/README.md) for every setting and control endpoint.

## Safety notes

- The `/_sandbox/*` controls are unauthenticated by design. Never put the sandbox on a shared
  network or the internet.
- A hosted sandbox would send webhooks to any URL you give it, including private addresses.
  That is another reason not to host it.
- Never put a real UAT or production key into the sandbox. Sandbox keys only look like UAT keys.
- Everything is kept in memory with no limit. Restart it, or call `/_sandbox/reset`, in long sessions.

## The rules your integration must follow

The starter shows each of these in working code.

- Send the key only as `Authorization: Bearer <key>`. A key in a URL is refused.
- Verify every webhook signature against the **raw** request body, accept either `v1`
  value during a secret rotation, and refuse timestamps older than 5 minutes.
- Answer webhooks with any 2xx within 10 seconds, then process them. Delivery is
  at-least-once and unordered: ignore event ids you have seen, and ignore events whose
  `sequence` is lower than the one you already applied.
- Download product images and host them yourself. The links expire.
- Push only **paid** orders. `external_order_id` is the idempotency key: retry with the
  exact same body and you get the same order back.
- Treat the shipping quote as an estimate. If the quote fails, show an error, never a
  made-up price.
- Branch on error `code`, never on `message`, and log `request_id`.
- Tolerate values you do not know: new statuses, hold reasons and event types can appear.

## Running the tests

```bash
docker run --rm -v "$PWD:/kit" -w /kit/sandbox node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f sh -c 'npm ci && npm run typecheck && npm test'
docker run --rm -v "$PWD:/kit" -w /kit/starter node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f sh -c 'npm ci && npm run typecheck && npm test'
```

The sandbox suite drives every scenario over HTTP. The starter suite runs the starter
against the sandbox like a shopper and a merchant would. CI publishes JUnit reports and an
HTML snapshot of a delivered order as build artifacts.

## Release checklist

- In the GitHub settings, protect the `sandbox-v*` tags (a tag ruleset), so only maintainers can
  push one. Pushing a tag publishes `ghcr.io/printarex/printarex-merchant-api-sandbox`.
- A release runs the full test suite first and publishes only if it passes. The image is
  published with build provenance and an SBOM.

## Licence

The code in this repository (sandbox, starter, scripts) is released under the [MIT licence](LICENSE).
Use of the PrintaRex Merchant API itself is governed by the [PrintaRex Merchant API Terms](https://printarex.com/api-terms).
