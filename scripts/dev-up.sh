#!/bin/sh
# Starts the sandbox and the starter shop with fresh keys and secrets for this run.
# Needs Docker and a POSIX shell (macOS, Linux, or WSL on Windows). No other tools.
# The values exist only in this shell and the two containers; they never work against PrintaRex.
set -eu
cd "$(dirname "$0")/.."

# One short-lived container makes four random 32-byte values (43 base64url characters each).
random_values=$(docker run --rm node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f \
  node -e 'for (let i = 0; i < 4; i++) console.log(require("node:crypto").randomBytes(32).toString("base64url"))')
value_number() { printf '%s\n' "$random_values" | sed -n "${1}p"; }

SANDBOX_API_KEY="prx_uat_$(value_number 1)"
SANDBOX_WEBHOOK_SECRET="whsec_$(value_number 2)"
STARTER_SESSION_SECRET="$(value_number 3)"
STARTER_ADMIN_TOKEN="$(value_number 4)"
export SANDBOX_API_KEY SANDBOX_WEBHOOK_SECRET STARTER_SESSION_SECRET STARTER_ADMIN_TOKEN

echo "Sandbox API key:        ${SANDBOX_API_KEY}"
echo "Sandbox webhook secret: ${SANDBOX_WEBHOOK_SECRET}"
echo "Starter admin token:    ${STARTER_ADMIN_TOKEN}   (use it to open /admin)"
echo "Shop:    http://localhost:3000   (admin: http://localhost:3000/admin)"
echo "Sandbox: http://localhost:8080/_sandbox/state"
echo
docker compose up --build "$@"
