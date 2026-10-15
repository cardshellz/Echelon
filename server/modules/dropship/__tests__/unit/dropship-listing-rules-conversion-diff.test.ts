import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_DESCRIPTION_HTML_LENGTH } from "../../../../../shared/dropship/listing-content";
import { MAX_LISTING_PRICE_CENTS, RULE_PRICE_OUTSIDE_LIMIT_ISSUE } from "../../../../../shared/dropship/listing-price";
import {
  CONVERSION_CHANGED_FIELDS, CONVERSION_CONTENT_BLOCKER_CODES, listingRulesConversionCheckSchema, type ConversionChangedField,
} from "../../../../../shared/dropship/listing-rules-conversion";
import type { PricingRecipe } from "../../../../../shared/dropship/pricing-rules";
import { MAX_STORE_LISTING_TEXT_BYTES } from "../../../../../shared/dropship/listing-setting-writes";
import { matchingContentGroups, prepareContentProfile, resolveContentTemplate } from "../../application/dropship-listing-content-resolver";
import type { DropshipListingCatalogCandidate, DropshipPricingPolicyRecord } from "../../application/dropship-listing-preview-service";
import {
  CONTENT_ISSUE_BLOCKERS, PLANNED_ROW_REVISION_ID, checkRulesConversion, compareConversion, contentIssueBlockers, conversionAfterInputs,
  conversionBlocks, conversionCanonicalWrites, conversionCheckView, conversionHashes, conversionKeyValues, conversionState,
  diffRulesConversion, planRulesConversion, todayWinners, type RulesConversionPlan,
} from "../../application/dropship-listing-rules-conversion";
import { buildListingSettingsFacts, type ListingSettingsInputs } from "../../application/dropship-listing-settings-facts";
import { DropshipError } from "../../domain/errors";
import {
  COST_PLUS_10, COST_PLUS_25, COST_PLUS_40, EBAY_SLEEVES, EBAY_STORE_DEFAULT, EBAY_TOPLOADERS, MAILERS, NO_PROFILE, RETAIL_PLUS_20,
  SLEEVES, STORE, TOPLOADERS, UPDATED_AT, availableCost, byCategory, byProduct, byProductLine, bySizes, candidate, categoriesByName,
  categoriesNamed, categoryRow, categoryRowsOf, contentState, conversionInputs, deepFreeze, ebayRulesState, inCategory, layersOf,
  listingInputs, pricingState, productRow, savedPrice,
} from "../fixtures/listing-rules-conversion.fixture";

/*
 * What the conversion would change (plan 4.A.7-4.A.9): the after inputs,
 * the diff over plan 3.2's keys (one mutation per key, so an empty diff is
 * never vacuous), the pricing rule under sizes that can't price today
 * (CMC#1), the cost property (plan 4.A.9's five costs and a typical one)
 * over every clean fixture and over a family of stores, the blocks (D9a-c),
 * the two hashes (plan 3.3), the answer and its paging (4.A.3), the content
 * issues the listable key knows, and the content walk equal to the template's.
 */

const NOW = new Date("2026-10-15T08:00:00.000Z");

function run(listing: ListingSettingsInputs, patch: Parameters<typeof conversionInputs>[1] = {}) {
  const inputs = conversionInputs(listing, patch);
  const { plan, diff } = checkRulesConversion(inputs);
  return { inputs, plan, diff, view: (page = 0, at = NOW) => conversionCheckView(plan, diff, page, at) };
}

/** The read model's inputs rebuilt with a patch, eBay categories resolved again as the load resolves them. */
function rebuilt(listing: ListingSettingsInputs, patch: Partial<Omit<ListingSettingsInputs, "candidates" | "ebayCategories">> = {},
  candidates: readonly DropshipListingCatalogCandidate[] = listing.candidates): ListingSettingsInputs {
  const { candidates: _candidates, ebayCategories: _ebayCategories, ...rest } = listing;
  return listingInputs(candidates, { ...rest, ...patch });
}

const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V) => new Map(map).set(key, value);
const costs = (entries: Array<[number, number]>) => new Map(entries.map(([id, cents]) => [id, availableCost(cents)]));
const rowIds = (rows: ReadonlyArray<{ productVariantId: number; changed: readonly string[] }>) =>
  rows.map((row) => [row.productVariantId, row.changed]);

function limit(patch: Partial<DropshipPricingPolicyRecord> & Pick<DropshipPricingPolicyRecord, "id">): DropshipPricingPolicyRecord {
  return { scopeType: "catalog", productLineId: null, productId: null, productVariantId: null, category: null,
    mode: "block_listing_push", floorPriceCents: null, ceilingPriceCents: null, ...patch };
}

function listed(productVariantId: number, patch: { status?: string; externalListingId?: string | null } = {}) {
  return { listingId: 9_000 + productVariantId, productVariantId, status: patch.status ?? "active", vendorRetailPriceCents: null,
    quantityCap: null, externalListingId: patch.externalListingId === undefined ? `v1|${productVariantId}|0` : patch.externalListingId };
}

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

// ---------------------------------------------------------------------------
// Clean fixtures: every one moves over with no change (plan 4.A.9)
// ---------------------------------------------------------------------------

/**
 * Category rules of all three kinds (REC:931): a Sleeves price and text group
 * (with an empty footer), a Toploaders price group and eBay rule, and sizes
 * that follow the rules in every way a size can (no row, `rules`, `inherit`
 * with and without a cost), one that owns its price, and a Mailers size the
 * store default prices.
 */
function cleanStore(): ListingSettingsInputs {
  return listingInputs([
    inCategory(SLEEVES, { productVariantId: 101, productId: 1, productName: "Alpha sleeves" }),
    inCategory(SLEEVES, { productVariantId: 102, productId: 1, productName: "Alpha sleeves" }),
    inCategory(SLEEVES, { productVariantId: 103, productId: 2, productName: "Beta sleeves" }),
    inCategory(SLEEVES, { productVariantId: 104, productId: 2, productName: "Beta sleeves" }),
    inCategory(SLEEVES, { productVariantId: 105, productId: 5, productName: "Epsilon sleeves" }),
    inCategory(TOPLOADERS, { productVariantId: 201, productId: 3, productName: "Gamma toploader" }),
    inCategory(MAILERS, { productVariantId: 301, productId: 4, productName: "Delta mailer" }),
  ], {
    pricing: pricingState([
      { id: "sleeves", name: "Sleeves price", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 },
      { id: "toploaders", name: "Toploaders price", priority: 10, scope: byCategory("Toploaders"), value: RETAIL_PLUS_20 },
    ]),
    content: contentState([{ id: "c-sleeves", name: "Sleeves text", priority: 1, scope: byCategory("Sleeves"),
      value: { introduction: "Sleeve intro", footer: "" } }]),
    ebayCategoryRules: ebayRulesState([{ id: "e-toploaders", name: "Toploaders eBay", scope: byCategory("Toploaders"), category: EBAY_TOPLOADERS }]),
    savedPrices: new Map([
      [102, savedPrice(102, { pricingMode: "rules" })],
      [103, savedPrice(103, { pricingMode: "inherit" })],
      [104, savedPrice(104, { pricingMode: "fixed", overridePriceCents: 1_000 })],
      [105, savedPrice(105, { pricingMode: "inherit" })],
    ]),
    costs: costs([[101, 800], [102, 800], [103, 1_000], [104, 900], [201, 500], [301, 600]]),
  });
}

/** Product-line, product and line rules that win for every chosen size of their product become its own values. */
function productRuleStore(): ListingSettingsInputs {
  return listingInputs([
    inCategory(MAILERS, { productVariantId: 101, productId: 1, productName: "Alpha", productLineIds: [9] }),
    inCategory(MAILERS, { productVariantId: 102, productId: 1, productName: "Alpha", productLineIds: [9] }),
  ], {
    pricing: pricingState([{ id: "line", priority: 5, scope: byProductLine(9), value: RETAIL_PLUS_20 }]),
    content: contentState([{ id: "line", priority: 1, scope: byProductLine(9), value: { introduction: "Line above", footer: "Line below" } }]),
    ebayCategoryRules: ebayRulesState([{ id: "product", scope: byProduct(1), category: EBAY_SLEEVES }]),
    savedPrices: new Map([[102, savedPrice(102, { pricingMode: "inherit" })]]),
    costs: costs([[101, 800]]),
  });
}

/** Named-size rules covering every chosen size of the product. */
function namedSizeStore(): ListingSettingsInputs {
  return listingInputs([201, 202].map((id) => candidate({ productVariantId: id, productId: 2, productName: "Beta" })), {
    pricing: pricingState([{ id: "named", priority: 1, scope: bySizes(201, 202), value: COST_PLUS_25 }]),
    ebayCategoryRules: ebayRulesState([{ id: "named", scope: bySizes(201, 202), category: EBAY_TOPLOADERS }]),
    costs: costs([[201, 700], [202, 750]]),
  });
}

/** Rules that decide no chosen size: an unmatched category name and another store's product. */
function unmatchedStore(): ListingSettingsInputs {
  return listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1 })], {
    pricing: pricingState([
      { id: "binders", priority: 1, scope: byCategory("Binders"), value: COST_PLUS_40 },
      { id: "other", priority: 1, scope: byProduct(99), value: RETAIL_PLUS_20 },
    ]),
    costs: costs([[101, 800]]),
  });
}

/** No chosen product at all: the category rules are still written to their categories. */
function noChosenStore(): ListingSettingsInputs {
  return listingInputs([], {
    pricing: pricingState([{ id: "sleeves", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 }]),
    content: contentState([{ id: "toploaders", priority: 1, scope: byCategory("Toploaders"), value: { introduction: "", footer: "Below" } }]),
  });
}

/**
 * A product in two product lines: the better line price (priority 5 over 8)
 * and the first eBay rule in saved order become its own, and one line text.
 */
function twoLineStore(): ListingSettingsInputs {
  return listingInputs([101, 102].map((id) =>
    inCategory(SLEEVES, { productVariantId: id, productId: 1, productName: "Binder", productLineIds: [1, 2] })), {
    pricing: pricingState([
      { id: "l1", priority: 8, scope: byProductLine(1), value: COST_PLUS_40 },
      { id: "l2", priority: 5, scope: byProductLine(2), value: COST_PLUS_25 },
      { id: "sleeves", priority: 10, scope: byCategory("Sleeves"), value: RETAIL_PLUS_20 },
    ]),
    ebayCategoryRules: ebayRulesState([
      { id: "e1", scope: byProductLine(1), category: EBAY_SLEEVES },
      { id: "e2", scope: byProductLine(2), category: EBAY_TOPLOADERS },
    ]),
    content: contentState([{ id: "c2", priority: 3, scope: byProductLine(2), value: { introduction: "Two", footer: "" } }]),
    savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
    costs: costs([[102, 700]]),
  });
}

const CLEAN_STORES: ReadonlyArray<[string, () => ListingSettingsInputs]> = [
  ["category rules of all three kinds", cleanStore],
  ["product-line and product rules", productRuleStore],
  ["named-size rules on every size", namedSizeStore],
  ["rules that decide nothing", unmatchedStore],
  ["no chosen product", noChosenStore],
  ["a product in two product lines", twoLineStore],
];

/**
 * CMC#1's property (plan 4.A.9, D3), with the planner's own verdict as its
 * condition: a store the planner calls clean at today's cost is clean at
 * every cost a size can get, known or not, including the ones that leave it
 * unpriced, and every size that does not own its price keeps its cents and
 * source. So a compare that missed a key (the pricing rule, say) would call a
 * Binders-like store clean, and this would fail at the first cost that prices
 * it. The plan itself never depends on the cost. The costs are the plan's
 * five {unknown, 0, 1, today's, MAX_LISTING_PRICE_CENTS} and a typical 1,000
 * cents: when today's cost is unknown, 0, 1 and the maximum price no recipe
 * apart, so a sixth, ordinary cost does.
 */
const TYPICAL_COST_CENTS = 1_000;

function expectCleanAtEveryCost(today: ListingSettingsInputs): void {
  const { plan, diff } = run(today);
  expect(diff.state).toBe("clean");
  for (const cost of ["unknown", 0, 1, "today", MAX_LISTING_PRICE_CENTS, TYPICAL_COST_CENTS] as const) {
    const listing: ListingSettingsInputs = {
      ...today,
      costs: cost === "today" ? today.costs : cost === "unknown" ? new Map()
        : new Map(today.candidates.map((size) => [size.productVariantId, availableCost(cost)])),
    };
    const inputs = conversionInputs(listing);
    expect(planRulesConversion(inputs)).toEqual(plan);
    const after = conversionAfterInputs(inputs, plan);
    const afterPrices = new Map(buildListingSettingsFacts(after).sizes.map((size) => [size.price.productVariantId, size.price]));
    for (const { price } of buildListingSettingsFacts(listing).sizes) {
      const saved = listing.savedPrices.get(price.productVariantId);
      if (saved && saved.pricingMode !== "rules" && saved.pricingMode !== "inherit") continue;
      const moved = afterPrices.get(price.productVariantId);
      expect([cost, price.productVariantId, moved?.priceCents, moved?.source]).toEqual([cost, price.productVariantId, price.priceCents, price.source]);
    }
    expect([cost, diffRulesConversion(inputs, plan).state]).toEqual([cost, "clean"]);
  }
}

describe("clean fixtures", () => {
  it.each(CLEAN_STORES)("%s: moving over changes nothing and nothing blocks it", (_name, store) => {
    const { plan, diff, view } = run(store());
    expect(diff.rows).toEqual([]);
    expect(diff.state).toBe("clean");
    expect(diff.blocked).toEqual({ wouldLosePrice: [], wouldBlockListing: [], tooMuchText: false, addedProductTextBytes: expect.any(Number) });
    expect(plan.categories.length + plan.products.length + Number(plan.profiles.pricing !== null)).toBeGreaterThan(0);
    expect(() => listingRulesConversionCheckSchema.parse(view())).not.toThrow();
  });

  it("the category fixture really converts rules of all three kinds into category settings", () => {
    const { plan } = run(cleanStore());
    expect(plan.categories.map((write) => [write.categoryName, write.settings])).toEqual([
      ["Sleeves", ["price", "textAbove", "textBelow"]], ["Toploaders", ["price", "ebayCategory"]]]);
    expect(plan.products).toEqual([]);
  });

  it.each(CLEAN_STORES)("%s: is clean at every cost (the plan's five and a typical one), each size keeping its cents and source", (_name, store) => {
    expectCleanAtEveryCost(store());
  });
});

/**
 * The property over a family of one-size stores rather than hand-picked
 * fixtures (CMC#1): the group's level (a category by id and copy, a copy no
 * category has, a product line, a named size) × the size's saved setting
 * (none, `rules`, `inherit`) × the recipe (from cost, from retail, or the
 * store default's own) × a blocking ceiling or none × a cost or none. The
 * planner must call exactly the copy-only stores whose recipe differs from
 * the store default not clean (their pricing rule changes), and every store
 * it calls clean must hold at five costs.
 */
describe("the cost property over a family of stores (CMC#1)", () => {
  const LEVELS = ["category", "copy only", "product line", "named size"] as const;
  const RECIPES: ReadonlyArray<[string, PricingRecipe]> = [["cost + 40%", COST_PLUS_40], ["retail + 20%", RETAIL_PLUS_20],
    ["the store default's", COST_PLUS_10]];
  const family = (level: (typeof LEVELS)[number], recipe: PricingRecipe, mode: "none" | "rules" | "inherit", ceiling: boolean,
    cost: number | null): ListingSettingsInputs => {
    const size = level === "category" ? inCategory(SLEEVES, { productVariantId: 101, productId: 1 })
      : level === "copy only" ? candidate({ productVariantId: 101, productId: 1, category: "Binders" })
        : level === "product line" ? candidate({ productVariantId: 101, productId: 1, productLineIds: [9] })
          : candidate({ productVariantId: 101, productId: 1 });
    const scope = level === "category" ? byCategory("Sleeves") : level === "copy only" ? byCategory("Binders")
      : level === "product line" ? byProductLine(9) : bySizes(101);
    return listingInputs([size], {
      pricing: pricingState([{ id: "group", priority: 10, scope, value: recipe }], COST_PLUS_10),
      savedPrices: mode === "none" ? new Map() : new Map([[101, savedPrice(101, { pricingMode: mode })]]),
      // 1,150 sits between "cost + 40%" at 800 (1,120) and "retail + 20%" (1,200).
      pricingPolicies: ceiling ? [limit({ id: 3, ceilingPriceCents: 1_150 })] : [],
      costs: cost === null ? new Map() : costs([[101, cost]]),
    });
  };
  const cases = LEVELS.flatMap((level) => RECIPES.map(([recipeName, recipe]) => [level, recipeName, recipe] as const));

  it.each(cases)("%s, %s recipe: the verdict, and every clean store at every cost", (level, _recipeName, recipe) => {
    for (const mode of ["none", "rules", "inherit"] as const) {
      for (const ceiling of [false, true]) {
        for (const cost of [null, 800]) {
          const listing = family(level, recipe, mode, ceiling, cost);
          const { state } = run(listing).diff;
          // The property's condition is the planner's own verdict; the verdict is then pinned on its own.
          if (state === "clean") expectCleanAtEveryCost(listing);
          const expected = level === "copy only" && recipe !== COST_PLUS_10 ? "not_clean" : "clean";
          expect([mode, ceiling, cost, state]).toEqual([mode, ceiling, cost, expected]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The after inputs (plan 4.A.7)
// ---------------------------------------------------------------------------

describe("the after inputs (plan 4.A.7)", () => {
  it("empties the three group lists, keeps the store defaults, and leaves every other read the same object", () => {
    const listing = cleanStore();
    const inputs = conversionInputs(listing);
    const after = conversionAfterInputs(inputs, planRulesConversion(inputs));
    expect(after.pricing).toEqual({ ...listing.pricing, profile: { defaultRecipe: COST_PLUS_10, groups: [] } });
    expect(after.content.profile).toEqual({ defaultTemplate: listing.content.profile!.defaultTemplate, groups: [] });
    expect(after.ebayCategoryRules.profile).toEqual({ version: 1, defaultCategory: EBAY_STORE_DEFAULT, rules: [] });
    for (const key of ["store", "candidates", "savedPrices", "existingListings", "costs", "pricingPolicies", "listingConfig",
      "policyOverrides", "shelfAssignments", "contentSettings", "pausedSince", "categoryMoves", "sizesTotalByProductId"] as const) {
      expect(after[key]).toBe(listing[key]);
    }
  });

  it("leaves a group list the plan does not rewrite as the same object", () => {
    const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1 })], {
      pricing: pricingState([{ id: "sleeves", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 }]),
      content: contentState([]),
    });
    const inputs = conversionInputs(listing);
    const after = conversionAfterInputs(inputs, planRulesConversion(inputs));
    expect(after.content).toBe(listing.content);
    expect(after.ebayCategoryRules).toBe(listing.ebayCategoryRules);
  });

  it("merges each planned row over the row it replaces, or over no settings, and parses it as a stored row", () => {
    const productOwn = productRow(1, { storeShelf: { mode: "none" }, textAbove: { mode: "own", text: "Mine" } }, 731);
    const toploadersRow = categoryRow(TOPLOADERS.id, { shippingPolicy: { id: "F7", name: null } }, 813);
    const listing = listingInputs([
      inCategory(SLEEVES, { productVariantId: 101, productId: 1, productLineIds: [9] }),
    ], {
      pricing: pricingState([
        { id: "line", priority: 5, scope: byProductLine(9), value: RETAIL_PLUS_20 },
        { id: "toploaders", priority: 10, scope: byCategory("Toploaders"), value: COST_PLUS_25 },
      ]),
      ebayCategoryRules: ebayRulesState([{ id: "sleeves", scope: byCategory("Sleeves"), category: EBAY_SLEEVES }]),
      layers: layersOf([productOwn]),
    });
    const inputs = conversionInputs(listing, { categoryRows: new Map([[TOPLOADERS.id, toploadersRow], [SLEEVES.id, null]]) });
    const after = conversionAfterInputs(inputs, planRulesConversion(inputs));
    expect(after.layers.products.get(1)).toEqual({ storeConnectionId: STORE, productId: 1, revisionId: PLANNED_ROW_REVISION_ID,
      updatedAt: "1970-01-01T00:00:00.000Z", values: { ...productOwn.values, price: RETAIL_PLUS_20 } });
    // A chosen category with no row gets one over "follow the default".
    expect(after.layers.categories.get(SLEEVES.id)?.values).toEqual({ price: null, ebayCategory: EBAY_SLEEVES, storeShelf: null,
      shippingPolicy: null, returnPolicy: null, paymentPolicy: null, textAbove: null, textBelow: null });
    // A target with no chosen product keeps the fields it sets itself, from the category rows read.
    expect(after.layers.categories.get(TOPLOADERS.id)?.values).toMatchObject({ price: COST_PLUS_25, shippingPolicy: { id: "F7", name: null } });
    // Its name is known after the move, as every target's is.
    expect(after.categoryNames.get(TOPLOADERS.id)).toBe("Toploaders");
    expect(listing.layers.products.get(1)).toBe(productOwn);
    expect(listing.layers.categories.size).toBe(0);
  });

  it("resolves eBay categories again over the new rules and layers", () => {
    const { inputs, plan } = run(cleanStore());
    const after = conversionAfterInputs(inputs, plan);
    expect(inputs.listing.ebayCategories.get(201)).toMatchObject({ categoryId: EBAY_TOPLOADERS.categoryId, source: "rule", ruleId: "e-toploaders" });
    expect(after.ebayCategories.get(201)).toMatchObject({ categoryId: EBAY_TOPLOADERS.categoryId, source: "category", ruleId: null });
    expect(after.ebayCategories.get(101)).toMatchObject({ categoryId: EBAY_STORE_DEFAULT.categoryId, source: "store_default" });
  });

  it("never mutates its inputs", () => {
    const expected = conversionAfterInputs(conversionInputs(cleanStore()), planRulesConversion(conversionInputs(cleanStore())));
    const frozen = deepFreeze(conversionInputs(cleanStore()));
    const plan = deepFreeze(planRulesConversion(frozen));
    expect(conversionAfterInputs(frozen, plan)).toEqual(expected);
    expect(diffRulesConversion(frozen, plan)).toEqual(diffRulesConversion(conversionInputs(cleanStore()), planRulesConversion(conversionInputs(cleanStore()))));
  });

  it("refuses a plan that was not made from these inputs", () => {
    const { inputs, plan } = run(cleanStore());
    expectInvariant(() => conversionAfterInputs(inputs, { ...plan, storeConnectionId: STORE + 1 }));
    expectInvariant(() => conversionAfterInputs(inputs, { ...plan, categories: [{ ...plan.categories[0], expectedRevisionId: 812 }] }));
    expectInvariant(() => conversionAfterInputs(inputs, { ...plan, profiles: { ...plan.profiles, pricing: { expectedRevisionId: 40, removedIds: [] } } }));
    expectInvariant(() => conversionAfterInputs(inputs, { ...plan, categories: [{ ...plan.categories[0], categoryName: "Renamed" }] }));
    expectInvariant(() => diffRulesConversion(inputs, { ...plan, olderRules: { ...plan.olderRules, pricingGroups: 1 } }));
    expectInvariant(() => compareConversion(inputs.listing, { ...inputs.listing, candidates: inputs.listing.candidates.slice(1) }));
  });
});

// ---------------------------------------------------------------------------
// The diff, one mutation per key (plan 4.A.9, 3.2)
// ---------------------------------------------------------------------------

describe("the diff: one mutation per compared key", () => {
  const { inputs, plan } = run(cleanStore());
  const before = inputs.listing;
  const after = conversionAfterInputs(inputs, plan);
  const policyOverride = (patch: { fulfillmentPolicyId?: string; returnPolicyId?: string; paymentPolicyId?: string }) =>
    withEntry(after.policyOverrides, 301, { productVariantId: 301, revisionId: 1, fulfillmentPolicyId: null, returnPolicyId: null,
      paymentPolicyId: null, updatedAt: new Date(UPDATED_AT), ...patch });
  /** Each case changes exactly one key of exactly one size on the after side. */
  const CASES: ReadonlyArray<[ConversionChangedField, number, () => ListingSettingsInputs]> = [
    // The cost moves the cents of a rule price from cost; its class, rule and blockers stay.
    ["price", 101, () => ({ ...after, costs: withEntry(after.costs, 101, availableCost(900)) })],
    // A typed price equal to retail read as the catalog price: same cents, no rule either way.
    ["priceSource", 104, () => ({ ...after, savedPrices: withEntry(after.savedPrices, 104,
      savedPrice(104, { pricingMode: "catalog_default", overridePriceCents: null })) })],
    // An inherit size with no cost: retail fallback at the same cents under another recipe (CMC#1).
    ["pricingRule", 105, () => ({ ...after, layers: { ...after.layers, products: withEntry(after.layers.products, 5, productRow(5, { price: COST_PLUS_25 })) } })],
    ["ebayCategory", 201, () => ({ ...after, ebayCategories: withEntry(after.ebayCategories, 201,
      { ...after.ebayCategories.get(201)!, categoryId: "999999", categoryName: "Another category" }) })],
    ["storeShelf", 301, () => ({ ...after, shelfAssignments: withEntry(after.shelfAssignments, 301, ["Shelf B"]) })],
    ["shippingPolicy", 301, () => ({ ...after, policyOverrides: policyOverride({ fulfillmentPolicyId: "F9" }) })],
    ["returnPolicy", 301, () => ({ ...after, policyOverrides: policyOverride({ returnPolicyId: "R9" }) })],
    ["paymentPolicy", 301, () => ({ ...after, policyOverrides: policyOverride({ paymentPolicyId: "P9" }) })],
    ["description", 301, () => ({ ...after, layers: { ...after.layers, products: withEntry(after.layers.products, 4,
      productRow(4, { textAbove: { mode: "own", text: "Mailer above" } })) } })],
    // A blocking floor over a typed price: the same price, now not sendable.
    ["listable", 104, () => ({ ...after, pricingPolicies: [limit({ id: 7, scopeType: "variant", productVariantId: 104, floorPriceCents: 2_000 })] })],
  ];

  it("has a case for every key, in the keys' order, over a store whose diff is empty", () => {
    expect(CASES.map(([key]) => key)).toEqual([...CONVERSION_CHANGED_FIELDS]);
    expect(compareConversion(before, after)).toEqual([]);
  });

  it.each(CASES)("%s: a change of only that key gives one row naming exactly it", (key, productVariantId, mutate) => {
    const rows = compareConversion(before, mutate());
    expect(rowIds(rows)).toEqual([[productVariantId, [key]]]);
    const [row] = rows;
    expect(conversionKeyValues(row.before)[key]).not.toEqual(conversionKeyValues(row.after)[key]);
    // The row's names come from the inputs.
    const size = before.candidates.find((entry) => entry.productVariantId === productVariantId)!;
    expect([row.productId, row.productName, row.sizeName]).toEqual([size.productId, size.productName, size.variantName]);
  });

  it("gives no row for an evidence hash or a label change alone", () => {
    const pricing = before.pricing.profile!;
    const content = before.content.profile!;
    const ebay = before.ebayCategoryRules.profile!;
    const relabelled = rebuilt(before, {
      pricing: { ...before.pricing, revisionId: 99, profile: { ...pricing, groups: pricing.groups.map((group) => ({ ...group, name: `New ${group.name}` })) } },
      content: { ...before.content, revisionId: 98, profile: { ...content, groups: content.groups.map((group) => ({ ...group, name: `New ${group.name}` })) } },
      ebayCategoryRules: { ...before.ebayCategoryRules, revisionId: 97,
        profile: { ...ebay, rules: ebay.rules.map((rule) => ({ ...rule, name: `New ${rule.name}` })) } },
    });
    expect(compareConversion(before, relabelled)).toEqual([]);
    // The views do carry the new labels; only the compared keys decide a row.
    const priced = buildListingSettingsFacts(relabelled).sizes.find((size) => size.price.productVariantId === 101)!;
    expect(priced.price.rule).toMatchObject({ kind: "group", name: "New Sleeves price" });
  });

  it("gives a priceSource row for retail fallback against the catalog price, both ways", () => {
    // No pricing profile, so nothing covers the inherit size: it falls back to retail with no rule either way.
    const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1 })], {
      ebayCategoryRules: ebayRulesState([{ id: "sleeves", scope: byCategory("Sleeves"), category: EBAY_SLEEVES }]),
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
    });
    const catalog = { ...listing, savedPrices: new Map([[101, savedPrice(101, { pricingMode: "catalog_default" })]]) };
    const there = compareConversion(listing, catalog);
    expect(rowIds(there)).toEqual([[101, ["priceSource"]]]);
    expect([there[0].before.price.source, there[0].after.price.source]).toEqual(["retail_fallback", "catalog_price"]);
    expect(there[0].before.price.priceCents).toBe(there[0].after.price.priceCents);
    expect(rowIds(compareConversion(catalog, listing))).toEqual([[101, ["priceSource"]]]);
  });
});

// ---------------------------------------------------------------------------
// The pricing rule under sizes that can't price today (CMC#1)
// ---------------------------------------------------------------------------

describe("the pricing rule under sizes that can't price today (CMC#1)", () => {
  /** An inherit size of a product whose copy is "Binders", with no Card Shellz category, a "Binders" group and a store default. */
  const binders = (patch: Partial<Omit<ListingSettingsInputs, "candidates" | "ebayCategories">> = {}, count = 1) =>
    listingInputs(Array.from({ length: count }, (_, index) => candidate({ productVariantId: 101 + index, productId: 1 + index,
      productName: `Binder ${index + 1}`, category: "Binders" })), {
      pricing: pricingState([{ id: "binders", name: "Binders rule", priority: 10, scope: byCategory("Binders"), value: COST_PLUS_40 }], COST_PLUS_10),
      savedPrices: new Map(Array.from({ length: count }, (_, index) => [101 + index, savedPrice(101 + index, { pricingMode: "inherit" })])),
      ...patch,
    });

  it("the Binders shape: a rule that changes under a size with no cost is a row, and the store is not clean", () => {
    const { diff, plan, view } = run(binders());
    expect(rowIds(diff.rows)).toEqual([[101, ["pricingRule"]]]);
    const [row] = diff.rows;
    expect(row.before.price).toMatchObject({ source: "retail_fallback", priceCents: 1_000, rule: null });
    expect(row.after.price).toMatchObject({ source: "retail_fallback", priceCents: 1_000, rule: null });
    expect([row.before.pricingRule, row.after.pricingRule]).toEqual([
      { kind: "group", name: "Binders rule", recipe: COST_PLUS_40 }, { kind: "store_default", name: expect.any(String), recipe: COST_PLUS_10 }]);
    expect(diff.state).toBe("not_clean");
    expect(plan.report.unmatched).toEqual([{ ruleName: "Binders rule", categoryName: "Binders", kind: "price" }]);
    expect(plan.report.nameMismatches).toEqual([{ productId: 1, productName: "Binder 1", listedAs: "Binders", categoryName: null }]);
    expect(listingRulesConversionCheckSchema.parse(view())).toMatchObject({ state: "not_clean", changes: { total: 1 } });
  });

  it("the same when a blocking limit refuses the rule price on both sides", () => {
    const listing = binders({ costs: costs([[101, 1_000]]), pricingPolicies: [limit({ id: 3, ceilingPriceCents: 1_050 })] });
    const { diff } = run(listing);
    expect(rowIds(diff.rows)).toEqual([[101, ["pricingRule"]]]);
    for (const side of [diff.rows[0].before, diff.rows[0].after]) {
      expect(side.price).toMatchObject({ source: "retail_fallback", priceCents: 1_000, issue: RULE_PRICE_OUTSIDE_LIMIT_ISSUE });
      expect(side.blockers).toEqual([]);
    }
    expect(diff.state).toBe("not_clean");
  });

  it("a tie on both sides is no row, whatever the tied recipes are", () => {
    const tied = (first: typeof COST_PLUS_40, second: typeof COST_PLUS_40) => listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1 })], {
      pricing: pricingState([
        { id: "a", priority: 10, scope: byCategory("Sleeves"), value: first },
        { id: "b", priority: 10, scope: byCategory("Sleeves"), value: second },
      ]),
      costs: costs([[101, 800]]),
    });
    const before = tied(COST_PLUS_40, COST_PLUS_25);
    const views = compareConversion(before, tied(RETAIL_PLUS_20, COST_PLUS_10));
    expect(views).toEqual([]);
    expect(buildListingSettingsFacts(before).sizes[0].price).toMatchObject({ priceCents: null, source: "none", issue: "pricing_rule_priority_conflict" });
  });

  it("a tie that becomes a recipe is a row, even when the cents and class stay", () => {
    const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1, productName: "Sleeves 100" })], {
      pricing: pricingState([
        { id: "a", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 },
        { id: "b", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_25 },
      ]),
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
    });
    const { diff, plan } = run(listing);
    expect(plan.report.ties).toEqual([{ productId: 1, productName: "Sleeves 100", setting: "price" }]);
    expect(rowIds(diff.rows)).toEqual([[101, ["pricingRule"]]]);
    expect([diff.rows[0].before.pricingRule, diff.rows[0].after.pricingRule?.kind]).toEqual([{ kind: "tie" }, "store_default"]);
    expect([diff.rows[0].before.price.source, diff.rows[0].after.price.source]).toEqual(["retail_fallback", "retail_fallback"]);
  });
});

// ---------------------------------------------------------------------------
// What blocks a move (plan D9)
// ---------------------------------------------------------------------------

describe("what blocks a move (plan D9)", () => {
  /** A size priced today only by a group no category has: after the move only the store default reaches it. */
  const folders = (patch: Partial<Omit<ListingSettingsInputs, "candidates" | "ebayCategories">> = {}, count = 1) =>
    listingInputs(Array.from({ length: count }, (_, index) => candidate({ productVariantId: 101 + index, productId: 1 + index,
      productName: `Folder ${index + 1}`, category: "Folders" })), {
      pricing: pricingState([{ id: "folders", priority: 10, scope: byCategory("Folders"), value: RETAIL_PLUS_20 }], COST_PLUS_10),
      savedPrices: new Map(Array.from({ length: count }, (_, index) => [101 + index, savedPrice(101 + index, { pricingMode: "rules" })])),
      ...patch,
    });

  it("D9a: a rule price that becomes none", () => {
    const { diff } = run(folders());
    expect(diff.blocked.wouldLosePrice).toEqual([{ productId: 1, productVariantId: 101, productName: "Folder 1", sizeName: "Size 101", priceCents: 1_200 }]);
    expect(diff.rows[0].after.price.priceCents).toBeNull();
    expect(diff.rows[0].after.blockers).toEqual(["size_cannot_be_priced"]);
    expect(diff.state).toBe("not_clean");
  });

  it("D9a: a price that ends outside a blocking Card Shellz limit", () => {
    // Retail + 20% is 1,200 under the 2,000 ceiling; the store default is 2,200 at a 2,000 cost.
    const { diff } = run(folders({ costs: costs([[101, 2_000]]), pricingPolicies: [limit({ id: 4, ceilingPriceCents: 2_000 })] }));
    expect(diff.rows[0].after.price.priceCents).toBe(2_200);
    expect(diff.rows[0].after.blockers).toEqual(["price_outside_limit"]);
    expect(diff.blocked.wouldLosePrice.map((size) => size.productVariantId)).toEqual([101]);
    expect(diff.blocked.wouldBlockListing).toEqual([]);
  });

  it("D9a: a size with no usable price today is never one that loses it", () => {
    const { diff } = run(folders({ pricingPolicies: [limit({ id: 4, ceilingPriceCents: 1_100 })] }));
    expect(diff.rows[0].before.blockers).toEqual(["price_outside_limit"]);
    expect(diff.blocked.wouldLosePrice).toEqual([]);
  });

  /** A size whose eBay category comes only from a rule no category has, with no store default and no Card Shellz base. */
  const ebayOnlyFromRule = (patch: Partial<Omit<ListingSettingsInputs, "candidates" | "ebayCategories">> = {}) =>
    listingInputs([candidate({ productVariantId: 101, productId: 1, productName: "Folder", category: "Folders",
      ebayBrowseCategoryId: null, ebayBrowseCategoryName: null })], {
      ebayCategoryRules: ebayRulesState([{ id: "folders", scope: byCategory("Folders"), category: EBAY_SLEEVES }], null),
      ...patch,
    });

  it("D9b: a listed size that would have no eBay category", () => {
    const { diff, view } = run(ebayOnlyFromRule({ existingListings: new Map([[101, listed(101)]]) }));
    expect(rowIds(diff.rows)).toEqual([[101, ["ebayCategory", "listable"]]]);
    expect(diff.blocked.wouldBlockListing).toEqual([{ productId: 1, productVariantId: 101, productName: "Folder", sizeName: "Size 101",
      priceCents: 1_000, reasons: ["no_ebay_category"] }]);
    expect(diff.blocked.wouldLosePrice).toEqual([]);
    expect(listingRulesConversionCheckSchema.parse(view()).blocked.wouldBlockListing.total).toBe(1);
  });

  it("D9b: an unlisted, an ended and an id-less listing are rows, not blocks", () => {
    for (const existingListings of [new Map(), new Map([[101, listed(101, { status: "ended" })]]),
      new Map([[101, listed(101, { externalListingId: null })]])]) {
      const { diff } = run(ebayOnlyFromRule({ existingListings }));
      expect(rowIds(diff.rows)).toEqual([[101, ["ebayCategory", "listable"]]]);
      expect(diff.blocked.wouldBlockListing).toEqual([]);
      expect(diff.state).toBe("not_clean");
    }
  });

  it("D9b: a listed size whose description would be too large to send", () => {
    // The body fits alone; the store template the move falls back to takes it past the limit.
    const description = `<p>${"x".repeat(MAX_DESCRIPTION_HTML_LENGTH - 20)}</p>`;
    const listing = listingInputs([candidate({ productVariantId: 101, productId: 1, productName: "Folder", category: "Folders", description })], {
      content: contentState([{ id: "folders", priority: 1, scope: byCategory("Folders"), value: { introduction: "", footer: "" } }]),
      existingListings: new Map([[101, listed(101)]]),
    });
    const { diff } = run(listing);
    expect(rowIds(diff.rows)).toEqual([[101, ["description", "listable"]]]);
    expect(diff.blocked.wouldBlockListing.map((size) => size.reasons)).toEqual([["listing_content_description_too_large"]]);
  });

  it("D9b: a listed size that is blocked today is not one the move blocks", () => {
    const { diff } = run(ebayOnlyFromRule({ existingListings: new Map([[101, listed(101)]]),
      pricingPolicies: [limit({ id: 5, scopeType: "variant", productVariantId: 101, floorPriceCents: 5_000 })] }));
    expect(diff.rows[0].before.blockers).toEqual(["price_outside_limit"]);
    expect(diff.blocked.wouldBlockListing).toEqual([]);
  });

  it("a listed size that loses its price is listed under wouldLosePrice only", () => {
    const { diff } = run(folders({ existingListings: new Map([[101, listed(101)]]) }));
    expect(diff.rows[0].before.blockers).toEqual([]);
    expect(diff.rows[0].after.blockers).toEqual(["size_cannot_be_priced"]);
    expect(diff.blocked.wouldLosePrice.map((size) => size.productVariantId)).toEqual([101]);
    expect(diff.blocked.wouldBlockListing).toEqual([]);
  });

  describe("the store text cap, by the writers' rule (CMC#7)", () => {
    /** A product-line text group that becomes the product's own text above: "Eleven char" is 11 bytes. */
    const lineText = (introduction = "Eleven char") => listingInputs([candidate({ productVariantId: 101, productId: 1, productLineIds: [9] })], {
      content: contentState([{ id: "line", priority: 1, scope: byProductLine(9), value: { introduction, footer: "" } }]),
    });

    it("refuses a move whose product text takes the store past the cap, and allows one that reaches it exactly", () => {
      const over = run(lineText(), { storeTextBytes: MAX_STORE_LISTING_TEXT_BYTES - 10 });
      expect(over.plan.products.map((write) => write.patch)).toEqual([{ textAbove: { mode: "own", text: "Eleven char" }, textBelow: { mode: "none" } }]);
      expect(over.diff.rows).toEqual([]);
      expect(over.diff.blocked).toEqual({ wouldLosePrice: [], wouldBlockListing: [], tooMuchText: true, addedProductTextBytes: 11 });
      expect(over.diff.state).toBe("not_clean");
      expect(listingRulesConversionCheckSchema.parse(over.view())).toMatchObject({ state: "not_clean", blocked: { tooMuchText: true } });
      const exact = run(lineText(), { storeTextBytes: MAX_STORE_LISTING_TEXT_BYTES - 11 });
      expect(exact.diff.blocked.tooMuchText).toBe(false);
      expect(exact.diff.state).toBe("clean");
    });

    it("counts UTF-8 bytes, not characters", () => {
      // "é" is two bytes: five of them are ten bytes, one more than the room.
      expect(run(lineText("ééééé"), { storeTextBytes: MAX_STORE_LISTING_TEXT_BYTES - 9 }).diff.blocked)
        .toMatchObject({ tooMuchText: true, addedProductTextBytes: 10 });
    });

    it("never refuses a store already over the cap that adds no product text", () => {
      const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1, productLineIds: [9] })], {
        pricing: pricingState([{ id: "line", priority: 1, scope: byProductLine(9), value: RETAIL_PLUS_20 }]),
      });
      const { plan, diff } = run(listing, { storeTextBytes: MAX_STORE_LISTING_TEXT_BYTES + 1 });
      expect(plan.products.map((write) => write.settings)).toEqual([["price"]]);
      expect(diff.blocked).toMatchObject({ tooMuchText: false, addedProductTextBytes: 0 });
      expect(diff.state).toBe("clean");
    });

    it("never counts category text", () => {
      const long = "y".repeat(4_000);
      const listing = listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1 })], {
        content: contentState([{ id: "sleeves", priority: 1, scope: byCategory("Sleeves"), value: { introduction: long, footer: long } }]),
      });
      const { plan, diff } = run(listing, { storeTextBytes: MAX_STORE_LISTING_TEXT_BYTES });
      expect(plan.categories.map((write) => write.settings)).toEqual([["textAbove", "textBelow"]]);
      expect(diff.blocked).toMatchObject({ tooMuchText: false, addedProductTextBytes: 0 });
      expect(diff.state).toBe("clean");
    });
  });

  it("is read from the rows in their order, whatever order they come in", () => {
    const { diff, inputs, plan } = run(folders({}, 3));
    const reversed = conversionBlocks({ listing: inputs.listing, rows: [...diff.rows].reverse(), plan, storeTextBytes: 0 });
    expect(reversed).toEqual(diff.blocked);
    expect(conversionState({ olderRules: plan.olderRules, rows: [], blocked: reversed })).toBe("not_clean");
    expect(conversionState({ olderRules: plan.olderRules, rows: [], blocked: { ...reversed, wouldLosePrice: [] } })).toBe("clean");
    expect(conversionState({ olderRules: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 }, rows: diff.rows, blocked: reversed }))
      .toBe("no_older_rules");
  });
});

// ---------------------------------------------------------------------------
// The hashes (plan 3.3)
// ---------------------------------------------------------------------------

/**
 * A store that is not clean in every way: the clean fixture's category rules,
 * a Binders size whose rule changes (a row), a Folders size that loses its
 * price (a block), a Binders size with a cost (a row with cents) and a
 * product-line text (a product write that counts toward the text cap).
 */
function notCleanStore(patch: Partial<Omit<ListingSettingsInputs, "candidates" | "ebayCategories">> = {}): ListingSettingsInputs {
  const base = cleanStore();
  const pricing = base.pricing.profile!;
  const content = base.content.profile!;
  return rebuilt(base, {
    pricing: { ...base.pricing, profile: { ...pricing, groups: [...pricing.groups,
      { id: "binders", name: "Binders price", priority: 10, scope: byCategory("Binders"), recipe: COST_PLUS_40 },
      { id: "folders", name: "Folders price", priority: 10, scope: byCategory("Folders"), recipe: RETAIL_PLUS_20 }] } },
    content: { ...base.content, profile: { ...content, groups: [...content.groups,
      { id: "c-line", name: "Line text", priority: 2, scope: byProductLine(9), template: { introduction: "Eleven char", footer: "" } }] } },
    savedPrices: new Map([...base.savedPrices, [401, savedPrice(401, { pricingMode: "inherit" })], [402, savedPrice(402, { pricingMode: "rules" })]]),
    costs: new Map([...base.costs, [403, availableCost(1_000)]]),
    sizesTotalByProductId: new Map([...base.sizesTotalByProductId, [6, 1], [7, 1], [8, 1], [9, 1]]),
    ...patch,
  }, [
    ...base.candidates,
    candidate({ productVariantId: 401, productId: 6, productName: "Binder", category: "Binders" }),
    candidate({ productVariantId: 402, productId: 7, productName: "Folder", category: "Folders" }),
    inCategory(MAILERS, { productVariantId: 801, productId: 8, productName: "Line product", productLineIds: [9] }),
    candidate({ productVariantId: 403, productId: 9, productName: "Binder with cost", category: "Binders" }),
  ]);
}

describe("the hashes (plan 3.3)", () => {
  const base = run(notCleanStore());

  it("the fixture has writes, rows and a block", () => {
    expect(base.plan.products.map((write) => write.productId)).toEqual([8]);
    expect(rowIds(base.diff.rows)).toEqual([[401, ["pricingRule"]], [403, ["price", "pricingRule"]], [402, ["price", "priceSource", "pricingRule", "listable"]]]);
    expect(base.diff.blocked.wouldLosePrice.map((size) => size.productVariantId)).toEqual([402]);
    expect(base.diff.hashes).toEqual({ writesHash: expect.stringMatching(/^[a-f0-9]{64}$/), planHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("are the same for shuffled inputs", () => {
    const listing = notCleanStore();
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
      costs: reversedMap(listing.costs),
      layers: { products: reversedMap(listing.layers.products), categories: reversedMap(listing.layers.categories) },
      ebayCategories: reversedMap(listing.ebayCategories),
      categoryNames: reversedMap(listing.categoryNames),
    };
    const names = categoriesNamed(listing);
    const again = run(shuffled, { categoriesByName: reversedMap(names), categoryRows: reversedMap(categoryRowsOf(listing, names)) });
    expect(again.diff).toEqual(base.diff);
    expect(JSON.stringify(again.view())).toBe(JSON.stringify(base.view()));
  });

  it("the plan hash moves with any write, row or block; the writes hash only with a write", () => {
    const hashes = (listing: ListingSettingsInputs, storeTextBytes = 0) => run(listing, { storeTextBytes }).diff.hashes!;
    const content = notCleanStore().content;
    // A write: the content profile the move empties is at another revision (no value moves).
    const write = hashes(notCleanStore({ content: { ...content, revisionId: 52 } }));
    expect(run(notCleanStore({ content: { ...content, revisionId: 52 } })).diff.rows).toEqual(base.diff.rows);
    expect(write.writesHash).not.toBe(base.diff.hashes!.writesHash);
    expect(write.planHash).not.toBe(base.diff.hashes!.planHash);
    // A row: the Binders size gets a cost, so its price moves with its rule (the same writes).
    const row = hashes(notCleanStore({ costs: new Map([...notCleanStore().costs, [401, availableCost(1_000)]]) }));
    expect(row.writesHash).toBe(base.diff.hashes!.writesHash);
    expect(row.planHash).not.toBe(base.diff.hashes!.planHash);
    // A block: the same writes and rows, now past the store text cap.
    const block = hashes(notCleanStore(), MAX_STORE_LISTING_TEXT_BYTES);
    expect(block.writesHash).toBe(base.diff.hashes!.writesHash);
    expect(block.planHash).not.toBe(base.diff.hashes!.planHash);
  });

  it("a cents-only change of a changed row moves the plan hash and not the writes hash", () => {
    const moved = run(notCleanStore({ costs: new Map([...notCleanStore().costs, [403, availableCost(2_000)]]) }));
    const rowOf = (diff: typeof moved.diff) => diff.rows.find((row) => row.productVariantId === 403)!;
    expect(rowOf(moved.diff).changed).toEqual(rowOf(base.diff).changed);
    expect([rowOf(base.diff).before.price.priceCents, rowOf(moved.diff).before.price.priceCents]).toEqual([1_400, 2_800]);
    expect(moved.diff.hashes!.writesHash).toBe(base.diff.hashes!.writesHash);
    expect(moved.diff.hashes!.planHash).not.toBe(base.diff.hashes!.planHash);
  });

  it("the plan hash covers today's side too: a change of only the before values moves it, and not the writes hash", () => {
    // A cost-based group by a copy no category has, and a retail-based store default: a cost moves only today's cents.
    const store = (cost: number) => listingInputs([candidate({ productVariantId: 101, productId: 1, category: "Binders" })], {
      pricing: pricingState([{ id: "binders", priority: 10, scope: byCategory("Binders"), value: COST_PLUS_40 }], RETAIL_PLUS_20),
      costs: costs([[101, cost]]),
    });
    const [low, high] = [run(store(1_000)), run(store(2_000))];
    const [lowRow, highRow] = [low.diff.rows[0], high.diff.rows[0]];
    expect([lowRow.changed, highRow.changed]).toEqual([["price", "priceSource", "pricingRule"], ["price", "priceSource", "pricingRule"]]);
    expect([lowRow.before.price.priceCents, highRow.before.price.priceCents, lowRow.after.price.priceCents]).toEqual([1_400, 2_800, 1_200]);
    expect(conversionKeyValues(highRow.after)).toEqual(conversionKeyValues(lowRow.after));
    expect(high.diff.blocked).toEqual(low.diff.blocked);
    expect(high.diff.hashes!.writesHash).toBe(low.diff.hashes!.writesHash);
    expect(high.diff.hashes!.planHash).not.toBe(low.diff.hashes!.planHash);
  });

  it("ignore generatedAt, product, size and rule names, and the page", () => {
    const later = base.view(0, new Date("2027-01-01T00:00:00.000Z"));
    expect([later.planHash, later.writesHash]).toEqual([base.view().planHash, base.view().writesHash]);
    expect(base.view(1).planHash).toBe(base.view().planHash);
    const listing = notCleanStore();
    const pricing = listing.pricing.profile!;
    const renamed = rebuilt(listing, {
      pricing: { ...listing.pricing, profile: { ...pricing, groups: pricing.groups.map((group) => ({ ...group, name: `Z ${group.name}` })) } },
    }, listing.candidates.map((size) => ({ ...size, productName: `Renamed ${size.productId}`, variantName: `Other ${size.productVariantId}` })));
    const again = run(renamed);
    expect(again.diff.rows.map((row) => row.productName)).not.toEqual(base.diff.rows.map((row) => row.productName));
    expect(again.diff.hashes).toEqual(base.diff.hashes);
  });

  it("hash the canonical writes: the schemas' key order and every list by id", () => {
    const plan: Pick<RulesConversionPlan, "storeConnectionId" | "profiles" | "categories" | "products"> = {
      storeConnectionId: STORE,
      profiles: { pricing: { expectedRevisionId: 41, removedIds: ["alpha", "Zeta"] }, content: null, ebayRules: { expectedRevisionId: 61, removedIds: ["z", "e"] } },
      categories: [
        { categoryId: 13, categoryName: "Toploaders", expectedRevisionId: 813, patch: { ebayCategory: EBAY_TOPLOADERS }, settings: ["ebayCategory"] },
        { categoryId: 12, categoryName: "Sleeves", expectedRevisionId: null,
          patch: { textBelow: { mode: "none" }, price: COST_PLUS_40 }, settings: ["price", "textBelow"] },
      ],
      products: [{ productId: 3, productName: "Gamma", expectedRevisionId: null,
        patch: { ebayCategory: { path: EBAY_SLEEVES.path, categoryName: EBAY_SLEEVES.categoryName, categoryId: EBAY_SLEEVES.categoryId } },
        settings: ["ebayCategory"] }],
    };
    const writes = conversionCanonicalWrites(plan);
    expect(JSON.stringify(writes)).toBe(JSON.stringify({
      v: 1, storeConnectionId: STORE,
      // Ids by UTF-16 code units, never the locale: "Zeta" before "alpha".
      profiles: { pricing: { expectedRevisionId: 41, removedGroupIds: ["Zeta", "alpha"] }, content: null, ebayRules: { expectedRevisionId: 61, removedRuleIds: ["e", "z"] } },
      categories: [
        { categoryId: 12, expectedRevisionId: null, patch: { price: COST_PLUS_40, textBelow: { mode: "none" } } },
        { categoryId: 13, expectedRevisionId: 813, patch: { ebayCategory: EBAY_TOPLOADERS } },
      ],
      products: [{ productId: 3, expectedRevisionId: null, patch: { ebayCategory: EBAY_SLEEVES } }],
    }));
    const hashed = conversionHashes({ plan, rows: [], blocked: { wouldLosePrice: [], wouldBlockListing: [], tooMuchText: false, addedProductTextBytes: 0 } });
    const renamed = conversionHashes({ plan: { ...plan, categories: [...plan.categories].reverse().map((write) => ({ ...write, categoryName: "X" })) },
      rows: [], blocked: { wouldLosePrice: [], wouldBlockListing: [], tooMuchText: false, addedProductTextBytes: 0 } });
    expect(renamed).toEqual(hashed);
    expectInvariant(() => conversionCanonicalWrites({ ...plan, categories: [{ ...plan.categories[0], patch: {} }] }));
  });
});

// ---------------------------------------------------------------------------
// The answer (plan 4.A.3)
// ---------------------------------------------------------------------------

describe("the answer (plan 4.A.3)", () => {
  /** Sixty one-size products in the Binders shape: sixty rows. */
  const sixty = () => {
    const sizes = Array.from({ length: 60 }, (_, index) => candidate({ productVariantId: 1_000 + index, productId: 100 + index,
      productName: `Binder ${index + 1}`, category: "Binders" }));
    return listingInputs(sizes, {
      pricing: pricingState([{ id: "binders", priority: 10, scope: byCategory("Binders"), value: COST_PLUS_40 }]),
      savedPrices: new Map(sizes.map((size) => [size.productVariantId, savedPrice(size.productVariantId, { pricingMode: "inherit" })])),
    });
  };

  it("pages the changed sizes 50 at a time, ordered by product name, size name, then id", () => {
    const { view } = run(sixty());
    const pages = [0, 1, 2].map((page) => listingRulesConversionCheckSchema.parse(view(page)));
    expect(pages.map((page) => [page.changes.page, page.changes.total, page.changes.rows.length])).toEqual([[0, 60, 50], [1, 60, 10], [2, 60, 0]]);
    const names = pages.flatMap((page) => page.changes.rows.map((row) => row.productName));
    // Numbers in names sort as numbers: "Binder 2" before "Binder 10".
    expect(names).toEqual(Array.from({ length: 60 }, (_, index) => `Binder ${index + 1}`));
    expect(pages[0].changes.pageSize).toBe(50);
  });

  it("orders sizes of one name by size name, then id", () => {
    const sizes = [
      candidate({ productVariantId: 3, productId: 2, productName: "Binder", variantName: "Small", category: "Binders" }),
      candidate({ productVariantId: 2, productId: 1, productName: "binder", variantName: "Small", category: "Binders" }),
      candidate({ productVariantId: 1, productId: 1, productName: "binder", variantName: "Large", category: "Binders" }),
    ];
    const listing = listingInputs(sizes, {
      pricing: pricingState([{ id: "binders", priority: 10, scope: byCategory("Binders"), value: COST_PLUS_40 }]),
      savedPrices: new Map(sizes.map((size) => [size.productVariantId, savedPrice(size.productVariantId, { pricingMode: "inherit" })])),
    });
    expect(run(listing).view().changes.rows.map((row) => row.productVariantId)).toEqual([1, 2, 3]);
  });

  it("caps every list at 100 items and counts them all", () => {
    const sizes = Array.from({ length: 120 }, (_, index) => candidate({ productVariantId: 1_000 + index, productId: 100 + index,
      productName: `Folder ${String(index + 1).padStart(3, "0")}`, category: "Folders" }));
    const listing = listingInputs(sizes, {
      pricing: pricingState([{ id: "folders", priority: 10, scope: byCategory("Folders"), value: RETAIL_PLUS_20 }]),
      savedPrices: new Map(sizes.map((size) => [size.productVariantId, savedPrice(size.productVariantId, { pricingMode: "rules" })])),
    });
    const { view } = run(listing);
    const answer = listingRulesConversionCheckSchema.parse(view(2));
    expect([answer.blocked.wouldLosePrice.total, answer.blocked.wouldLosePrice.items.length]).toEqual([120, 100]);
    expect(answer.blocked.wouldLosePrice.items.map((size) => size.productName)).toEqual(sizes.slice(0, 100).map((size) => size.productName));
    expect([answer.report.nameMismatches.total, answer.report.nameMismatches.items.length]).toEqual([120, 100]);
    expect([answer.changes.total, answer.changes.rows.length]).toEqual([120, 20]);
  });

  it("lists what the rules become by name, then id", () => {
    const zebra = { id: 1, name: "Zebra" };
    const apple = { id: 2, name: "apple" };
    const listing = listingInputs([
      candidate({ productVariantId: 11, productId: 1, productName: "zeta", productLineIds: [9] }),
      candidate({ productVariantId: 12, productId: 2, productName: "Alpha", productLineIds: [9] }),
    ], {
      pricing: pricingState([
        { id: "zebra", priority: 10, scope: byCategory("Zebra"), value: COST_PLUS_40 },
        { id: "apple", priority: 10, scope: byCategory("apple"), value: COST_PLUS_25 },
        { id: "line", priority: 1, scope: byProductLine(9), value: RETAIL_PLUS_20 },
      ]),
      categoryNames: new Map(),
    });
    const answer = listingRulesConversionCheckSchema.parse(run(listing, { categoriesByName: categoriesByName(zebra, apple) }).view());
    expect(answer.becomes.categories.items).toEqual([
      { categoryId: 2, categoryName: "apple", settings: ["price"] }, { categoryId: 1, categoryName: "Zebra", settings: ["price"] }]);
    expect(answer.becomes.products.items.map((item) => [item.productId, item.productName])).toEqual([[2, "Alpha"], [1, "zeta"]]);
    expect(answer.state).toBe("clean");
  });

  it("is the whole answer for a store that is not clean, and passes its schema", () => {
    const { view, plan, diff } = run(notCleanStore());
    const answer = listingRulesConversionCheckSchema.parse(view());
    expect(answer).toMatchObject({
      storeConnectionId: STORE, generatedAt: NOW.toISOString(), state: "not_clean",
      planHash: diff.hashes!.planHash, writesHash: diff.hashes!.writesHash,
      olderRules: { pricingGroups: 4, contentGroups: 2, ebayCategoryRules: 1 },
      blocked: { wouldLosePrice: { total: 1 }, wouldBlockListing: { total: 0, items: [] }, tooMuchText: false },
      becomes: { categories: { total: 2 }, products: { total: 1, items: [{ productId: 8, productName: "Line product", settings: ["textAbove", "textBelow"] }] } },
      kept: plan.kept,
      changes: { page: 0, pageSize: 50, total: 3 },
    });
    expect(answer.report.unmatched.items.map((item) => item.ruleName)).toEqual(["Binders price", "Folders price"]);
  });

  it("answers a store with no older rules without comparing anything", () => {
    // Inputs the read model refuses (no size counts): the check never builds it.
    const listing = { ...listingInputs([candidate({ productVariantId: 101, productId: 1 })]), sizesTotalByProductId: new Map<number, number>() };
    expect(() => buildListingSettingsFacts(listing)).toThrow();
    const { diff, view } = run(listing);
    expect(diff).toEqual({ rows: [], blocked: { wouldLosePrice: [], wouldBlockListing: [], tooMuchText: false, addedProductTextBytes: 0 },
      state: "no_older_rules", hashes: null });
    expect(listingRulesConversionCheckSchema.parse(view())).toMatchObject({ state: "no_older_rules", planHash: null, writesHash: null,
      olderRules: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 }, changes: { total: 0, rows: [] } });
  });

  it("refuses a page outside its bounds, a time that is not one, and a diff in a state its plan does not give", () => {
    const { plan, diff } = run(cleanStore());
    expectInvariant(() => conversionCheckView(plan, diff, -1, NOW));
    expectInvariant(() => conversionCheckView(plan, diff, 200, NOW));
    expectInvariant(() => conversionCheckView(plan, diff, 0.5, NOW));
    expectInvariant(() => conversionCheckView(plan, diff, 0, new Date(Number.NaN)));
    expectInvariant(() => conversionCheckView(plan, { ...diff, state: "no_older_rules", hashes: null }, 0, NOW));
    expect(() => conversionCheckView(plan, diff, 199, NOW)).not.toThrow();
  });

  it("refuses another store's diff, and a diff whose rows or hashes are not its own, even when the states agree", () => {
    const binders = run(listingInputs([candidate({ productVariantId: 201, productId: 2, category: "Binders" })], {
      pricing: pricingState([{ id: "binders", priority: 10, scope: byCategory("Binders"), value: RETAIL_PLUS_20 }]),
      savedPrices: new Map([[201, savedPrice(201, { pricingMode: "inherit" })]]),
    }));
    const other = run(notCleanStore());
    expect([binders.diff.state, other.diff.state]).toEqual(["not_clean", "not_clean"]);
    expectInvariant(() => conversionCheckView(other.plan, binders.diff, 0, NOW));
    expectInvariant(() => conversionCheckView(binders.plan, { ...binders.diff, rows: [...binders.diff.rows, ...other.diff.rows] }, 0, NOW));
    expectInvariant(() => conversionCheckView(binders.plan, { ...binders.diff, hashes: other.diff.hashes }, 0, NOW));
    expect(listingRulesConversionCheckSchema.parse(conversionCheckView(binders.plan, binders.diff, 0, NOW)).state).toBe("not_clean");
  });
});

// ---------------------------------------------------------------------------
// Content issues in the `listable` key (plan 3.2)
// ---------------------------------------------------------------------------

describe("content issues in the listable key (plan 3.2)", () => {
  it("classifies exactly the issues the content resolver raises", () => {
    // A drift guard: a sixth issue in the resolver fails here before any store can be called clean over it.
    const source = readFileSync(resolve(process.cwd(), "server/modules/dropship/application/dropship-listing-content-resolver.ts"), "utf8");
    const raised = [...source.matchAll(/issues\.push\("([a-z_]+)"\)/g)].map((match) => match[1]).sort();
    expect(raised).toEqual([...CONTENT_ISSUE_BLOCKERS.keys()].sort());
    expect(raised).toHaveLength(5);
    expect([...CONTENT_ISSUE_BLOCKERS.values()].filter((code) => code !== null)).toEqual([...CONVERSION_CONTENT_BLOCKER_CODES]);
  });

  it("adds the three issues no fix code covers, nothing for the two the fix codes cover, and refuses one it does not know", () => {
    expect(contentIssueBlockers(["listing_content_template_conflict", "listing_content_description_too_large",
      "listing_content_catalog_review_required", "listing_content_catalog_too_large"]))
      .toEqual(["listing_content_description_too_large", "listing_content_catalog_too_large"]);
    expectInvariant(() => contentIssueBlockers(["listing_content_description_required", "listing_content_something_new"]));
  });
});

// ---------------------------------------------------------------------------
// The content walk (plan 4.A.9 "Content resolver")
// ---------------------------------------------------------------------------

describe("matchingContentGroups and today's text winners equal the template's walk", () => {
  const size = inCategory(SLEEVES, { productVariantId: 101, productId: 7 });
  const profiles = {
    none: NO_PROFILE,
    store: contentState([]),
    one: contentState([{ id: "a", priority: 1, scope: byProduct(7), value: { introduction: "A above", footer: "A below" } }]),
    ordered: contentState([
      { id: "b", priority: 2, scope: byProduct(7), value: { introduction: "B", footer: "B" } },
      { id: "a", priority: 1, scope: bySizes(101), value: { introduction: "A", footer: "" } },
    ]),
    tied: contentState([
      { id: "a", priority: 1, scope: byProduct(7), value: { introduction: "A", footer: "A" } },
      { id: "b", priority: 1, scope: byCategory("Sleeves"), value: { introduction: "B", footer: "B" } },
    ]),
  };
  const layerSets = {
    none: layersOf(),
    productAbove: layersOf([productRow(7, { textAbove: { mode: "own", text: "Product above" } })]),
    productBoth: layersOf([productRow(7, { textAbove: { mode: "none" }, textBelow: { mode: "own", text: "Below" } })]),
    category: layersOf([], [categoryRow(SLEEVES.id, { textAbove: { mode: "own", text: "C above" }, textBelow: { mode: "own", text: "C below" } })]),
  };
  const cases = Object.entries(profiles).flatMap(([profileName, profile]) =>
    Object.entries(layerSets).map(([layerName, layers]) => [`${profileName} groups, ${layerName} layers`, profile, layers] as const));

  it.each(cases)("%s", (_name, profile, layers) => {
    const prepared = prepareContentProfile(profile);
    const groups = matchingContentGroups(prepared, size);
    const template = resolveContentTemplate(prepared, size, layers);
    const [winners] = todayWinners(listingInputs([size], { content: profile, layers }));
    for (const part of ["textAbove", "textBelow"] as const) {
      const source = template.parts[part].source;
      const winner = winners[part];
      if (winner.type === "own") expect(source).toBe("product");
      else if (winner.type === "rule") {
        expect(source).toBe("group_rule");
        expect(winner.rule.id).toBe(groups.winner?.id);
        expect(template.groupName).toBe(winner.rule.name);
      } else if (winner.type === "tie") {
        expect(groups.tie).toBe(true);
        expect(template.conflict).toBe(true);
      } else {
        expect(["category", "store_default", "none"]).toContain(source);
        expect(groups.winner).toBeNull();
      }
    }
  });
});
