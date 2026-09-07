import type { DropshipProductCost, DropshipProductCostIssue, DropshipProductCostSource } from "../application/dropship-product-cost";

export interface ShellzClubCostOverride {
  id: unknown;
  variantId: unknown;
  productId: unknown;
  overrideType: unknown;
  fixedPrice: unknown;
  discountPercent: unknown;
}

export interface ShellzClubWholesaleAssignment {
  enabled: unknown;
  percentageBp: unknown;
  channelPolicies: readonly {
    mode: unknown; enabled: unknown; percentageBpOverride: unknown;
  }[];
}

export interface DropshipProductCostSnapshot {
  planId: string;
  shopifyVariantId: unknown;
  shopifyProductId: unknown;
  variants: readonly { id: unknown; productId: unknown; price: unknown }[];
  overrides: readonly ShellzClubCostOverride[];
  productCollectionIds: readonly unknown[];
  excludedCollectionIds: readonly unknown[];
  wholesaleAssignments: readonly ShellzClubWholesaleAssignment[];
  legacyFlatDiscountBp: unknown;
  legacyFlatDiscountPercent: unknown;
  fallbackChannelAvailable?: boolean;
}

const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const BASIS_POINTS = BigInt(10_000);

/** Accept only exact decimal representations; no floating-point price arithmetic. */
export function parseShellzClubDecimalCents(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,16}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  return cents <= MAX_SAFE_CENTS ? Number(cents) : null;
}

export function normalizeShopifyCostIdentity(value: unknown, kind: "Product" | "ProductVariant" | "Collection"): string | null {
  if (typeof value !== "string") return null;
  const raw = value.startsWith(`gid://shopify/${kind}/`) ? value.slice(`gid://shopify/${kind}/`.length) : value;
  return /^[1-9]\d{0,29}$/.test(raw) ? raw : null;
}

export function unavailableDropshipProductCost(
  issue: DropshipProductCostIssue, planId: string | null = null, overrideId: string | null = null,
): DropshipProductCost {
  return { status: "unavailable", unitCostCents: null, planId, source: null, overrideId, issue };
}

function parseBasisPoints(value: unknown): number | null {
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== "string" || !/^\d{1,5}$/.test(raw)) return null;
  const number = Number(raw);
  return number <= 10_000 ? number : null;
}

function resolveFallbackBasisPoints(input: DropshipProductCostSnapshot): number | null {
  if (input.fallbackChannelAvailable === false) return null;
  if (input.wholesaleAssignments.length > 1) return null;
  const assignment = input.wholesaleAssignments[0];
  if (!assignment) {
    if (input.legacyFlatDiscountBp != null) return parseBasisPoints(input.legacyFlatDiscountBp);
    if (input.legacyFlatDiscountPercent != null) {
      const bp = parseShellzClubDecimalCents(input.legacyFlatDiscountPercent);
      return bp !== null && bp <= 10_000 ? bp : null;
    }
    return 0;
  }
  if (typeof assignment.enabled !== "boolean" || assignment.channelPolicies.length > 1) return null;
  const policy = assignment.channelPolicies[0];
  if (policy) {
    if (typeof policy.enabled !== "boolean") return null;
    const mode = policy.mode ?? (policy.enabled ? "enabled" : "disabled");
    if (!["inherit", "enabled", "disabled", "override"].includes(String(mode))) return null;
    if (mode !== "inherit" && (mode === "disabled" || !policy.enabled)) return 0;
    // Match the owner: a positive channel override precedes the base assignment.
    if (mode === "override" && policy.percentageBpOverride != null) {
      const bp = parseBasisPoints(policy.percentageBpOverride);
      if (bp === null) return null;
      if (bp > 0) return bp;
    }
  }
  if (!assignment.enabled || assignment.percentageBp == null) return 0;
  return parseBasisPoints(assignment.percentageBp);
}

function discountedCents(retailCents: number, bp: number): number {
  const discount = (BigInt(retailCents) * BigInt(bp) + BASIS_POINTS / BigInt(2)) / BASIS_POINTS;
  return retailCents - Number(discount);
}

/** Mirrors Shellz Club's collection -> exact variant -> configured plan fallback precedence. */
export function resolveDropshipProductCost(input: DropshipProductCostSnapshot): DropshipProductCost {
  const unavailable = (issue: DropshipProductCostIssue, overrideId: string | null = null) =>
    unavailableDropshipProductCost(issue, input.planId, overrideId);
  const available = (unitCostCents: number, source: DropshipProductCostSource, overrideId: string | null = null): DropshipProductCost =>
    ({ status: "available", unitCostCents, planId: input.planId, source, overrideId, issue: null });
  const variantId = normalizeShopifyCostIdentity(input.shopifyVariantId, "ProductVariant");
  const productId = normalizeShopifyCostIdentity(input.shopifyProductId, "Product");
  if (!variantId || !productId || input.variants.length === 0) return unavailable("variant_unmapped");
  if (input.variants.length !== 1) return unavailable("variant_ambiguous");
  const variant = input.variants[0];
  if (normalizeShopifyCostIdentity(variant.id, "ProductVariant") !== variantId
    || normalizeShopifyCostIdentity(variant.productId, "Product") !== productId) return unavailable("variant_identity_mismatch");
  const retailCents = parseShellzClubDecimalCents(variant.price);
  const collections = input.productCollectionIds.map((id) => normalizeShopifyCostIdentity(id, "Collection"));
  const exclusions = input.excludedCollectionIds.map((id) => normalizeShopifyCostIdentity(id, "Collection"));
  if (collections.includes(null) || exclusions.includes(null)) return unavailable("pricing_configuration_invalid");
  if (collections.some((id) => exclusions.includes(id))) {
    return retailCents === null ? unavailable("retail_unavailable") : available(retailCents, "retail");
  }
  if (input.overrides.length > 1) return unavailable("override_ambiguous");
  const override = input.overrides[0];
  if (override) {
    const overrideId = typeof override.id === "string" && override.id.length > 0 ? override.id : null;
    if (!overrideId || normalizeShopifyCostIdentity(override.variantId, "ProductVariant") !== variantId
      || normalizeShopifyCostIdentity(override.productId, "Product") !== productId) return unavailable("variant_identity_mismatch", overrideId);
    if (override.overrideType === "fixed_price") {
      const cents = parseShellzClubDecimalCents(override.fixedPrice);
      return cents === null ? unavailable("override_invalid", overrideId) : available(cents, "variant_fixed_price", overrideId);
    }
    if (override.overrideType === "exclude") {
      return retailCents === null ? unavailable("retail_unavailable", overrideId) : available(retailCents, "retail", overrideId);
    }
    if (override.overrideType === "flat_percent") {
      const bp = parseShellzClubDecimalCents(override.discountPercent);
      if (bp === null || bp > 10_000) return unavailable("override_invalid", overrideId);
      return retailCents === null ? unavailable("retail_unavailable", overrideId)
        : available(discountedCents(retailCents, bp), "variant_percent", overrideId);
    }
    return unavailable("override_invalid", overrideId);
  }
  const bp = resolveFallbackBasisPoints(input);
  if (bp === null) return unavailable("pricing_configuration_invalid");
  if (retailCents === null) return unavailable("retail_unavailable");
  return bp > 0 ? available(discountedCents(retailCents, bp), "plan_percent") : available(retailCents, "retail");
}
