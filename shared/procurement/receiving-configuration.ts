import { z } from "zod";
import { MAX_UNIT_QUANTITY } from "./unit-quantity";

const positiveInteger = z.number().int().positive().max(MAX_UNIT_QUANTITY);
export interface ReceivingConfigurationOption { id: number; unitsPerVariant: number }
export interface ReceivingConfigurationReview {
  ready: boolean;
  count: number | null;
  issue: { code: string; message: string } | null;
}

/** Options must already be restricted to the product's active catalog variants.
 * A piece total alone is not evidence of the configuration being received. */
export function reviewReceivingConfiguration(input: {
  pieces: number;
  variantId: number | null;
  recordedUnits: number | null;
  activeVariants: readonly ReceivingConfigurationOption[];
}): ReceivingConfigurationReview {
  const issue = (code: string, message: string): ReceivingConfigurationReview => ({ ready: false, count: null, issue: { code, message } });
  if (!positiveInteger.safeParse(input.pieces).success) return issue("INVALID_RECEIVING_UNIT_QUANTITY", "Enter a positive whole piece count within the supported range.");
  if (input.variantId === null) return issue("RECEIVING_VARIANT_SELECTION_REQUIRED", input.activeVariants.length
    ? "Choose and save the product configuration that will arrive before booking or shipping."
    : "Add the product's actual receiving configuration before booking or shipping.");
  const selected = input.activeVariants.find(variant => variant.id === input.variantId);
  if (!positiveInteger.safeParse(input.variantId).success || !selected) return issue("RECEIVING_VARIANT_REVIEW_REQUIRED", "The chosen configuration is missing, inactive or belongs to another product. Choose an active configuration for this product.");
  if (!positiveInteger.safeParse(input.recordedUnits).success) return issue("RECEIVING_UNIT_SNAPSHOT_REQUIRED", "Choose and save the configuration to record its pieces per unit.");
  if (!positiveInteger.safeParse(selected.unitsPerVariant).success || selected.unitsPerVariant !== input.recordedUnits) {
    return issue("RECEIVING_UNIT_SOURCE_CHANGED", "The configuration's piece count changed. Refresh, select it again and review the count.");
  }
  if (input.pieces % selected.unitsPerVariant !== 0) return issue("RECEIVING_UNIT_SELECTION_INEXACT", "The chosen configuration cannot represent these pieces as a whole count. Choose the configuration that actually contains these pieces, or a piece unit for loose goods.");
  return { ready: true, count: input.pieces / selected.unitsPerVariant, issue: null };
}
