import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AUTH_MESSAGES, authenticate, consumeRateLimit, type Principal, type RateClass, requireScope } from './auth.ts';
import type { SandboxConfig } from './config.ts';
import { createLater, type Sandbox } from './context.ts';
import { refuseForeignRequest } from './control-route.ts';
import { faultMessage, handleControl, initialiseState, resetState } from './control.ts';
import { ApiError, INTERNAL_ERROR_MESSAGE, notFound, statusOf } from './errors.ts';
import { errorReply, header, matchRoute, MAX_BODY_BYTES, readBody, type Reply, type RequestContext, route, type Route, sendJson } from './http.ts';
import { KEY_IN_QUERY_PATTERN, newRequestId } from './ids.ts';
import { checkImageSignature, renderPng } from './images.ts';
import { cancelOrder, createOrder, getOrder, listOrders, updateShippingAddress } from './orders.ts';
import { renderPortalPage } from './portal.ts';
import { confirmProduct, getInventory, getProduct, listProducts, reportProductRemoved, reportPublishFailure } from './products.ts';
import { getShippingCoverage, getShippingRates } from './shipping.ts';
import { createState, type Scope } from './state.ts';
import { storeView } from './store.ts';
import { startDispatcher } from './webhook-outbox.ts';
import { listDeliveries, replayDelivery, sendTestEvent } from './webhooks.ts';

const BASE_PATH = '/merchant/v1';
const CONTRACT = readFileSync(new URL('../../contract/merchant-api-v1.openapi.yaml', import.meta.url));
const JSON_TYPES = ['application/json'];
const PATCH_TYPES = ['application/merge-patch+json', 'application/json'];

type ApiContext = { sandbox: Sandbox; ctx: RequestContext; principal: Principal };
type ApiRoute = Route<ApiContext> & { scope: Scope; rateClass: RateClass; consumes: string[] | null; key: string };

function apiRoute(
  method: string,
  path: string,
  scope: Scope,
  handler: (api: ApiContext) => Reply,
  options: { consumes?: string[]; rateClass?: RateClass } = {},
): ApiRoute {
  return {
    ...route<ApiContext>(method, path, handler),
    scope,
    rateClass: options.rateClass ?? 'general',
    consumes: options.consumes ?? null,
    key: `${method} ${path}`,
  };
}

const API_ROUTES: ApiRoute[] = [
  apiRoute('GET', '/store', 'store:read', ({ sandbox }) => ({ status: 200, body: storeView(sandbox) })),
  apiRoute('GET', '/products', 'products:read', ({ sandbox, ctx }) => listProducts(sandbox, ctx)),
  apiRoute('GET', '/products/{product_id}', 'products:read', ({ sandbox, ctx }) => getProduct(sandbox, ctx)),
  apiRoute('POST', '/products/{product_id}/confirmation', 'products:write', ({ sandbox, ctx }) => confirmProduct(sandbox, ctx), { consumes: JSON_TYPES }),
  apiRoute('POST', '/products/{product_id}/publish-failure', 'products:write', ({ sandbox, ctx }) => reportPublishFailure(sandbox, ctx), { consumes: JSON_TYPES }),
  apiRoute('POST', '/products/{product_id}/removed', 'products:write', ({ sandbox, ctx }) => reportProductRemoved(sandbox, ctx)),
  apiRoute('GET', '/inventory', 'products:read', ({ sandbox, ctx }) => getInventory(sandbox, ctx)),
  apiRoute('POST', '/shipping/rates', 'shipping:read', ({ sandbox, ctx }) => getShippingRates(sandbox, ctx), { consumes: JSON_TYPES, rateClass: 'rates' }),
  apiRoute('GET', '/shipping/coverage', 'shipping:read', ({ sandbox, ctx }) => getShippingCoverage(sandbox, ctx)),
  apiRoute('POST', '/orders', 'orders:write', ({ sandbox, ctx, principal }) => createOrder(sandbox, ctx, principal.record), { rateClass: 'orders' }),
  apiRoute('GET', '/orders', 'orders:read', ({ sandbox, ctx }) => listOrders(sandbox, ctx)),
  apiRoute('GET', '/orders/{order_id}', 'orders:read', ({ sandbox, ctx }) => getOrder(sandbox, ctx)),
  apiRoute('POST', '/orders/{order_id}/cancel', 'orders:write', ({ sandbox, ctx }) => cancelOrder(sandbox, ctx)),
  apiRoute('PATCH', '/orders/{order_id}/shipping-address', 'orders:write', ({ sandbox, ctx }) => updateShippingAddress(sandbox, ctx), { consumes: PATCH_TYPES }),
  apiRoute('GET', '/webhook-deliveries', 'webhooks:manage', ({ sandbox, ctx }) => listDeliveries(sandbox, ctx)),
  apiRoute('POST', '/webhook-deliveries/{delivery_id}/replay', 'webhooks:manage', ({ sandbox, ctx }) => replayDelivery(sandbox, ctx)),
  apiRoute('POST', '/webhooks/test', 'webhooks:manage', ({ sandbox, ctx }) => sendTestEvent(sandbox, ctx), { consumes: JSON_TYPES }),
];

export type RunningSandbox = { sandbox: Sandbox; server: Server; close: () => Promise<void> };

export function createSandbox(config: SandboxConfig): RunningSandbox {
  const state = createState(config);
  const sandbox: Sandbox = {
    config,
    state,
    view: { state, publicBaseUrl: config.publicBaseUrl, portalBaseUrl: config.portalBaseUrl, imageTtlSeconds: config.imageTtlSeconds },
    later: createLater(state),
    log: config.logRequests ? (message) => console.log(`[sandbox] ${message}`) : () => undefined,
  };
  initialiseState(sandbox);
  const stopDispatcher = startDispatcher(sandbox);
  const server = createServer((request, response) => {
    handle(sandbox, request, response).catch((error: unknown) => {
      console.error('[sandbox] unexpected error', error);
      if (!response.headersSent) sendJson(response, errorReply(new ApiError('internal_error', INTERNAL_ERROR_MESSAGE), newRequestId()));
    });
  });
  return {
    sandbox,
    server,
    close: () =>
      new Promise((resolve) => {
        stopDispatcher();
        for (const timer of state.timers) clearTimeout(timer);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function handle(sandbox: Sandbox, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://sandbox.local');
  const path = url.pathname;
  if (path === '/healthz') return sendJson(response, { status: 200, body: { status: 'ok' } });
  if (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`)) return handleApi(sandbox, request, response, url);
  if (path.startsWith('/_sandbox')) return handleSandbox(sandbox, request, response, url);
  sendJson(response, errorReply(notFound('Not found. The Merchant API is under /merchant/v1.'), newRequestId()));
}

async function handleApi(sandbox: Sandbox, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const requestId = newRequestId();
  const started = Date.now();
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('PrintaRex-Api-Version', sandbox.config.apiVersion);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  const method = request.method ?? 'GET';
  const path = url.pathname.slice(BASE_PATH.length) || '/';
  let reply: Reply;
  let rateHeaders: Record<string, string> = {};
  try {
    if (Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      throw new ApiError('payload_too_large', 'The request body is too large.');
    }
    const rawBody = await readBody(request);
    if (rawBody === 'too_large') throw new ApiError('payload_too_large', 'The request body is too large or too deeply nested.');
    const principal = authenticateRequest(sandbox, request, url);
    const match = matchRoute(API_ROUTES, method, path);
    rateHeaders = consumeRateLimit(sandbox.state, principal.key, match?.route.rateClass ?? 'general');
    if (!match) throw new ApiError('forbidden_scope', AUTH_MESSAGES.forbidden_scope);
    const apiRoute = match.route;
    requireScope(principal, apiRoute.scope);
    const ctx: RequestContext = { method, path, query: url.searchParams, params: match.params, headers: request.headers, rawBody, requestId };
    checkVersion(sandbox, ctx);
    checkContentType(ctx, apiRoute);
    takeInjectedFault(sandbox, apiRoute.key);
    reply = apiRoute.handler({ sandbox, ctx, principal });
  } catch (error) {
    reply = errorReply(asApiError(error), requestId);
  }
  reply.headers = { ...rateHeaders, ...reply.headers };
  sendJson(response, reply);
  sandbox.log(`${method} ${url.pathname} -> ${reply.status} (${Date.now() - started} ms)`);
}

/** An API key in the query string is refused even when valid: it leaks into logs. A 401 always names the Bearer scheme. */
function authenticateRequest(sandbox: Sandbox, request: IncomingMessage, url: URL): Principal {
  try {
    if (KEY_IN_QUERY_PATTERN.test(url.search) || KEY_IN_QUERY_PATTERN.test(safeDecode(url.search))) {
      throw new ApiError('unauthorized', AUTH_MESSAGES.unauthorized);
    }
    return authenticate(sandbox.state, request.headers.authorization);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) error.headers['WWW-Authenticate'] = 'Bearer';
    throw error;
  }
}

/** Unexpected errors are logged here and answered without their details. */
function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  console.error('[sandbox] handler error', error);
  return new ApiError('internal_error', INTERNAL_ERROR_MESSAGE);
}

function checkVersion(sandbox: Sandbox, ctx: RequestContext): void {
  const requested = header(ctx, 'PrintaRex-Api-Version');
  if (requested === undefined) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested) || requested !== sandbox.config.apiVersion) {
    throw new ApiError('validation_failed', `Unsupported API version. This deployment serves ${sandbox.config.apiVersion}.`, { field: 'PrintaRex-Api-Version' });
  }
}

function checkContentType(ctx: RequestContext, apiRoute: ApiRoute): void {
  const accept = header(ctx, 'Accept');
  if (accept && !/(application\/json|application\/\*|\*\/\*)/i.test(accept)) {
    throw new ApiError('validation_failed', 'Use application/json for requests and responses.', { field: 'Accept' });
  }
  if (!apiRoute.consumes) return;
  const contentType = (header(ctx, 'Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!apiRoute.consumes.includes(contentType)) {
    throw new ApiError('validation_failed', 'Use application/json for requests and responses.', { field: 'Content-Type' });
  }
}

function takeInjectedFault(sandbox: Sandbox, routeKey: string): void {
  const index = sandbox.state.faults.findIndex((fault) => fault.route === null || fault.route === routeKey);
  if (index < 0) return;
  const fault = sandbox.state.faults[index];
  if (!fault) return;
  fault.remaining -= 1;
  if (fault.remaining <= 0) sandbox.state.faults.splice(index, 1);
  const status = statusOf(fault.code);
  throw new ApiError(fault.code, faultMessage(fault.code), { retryAfterSeconds: status === 429 || status === 503 ? 30 : undefined });
}

async function handleSandbox(sandbox: Sandbox, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method ?? 'GET';
  const path = url.pathname.replace(/\/$/, '') || '/';
  const requestId = newRequestId();
  const refusal = refuseForeignRequest(sandbox.config, request.headers);
  if (refusal) {
    response.setHeader('Cache-Control', 'no-store');
    return sendJson(response, errorReply(refusal, requestId));
  }
  const imageMatch = /^\/_sandbox\/images\/(prd_[0-9a-f]{32})\/(\d+)\.png$/.exec(path);
  if (method === 'GET' && imageMatch) return serveImage(sandbox, response, url, imageMatch[1] ?? '', Number(imageMatch[2]));
  if (method === 'GET' && path === '/_sandbox/openapi.yaml') {
    response.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8' }).end(CONTRACT);
    return;
  }
  const portalMatch = /^\/_sandbox\/portal\/orders\/(ord_[0-9a-f]{32})$/.exec(path);
  if (method === 'GET' && portalMatch) {
    const page = renderPortalPage(sandbox, portalMatch[1] ?? '');
    response
      .writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': page.contentSecurityPolicy,
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
      })
      .end(page.html);
    return;
  }
  response.setHeader('Cache-Control', 'no-store');
  const rawBody = await readBody(request);
  if (rawBody === 'too_large') return sendJson(response, errorReply(new ApiError('payload_too_large', 'The request body is too large.'), requestId));
  const ctx: RequestContext = { method, path, query: url.searchParams, params: {}, headers: request.headers, rawBody, requestId };
  let reply: Reply;
  try {
    reply = handleControl(sandbox, ctx, () => resetState(sandbox, createState(sandbox.config))) ?? errorReply(notFound('Unknown sandbox control endpoint. See the sandbox README.'), requestId);
  } catch (error) {
    reply = errorReply(asApiError(error), requestId);
  }
  sendJson(response, reply);
}

function serveImage(sandbox: Sandbox, response: ServerResponse, url: URL, productId: string, position: number): void {
  const check = checkImageSignature(url.pathname, url.searchParams);
  const product = sandbox.state.products.get(productId);
  const image = product?.images.find((candidate) => candidate.position === position);
  if (check !== 'ok' || !image) {
    response.writeHead(403, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' }).end(check === 'expired' ? 'Link expired' : 'Forbidden');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' }).end(renderPng(image.swatchHex, position));
}

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
