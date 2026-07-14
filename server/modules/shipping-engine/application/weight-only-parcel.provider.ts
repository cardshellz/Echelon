import type {
  ShipmentLineInput,
  ShipmentParcelPlanResult,
} from "../domain/shipment";
import type { ShipmentParcelProvider } from "./shipment-parcel-provider";

export const WEIGHT_ONLY_PARCEL_PROVIDER = {
  name: "channel-weight",
  version: "1.0.0",
} as const;

const MINIMUM_RATING_WEIGHT_GRAMS = 1;

/**
 * Initial strategy: rate one shipment from already-resolved item weights. It
 * deliberately does not guess dimensions, boxes, or carton count.
 */
export function buildWeightOnlyParcelPlan(
  lines: readonly ShipmentLineInput[],
): ShipmentParcelPlanResult {
  if (lines.length === 0) {
    return { ok: false, errors: ["no shippable lines to rate"] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  let totalWeightGrams = 0;

  lines.forEach((line, index) => {
    const label = line.sku?.trim() || `line ${index + 1}`;
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      errors.push(`${label}: quantity must be a positive integer`);
      return;
    }
    if (
      line.unitWeightGrams == null
      || !Number.isFinite(line.unitWeightGrams)
      || line.unitWeightGrams <= 0
    ) {
      warnings.push(`${label}: missing weight excluded from rated shipment weight`);
      return;
    }
    if (line.weightSource === "channel_fallback") {
      warnings.push(`${label}: used channel weight because Echelon catalog weight is missing`);
    }
    totalWeightGrams += line.unitWeightGrams * line.quantity;
  });

  if (errors.length > 0) return { ok: false, errors };

  const roundedWeightGrams = Math.max(
    MINIMUM_RATING_WEIGHT_GRAMS,
    Math.ceil(totalWeightGrams),
  );
  if (!Number.isSafeInteger(roundedWeightGrams)) {
    return { ok: false, errors: ["shipment weight is outside the supported range"] };
  }
  if (totalWeightGrams === 0) {
    warnings.push("no usable item weights; applied 1g minimum rating weight");
  }

  return {
    ok: true,
    plan: {
      provider: WEIGHT_ONLY_PARCEL_PROVIDER,
      strategy: "single_weight_based_shipment",
      parcels: [{
        sequence: 1,
        source: "channel_weight",
        actualWeightGrams: roundedWeightGrams,
        billableWeightGrams: roundedWeightGrams,
        dimensions: null,
        shippingGroupCode: null,
      }],
      warnings,
    },
  };
}

export const weightOnlyParcelProvider: ShipmentParcelProvider = {
  provider: WEIGHT_ONLY_PARCEL_PROVIDER,
  async plan(lines) {
    return buildWeightOnlyParcelPlan(lines);
  },
};
