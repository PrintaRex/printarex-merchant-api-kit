import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSandbox, type RunningSandbox } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { deliveryView, inventoryView, orderView, productView } from '../src/views.ts';

export type OrderBody = ReturnType<typeof orderView>;
export type ProductBody = ReturnType<typeof productView>;
export type InventoryBody = ReturnType<typeof inventoryView>;
export type DeliveryBody = ReturnType<typeof deliveryView>;
export type ShipmentBody = OrderBody['shipments'][number];
export type Page<Item> = { data: Item[]; next_cursor: string | null };
export type ErrorBody = { code: string; message: string; field: string | null; request_id: string; details?: { existing_order_id?: string } };

/** Every field a webhook `data` object can carry; an event holds the ones its type documents. */
export type EventData = {
  product?: ProductBody;
  changed?: string[];
  product_id?: string;
  website_product_id?: string | null;
  variants?: InventoryBody[];
  order?: OrderBody;
  previous_status?: string;
  retry_url?: string;
  charge?: { amount: string; currency: string; charged_at: string; invoice_url: string | null };
  shipment?: ShipmentBody;
  kind?: string;
  refund?: { status: string; amount: string | null; currency: string };
  reason_code?: string;
  message?: string;
  reason?: string;
  display_prefix?: string;
  expires_at?: string;
};

/** The JSON body of a webhook request, exactly as the merchant receives it. */
export type WebhookEnvelope = {
  id: string;
  type: string;
  api_version: string;
  created_at: string;
  attempt: number;
  sequence: number | null;
  store_id: string;
  data: EventData;
};

export type ReceivedEvent = WebhookEnvelope & {
  signatureValid: boolean;
  headers: Record<string, string | string[] | undefined>;
};

/** The envelope a received event carried, without the fields the harness added. */
export function envelopeOf(event: ReceivedEvent): WebhookEnvelope {
  const { signatureValid: _signatureValid, headers: _headers, ...envelope } = event;
  return envelope;
}

/** A merchant webhook endpoint that verifies every signature and can be told to fail. */
export class WebhookReceiver {
  events: ReceivedEvent[] = [];
  failNext = 0;
  secrets: string[] = [];
  private server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const envelope = JSON.parse(raw) as WebhookEnvelope;
      this.events.push({
        ...envelope,
        signatureValid: verifySignature(String(request.headers['printarex-signature'] ?? ''), raw, this.secrets),
        headers: request.headers,
      });
      if (this.failNext > 0) {
        this.failNext -= 1;
        response.writeHead(500).end();
        return;
      }
      response.writeHead(204).end();
    });
  });

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/webhooks`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  ofType(type: string): ReceivedEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  async waitFor(predicate: (event: ReceivedEvent) => boolean, timeoutMs = 3000): Promise<ReceivedEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.events.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for a webhook. Received: ${this.events.map((event) => event.type).join(', ')}`);
  }
}

/** The verification every merchant must implement: HMAC-SHA256 over "<t>.<raw body>", any v1 may match. */
export function verifySignature(header: string, rawBody: string, secrets: string[], toleranceSeconds = 300): boolean {
  const parts = header.split(',').map((part) => part.split('='));
  const timestamp = Number(parts.find(([name]) => name === 't')?.[1]);
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const given = parts.filter(([name]) => name === 'v1').map(([, value]) => Buffer.from(value ?? '', 'hex'));
  return secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
    return given.some((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected));
  });
}

export type Harness = {
  running: RunningSandbox;
  receiver: WebhookReceiver;
  baseUrl: string;
  fullKey: string;
  readOnlyKey: string;
  api: <Body = ErrorBody>(method: string, path: string, options?: ApiOptions) => Promise<ApiResponse<Body>>;
  control: <Body = ErrorBody>(method: string, path: string, body?: unknown) => Promise<ApiResponse<Body>>;
  stop: () => Promise<void>;
};

export type ApiOptions = { body?: unknown; key?: string | null; headers?: Record<string, string> };

/** `Body` is the shape the test expects for this call; it defaults to the error envelope, which every refusal shares. */
export type ApiResponse<Body = ErrorBody> = { status: number; headers: Headers; body: Body };

export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const receiver = new WebhookReceiver();
  const webhookUrl = await receiver.start();
  const config = loadConfig({
    SANDBOX_WEBHOOK_URL: webhookUrl,
    SANDBOX_ASYNC_STEP_MS: '20',
    SANDBOX_WEBHOOK_RETRY_SECONDS: '0.05,0.05,0.05,0.05,0.05,0.05,0.05',
    SANDBOX_CANCEL_AUTO_RESOLVE_MS: '150',
    SANDBOX_HELD_FIRST_ORDERS: '0',
    SANDBOX_LOG_REQUESTS: 'false',
    ...env,
  });
  receiver.secrets = [config.webhookSecret];
  const running = createSandbox(config);
  await new Promise<void>((resolve) => running.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
  running.sandbox.config.publicBaseUrl = baseUrl;
  running.sandbox.view.publicBaseUrl = baseUrl;

  const call = async <Body>(method: string, url: string, body: unknown, headers: Record<string, string>): Promise<ApiResponse<Body>> => {
    const response = await fetch(url, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : null) as Body };
  };
  return {
    running,
    receiver,
    baseUrl,
    fullKey: config.fullAccessKey,
    readOnlyKey: config.readOnlyKey,
    api: (method, path, options = {}) => {
      const key = options.key === undefined ? config.fullAccessKey : options.key;
      return call(method, `${baseUrl}/merchant/v1${path}`, options.body, {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...options.headers,
      });
    },
    control: (method, path, body) => call(method, `${baseUrl}/_sandbox${path}`, body, {}),
    stop: async () => {
      await running.close();
      await receiver.stop();
    },
  };
}

export function orderBody(variantId: string, overrides: Record<string, unknown> = {}, addressOverrides: Record<string, unknown> = {}) {
  return {
    external_order_id: `W-${Math.random().toString(36).slice(2, 10)}`,
    payment_status: 'paid',
    currency: 'AED',
    customer: { email: 'buyer@example.com' },
    shipping_address: {
      name: 'Sara Ahmed',
      phone: '+971501234567',
      address1: 'Marina Walk 1',
      city: 'Dubai',
      state: 'Dubai',
      country: 'AE',
      ...addressOverrides,
    },
    items: [{ variant_id: variantId, quantity: 1, unit_price: '79.00' }],
    ...overrides,
  };
}
