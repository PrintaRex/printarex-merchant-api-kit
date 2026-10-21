const AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/** Unit price times quantity, in whole minor units, so no floating-point rounding can creep in. */
export function lineTotal(unitPrice: string, quantity: number): string {
  if (!AMOUNT_PATTERN.test(unitPrice)) throw new Error(`Unexpected price "${unitPrice}"`);
  const [whole = '0', fraction = ''] = unitPrice.split('.');
  const unitCents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const totalCents = unitCents * BigInt(quantity);
  return `${totalCents / 100n}.${String(totalCents % 100n).padStart(2, '0')}`;
}
