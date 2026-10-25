import type { DropshipVendorCatalogSelectionDecision } from "../../domain/vendor-selection";
import type { LegacyVendorSelectionDecision } from "./legacy-vendor-selection";

/**
 * What PR B's evaluator must answer for a size whose pick is what the frozen rules chose
 * (`vendorRulesPick`), given A's decision for it (the frozen oracle, legacy-vendor-selection.ts;
 * PLAN-B v4.1 §7.1). The same selection, exposure reason and marketplace quantity; A's keep-out
 * reason `excluded_by_vendor_rule` becomes the retained not-picked name `missing_vendor_include_rule`;
 * no rule ids and no automation flags, since picks are one-time. Keys in the evaluator's order, so two
 * decisions also compare as JSON text.
 */
export function legacyDecisionUnderPicks(
  legacy: LegacyVendorSelectionDecision,
  picked: boolean,
): DropshipVendorCatalogSelectionDecision {
  return {
    selected: legacy.selected,
    reason: legacy.reason === "excluded_by_vendor_rule" ? "missing_vendor_include_rule" : legacy.reason,
    adminExposureReason: legacy.adminExposureReason,
    picked,
    includeRuleIds: [],
    excludeRuleIds: [],
    autoConnectNewSkus: false,
    autoListNewSkus: false,
    marketplaceQuantity: legacy.marketplaceQuantity,
    quantityCapApplied: legacy.quantityCapApplied,
  };
}
