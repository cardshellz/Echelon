import {
  dropshipCatalogRuleMatchesVariant,
  normalizeCatalogCategory,
  type DropshipCatalogExposureDecision,
  type DropshipCatalogExposureScope,
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

export interface EvaluateDropshipVendorCatalogSelectionInput {
  candidate: DropshipCatalogVariantCandidate;
  adminExposureDecision: DropshipCatalogExposureDecision;
  rules: readonly DropshipVendorSelectionRule[];
  rawAtpUnits: number;
  override?: DropshipVendorVariantOverride | null;
}

export function evaluateDropshipVendorCatalogSelection(
  input: EvaluateDropshipVendorCatalogSelectionInput,
): DropshipVendorCatalogSelectionDecision {
  const marketplaceQuantity = computeDropshipMarketplaceQuantity(input.rawAtpUnits, input.override);
  const quantityCapApplied =
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
