export type StarterConfig = {
  port: number;
  /** Base URL of the PrintaRex Merchant API, ending in /merchant/v1. */
  apiBaseUrl: string;
  apiKey: string;
  /** Current and (during a rotation) previous webhook signing secret. */
  webhookSecrets: string[];
  /** Public https address of this storefront. PrintaRex only accepts https product URLs. */
  storefrontBaseUrl: string;
  dataDir: string;
  reconcileIntervalMs: number;
  /** Server secret behind the order-page form tokens. */
  sessionSecret: string;
  /** Password for `/admin`; null switches `/admin` off. */
  adminToken: string | null;
  /** When not empty, product images may only be downloaded from these host names. */
  imageHosts: string[];
};

const MIN_SECRET_LENGTH = 32;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): StarterConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required. See starter/README.md.`);
    return value;
  };
  return {
    port: integerFrom(env, 'PORT', 3000),
    apiBaseUrl: required('PRINTAREX_API_BASE_URL').replace(/\/$/, ''),
    apiKey: required('PRINTAREX_API_KEY'),
    webhookSecrets: [required('PRINTAREX_WEBHOOK_SECRET'), env.PRINTAREX_WEBHOOK_PREVIOUS_SECRET].filter((secret): secret is string => Boolean(secret)),
    storefrontBaseUrl: (env.STOREFRONT_BASE_URL ?? 'https://shop.example').replace(/\/$/, ''),
    dataDir: env.STARTER_DATA_DIR ?? new URL('../data', import.meta.url).pathname,
    reconcileIntervalMs: integerFrom(env, 'RECONCILE_INTERVAL_MS', 5 * 60_000),
    sessionSecret: longEnough('STARTER_SESSION_SECRET', required('STARTER_SESSION_SECRET')),
    adminToken: env.STARTER_ADMIN_TOKEN ? longEnough('STARTER_ADMIN_TOKEN', env.STARTER_ADMIN_TOKEN) : null,
    imageHosts: (env.PRINTAREX_IMAGE_HOSTS ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
  };
}

/** There is no rate limit on a guessing attack, so a short secret is refused at startup. */
function longEnough(name: string, value: string): string {
  if (value.length < MIN_SECRET_LENGTH) throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters. Generate one with: openssl rand -base64 32`);
  return value;
}

function integerFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive whole number, got "${raw}".`);
  return parsed;
}
