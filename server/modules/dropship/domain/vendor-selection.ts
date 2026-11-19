import {
  dropshipCatalogRuleMatchesVariant,
  normalizeCatalogCategory,
  type DropshipCatalogExposureDecision,
  type DropshipCatalogExposureScope,
  type DropshipCatalogExposureSubject,
  type DropshipCatalogVariantCandidate,
} from "./catalog-exposure";
import { DropshipError } from "./errors";

export type DropshipVendorSelectionScope = DropshipCatalogExposureScope;
export type DropshipVendorSelectionAction = "include" | "exclude";

export interface DropshipVendorSelectionRule {
  id?: number;
  vendorId?: number;
  scopeType: DropshipVendorSelectionScope;
  action: DropshipVendorSelectionAction;
  productLineId?: number | null;
  productId?: number | null;
  productVariantId?: number | null;
  category?: string | null;
  autoConnectNewSkus?: boolean | null;
  autoListNewSkus?: boolean | null;
  isActive?: boolean;
}

export interface DropshipVendorVariantOverride {
  productVariantId: number;
  enabledOverride?: boolean | null;
  marketplaceQuantityCap?: number | null;
}

/**
 * Why a size is or is not selected. The names are stored: preview blockers
 * `selection:<reason>` (dropship-listing-preview-service.ts), push job results
 * and stage 1 client words read them, so a not-picked size keeps the name
 * `missing_vendor_include_rule`. `excluded_by_vendor_rule` is never produced
 * since PR B (one-time picks have no keep-out rules); it stays in the union for
 * data stored before PR B.
 */
export type DropshipVendorCatalogSelectionReason =
  | "selected"
  | "not_exposed_by_admin"
  | "excluded_by_vendor_rule"
  | "missing_vendor_include_rule"
  | "disabled_by_vendor_override";

export interface DropshipVendorCatalogSelectionDecision {
  selected: boolean;
  reason: DropshipVendorCatalogSelectionReason;
  adminExposureReason: DropshipCatalogExposureDecision["reason"];
  /** The vendor's pick of this size, whatever the reason: a picked size Card Shellz stopped offering, or the vendor turned off, stays picked. */
  picked: boolean;
  /**
   * Always empty since PR B, and the two automation flags always false: picks
   * are one-time and add nothing by themselves. Kept one release so an older
   * stage 1 tab still parses a catalog row (client/src/lib/dropship-catalog-choose.ts).
   */
  includeRuleIds: number[];
  excludeRuleIds: number[];
  autoConnectNewSkus: boolean;
  autoListNewSkus: boolean;
  marketplaceQuantity: number;
  quantityCapApplied: boolean;
}

export interface EvaluateDropshipVendorCatalogSelectionInput {
  /** Not read since PR B (picks replace the rule match); kept so every caller passes one shape. */
  candidate: DropshipCatalogVariantCandidate;
  adminExposureDecision: DropshipCatalogExposureDecision;
  /** Whether the vendor picked this size (a row of `dropship.dropship_vendor_selected_variants`). */
  picked: boolean;
  rawAtpUnits: number;
  override?: DropshipVendorVariantOverride | null;
  /**
   * Legacy-only quantity authority. Canonical quantities already include the
   * exact target/SKU policy, so applying this cap again would create a second
   * formula that provider admission can overwrite.
   */
  applyMarketplaceQuantityCap?: boolean;
}

export function evaluateDropshipVendorCatalogSelection(
  input: EvaluateDropshipVendorCatalogSelectionInput,
): DropshipVendorCatalogSelectionDecision {
  const marketplaceQuantity = computeDropshipMarketplaceQuantity(
    input.rawAtpUnits,
    input.applyMarketplaceQuantityCap === false ? null : input.override,
  );
  const quantityCapApplied =
    input.applyMarketplaceQuantityCap !== false
    &&
    typeof input.override?.marketplaceQuantityCap === "number"
    && marketplaceQuantity < normalizeAtpUnits(input.rawAtpUnits);

  if (!input.adminExposureDecision.exposed) {
    return blockedSelectionDecision({
      reason: "not_exposed_by_admin",
      adminExposureReason: input.adminExposureDecision.reason,
      picked: input.picked,
    });
  }

  if (!input.picked) {
    return blockedSelectionDecision({
      reason: "missing_vendor_include_rule",
      adminExposureReason: input.adminExposureDecision.reason,
      picked: false,
    });
  }

  if (input.override?.enabledOverride === false) {
    return blockedSelectionDecision({
      reason: "disabled_by_vendor_override",
      adminExposureReason: input.adminExposureDecision.reason,
      picked: true,
    });
  }

  return {
    selected: true,
    reason: "selected",
    adminExposureReason: input.adminExposureDecision.reason,
    picked: true,
    includeRuleIds: [],
    excludeRuleIds: [],
    autoConnectNewSkus: false,
    autoListNewSkus: false,
    marketplaceQuantity,
    quantityCapApplied,
  };
}

/**
 * The frozen vendor rules' answer for one size (PLAN-B v4.1 §7.1, V36): some
 * active include rule matches it and no active exclude rule does, with the
 * rules A's evaluator counted (only rules with an id; a rule without one was
 * never saved). It is A's rule decision, VS:88-117 at cea5cb027, without the
 * exposure and override steps, which the evaluator still applies. Readers
 * decide from picks; this answers what the frozen rules chose, for the
 * conversion follow-up (§11.2) and tests.
 */
export function vendorRulesPick(
  rules: readonly DropshipVendorSelectionRule[],
  candidate: DropshipCatalogExposureSubject,
): boolean {
  const matching = rules.filter((rule) => rule.isActive !== false && dropshipCatalogRuleMatchesVariant(rule, candidate));
  const includeRuleIds = numericRuleIds(matching.filter((rule) => rule.action === "include"));
  const excludeRuleIds = numericRuleIds(matching.filter((rule) => rule.action === "exclude"));
  return includeRuleIds.length > 0 && excludeRuleIds.length === 0;
}

export function computeDropshipMarketplaceQuantity(
  rawAtpUnits: number,
  override?: DropshipVendorVariantOverride | null,
): number {
  const safeAtpUnits = normalizeAtpUnits(rawAtpUnits);
  const cap = override?.marketplaceQuantityCap;
  if (typeof cap === "number") {
    return Math.min(safeAtpUnits, Math.max(0, Math.floor(cap)));
  }
  return safeAtpUnits;
}

export function assertDropshipVendorSelectionRuleTarget(rule: DropshipVendorSelectionRule): void {
  const populatedTargets = [
    rule.productLineId,
    rule.productId,
    rule.productVariantId,
    normalizeCatalogCategory(rule.category),
  ].filter((value) => value !== null && value !== undefined);

  if (rule.scopeType === "catalog") {
    if (populatedTargets.length > 0) {
      throw new DropshipError(
        "DROPSHIP_VENDOR_SELECTION_RULE_TARGET_INVALID",
        "Catalog-wide vendor selection rules cannot include a specific target.",
        { scopeType: rule.scopeType },
      );
    }
    return;
  }

  const expectedTargetPresent =
    (rule.scopeType === "product_line" && typeof rule.productLineId === "number")
    || (rule.scopeType === "category" && normalizeCatalogCategory(rule.category) !== null)
    || (rule.scopeType === "product" && typeof rule.productId === "number")
    || (rule.scopeType === "variant" && typeof rule.productVariantId === "number");

  if (!expectedTargetPresent || populatedTargets.length !== 1) {
    throw new DropshipError(
      "DROPSHIP_VENDOR_SELECTION_RULE_TARGET_INVALID",
      "Vendor selection rule target does not match its scope.",
      { scopeType: rule.scopeType },
    );
  }
}

/** A size that is not selected lists nothing and its marketplace quantity is 0. */
function blockedSelectionDecision(input: {
  reason: Exclude<DropshipVendorCatalogSelectionReason, "selected" | "excluded_by_vendor_rule">;
  adminExposureReason: DropshipCatalogExposureDecision["reason"];
  picked: boolean;
}): DropshipVendorCatalogSelectionDecision {
  return {
    selected: false,
    reason: input.reason,
    adminExposureReason: input.adminExposureReason,
    picked: input.picked,
    includeRuleIds: [],
    excludeRuleIds: [],
    autoConnectNewSkus: false,
    autoListNewSkus: false,
    marketplaceQuantity: 0,
    quantityCapApplied: false,
  };
}

function numericRuleIds(rules: readonly DropshipVendorSelectionRule[]): number[] {
  return rules
    .map((rule) => rule.id)
    .filter((id): id is number => typeof id === "number");
}

function normalizeAtpUnits(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}
