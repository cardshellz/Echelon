/**
 * Physical-measure coercion helpers.
 *
 * catalog.product_variants stores weight/dims as numeric(10,2) so inch/pound
 * inputs round-trip exactly (6.00in = 152.40mm). The pg driver returns
 * numeric columns as strings; these helpers convert at the boundary so the
 * rest of the codebase keeps working with numbers.
 */

export function numericToNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function numericToNumberOrZero(value: string | number | null | undefined): number {
  return numericToNumber(value) ?? 0;
}
