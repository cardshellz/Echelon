import { describe, expect, it } from "vitest";
import { calculateRulePrice, resolvePricingRule, pricingProfileSchema, pricingRecipeSchema, type PricingProfile, type PricingRecipe } from "../../../../../shared/dropship/pricing-rules";
import { resolveListingPrice, saveListingPriceInputSchema, MAX_LISTING_PRICE_CENTS } from "../../../../../shared/dropship/listing-price";

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
  it("preserves legacy fixed and catalog choices, and uses rules only on adoption or new listings", () => {
    const sources = { existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: { priceCents: 1152 } };
    expect(resolveListingPrice({ ...sources, saved: null }).effectivePriceCents).toBe(999);
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
  it("does not mutate group ordering or candidates", () => {
    const before = JSON.stringify({ profile, candidate });
    resolvePricingRule({ profile, candidate, productCostCents: 809, catalogRetailCents: 899 });
    expect(JSON.stringify({ profile, candidate })).toBe(before);
  });
});
