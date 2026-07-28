import type { ShipmentWeightSource } from "./shipment";

export interface UnitWeightMeasurement {
  quantity: number;
  unitWeightGrams: number | null;
  weightSource?: ShipmentWeightSource;
}

/**
 * Returns the lowest whole-gram total supported by integer-gram unit weights.
 *
 * Shopify and Echelon persist a unit weight rounded to the nearest gram. When
 * those rounded units are multiplied before rating, the rounding error can
 * incorrectly cross a configured pound boundary (454 g x 2 versus a 907 g
 * two-pound ceiling). Subtracting half of the one-gram precision interval per
 * unit and rounding the aggregate up preserves a genuinely heavier single
 * unit while avoiding a higher charge caused only by accumulated storage
 * quantization.
 */
export function sumRateSelectionWeightGrams(
  lines: readonly UnitWeightMeasurement[],
): number | null {
  let lowerBoundGrams = 0;

  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) return null;
    if (
      line.unitWeightGrams === null
      || !Number.isFinite(line.unitWeightGrams)
      || line.unitWeightGrams <= 0
    ) {
      return null;
    }

    const extendedWeight = line.unitWeightGrams * line.quantity;
    if (!Number.isFinite(extendedWeight)) return null;

    lowerBoundGrams += extendedWeight;
    if (
      Number.isInteger(line.unitWeightGrams)
      && isIntegerGramSource(line.weightSource)
    ) {
      lowerBoundGrams -= line.quantity / 2;
    }
    if (!Number.isFinite(lowerBoundGrams)) return null;
  }

  const roundedWeight = Math.ceil(lowerBoundGrams);
  return Number.isSafeInteger(roundedWeight) && roundedWeight >= 0
    ? roundedWeight
    : null;
}

function isIntegerGramSource(source: ShipmentWeightSource | undefined): boolean {
  return source === "echelon_catalog" || source === "channel_fallback";
}
