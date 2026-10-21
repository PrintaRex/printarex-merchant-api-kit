import { createHash } from 'node:crypto';
import { citiesOf } from './cities.ts';
import { newProductId, newVariantId } from './ids.ts';
import type { Product, ProviderGroup, SandboxState, Variant } from './state.ts';

/**
 * Demo catalogue. Two provider groups exist so a website can test `multi_provider_cart`;
 * the second group does not ship to the last state of the country, so `destination_uncovered`
 * can be tested too.
 */
const providerGroupId = (providerId: string): string =>
  `pg_${createHash('sha256').update(`custom-api-provider-group:v1\n${providerId}`).digest('hex').slice(0, 16)}`;

export function seedProviderGroups(state: SandboxState): ProviderGroup[] {
  const states = citiesOf(state.store.country);
  const groups: ProviderGroup[] = [
    {
      id: providerGroupId('sandbox-provider-1'),
      label: 'Sandbox print partner 1 (ships everywhere)',
      coveredStates: new Set(states),
      firstItemCents: 1500,
      additionalItemCents: 500,
      deliveryDays: { min: 2, max: 4 },
    },
    {
      id: providerGroupId('sandbox-provider-2'),
      label: `Sandbox print partner 2 (does not ship to ${states.at(-1)})`,
      coveredStates: new Set(states.slice(0, -1)),
      firstItemCents: 1200,
      additionalItemCents: 400,
      deliveryDays: { min: 3, max: 5 },
    },
  ];
  for (const group of groups) state.providerGroups.set(group.id, group);
  return groups;
}

type Template = {
  title: string;
  type: string;
  description: string;
  tags: string[];
  colors: { name: string; hex: string }[];
  sizes: (string | null)[];
  priceCents: number;
  productionCents: number;
  brandingCents: number;
  baseDays: number;
  providerIndex: 0 | 1;
};

export const TEMPLATES = {
  tshirt: {
    title: 'Classic Crew T-Shirt',
    type: 'T-Shirt',
    description: '<p>Soft cotton crew-neck tee with your design printed on the front.</p>',
    tags: ['apparel', 'sandbox'],
    colors: [
      { name: 'White', hex: '#E9E9E9' },
      { name: 'Black', hex: '#2B2B2B' },
    ],
    sizes: ['S', 'M', 'L', 'XL'],
    priceCents: 7900,
    productionCents: 3200,
    brandingCents: 0,
    baseDays: 2,
    providerIndex: 0,
  },
  hoodie: {
    title: 'Pullover Hoodie',
    type: 'Hoodie',
    description: '<p>Midweight fleece hoodie with a front print.</p>',
    tags: ['apparel', 'sandbox'],
    colors: [{ name: 'Navy', hex: '#24324F' }],
    sizes: ['M', 'L'],
    priceCents: 14900,
    productionCents: 7400,
    brandingCents: 0,
    baseDays: 3,
    providerIndex: 0,
  },
  mug: {
    title: 'Ceramic Mug 11oz',
    type: 'Mug',
    description: '<p>Glossy white ceramic mug, dishwasher safe.</p>',
    tags: ['homeware', 'sandbox'],
    colors: [{ name: 'White', hex: '#F2F2F2' }],
    sizes: [null],
    priceCents: 4900,
    productionCents: 1800,
    brandingCents: 0,
    baseDays: 1,
    providerIndex: 1,
  },
  tote: {
    title: 'Canvas Tote Bag',
    type: 'Tote Bag',
    description: '<p>Natural cotton canvas tote with a one-side print.</p>',
    tags: ['accessories', 'sandbox'],
    colors: [{ name: 'Natural', hex: '#D9CBAE' }],
    sizes: [null],
    priceCents: 5900,
    productionCents: 2100,
    brandingCents: 0,
    baseDays: 2,
    providerIndex: 1,
  },
} satisfies Record<string, Template>;

export type TemplateName = keyof typeof TEMPLATES;
export const isTemplateName = (value: unknown): value is TemplateName => typeof value === 'string' && value in TEMPLATES;

/** Builds a published product; its listing state is set by the publish flow. */
export function buildProduct(state: SandboxState, templateName: TemplateName, now: Date): Product {
  const template: Template = TEMPLATES[templateName];
  const group = [...state.providerGroups.values()][template.providerIndex];
  if (!group) throw new Error('Provider groups are not seeded');
  const variants: Variant[] = [];
  for (const color of template.colors) {
    for (const size of template.sizes) {
      variants.push({
        id: newVariantId(),
        sku: [template.type, color.name, size].filter(Boolean).join('-').toUpperCase().replaceAll(' ', '-'),
        colorName: color.name,
        size,
        priceCents: template.priceCents,
        productionCents: template.productionCents,
        quantity: 500,
        syncFailed: false,
        updatedAt: now,
      });
    }
  }
  // One variant starts out of stock so `variant_out_of_stock` can be tested without setup.
  const lastVariant = variants.at(-1);
  if (lastVariant && variants.length > 1) lastVariant.quantity = 0;
  // Two images per colour; colour-specific only when the product has more than one colour.
  const images = template.colors
    .flatMap((color) => [color, color])
    .map((color, index) => ({ position: index + 1, colorName: template.colors.length > 1 ? color.name : null, swatchHex: color.hex }));
  return {
    id: newProductId(),
    status: 'published',
    title: template.title,
    descriptionHtml: template.description,
    tags: template.tags,
    type: template.type,
    providerGroupId: group.id,
    images,
    variants,
    baseDays: template.baseDays,
    bulkTiers: [{ minQuantity: 50, productionDays: template.baseDays + 3 }],
    brandingCents: template.brandingCents,
    orderFeeCents: 300,
    listingState: null,
    listingReason: null,
    websiteProductId: null,
    websiteUrl: null,
    updatedAt: now,
    sequence: 0,
  };
}
