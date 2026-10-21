import { ApiError } from './errors.ts';
import { API_KEY_PATTERN } from './ids.ts';
import type { KeyRecord, SandboxState, Scope } from './state.ts';

export const AUTH_MESSAGES = {
  unauthorized: 'Missing, malformed or unknown API key.',
  key_expired: 'This API key expired. Create a new key in the Developers tab.',
  forbidden_scope: 'This API key does not have the scope this request needs.',
  rate_limited: 'Too many requests for this API key. Wait Retry-After seconds.',
} as const;

export type Principal = { key: string; record: KeyRecord };
export type RateClass = 'general' | 'orders' | 'rates';

/** `Authorization: Bearer <key>` only; exactly one header, scheme matched case-insensitively. */
export function authenticate(state: SandboxState, authorization: string | string[] | undefined): Principal {
  const unauthorized = new ApiError('unauthorized', AUTH_MESSAGES.unauthorized);
  if (authorization === undefined || Array.isArray(authorization)) throw unauthorized;
  if (authorization.slice(0, 7).toLowerCase() !== 'bearer ') throw unauthorized;
  const key = authorization.slice(7);
  if (!API_KEY_PATTERN.test(key)) throw unauthorized;
  const record = state.keys.get(key);
  if (!record || record.status === 'revoked') throw unauthorized;
  if (record.status === 'expired') throw new ApiError('key_expired', AUTH_MESSAGES.key_expired);
  return { key, record };
}

export function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.record.scopes.has(scope)) throw new ApiError('forbidden_scope', AUTH_MESSAGES.forbidden_scope);
}

/**
 * Fixed one-minute windows per key and route class, starting at the first request.
 * Returns the RateLimit-* headers; throws `rate_limited` when the window is used up.
 */
export function consumeRateLimit(state: SandboxState, key: string, rateClass: RateClass, now = Date.now()): Record<string, string> {
  const limit = state.rateLimits[rateClass];
  const windowKey = `${key}|${rateClass}`;
  let window = state.rateWindows.get(windowKey);
  if (!window) {
    window = { startedAt: now, used: 0 };
    state.rateWindows.set(windowKey, window);
  } else if (now - window.startedAt >= 60_000) {
    window.startedAt += Math.floor((now - window.startedAt) / 60_000) * 60_000;
    window.used = 0;
  }
  const resetSeconds = Math.max(1, Math.ceil((window.startedAt + 60_000 - now) / 1000));
  if (window.used >= limit) {
    const headers = { 'RateLimit-Limit': String(limit), 'RateLimit-Remaining': '0', 'RateLimit-Reset': String(resetSeconds) };
    throw new ApiError('rate_limited', AUTH_MESSAGES.rate_limited, { retryAfterSeconds: resetSeconds, headers });
  }
  window.used += 1;
  return { 'RateLimit-Limit': String(limit), 'RateLimit-Remaining': String(limit - window.used), 'RateLimit-Reset': String(resetSeconds) };
}
