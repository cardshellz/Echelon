import { describe, expect, it } from "vitest";
import {
  normalizeShopifyCostIdentity, parseShellzClubDecimalCents, resolveDropshipProductCost,
  type DropshipProductCostSnapshot,
} from "../../domain/dropship-product-cost";

function snapshot(patch: Partial<DropshipProductCostSnapshot> = {}): DropshipProductCostSnapshot {
  return {
    planId: "plan-ops", shopifyVariantId: "45546128408735", shopifyProductId: "9305995968671",
    variants: [{ id: "45546128408735", productId: "9305995968671", price: "8.99" }],
    overrides: [{ id: "override-1", variantId: "45546128408735", productId: "9305995968671",
      overrideType: "fixed_price", fixedPrice: "8.09", discountPercent: null }],
    productCollectionIds: [], excludedCollectionIds: [], wholesaleAssignments: [],
    legacyFlatDiscountBp: null, legacyFlatDiscountPercent: null, ...patch,
  };
}

describe("exact Shellz Club product-cost resolution", () => {
  it("returns the configured fixed price per sellable variant, not a reverse-engineered discount", () => {
    const input = snapshot({ legacyFlatDiscountBp: 2500 });
    const before = structuredClone(input);
    expect(resolveDropshipProductCost(input)).toEqual({ status: "available", unitCostCents: 809,
      source: "variant_fixed_price", overrideId: "override-1", planId: "plan-ops", issue: null });
    expect(input).toEqual(before);
  });

  it("allows zero and above-retail exact fixed prices without clamping or multiplying pack contents", () => {
    for (const [price, cents] of [["0.00", 0], ["18.09", 1809]] as const) {
      const input = snapshot();
      input.overrides = [{ ...input.overrides[0], fixedPrice: price }];
      expect(resolveDropshipProductCost(input).unitCostCents).toBe(cents);
    }
  });

  it("does not require a retail number to reinterpret an already exact fixed price", () => {
    const input = snapshot();
    input.variants = [{ ...input.variants[0], price: null }];
    expect(resolveDropshipProductCost(input).unitCostCents).toBe(809);
  });

  it("normalizes numeric/GID identities, never SKU or a different product", () => {
    const input = snapshot({ shopifyVariantId: "gid://shopify/ProductVariant/45546128408735",
      shopifyProductId: "gid://shopify/Product/9305995968671" });
    expect(resolveDropshipProductCost(input).unitCostCents).toBe(809);
    input.variants = [{ ...input.variants[0], productId: "11" }];
    expect(resolveDropshipProductCost(input).issue).toBe("variant_identity_mismatch");
  });

  it.each([null, "", " 12", "012", "-12", "12e3", "gid://shopify/Product/12", 12])("rejects malformed variant identity %s", (id) => {
    expect(resolveDropshipProductCost(snapshot({ shopifyVariantId: id })).issue).toBe("variant_unmapped");
  });

  it("rejects missing or duplicate cache identities and duplicate active overrides", () => {
    const input = snapshot();
    expect(resolveDropshipProductCost({ ...input, variants: [] }).issue).toBe("variant_unmapped");
    expect(resolveDropshipProductCost({ ...input, variants: [...input.variants, ...input.variants] }).issue).toBe("variant_ambiguous");
    expect(resolveDropshipProductCost({ ...input, overrides: [...input.overrides, ...input.overrides] }).issue).toBe("override_ambiguous");
  });

  it("collection exclusions win before fixed overrides and normalize collection IDs", () => {
    expect(resolveDropshipProductCost(snapshot({ productCollectionIds: ["gid://shopify/Collection/9"],
      excludedCollectionIds: ["9"] }))).toMatchObject({ status: "available", source: "retail", unitCostCents: 899, overrideId: null });
  });

  it("rejects malformed collection configuration rather than bypassing exclusions", () => {
    expect(resolveDropshipProductCost(snapshot({ excludedCollectionIds: ["no-id"] })).issue).toBe("pricing_configuration_invalid");
  });

  it("variant exclude returns retail and retains override provenance", () => {
    const input = snapshot();
    input.overrides = [{ ...input.overrides[0], overrideType: "exclude" }];
    expect(resolveDropshipProductCost(input)).toMatchObject({ unitCostCents: 899, source: "retail", overrideId: "override-1" });
  });

  it("rounds discount half-up, not the discounted remainder", () => {
    const input = snapshot();
    input.variants = [{ ...input.variants[0], price: "8.95" }];
    input.overrides = [{ ...input.overrides[0], overrideType: "flat_percent", discountPercent: "10.00" }];
    expect(resolveDropshipProductCost(input)).toMatchObject({ unitCostCents: 805, source: "variant_percent" });
  });

  it.each(["-1.00", "8.001", "8.09oops", "8e2", "Infinity", "NaN", "90071992547409.92", 8.09, null])("does not invent a fallback for malformed fixed price %s", (price) => {
    const input = snapshot({ legacyFlatDiscountBp: 5000 });
    input.overrides = [{ ...input.overrides[0], fixedPrice: price }];
    expect(resolveDropshipProductCost(input).issue).toBe("override_invalid");
  });

  it("rejects unknown override type and wrong product or variant", () => {
    for (const patch of [{ overrideType: "promotional" }, { productId: "22" }, { variantId: "33" }]) {
      const input = snapshot();
      input.overrides = [{ ...input.overrides[0], ...patch }];
      expect(resolveDropshipProductCost(input).status).toBe("unavailable");
    }
  });

  it("uses only a configured fallback percentage, preferring basis points to legacy percent", () => {
    expect(resolveDropshipProductCost(snapshot({ overrides: [], legacyFlatDiscountBp: 1000, legacyFlatDiscountPercent: "30" })))
      .toMatchObject({ unitCostCents: 809, source: "plan_percent" });
    expect(resolveDropshipProductCost(snapshot({ overrides: [], legacyFlatDiscountPercent: "10.00" })).unitCostCents).toBe(809);
    expect(resolveDropshipProductCost(snapshot({ overrides: [] }))).toMatchObject({ unitCostCents: 899, source: "retail" });
  });

  it("disabled or unvalued canonical assignment never falls back to the legacy discount", () => {
    for (const assignment of [{ enabled: false, percentageBp: 2000 }, { enabled: true, percentageBp: null }]) {
      expect(resolveDropshipProductCost(snapshot({ overrides: [], legacyFlatDiscountBp: 5000,
        wholesaleAssignments: [{ ...assignment, channelPolicies: [] }] })).unitCostCents).toBe(899);
    }
  });

  it("positive channel override precedes even a disabled base assignment, matching the owner", () => {
    expect(resolveDropshipProductCost(snapshot({ overrides: [], wholesaleAssignments: [{ enabled: false, percentageBp: 5000,
      channelPolicies: [{ mode: "override", enabled: true, percentageBpOverride: 1000 }] }] })).unitCostCents).toBe(809);
  });

  it("channel disabled wins; zero override and inherit fall back to assignment", () => {
    for (const [mode, enabled, override, cents] of [["disabled", true, 5000, 899], ["override", true, 0, 719], ["inherit", false, 5000, 719]] as const) {
      expect(resolveDropshipProductCost(snapshot({ overrides: [], wholesaleAssignments: [{ enabled: true, percentageBp: 2000,
        channelPolicies: [{ mode, enabled, percentageBpOverride: override }] }] })).unitCostCents).toBe(cents);
    }
  });

  it("rejects ambiguous canonical assignments/policies and out-of-range percentages", () => {
    const assignment = { enabled: true, percentageBp: 1000, channelPolicies: [] };
    expect(resolveDropshipProductCost(snapshot({ overrides: [], wholesaleAssignments: [assignment, assignment] })).issue).toBe("pricing_configuration_invalid");
    const policy = { mode: "enabled", enabled: true, percentageBpOverride: null };
    expect(resolveDropshipProductCost(snapshot({ overrides: [], wholesaleAssignments: [{ ...assignment, channelPolicies: [policy, policy] }] })).issue).toBe("pricing_configuration_invalid");
    expect(resolveDropshipProductCost(snapshot({ overrides: [], legacyFlatDiscountBp: 10001 })).issue).toBe("pricing_configuration_invalid");
  });

  it("unknown fallback channel blocks only fallback, not the exact variant price", () => {
    expect(resolveDropshipProductCost(snapshot({ fallbackChannelAvailable: false })).unitCostCents).toBe(809);
    expect(resolveDropshipProductCost(snapshot({ overrides: [], fallbackChannelAvailable: false })).issue).toBe("pricing_configuration_invalid");
  });

  it("requires retail for an exclusion or percentage and supports exact safe integer boundary", () => {
    const input = snapshot({ overrides: [] });
    input.variants = [{ ...input.variants[0], price: null }];
    expect(resolveDropshipProductCost(input).issue).toBe("retail_unavailable");
    expect(parseShellzClubDecimalCents("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseShellzClubDecimalCents("90071992547409.92")).toBeNull();
    expect(normalizeShopifyCostIdentity("gid://shopify/Product/9", "Product")).toBe("9");
  });
});
