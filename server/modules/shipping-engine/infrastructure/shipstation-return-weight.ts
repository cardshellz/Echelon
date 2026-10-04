import Decimal from "decimal.js";

const Exact = Decimal.clone({ precision: 50 });
const GRAMS_PER_POUND = "453.59237";
// Retain fractional pounds. Eight decimal places matched the live return quote
// and round up by less than 0.000005 g, without under-declaring product weight.
const POUND_DECIMAL_PLACES = 8;
// Observed label and shipment readbacks report 1.87 lb for the declared
// 1.87392923 lb (850 g). Accept only the exact two-decimal rounded
// representation, never an arbitrary tolerance.
const READBACK_POUND_DECIMAL_PLACES = 2;
const GRAMS_PER_UNIT = {
  gram: "1",
  kilogram: "1000",
  ounce: "28.349523125",
  pound: GRAMS_PER_POUND,
} as const;

export interface ShipStationReturnWeight {
  value: number | string;
  unit: keyof typeof GRAMS_PER_UNIT;
}

/** Canonical product grams remain unchanged; only the provider wire unit changes. */
export function shipStationReturnWeightPounds(weightGrams: number): number | null {
  if (!Number.isSafeInteger(weightGrams) || weightGrams <= 0) return null;
  const pounds = new Exact(weightGrams)
    .div(GRAMS_PER_POUND)
    .toDecimalPlaces(POUND_DECIMAL_PLACES, Decimal.ROUND_CEIL);
  const value = pounds.toNumber();
  // JSON numbers must preserve the declared decimal. Reject unrepresentable
  // magnitudes rather than silently losing weight precision at serialization.
  return Number.isFinite(value) && value > 0 && new Exact(value).eq(pounds)
    ? value
    : null;
}

/** Accept exact weights or the provider's two-decimal pound representation.
 * This does not change the declared weight, canonical grams or purchase limits.
 */
export function matchesShipStationReturnWeight(
  actual: ShipStationReturnWeight,
  weightGrams: number,
): boolean {
  if (!Number.isSafeInteger(weightGrams) || weightGrams <= 0) return false;
  let value: Decimal;
  try { value = new Exact(actual.value); } catch { return false; }
  if (!value.isFinite() || value.lessThanOrEqualTo(0)) return false;
  const gramsPerUnit = GRAMS_PER_UNIT[actual.unit];
  if (!gramsPerUnit) return false;
  const actualGrams = value.times(gramsPerUnit);
  if (actualGrams.eq(weightGrams)) return true;
  const pounds = shipStationReturnWeightPounds(weightGrams);
  if (pounds === null) return false;
  if (actualGrams.eq(new Exact(pounds).times(GRAMS_PER_POUND))) return true;
  return actual.unit === "pound" && value.eq(new Exact(pounds)
    .toDecimalPlaces(READBACK_POUND_DECIMAL_PLACES, Decimal.ROUND_HALF_UP));
}
