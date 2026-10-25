/**
 * FROZEN ORACLE: PR A's vendor selection evaluator, copied verbatim. Do not edit.
 *
 * Step 1 plan S2-5, PR B (PLAN-B v4.1 §7.1, V36; TESTS-2, SAFETY-12). PR B replaces the evaluator's
 * `rules` input with `picked`, after which no rules evaluator and no "stock selection under rules"
 * remains in the tree to compare with; the legacy matcher `vendorRulesPick` copies the evaluator's
 * rule branch, so a test against it alone would be circular. This copy is "A's evaluator" for B's
 * equivalence tests (vendor-selection.test.ts and the picks migration suite).
 *
 * Source: server/modules/dropship/domain/vendor-selection.ts at main
 * cea5cb0279982a5688dd96a712a0ed2f522f88af ("Merge pull request #1900").
 * Each region between a `<frozen-source>` marker pair is that file's text, byte for byte. Its sha256 is
 * `git show cea5cb027:server/modules/dropship/domain/vendor-selection.ts | sed -n '<from>,<to>p' | sha256sum`:
 *   lines 10-50   (selection types)            cc2c5ee08f1b4d8436aafc0ac05e07b5673cb3c60393c5540bafdb726933f5bb
 *   lines 52-141  (input and evaluator)        961d333228f15e28bd301d92d92e31b23143123ce97e202664777081b4f78ce3
 *   lines 143-153 (marketplace quantity)       40a8be61a07d4e5c31c2552311441cc90a3a658122baea6eddbd754f4f56c820
 *   lines 189-221 (private helpers)            168f548cd98a311550b20ef4fff394a4307a08e130929726dae8710f6be9d546
 * server/modules/dropship/__tests__/unit/vendor-selection.test.ts recomputes every region's sha256 and
 * pins the code outside the regions, so this oracle can never be edited silently.
 *
 * Not copied: the source's imports (lines 1-8; here they point at the same catalog-exposure module,
 * which PR B does not change) and `assertDropshipVendorSelectionRuleTarget` (lines 155-187), which the
 * evaluator does not call.
 */
import {
  dropshipCatalogRuleMatchesVariant,
  type DropshipCatalogExposureDecision,
  type DropshipCatalogExposureScope,
  type DropshipCatalogVariantCandidate,
} from "../../domain/catalog-exposure";

// <frozen-source lines="10-50">
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
  includeRuleIds: number[];
  excludeRuleIds: number[];
  autoConnectNewSkus: boolean;
  autoListNewSkus: boolean;
  marketplaceQuantity: number;
  quantityCapApplied: boolean;
}
// </frozen-source>

// <frozen-source lines="52-141">
export interface EvaluateDropshipVendorCatalogSelectionInput {
  candidate: DropshipCatalogVariantCandidate;
  adminExposureDecision: DropshipCatalogExposureDecision;
  rules: readonly DropshipVendorSelectionRule[];
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
      marketplaceQuantity: 0,
      quantityCapApplied: false,
    });
  }

  const activeRules = input.rules.filter((rule) => rule.isActive !== false);
  const matchingIncludeRules = activeRules.filter(
    (rule) => rule.action === "include" && dropshipCatalogRuleMatchesVariant(rule, input.candidate),
  );
  const matchingExcludeRules = activeRules.filter(
    (rule) => rule.action === "exclude" && dropshipCatalogRuleMatchesVariant(rule, input.candidate),
  );

  const includeRuleIds = numericRuleIds(matchingIncludeRules);
  const excludeRuleIds = numericRuleIds(matchingExcludeRules);

  if (excludeRuleIds.length > 0) {
    return blockedSelectionDecision({
      reason: "excluded_by_vendor_rule",
      adminExposureReason: input.adminExposureDecision.reason,
      includeRuleIds,
      excludeRuleIds,
      marketplaceQuantity: 0,
      quantityCapApplied: false,
    });
  }

  if (includeRuleIds.length === 0) {
    return blockedSelectionDecision({
      reason: "missing_vendor_include_rule",
      adminExposureReason: input.adminExposureDecision.reason,
      marketplaceQuantity: 0,
      quantityCapApplied: false,
    });
  }

  if (input.override?.enabledOverride === false) {
    return blockedSelectionDecision({
      reason: "disabled_by_vendor_override",
      adminExposureReason: input.adminExposureDecision.reason,
      includeRuleIds,
      excludeRuleIds,
      marketplaceQuantity: 0,
      quantityCapApplied: false,
    });
  }

  return {
    selected: true,
    reason: "selected",
    adminExposureReason: input.adminExposureDecision.reason,
    includeRuleIds,
    excludeRuleIds,
    autoConnectNewSkus: matchingIncludeRules.some((rule) => rule.autoConnectNewSkus !== false),
    autoListNewSkus: matchingIncludeRules.some((rule) => rule.autoListNewSkus === true),
    marketplaceQuantity,
    quantityCapApplied,
  };
}
// </frozen-source>

// <frozen-source lines="143-153">
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
// </frozen-source>

// <frozen-source lines="189-221">
function blockedSelectionDecision(input: {
  reason: Exclude<DropshipVendorCatalogSelectionReason, "selected">;
  adminExposureReason: DropshipCatalogExposureDecision["reason"];
  includeRuleIds?: number[];
  excludeRuleIds?: number[];
  marketplaceQuantity: number;
  quantityCapApplied: boolean;
}): DropshipVendorCatalogSelectionDecision {
  return {
    selected: false,
    reason: input.reason,
    adminExposureReason: input.adminExposureReason,
    includeRuleIds: input.includeRuleIds ?? [],
    excludeRuleIds: input.excludeRuleIds ?? [],
    autoConnectNewSkus: false,
    autoListNewSkus: false,
    marketplaceQuantity: input.marketplaceQuantity,
    quantityCapApplied: input.quantityCapApplied,
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
// </frozen-source>

/** A's evaluator under its oracle name: what every B equivalence test compares against. */
export const legacyEvaluateVendorSelection = evaluateDropshipVendorCatalogSelection;
export type LegacyVendorSelectionRule = DropshipVendorSelectionRule;
export type LegacyVendorSelectionInput = EvaluateDropshipVendorCatalogSelectionInput;
export type LegacyVendorSelectionDecision = DropshipVendorCatalogSelectionDecision;
