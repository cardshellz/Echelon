import { describe, expect, it } from "vitest";
import { calculateRulePrice, resolvePricingRule, pricingBasisCents, pricingImpactRowSchema, pricingProfileSchema, pricingRecipeSchema, type PricingProfile, type PricingRecipe } from "../../../../../shared/dropship/pricing-rules";
import { LISTING_PRICING_MODES, listingPriceFollowsRules, resolveListingPrice, saveListingPriceInputSchema, MAX_LISTING_PRICE_CENTS } from "../../../../../shared/dropship/listing-price";

const recipe: PricingRecipe = { basis: "product_cost", markupBps: 3000, flatCents: 100, rounding: "cent" };
const candidate = { productVariantId: 66, productId: 7, category: "Mailers", productLineIds: [2, 3] };
const profile: PricingProfile = { defaultRecipe: recipe, groups: [] };
describe("deterministic vendor pricing rules", () => {
  it.each([[3000, 0, 1052], [0, 200, 1009], [3000, 100, 1152]])("809 cents plus %s bps and %s cents = %s", (markupBps, flatCents, expected) => {
    expect(calculateRulePrice({ ...recipe, markupBps, flatCents }, 809).priceCents).toBe(expected);
  });
  it("rounds half-up once after exact arithmetic", () => {
    expect(calculateRulePrice({ ...recipe, markupBps: 5000, flatCents: 0 }, 1).priceCents).toBe(2);
    expect(calculateRulePrice({ ...recipe, markupBps: 1250, flatCents: 3 }, 895).priceCents).toBe(1010);
  });
  it.each([[99, 99], [100, 199], [198, 199], [199, 199], [200, 299], [1152, 1199]])("rounds %s upward to %s", (basis, expected) => {
    expect(calculateRulePrice({ ...recipe, markupBps: 0, flatCents: 0, rounding: "up_99" }, basis).priceCents).toBe(expected);
  });
  it.each([null, -1, 1.5, NaN, Infinity, MAX_LISTING_PRICE_CENTS + 1])("blocks invalid basis %s without retail fallback", (basis) => {
    expect(calculateRulePrice(recipe, basis)).toMatchObject({ priceCents: null, issue: "pricing_basis_unavailable" });
  });
  it("accepts a real zero cost plus a flat markup, but not a zero selling price", () => {
    expect(calculateRulePrice(recipe, 0).priceCents).toBe(100);
    expect(calculateRulePrice({ ...recipe, flatCents: 0 }, 0).issue).toBe("pricing_result_out_of_range");
  });
  it("detects integer storage overflow including rounding", () => {
    expect(calculateRulePrice(recipe, MAX_LISTING_PRICE_CENTS).issue).toBe("pricing_result_out_of_range");
    expect(calculateRulePrice({ ...recipe, markupBps: 0, flatCents: 0, rounding: "up_99" }, MAX_LISTING_PRICE_CENTS).issue).toBe("pricing_result_out_of_range");
  });
  it.each([{ markupBps: -1 }, { markupBps: 1.5 }, { flatCents: -1 }, { flatCents: 1.5 }, { markupBps: 1_000_001 }, { rounding: "down" }])("rejects invalid recipe %j", (invalid) => {
    expect(pricingRecipeSchema.safeParse({ ...recipe, ...invalid }).success).toBe(false);
  });
  it("uses the store default when no group matches", () => {
    expect(resolvePricingRule({ profile, candidate, productCostCents: 809, catalogRetailCents: 899 })).toMatchObject({ priceCents: 1152, ruleName: "Store default rule" });
  });
  it.each([{ type: "category", category: "Mailers" }, { type: "product_line", productLineId: 2 }, { type: "product", productId: 7 }, { type: "listings", productVariantIds: [66, 99] }] as const)("matches %j and never stacks recipes", (scope) => {
    const next = pricingProfileSchema.parse({ ...profile, groups: [{ id: "a", name: "Group", priority: 2, scope,
      recipe: { ...recipe, markupBps: 0, flatCents: 200 } }] });
    expect(resolvePricingRule({ profile: next, candidate, productCostCents: 809, catalogRetailCents: 899 }).priceCents).toBe(1009);
  });
  it("rejects tied winning priorities and ignores lower-priority ties", () => {
    const group = { id: "a", name: "A", priority: 10, scope: { type: "category" as const, category: "Mailers" }, recipe };
    const groups = [group, { ...group, id: "b" }];
    expect(resolvePricingRule({ profile: { ...profile, groups }, candidate, productCostCents: 809, catalogRetailCents: 899 }).issue).toBe("pricing_rule_priority_conflict");
    expect(resolvePricingRule({ profile: { ...profile, groups: [...groups, { ...group, id: "c", name: "Winner", priority: 1 }] },
      candidate, productCostCents: 809, catalogRetailCents: 899 }).ruleName).toBe("Winner");
  });
  it("allows catalog retail only when explicitly selected", () => {
    expect(resolvePricingRule({ profile, candidate, productCostCents: null, catalogRetailCents: 899 }).priceCents).toBeNull();
    expect(resolvePricingRule({ profile: { ...profile, defaultRecipe: { ...recipe, basis: "catalog_retail" } },
      candidate, productCostCents: null, catalogRetailCents: 899 }).priceCents).toBe(1269);
  });
  it("keeps typed and catalog choices, and lets the rules price everything else, including a price an earlier push saved", () => {
    const sources = { existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: { priceCents: 1152 } };
    expect(resolveListingPrice({ ...sources, saved: null })).toEqual({ effectivePriceCents: 1152, source: "rules" });
    expect(resolveListingPrice({ ...sources, saved: null, rulePrice: null })).toEqual({ effectivePriceCents: 999, source: "saved_listing" });
    expect(resolveListingPrice({ ...sources, saved: null, rulePrice: { priceCents: null } })).toEqual({ effectivePriceCents: null, source: "unavailable" });
    expect(resolveListingPrice({ ...sources, saved: { overridePriceCents: null } }).effectivePriceCents).toBe(899);
    expect(resolveListingPrice({ ...sources, saved: { overridePriceCents: 1399, pricingMode: "fixed" } }).effectivePriceCents).toBe(1399);
    expect(resolveListingPrice({ ...sources, saved: { overridePriceCents: null, pricingMode: "rules" } }).effectivePriceCents).toBe(1152);
    expect(resolveListingPrice({ ...sources, saved: null, existingListingPriceCents: null }).source).toBe("rules");
    expect(resolveListingPrice({ ...sources, saved: { overridePriceCents: null, pricingMode: "rules" }, rulePrice: null }).effectivePriceCents).toBeNull();
  });
  it("validates explicit ownership at the boundary", () => {
    const save = { expectedRevisionId: null, idempotencyKey: "test" };
    expect(saveListingPriceInputSchema.safeParse({ ...save, priceCents: 999, pricingMode: "rules" }).success).toBe(false);
    expect(saveListingPriceInputSchema.safeParse({ ...save, priceCents: null, pricingMode: "fixed" }).success).toBe(false);
    expect(saveListingPriceInputSchema.safeParse({ ...save, priceCents: null, pricingMode: "rules" }).success).toBe(true);
  });
  it("prices an inherit size by the rules when they give a price, else by retail, never by an earlier push (A3, L1)", () => {
    const sources = { existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: { priceCents: 1152 } };
    const inherit = { overridePriceCents: null, pricingMode: "inherit" as const };
    expect(resolveListingPrice({ ...sources, saved: inherit })).toEqual({ effectivePriceCents: 1152, source: "rules" });
    expect(listingPriceFollowsRules({ saved: inherit, rulePrice: sources.rulePrice })).toBe(true);
    // No rules: the retail price, even though an earlier push saved $9.99 on the listing.
    expect(resolveListingPrice({ ...sources, saved: inherit, rulePrice: null })).toEqual({ effectivePriceCents: 899, source: "catalog_default" });
    expect(listingPriceFollowsRules({ saved: inherit, rulePrice: null })).toBe(false);
    // Rules that can't price the size (a tie, no cost, out of range): retail too, not "unavailable".
    expect(resolveListingPrice({ ...sources, saved: inherit, rulePrice: { priceCents: null } })).toEqual({ effectivePriceCents: 899, source: "catalog_default" });
    expect(listingPriceFollowsRules({ saved: inherit, rulePrice: { priceCents: null } })).toBe(false);
    // No rule price and no retail: no price at all.
    expect(resolveListingPrice({ ...sources, saved: inherit, rulePrice: null, defaultPriceCents: null })).toEqual({ effectivePriceCents: null, source: "unavailable" });
    expect(resolveListingPrice({ ...sources, saved: inherit, rulePrice: { priceCents: null }, defaultPriceCents: null }))
      .toEqual({ effectivePriceCents: null, source: "unavailable" });
  });
  it("leaves rules and catalog default as they were next to inherit", () => {
    const sources = { existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: { priceCents: null } };
    expect(resolveListingPrice({ ...sources, saved: { overridePriceCents: null, pricingMode: "rules" } })).toEqual({ effectivePriceCents: null, source: "unavailable" });
    expect(listingPriceFollowsRules({ saved: { pricingMode: "rules" }, rulePrice: null })).toBe(true);
    expect(resolveListingPrice({ ...sources, saved: { overridePriceCents: null, pricingMode: "catalog_default" }, rulePrice: { priceCents: 1152 } }))
      .toEqual({ effectivePriceCents: 899, source: "catalog_default" });
    expect(listingPriceFollowsRules({ saved: { pricingMode: "catalog_default" }, rulePrice: { priceCents: 1152 } })).toBe(false);
    expect(LISTING_PRICING_MODES).toEqual(["fixed", "catalog_default", "rules", "inherit"]);
  });
  it("accepts inherit only without a price", () => {
    const save = { expectedRevisionId: 4, idempotencyKey: "inherit-1" };
    expect(saveListingPriceInputSchema.safeParse({ ...save, priceCents: null, pricingMode: "inherit" }).success).toBe(true);
    expect(saveListingPriceInputSchema.safeParse({ ...save, priceCents: 999, pricingMode: "inherit" }).success).toBe(false);
    expect(saveListingPriceInputSchema.safeParse({ ...save, priceCents: null, pricingMode: "auction" }).success).toBe(false);
  });
  it("does not mutate group ordering or candidates", () => {
    const before = JSON.stringify({ profile, candidate });
    resolvePricingRule({ profile, candidate, productCostCents: 809, catalogRetailCents: 899 });
    expect(JSON.stringify({ profile, candidate })).toBe(before);
  });
  it("names the amount each basis prices from, and the resolver uses that same amount", () => {
    const amounts = { productCostCents: 809, catalogRetailCents: 1249 };
    expect(pricingBasisCents("product_cost", amounts)).toBe(809);
    expect(pricingBasisCents("catalog_retail", amounts)).toBe(1249);
    expect(pricingBasisCents("catalog_retail", { productCostCents: 809, catalogRetailCents: null })).toBeNull();
    // 1249 × 1.2 = 1498.8, rounded half-up to 1499: the reviewed $14.99.
    const retail = { defaultRecipe: { basis: "catalog_retail" as const, markupBps: 2000, flatCents: 0, rounding: "cent" as const }, groups: [] };
    expect(resolvePricingRule({ profile: retail, candidate, ...amounts })).toMatchObject({ priceCents: 1499, basis: "catalog_retail" });
  });
});

describe("pricing review rows", () => {
  const row = { productVariantId: 66, title: "Easy Glide Soft Sleeves Standard", sku: "EG-SLV-STD-5PCK-B500",
    previousPriceCents: 1089, priceCents: 1499, productCostCents: 1089, ruleName: "Store default rule", preserved: false,
    issues: [], settingRevisionId: null, evidenceHash: "a".repeat(64) };
  it("still parses a row stored before rows carried the basis", () => {
    expect(pricingImpactRowSchema.parse(row)).toEqual(row);
  });
  it("carries the size, the basis and its amount, and non-blocking warnings", () => {
    const full = { ...row, sizeName: "Box of 5 Packs of 100", basis: "catalog_retail", basisCents: 1249, warnings: ["price_below_product_cost"] };
    expect(pricingImpactRowSchema.parse(full)).toEqual(full);
    expect(pricingImpactRowSchema.parse({ ...row, basis: null, basisCents: null })).toMatchObject({ basis: null, basisCents: null });
  });
  it.each([
    ["a negative amount", { basisCents: -1 }],
    ["a fractional amount", { basisCents: 12.5 }],
    ["an unknown basis", { basis: "msrp" }],
    ["an unknown field", { surprise: true }],
  ])("rejects %s", (_label, change) => {
    expect(pricingImpactRowSchema.safeParse({ ...row, ...change }).success).toBe(false);
  });
});
