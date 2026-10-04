import Decimal from "decimal.js";

const Exact = Decimal.clone({ precision: 50 });
const GRAMS_PER_POUND = "453.59237";
// Merchant-directed normalization: quotes and new labels truncate pounds to
// two decimals. Canonical product grams and parcel limits remain unchanged.
const POUND_DECIMAL_PLACES = 2;
// Older attempts sent whole grams or pounds rounded up to eight decimals.
// Their provider readbacks may show only two decimals (850 g -> 1.87 lb).
const LEGACY_POUND_DECIMAL_PLACES = 8;
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

export type ShipStationReturnWeightVerificationMode = "purchase" | "recover";

/** Canonical product grams remain unchanged; only the provider wire unit changes. */
export function shipStationReturnWeightPounds(weightGrams: number): number | null {
  return roundedPounds(weightGrams, POUND_DECIMAL_PLACES, Decimal.ROUND_DOWN);
}

function roundedPounds(weightGrams: number, decimalPlaces: number, rounding: Decimal.Rounding): number | null {
  if (!Number.isSafeInteger(weightGrams) || weightGrams <= 0) return null;
  const pounds = new Exact(weightGrams)
    .div(GRAMS_PER_POUND)
    .toDecimalPlaces(decimalPlaces, rounding);
  const value = pounds.toNumber();
  // JSON numbers must preserve the declared decimal. Reject unrepresentable
  // magnitudes rather than silently losing weight precision at serialization.
  return Number.isFinite(value) && value > 0 && new Exact(value).eq(pounds)
    ? value
    : null;
}

/** Match the normalized declared weight. Historical formats are recovery-only. */
export function matchesShipStationReturnWeight(
  actual: ShipStationReturnWeight,
  weightGrams: number,
  mode: ShipStationReturnWeightVerificationMode = "purchase",
): boolean {
  if (!Number.isSafeInteger(weightGrams) || weightGrams <= 0) return false;
  let value: Decimal;
  try { value = new Exact(actual.value); } catch { return false; }
  if (!value.isFinite() || value.lessThanOrEqualTo(0)) return false;
  const gramsPerUnit = GRAMS_PER_UNIT[actual.unit];
  if (!gramsPerUnit) return false;
  const actualGrams = value.times(gramsPerUnit);
  const pounds = shipStationReturnWeightPounds(weightGrams);
  if (pounds !== null && actualGrams.eq(new Exact(pounds).times(GRAMS_PER_POUND))) return true;
  if (mode !== "recover") return false;
  // An already-paid label must remain recoverable after the outgoing format
  // changes. These exact historical formats must not relax new purchases.
  if (actualGrams.eq(weightGrams)) return true;
  const legacyPounds = roundedPounds(weightGrams, LEGACY_POUND_DECIMAL_PLACES, Decimal.ROUND_CEIL);
  if (legacyPounds === null) return false;
  if (actualGrams.eq(new Exact(legacyPounds).times(GRAMS_PER_POUND))) return true;
  return actual.unit === "pound" && value.eq(new Exact(legacyPounds)
    .toDecimalPlaces(POUND_DECIMAL_PLACES, Decimal.ROUND_HALF_UP));
}
