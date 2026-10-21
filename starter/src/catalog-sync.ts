import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StarterConfig } from './config.ts';
import type { Db, Listing } from './db.ts';
import type { ApiImage, ApiInventory, ApiProduct, PrintarexClient } from './printarex-client.ts';
import { allowedProtocols } from './safe-url.ts';

const PRODUCT_ID_PATTERN = /^prd_[0-9a-f]{32}$/;
const MAX_IMAGE_POSITION = 100;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 15_000;

export const IMAGE_CONTENT_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** Data from a payload that the website will not use. Unlike an expired link, fresh links cannot fix it. */
export class RefusedPayloadError extends Error {}

/** Product ids become file names, URL paths and object keys, so only the documented shape gets through. */
function assertProductId(productId: string): void {
  if (!PRODUCT_ID_PATTERN.test(productId)) throw new RefusedPayloadError('Refused a product id that is not prd_ followed by 32 hex characters');
}

function assertImagePosition(position: number): void {
  if (!Number.isInteger(position) || position < 1 || position > MAX_IMAGE_POSITION) {
    throw new RefusedPayloadError(`Refused image position ${JSON.stringify(position)}: it must be a whole number from 1 to ${MAX_IMAGE_POSITION}`);
  }
}

/** The file type is decided by the first bytes, never by the URL or the Content-Type header. */
function imageExtensionOf(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** Reads at most `maxBytes`: a body is cancelled as soon as it grows past the limit. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxBytes || !response.body) {
    await response.body?.cancel();
    throw new RefusedPayloadError(`Refused an image that is empty or larger than ${maxBytes / 1024 / 1024} MB`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new RefusedPayloadError(`Refused an image larger than ${maxBytes / 1024 / 1024} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The publish handshake.
 *
 * 1. `product.publish_requested` arrives with the primary image only.
 * 2. Download the image and HOST IT YOURSELF: PrintaRex links are signed and expire.
 * 3. Create the listing, then confirm it with your own product id and https URL.
 *    If you cannot list it, report a publish failure instead (the merchant sees the reason).
 * 4. `product.updated{changed:[images]}` brings the rest of the gallery.
 */
export class CatalogSync {
  private readonly config: StarterConfig;
  private readonly db: Db;
  private readonly client: PrintarexClient;
  private readonly imageProtocols: string[];

  constructor(config: StarterConfig, db: Db, client: PrintarexClient) {
    this.config = config;
    this.db = db;
    this.client = client;
    this.imageProtocols = allowedProtocols(config.apiBaseUrl);
  }

  async onPublishRequested(product: ApiProduct): Promise<void> {
    assertProductId(product.id);
    let websiteProductId: string;
    try {
      websiteProductId = await this.upsertListing(product);
    } catch (error) {
      // A listing that is already live stays live; only a first listing attempt is reported as failed.
      if (this.db.data.listings[product.id]?.listingState === 'confirmed') throw error;
      await this.client.reportPublishFailure(product.id, `The website could not create the listing: ${(error as Error).message}`.slice(0, 500));
      return;
    }
    const confirmed = await this.client.confirmProduct(product.id, websiteProductId, `${this.config.storefrontBaseUrl}/products/${websiteProductId}`);
    this.db.update((data) => {
      const listing = data.listings[product.id];
      if (listing) listing.listingState = confirmed.data.listing_state;
    });
  }

  async onProductUpdated(product: ApiProduct): Promise<void> {
    assertProductId(product.id);
    if (!this.db.data.listings[product.id]) return this.onPublishRequested(product);
    await this.upsertListing(product);
  }

  async onUnpublishRequested(productId: string): Promise<void> {
    assertProductId(productId);
    this.db.update((data) => {
      const listing = data.listings[productId];
      if (listing) listing.visible = false;
    });
    await this.client.reportRemoved(productId);
  }

  onDeleted(productId: string): void {
    assertProductId(productId);
    this.db.update((data) => {
      delete data.listings[productId];
    });
  }

  onInventoryUpdated(productId: string, variants: ApiInventory[]): void {
    assertProductId(productId);
    if (!this.db.data.listings[productId]) return;
    this.db.update((data) => {
      for (const update of variants) {
        const variant = data.listings[productId]?.variants.find((candidate) => candidate.id === update.variant_id);
        if (variant) variant.available = update.available;
      }
    });
  }

  /** Catches up on products published while the website was offline or missed a webhook. */
  async backfill(): Promise<number> {
    let cursor: string | undefined;
    let created = 0;
    do {
      const page = (await this.client.listProducts(cursor)).data;
      for (const product of page.data) {
        if (product.status !== 'published' || this.db.data.listings[product.id] || product.listing_state === 'failed') continue;
        await this.onPublishRequested(product);
        created += 1;
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return created;
  }

  /** Returns the website product id, which the confirmation sends back to PrintaRex. */
  private async upsertListing(product: ApiProduct): Promise<string> {
    const existing = this.db.data.listings[product.id];
    const websiteProductId = existing?.websiteProductId ?? `p-${product.id.slice(4, 16)}`;
    const images = await this.downloadImages(websiteProductId, product);
    const listing: Listing = {
      printarexProductId: product.id,
      websiteProductId,
      title: product.title,
      descriptionHtml: product.description_html,
      // Keep gallery images already hosted when an event carries only the primary image.
      images: images.length >= (existing?.images.length ?? 0) ? images : [...(existing?.images ?? images)],
      variants: product.variants.map((variant) => ({
        id: variant.id,
        label: [variant.color?.name, variant.size].filter(Boolean).join(' / ') || 'Default',
        price: variant.price,
        currency: variant.currency,
        available: variant.available,
        providerGroupId: variant.provider_group_id,
      })),
      productionCost: product.cost.production,
      visible: product.status === 'published',
      listingState: existing?.listingState ?? product.listing_state,
    };
    this.db.update((data) => {
      data.listings[product.id] = listing;
    });
    return websiteProductId;
  }

  /**
   * Image links are signed and expire, and a retried or late webhook can carry an old link.
   * If a download fails, read the product again for fresh links before giving up.
   */
  private async downloadImages(websiteProductId: string, product: ApiProduct): Promise<string[]> {
    const download = (images: ApiImage[]) => Promise.all(images.map((image) => this.downloadImage(websiteProductId, image.position, image.src)));
    try {
      return await download(product.images);
    } catch (error) {
      if (error instanceof RefusedPayloadError) throw error;
      const fresh = (await this.client.getProduct(product.id)).data;
      const freshImages = fresh.images.filter((image) => product.images.some((wanted) => wanted.position === image.position));
      return download(freshImages);
    }
  }

  /** Only the image types the shop can safely serve are kept, under a file name the website chose itself. */
  private async downloadImage(websiteProductId: string, position: number, src: string): Promise<string> {
    assertImagePosition(position);
    const url = this.checkedImageUrl(src);
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`image ${position} download failed with HTTP ${response.status}`);
    const bytes = await readCapped(response, MAX_IMAGE_BYTES);
    const extension = imageExtensionOf(bytes);
    if (!extension) throw new RefusedPayloadError(`Refused image ${position}: it is not a PNG, JPEG or WebP file`);
    const fileName = `${websiteProductId}-${position}.${extension}`;
    writeFileSync(join(this.db.imagesDir, fileName), bytes);
    return `/images/${fileName}`;
  }

  private checkedImageUrl(src: string): URL {
    let url: URL;
    try {
      url = new URL(src);
    } catch {
      throw new RefusedPayloadError('Refused an image link that is not a valid URL');
    }
    if (!this.imageProtocols.includes(url.protocol)) throw new RefusedPayloadError(`Refused an image link that uses ${url.protocol}`);
    const { imageHosts } = this.config;
    if (imageHosts.length > 0 && !imageHosts.includes(url.hostname)) throw new RefusedPayloadError(`Refused an image from ${url.hostname}: it is not in PRINTAREX_IMAGE_HOSTS`);
    return url;
  }
}
