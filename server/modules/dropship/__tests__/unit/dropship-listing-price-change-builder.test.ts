import { describe, expect, it } from "vitest";
import type { PricingProfileState, PricingRecipe } from "../../../../../shared/dropship/pricing-rules";
import {
  buildListingPriceChanges,
  compareExpectedPrices,
  type ListingPriceChangeSize,
  type TypedInRequestPrice,
} from "../../application/dropship-listing-price-change-builder";
import type { DropshipPricingPolicyRecord } from "../../application/dropship-listing-preview-service";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import {
  NO_PRICING_PROFILE_STATE,
  rulePriceContextFromFacts,
  rulePriceContextOf,
  withRecipes,
  type RulePriceContext,
  type RulePriceRecipeFacts,
} from "../../application/dropship-rule-price";
import { EMPTY_LISTING_SETTING_LAYERS, type ListingSettingLayers } from "../../application/dropship-listing-setting-layers";
import { EMPTY_CATEGORY_LISTING_SETTING_VALUES, EMPTY_PRODUCT_LISTING_SETTING_VALUES } from "../../domain/listing-setting-values";

/**
 * The pure price-change builder (plan PR 9, section 6.4): before and after for
 * every chosen size, `typed` only for a price typed in this request
 * (C-money-3), and the shown-price comparison. Golden agreement with the read
 * model and W9 is pinned in rule-price-golden.test.ts (C-money-6).
 */

const PRODUCT = 700;
const RETAIL = 1_199;
/** 800 x 1.3 = 1,040 at a cent. */
const RECIPE: PricingRecipe = { basis: "product_cost", markupBps: 3_000, flatCents: 0, rounding: "cent" };
const OTHER_RECIPE: PricingRecipe = { basis: "product_cost", markupBps: 5_000, flatCents: 0, rounding: "cent" };
const STORE_DEFAULT: PricingProfileState = {
  revisionId: 41, updatedAt: "2026-10-01T12:00:00.000Z",
  profile: { defaultRecipe: { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" }, groups: [] },
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function available(unitCostCents: number): DropshipProductCost {
  return { status: "available", unitCostCents, planId: "ops", source: "plan_percent", overrideId: null, issue: null,
    retailPriceCents: RETAIL, discountBps: 2_000 };
}
const UNKNOWN_COST: DropshipProductCost = { status: "unavailable", unitCostCents: null, planId: null, source: null, overrideId: null,
  issue: "variant_unmapped", retailPriceCents: null, discountBps: null };

function size(productVariantId: number, fields: Partial<ListingPriceChangeSize> = {}): ListingPriceChangeSize {
  return {
    candidate: { productVariantId, productId: PRODUCT, category: "Toploaders", productLineIds: [9], categoryId: null,
      defaultRetailPriceCents: RETAIL },
    saved: null, existingListingPriceCents: null, cost: available(800), ...fields,
  };
}

function floor(floorPriceCents: number): DropshipPricingPolicyRecord {
  return { id: 5, scopeType: "catalog", productLineId: null, productId: null, productVariantId: null, category: null,
    mode: "block_listing_push", floorPriceCents, ceilingPriceCents: null };
}

const noProfile = rulePriceContextOf(NO_PRICING_PROFILE_STATE, EMPTY_LISTING_SETTING_LAYERS);
const withProductRecipe = withRecipes(noProfile, { products: new Map([[PRODUCT, RECIPE]]) });

function build(input: { before?: RulePriceContext; after?: RulePriceContext; policies?: DropshipPricingPolicyRecord[];
  sizes: ListingPriceChangeSize[]; typed?: Array<[number, TypedInRequestPrice]> }) {
  return buildListingPriceChanges({ before: input.before ?? noProfile, after: input.after ?? input.before ?? noProfile,
    policies: input.policies ?? [], sizes: input.sizes, typedInRequest: new Map(input.typed ?? []) });
}

describe("buildListingPriceChanges (plan PR 9, 6.4)", () => {
  it("leaves a store with no profile and no change on its retail price, before and after", () => {
    expect(build({ sizes: [size(101)] })).toEqual([{ productVariantId: 101, productId: PRODUCT,
      before: { priceCents: RETAIL, blockers: [] }, after: { priceCents: RETAIL, blockers: [], typed: false }, refusal: null, afterRule: null }]);
  });

  it("prices every size by a product's first recipe after the change, in a store with no profile", () => {
    const [change] = build({ before: noProfile, after: withProductRecipe, sizes: [size(101)] });
    expect(change).toMatchObject({ before: { priceCents: RETAIL }, after: { priceCents: 1_040, typed: false }, refusal: null,
      afterRule: { priceCents: 1_040, ruleId: `product:${PRODUCT}`, ruleLevel: "product", blockedByLimit: false } });
  });

  it("takes a size back to nothing (retail) when \"Use default\" removes the product's recipe", () => {
    const removed = withRecipes(withProductRecipe, { products: new Map([[PRODUCT, null]]) });
    const [change] = build({ before: withProductRecipe, after: removed, sizes: [size(101)] });
    expect(change).toMatchObject({ before: { priceCents: 1_040 }, after: { priceCents: RETAIL }, refusal: null, afterRule: null });
  });

  it("follows the store default when a product's recipe is removed in a store with a profile", () => {
    const before = withRecipes(rulePriceContextOf(STORE_DEFAULT, EMPTY_LISTING_SETTING_LAYERS), { products: new Map([[PRODUCT, RECIPE]]) });
    const after = withRecipes(before, { products: new Map([[PRODUCT, null]]) });
    const [change] = build({ before, after, sizes: [size(101)] });
    expect(change).toMatchObject({ before: { priceCents: 1_040 }, after: { priceCents: RETAIL }, refusal: null });
    expect(change.afterRule).toMatchObject({ ruleId: null, priceCents: RETAIL });
  });

  it("sends a released size whose rules cannot price it to retail (L1), never to a refusal", () => {
    const typedBefore = { overridePriceCents: 999, pricingMode: "fixed" as const };
    const [change] = build({ before: withProductRecipe, after: withProductRecipe,
      sizes: [size(101, { saved: typedBefore, cost: UNKNOWN_COST })], typed: [[101, { pricingMode: "inherit" }]] });
    // The recipe needs a cost, which is unknown: the rules give no usable price, so the size follows retail.
    expect(change).toMatchObject({ before: { priceCents: 999 }, after: { priceCents: RETAIL, typed: false }, refusal: null });
    expect(change.afterRule).toMatchObject({ priceCents: null, issue: "pricing_basis_unavailable" });
  });

  it("refuses a recipe whose price a blocking Card Shellz limit refuses, for a size that has a usable price", () => {
    const [change] = build({ before: noProfile, after: withProductRecipe, policies: [floor(1_100)], sizes: [size(101)] });
    expect(change).toMatchObject({ before: { priceCents: RETAIL, blockers: [] },
      after: { priceCents: 1_040, blockers: ["pricing:below_floor:policy_5"], typed: false },
      refusal: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", afterRule: { blockedByLimit: true } });
  });

  it("sends an inherit size whose rule price a blocking limit refuses to retail instead (L1)", () => {
    const inherit = { overridePriceCents: null, pricingMode: "inherit" as const };
    const [change] = build({ before: noProfile, after: withProductRecipe, policies: [floor(1_100)], sizes: [size(101, { saved: inherit })] });
    expect(change).toMatchObject({ before: { priceCents: RETAIL }, after: { priceCents: RETAIL, blockers: [] }, refusal: null });
  });

  it("calls only a price typed in this request typed: a stored typed price under a new limit may stay, a new one may not", () => {
    const stored = { overridePriceCents: 500, pricingMode: "fixed" as const };
    const [kept] = build({ policies: [floor(1_100)], sizes: [size(101, { saved: stored })] });
    expect(kept).toMatchObject({ before: { priceCents: 500 }, after: { priceCents: 500, typed: false }, refusal: null });

    const [typedNow] = build({ policies: [floor(1_100)], sizes: [size(101)], typed: [[101, { pricingMode: "fixed", priceCents: 500 }]] });
    expect(typedNow).toMatchObject({ before: { priceCents: RETAIL }, after: { priceCents: 500, typed: true },
      refusal: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT" });

    const [retyped] = build({ policies: [floor(1_100)], sizes: [size(101, { saved: stored })],
      typed: [[101, { pricingMode: "fixed", priceCents: 500 }]] });
    expect(retyped.refusal).toBe("DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT");
  });

  it("uses an earlier push's price only for a size with no saved setting and no rule, as the shared resolver does", () => {
    const [change] = build({ sizes: [size(101, { existingListingPriceCents: 1_299 })] });
    expect(change.before.priceCents).toBe(1_299);
  });

  it("leaves a size that had no usable price free to stay without one (rule 2)", () => {
    const [change] = build({ sizes: [size(101, { candidate: { ...size(101).candidate, defaultRetailPriceCents: null } })] });
    expect(change).toMatchObject({ before: { priceCents: null, blockers: ["vendor_retail_price_required"] },
      after: { priceCents: null }, refusal: null });
  });

  it("keeps the sizes in the order given and mutates nothing it was given", () => {
    const sizes = deepFreeze([size(103), size(101, { saved: { overridePriceCents: 900, pricingMode: "fixed" } })]);
    const before = deepFreeze(rulePriceContextOf(NO_PRICING_PROFILE_STATE, EMPTY_LISTING_SETTING_LAYERS));
    const after = withRecipes(before, { products: new Map([[PRODUCT, RECIPE]]) });
    const typed = new Map<number, TypedInRequestPrice>([[103, deepFreeze({ pricingMode: "fixed", priceCents: 1_500 })]]);

    const changes = buildListingPriceChanges({ before, after, policies: deepFreeze([floor(100)]), sizes, typedInRequest: typed });

    expect(changes.map((change) => change.productVariantId)).toEqual([103, 101]);
    expect(changes.map((change) => change.after.priceCents)).toEqual([1_500, 900]);
    expect(before.productRules.size).toBe(0);
  });
});

describe("compareExpectedPrices (plan P14)", () => {
  const row = (productVariantId: number, priceCents: number | null) => ({ productVariantId, after: { priceCents, blockers: [], typed: false } });

  it("finds nothing when every chosen size was shown its after price, null for can't price included", () => {
    expect(compareExpectedPrices([row(101, 1_040), row(102, null)], [{ productVariantId: 102, priceCents: null },
      { productVariantId: 101, priceCents: 1_040 }])).toEqual({ missing: [], extra: [], differing: [] });
  });

  it("names a missing, an extra and a differing size, each list ascending", () => {
    const comparison = compareExpectedPrices(
      [row(104, 1_000), row(101, 1_040), row(103, null)],
      [{ productVariantId: 105, priceCents: 999 }, { productVariantId: 101, priceCents: 1_099 }, { productVariantId: 103, priceCents: 500 },
        { productVariantId: 102, priceCents: null }],
    );
    expect(comparison).toEqual({
      missing: [{ productVariantId: 104, priceCents: 1_000 }],
      extra: [{ productVariantId: 102, expectedPriceCents: null }, { productVariantId: 105, expectedPriceCents: 999 }],
      differing: [{ productVariantId: 101, expectedPriceCents: 1_099, priceCents: 1_040 },
        { productVariantId: 103, expectedPriceCents: 500, priceCents: null }],
    });
  });

  it("does not mutate its inputs", () => {
    const rows = deepFreeze([row(102, 1), row(101, 2)]);
    const expected = deepFreeze([{ productVariantId: 103, priceCents: 1 }]);
    expect(() => compareExpectedPrices(rows, expected)).not.toThrow();
  });
});

describe("withRecipes (plan 6.4)", () => {
  function context(state: PricingProfileState): RulePriceContext {
    return { state, productRules: new Map([[700, RECIPE]]), categoryRules: new Map([[4, OTHER_RECIPE]]) };
  }

  it("sets and removes recipes in a new frozen context, and setting then removing gives back the input maps", () => {
    const input = context(STORE_DEFAULT);
    const set = withRecipes(input, { products: new Map([[702, OTHER_RECIPE]]), categories: new Map([[4, null]]) });

    expect(Object.isFrozen(set)).toBe(true);
    expect(set.productRules).not.toBe(input.productRules);
    expect([...set.productRules]).toEqual([[700, RECIPE], [702, OTHER_RECIPE]]);
    expect([...set.categoryRules]).toEqual([]);
    // The input is as it was.
    expect([...input.productRules]).toEqual([[700, RECIPE]]);
    expect([...input.categoryRules]).toEqual([[4, OTHER_RECIPE]]);

    const back = withRecipes(set, { products: new Map([[702, null]]), categories: new Map([[4, OTHER_RECIPE]]) });
    expect(back.productRules).toEqual(input.productRules);
    expect(back.categoryRules).toEqual(input.categoryRules);
    expect(back.state).toBe(input.state);
  });

  it("changes nothing when given no change", () => {
    const input = context(NO_PRICING_PROFILE_STATE);
    const same = withRecipes(input, {});
    expect(same.productRules).toEqual(input.productRules);
    expect(same.categoryRules).toEqual(input.categoryRules);
  });
});

describe("rulePriceContextFromFacts (plan 6.4; v3r, C-feas-2)", () => {
  const SAVED = "2026-10-01T12:00:00.000Z";
  /** The same products and categories as layers (with values) and as facts (prices only). */
  const LAYERS: ListingSettingLayers = deepFreeze({
    products: new Map([
      [700, { storeConnectionId: 22, productId: 700, revisionId: 1, updatedAt: SAVED,
        values: { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, price: RECIPE, textAbove: { mode: "own" as const, text: "Own words." } } }],
      [701, { storeConnectionId: 22, productId: 701, revisionId: 2, updatedAt: SAVED,
        values: { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, storeShelf: { mode: "none" as const } } }],
    ]),
    categories: new Map([
      [4, { storeConnectionId: 22, categoryId: 4, revisionId: 3, updatedAt: SAVED, values: { ...EMPTY_CATEGORY_LISTING_SETTING_VALUES, price: OTHER_RECIPE } }],
      [5, { storeConnectionId: 22, categoryId: 5, revisionId: 4, updatedAt: SAVED, values: EMPTY_CATEGORY_LISTING_SETTING_VALUES }],
    ]),
  });
  const FACTS: RulePriceRecipeFacts = deepFreeze({
    products: new Map([[700, { price: RECIPE }], [701, { price: null }]]),
    categories: new Map([[4, { price: OTHER_RECIPE }], [5, { price: null }]]),
  });

  it("builds the context rulePriceContextOf builds from the same rows' layers: recipes only, a null price is no recipe", () => {
    const fromFacts = rulePriceContextFromFacts(STORE_DEFAULT, FACTS);
    const fromLayers = rulePriceContextOf(STORE_DEFAULT, LAYERS);

    expect(fromFacts.state).toBe(STORE_DEFAULT);
    expect([...fromFacts.productRules]).toEqual([...fromLayers.productRules]);
    expect([...fromFacts.categoryRules]).toEqual([...fromLayers.categoryRules]);
    expect([...fromFacts.productRules]).toEqual([[700, RECIPE]]);
    expect([...fromFacts.categoryRules]).toEqual([[4, OTHER_RECIPE]]);
  });

  it("is a new frozen context that leaves the facts as they were", () => {
    const context = rulePriceContextFromFacts(NO_PRICING_PROFILE_STATE, FACTS);
    expect(Object.isFrozen(context)).toBe(true);
    expect(context.productRules).not.toBe(FACTS.products);
    expect([...FACTS.products.keys()]).toEqual([700, 701]);
    const none = rulePriceContextFromFacts(NO_PRICING_PROFILE_STATE, { products: new Map(), categories: new Map() });
    expect([...none.productRules]).toEqual([]);
    expect([...none.categoryRules]).toEqual([]);
  });

  it("prices every size as the layers' context does, before and after a recipe change (the builder's before side)", () => {
    const sizes = [
      size(101),
      size(102, { candidate: { productVariantId: 102, productId: 701, category: "Toploaders", productLineIds: [9], categoryId: 4,
        defaultRetailPriceCents: RETAIL } }),
      size(103, { candidate: { productVariantId: 103, productId: 702, category: "Toploaders", productLineIds: [9], categoryId: 5,
        defaultRetailPriceCents: RETAIL } }),
    ];
    const change = { products: new Map<number, PricingRecipe | null>([[701, RECIPE]]) };
    const fromFacts = rulePriceContextFromFacts(STORE_DEFAULT, FACTS);
    const fromLayers = rulePriceContextOf(STORE_DEFAULT, LAYERS);

    expect(build({ before: fromFacts, after: withRecipes(fromFacts, change), sizes }))
      .toEqual(build({ before: fromLayers, after: withRecipes(fromLayers, change), sizes }));
  });
});
