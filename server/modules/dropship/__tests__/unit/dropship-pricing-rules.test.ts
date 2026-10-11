import { describe, expect, it } from "vitest";
import { calculateRulePrice, resolvePricingRule, pricingBasisCents, pricingImpactRowSchema, pricingProfileSchema, pricingRecipeSchema, type PricingProfile, type PricingRecipe } from "../../../../../shared/dropship/pricing-rules";
import { CATEGORY_PRICE_RULE_NAME, PRODUCT_PRICE_RULE_NAME, type PricingRuleCandidate, type RulePriceResult } from "../../../../../shared/dropship/pricing-rules";
import { matchesCatalogScope } from "../../../../../shared/dropship/catalog-scope";
import { LISTING_PRICING_MODES, listingPriceFollowsRules, resolveListingPrice, saveListingPriceInputSchema, MAX_LISTING_PRICE_CENTS } from "../../../../../shared/dropship/listing-price";

const recipe: PricingRecipe = { basis: "product_cost", markupBps: 3000, flatCents: 100, rounding: "cent" };
const candidate = { productVariantId: 66, productId: 7, category: "Mailers", categoryId: null, productLineIds: [2, 3] };
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
  it("puts an inherit size on its retail price when a blocking Card Shellz limit refuses the rule price (L1)", () => {
    const sources = { existingListingPriceCents: 999, defaultPriceCents: 899 };
    const inherit = { overridePriceCents: null, pricingMode: "inherit" as const };
    const blocked = { priceCents: 500, blockedByLimit: true };
    expect(listingPriceFollowsRules({ saved: inherit, rulePrice: blocked })).toBe(false);
    expect(resolveListingPrice({ ...sources, saved: inherit, rulePrice: blocked })).toEqual({ effectivePriceCents: 899, source: "catalog_default" });
    // With no retail price either, the size has no price; the earlier push's $9.99 is never used.
    expect(resolveListingPrice({ ...sources, saved: inherit, rulePrice: blocked, defaultPriceCents: null }))
      .toEqual({ effectivePriceCents: null, source: "unavailable" });
    // Not blocked, or not said: the rule price.
    expect(resolveListingPrice({ ...sources, saved: inherit, rulePrice: { priceCents: 500, blockedByLimit: false } }))
      .toEqual({ effectivePriceCents: 500, source: "rules" });
    // `rules`, a size with no setting and a typed price never read the flag.
    expect(resolveListingPrice({ ...sources, saved: { overridePriceCents: null, pricingMode: "rules" }, rulePrice: blocked }))
      .toEqual({ effectivePriceCents: 500, source: "rules" });
    expect(resolveListingPrice({ ...sources, saved: null, rulePrice: blocked })).toEqual({ effectivePriceCents: 500, source: "rules" });
    expect(resolveListingPrice({ ...sources, saved: { overridePriceCents: 1399, pricingMode: "fixed" }, rulePrice: blocked }))
      .toEqual({ effectivePriceCents: 1399, source: "override" });
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

/**
 * `resolvePricingRule` as it was before product and category prices (HEAD
 * 46dd3f11), word for word. Frozen here so the no-recipe path is compared
 * against the code it replaced, not against itself.
 */
function legacyResolvePricingRule(input: {
  profile: PricingProfile | null; candidate: PricingRuleCandidate;
  productCostCents: number | null; catalogRetailCents: number | null;
}): RulePriceResult {
  if (!input.profile) return { priceCents: null, ruleName: null, ruleId: null, issue: "pricing_rules_not_configured", basis: null };
  const matches = input.profile.groups.filter(({ scope }) => matchesCatalogScope(scope, input.candidate))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  if (matches.length > 1 && matches[0].priority === matches[1].priority) {
    return { priceCents: null, ruleName: null, ruleId: null, issue: "pricing_rule_priority_conflict", basis: null };
  }
  const winner = matches[0];
  const recipe = winner?.recipe ?? input.profile.defaultRecipe;
  return { ...calculateRulePrice(recipe, pricingBasisCents(recipe.basis, input)),
    ruleName: winner?.name ?? "Store default rule", ruleId: winner?.id ?? null };
}

describe("product and category prices in the rule order (listing settings design 5.1)", () => {
  const productRecipe: PricingRecipe = { basis: "product_cost", markupBps: 0, flatCents: 500, rounding: "cent" };
  const categoryRecipe: PricingRecipe = { basis: "catalog_retail", markupBps: 1000, flatCents: 0, rounding: "up_99" };
  const inCategory = { ...candidate, categoryId: 12 };
  const amounts = { productCostCents: 809, catalogRetailCents: 899 };
  type GroupRule = PricingProfile["groups"][number];
  const group = (id: string, priority: number, scope: GroupRule["scope"]): GroupRule =>
    ({ id, name: `Group ${id}`, priority, scope, recipe: { ...recipe, markupBps: 0, flatCents: 200 } });
  const groups = {
    none: [],
    category: [group("cat", 5, { type: "category", category: "Mailers" })],
    productLine: [group("line", 5, { type: "product_line", productLineId: 2 })],
    product: [group("prod", 5, { type: "product", productId: 7 })],
    listings: [group("pick", 1, { type: "listings", productVariantIds: [66] })],
    unmatched: [group("other", 5, { type: "category", category: "Binders" })],
    tie: [group("a", 5, { type: "category", category: "Mailers" }), group("b", 5, { type: "product_line", productLineId: 3 })],
  };
  const profiles: Array<[string, PricingProfile | null]> = [
    ["no profile", null], ...Object.entries(groups).map(([name, list]): [string, PricingProfile] => [name, { defaultRecipe: recipe, groups: list }]),
  ];

  it.each(profiles)("with no product or category price gives today's result, key for key: %s", (_name, current) => {
    for (const subject of [candidate, inCategory]) {
      for (const costs of [amounts, { productCostCents: null, catalogRetailCents: 899 }]) {
        const today = legacyResolvePricingRule({ profile: current, candidate: subject, ...costs });
        for (const recipes of [{}, { productRecipe: null, categoryRecipe: null }, { productRecipe: undefined, categoryRecipe: undefined }]) {
          const result = resolvePricingRule({ profile: current, candidate: subject, ...costs, ...recipes });
          expect(JSON.stringify(result)).toBe(JSON.stringify(today));
          // JSON drops an undefined key, so check the key is absent, not undefined.
          expect("ruleLevel" in result).toBe(false);
        }
      }
    }
  });

  it.each(profiles)("a product's own price beats every older group rule, a tie and the store default: %s", (_name, current) => {
    expect(resolvePricingRule({ profile: current, candidate: inCategory, ...amounts, productRecipe, categoryRecipe })).toEqual({
      priceCents: 1309, ruleName: PRODUCT_PRICE_RULE_NAME, ruleId: "product:7", issue: null, basis: "product_cost", ruleLevel: "product",
    });
  });

  it("an older group rule, or a tie, comes before the category price", () => {
    for (const list of [groups.category, groups.productLine, groups.product, groups.listings]) {
      expect(resolvePricingRule({ profile: { defaultRecipe: recipe, groups: list }, candidate: inCategory, ...amounts, categoryRecipe }))
        .toEqual({ priceCents: 1009, ruleName: list[0].name, ruleId: list[0].id, issue: null, basis: "product_cost" });
    }
    expect(resolvePricingRule({ profile: { defaultRecipe: recipe, groups: groups.tie }, candidate: inCategory, ...amounts, categoryRecipe }))
      .toEqual({ priceCents: null, ruleName: null, ruleId: null, issue: "pricing_rule_priority_conflict", basis: null });
  });

  it.each([["no profile", null], ["no matching group", { defaultRecipe: recipe, groups: groups.unmatched }]] as const)(
    "the category price comes before the store default: %s", (_name, current) => {
      // 899 + 10% = 988.9, rounded half-up to 989, then up to .99.
      expect(resolvePricingRule({ profile: current, candidate: inCategory, ...amounts, categoryRecipe })).toEqual({
        priceCents: 999, ruleName: CATEGORY_PRICE_RULE_NAME, ruleId: "category:12", issue: null, basis: "catalog_retail", ruleLevel: "category",
      });
    });

  it("names the level's own reason when its recipe cannot price the size", () => {
    expect(resolvePricingRule({ profile: null, candidate, productCostCents: null, catalogRetailCents: 899, productRecipe })).toEqual({
      priceCents: null, ruleName: PRODUCT_PRICE_RULE_NAME, ruleId: "product:7", issue: "pricing_basis_unavailable", basis: "product_cost",
      ruleLevel: "product",
    });
    expect(resolvePricingRule({ profile: null, candidate: inCategory, productCostCents: 809, catalogRetailCents: null, categoryRecipe }))
      .toMatchObject({ priceCents: null, ruleId: "category:12", issue: "pricing_basis_unavailable", ruleLevel: "category" });
  });

  it("refuses a category price for a size whose product has no Card Shellz category", () => {
    expect(() => resolvePricingRule({ profile, candidate, ...amounts, categoryRecipe })).toThrow(RangeError);
    // With no category price the same size resolves as always.
    expect(resolvePricingRule({ profile, candidate, ...amounts, categoryRecipe: null })).toMatchObject({ ruleName: "Store default rule" });
  });

  it("does not mutate the recipes or the candidate", () => {
    const before = JSON.stringify({ productRecipe, categoryRecipe, inCategory });
    resolvePricingRule({ profile, candidate: inCategory, ...amounts, productRecipe, categoryRecipe });
    resolvePricingRule({ profile: null, candidate: inCategory, ...amounts, categoryRecipe });
    expect(JSON.stringify({ productRecipe, categoryRecipe, inCategory })).toBe(before);
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
