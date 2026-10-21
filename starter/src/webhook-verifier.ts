import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifies `PrintaRex-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`.
 *
 * - Sign "<t>.<raw body>" with HMAC-SHA256; the key is the whole secret string, including `whsec_`.
 * - Use the raw request bytes. Parsing and re-serialising the JSON changes them and breaks the check.
 * - During a secret rotation two v1 values are sent; accept the request if any of them matches.
 * - Refuse timestamps more than 5 minutes from your clock (replay protection).
 */
export function verifyWebhookSignature(header: string | undefined, rawBody: Buffer, secrets: string[], nowSeconds = Date.now() / 1000): boolean {
  if (!header) return false;
  let timestamp = Number.NaN;
  const signatures: Buffer[] = [];
  for (const part of header.split(',')) {
    const [name, value = ''] = part.trim().split('=');
    if (name === 't') timestamp = Number(value);
    if (name === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(Buffer.from(value, 'hex'));
  }
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) return false;
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);
  return secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(signedPayload).digest();
    return signatures.some((signature) => timingSafeEqual(signature, expected));
  });
}
