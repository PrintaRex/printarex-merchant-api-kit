import { generateApiKey, generateWebhookSecret } from './ids.ts';

/** Seconds the real service waits before each webhook retry: 1m, 5m, 30m, 2h, 6h, 12h, 24h. */
const PRODUCTION_RETRY_SECONDS = [60, 300, 1800, 7200, 21600, 43200, 86400];

export type SandboxConfig = {
  port: number;
  /** Address websites use to reach the sandbox (API, image links). */
  publicBaseUrl: string;
  /** Address a browser uses for the stand-in portal pages (`action_url`, `retry_url`). */
  portalBaseUrl: string;
  apiVersion: string;
  storeCountry: string;
  storeName: string;
  storeWebsiteUrl: string;
  fullAccessKey: string;
  readOnlyKey: string;
  webhookUrl: string | null;
  webhookSecret: string;
  /** Retry delays in milliseconds. Defaults to the production schedule with minutes shown as seconds. */
  webhookRetryDelaysMs: number[];
  webhookTimeoutMs: number;
  /** Delay between a state change and its side effects (initial order status, gallery image event). */
  asyncStepMs: number;
  /** How many first orders of the key are held as on_hold(velocity_review). Production uses 10. */
  heldFirstOrders: number;
  cancelAutoResolveMs: number;
  imageTtlSeconds: number;
  seedProducts: boolean;
  logRequests: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const port = integerFrom(env.PORT, 8080);
  const storeCountry = (env.SANDBOX_STORE_COUNTRY ?? 'AE').toUpperCase();
  const publicBaseUrl = trimTrailingSlash(env.SANDBOX_PUBLIC_BASE_URL ?? `http://localhost:${port}`);
  return {
    port,
    publicBaseUrl,
    portalBaseUrl: trimTrailingSlash(env.SANDBOX_PORTAL_BASE_URL ?? publicBaseUrl),
    apiVersion: '2026-11-01',
    storeCountry,
    storeName: env.SANDBOX_STORE_NAME ?? 'Sandbox Store',
    storeWebsiteUrl: env.SANDBOX_STORE_WEBSITE_URL ?? 'https://merchant.example',
    fullAccessKey: env.SANDBOX_API_KEY ?? generateApiKey(),
    readOnlyKey: env.SANDBOX_READ_ONLY_API_KEY ?? generateApiKey(),
    webhookUrl: webhookUrlFrom(env.SANDBOX_WEBHOOK_URL),
    webhookSecret: env.SANDBOX_WEBHOOK_SECRET ?? generateWebhookSecret(),
    webhookRetryDelaysMs: retryDelaysFrom(env.SANDBOX_WEBHOOK_RETRY_SECONDS),
    webhookTimeoutMs: integerFrom(env.SANDBOX_WEBHOOK_TIMEOUT_MS, 10_000),
    asyncStepMs: integerFrom(env.SANDBOX_ASYNC_STEP_MS, 500),
    heldFirstOrders: integerFrom(env.SANDBOX_HELD_FIRST_ORDERS, 10),
    cancelAutoResolveMs: integerFrom(env.SANDBOX_CANCEL_AUTO_RESOLVE_MS, 2000),
    imageTtlSeconds: integerFrom(env.SANDBOX_IMAGE_TTL_SECONDS, 72 * 3600),
    seedProducts: env.SANDBOX_SEED_PRODUCTS !== 'false',
    logRequests: env.SANDBOX_LOG_REQUESTS !== 'false',
  };
}

function integerFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Expected a non-negative integer, got "${raw}"`);
  return parsed;
}

/** Same rule as POST /_sandbox/webhooks/endpoint, applied at startup so a typo fails here and not on the first delivery. */
function webhookUrlFrom(raw: string | undefined): string | null {
  if (!raw) return null;
  const protocol = URL.parse(raw)?.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`SANDBOX_WEBHOOK_URL must be an http or https URL, got "${raw}"`);
  return raw;
}

function retryDelaysFrom(raw: string | undefined): number[] {
  if (!raw) return PRODUCTION_RETRY_SECONDS.map((seconds) => (seconds / 60) * 1000);
  return raw.split(',').map((value) => {
    const seconds = Number(value);
    if (!value.trim() || !Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`SANDBOX_WEBHOOK_RETRY_SECONDS must be comma-separated non-negative numbers, got "${raw}"`);
    }
    return Math.round(seconds * 1000);
  });
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
