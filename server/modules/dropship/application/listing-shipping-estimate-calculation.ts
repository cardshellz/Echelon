import {
  listingShippingEstimateCalculationSchema,
  type ListingShippingEstimateCalculation,
} from "../../../../shared/dropship/listing-shipping-estimate";
import { DropshipError } from "../domain/errors";
import type { DropshipShippingCalculationResult } from "./dropship-shipping-quote-service";

/** Catalog facts a staff viewer needs to verify what was rated. */
export interface ListingShippingEstimateCalculationFact {
  sku: string | null;
  weightGrams: number | null;
}

export interface ListingShippingEstimateCalculationInput {
  result: DropshipShippingCalculationResult;
  originWarehouseId: number;
  items: readonly { productVariantId: number; quantity: number }[];
  facts: ReadonlyMap<number, ListingShippingEstimateCalculationFact>;
}

/**
 * Project the read-only shipping calculation into the staff-only evidence
 * block: which pricing source decided, the item weights that were submitted,
 * the cartons that were rated, the program / rate table / row that priced
 * them, and the fee arithmetic. Pure; validates its own output and refuses to
 * emit a block that fails the contract rather than showing partial evidence.
 */
export function buildListingShippingEstimateCalculation(
  input: ListingShippingEstimateCalculationInput,
): ListingShippingEstimateCalculation {
  const { result } = input;
  const pricing = result.pricing;
  const candidate = {
    pricingSource: pricing.source,
    cutoverMode: pricing.decision.mode,
    cutoverReasonCode: pricing.decision.reasonCode,
    originWarehouseId: input.originWarehouseId,
    items: input.items.map((item) => {
      const fact = input.facts.get(item.productVariantId);
      const unitWeightGrams = fact?.weightGrams ?? null;
      return {
        productVariantId: item.productVariantId,
        sku: fact?.sku ?? null,
        quantity: item.quantity,
        unitWeightGrams,
        lineWeightGrams: unitWeightGrams === null ? null : unitWeightGrams * item.quantity,
      };
    }),
    packages: result.cartonization.packages.map((carton) => ({
      packageSequence: carton.packageSequence,
      boxCode: carton.boxCode,
      weightGrams: carton.weightGrams,
      lengthMm: carton.lengthMm,
      widthMm: carton.widthMm,
      heightMm: carton.heightMm,
      items: carton.items.map((line) => ({
        productVariantId: line.productVariantId,
        quantity: line.quantity,
      })),
    })),
    rate: pricing.source === "shared"
      ? {
          source: "shared_engine" as const,
          rateBookId: pricing.quote.rateBookId,
          rateBookCode: pricing.quote.rateBookCode,
          rateTableId: pricing.quote.rateTableId,
          rateRowId: pricing.quote.selectedRate.rateRowId ?? null,
          serviceLevelCode: pricing.quote.selectedRate.serviceLevelCode,
          serviceLevelName: pricing.quote.selectedRate.displayName,
          zone: pricing.quote.resolvedZone,
          ratedWeightGrams: pricing.quote.ratedWeightGrams,
          chargeModel: pricing.quote.selectedRate.chargeModel,
          rowMaxShipmentWeightGrams: pricing.quote.selectedRate.maxShipmentWeightGrams,
          perStartedPoundCents: pricing.quote.selectedRate.perStartedPoundCents,
          billablePounds: pricing.quote.selectedRate.billablePounds,
          productPolicyApplied: pricing.quote.selectedRate.productPolicyApplied,
          policySteps: pricing.quote.selectedRate.calculationTrace.map((step) => ({
            kind: step.kind,
            ruleId: step.ruleId,
            label: step.label,
            amountCents: step.amountCents,
            skus: [...step.skus],
          })),
        }
      : {
          source: "legacy_rate_table" as const,
          zone: pricing.zone.zone,
          zoneRuleId: pricing.zone.zoneRuleId,
          packages: pricing.rateMatches.map((match) => ({
            packageSequence: match.packageSequence,
            rateTableId: match.rateTableId,
            carrier: match.carrier,
            service: match.service,
            rateCents: match.rateCents,
          })),
        },
    charges: {
      baseCents: result.baseRateCents,
      markupCents: result.markupCents,
      insuranceCents: result.insurancePoolCents,
      dunnageCents: result.dunnageCents,
      totalCents: result.totalShippingCents,
    },
    warnings: [
      ...result.cartonization.warnings,
      ...(pricing.source === "shared" ? pricing.quote.warnings : []),
    ],
  };
  const parsed = listingShippingEstimateCalculationSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new DropshipError(
      "DROPSHIP_LISTING_SHIPPING_CALCULATION_INVALID",
      "Listing shipping calculation detail failed its contract.",
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}
