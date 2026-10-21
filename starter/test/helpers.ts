import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, type RunningSandbox } from '../../sandbox/src/app.ts';
import { loadConfig as loadSandboxConfig } from '../../sandbox/src/config.ts';
import type { StarterConfig } from '../src/config.ts';

export const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef-0123456789abcdef';
export const TEST_ADMIN_TOKEN = 'test-admin-token-0123456789abcdef-0123456789abcdef';

export const waitUntil = async (check: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
};

export const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
  redirect: 'manual' as const,
});

/** The hidden form token on an order page, the way a browser would send it back. */
export async function csrfTokenOf(shopUrl: string, orderId: string): Promise<string> {
  const page = await (await fetch(`${shopUrl}/orders/${orderId}`)).text();
  const token = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1];
  if (!token) throw new Error(`No form token on the page of order ${orderId}`);
  return token;
}

export const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

export type SandboxStateView = {
  products: { id: string; title: string; listing_state: string | null }[];
  orders: { external_order_id: string }[];
};

export type Kit = {
  sandbox: RunningSandbox;
  sandboxUrl: string;
  apiBaseUrl: string;
  apiKey: string;
  webhookSecret: string;
  control: <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;
};

/** The real sandbox on a free port, quick to react, and with image links that point at itself. */
export async function startSandbox(extraEnv: Record<string, string> = {}): Promise<Kit> {
  const config = loadSandboxConfig({
    SANDBOX_ASYNC_STEP_MS: '20',
    SANDBOX_WEBHOOK_RETRY_SECONDS: '0.05,0.05,0.05,0.05,0.05,0.05,0.05',
    SANDBOX_CANCEL_AUTO_RESOLVE_MS: '150',
    SANDBOX_HELD_FIRST_ORDERS: '0',
    SANDBOX_LOG_REQUESTS: 'false',
    ...extraEnv,
  });
  const sandbox = createSandbox(config);
  const sandboxUrl = await listen(sandbox.server);
  sandbox.sandbox.config.publicBaseUrl = sandboxUrl;
  sandbox.sandbox.view.publicBaseUrl = sandboxUrl;
  const control = async <T = unknown>(method: string, path: string, body?: unknown) => {
    const response = await fetch(`${sandboxUrl}/_sandbox${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return (await response.json()) as T;
  };
  return { sandbox, sandboxUrl, apiBaseUrl: `${sandboxUrl}/merchant/v1`, apiKey: config.fullAccessKey, webhookSecret: config.webhookSecret, control };
}

export const starterConfig = (kit: Kit, overrides: Partial<StarterConfig> = {}): StarterConfig => ({
  port: 0,
  apiBaseUrl: kit.apiBaseUrl,
  apiKey: kit.apiKey,
  webhookSecrets: [kit.webhookSecret],
  storefrontBaseUrl: 'https://shop.example',
  dataDir: mkdtempSync(join(tmpdir(), 'starter-')),
  reconcileIntervalMs: 3_600_000,
  sessionSecret: TEST_SESSION_SECRET,
  adminToken: TEST_ADMIN_TOKEN,
  imageHosts: [],
  ...overrides,
});
