import { describe, expect, it } from "vitest";
import { MAX_LISTING_PRICE_CENTS } from "../../../../../shared/dropship/listing-price";
import { listingRulesConversionCheckSchema } from "../../../../../shared/dropship/listing-rules-conversion";
import type { RulePriceResult } from "../../../../../shared/dropship/pricing-rules";
import { matchingContentGroups, prepareContentProfile, resolveContentTemplate } from "../../application/dropship-listing-content-resolver";
import type { DropshipListingCatalogCandidate } from "../../application/dropship-listing-preview-service";
import {
  RULES_CONVERSION_PLANNER_VERSION, checkRulesConversion, conversionAfterInputs, conversionCanonicalWrites, conversionCategoryNamesToRead,
  conversionCheckView, diffRulesConversion, planRulesConversion, selectedPricingRule, sizeOwnsPrice, sizePricingRule, todayWinners,
  type ConversionInputs, type SettingWinner,
} from "../../application/dropship-listing-rules-conversion";
import { buildListingSettingsFacts, type ListingSettingsInputs } from "../../application/dropship-listing-settings-facts";
import { createRulePriceResolver, rulePriceContextOf } from "../../application/dropship-rule-price";
import { DropshipError } from "../../domain/errors";
import {
  COST_PLUS_10, COST_PLUS_25, COST_PLUS_40, EBAY_SLEEVES, EBAY_STORE_DEFAULT, EBAY_TOPLOADERS, MAILERS, NO_PROFILE, RETAIL_PLUS_20,
  FIXTURE_CATALOG, SLEEVES, STORE, TOPLOADERS, UPDATED_AT, availableCost, byCategory, byProduct, byProductLine, bySizes, candidate,
  categoriesNamed, categoryRow, categoryRowsOf, contentState, conversionInputs, deepFreeze, ebayRulesState, inCategory, layersOf,
  listingInputs, pricingState, productRow, savedPrice,
} from "../fixtures/listing-rules-conversion.fixture";

/*
 * The conversion planner's plan (plan 4.A.4-4.A.6, 4.A.9 "Planner"):
 * today's winners from the resolvers the preview uses, the pricing rule a
 * size follows, what becomes what (one case per 4.A.4 row and its further
 * rules), the report (each item once, with its kind or setting), frozen
 * inputs and a fixed order. The after inputs, diff, blocks, hashes and
 * answer are tested in dropship-listing-rules-conversion-diff.test.ts.
 */

const NOW = new Date("2026-10-15T08:00:00.000Z");

const plan = (listing: ListingSettingsInputs, patch: Parameters<typeof conversionInputs>[1] = {}) =>
  planRulesConversion(conversionInputs(listing, patch));

function winnersById(listing: ListingSettingsInputs) {
  return new Map(todayWinners(listing).map((size) => [size.candidate.productVariantId, size]));
}

const ruleWon = (kind: string, id: string) => ({ type: "rule", rule: expect.objectContaining({ kind, id }) });
const own: SettingWinner = { type: "own" };
const tie: SettingWinner = { type: "tie" };
const none: SettingWinner = { type: "none" };

function expectInvariant(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DropshipError);
    expect((error as DropshipError).code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect((error as DropshipError).context).toMatchObject({ classification: "fatal", retryable: false });
    return;
  }
  throw new Error("Expected a fatal invariant failure.");
}

const resolverOf = (listing: ListingSettingsInputs) => createRulePriceResolver(rulePriceContextOf(listing.pricing, listing.layers));

describe("today's winners (plan 4.A.6)", () => {
  it("reads each size's price winner from the rule price resolver, leaving out sizes that own their price", () => {
    const listing = listingInputs([
      inCategory(SLEEVES, { productVariantId: 101, productId: 1 }),
      inCategory(SLEEVES, { productVariantId: 102, productId: 1 }),
      inCategory(SLEEVES, { productVariantId: 103, productId: 1 }),
      inCategory(TOPLOADERS, { productVariantId: 201, productId: 2 }),
      inCategory(MAILERS, { productVariantId: 301, productId: 3 }),
      candidate({ productVariantId: 401, productId: 4, category: "Binders" }),
      candidate({ productVariantId: 501, productId: 5 }),
    ], {
      pricing: pricingState([
        { id: "sleeves", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 },
        { id: "toploaders", priority: 10, scope: byCategory("Toploaders"), value: COST_PLUS_40 },
        { id: "binders-a", priority: 5, scope: byCategory("Binders"), value: COST_PLUS_40 },
        { id: "binders-b", priority: 5, scope: byCategory("Binders"), value: COST_PLUS_25 },
      ]),
      savedPrices: new Map([[102, savedPrice(102, { overridePriceCents: 1_500, pricingMode: "fixed" })],
        [103, savedPrice(103, { pricingMode: "rules" })]]),
      layers: layersOf([productRow(2, { price: RETAIL_PLUS_20 })], [categoryRow(MAILERS.id, { price: COST_PLUS_25 })]),
    });
    const winners = winnersById(listing);
    expect(winners.get(101)?.price).toEqual(ruleWon("price", "sleeves"));
    expect(winners.get(102)?.price).toBeNull();
    expect(winners.get(103)?.price).toEqual(ruleWon("price", "sleeves"));
    expect(winners.get(201)?.price).toEqual(own);
    // The category's own price wins only when no group matched: no older rule decides.
    expect(winners.get(301)?.price).toEqual(none);
    expect(winners.get(401)?.price).toEqual(tie);
    // The store default.
    expect(winners.get(501)?.price).toEqual(none);
  });

  it("leaves every size out of the price agreement when no rule covers it", () => {
    const winners = winnersById(listingInputs([candidate({ productVariantId: 101, productId: 1 })]));
    expect(winners.get(101)?.price).toBeNull();
  });

  it("reads the eBay category winner from the eBay category resolver", () => {
    const listing = listingInputs([
      inCategory(SLEEVES, { productVariantId: 101, productId: 1 }),
      inCategory(SLEEVES, { productVariantId: 201, productId: 2 }),
      inCategory(TOPLOADERS, { productVariantId: 301, productId: 3 }),
    ], {
      ebayCategoryRules: ebayRulesState([{ id: "sleeves", scope: byCategory("Sleeves"), category: EBAY_SLEEVES }]),
      layers: layersOf([productRow(2, { ebayCategory: EBAY_TOPLOADERS })]),
    });
    const winners = winnersById(listing);
    expect(winners.get(101)?.ebayCategory).toEqual(ruleWon("ebayCategory", "sleeves"));
    expect(winners.get(201)?.ebayCategory).toEqual(own);
    expect(winners.get(301)?.ebayCategory).toEqual(none);
  });

  it("reads text above and below each on its own, a part the product sets never reaching the groups", () => {
    const listing = listingInputs([
      candidate({ productVariantId: 101, productId: 1, productLineIds: [9] }),
      candidate({ productVariantId: 201, productId: 2, productLineIds: [9] }),
      candidate({ productVariantId: 301, productId: 3, category: "Tied" }),
      candidate({ productVariantId: 401, productId: 4 }),
    ], {
      content: contentState([
        { id: "line", priority: 2, scope: byProductLine(9), value: { introduction: "Line above", footer: "Line below" } },
        { id: "tied-a", priority: 1, scope: byCategory("Tied"), value: { introduction: "A", footer: "A" } },
        { id: "tied-b", priority: 1, scope: byCategory("Tied"), value: { introduction: "B", footer: "B" } },
      ]),
      layers: layersOf([productRow(2, { textAbove: { mode: "none" } })]),
    });
    const winners = winnersById(listing);
    expect([winners.get(101)?.textAbove, winners.get(101)?.textBelow]).toEqual([ruleWon("description", "line"), ruleWon("description", "line")]);
    expect([winners.get(201)?.textAbove, winners.get(201)?.textBelow]).toEqual([own, ruleWon("description", "line")]);
    expect([winners.get(301)?.textAbove, winners.get(301)?.textBelow]).toEqual([tie, tie]);
    expect([winners.get(401)?.textAbove, winners.get(401)?.textBelow]).toEqual([none, none]);
  });

  it("sorts sizes as the read model does", () => {
    const listing = listingInputs([
      candidate({ productVariantId: 3, productId: 2, productName: "pack 10", variantName: "B" }),
      candidate({ productVariantId: 2, productId: 1, productName: "Pack 2", variantName: "Size 10" }),
      candidate({ productVariantId: 1, productId: 1, productName: "Pack 2", variantName: "Size 9" }),
    ]);
    expect(todayWinners(listing).map((size) => size.candidate.productVariantId)).toEqual([1, 2, 3]);
    expect(buildListingSettingsFacts(listing).sizes.map((size) => size.price.productVariantId)).toEqual([1, 2, 3]);
  });
});

describe("the pricing rule a size follows (plan 3.2)", () => {
  it("is the same at every cost, known or not, priced or not", () => {
    const size = inCategory(SLEEVES, { productVariantId: 101, productId: 1 });
    const listing = listingInputs([size], {
      pricing: pricingState([{ id: "sleeves", name: "Sleeves rule", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 }]),
    });
    const resolver = resolverOf(listing);
    const rules = [null, 0, 1, 1_000, MAX_LISTING_PRICE_CENTS].map((cost) => selectedPricingRule(resolver.priceAtCost(size, cost), size, listing));
    for (const rule of rules) expect(rule).toEqual({ kind: "group", name: "Sleeves rule", recipe: COST_PLUS_40 });
  });

  it("reads the product's price, the category's, a tie, nothing, the store default and a group, in the resolver's order", () => {
    const size = inCategory(SLEEVES, { productVariantId: 101, productId: 1, productName: "Sleeves 100" });
    const listing = listingInputs([size], {
      pricing: pricingState([{ id: "g", name: "A group", priority: 1, scope: byCategory("Sleeves"), value: COST_PLUS_40 }]),
      layers: layersOf([productRow(1, { price: RETAIL_PLUS_20 })], [categoryRow(SLEEVES.id, { price: COST_PLUS_25 })]),
    });
    const at = (result: RulePriceResult, candidateValue: DropshipListingCatalogCandidate = size) =>
      selectedPricingRule(result, candidateValue, listing);
    const base: RulePriceResult = { priceCents: null, ruleName: null, ruleId: null, issue: "pricing_basis_unavailable", basis: null };
    expect(at({ ...base, ruleName: "Product price", ruleId: "product:1", ruleLevel: "product" }))
      .toEqual({ kind: "product", name: "Sleeves 100", recipe: RETAIL_PLUS_20 });
    expect(at({ ...base, ruleName: "Product price", ruleId: "product:1", ruleLevel: "product" }, { ...size, productName: "  " }))
      .toEqual({ kind: "product", name: "Product price", recipe: RETAIL_PLUS_20 });
    expect(at({ ...base, ruleName: "Category price", ruleId: "category:12", ruleLevel: "category" }))
      .toEqual({ kind: "category", name: "Sleeves", recipe: COST_PLUS_25 });
    expect(at({ ...base, issue: "pricing_rule_priority_conflict" })).toEqual({ kind: "tie" });
    expect(at({ ...base, issue: "pricing_rules_not_configured" })).toBeNull();
    expect(at({ ...base, ruleName: "Store default rule" })).toEqual({ kind: "store_default", name: "Store default rule", recipe: COST_PLUS_10 });
    expect(at({ ...base, ruleName: "A group", ruleId: "g" })).toEqual({ kind: "group", name: "A group", recipe: COST_PLUS_40 });
  });

  it("names the same rule the read model names for every size, and none where the size owns its price", () => {
    // Every size has a usable cost, so each size that follows the rules is rule-owned in the read model too, and each one that
    // owns its price (a typed price, the catalog default, a legacy row with or without a price) has no rule there: the
    // planner's sizeOwnsPrice copy and the read model must agree on every one.
    const sizes = [
      ...[101, 102, 103, 104, 105, 106, 107, 108].map((id) => inCategory(SLEEVES, { productVariantId: id, productId: 1 })),
      inCategory(TOPLOADERS, { productVariantId: 201, productId: 2 }),
      inCategory(MAILERS, { productVariantId: 301, productId: 3 }),
      candidate({ productVariantId: 401, productId: 4, category: "Binders" }),
      candidate({ productVariantId: 501, productId: 5 }),
    ];
    const listing = listingInputs(sizes, {
      pricing: pricingState([
        { id: "sleeves", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 },
        { id: "named", priority: 1, scope: bySizes(102), value: RETAIL_PLUS_20 },
      ]),
      layers: layersOf([productRow(2, { price: COST_PLUS_25 })], [categoryRow(MAILERS.id, { price: RETAIL_PLUS_20 })]),
      costs: new Map(sizes.map((size) => [size.productVariantId, availableCost(800)])),
      savedPrices: new Map([
        [103, savedPrice(103, { overridePriceCents: 1_500, pricingMode: "fixed" })],
        [104, savedPrice(104, { pricingMode: "catalog_default" })],
        [105, savedPrice(105, {})],
        [106, savedPrice(106, { overridePriceCents: 1_600 })],
        [107, savedPrice(107, { pricingMode: "rules" })],
        [108, savedPrice(108, { pricingMode: "inherit" })],
      ]),
    });
    const resolver = resolverOf(listing);
    const facts = buildListingSettingsFacts(listing);
    const byId = new Map(sizes.map((size) => [size.productVariantId, size]));
    const owned = facts.sizes.filter((size) => size.price.rule === null).map((size) => size.price.productVariantId);
    expect(owned).toEqual([103, 104, 105, 106]);
    for (const size of facts.sizes) {
      const rule = sizePricingRule(byId.get(size.price.productVariantId)!, listing, resolver);
      expect([size.price.productVariantId, rule]).toEqual([size.price.productVariantId, size.price.rule]);
      expect(rule === null).toBe(sizeOwnsPrice(listing.savedPrices.get(size.price.productVariantId) ?? null));
    }
  });

  it("names the rule under a size the rules can't price today, where the read model names none (the Binders shape)", () => {
    // An inherit size with no cost, a category group "Cost + 40%" by its copy "Binders", no category id, a store default "Cost + 10%".
    const binder = candidate({ productVariantId: 101, productId: 1, category: "Binders" });
    const listing = listingInputs([binder], {
      pricing: pricingState([{ id: "binders", name: "Binders rule", priority: 10, scope: byCategory("Binders"), value: COST_PLUS_40 }]),
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
    });
    const facts = buildListingSettingsFacts(listing);
    expect(facts.sizes[0].price).toMatchObject({ source: "retail_fallback", rule: null, issue: "pricing_basis_unavailable" });
    expect(sizePricingRule(binder, listing, resolverOf(listing))).toEqual({ kind: "group", name: "Binders rule", recipe: COST_PLUS_40 });
  });

  it("is null for a size that owns its price and for a size no rule covers", () => {
    const sizes = [101, 102, 103].map((id) => candidate({ productVariantId: id, productId: 1 }));
    const listing = listingInputs(sizes, {
      pricing: pricingState([]),
      savedPrices: new Map([
        [101, savedPrice(101, { overridePriceCents: 1_500, pricingMode: "fixed" })],
        [102, savedPrice(102, { pricingMode: "catalog_default" })],
        [103, savedPrice(103, {})],
      ]),
    });
    for (const size of sizes) expect(sizePricingRule(size, listing, resolverOf(listing))).toBeNull();
    const uncovered = listingInputs([sizes[0]]);
    expect(sizePricingRule(sizes[0], uncovered, resolverOf(uncovered))).toBeNull();
  });

  it("owns a price exactly as the read model does: a typed price, the catalog default or a legacy row", () => {
    expect(sizeOwnsPrice(null)).toBe(false);
    expect(sizeOwnsPrice({ pricingMode: "rules" })).toBe(false);
    expect(sizeOwnsPrice({ pricingMode: "inherit" })).toBe(false);
    expect(sizeOwnsPrice({ pricingMode: "fixed" })).toBe(true);
    expect(sizeOwnsPrice({ pricingMode: "catalog_default" })).toBe(true);
    expect(sizeOwnsPrice({})).toBe(true);
  });

  it("refuses a rule its inputs don't hold", () => {
    const size = inCategory(SLEEVES, { productVariantId: 101, productId: 1 });
    const listing = listingInputs([size], { pricing: pricingState([]) });
    const base: RulePriceResult = { priceCents: 1_000, ruleName: null, ruleId: null, issue: null, basis: "product_cost" };
    expectInvariant(() => selectedPricingRule({ ...base, ruleName: "Product price", ruleId: "product:1", ruleLevel: "product" }, size, listing));
    expectInvariant(() => selectedPricingRule({ ...base, ruleName: "Category price", ruleId: "category:12", ruleLevel: "category" }, size, listing));
    expectInvariant(() => selectedPricingRule({ ...base, ruleName: "Gone", ruleId: "gone" }, size, listing));
    expectInvariant(() => selectedPricingRule({ ...base, ruleName: "Store default rule" }, size, listingInputs([size])));
  });
});

describe("what becomes what (plan 4.A.4)", () => {
  it("890: the best category pricing group of a name becomes every target's price; the others never apply", () => {
    const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1 })], {
      pricing: pricingState([
        { id: "sleeves-old", name: "Old sleeves", priority: 20, scope: byCategory("Sleeves"), value: COST_PLUS_25 },
        { id: "sleeves", name: "Sleeves rule", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 },
      ]),
    });
    const result = plan(listing);
    expect(result.categories).toEqual([{ categoryId: SLEEVES.id, categoryName: "Sleeves", expectedRevisionId: null,
      patch: { price: COST_PLUS_40 }, settings: ["price"] }]);
    expect(result.products).toEqual([]);
    expect(result.report.neverApplies).toEqual([{ ruleName: "Old sleeves", kind: "price" }]);
    expect(result.profiles.pricing).toEqual({ expectedRevisionId: 41, removedIds: ["sleeves", "sleeves-old"] });
  });

  it("890: two category groups tied at the best priority give the category no price and list the tied products", () => {
    const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1, productName: "Sleeves 100" })], {
      pricing: pricingState([
        { id: "a", name: "Rule A", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 },
        { id: "b", name: "Rule B", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_25 },
      ]),
    });
    const result = plan(listing);
    expect(result.categories).toEqual([]);
    expect(result.report.ties).toEqual([{ productId: 1, productName: "Sleeves 100", setting: "price" }]);
    // Neither decides a size (a tie gives no price) and neither is written: each is listed once (plan D5).
    expect(result.report.neverApplies).toEqual([{ ruleName: "Rule A", kind: "price" }, { ruleName: "Rule B", kind: "price" }]);
  });

  it("890: a category description group gives both text parts, an empty part as None", () => {
    const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1 })], {
      content: contentState([{ id: "sleeves", priority: 1, scope: byCategory("Sleeves"), value: { introduction: "Sleeve intro", footer: "" } }]),
    });
    expect(plan(listing).categories).toEqual([{ categoryId: SLEEVES.id, categoryName: "Sleeves", expectedRevisionId: null,
      patch: { textAbove: { mode: "own", text: "Sleeve intro" }, textBelow: { mode: "none" } }, settings: ["textAbove", "textBelow"] }]);
  });

  it("890: a category eBay rule gives its stored category, with no eBay call", () => {
    const listing = listingInputs([inCategory(TOPLOADERS, { productVariantId: 101, productId: 1 })], {
      ebayCategoryRules: ebayRulesState([{ id: "toploaders", scope: byCategory("Toploaders"), category: EBAY_TOPLOADERS }]),
    });
    const result = plan(listing);
    expect(result.categories).toEqual([{ categoryId: TOPLOADERS.id, categoryName: "Toploaders", expectedRevisionId: null,
      patch: { ebayCategory: EBAY_TOPLOADERS }, settings: ["ebayCategory"] }]);
    expect(result.profiles).toEqual({ pricing: null, content: null, ebayRules: { expectedRevisionId: 61, removedIds: ["toploaders"] } });
  });

  it("890: one category gets every kind's rule in one write", () => {
    const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1 })], {
      pricing: pricingState([{ id: "p", priority: 1, scope: byCategory("Sleeves"), value: COST_PLUS_40 }]),
      content: contentState([{ id: "c", priority: 1, scope: byCategory("Sleeves"), value: { introduction: "Above", footer: "Below" } }]),
      ebayCategoryRules: ebayRulesState([{ id: "e", scope: byCategory("Sleeves"), category: EBAY_SLEEVES }]),
    });
    const [write] = plan(listing).categories;
    expect(write.patch).toEqual({ price: COST_PLUS_40, ebayCategory: EBAY_SLEEVES,
      textAbove: { mode: "own", text: "Above" }, textBelow: { mode: "own", text: "Below" } });
    expect(write.settings).toEqual(["price", "ebayCategory", "textAbove", "textBelow"]);
  });

  it("891: rules of every kind whose name no category has are unmatched, and write nothing", () => {
    const listing = listingInputs([candidate({ productVariantId: 101, productId: 1 })], {
      pricing: pricingState([{ id: "p", name: "Binders", priority: 1, scope: byCategory("Binders"), value: COST_PLUS_40 }]),
      content: contentState([{ id: "c", name: "Binders", priority: 1, scope: byCategory("Binders"), value: { introduction: "A", footer: "" } }]),
      ebayCategoryRules: ebayRulesState([{ id: "e", name: "Binders", scope: byCategory("Binders"), category: EBAY_SLEEVES }]),
    });
    const result = plan(listing);
    expect(result.report.unmatched).toEqual([
      { ruleName: "Binders", categoryName: "Binders", kind: "price" },
      { ruleName: "Binders", categoryName: "Binders", kind: "description" },
      { ruleName: "Binders", categoryName: "Binders", kind: "ebayCategory" },
    ]);
    expect(result.report.neverApplies).toEqual([]);
    expect(result.categories).toEqual([]);
  });

  it("893: a product-line or product rule that wins for every reached size becomes the product's own value", () => {
    const sizes = [101, 102].map((id) => inCategory(SLEEVES, { productVariantId: id, productId: 1, productLineIds: [9] }));
    const listing = listingInputs(sizes, {
      pricing: pricingState([
        { id: "line", priority: 5, scope: byProductLine(9), value: RETAIL_PLUS_20 },
        { id: "sleeves", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 },
      ]),
      ebayCategoryRules: ebayRulesState([
        { id: "product", scope: byProduct(1), category: EBAY_TOPLOADERS },
        { id: "sleeves", scope: byCategory("Sleeves"), category: EBAY_SLEEVES },
      ]),
      content: contentState([{ id: "line", priority: 1, scope: byProductLine(9), value: { introduction: "Line above", footer: "Line below" } }]),
      layers: layersOf([productRow(1, { textAbove: { mode: "own", text: "Mine" } }, 731)]),
    });
    const result = plan(listing);
    expect(result.products).toEqual([{ productId: 1, productName: "Product 1", expectedRevisionId: 731,
      patch: { price: RETAIL_PLUS_20, ebayCategory: EBAY_TOPLOADERS, textBelow: { mode: "own", text: "Line below" } },
      settings: ["price", "ebayCategory", "textBelow"] }]);
    // The category rules are written to their category even where a closer rule wins today (products chosen later follow them).
    expect(result.categories).toEqual([{ categoryId: SLEEVES.id, categoryName: "Sleeves", expectedRevisionId: null,
      patch: { price: COST_PLUS_40, ebayCategory: EBAY_SLEEVES }, settings: ["price", "ebayCategory"] }]);
    expect(result.report.neverApplies).toEqual([]);
  });

  it("893: a category rule that wins for a product writes nothing for the product; it follows its category", () => {
    const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1 })], {
      pricing: pricingState([{ id: "sleeves", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 }]),
    });
    const result = plan(listing);
    expect(result.products).toEqual([]);
    expect(result.categories.map((write) => write.categoryId)).toEqual([SLEEVES.id]);
  });

  it("894: a named-size rule covering every reached size and winning for all becomes the product's own value", () => {
    const listing = listingInputs([101, 102].map((id) => candidate({ productVariantId: id, productId: 1 })), {
      pricing: pricingState([{ id: "named", priority: 1, scope: bySizes(101, 102, 999), value: RETAIL_PLUS_20 }]),
      ebayCategoryRules: ebayRulesState([{ id: "named", scope: bySizes(101, 102), category: EBAY_SLEEVES }]),
    });
    expect(plan(listing).products).toEqual([{ productId: 1, productName: "Product 1", expectedRevisionId: null,
      patch: { price: RETAIL_PLUS_20, ebayCategory: EBAY_SLEEVES }, settings: ["price", "ebayCategory"] }]);
  });

  it("894: a named-size rule on only some sizes writes nothing and is listed with its setting, for every kind", () => {
    const listing = listingInputs([101, 102].map((id) => candidate({ productVariantId: id, productId: 1, productName: "Binder" })), {
      pricing: pricingState([{ id: "named", name: "Named price", priority: 1, scope: bySizes(101), value: RETAIL_PLUS_20 }]),
      content: contentState([{ id: "named", name: "Named text", priority: 1, scope: bySizes(101), value: { introduction: "A", footer: "B" } }]),
      ebayCategoryRules: ebayRulesState([{ id: "named", name: "Named eBay", scope: bySizes(102), category: EBAY_SLEEVES }]),
    });
    const result = plan(listing);
    expect(result.products).toEqual([]);
    expect(result.report.someSizesOnly).toEqual([
      { ruleName: "Named price", productId: 1, productName: "Binder", setting: "price" },
      { ruleName: "Named eBay", productId: 1, productName: "Binder", setting: "ebayCategory" },
      { ruleName: "Named text", productId: 1, productName: "Binder", setting: "textAbove" },
      { ruleName: "Named text", productId: 1, productName: "Binder", setting: "textBelow" },
    ]);
    expect(result.report.mixed).toEqual([]);
    expect(result.report.neverApplies).toEqual([]);
  });

  it("894/897: a named-size rule on some sizes is listed even where another size of the product ties", () => {
    const listing = listingInputs([101, 102].map((id) => inCategory(SLEEVES, { productVariantId: id, productId: 1, productName: "Binder" })), {
      pricing: pricingState([
        { id: "a", name: "Tie A", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 },
        { id: "b", name: "Tie B", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_25 },
        { id: "n", name: "Named", priority: 1, scope: bySizes(102), value: RETAIL_PLUS_20 },
      ]),
    });
    const result = plan(listing);
    expect(result.products).toEqual([]);
    expect(result.report.ties).toEqual([{ productId: 1, productName: "Binder", setting: "price" }]);
    // "Named" decides size 102 today and is written nowhere: the report names it with its setting.
    expect(result.report.someSizesOnly).toEqual([{ ruleName: "Named", productId: 1, productName: "Binder", setting: "price" }]);
    expect(result.report.neverApplies).toEqual([{ ruleName: "Tie A", kind: "price" }, { ruleName: "Tie B", kind: "price" }]);
  });

  it("a product in two product lines: the best line price and the first eBay rule become its own, tied line texts are listed", () => {
    const listing = listingInputs([101, 102].map((id) =>
      inCategory(SLEEVES, { productVariantId: id, productId: 1, productName: "Binder", productLineIds: [1, 2] })), {
      pricing: pricingState([
        { id: "l1", name: "Line 1 price", priority: 8, scope: byProductLine(1), value: COST_PLUS_40 },
        { id: "l2", name: "Line 2 price", priority: 5, scope: byProductLine(2), value: COST_PLUS_25 },
        { id: "s", name: "Sleeves price", priority: 10, scope: byCategory("Sleeves"), value: RETAIL_PLUS_20 },
      ]),
      // eBay rules have no priority: the first in saved order wins.
      ebayCategoryRules: ebayRulesState([
        { id: "e1", name: "Line 1 eBay", scope: byProductLine(1), category: EBAY_SLEEVES },
        { id: "e2", name: "Line 2 eBay", scope: byProductLine(2), category: EBAY_TOPLOADERS },
      ]),
      content: contentState([
        { id: "c1", name: "Line 1 text", priority: 3, scope: byProductLine(1), value: { introduction: "One", footer: "" } },
        { id: "c2", name: "Line 2 text", priority: 3, scope: byProductLine(2), value: { introduction: "Two", footer: "" } },
      ]),
    });
    const result = plan(listing);
    expect(result.products).toEqual([{ productId: 1, productName: "Binder", expectedRevisionId: null,
      patch: { price: COST_PLUS_25, ebayCategory: EBAY_SLEEVES }, settings: ["price", "ebayCategory"] }]);
    expect(result.categories).toEqual([{ categoryId: SLEEVES.id, categoryName: "Sleeves", expectedRevisionId: null,
      patch: { price: RETAIL_PLUS_20 }, settings: ["price"] }]);
    expect(result.report.ties).toEqual([{ productId: 1, productName: "Binder", setting: "description" }]);
    expect(result.report.neverApplies).toEqual([{ ruleName: "Line 1 price", kind: "price" }, { ruleName: "Line 1 text", kind: "description" },
      { ruleName: "Line 2 eBay", kind: "ebayCategory" }, { ruleName: "Line 2 text", kind: "description" }]);
  });

  it("a product-line group and a category group tied at one priority write nothing for the product and list it", () => {
    const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1, productName: "Binder", productLineIds: [9] })], {
      pricing: pricingState([
        { id: "line", name: "Line price", priority: 5, scope: byProductLine(9), value: RETAIL_PLUS_20 },
        { id: "sleeves", name: "Sleeves price", priority: 5, scope: byCategory("Sleeves"), value: COST_PLUS_40 },
      ]),
    });
    const result = plan(listing);
    expect(result.products).toEqual([]);
    expect(result.report.ties).toEqual([{ productId: 1, productName: "Binder", setting: "price" }]);
    // The category group is still the best of its name, so its category gets it.
    expect(result.categories.map((write) => [write.categoryId, write.patch])).toEqual([[SLEEVES.id, { price: COST_PLUS_40 }]]);
    expect(result.report.neverApplies).toEqual([{ ruleName: "Line price", kind: "price" }]);
  });

  it("a product's sizes won by different rules, with no named-size rule to explain it, are listed as mixed", () => {
    const listing = listingInputs([
      candidate({ productVariantId: 101, productId: 1, productName: "Binder", productLineIds: [1] }),
      candidate({ productVariantId: 102, productId: 1, productName: "Binder", productLineIds: [2] }),
    ], {
      pricing: pricingState([
        { id: "line-1", priority: 5, scope: byProductLine(1), value: RETAIL_PLUS_20 },
        { id: "line-2", priority: 5, scope: byProductLine(2), value: COST_PLUS_40 },
      ]),
    });
    const result = plan(listing);
    expect(result.products).toEqual([]);
    expect(result.report.mixed).toEqual([{ productId: 1, productName: "Binder", setting: "price" }]);
    expect(result.report.someSizesOnly).toEqual([]);
  });

  it("895-896: per-size rows are kept as they are and counted", () => {
    const ids = [101, 102, 103, 104, 105, 106, 107];
    const listing = listingInputs(ids.map((id) => candidate({ productVariantId: id, productId: 1 })), {
      pricing: pricingState([{ id: "line", priority: 5, scope: byProduct(1), value: RETAIL_PLUS_20 }]),
      savedPrices: new Map([
        [101, savedPrice(101, { overridePriceCents: 1_500, pricingMode: "fixed" })],
        [102, savedPrice(102, { overridePriceCents: 1_600 })],
        [103, savedPrice(103, { pricingMode: "catalog_default" })],
        [104, savedPrice(104, {})],
        [105, savedPrice(105, { pricingMode: "rules" })],
        [106, savedPrice(106, { pricingMode: "inherit" })],
      ]),
      policyOverrides: new Map([
        [101, { productVariantId: 101, revisionId: 1, fulfillmentPolicyId: "F9", returnPolicyId: null, paymentPolicyId: null, updatedAt: new Date(UPDATED_AT) }],
        [102, { productVariantId: 102, revisionId: 2, fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null, updatedAt: new Date(UPDATED_AT) }],
      ]),
      shelfAssignments: new Map([[103, ["Shelf A"]], [104, []]]),
      contentSettings: new Map([
        [105, { revisionId: 1, customText: "Mine", catalogHash: "a".repeat(64), updatedAt: UPDATED_AT }],
        [106, { revisionId: 2, customText: null, catalogHash: "a".repeat(64), updatedAt: UPDATED_AT }],
      ]),
    });
    const result = plan(listing);
    expect(result.kept).toEqual({ exactPrices: 2, catalogPrices: 2, sizePolicies: 1, sizeShelves: 1, sizeTexts: 1 });
    // The rule wins for every size that does not own its price (105, 106, 107), so it becomes the product's price;
    // the four that own theirs keep them and are not part of the agreement.
    expect(result.products).toEqual([{ productId: 1, productName: "Product 1", expectedRevisionId: null,
      patch: { price: RETAIL_PLUS_20 }, settings: ["price"] }]);
  });

  it("897: two description groups tied for a product list it once under ties and write neither part", () => {
    const listing = listingInputs([101, 102].map((id) => candidate({ productVariantId: id, productId: 1, productName: "Binder" })), {
      content: contentState([
        { id: "a", priority: 3, scope: byProduct(1), value: { introduction: "A", footer: "A" } },
        { id: "b", priority: 3, scope: bySizes(101, 102), value: { introduction: "B", footer: "B" } },
      ]),
    });
    const result = plan(listing);
    expect(result.report.ties).toEqual([{ productId: 1, productName: "Binder", setting: "description" }]);
    expect(result.products).toEqual([]);
  });

  it("898: the plan writes no per-size row: an explicit rules row stays and follows the same recipe from its category", () => {
    const size = inCategory(SLEEVES, { productVariantId: 101, productId: 1 });
    const listing = listingInputs([size], {
      pricing: pricingState([{ id: "sleeves", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 }]),
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "rules" })]]),
      costs: new Map([[101, availableCost(800)]]),
    });
    const inputs = conversionInputs(listing);
    const result = planRulesConversion(inputs);
    // What the move writes: the profiles, categories and products, and no size price.
    expect(Object.keys(conversionCanonicalWrites(result))).toEqual(["v", "storeConnectionId", "profiles", "categories", "products"]);
    const after = conversionAfterInputs(inputs, result);
    expect(after.savedPrices).toBe(listing.savedPrices);
    const [before, afterRule] = [sizePricingRule(size, listing, resolverOf(listing)), sizePricingRule(size, after, resolverOf(after))];
    expect([before?.kind, afterRule?.kind]).toEqual(["group", "category"]);
    expect([before && "recipe" in before ? before.recipe : null, afterRule && "recipe" in afterRule ? afterRule.recipe : null])
      .toEqual([COST_PLUS_40, COST_PLUS_40]);
    expect(diffRulesConversion(inputs, result).rows).toEqual([]);
  });

  it("899: the three group lists are emptied at their revisions; a list already empty is not rewritten", () => {
    const listing = listingInputs([candidate({ productVariantId: 101, productId: 1 })], {
      pricing: pricingState(["alpha", "Zeta", "beta"].map((id) => ({ id, priority: 100, scope: byProduct(99), value: COST_PLUS_40 })), COST_PLUS_10, 44),
      content: contentState([], undefined, 55),
    });
    const result = plan(listing);
    // Ids by UTF-16 code units, never the locale: "Zeta" before "alpha" (a locale order would put it last).
    expect(result.profiles).toEqual({ pricing: { expectedRevisionId: 44, removedIds: ["Zeta", "alpha", "beta"] }, content: null, ebayRules: null });
    expect(result.olderRules).toEqual({ pricingGroups: 3, contentGroups: 0, ebayCategoryRules: 0 });
  });

  it("874/899: every chosen product without a category mark gets its first one", () => {
    const listing = listingInputs([3, 1, 2, 1].map((productId, index) => candidate({ productVariantId: 100 + index, productId })), {
      pricing: pricingState([{ id: "p", priority: 1, scope: byProduct(99), value: COST_PLUS_40 }]),
      categoryMoves: { marks: new Map([[1, { storeConnectionId: STORE, productId: 1, categoryId: null, seenAt: UPDATED_AT }]]),
        fromCategories: new Map(), fromCategoryNames: new Map() },
    });
    expect(plan(listing).firstMarks).toEqual([2, 3]);
  });
});

describe("the further rules (plan 4.A.4)", () => {
  it("leaves a size that owns its price out of the price agreement", () => {
    const listing = listingInputs([101, 102, 103].map((id) => candidate({ productVariantId: id, productId: 1, productLineIds: [9] })), {
      pricing: pricingState([
        { id: "named", name: "Named", priority: 1, scope: bySizes(101), value: COST_PLUS_25 },
        { id: "line", priority: 5, scope: byProductLine(9), value: RETAIL_PLUS_20 },
      ]),
      savedPrices: new Map([[101, savedPrice(101, { overridePriceCents: 1_500, pricingMode: "fixed" })],
        [103, savedPrice(103, { pricingMode: "inherit" })]]),
    });
    const result = plan(listing);
    expect(result.products.map((write) => write.patch)).toEqual([{ price: RETAIL_PLUS_20 }]);
    expect(result.report.someSizesOnly).toEqual([]);
    // The named rule reaches only a size with its own price, so it decides nothing.
    expect(result.report.neverApplies).toEqual([{ ruleName: "Named", kind: "price" }]);
  });

  it("never overwrites a product's own value; a rule that only loses to it never applies", () => {
    const listing = listingInputs([candidate({ productVariantId: 101, productId: 1, productLineIds: [9] })], {
      pricing: pricingState([{ id: "line", name: "Line price", priority: 5, scope: byProductLine(9), value: RETAIL_PLUS_20 }]),
      ebayCategoryRules: ebayRulesState([{ id: "line", name: "Line eBay", scope: byProductLine(9), category: EBAY_SLEEVES }]),
      layers: layersOf([productRow(1, { price: COST_PLUS_25, ebayCategory: EBAY_TOPLOADERS })]),
    });
    const result = plan(listing);
    expect(result.products).toEqual([]);
    expect(result.report.neverApplies).toEqual([{ ruleName: "Line eBay", kind: "ebayCategory" }, { ruleName: "Line price", kind: "price" }]);
  });

  it("patches only the converted fields of a category row already present, and never a field it sets itself", () => {
    const sleevesRow = categoryRow(SLEEVES.id, { ebayCategory: EBAY_TOPLOADERS, storeShelf: { mode: "none" } }, 812);
    // A target with no chosen product: its row comes only from the category rows read.
    const toploadersRow = categoryRow(TOPLOADERS.id, { price: COST_PLUS_10 }, 813);
    const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1 })], {
      pricing: pricingState([
        { id: "sleeves", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 },
        { id: "toploaders", name: "Toploaders price", priority: 10, scope: byCategory("Toploaders"), value: COST_PLUS_25 },
      ]),
      ebayCategoryRules: ebayRulesState([{ id: "sleeves", scope: byCategory("Sleeves"), category: EBAY_SLEEVES }]),
      layers: layersOf([], [sleevesRow]),
    });
    const result = plan(listing, { categoryRows: new Map([[SLEEVES.id, sleevesRow], [TOPLOADERS.id, toploadersRow]]) });
    expect(result.categories).toEqual([{ categoryId: SLEEVES.id, categoryName: "Sleeves", expectedRevisionId: 812,
      patch: { price: COST_PLUS_40 }, settings: ["price"] }]);
    // The eBay rule wins today (a rule beats its category), so it is not "never applies" though it writes nothing;
    // the Toploaders price neither writes nor wins.
    expect(result.report.neverApplies).toEqual([{ ruleName: "Toploaders price", kind: "price" }]);
  });

  it("writes a category rule to its category when no product is chosen at all, and empties the groups", () => {
    const listing = listingInputs([], {
      pricing: pricingState([{ id: "sleeves", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 }]),
      content: contentState([{ id: "toploaders", priority: 1, scope: byCategory("Toploaders"), value: { introduction: "", footer: "Below" } }]),
    });
    const result = plan(listing);
    expect(result.categories.map((write) => [write.categoryId, write.settings])).toEqual([
      [SLEEVES.id, ["price"]], [TOPLOADERS.id, ["textAbove", "textBelow"]]]);
    expect(result.products).toEqual([]);
    expect(result.firstMarks).toEqual([]);
    expect(result.profiles).toEqual({ pricing: { expectedRevisionId: 41, removedIds: ["sleeves"] },
      content: { expectedRevisionId: 51, removedIds: ["toploaders"] }, ebayRules: null });
    expect(result.report.neverApplies).toEqual([]);
  });

  it("gives a product with no Card Shellz category no value from a category group, and lists it", () => {
    const listing = listingInputs([candidate({ productVariantId: 101, productId: 1, productName: "Binder", category: "Sleeves" })], {
      pricing: pricingState([{ id: "sleeves", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 }]),
    });
    const { plan: result, diff } = checkRulesConversion(conversionInputs(listing));
    expect(result.products).toEqual([]);
    expect(result.report.nameMismatches).toEqual([{ productId: 1, productName: "Binder", listedAs: "Sleeves", categoryName: null }]);
    expect(result.categories.map((write) => write.categoryId)).toEqual([SLEEVES.id]);
    // Its copy matched the Sleeves group today; with no category id it falls to the store default ("Cost + 10%"): a row.
    expect(diff.rows.map((row) => [row.productVariantId, row.changed])).toEqual([[101, ["pricingRule"]]]);
    expect([diff.rows[0].before.pricingRule?.kind, diff.rows[0].after.pricingRule?.kind]).toEqual(["group", "store_default"]);
    expect(diff.state).toBe("not_clean");
  });

  it("lists under never applies only the rules with no write and no win", () => {
    const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1, productLineIds: [9] })], {
      pricing: pricingState([
        { id: "line", name: "Wins", priority: 1, scope: byProductLine(9), value: RETAIL_PLUS_20 },
        { id: "other", name: "Other product", priority: 1, scope: byProduct(99), value: RETAIL_PLUS_20 },
        { id: "sleeves", name: "Written", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 },
        { id: "binders", name: "Unmatched", priority: 10, scope: byCategory("Binders"), value: COST_PLUS_40 },
      ]),
    });
    const result = plan(listing);
    expect(result.report.neverApplies).toEqual([{ ruleName: "Other product", kind: "price" }]);
    expect(result.report.unmatched).toEqual([{ ruleName: "Unmatched", categoryName: "Binders", kind: "price" }]);
  });
});

/** A second Card Shellz category named "Toploaders", with no chosen product: the rich store's shared name. */
const TOPLOADERS_TWO = { id: 14, name: "Toploaders" } as const;
const RICH_CATALOG = [...FIXTURE_CATALOG, TOPLOADERS_TWO];

/**
 * A store with something in every report list (plan 4.A.9 "every list item
 * carries its kind or setting"), read with RICH_CATALOG: products 1-6 named
 * in alphabetical order.
 */
function richStore(): ListingSettingsInputs {
  const toploadersRow = categoryRow(TOPLOADERS.id, { paymentPolicy: { id: "P7", name: null } }, 813);
  return listingInputs([
    inCategory(SLEEVES, { productVariantId: 101, productId: 1, productName: "Alpha sleeves", productLineIds: [9] }),
    inCategory(SLEEVES, { productVariantId: 102, productId: 1, productName: "Alpha sleeves", productLineIds: [9] }),
    candidate({ productVariantId: 201, productId: 2, productName: "Beta binder", category: "Binders" }),
    candidate({ productVariantId: 301, productId: 3, productName: "Gamma toploader", category: "Sleeves", categoryId: TOPLOADERS.id }),
    inCategory(MAILERS, { productVariantId: 401, productId: 4, productName: "Delta mailer", productLineIds: [9] }),
    inCategory(MAILERS, { productVariantId: 402, productId: 4, productName: "Delta mailer", productLineIds: [9] }),
    inCategory(TOPLOADERS, { productVariantId: 501, productId: 5, productName: "Epsilon toploader" }),
    inCategory(TOPLOADERS, { productVariantId: 502, productId: 5, productName: "Epsilon toploader" }),
    candidate({ productVariantId: 601, productId: 6, productName: "Zeta", productLineIds: [1] }),
    candidate({ productVariantId: 602, productId: 6, productName: "Zeta", productLineIds: [2] }),
  ], {
    pricing: pricingState([
      { id: "sleeves", name: "Sleeves price", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 },
      { id: "sleeves-old", name: "Old sleeves price", priority: 20, scope: byCategory("Sleeves"), value: COST_PLUS_25 },
      { id: "binders", name: "Binders price", priority: 10, scope: byCategory("Binders"), value: COST_PLUS_40 },
      { id: "line9", name: "Line price", priority: 5, scope: byProductLine(9), value: RETAIL_PLUS_20 },
      { id: "tie-a", name: "Tie A", priority: 7, scope: byCategory("Toploaders"), value: COST_PLUS_40 },
      { id: "tie-b", name: "Tie B", priority: 7, scope: byCategory("Toploaders"), value: COST_PLUS_25 },
      { id: "named-501", name: "Named 501", priority: 1, scope: bySizes(501), value: RETAIL_PLUS_20 },
      { id: "line1", name: "Line 1", priority: 5, scope: byProductLine(1), value: RETAIL_PLUS_20 },
      { id: "line2", name: "Line 2", priority: 5, scope: byProductLine(2), value: COST_PLUS_40 },
    ]),
    content: contentState([
      { id: "c-sleeves", name: "Sleeves text", priority: 1, scope: byCategory("Sleeves"), value: { introduction: "Sleeve intro", footer: "" } },
      { id: "c-line", name: "Line text", priority: 2, scope: byProductLine(9), value: { introduction: "Line above", footer: "Line below" } },
      { id: "c-named", name: "Named text", priority: 1, scope: bySizes(401), value: { introduction: "Named above", footer: "Named below" } },
    ]),
    ebayCategoryRules: ebayRulesState([
      { id: "e-p1", name: "Alpha eBay", scope: byProduct(1), category: EBAY_SLEEVES },
      { id: "e-toploaders", name: "Toploaders eBay", scope: byCategory("Toploaders"), category: EBAY_TOPLOADERS },
      { id: "e-unused", name: "Unused eBay", scope: byProduct(99), category: EBAY_STORE_DEFAULT },
    ]),
    layers: layersOf([productRow(4, { textAbove: { mode: "own", text: "Mailer intro" } }, 704)], [toploadersRow]),
    savedPrices: new Map([[402, savedPrice(402, { overridePriceCents: 1_500, pricingMode: "fixed" })]]),
    policyOverrides: new Map([[201, { productVariantId: 201, revisionId: 1, fulfillmentPolicyId: "F9", returnPolicyId: null,
      paymentPolicyId: null, updatedAt: new Date(UPDATED_AT) }]]),
    shelfAssignments: new Map([[301, ["Shelf A"]]]),
    contentSettings: new Map([[401, { revisionId: 1, customText: "Own text", catalogHash: "a".repeat(64), updatedAt: UPDATED_AT }]]),
    categoryMoves: { marks: new Map([[1, { storeConnectionId: STORE, productId: 1, categoryId: SLEEVES.id, seenAt: UPDATED_AT }]]),
      fromCategories: new Map(), fromCategoryNames: new Map() },
  });
}

describe("a whole store", () => {
  it("plans every write and lists every item once", () => {
    const result = plan(richStore(), { catalog: RICH_CATALOG });
    expect(result).toEqual({
      storeConnectionId: STORE,
      olderRules: { pricingGroups: 9, contentGroups: 3, ebayCategoryRules: 3 },
      profiles: {
        pricing: { expectedRevisionId: 41, removedIds: ["binders", "line1", "line2", "line9", "named-501", "sleeves", "sleeves-old", "tie-a", "tie-b"] },
        content: { expectedRevisionId: 51, removedIds: ["c-line", "c-named", "c-sleeves"] },
        ebayRules: { expectedRevisionId: 61, removedIds: ["e-p1", "e-toploaders", "e-unused"] },
      },
      categories: [
        { categoryId: SLEEVES.id, categoryName: "Sleeves", expectedRevisionId: null, settings: ["price", "textAbove", "textBelow"],
          patch: { price: COST_PLUS_40, textAbove: { mode: "own", text: "Sleeve intro" }, textBelow: { mode: "none" } } },
        { categoryId: TOPLOADERS.id, categoryName: "Toploaders", expectedRevisionId: 813, settings: ["ebayCategory"],
          patch: { ebayCategory: EBAY_TOPLOADERS } },
        { categoryId: TOPLOADERS_TWO.id, categoryName: "Toploaders", expectedRevisionId: null, settings: ["ebayCategory"],
          patch: { ebayCategory: EBAY_TOPLOADERS } },
      ],
      products: [
        { productId: 1, productName: "Alpha sleeves", expectedRevisionId: null, settings: ["price", "ebayCategory"],
          patch: { price: RETAIL_PLUS_20, ebayCategory: EBAY_SLEEVES } },
        { productId: 4, productName: "Delta mailer", expectedRevisionId: 704, settings: ["price"], patch: { price: RETAIL_PLUS_20 } },
      ],
      firstMarks: [2, 3, 4, 5, 6],
      report: {
        unmatched: [{ ruleName: "Binders price", categoryName: "Binders", kind: "price" }],
        shared: [{ ruleName: "Toploaders eBay", categoryName: "Toploaders", categoryCount: 2, kind: "ebayCategory" }],
        nameMismatches: [
          { productId: 2, productName: "Beta binder", listedAs: "Binders", categoryName: null },
          { productId: 3, productName: "Gamma toploader", listedAs: "Sleeves", categoryName: "Toploaders" },
        ],
        neverApplies: [
          { ruleName: "Old sleeves price", kind: "price" },
          { ruleName: "Tie A", kind: "price" },
          { ruleName: "Tie B", kind: "price" },
          { ruleName: "Unused eBay", kind: "ebayCategory" },
        ],
        ties: [{ productId: 5, productName: "Epsilon toploader", setting: "price" }],
        someSizesOnly: [
          { ruleName: "Named text", productId: 4, productName: "Delta mailer", setting: "textBelow" },
          // Size 501 is won by its named rule, 502 by no one (a tie): the product is in ties and the named rule here.
          { ruleName: "Named 501", productId: 5, productName: "Epsilon toploader", setting: "price" },
        ],
        mixed: [{ productId: 6, productName: "Zeta", setting: "price" }],
      },
      kept: { exactPrices: 1, catalogPrices: 0, sizePolicies: 1, sizeShelves: 1, sizeTexts: 1 },
    });
  });

  it("answers with every report list filled, each item with its kind or setting, and passes the answer's schema", () => {
    const { plan: result, diff } = checkRulesConversion(conversionInputs(richStore(), { catalog: RICH_CATALOG }));
    const answer = listingRulesConversionCheckSchema.parse(conversionCheckView(result, diff, 0, NOW));
    expect(Object.entries(answer.report).map(([name, list]) => [name, list.total > 0, list.items.length === list.total]))
      .toEqual(Object.keys(answer.report).map((name) => [name, true, true]));
    expect(answer.state).toBe("not_clean");
  });

  it("never mutates its inputs", () => {
    const expected = plan(richStore(), { catalog: RICH_CATALOG });
    const frozen = deepFreeze(conversionInputs(richStore(), { catalog: RICH_CATALOG }));
    // The freeze holds for maps too, so a write anywhere in the inputs would throw.
    expect(() => (frozen.listing.savedPrices as Map<number, unknown>).set(1, null)).toThrow(TypeError);
    expect(() => (frozen.listing.candidates as DropshipListingCatalogCandidate[]).push(frozen.listing.candidates[0])).toThrow(TypeError);
    expect(planRulesConversion(frozen)).toEqual(expected);
  });

  it("plans the same whatever order its inputs come in", () => {
    const listing = richStore();
    const reversedMap = <K, V>(map: ReadonlyMap<K, V>) => new Map([...map].reverse());
    const pricing = listing.pricing.profile!;
    const content = listing.content.profile!;
    const shuffled: ListingSettingsInputs = {
      ...listing,
      candidates: [...listing.candidates].reverse(),
      // Groups are ranked by priority and id; eBay rules keep their saved order, which is their precedence.
      pricing: { ...listing.pricing, profile: { ...pricing, groups: [...pricing.groups].reverse() } },
      content: { ...listing.content, profile: { ...content, groups: [...content.groups].reverse() } },
      savedPrices: reversedMap(listing.savedPrices),
      layers: { products: reversedMap(listing.layers.products), categories: reversedMap(listing.layers.categories) },
      ebayCategories: reversedMap(listing.ebayCategories),
      categoryNames: reversedMap(listing.categoryNames),
    };
    const expected = plan(listing, { catalog: RICH_CATALOG });
    const names = categoriesNamed(listing, RICH_CATALOG);
    const reversedNames = new Map([...names].reverse().map(([name, categories]) => [name, [...categories].reverse()]));
    expect(plan(shuffled, { categoriesByName: reversedNames, categoryRows: reversedMap(categoryRowsOf(listing, names)) })).toEqual(expected);
    expect(JSON.stringify(plan(shuffled, { catalog: [...RICH_CATALOG].reverse() }))).toBe(JSON.stringify(expected));
  });
});

describe("a store with no older rules", () => {
  it("plans nothing and counts what it keeps", () => {
    const listing = listingInputs([candidate({ productVariantId: 101, productId: 1 })], {
      pricing: pricingState([]),
      savedPrices: new Map([[101, savedPrice(101, { overridePriceCents: 1_500, pricingMode: "fixed" })]]),
    });
    expect(plan(listing)).toEqual({ storeConnectionId: STORE, olderRules: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 },
      profiles: { pricing: null, content: null, ebayRules: null }, categories: [], products: [], firstMarks: [],
      report: { unmatched: [], shared: [], nameMismatches: [], neverApplies: [], ties: [], someSizesOnly: [], mixed: [] },
      kept: { exactPrices: 1, catalogPrices: 0, sizePolicies: 0, sizeShelves: 0, sizeTexts: 0 } });
  });
});

describe("inputs that cannot happen", () => {
  const sleeves = pricingState([{ id: "sleeves", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 }]);

  it("refuses a text size that is not a whole number of bytes, and a size listed twice", () => {
    const listing = listingInputs([candidate({ productVariantId: 101, productId: 1 })], { pricing: sleeves });
    expectInvariant(() => plan(listing, { storeTextBytes: -1 }));
    expectInvariant(() => plan(listing, { storeTextBytes: 1.5 }));
    expectInvariant(() => plan(listingInputs([101, 101].map((id) => candidate({ productVariantId: id, productId: 1 })), { pricing: sleeves })));
  });

  it("refuses category rows keyed by another category or store, or that differ from the layers' row", () => {
    const row = categoryRow(SLEEVES.id, {}, 812);
    const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1 })], { pricing: sleeves, layers: layersOf([], [row]) });
    expectInvariant(() => plan(listing, { categoryRows: new Map([[TOPLOADERS.id, row]]) }));
    expectInvariant(() => plan(listing, { categoryRows: new Map([[SLEEVES.id, { ...row, storeConnectionId: STORE + 1 }]]) }));
    expectInvariant(() => plan(listing, { categoryRows: new Map([[SLEEVES.id, { ...row, revisionId: 900 }]]) }));
    expectInvariant(() => plan(listing, { categoryRows: new Map() }));
    // A chosen category with no row in the layers cannot have one in the category rows read.
    const noLayerRow = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1 })], { pricing: sleeves });
    expectInvariant(() => plan(noLayerRow, { categoryRows: new Map([[SLEEVES.id, row]]) }));
  });

  it("refuses a profile with older rules and no revision, and two eBay rules on one category", () => {
    expectInvariant(() => plan(listingInputs([], { pricing: { ...sleeves, revisionId: null } })));
    const twoRules = ebayRulesState([{ id: "a", scope: byCategory("Sleeves"), category: EBAY_SLEEVES }]);
    const profile = twoRules.profile!;
    const broken = { ...twoRules, profile: { ...profile, rules: [...profile.rules, { ...profile.rules[0], id: "b" }] } };
    expectInvariant(() => plan(listingInputs([], { ebayCategoryRules: broken })));
  });

  it("refuses a rule's category name that was never looked up, and a target whose settings row was never read", () => {
    // The eBay rule targets Sleeves, which holds no chosen product: only the names read and the category rows can say so.
    const listing = listingInputs([inCategory(MAILERS, { productVariantId: 101, productId: 1 })], {
      ebayCategoryRules: ebayRulesState([{ id: "r1", name: "Sleeves rule", scope: byCategory("Sleeves"), category: EBAY_SLEEVES }]),
    });
    expect(conversionInputs(listing).categoriesByName).toEqual(new Map([["Sleeves", [SLEEVES]]]));
    expect(conversionInputs(listing).categoryRows).toEqual(new Map([[SLEEVES.id, null]]));
    expectInvariant(() => plan(listing, { categoriesByName: new Map() }));
    expectInvariant(() => plan(listing, { categoryRows: new Map() }));
    // Looked up and read, with no row: the rule is written over no row.
    expect(plan(listing).categories.map((write) => [write.categoryId, write.expectedRevisionId, write.settings]))
      .toEqual([[SLEEVES.id, null, ["ebayCategory"]]]);
    // Looked up, and no category has the name: unmatched, nothing written.
    const unmatched = plan(listing, { categoriesByName: new Map([["Sleeves", []]]), categoryRows: new Map() });
    expect([unmatched.categories, unmatched.report.unmatched.map((item) => item.categoryName)]).toEqual([[], ["Sleeves"]]);
  });

  it("names every category name to look up once, by code units, from all three profiles", () => {
    const listing = listingInputs([], {
      pricing: pricingState([
        { id: "p1", priority: 1, scope: byCategory("binders"), value: COST_PLUS_40 },
        { id: "p2", priority: 2, scope: byCategory("Sleeves"), value: COST_PLUS_40 },
        { id: "p3", priority: 3, scope: byProduct(9), value: COST_PLUS_40 },
      ]),
      content: contentState([{ id: "c1", priority: 1, scope: byCategory("Binders"), value: { introduction: "A", footer: "" } }]),
      ebayCategoryRules: ebayRulesState([{ id: "e1", scope: byCategory("Sleeves"), category: EBAY_SLEEVES }]),
    });
    expect(conversionCategoryNamesToRead(listing)).toEqual(["Binders", "Sleeves", "binders"]);
    expect(conversionCategoryNamesToRead(listingInputs([]))).toEqual([]);
  });

  it("names its version", () => {
    expect(RULES_CONVERSION_PLANNER_VERSION).toBe(1);
  });
});

describe("matchingContentGroups (the content resolver's walk)", () => {
  const size = candidate({ productVariantId: 101, productId: 7, productLineIds: [3] });

  it("gives the winner resolveContentTemplate uses after the product and before the category", () => {
    const profile = contentState([
      { id: "b", name: "Group b", priority: 2, scope: byProduct(7), value: { introduction: "B above", footer: "B below" } },
      { id: "a", name: "Group a", priority: 1, scope: byProductLine(3), value: { introduction: "A above", footer: "A below" } },
      { id: "c", name: "Group c", priority: 1, scope: byProduct(8), value: { introduction: "C", footer: "C" } },
    ]);
    const prepared = prepareContentProfile(profile);
    const groups = matchingContentGroups(prepared, size);
    expect(groups.groups.map((group) => group.id)).toEqual(["a", "b"]);
    expect(groups.tie).toBe(false);
    expect(groups.winner?.id).toBe("a");
    const layers = layersOf([productRow(7, { textAbove: { mode: "own", text: "Product above" } })],
      [categoryRow(SLEEVES.id, { textAbove: { mode: "own", text: "C above" }, textBelow: { mode: "own", text: "C below" } })]);
    expect(resolveContentTemplate(prepared, { ...size, categoryId: SLEEVES.id }, layers)).toMatchObject({
      groupName: "Group a", conflict: false,
      parts: { textAbove: { text: "Product above", source: "product" }, textBelow: { text: "A below", source: "group_rule" } } });
  });

  it("says two groups tie when the best two share a priority, as resolveContentTemplate's conflict does", () => {
    const tied = contentState([
      { id: "a", priority: 1, scope: byProduct(7), value: { introduction: "A", footer: "A" } },
      { id: "b", priority: 1, scope: bySizes(101), value: { introduction: "B", footer: "B" } },
    ]);
    const prepared = prepareContentProfile(tied);
    expect(matchingContentGroups(prepared, size)).toMatchObject({ tie: true, winner: null });
    expect(matchingContentGroups(prepared, size).groups.map((group) => group.id)).toEqual(["a", "b"]);
    expect(resolveContentTemplate(prepared, size).conflict).toBe(true);
    // A product part on both sides hides the tie from the template, never from the walk.
    expect(resolveContentTemplate(prepared, size, layersOf([productRow(7, { textAbove: { mode: "none" }, textBelow: { mode: "none" } })])).conflict)
      .toBe(false);
    expect(matchingContentGroups(prepareContentProfile(NO_PROFILE), size)).toEqual({ groups: [], tie: false, winner: null });
  });
});
