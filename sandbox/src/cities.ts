import { readFileSync } from 'node:fs';

/**
 * Canonical states and cities, copied from the PrintaRex platform data so that matching
 * behaves like production: trimmed, NFKC-normalised, whitespace-collapsed, lower-cased alias
 * lookup (English and Arabic), then a Levenshtein distance of at most 2 against canonical names.
 */
type CountryData = { cities: string[]; aliases?: Record<string, string>; arabicNames?: Record<string, string> };

const COUNTRY_NAMES: Record<string, string> = { AE: 'UAE', SA: 'Saudi Arabia', EG: 'Egypt' };
const MAX_DISTANCE = 2;

const data = JSON.parse(
  readFileSync(new URL('./data/canonical-cities.json', import.meta.url), 'utf8'),
) as Record<string, CountryData>;

const normalizeKey = (input: string): string => input.trim().normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
const containsArabic = (text: string): boolean => /\p{Script=Arabic}/u.test(text);

type CountryIndex = { cities: string[]; aliases: Map<string, string>; arabicNames: Map<string, string> };

const index = new Map<string, CountryIndex>();
for (const [code, name] of Object.entries(COUNTRY_NAMES)) {
  const country = data[name];
  if (!country) continue;
  const aliases = new Map<string, string>();
  for (const city of country.cities) aliases.set(normalizeKey(city), city);
  const arabicNames = new Map<string, string>();
  for (const [alias, city] of Object.entries(country.aliases ?? {})) {
    aliases.set(normalizeKey(alias), city);
    if (containsArabic(alias) && !arabicNames.has(city)) arabicNames.set(city, alias);
  }
  for (const [city, arabic] of Object.entries(country.arabicNames ?? {})) arabicNames.set(city, arabic);
  index.set(code, { cities: country.cities, aliases, arabicNames });
}

export const supportedCountries = (): string[] => [...index.keys()];

export const citiesOf = (country: string): string[] => index.get(country)?.cities ?? [];

export const arabicNameOf = (country: string, city: string): string | null => index.get(country)?.arabicNames.get(city) ?? null;

/** Returns the canonical city for a raw name, or null when it is not in the coverage list. */
export function normalizeCity(raw: string | null | undefined, country: string): string | null {
  const countryIndex = index.get(country);
  if (!raw || !raw.trim() || !countryIndex) return null;
  const key = normalizeKey(raw);
  const exact = countryIndex.aliases.get(key);
  if (exact) return exact;
  let best: string | null = null;
  let bestDistance = MAX_DISTANCE + 1;
  for (const city of countryIndex.cities) {
    const distance = levenshtein(key, normalizeKey(city));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = city;
    }
  }
  return bestDistance <= MAX_DISTANCE ? best : null;
}

export type CityResolution = { kind: 'found'; city: string } | { kind: 'unsupported_country' } | { kind: 'unknown_city' };

/** `normalizeCity` plus the reason it found nothing, so each endpoint can report its own error for the same lookup. */
export function resolveCity(raw: string | null | undefined, country: string): CityResolution {
  if (!supportedCountries().includes(country)) return { kind: 'unsupported_country' };
  const city = normalizeCity(raw, country);
  return city ? { kind: 'found', city } : { kind: 'unknown_city' };
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, column) => column);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    for (let column = 1; column <= b.length; column++) {
      const substitution = (previous[column - 1] ?? 0) + (a[row - 1] === b[column - 1] ? 0 : 1);
      current.push(Math.min((previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
