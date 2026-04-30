import { DropshipError } from "./errors";

export type DropshipCatalogExposureScope =
  | "catalog"
  | "product_line"
  | "category"
  | "product"
  | "variant";

export type DropshipCatalogExposureAction = "include" | "exclude";

export interface DropshipCatalogExposureRule {
  id?: number;
  scopeType: DropshipCatalogExposureScope;
  action: DropshipCatalogExposureAction;
  productLineId?: number | null;
  productId?: number | null;
  productVariantId?: number | null;
  category?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
}

export interface DropshipCatalogVariantCandidate {
  productId: number;
  productVariantId: number;
  productLineIds: readonly number[];
  category: string | null;
  productIsActive: boolean;
  variantIsActive: boolean;
}

export type DropshipCatalogExposureDecisionReason =
  | "exposed"
  | "inactive_product_or_variant"
  | "excluded_by_admin_rule"
  | "missing_include_rule";

export interface DropshipCatalogExposureDecision {
  exposed: boolean;
  reason: DropshipCatalogExposureDecisionReason;
  includeRuleIds: number[];
  excludeRuleIds: number[];
}

export function evaluateDropshipCatalogExposure(
  candidate: DropshipCatalogVariantCandidate,
  rules: readonly DropshipCatalogExposureRule[],
  now: Date,
): DropshipCatalogExposureDecision {
  if (!candidate.productIsActive || !candidate.variantIsActive) {
    return {
      exposed: false,
      reason: "inactive_product_or_variant",
      includeRuleIds: [],
      excludeRuleIds: [],
    };
  }

  const effectiveRules = rules.filter((rule) => isDropshipCatalogExposureRuleEffective(rule, now));
  const includeRuleIds = effectiveRules
    .filter((rule) => rule.action === "include" && dropshipCatalogRuleMatchesVariant(rule, candidate))
    .map((rule) => rule.id)
    .filter((id): id is number => typeof id === "number");
  const excludeRuleIds = effectiveRules
    .filter((rule) => rule.action === "exclude" && dropshipCatalogRuleMatchesVariant(rule, candidate))
    .map((rule) => rule.id)
    .filter((id): id is number => typeof id === "number");

  if (excludeRuleIds.length > 0) {
    return {
      exposed: false,
      reason: "excluded_by_admin_rule",
      includeRuleIds,
      excludeRuleIds,
    };
  }

  if (includeRuleIds.length === 0) {
    return {
      exposed: false,
      reason: "missing_include_rule",
      includeRuleIds,
      excludeRuleIds,
    };
  }

  return {
    exposed: true,
    reason: "exposed",
    includeRuleIds,
    excludeRuleIds,
  };
}

export function dropshipCatalogRuleMatchesVariant(
  rule: DropshipCatalogExposureRule,
  candidate: DropshipCatalogVariantCandidate,
): boolean {
  switch (rule.scopeType) {
    case "catalog":
      return true;
    case "product_line":
      return typeof rule.productLineId === "number"
        && candidate.productLineIds.includes(rule.productLineId);
    case "category":
      return normalizeCatalogCategory(rule.category) !== null
        && normalizeCatalogCategory(rule.category) === normalizeCatalogCategory(candidate.category);
    case "product":
      return rule.productId === candidate.productId;
    case "variant":
      return rule.productVariantId === candidate.productVariantId;
    default:
      return false;
  }
}

export function isDropshipCatalogExposureRuleEffective(
  rule: DropshipCatalogExposureRule,
  now: Date,
): boolean {
  if (rule.startsAt && rule.startsAt.getTime() > now.getTime()) {
    return false;
  }

  if (rule.endsAt && rule.endsAt.getTime() <= now.getTime()) {
    return false;
  }

  return true;
}

export function assertDropshipCatalogExposureRuleTarget(
  rule: DropshipCatalogExposureRule,
): void {
  const populatedTargets = [
    rule.productLineId,
    rule.productId,
    rule.productVariantId,
    normalizeCatalogCategory(rule.category),
  ].filter((value) => value !== null && value !== undefined);

  if (rule.scopeType === "catalog") {
    if (populatedTargets.length > 0) {
      throw new DropshipError(
        "DROPSHIP_CATALOG_RULE_TARGET_INVALID",
        "Catalog-wide dropship exposure rules cannot include a specific target.",
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
      "DROPSHIP_CATALOG_RULE_TARGET_INVALID",
      "Dropship catalog exposure rule target does not match its scope.",
      { scopeType: rule.scopeType },
    );
  }
}

export function normalizeCatalogCategory(category: string | null | undefined): string | null {
  const normalized = category?.trim().toLowerCase();
  return normalized ? normalized : null;
}
