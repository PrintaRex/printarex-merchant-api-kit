import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

/**
 * Product images are served by the sandbox itself behind expiring signed links, like the real
 * CDN links: a website must download and host them instead of hot-linking.
 */
const signingKey = randomBytes(32);
const IMAGE_SIZE = 480;

const signatureOf = (path: string, expires: number): string =>
  createHmac('sha256', signingKey).update(`${path}\n${expires}`).digest('base64url');

export function signedImageUrl(baseUrl: string, productId: string, position: number, expiresAt: Date): string {
  const path = `/_sandbox/images/${productId}/${position}.png`;
  const expires = Math.floor(expiresAt.getTime() / 1000);
  return `${baseUrl}${path}?expires=${expires}&signature=${signatureOf(path, expires)}`;
}

export type ImageCheck = 'ok' | 'expired' | 'invalid';

export function checkImageSignature(path: string, query: URLSearchParams, now = Date.now()): ImageCheck {
  const expires = Number(query.get('expires'));
  const signature = query.get('signature') ?? '';
  if (!Number.isInteger(expires)) return 'invalid';
  const expected = Buffer.from(signatureOf(path, expires));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  return expires * 1000 < now ? 'expired' : 'ok';
}

/** A solid-colour PNG with a lighter band, so each position of a product looks different. */
export function renderPng(hex: string, position: number): Buffer {
  const base = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const band = base.map((channel) => Math.min(255, channel + 40));
  const bandStart = Math.floor((IMAGE_SIZE / 6) * Math.min(position, 5));
  const rows: Buffer[] = [];
  for (let y = 0; y < IMAGE_SIZE; y++) {
    const row = Buffer.alloc(1 + IMAGE_SIZE * 3);
    const color = y >= bandStart && y < bandStart + IMAGE_SIZE / 6 ? band : base;
    for (let x = 0; x < IMAGE_SIZE; x++) row.set(color, 1 + x * 3);
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(IMAGE_SIZE, 0);
  header.writeUInt32BE(IMAGE_SIZE, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}
