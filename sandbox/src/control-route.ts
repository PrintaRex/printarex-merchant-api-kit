import type { IncomingMessage } from 'node:http';
import type { SandboxConfig } from './config.ts';
import type { Sandbox } from './context.ts';
import { ApiError, validationFailed } from './errors.ts';
import { header, route, type Reply, type RequestContext, type Route } from './http.ts';

/** A `/_sandbox/*` control endpoint: settings and scenario triggers for testing, not part of the Merchant API. */
export type ControlContext = { sandbox: Sandbox; ctx: RequestContext; body: Record<string, unknown>; reset: () => void };
export type ControlRoute = Route<ControlContext>;
export type ControlHandler = (sandbox: Sandbox, ctx: RequestContext, body: Record<string, unknown>) => Reply;

export const ok = (body: unknown): Reply => ({ status: 200, body });

/** Collects routes declared with `add`, in declaration order. */
export function routeList(): { routes: ControlRoute[]; add: (method: string, path: string, handler: ControlHandler) => void } {
  const routes: ControlRoute[] = [];
  const add = (method: string, path: string, handler: ControlHandler) => {
    routes.push(route(method, path, ({ sandbox, ctx, body }) => handler(sandbox, ctx, body)));
  };
  return { routes, add };
}

// ---- Input checks: validate first, then the value has its real type ------------------------------

/** Narrows an untrusted value to one member of a fixed list. */
export const isOneOf = <T extends string>(allowed: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && allowed.some((candidate) => candidate === value);

export const isWholeNumber = (value: unknown, minimum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum;

/** How many times a fault fires: 1 when omitted, otherwise a positive whole number. */
export function faultCount(body: Record<string, unknown>): number {
  if (body.count === undefined || body.count === null) return 1;
  if (!isWholeNumber(body.count, 1)) throw validationFailed('count must be a positive whole number.', 'count');
  return body.count;
}

// ---- Who may call /_sandbox/* --------------------------------------------------------------------

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const HOST_PATTERN = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/;

/**
 * The control endpoints change what the sandbox does, so a web page the developer happens to visit must not
 * reach them: a cross-site POST carries an Origin, and a DNS-rebinding page carries its own Host. Requests
 * without an Origin (curl, a server) are allowed. Returns the refusal, or null when the request may proceed.
 */
export function refuseForeignRequest(config: SandboxConfig, headers: IncomingMessage['headers']): ApiError | null {
  const host = header({ headers }, 'Host')?.toLowerCase() ?? '';
  if (!isAllowedHost(config, host)) {
    return new ApiError('forbidden_scope', 'This Host is not allowed. Use localhost, 127.0.0.1, [::1] or the host in SANDBOX_PUBLIC_BASE_URL or SANDBOX_PORTAL_BASE_URL.', { field: 'Host' });
  }
  const origin = header({ headers }, 'Origin');
  if (origin !== undefined && !isAllowedOrigin(config, host, origin)) {
    return new ApiError('forbidden_scope', 'Requests from another website are refused. Call the sandbox from your server, curl or the sandbox portal page.', { field: 'Origin' });
  }
  return null;
}

/** The control endpoints change state, so a body must announce itself as JSON; `text/plain` is what a cross-site form can send. */
export function requireJsonContentType(ctx: RequestContext): void {
  if (ctx.rawBody.length === 0) return;
  const contentType = (header(ctx, 'Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ApiError('validation_failed', 'Use application/json for requests and responses.', { field: 'Content-Type' });
  }
}

function isAllowedHost(config: SandboxConfig, host: string): boolean {
  const match = HOST_PATTERN.exec(host);
  if (!match) return false;
  return LOOPBACK_HOSTNAMES.has(match[1] ?? '') || configuredUrls(config).some((url) => url.host === host);
}

/** Same origin as the Host that was just accepted (the browser may reach the sandbox on any mapped port), or a configured one. */
function isAllowedOrigin(config: SandboxConfig, host: string, origin: string): boolean {
  const parsed = URL.parse(origin);
  if (parsed?.protocol !== 'http:' && parsed?.protocol !== 'https:') return false;
  return parsed.host === host || configuredUrls(config).some((url) => url.origin === parsed.origin);
}

/** Read per request, because the public base URL can change after the server is built (tests bind a random port). */
function configuredUrls(config: SandboxConfig): URL[] {
  return [config.publicBaseUrl, config.portalBaseUrl].flatMap((address) => URL.parse(address) ?? []);
}
