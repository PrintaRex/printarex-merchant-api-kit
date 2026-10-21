import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Who may see or change what.
 *
 * - An order page link is a capability URL: whoever holds the link may view the order. The id in it
 *   is the secret, so it is 128 random bits and never derived from the time or a counter.
 * - The phone and cancel forms carry a token that only this server can make for that order, so
 *   another website cannot submit them for a buyer.
 */
export const newOrderId = (): string => `W-${randomBytes(16).toString('hex')}`;

export const ORDER_ID_PATTERN = /^W-[0-9a-f]{32}$/;

export const csrfTokenFor = (sessionSecret: string, orderId: string): string => createHmac('sha256', sessionSecret).update(orderId).digest('hex');

export const isValidCsrfToken = (sessionSecret: string, orderId: string, given: string | undefined): boolean =>
  given !== undefined && constantTimeEqual(given, csrfTokenFor(sessionSecret, orderId));

/** HTTP Basic (any user name, the token as the password) or a Bearer token. */
export function isAdminRequest(authorization: string | undefined, adminToken: string): boolean {
  const [, scheme = '', credentials = ''] = /^(\w+) (\S+)$/.exec(authorization ?? '') ?? [];
  if (scheme.toLowerCase() === 'bearer') return constantTimeEqual(credentials, adminToken);
  if (scheme.toLowerCase() !== 'basic') return false;
  const decoded = Buffer.from(credentials, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  return separator >= 0 && constantTimeEqual(decoded.slice(separator + 1), adminToken);
}

/** Compares hashes, so the time taken does not depend on the length or content of the guess. */
function constantTimeEqual(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
