import { arabicNameOf, citiesOf, normalizeCity, resolveCity, supportedCountries } from './cities.ts';
import type { Sandbox } from './context.ts';
import { ApiError, validationFailed } from './errors.ts';
import { jsonBody, type Reply, type RequestContext } from './http.ts';
import { formatCents } from './money.ts';
import { arr, isPresent, num, obj, type Present, str } from './shape.ts';
import { findPublishedVariant, sharedProviderGroupId } from './product-catalogue.ts';
import type { ProviderGroup, SandboxState } from './state.ts';
import { isVariantAvailable } from './views.ts';

const COUNTRY_PATTERN = /^[A-Z]{2}$/;

const ratesShape = obj({
  destination: obj({ country: str, state: str, city: str, postal_code: str }),
  items: arr(obj({ variant_id: str, quantity: num })),
});

export function shippingCents(group: ProviderGroup, totalQuantity: number): number {
  return group.firstItemCents + Math.max(0, totalQuantity - 1) * group.additionalItemCents;
}

type RatesRequest = { country: string; state: string; city: string; items: { variantId: string; quantity: number }[] };

export function getShippingRates(sandbox: Sandbox, ctx: RequestContext): Reply {
  const request = validateRatesRequest(jsonBody(ctx, ratesShape));
  const city = canonicalDestination(request);
  const { group, totalQuantity } = quotingGroup(sandbox.state, request.items);
  if (!group.coveredStates.has(city)) {
    throw new ApiError('destination_uncovered', 'PrintaRex cannot quote shipping to this destination.', { field: 'destination.city' });
  }
  const currency = sandbox.state.store.currency;
  return {
    status: 200,
    body: {
      currency,
      methods: [
        {
          code: 'standard',
          name: 'Standard shipping',
          amount: formatCents(shippingCents(group, totalQuantity)),
          currency,
          delivery_days: { min: group.deliveryDays.min, max: group.deliveryDays.max },
        },
      ],
      production_time: { days: group.deliveryDays.max },
    },
  };
}

function validateRatesRequest(body: Present<typeof ratesShape>): RatesRequest {
  const destination = body.destination;
  if (!destination) throw validationFailed('destination is required.', 'destination');
  const country = destination.country;
  if (!country || !COUNTRY_PATTERN.test(country)) throw validationFailed('country must be an ISO 3166-1 alpha-2 code.', 'destination.country');
  const state = destination.state;
  if (!state?.trim()) throw validationFailed('state is required.', 'destination.state');
  const city = destination.city;
  if (!city?.trim()) throw validationFailed('city is required.', 'destination.city');
  const items = body.items ?? [];
  if (items.length === 0) throw validationFailed('items must contain at least one item.', 'items');
  if (items.length > 100) throw new ApiError('too_many_items', 'items can contain at most 100 items.', { field: 'items' });
  const lines = items.map((item, index) => {
    const quantity = item?.quantity;
    if (!isPresent(quantity) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) {
      throw validationFailed('quantity must be a whole number from 1 to 10000.', `items[${index}].quantity`);
    }
    const variantId = item?.variant_id;
    if (!variantId) throw validationFailed('variant_id is required.', `items[${index}].variant_id`);
    return { variantId, quantity };
  });
  return { country, state, city, items: lines };
}

/** The canonical city; the state must be a known coverage name too. */
function canonicalDestination(request: RatesRequest): string {
  const resolution = resolveCity(request.city, request.country);
  if (resolution.kind === 'unsupported_country') {
    throw new ApiError('destination_uncovered', 'PrintaRex does not ship to this country yet.', { field: 'destination.country' });
  }
  if (resolution.kind === 'unknown_city') throw new ApiError('address_invalid', 'The city is not in GET /shipping/coverage.', { field: 'destination.city' });
  if (!normalizeCity(request.state, request.country)) {
    throw new ApiError('address_invalid', 'The state is not in GET /shipping/coverage.', { field: 'destination.state' });
  }
  return resolution.city;
}

/** The single provider group shipping every item; a cart spanning groups cannot be quoted as one. */
function quotingGroup(state: SandboxState, items: RatesRequest['items']): { group: ProviderGroup; totalQuantity: number } {
  const products = items.map(({ variantId, quantity }, index) => {
    const field = `items[${index}].variant_id`;
    const { product, variant } = findPublishedVariant(state, variantId, field);
    if (!isVariantAvailable(product, variant) || (variant.quantity !== null && variant.quantity < quantity)) {
      throw new ApiError('variant_out_of_stock', 'This variant is not available in the requested quantity.', { field });
    }
    return product;
  });
  const groupId = sharedProviderGroupId(products);
  if (groupId === null) {
    throw new ApiError('multi_provider_cart', 'All items must ship from one provider group. Split the cart into one order per provider group.', { field: 'items' });
  }
  const group = state.providerGroups.get(groupId);
  if (!group) throw new ApiError('destination_uncovered', 'PrintaRex cannot quote shipping to this destination.', { field: 'destination.city' });
  return { group, totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0) };
}

export function getShippingCoverage(sandbox: Sandbox, ctx: RequestContext): Reply {
  const country = ctx.query.get('country') ?? sandbox.state.store.country;
  if (!COUNTRY_PATTERN.test(country)) throw validationFailed('country must be an ISO 3166-1 alpha-2 code.', 'country');
  if (!supportedCountries().includes(country)) return { status: 200, body: { countries: [] } };
  const states = citiesOf(country).map((name) => {
    const nameAr = arabicNameOf(country, name);
    return { name, name_ar: nameAr, cities: [{ name, name_ar: nameAr }] };
  });
  return { status: 200, body: { countries: [{ country, states }] } };
}
