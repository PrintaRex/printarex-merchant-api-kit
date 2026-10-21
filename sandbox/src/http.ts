import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, INVALID_JSON } from './errors.ts';
import { isPlainObject, type BodyShape, parseObject, type Present } from './shape.ts';

export const MAX_BODY_BYTES = 262_144;

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

export type RequestContext = {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  rawBody: Buffer;
  requestId: string;
};

export type Route<C> = {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: (ctx: C) => Reply;
};

export function route<C>(method: string, template: string, handler: Route<C>['handler']): Route<C> {
  const paramNames: string[] = [];
  const source = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${source}$`), paramNames, handler };
}

/** Generic over the route type, so a caller's route extras (scope, rate class) survive the match. */
export function matchRoute<R extends Route<never>>(routes: readonly R[], method: string, path: string): { route: R; params: Record<string, string> } | null {
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const match = candidate.pattern.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    candidate.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1] ?? '');
    });
    return { route: candidate, params };
  }
  return null;
}

/** Reads the body, stopping one byte past the cap so an oversized body is detected without buffering it all. */
export async function readBody(request: IncomingMessage, cap = MAX_BODY_BYTES): Promise<Buffer | 'too_large'> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > cap) return 'too_large';
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parses a required JSON object body; the result is typed by the request shape. */
export function jsonBody<S extends BodyShape>(ctx: RequestContext, shape: S): Present<S> {
  const parsed = optionalJsonBody(ctx, shape);
  if (parsed === null) throw new ApiError('validation_failed', INVALID_JSON);
  return parsed;
}

/** Same as {@link jsonBody} but an empty body is allowed and returns null. */
export function optionalJsonBody<S extends BodyShape>(ctx: RequestContext, shape: S): Present<S> | null {
  const raw = parseJsonObject(ctx);
  return raw === null ? null : parseObject(raw, shape);
}

/** Parses the body as a JSON object without a shape check; an empty body returns null. */
export function parseJsonObject(ctx: RequestContext): Record<string, unknown> | null {
  if (ctx.rawBody.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.rawBody.toString('utf8'));
  } catch {
    throw new ApiError('validation_failed', INVALID_JSON);
  }
  if (!isPlainObject(parsed)) throw new ApiError('validation_failed', INVALID_JSON);
  return parsed;
}

export function sendJson(response: ServerResponse, reply: Reply): void {
  for (const [name, value] of Object.entries(reply.headers ?? {})) response.setHeader(name, value);
  if (reply.body === undefined) {
    response.writeHead(reply.status).end();
    return;
  }
  const payload = JSON.stringify(reply.body);
  response.setHeader('Content-Type', 'application/json');
  response.writeHead(reply.status).end(payload);
}

export function errorReply(error: ApiError, requestId: string): Reply {
  const body: Record<string, unknown> = {
    code: error.code,
    message: error.message,
    field: error.field,
    request_id: requestId,
  };
  if (error.details) body.details = error.details;
  const headers: Record<string, string> = { ...error.headers };
  if (error.retryAfterSeconds !== null) headers['Retry-After'] = String(error.retryAfterSeconds);
  return { status: error.status, body, headers };
}

export const header = (ctx: { headers: IncomingMessage['headers'] }, name: string): string | undefined => {
  const value = ctx.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};
