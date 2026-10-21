export const AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/** Formats integer minor units as the API's two-decimal string. */
export function formatCents(cents: number): string {
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

export const formatNullableCents = (cents: number | null): string | null => (cents === null ? null : formatCents(cents));

/** Parses an amount that already matched {@link AMOUNT_PATTERN}. */
export function parseCents(amount: string): number {
  const [whole = '0', fraction = ''] = amount.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Card charges are made in whole units (the AFS rounding rule), rounded half up. */
export const roundToWholeUnits = (cents: number): number => Math.round(cents / 100) * 100;
