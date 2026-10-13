import { describe, expect, it } from "vitest";
import type { ContentProfileState, SavedListingContent } from "../../../../../shared/dropship/listing-content";
import type { SavedListingPriceRevision } from "../../../../../shared/dropship/listing-price";
import {
  listingSettingsCategoriesResponseSchema,
  listingSettingsCategoryDetailSchema,
  listingSettingsPricesResponseSchema,
  listingSettingsProductDetailSchema,
  listingSettingsProductIdsResponseSchema,
  listingSettingsProductsResponseSchema,
  listingSettingsSummarySchema,
} from "../../../../../shared/dropship/listing-settings";
import type { EbayCategoryRulesState } from "../../../../../shared/dropship/ebay-category-rules";
import {
  CATEGORY_LISTING_SETTING_FIELDS, PRODUCT_LISTING_SETTING_FIELDS, categoryListingSettingRowSchema, productListingSettingRowSchema,
  type CategoryListingSettingValues, type ProductListingSettingField, type ProductListingSettingValues,
} from "../../../../../shared/dropship/listing-setting-values";
import type { PricingProfileState } from "../../../../../shared/dropship/pricing-rules";
import { prepareEbayCategoryRules, resolveEbayListingCategory } from "../../application/dropship-ebay-category-resolver";
import type { DropshipEbayListingPolicyOverride } from "../../application/dropship-ebay-listing-policy-override-service";
import { listingCatalogHash, productCatalogHash, resolveListingContent } from "../../application/dropship-listing-content-resolver";
import {
  evaluateListingPricingPolicy,
  type DropshipListingCatalogCandidate, type DropshipListingStoreContext, type DropshipPricingPolicyRecord,
} from "../../application/dropship-listing-preview-service";
import { createRulePriceResolver, rulePriceContextOf } from "../../application/dropship-rule-price";
import {
  buildListingSettingsFacts,
  buildListingSettingsStoreDefaults,
  effectiveSizePrice,
  buildListingSettingsSummary,
  buildTooLargeListingSettingsSummary,
  listingSettingsStockUnits,
  olderGroupRuleCounts,
  ownCategoryFields,
  productOwnFieldsOf,
  selectListingSettingsCategories,
  selectListingSettingsCategory,
  selectListingSettingsPrices,
  selectListingSettingsProduct,
  selectListingSettingsProductIds,
  selectListingSettingsProducts,
  type ListingSettingsInputs,
} from "../../application/dropship-listing-settings-facts";
import { EMPTY_LISTING_SETTING_LAYERS, type ListingSettingLayers } from "../../application/dropship-listing-setting-layers";
import type { DropshipStoreListingConfig } from "../../application/dropship-marketplace-listing-provider";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import { DropshipError } from "../../domain/errors";
import type { ListingSettingLeftoverField } from "../../domain/listing-setting-values";

const GENERATED_AT = new Date("2026-10-06T12:00:00.000Z");
const EMPTY_PRICING: PricingProfileState = { revisionId: null, profile: null, updatedAt: null };
const EMPTY_CONTENT: ContentProfileState = { revisionId: null, profile: null, updatedAt: null };
const EMPTY_CATEGORY_RULES: EbayCategoryRulesState = { revisionId: null, profile: null, updatedAt: null };
const RETAIL_RECIPE = { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" } as const;
const COST_RECIPE = { basis: "product_cost", markupBps: 5_000, flatCents: 0, rounding: "cent" } as const;

function candidate(patch: Partial<DropshipListingCatalogCandidate> = {}): DropshipListingCatalogCandidate {
  return {
    productId: 501, productVariantId: 101, productLineIds: [9], category: "Toploaders", categoryId: null,
    ebayBrowseCategoryId: "183438", ebayBrowseCategoryName: "Card Toploaders & Holders",
    productIsActive: true, variantIsActive: true, variantUomType: "pack", unitsPerVariant: 25,
    defaultRetailPriceCents: 1_199, sku: "TL-35-25", productName: "Toploader 35pt", variantName: "Pack of 25",
    title: "Toploader 35pt", description: "Rigid card protection.", brand: "Card Shellz", gtin: null, mpn: null,
    condition: "new", itemSpecifics: null, imageUrls: [], weightGrams: 100, ...patch,
  };
}

function store(patch: Partial<DropshipListingStoreContext> = {}): DropshipListingStoreContext {
  return { vendorId: 7, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: 5,
    storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true, ...patch };
}

function config(policies: Record<string, string> = { fulfillmentPolicyId: "F1", returnPolicyId: "R1", paymentPolicyId: "P1" }): DropshipStoreListingConfig {
  return { id: 1, storeConnectionId: 5, platform: "ebay", listingMode: "live", inventoryMode: "managed_quantity_sync",
    priceMode: "vendor_defined", marketplaceConfig: { marketplaceId: "EBAY_US", businessPolicies: policies },
    requiredConfigKeys: [], requiredProductFields: [], isActive: true };
}

function cost(unitCostCents: number | null): DropshipProductCost {
  return unitCostCents === null
    ? { status: "unavailable", unitCostCents: null, planId: null, source: null, overrideId: null, issue: "variant_unmapped", retailPriceCents: null, discountBps: null }
    : { status: "available", unitCostCents, planId: "ops", source: "plan_percent", overrideId: null, issue: null, retailPriceCents: 1_199, discountBps: 2_000 };
}

function savedPrice(productVariantId: number, patch: Partial<SavedListingPriceRevision>): SavedListingPriceRevision {
  return { productVariantId, revisionId: 900 + productVariantId, overridePriceCents: null, updatedAt: "2026-10-01T00:00:00.000Z", ...patch };
}

function override(productVariantId: number, patch: Partial<DropshipEbayListingPolicyOverride>): DropshipEbayListingPolicyOverride {
  return { productVariantId, revisionId: 1, fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null,
    updatedAt: new Date("2026-10-01T00:00:00.000Z"), ...patch };
}

function policy(patch: Partial<DropshipPricingPolicyRecord>): DropshipPricingPolicyRecord {
  return { id: 1, scopeType: "catalog", productLineId: null, productId: null, productVariantId: null, category: null,
    mode: "warn_only", floorPriceCents: null, ceilingPriceCents: null, ...patch };
}

/** Card Shellz categories by id with their current names, as the load reads them (plan D19). */
const TOPLOADERS_CATEGORY = 40;
const SLEEVES_CATEGORY = 41;
const CATEGORY_NAMES: ReadonlyMap<number, string> = new Map([[TOPLOADERS_CATEGORY, "Toploaders"], [SLEEVES_CATEGORY, "Sleeves"]]);

function inputs(candidates: DropshipListingCatalogCandidate[], patch: Partial<ListingSettingsInputs> = {}): ListingSettingsInputs {
  const categoryRules = patch.ebayCategoryRules ?? EMPTY_CATEGORY_RULES;
  const layers = patch.layers ?? EMPTY_LISTING_SETTING_LAYERS;
  // The load resolves eBay categories with the same layers it hands the facts.
  const prepared = prepareEbayCategoryRules(categoryRules.revisionId, categoryRules.profile, layers);
  const sizesTotal = new Map<number, number>();
  for (const row of candidates) sizesTotal.set(row.productId, (sizesTotal.get(row.productId) ?? 0) + 1);
  return {
    store: store(),
    candidates,
    sizesTotalByProductId: sizesTotal,
    savedPrices: new Map(),
    existingListings: new Map(),
    pricing: EMPTY_PRICING,
    costs: new Map(),
    pricingPolicies: [],
    listingConfig: config(),
    policyOverrides: new Map(),
    shelfAssignments: new Map(),
    ebayCategoryRules: categoryRules,
    ebayCategories: new Map(candidates.map((row) => [row.productVariantId, resolveEbayListingCategory(row, prepared)])),
    content: EMPTY_CONTENT,
    contentSettings: new Map(),
    pausedSince: new Map(),
    layers,
    categoryNames: CATEGORY_NAMES,
    ...patch,
  };
}

function pricing(profile: NonNullable<PricingProfileState["profile"]>): PricingProfileState {
  return { revisionId: 41, profile, updatedAt: "2026-10-01T12:00:00.000Z" };
}

function onlyPrice(input: ListingSettingsInputs) {
  const facts = buildListingSettingsFacts(input);
  expect(facts.sizes).toHaveLength(1);
  return facts.sizes[0].price;
}

describe("listing settings facts: the price of one size", () => {
  it("reports a typed price as exact, with its saved revision", () => {
    const price = onlyPrice(inputs([candidate()], {
      savedPrices: new Map([[101, savedPrice(101, { overridePriceCents: 1_499, pricingMode: "fixed" })]]),
      pricing: pricing({ defaultRecipe: RETAIL_RECIPE, groups: [] }),
    }));
    expect(price).toMatchObject({ priceCents: 1_499, source: "exact", rule: null, basis: null, basisAmountCents: null,
      issue: null, settingRevisionId: 1_001 });
  });

  it("prices from the store default recipe and names what it starts from", () => {
    const price = onlyPrice(inputs([candidate()], {
      pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [] }),
      costs: new Map([[101, cost(800)]]),
    }));
    // Example numbers: a cost of $8.00 plus a 50% markup is $12.00.
    expect(price).toMatchObject({ priceCents: 1_200, source: "rules", basis: "product_cost", basisAmountCents: 800,
      costCents: 800, issue: null, rule: { kind: "store_default", name: "Store default rule", recipe: COST_RECIPE } });
  });

  it("names the group rule that wins and its own recipe", () => {
    const groupRecipe = { basis: "catalog_retail", markupBps: 1_000, flatCents: 0, rounding: "up_99" } as const;
    const price = onlyPrice(inputs([candidate()], {
      pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [
        { id: "toploaders", name: "Toploaders", priority: 1, scope: { type: "category", category: "Toploaders" }, recipe: groupRecipe },
      ] }),
    }));
    // Example numbers: $11.99 plus 10% is $13.19, which up_99 makes $13.99.
    expect(price).toMatchObject({ priceCents: 1_399, source: "rules", basis: "catalog_retail", basisAmountCents: 1_199,
      rule: { kind: "group", name: "Toploaders", recipe: groupRecipe } });
  });

  it("names no rule when two rules tie, and says why the size has no price", () => {
    const price = onlyPrice(inputs([candidate()], {
      pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [
        { id: "a", name: "A", priority: 1, scope: { type: "category", category: "Toploaders" }, recipe: RETAIL_RECIPE },
        { id: "b", name: "B", priority: 1, scope: { type: "product", productId: 501 }, recipe: RETAIL_RECIPE },
      ] }),
    }));
    expect(price).toMatchObject({ priceCents: null, source: "none", rule: null, basis: null, issue: "pricing_rule_priority_conflict" });
  });

  it("keeps the rule but has no price when the cost it starts from is unknown", () => {
    const price = onlyPrice(inputs([candidate()], {
      pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [] }),
      costs: new Map([[101, cost(null)]]),
    }));
    expect(price).toMatchObject({ priceCents: null, source: "none", basis: "product_cost", basisAmountCents: null, costCents: null,
      issue: "pricing_basis_unavailable", rule: { kind: "store_default" } });
  });

  it("reports a size saved to follow rules in a store without rules", () => {
    const price = onlyPrice(inputs([candidate()], {
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "rules" })]]),
    }));
    expect(price).toMatchObject({ priceCents: null, source: "none", issue: "pricing_rules_not_configured" });
  });

  it("falls back to the last published price, then the catalog price, without rules", () => {
    const published = onlyPrice(inputs([candidate()], {
      existingListings: new Map([[101, { listingId: 1, productVariantId: 101, status: "active", vendorRetailPriceCents: 1_350, quantityCap: null, externalListingId: "x" }]]),
    }));
    expect(published).toMatchObject({ priceCents: 1_350, source: "last_published" });
    expect(onlyPrice(inputs([candidate()]))).toMatchObject({ priceCents: 1_199, source: "catalog_price" });
    expect(onlyPrice(inputs([candidate({ defaultRetailPriceCents: null })])))
      .toMatchObject({ priceCents: null, source: "none", issue: "price_unavailable" });
  });

  it("never brings back the last published price after the vendor chose the catalog price", () => {
    const price = onlyPrice(inputs([candidate()], {
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "catalog_default" })]]),
      existingListings: new Map([[101, { listingId: 1, productVariantId: 101, status: "active", vendorRetailPriceCents: 1_350, quantityCap: null, externalListingId: "x" }]]),
    }));
    expect(price).toMatchObject({ priceCents: 1_199, source: "catalog_price" });
  });

  it("says how much each sale loses below the cost, and nothing at or above it", () => {
    const at = (priceCents: number, costCents: number) => onlyPrice(inputs([candidate()], {
      savedPrices: new Map([[101, savedPrice(101, { overridePriceCents: priceCents, pricingMode: "fixed" })]]),
      costs: new Map([[101, cost(costCents)]]),
    })).belowCostByCents;
    expect(at(999, 1_039)).toBe(40);
    expect(at(1_039, 1_039)).toBeNull();
    expect(at(1_100, 1_039)).toBeNull();
  });

  it("lists every Card Shellz limit that covers the size, with its mode and any breach", () => {
    const price = onlyPrice(inputs([candidate()], {
      savedPrices: new Map([[101, savedPrice(101, { overridePriceCents: 450, pricingMode: "fixed" })]]),
      pricingPolicies: [
        policy({ id: 1, mode: "warn_only", floorPriceCents: 500 }),
        policy({ id: 2, mode: "block_listing_push", scopeType: "variant", productVariantId: 101, ceilingPriceCents: 4_000 }),
        policy({ id: 3, mode: "block_order_acceptance", scopeType: "category", category: " toploaders ", floorPriceCents: 400 }),
        policy({ id: 4, mode: "off", floorPriceCents: 9_999 }),
        policy({ id: 5, mode: "warn_only", scopeType: "product", productId: 999, floorPriceCents: 9_999 }),
      ],
    }));
    expect(price.limits).toEqual([
      { policyId: 1, floorCents: 500, ceilingCents: null, mode: "warn", breached: "below_floor" },
      { policyId: 2, floorCents: null, ceilingCents: 4_000, mode: "block_listing", breached: null },
      { policyId: 3, floorCents: 400, ceilingCents: null, mode: "refuse_orders", breached: null },
    ]);
  });

  it("prices an inherit size without rules at retail, as a retail fallback, never at the last published price (A3)", () => {
    const price = onlyPrice(inputs([candidate()], {
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
      existingListings: new Map([[101, { listingId: 1, productVariantId: 101, status: "active", vendorRetailPriceCents: 1_350, quantityCap: null, externalListingId: "x" }]]),
      costs: new Map([[101, cost(800)]]),
    }));
    expect(price).toMatchObject({ priceCents: 1_199, source: "retail_fallback", rule: null, basis: null, basisAmountCents: null,
      issue: null, costCents: 800, belowCostByCents: null, settingRevisionId: 1_001 });
  });

  it("prices an inherit size by the store's rules when they give a price", () => {
    const price = onlyPrice(inputs([candidate()], {
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
      pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [] }),
      costs: new Map([[101, cost(800)]]),
    }));
    expect(price).toMatchObject({ priceCents: 1_200, source: "rules", basis: "product_cost", basisAmountCents: 800, issue: null,
      rule: { kind: "store_default", name: "Store default rule", recipe: COST_RECIPE } });
  });

  it("falls back to retail for an inherit size its rules can't price, and says why (L1)", () => {
    const tie = onlyPrice(inputs([candidate()], {
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
      pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [
        { id: "a", name: "A", priority: 1, scope: { type: "category", category: "Toploaders" }, recipe: RETAIL_RECIPE },
        { id: "b", name: "B", priority: 1, scope: { type: "product", productId: 501 }, recipe: RETAIL_RECIPE },
      ] }),
    }));
    expect(tie).toMatchObject({ priceCents: 1_199, source: "retail_fallback", rule: null, basis: null, issue: "pricing_rule_priority_conflict" });
    const noCost = onlyPrice(inputs([candidate()], {
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
      pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [] }),
      costs: new Map([[101, cost(null)]]),
    }));
    expect(noCost).toMatchObject({ priceCents: 1_199, source: "retail_fallback", rule: null, basis: null, issue: "pricing_basis_unavailable" });
    // A fallback has a price, so it is no fix and no "can't price" count.
    const facts = buildListingSettingsFacts(inputs([candidate()], {
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
      pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [] }),
    }));
    expect(facts.sizes[0].fixes).toEqual([]);
    expect(buildListingSettingsSummary(facts, GENERATED_AT).counts).toMatchObject({ cannotPrice: 0, productsNeedingFix: 0 });
  });

  it("falls back to retail for an inherit size whose rule price a blocking Card Shellz limit refuses, and says why (L1)", () => {
    // The rules give $9.00 (cost $6.00 + 50%), under a $10.00 blocking minimum; the $11.99 retail price clears it.
    const blocking = policy({ id: 7, mode: "block_listing_push", floorPriceCents: 1_000 });
    const sources = {
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
      pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [] }),
      costs: new Map([[101, cost(600)]]),
    };
    const facts = buildListingSettingsFacts(inputs([candidate()], { ...sources, pricingPolicies: [blocking] }));
    expect(facts.sizes[0].price).toMatchObject({ priceCents: 1_199, source: "retail_fallback", rule: null, basis: null,
      basisAmountCents: null, issue: "pricing_rule_outside_limit", costCents: 600,
      limits: [{ policyId: 7, floorCents: 1_000, ceilingCents: null, mode: "block_listing", breached: null }] });
    expect(facts.sizes[0].fixes).toEqual([]);
    expect(buildListingSettingsSummary(facts, GENERATED_AT).counts).toMatchObject({ cannotPrice: 0, productsNeedingFix: 0 });
    expect(listingSettingsPricesResponseSchema.safeParse({ storeConnectionId: 5, page: 0, pageSize: 50, total: 1,
      rows: [facts.sizes[0].price], generatedAt: GENERATED_AT.toISOString() }).success).toBe(true);
    // When the minimum refuses the retail price too, the size is still on its retail price, and the limit shows as broken.
    expect(onlyPrice(inputs([candidate()], { ...sources, pricingPolicies: [{ ...blocking, floorPriceCents: 1_250 }] })))
      .toMatchObject({ priceCents: 1_199, source: "retail_fallback", issue: "pricing_rule_outside_limit",
        limits: [{ policyId: 7, mode: "block_listing", breached: "below_floor" }] });
    // A warn-only limit leaves the rule price in place.
    expect(onlyPrice(inputs([candidate()], { ...sources, pricingPolicies: [policy({ id: 8, floorPriceCents: 1_000 })] })))
      .toMatchObject({ priceCents: 900, source: "rules", issue: null, limits: [{ policyId: 8, mode: "warn", breached: "below_floor" }] });
    // A `rules` size keeps the rule price, and the limit shows as broken.
    expect(onlyPrice(inputs([candidate()], { ...sources, pricingPolicies: [blocking],
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "rules" })]]) })))
      .toMatchObject({ priceCents: 900, source: "rules", issue: null, limits: [{ policyId: 7, breached: "below_floor" }] });
  });

  it("has no price for an inherit size with no rule price and no retail price", () => {
    const price = onlyPrice(inputs([candidate({ defaultRetailPriceCents: null })], {
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
      existingListings: new Map([[101, { listingId: 1, productVariantId: 101, status: "active", vendorRetailPriceCents: 1_350, quantityCap: null, externalListingId: "x" }]]),
    }));
    expect(price).toMatchObject({ priceCents: null, source: "none", issue: "price_unavailable" });
  });

  it("still reports a never-saved size without rules as the catalog or last published price", () => {
    expect(onlyPrice(inputs([candidate()]))).toMatchObject({ source: "catalog_price", settingRevisionId: null });
    expect(onlyPrice(inputs([candidate()], {
      existingListings: new Map([[101, { listingId: 1, productVariantId: 101, status: "active", vendorRetailPriceCents: 1_350, quantityCap: null, externalListingId: "x" }]]),
    }))).toMatchObject({ source: "last_published", priceCents: 1_350 });
  });

  it("reports a size paused by a cost change", () => {
    const price = onlyPrice(inputs([candidate()], { pausedSince: new Map([[101, new Date("2026-10-02T09:30:00.000Z")]]) }));
    expect(price.pausedSince).toBe("2026-10-02T09:30:00.000Z");
  });
});

describe("effectiveSizePrice: the facts' size price, extracted for the price-change builder (plan PR 9, 6.4, C-feas-8)", () => {
  const listing = (vendorRetailPriceCents: number) => new Map([[101, { listingId: 1, productVariantId: 101, status: "active",
    vendorRetailPriceCents, quantityCap: null, externalListingId: "x" }]]);
  const tie = pricing({ defaultRecipe: COST_RECIPE, groups: [
    { id: "a", name: "A", priority: 1, scope: { type: "category", category: "Toploaders" }, recipe: RETAIL_RECIPE },
    { id: "b", name: "B", priority: 1, scope: { type: "product", productId: 501 }, recipe: RETAIL_RECIPE },
  ] });
  const productRecipe = productListingSettingRowSchema.parse({ storeConnectionId: 5, productId: 501, revisionId: 3,
    updatedAt: "2026-10-01T00:00:00.000Z", values: { price: COST_RECIPE, ebayCategory: null, storeShelf: null, shippingPolicy: null,
      returnPolicy: null, paymentPolicy: null, textAbove: null, textBelow: null, mainText: null } });
  /** The facts' price table, case by case: each sets what decides one size's price. */
  const table: ReadonlyArray<[string, ListingSettingsInputs]> = [
    ["a typed price", inputs([candidate()], { savedPrices: new Map([[101, savedPrice(101, { overridePriceCents: 1_499, pricingMode: "fixed" })]]),
      pricing: pricing({ defaultRecipe: RETAIL_RECIPE, groups: [] }) })],
    ["the store default recipe", inputs([candidate()], { pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [] }), costs: new Map([[101, cost(800)]]) })],
    ["a tie", inputs([candidate()], { pricing: tie })],
    ["an unknown cost", inputs([candidate()], { pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [] }), costs: new Map([[101, cost(null)]]) })],
    ["rules with no rules", inputs([candidate()], { savedPrices: new Map([[101, savedPrice(101, { pricingMode: "rules" })]]) })],
    ["the last published price", inputs([candidate()], { existingListings: listing(1_350) })],
    ["the catalog price", inputs([candidate()])],
    ["no retail price", inputs([candidate({ defaultRetailPriceCents: null })])],
    ["the catalog price over a published one", inputs([candidate()], {
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "catalog_default" })]]), existingListings: listing(1_350) })],
    ["inherit without rules", inputs([candidate()], { savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
      existingListings: listing(1_350), costs: new Map([[101, cost(800)]]) })],
    ["inherit by the rules", inputs([candidate()], { savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
      pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [] }), costs: new Map([[101, cost(800)]]) })],
    ["inherit on a tie", inputs([candidate()], { savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]), pricing: tie })],
    ["inherit under a blocking limit", inputs([candidate()], { savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
      pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [] }), costs: new Map([[101, cost(600)]]),
      pricingPolicies: [policy({ id: 7, mode: "block_listing_push", floorPriceCents: 1_000 })] })],
    ["rules under a blocking limit", inputs([candidate()], { savedPrices: new Map([[101, savedPrice(101, { pricingMode: "rules" })]]),
      pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [] }), costs: new Map([[101, cost(600)]]),
      pricingPolicies: [policy({ id: 7, mode: "block_listing_push", floorPriceCents: 1_000 })] })],
    ["a typed price under every limit kind", inputs([candidate()], {
      savedPrices: new Map([[101, savedPrice(101, { overridePriceCents: 450, pricingMode: "fixed" })]]),
      pricingPolicies: [policy({ id: 1, mode: "warn_only", floorPriceCents: 500 }),
        policy({ id: 2, mode: "block_listing_push", scopeType: "variant", productVariantId: 101, ceilingPriceCents: 4_000 })] })],
    ["the product's own price in a store with no rules", inputs([candidate()], {
      layers: { products: new Map([[501, productRecipe]]), categories: new Map() }, costs: new Map([[101, cost(800)]]) })],
  ];
  const SOURCE = { override: "exact", rules: "rules", catalog_default: "catalog_price", saved_listing: "last_published", unavailable: "none" } as const;

  it.each(table)("gives the facts' price, source, cost and limits: %s", (_name, input) => {
    const facts = onlyPrice(input);
    const size = input.candidates[0];
    const effective = effectiveSizePrice({
      candidate: size, saved: input.savedPrices.get(101) ?? null, cost: input.costs.get(101) ?? null,
      pricingPolicies: input.pricingPolicies, existingListingPriceCents: input.existingListings.get(101)?.vendorRetailPriceCents ?? null,
      resolver: createRulePriceResolver(rulePriceContextOf(input.pricing, input.layers)),
    });
    expect(effective.priceCents).toBe(facts.priceCents);
    expect(effective.resolved.effectivePriceCents).toBe(facts.priceCents);
    expect(effective.costCents).toBe(facts.costCents);
    expect(facts.source === "retail_fallback" ? "catalog_price" : facts.source).toBe(SOURCE[effective.resolved.source]);
    // The limits are the facts' at that price: a blocking limit is broken exactly when the price has a blocker.
    const blocked = facts.limits.some((limit) => limit.mode === "block_listing" && limit.breached !== null);
    expect(blocked).toBe(facts.priceCents !== null
      && evaluateListingPricingPolicy(size, input.pricingPolicies, effective.priceCents).blockers.length > 0);
  });
});

describe("listing settings facts: a product's sizes", () => {
  const small = candidate({ productVariantId: 101, variantName: "Pack of 25", sku: "TL-25" });
  const large = candidate({ productVariantId: 102, variantName: "Pack of 100", sku: "TL-100", defaultRetailPriceCents: 3_999 });

  it("rolls up the chosen sizes, price range and exact prices", () => {
    const facts = buildListingSettingsFacts(inputs([small, large], {
      sizesTotalByProductId: new Map([[501, 4]]),
      savedPrices: new Map([[102, savedPrice(102, { overridePriceCents: 3_499, pricingMode: "fixed" })]]),
    }));
    expect(facts.products).toHaveLength(1);
    expect(facts.products[0].row).toEqual({
      productId: 501, productName: "Toploader 35pt", category: "Toploaders", sizesChosen: 2, sizesTotal: 4,
      priceRange: { minCents: 1_199, maxCents: 3_499 }, exactPriceCount: 1, ownSettings: [], sizesDiffer: [], fixes: [],
    });
    // Sizes are listed by name within a product, numbers in number order.
    expect(facts.sizes.map((size) => size.price.sizeName)).toEqual(["Pack of 25", "Pack of 100"]);
  });

  it("marks a policy one size overrides as its own setting, and as sizes differ", () => {
    const facts = buildListingSettingsFacts(inputs([small, large], {
      policyOverrides: new Map([[102, override(102, { fulfillmentPolicyId: "F2" })]]),
    }));
    expect(facts.products[0].row.ownSettings).toEqual(["shipping_policy"]);
    expect(facts.products[0].row.sizesDiffer).toEqual(["shipping_policy"]);
  });

  it("does not call a policy different when the override repeats the store default", () => {
    const facts = buildListingSettingsFacts(inputs([small, large], {
      policyOverrides: new Map([[102, override(102, { returnPolicyId: "R1" })]]),
    }));
    expect(facts.products[0].row.ownSettings).toEqual(["return_policy"]);
    expect(facts.products[0].row.sizesDiffer).toEqual([]);
  });

  it("reports a store shelf on one size", () => {
    const facts = buildListingSettingsFacts(inputs([small, large], { shelfAssignments: new Map([[101, ["Supplies:Toploaders"]]]) }));
    expect(facts.products[0].row.ownSettings).toEqual(["store_shelf"]);
    expect(facts.products[0].row.sizesDiffer).toEqual(["store_shelf"]);
  });

  it("compares sizes' own descriptions by their text, kept as a short key", () => {
    const text = (customText: string, revisionId: number): SavedListingContent =>
      ({ revisionId, customText, catalogHash: "0".repeat(64), updatedAt: "2026-10-01T00:00:00.000Z" });
    const longest = "x".repeat(20_000);
    const same = buildListingSettingsFacts(inputs([small, large], {
      contentSettings: new Map([[101, text(longest, 3)], [102, text(longest, 4)]]),
    }));
    expect(same.products[0].row).toMatchObject({ ownSettings: ["description"], sizesDiffer: [] });
    expect(same.sizes[0].values.mainText.key.length).toBeLessThan(100);
    const different = buildListingSettingsFacts(inputs([small, large], {
      contentSettings: new Map([[101, text(longest, 3)], [102, text(`${longest.slice(1)}y`, 4)]]),
    }));
    expect(different.products[0].row.sizesDiffer).toEqual(["description"]);
  });

  it("asks for a check of own text saved against an older catalog, and not of current own text", () => {
    const own = (catalogHash: string): SavedListingContent => ({ revisionId: 3, customText: "My words", catalogHash, updatedAt: "2026-10-01T00:00:00.000Z" });
    const stale = buildListingSettingsFacts(inputs([small], { contentSettings: new Map([[101, own("0".repeat(64))]]) }));
    expect(stale.products[0].row).toMatchObject({ ownSettings: ["description"], fixes: ["own_text_needs_check"] });
    const current = buildListingSettingsFacts(inputs([small], { contentSettings: new Map([[101, own(listingCatalogHash(small))]]) }));
    expect(current.products[0].row).toMatchObject({ ownSettings: ["description"], fixes: [] });
  });

  it("needs a fix when two description groups tie for a size", () => {
    const template = { introduction: "Hi", footer: "" };
    const facts = buildListingSettingsFacts(inputs([small], { content: { revisionId: 2, updatedAt: "2026-10-01T00:00:00.000Z", profile: {
      defaultTemplate: { introduction: "", footer: "" },
      groups: [
        { id: "a", name: "A", priority: 3, scope: { type: "category", category: "Toploaders" }, template },
        { id: "b", name: "B", priority: 3, scope: { type: "product", productId: 501 }, template },
      ] } } }));
    expect(facts.products[0].row.fixes).toEqual(["description_group_conflict"]);
  });

  it("needs a fix when no eBay category can be found, and when a size can't be priced", () => {
    const facts = buildListingSettingsFacts(inputs([
      candidate({ productVariantId: 101, ebayBrowseCategoryId: null, ebayBrowseCategoryName: null, defaultRetailPriceCents: null }),
    ]));
    expect(facts.products[0].row.fixes).toEqual(["no_ebay_category", "size_cannot_be_priced"]);
  });

  it("refuses inputs that miss a size's category result or a product's size count", () => {
    expect(() => buildListingSettingsFacts(inputs([small], { ebayCategories: new Map() }))).toThrow(/eBay category/);
    expect(() => buildListingSettingsFacts(inputs([small], { sizesTotalByProductId: new Map() }))).toThrow(/size count/);
  });

  it("orders products by name regardless of case, then id", () => {
    const facts = buildListingSettingsFacts(inputs([
      candidate({ productId: 3, productVariantId: 31, productName: "sleeves" }),
      candidate({ productId: 2, productVariantId: 21, productName: "Armalopes" }),
      candidate({ productId: 1, productVariantId: 11, productName: "Sleeves" }),
    ]));
    expect(facts.products.map((product) => product.row.productId)).toEqual([2, 1, 3]);
  });
});

describe("listing settings facts: one product", () => {
  const small = candidate({ productVariantId: 101, variantName: "Pack of 25", sku: "TL-25" });
  const large = candidate({ productVariantId: 102, variantName: "Pack of 100", sku: "TL-100", defaultRetailPriceCents: 3_999 });
  const huge = candidate({ productVariantId: 103, variantName: "Pack of 1000", sku: "TL-1000", defaultRetailPriceCents: 9_999 });
  const content = (profile: NonNullable<ContentProfileState["profile"]>): ContentProfileState =>
    ({ revisionId: 2, updatedAt: "2026-10-01T00:00:00.000Z", profile });
  const select = (input: ListingSettingsInputs, productId = 501) => {
    const selection = selectListingSettingsProduct(buildListingSettingsFacts(input), productId);
    if (!selection) throw new Error("expected the product");
    return selection;
  };
  /** The answer the route sends, so each test also checks the contract's own rules. */
  const detail = (selection: ReturnType<typeof select>) => listingSettingsProductDetailSchema.parse({
    storeConnectionId: 5, ...selection, sizes: selection.sizes.map((size) => ({ ...size, stockUnits: 0 })),
    stock: { state: "ok", checkedAt: GENERATED_AT.toISOString() }, generatedAt: GENERATED_AT.toISOString(),
  });

  it("gives one value per setting when every size agrees, with where the sizes get it", () => {
    const selection = select(inputs([small, large]));
    expect(selection.settings.shippingPolicy).toEqual([
      { value: { policyId: "F1" }, sources: [{ source: "store_default", ruleName: null, productVariantIds: [101, 102] }] },
    ]);
    expect(selection.settings.ebayCategory).toEqual([{
      value: { categoryId: "183438", categoryName: "Card Toploaders & Holders" },
      sources: [{ source: "catalog", ruleName: null, productVariantIds: [101, 102] }],
    }]);
    expect(selection.settings.storeShelf).toEqual([
      { value: { names: [] }, sources: [{ source: "none", ruleName: null, productVariantIds: [101, 102] }] },
    ]);
    expect(selection.settings.descriptionTemplate).toEqual([{
      value: { hasIntroduction: false, hasFooter: false, groupConflict: false },
      sources: [{ source: "none", ruleName: null, productVariantIds: [101, 102] }],
    }]);
    expect(selection.settings.mainText).toEqual([
      { value: { own: false }, sources: [{ source: "catalog", ruleName: null, productVariantIds: [101, 102] }] },
    ]);
    expect(selection.sizes.map((size) => size.price.productVariantId)).toEqual([101, 102]);
    expect(detail(selection).product).toMatchObject({ productId: 501, sizesChosen: 2, ownSettings: [], sizesDiffer: [] });
  });

  it("lists each value with its sizes when sizes differ, the most used first", () => {
    const selection = select(inputs([small, large, huge], {
      policyOverrides: new Map([[103, override(103, { fulfillmentPolicyId: "F9" })]]),
    }));
    expect(selection.settings.shippingPolicy).toEqual([
      { value: { policyId: "F1" }, sources: [{ source: "store_default", ruleName: null, productVariantIds: [101, 102] }] },
      { value: { policyId: "F9" }, sources: [{ source: "size", ruleName: null, productVariantIds: [103] }] },
    ]);
    expect(detail(selection).product).toMatchObject({ ownSettings: ["shipping_policy"], sizesDiffer: ["shipping_policy"] });
  });

  it("keeps one value when a size's own policy repeats the store default, and says which sizes have it as their own", () => {
    const selection = select(inputs([small, large], { policyOverrides: new Map([[102, override(102, { returnPolicyId: "R1" })]]) }));
    expect(selection.settings.returnPolicy).toEqual([{ value: { policyId: "R1" }, sources: [
      { source: "size", ruleName: null, productVariantIds: [102] },
      { source: "store_default", ruleName: null, productVariantIds: [101] },
    ] }]);
    expect(detail(selection).product).toMatchObject({ ownSettings: ["return_policy"], sizesDiffer: [] });
  });

  it("reports no policy, and no own value, while the store has no listing config", () => {
    const selection = select(inputs([small], { listingConfig: null,
      policyOverrides: new Map([[101, override(101, { fulfillmentPolicyId: "F9" })]]) }));
    expect(selection.settings.shippingPolicy).toEqual([
      { value: { policyId: null }, sources: [{ source: "none", ruleName: null, productVariantIds: [101] }] },
    ]);
    expect(detail(selection).product.ownSettings).toEqual([]);
  });

  it("names the older eBay category rule a value comes from", () => {
    const rules: EbayCategoryRulesState = { revisionId: 4, updatedAt: "2026-10-01T00:00:00.000Z", profile: {
      version: 1,
      defaultCategory: { categoryId: "261328", categoryName: "Card Sleeves", path: ["Collectibles", "Card Sleeves"] },
      rules: [{ id: "big", name: "Big packs", scope: { type: "listings", productVariantIds: [103] },
        category: { categoryId: "183438", categoryName: "Toploaders & Holders", path: ["Collectibles", "Toploaders & Holders"] } }],
    } };
    const selection = select(inputs([small, huge], { ebayCategoryRules: rules }));
    expect(selection.settings.ebayCategory).toEqual([
      { value: { categoryId: "261328", categoryName: "Card Sleeves" },
        sources: [{ source: "store_default", ruleName: null, productVariantIds: [101] }] },
      { value: { categoryId: "183438", categoryName: "Toploaders & Holders" },
        sources: [{ source: "group_rule", ruleName: "Big packs", productVariantIds: [103] }] },
    ]);
  });

  it("compares the text above and below by the words sent, not by the template's name", () => {
    const template = { introduction: "Fast shipping.", footer: "" };
    const twin = { id: "twin", name: "Store template", priority: 1, scope: { type: "listings" as const, productVariantIds: [102] }, template };
    const same = select(inputs([small, large], { content: content({ defaultTemplate: template, groups: [twin] }) }));
    // A group named like the store template, with the same words: one value, from two places.
    expect(same.settings.descriptionTemplate).toEqual([{
      value: { hasIntroduction: true, hasFooter: false, groupConflict: false },
      sources: [
        { source: "group_rule", ruleName: "Store template", productVariantIds: [102] },
        { source: "store_default", ruleName: null, productVariantIds: [101] },
      ],
    }]);
    expect(detail(same).product.sizesDiffer).toEqual([]);
    const other = select(inputs([small, large], { content: content({ defaultTemplate: template,
      groups: [{ ...twin, template: { introduction: "Ships in a box.", footer: "" } }] }) }));
    expect(other.settings.descriptionTemplate).toHaveLength(2);
    expect(detail(other).product.sizesDiffer).toEqual(["description"]);
  });

  it("treats a blank template as no text above or below", () => {
    const blank = select(inputs([small, large], { content: content({ defaultTemplate: { introduction: "  ", footer: "\n" }, groups: [
      { id: "g", name: "Blank group", priority: 1, scope: { type: "listings", productVariantIds: [102] }, template: { introduction: "", footer: "" } },
    ] }) }));
    expect(blank.settings.descriptionTemplate).toHaveLength(1);
    expect(blank.settings.descriptionTemplate[0].value).toEqual({ hasIntroduction: false, hasFooter: false, groupConflict: false });
  });

  it("marks sizes whose description groups tie as a conflict, apart from sizes with no text", () => {
    const template = { introduction: "Hi", footer: "" };
    const selection = select(inputs([small, large], { content: content({ defaultTemplate: { introduction: "", footer: "" }, groups: [
      { id: "a", name: "A", priority: 3, scope: { type: "listings", productVariantIds: [101] }, template },
      { id: "b", name: "B", priority: 3, scope: { type: "listings", productVariantIds: [101] }, template },
    ] }) }));
    expect(selection.settings.descriptionTemplate).toEqual([
      { value: { hasIntroduction: false, hasFooter: false, groupConflict: true },
        sources: [{ source: "none", ruleName: null, productVariantIds: [101] }] },
      { value: { hasIntroduction: false, hasFooter: false, groupConflict: false },
        sources: [{ source: "store_default", ruleName: null, productVariantIds: [102] }] },
    ]);
    expect(detail(selection).product).toMatchObject({ sizesDiffer: ["description"], fixes: ["description_group_conflict"] });
  });

  it("tells a size's own main text apart from another size's own text", () => {
    const own = (customText: string): SavedListingContent =>
      ({ revisionId: 3, customText, catalogHash: listingCatalogHash(small), updatedAt: "2026-10-01T00:00:00.000Z" });
    const selection = select(inputs([small, large, huge], { contentSettings: new Map([[101, own("Mine")], [102, own("Also mine")]]) }));
    expect(selection.settings.mainText.map((value) => [value.value, value.sources.map((entry) => entry.productVariantIds)])).toEqual([
      [{ own: true }, [[101]]], [{ own: true }, [[102]]], [{ own: false }, [[103]]],
    ]);
    expect(detail(selection).product).toMatchObject({ ownSettings: ["description"], sizesDiffer: ["description"] });
  });

  it("keeps a size's shelves in order: a swapped first and second shelf is a different value", () => {
    const selection = select(inputs([small, large], {
      shelfAssignments: new Map([[101, ["Toploaders", "Sleeves"]], [102, ["Sleeves", "Toploaders"]]]),
    }));
    expect(selection.settings.storeShelf.map((value) => value.value.names)).toEqual([["Toploaders", "Sleeves"], ["Sleeves", "Toploaders"]]);
    expect(detail(selection).product.sizesDiffer).toEqual(["store_shelf"]);
  });

  it("shares one value object among the sizes that agree, and keeps it whole", () => {
    const facts = buildListingSettingsFacts(inputs([small, large], { shelfAssignments: new Map([[101, ["Toploaders"]], [102, ["Toploaders"]]]) }));
    expect(facts.sizes[0].values.shippingPolicy).toBe(facts.sizes[1].values.shippingPolicy);
    expect(facts.sizes[0].values.storeShelf).toBe(facts.sizes[1].values.storeShelf);
    expect(Object.isFrozen(facts.sizes[0].values.shippingPolicy)).toBe(true);
    expect(Object.isFrozen(facts.sizes[0].values.storeShelf.value)).toBe(true);
    expect(Object.isFrozen(facts.sizes[0].values.storeShelf.value.names)).toBe(true);
  });

  it("keeps each size's own eBay category name, and groups the sizes by the category id eBay lists by", () => {
    const named = candidate({ productVariantId: 102, variantName: "Pack of 100", ebayBrowseCategoryName: "Toploaders & Holders" });
    const facts = buildListingSettingsFacts(inputs([small, named]));
    expect(facts.sizes.map((size) => size.values.ebayCategory.value.categoryName)).toEqual(["Card Toploaders & Holders", "Toploaders & Holders"]);
    const selection = selectListingSettingsProduct(facts, 501);
    expect(selection?.settings.ebayCategory).toEqual([{ value: { categoryId: "183438", categoryName: "Card Toploaders & Holders" },
      sources: [{ source: "catalog", ruleName: null, productVariantIds: [101, 102] }] }]);
    expect(selection?.product.sizesDiffer).toEqual([]);
  });

  it("finds no product that has no chosen size", () => {
    expect(selectListingSettingsProduct(buildListingSettingsFacts(inputs([small])), 999)).toBeNull();
  });

  it("refuses an answer whose flags disagree with its settings", () => {
    const selection = select(inputs([small, large], { policyOverrides: new Map([[102, override(102, { fulfillmentPolicyId: "F2" })]]) }));
    const answer = { storeConnectionId: 5, ...selection, sizes: selection.sizes.map((size) => ({ ...size, stockUnits: 1 })),
      stock: { state: "ok", checkedAt: GENERATED_AT.toISOString() }, generatedAt: GENERATED_AT.toISOString() };
    expect(listingSettingsProductDetailSchema.safeParse(answer).success).toBe(true);
    expect(listingSettingsProductDetailSchema.safeParse({ ...answer, product: { ...answer.product, sizesDiffer: [] } }).success).toBe(false);
    expect(listingSettingsProductDetailSchema.safeParse({ ...answer, product: { ...answer.product, ownSettings: [] } }).success).toBe(false);
    expect(listingSettingsProductDetailSchema.safeParse({ ...answer, sizes: answer.sizes.slice(1) }).success).toBe(false);
    expect(listingSettingsProductDetailSchema.safeParse({ ...answer,
      stock: { state: "unavailable", retryable: true, checkedAt: GENERATED_AT.toISOString() } }).success).toBe(false);
  });
});

describe("listing settings facts: product and category settings", () => {
  const SAVED_AT = "2026-10-01T00:00:00.000Z";
  const SLEEVES_EBAY = { categoryId: "261328", categoryName: "Card Sleeves", path: ["Collectibles", "Card Sleeves"] };
  const TOPLOADERS_EBAY = { categoryId: "183438", categoryName: "Toploaders & Holders", path: ["Collectibles", "Toploaders & Holders"] };
  /** Example numbers: an $11.99 retail price plus $3.00 is $14.99. */
  const RETAIL_PLUS_300 = { basis: "catalog_retail", markupBps: 0, flatCents: 300, rounding: "cent" } as const;
  const small = candidate({ productVariantId: 101, variantName: "Pack of 25", sku: "TL-25", categoryId: TOPLOADERS_CATEGORY });
  const large = candidate({ productVariantId: 102, variantName: "Pack of 100", sku: "TL-100", categoryId: TOPLOADERS_CATEGORY,
    defaultRetailPriceCents: 3_999 });

  function productValues(patch: Partial<ProductListingSettingValues> = {}): ProductListingSettingValues {
    return { price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
      textAbove: null, textBelow: null, mainText: null, ...patch };
  }
  function categoryValues(patch: Partial<CategoryListingSettingValues> = {}): CategoryListingSettingValues {
    const { mainText: _productOnly, ...values } = productValues();
    return { ...values, ...patch };
  }
  /** Current rows as the 8a readers return them, parsed with the stored contract so a fixture can't hold a value no row can. */
  function layers(rows: {
    products?: ReadonlyArray<readonly [number, ProductListingSettingValues]>;
    categories?: ReadonlyArray<readonly [number, CategoryListingSettingValues]>;
  }): ListingSettingLayers {
    return {
      products: new Map((rows.products ?? []).map(([productId, values], index) => [productId, productListingSettingRowSchema.parse(
        { storeConnectionId: 5, productId, revisionId: 800 + index, updatedAt: SAVED_AT, values })])),
      categories: new Map((rows.categories ?? []).map(([categoryId, values], index) => [categoryId, categoryListingSettingRowSchema.parse(
        { storeConnectionId: 5, categoryId, revisionId: 900 + index, updatedAt: SAVED_AT, values })])),
    };
  }
  function configWith(extra: Record<string, unknown>): DropshipStoreListingConfig {
    const base = config();
    return { ...base, marketplaceConfig: { ...base.marketplaceConfig, ...extra } };
  }
  const select = (input: ListingSettingsInputs, productId = 501) => {
    const selection = selectListingSettingsProduct(buildListingSettingsFacts(input), productId);
    if (!selection) throw new Error("expected the product");
    return selection;
  };
  /** The answer the route sends: the contract checks that only group rules and categories are named, and the own-setting flags. */
  const detail = (selection: ReturnType<typeof select>) => listingSettingsProductDetailSchema.parse({
    storeConnectionId: 5, ...selection, sizes: selection.sizes.map((size) => ({ ...size, stockUnits: 0 })),
    stock: { state: "ok", checkedAt: GENERATED_AT.toISOString() }, generatedAt: GENERATED_AT.toISOString(),
  });
  const pricesPage = (rows: unknown[]) => listingSettingsPricesResponseSchema.parse({ storeConnectionId: 5, page: 0, pageSize: 50,
    total: rows.length, rows, generatedAt: GENERATED_AT.toISOString() });
  const sourceOf = (selection: ReturnType<typeof select>, key: keyof ReturnType<typeof select>["settings"]) =>
    selection.settings[key].flatMap((value) => value.sources.map((entry) => [entry.source, entry.ruleName, entry.productVariantIds]));

  it("gives every size the product's own settings, as the product's own values", () => {
    const own = productValues({
      price: COST_RECIPE,
      ebayCategory: SLEEVES_EBAY,
      storeShelf: { mode: "own", shelves: [{ id: "11", name: "Supplies:Toploaders" }] },
      shippingPolicy: { id: "F-product", name: "Product shipping" },
      textAbove: { mode: "own", text: "Ships next day." },
      textBelow: { mode: "none" },
      mainText: { text: "Our own words.", catalogHash: productCatalogHash(small) },
    });
    const input = inputs([small, large], { layers: layers({ products: [[501, own]] }), costs: new Map([[101, cost(800)], [102, cost(2_000)]]) });
    const selection = select(input);
    // Example numbers: a cost of $8.00 plus 50% is $12.00, and $20.00 plus 50% is $30.00.
    expect(selection.sizes.map((size) => [size.price.productVariantId, size.price.priceCents, size.price.source])).toEqual([
      [101, 1_200, "rules"], [102, 3_000, "rules"],
    ]);
    expect(selection.sizes[0].price).toMatchObject({ basis: "product_cost", basisAmountCents: 800, issue: null,
      rule: { kind: "product", name: "Toploader 35pt", recipe: COST_RECIPE } });
    expect(selection.settings.shippingPolicy).toEqual([
      { value: { policyId: "F-product" }, sources: [{ source: "product", ruleName: null, productVariantIds: [101, 102] }] },
    ]);
    expect(sourceOf(selection, "returnPolicy")).toEqual([["store_default", null, [101, 102]]]);
    expect(selection.settings.ebayCategory).toEqual([{ value: { categoryId: "261328", categoryName: "Card Sleeves" },
      sources: [{ source: "product", ruleName: null, productVariantIds: [101, 102] }] }]);
    expect(selection.settings.storeShelf).toEqual([{ value: { names: ["Supplies:Toploaders"] },
      sources: [{ source: "product", ruleName: null, productVariantIds: [101, 102] }] }]);
    expect(selection.settings.descriptionTemplate).toEqual([{ value: { hasIntroduction: true, hasFooter: false, groupConflict: false },
      sources: [{ source: "product", ruleName: null, productVariantIds: [101, 102] }] }]);
    expect(selection.settings.mainText).toEqual([
      { value: { own: true }, sources: [{ source: "product", ruleName: null, productVariantIds: [101, 102] }] },
    ]);
    expect(detail(selection).product).toMatchObject({ ownSettings: ["shipping_policy", "ebay_category", "store_shelf", "description"],
      sizesDiffer: [], fixes: [] });
    expect(pricesPage(selection.sizes.map((size) => size.price)).rows).toHaveLength(2);
    const summary = buildListingSettingsSummary(buildListingSettingsFacts(input), GENERATED_AT);
    expect(summary.counts).toMatchObject({ productsWithOwnSettings: 1, productsNeedingFix: 0 });
    expect(selectListingSettingsProducts(buildListingSettingsFacts(input), { search: "", show: "own_settings", page: 0 }).total).toBe(1);
  });

  it("gives a category's settings to its products, named by the category's current Card Shellz name", () => {
    const shared = layers({ categories: [[TOPLOADERS_CATEGORY, categoryValues({
      price: RETAIL_PLUS_300,
      ebayCategory: TOPLOADERS_EBAY,
      storeShelf: { mode: "own", shelves: [{ id: "12", name: "Toploaders" }] },
      returnPolicy: { id: "R-category", name: null },
      textBelow: { mode: "own", text: "Thank you for your order." },
    })]] });
    const selection = select(inputs([small], { layers: shared }));
    // No store rules: the category's own price covers the size.
    expect(selection.sizes[0].price).toMatchObject({ priceCents: 1_499, source: "rules", basis: "catalog_retail", basisAmountCents: 1_199,
      rule: { kind: "category", name: "Toploaders", recipe: RETAIL_PLUS_300 } });
    expect(sourceOf(selection, "returnPolicy")).toEqual([["category", "Toploaders", [101]]]);
    expect(selection.settings.returnPolicy[0].value).toEqual({ policyId: "R-category" });
    expect(sourceOf(selection, "shippingPolicy")).toEqual([["store_default", null, [101]]]);
    expect(selection.settings.ebayCategory).toEqual([{ value: { categoryId: "183438", categoryName: "Toploaders & Holders" },
      sources: [{ source: "category", ruleName: "Toploaders", productVariantIds: [101] }] }]);
    expect(selection.settings.storeShelf[0]).toEqual({ value: { names: ["Toploaders"] },
      sources: [{ source: "category", ruleName: "Toploaders", productVariantIds: [101] }] });
    expect(selection.settings.descriptionTemplate[0]).toEqual({ value: { hasIntroduction: false, hasFooter: true, groupConflict: false },
      sources: [{ source: "category", ruleName: "Toploaders", productVariantIds: [101] }] });
    expect(sourceOf(selection, "mainText")).toEqual([["catalog", null, [101]]]);
    // A category's value is not the product's own.
    expect(detail(selection).product).toMatchObject({ ownSettings: [], sizesDiffer: [] });
    expect(pricesPage([selection.sizes[0].price]).rows[0].rule).toMatchObject({ kind: "category", name: "Toploaders" });

    // A Card Shellz rename shows at once and changes no value.
    const renamed = select(inputs([small], { layers: shared, categoryNames: new Map([[TOPLOADERS_CATEGORY, "Top loaders"]]) }));
    expect(sourceOf(renamed, "returnPolicy")).toEqual([["category", "Top loaders", [101]]]);
    expect(renamed.sizes[0].price.rule).toMatchObject({ kind: "category", name: "Top loaders" });
    expect(renamed.settings.storeShelf.map((value) => value.value)).toEqual(selection.settings.storeShelf.map((value) => value.value));
    expect(renamed.sizes[0].price.priceCents).toBe(1_499);
  });

  it("skips the category step for a product with no Card Shellz category, whatever category rows exist", () => {
    const noCategory = candidate({ categoryId: null });
    const everything = layers({ categories: [[TOPLOADERS_CATEGORY, categoryValues({ price: RETAIL_PLUS_300, ebayCategory: TOPLOADERS_EBAY,
      returnPolicy: { id: "R-category", name: null }, storeShelf: { mode: "none" }, textAbove: { mode: "own", text: "Hi" } })]] });
    const withRows = buildListingSettingsFacts(inputs([noCategory], { layers: everything, categoryNames: new Map() }));
    const without = buildListingSettingsFacts(inputs([noCategory]));
    expect(withRows.sizes).toEqual(without.sizes);
    expect(withRows.products).toEqual(without.products);
    expect(withRows.sizes[0].price).toMatchObject({ priceCents: 1_199, source: "catalog_price", rule: null });
  });

  it("follows the new category's settings after Card Shellz moves the product", () => {
    const both = layers({ categories: [
      [TOPLOADERS_CATEGORY, categoryValues({ returnPolicy: { id: "R-toploaders", name: null }, price: RETAIL_PLUS_300 })],
      [SLEEVES_CATEGORY, categoryValues({ returnPolicy: { id: "R-sleeves", name: null }, price: RETAIL_RECIPE })],
    ] });
    const before = select(inputs([small], { layers: both }));
    expect(before.settings.returnPolicy).toEqual([{ value: { policyId: "R-toploaders" },
      sources: [{ source: "category", ruleName: "Toploaders", productVariantIds: [101] }] }]);
    expect(before.sizes[0].price).toMatchObject({ priceCents: 1_499, rule: { kind: "category", name: "Toploaders" } });
    const moved = select(inputs([{ ...small, categoryId: SLEEVES_CATEGORY }], { layers: both }));
    expect(moved.settings.returnPolicy).toEqual([{ value: { policyId: "R-sleeves" },
      sources: [{ source: "category", ruleName: "Sleeves", productVariantIds: [101] }] }]);
    expect(moved.sizes[0].price).toMatchObject({ priceCents: 1_199, rule: { kind: "category", name: "Sleeves", recipe: RETAIL_RECIPE } });
  });

  it("takes the closest value for each setting: the size's leftover, then the product's, then the category's", () => {
    const sizeText = (customText: string): SavedListingContent =>
      ({ revisionId: 3, customText, catalogHash: listingCatalogHash(small), updatedAt: SAVED_AT });
    const stack = layers({
      products: [[501, productValues({
        shippingPolicy: { id: "F-product", name: null }, returnPolicy: { id: "R-product", name: null },
        storeShelf: { mode: "none" }, textAbove: { mode: "own", text: "Product above." },
        mainText: { text: "Product words.", catalogHash: productCatalogHash(small) },
      })]],
      categories: [[TOPLOADERS_CATEGORY, categoryValues({
        price: RETAIL_PLUS_300, shippingPolicy: { id: "F-category", name: null }, returnPolicy: { id: "R-category", name: null },
        paymentPolicy: { id: "P-category", name: null }, storeShelf: { mode: "own", shelves: [{ id: "12", name: "Toploaders" }] },
        textAbove: { mode: "own", text: "Category above." }, textBelow: { mode: "own", text: "Category below." },
      })]],
    });
    const input = inputs([small, large], {
      layers: stack,
      listingConfig: configWith({ storeShelfDefault: { ids: ["7"], names: ["Store shelf"] } }),
      policyOverrides: new Map([[101, override(101, { fulfillmentPolicyId: "F-size" })]]),
      shelfAssignments: new Map([[101, ["Size shelf"]]]),
      contentSettings: new Map([[101, sizeText("Size words.")]]),
    });
    const selection = select(input);
    expect(sourceOf(selection, "shippingPolicy")).toEqual([["size", null, [101]], ["product", null, [102]]]);
    expect(selection.settings.shippingPolicy.map((value) => value.value.policyId)).toEqual(["F-size", "F-product"]);
    expect(sourceOf(selection, "returnPolicy")).toEqual([["product", null, [101, 102]]]);
    expect(sourceOf(selection, "paymentPolicy")).toEqual([["category", "Toploaders", [101, 102]]]);
    // The product's "none" beats both the category's shelves and the store default.
    expect(selection.settings.storeShelf).toEqual([
      { value: { names: ["Size shelf"] }, sources: [{ source: "size", ruleName: null, productVariantIds: [101] }] },
      { value: { names: [] }, sources: [{ source: "product", ruleName: null, productVariantIds: [102] }] },
    ]);
    // Text above from the product, below from the category: one value, from its closer part (plan D18).
    expect(selection.settings.descriptionTemplate).toEqual([{ value: { hasIntroduction: true, hasFooter: true, groupConflict: false },
      sources: [{ source: "product", ruleName: null, productVariantIds: [101, 102] }] }]);
    expect(sourceOf(selection, "mainText")).toEqual([["size", null, [101]], ["product", null, [102]]]);
    expect(selection.sizes.map((size) => size.price.rule?.kind)).toEqual(["category", "category"]);
    expect(detail(selection).product).toMatchObject({
      ownSettings: ["shipping_policy", "return_policy", "store_shelf", "description"],
      sizesDiffer: ["shipping_policy", "store_shelf", "description"],
    });
    // The step 3 preview builds the same description from the same layers: product text above, category text below, the product's main text.
    const preview = resolveListingContent({ candidate: large, profile: EMPTY_CONTENT, saved: null, layers: stack });
    expect(preview).toMatchObject({ source: "custom", templateName: "This product", needsCatalogReview: false });
    expect(preview.descriptionText).toContain("Product above.");
    expect(preview.descriptionText).toContain("Product words.");
    expect(preview.descriptionText).toContain("Category below.");
  });

  it("puts the store's older group rules after the product and before the category", () => {
    const group = { id: "toploaders", name: "Toploaders group", priority: 1, scope: { type: "category" as const, category: "Toploaders" } };
    const categoryOnly = layers({ categories: [[TOPLOADERS_CATEGORY, categoryValues({
      price: RETAIL_PLUS_300, ebayCategory: SLEEVES_EBAY, textAbove: { mode: "own", text: "Category above." },
      textBelow: { mode: "own", text: "Category below." },
    })]] });
    const older = {
      pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [{ ...group, recipe: RETAIL_RECIPE }] }),
      ebayCategoryRules: { revisionId: 4, updatedAt: SAVED_AT, profile: { version: 1 as const, defaultCategory: null,
        rules: [{ id: "big", name: "Big packs", scope: { type: "listings" as const, productVariantIds: [101] }, category: TOPLOADERS_EBAY }] } },
      content: { revisionId: 2, updatedAt: SAVED_AT, profile: { defaultTemplate: { introduction: "Store above.", footer: "" },
        groups: [{ ...group, template: { introduction: "Group above.", footer: "Group below." } }] } },
    } satisfies Partial<ListingSettingsInputs>;
    const groupWins = select(inputs([small, large], { ...older, layers: categoryOnly }));
    expect(groupWins.sizes.map((size) => size.price.rule)).toEqual([
      { kind: "group", name: "Toploaders group", recipe: RETAIL_RECIPE }, { kind: "group", name: "Toploaders group", recipe: RETAIL_RECIPE },
    ]);
    // The older eBay rule names size 101 only; size 102 falls through to its category.
    expect(sourceOf(groupWins, "ebayCategory")).toEqual([["group_rule", "Big packs", [101]], ["category", "Toploaders", [102]]]);
    expect(sourceOf(groupWins, "descriptionTemplate")).toEqual([["group_rule", "Toploaders group", [101, 102]]]);

    const productAbove = layers({ products: [[501, productValues({ price: COST_RECIPE, textAbove: { mode: "none" } })]],
      categories: [[TOPLOADERS_CATEGORY, categoryValues({ price: RETAIL_PLUS_300 })]] });
    const productWins = select(inputs([small], { ...older, layers: productAbove, costs: new Map([[101, cost(800)]]) }));
    expect(productWins.sizes[0].price).toMatchObject({ priceCents: 1_200, rule: { kind: "product", name: "Toploader 35pt" } });
    // Text above is the product's "None"; text below still comes from the group, so the closer source names the product.
    expect(productWins.settings.descriptionTemplate).toEqual([{ value: { hasIntroduction: false, hasFooter: true, groupConflict: false },
      sources: [{ source: "product", ruleName: null, productVariantIds: [101] }] }]);
  });

  it("gives sizes without a shelf of their own the store shelf default (the documented change at the 8b deploy)", () => {
    const withDefault = configWith({ storeShelfDefault: { ids: ["7", "9"], names: ["Supplies", "Supplies:Toploaders"] } });
    const selection = select(inputs([small, large], { listingConfig: withDefault, shelfAssignments: new Map([[101, ["Size shelf"]]]) }));
    expect(selection.settings.storeShelf).toEqual([
      { value: { names: ["Size shelf"] }, sources: [{ source: "size", ruleName: null, productVariantIds: [101] }] },
      { value: { names: ["Supplies", "Supplies:Toploaders"] }, sources: [{ source: "store_default", ruleName: null, productVariantIds: [102] }] },
    ]);
    expect(detail(selection).product).toMatchObject({ ownSettings: ["store_shelf"], sizesDiffer: ["store_shelf"] });
    // A malformed default is no default, as the setup view reads it.
    const malformed = select(inputs([large], { listingConfig: configWith({ storeShelfDefault: { ids: ["7"], names: [] } }) }));
    expect(sourceOf(malformed, "storeShelf")).toEqual([["none", null, [102]]]);
  });

  it("asks for a check of the product's own text only when the product's catalog facts changed", () => {
    const text = (catalogHash: string) => layers({ products: [[501, productValues({ mainText: { text: "Product words.", catalogHash } })]] });
    const stale = buildListingSettingsFacts(inputs([small], { layers: text("0".repeat(64)) }));
    expect(stale.sizes[0].fixes).toEqual(["own_text_needs_check"]);
    expect(buildListingSettingsSummary(stale, GENERATED_AT).attention.items)
      .toContainEqual({ code: "own_text_needs_check", count: 1, productId: null, productName: null });
    expect(buildListingSettingsFacts(inputs([small], { layers: text(productCatalogHash(small)) })).sizes[0].fixes).toEqual([]);
    // A size-only catalog change does not ask the vendor to re-check product text (design record 8.3).
    const resized = { ...small, variantName: "Pack of 30", sku: "TL-30", gtin: "0123456789012", mpn: "M-30", unitsPerVariant: 30 };
    expect(buildListingSettingsFacts(inputs([resized], { layers: text(productCatalogHash(small)) })).sizes[0].fixes).toEqual([]);
    expect(buildListingSettingsFacts(inputs([{ ...small, description: "New words." }], { layers: text(productCatalogHash(small)) }))
      .sizes[0].fixes).toEqual(["own_text_needs_check"]);
    // A size with its own text does not use the product's, so the product's text is not checked for it.
    const sizeText: SavedListingContent = { revisionId: 3, customText: "Size words.", catalogHash: listingCatalogHash(small), updatedAt: SAVED_AT };
    expect(buildListingSettingsFacts(inputs([small], { layers: text("0".repeat(64)), contentSettings: new Map([[101, sizeText]]) }))
      .sizes[0].fixes).toEqual([]);
  });

  it("prices inherit and rules sizes by the product's own price in a store without rules", () => {
    const own = layers({ products: [[501, productValues({ price: COST_RECIPE })]] });
    const inherit = onlyPrice(inputs([small], { layers: own, costs: new Map([[101, cost(800)]]),
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]) }));
    expect(inherit).toMatchObject({ priceCents: 1_200, source: "rules", rule: { kind: "product" }, issue: null });
    const rules = onlyPrice(inputs([small], { layers: own, costs: new Map([[101, cost(800)]]),
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "rules" })]]) }));
    expect(rules).toMatchObject({ priceCents: 1_200, source: "rules", issue: null });
    // Without a known cost the product's recipe gives no price: an inherit size falls back to retail and says why.
    const noCost = onlyPrice(inputs([small], { layers: own, costs: new Map([[101, cost(null)]]),
      savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]) }));
    expect(noCost).toMatchObject({ priceCents: 1_199, source: "retail_fallback", rule: null, issue: "pricing_basis_unavailable" });
    // An exact price still beats every rule.
    expect(onlyPrice(inputs([small], { layers: own,
      savedPrices: new Map([[101, savedPrice(101, { overridePriceCents: 999, pricingMode: "fixed" })]]) })))
      .toMatchObject({ priceCents: 999, source: "exact", rule: null });
    // A blank Card Shellz product name still labels the rule.
    expect(onlyPrice(inputs([{ ...small, productName: " " }], { layers: own, costs: new Map([[101, cost(800)]]) })).rule)
      .toMatchObject({ kind: "product", name: "Product price" });
  });

  it("keeps the Own settings chip, its count and the column in step for a product whose only own value is its price", () => {
    const input = inputs([small], { layers: layers({ products: [[501, productValues({ price: COST_RECIPE })]] }),
      costs: new Map([[101, cost(800)]]) });
    const facts = buildListingSettingsFacts(input);
    // The product's recipe prices the size ...
    expect(facts.sizes[0].price).toMatchObject({ priceCents: 1_200, rule: { kind: "product" } });
    // ... but the row has no price field, so none of the three counts it (hasOwnSettings; widening the row is PR 9/10 work).
    expect(detail(select(input)).product).toMatchObject({ ownSettings: [], exactPriceCount: 0 });
    expect(buildListingSettingsSummary(facts, GENERATED_AT).counts).toMatchObject({ productsWithOwnSettings: 0 });
    expect(selectListingSettingsProducts(facts, { search: "", show: "own_settings", page: 0 }).total).toBe(0);
  });

  it("changes nothing for rows of products and categories no chosen size has", () => {
    const elsewhere = layers({
      products: [[999, productValues({ price: COST_RECIPE, storeShelf: { mode: "none" }, shippingPolicy: { id: "F-other", name: null } })]],
      categories: [[SLEEVES_CATEGORY, categoryValues({ price: RETAIL_PLUS_300, returnPolicy: { id: "R-other", name: null } })]],
    });
    const base = { pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [] }), costs: new Map([[101, cost(800)], [102, cost(2_000)]]),
      policyOverrides: new Map([[102, override(102, { returnPolicyId: "R1" })]]), shelfAssignments: new Map([[101, ["Size shelf"]]]) };
    const withRows = buildListingSettingsFacts(inputs([small, large], { ...base, layers: elsewhere }));
    const without = buildListingSettingsFacts(inputs([small, large], base));
    expect(withRows.sizes).toEqual(without.sizes);
    expect(withRows.products).toEqual(without.products);
    expect(buildListingSettingsSummary(withRows, GENERATED_AT)).toEqual(buildListingSettingsSummary(without, GENERATED_AT));
  });

  it("refuses a category value it has no Card Shellz name for: the load reads one for every category with settings", () => {
    const shared = layers({ categories: [[TOPLOADERS_CATEGORY, categoryValues({ returnPolicy: { id: "R-category", name: null } })]] });
    const error = (() => {
      try {
        buildListingSettingsFacts(inputs([small], { layers: shared, categoryNames: new Map() }));
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(DropshipError);
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      context: { categoryId: TOPLOADERS_CATEGORY, productVariantId: 101, classification: "fatal" } });
  });
});

describe("listing settings facts: stock for one product", () => {
  const caps = [{ productVariantId: 101, enabledOverride: true, marketplaceQuantityCap: 5 }];

  it("caps a size's stock at the vendor's own cap under legacy quantity authority, as the preview does", () => {
    const units = listingSettingsStockUnits({ snapshot: { authority: "legacy", quantities: new Map([[101, 40], [102, 3]]) },
      overrides: caps, productVariantIds: [101, 102] });
    expect([...units]).toEqual([[101, 5], [102, 3]]);
  });

  it("leaves canonical quantities as they are: the cap is already in them", () => {
    const units = listingSettingsStockUnits({ snapshot: { authority: "canonical", quantities: new Map([[101, 40]]) },
      overrides: caps, productVariantIds: [101] });
    expect(units.get(101)).toBe(40);
  });

  it("gives 0 for a size with no stock, and refuses a read that skipped a size", () => {
    expect(listingSettingsStockUnits({ snapshot: { authority: "legacy", quantities: new Map([[101, 0]]) },
      overrides: [], productVariantIds: [101] }).get(101)).toBe(0);
    expect(() => listingSettingsStockUnits({ snapshot: { authority: "legacy", quantities: new Map() },
      overrides: [], productVariantIds: [101] })).toThrow(/no quantity for size 101/);
  });
});

describe("listing settings facts: lists", () => {
  const rows = Array.from({ length: 120 }, (_, index) => candidate({
    productId: 1_000 + Math.floor(index / 2), productVariantId: 10_000 + index,
    productName: `Product ${String(Math.floor(index / 2)).padStart(3, "0")}`, variantName: index % 2 ? "Large" : "Small",
    sku: `SKU-${index}`,
  }));

  it("pages the Prices tab 50 sizes at a time", () => {
    const facts = buildListingSettingsFacts(inputs(rows));
    const second = selectListingSettingsPrices(facts, { search: "", show: "all", page: 1 });
    expect(second.total).toBe(120);
    expect(second.rows).toHaveLength(50);
    expect(second.rows[0].productName).toBe("Product 025");
    expect(selectListingSettingsPrices(facts, { search: "", show: "all", page: 3 }).rows).toEqual([]);
    expect(listingSettingsPricesResponseSchema.safeParse({ storeConnectionId: 5, page: 1, pageSize: 50, total: second.total,
      rows: second.rows, generatedAt: GENERATED_AT.toISOString() }).success).toBe(true);
  });

  it("finds a product by its name, or by a size's name or SKU, ignoring case", () => {
    const facts = buildListingSettingsFacts(inputs(rows));
    const byName = selectListingSettingsProducts(facts, { search: "product 007", show: "all", page: 0 });
    expect(byName.rows.map((row) => [row.productId, row.matchedSize])).toEqual([[1_007, null]]);
    const bySku = selectListingSettingsProducts(facts, { search: "sku-15", show: "all", page: 0 });
    expect(bySku.rows.map((row) => [row.productId, row.matchedSize?.sku])).toEqual([[1_007, "SKU-15"]]);
    expect(listingSettingsProductsResponseSchema.safeParse({ storeConnectionId: 5, page: 0, pageSize: 50, total: bySku.total,
      rows: bySku.rows, generatedAt: GENERATED_AT.toISOString() }).success).toBe(true);
    expect(selectListingSettingsPrices(facts, { search: "LARGE", show: "all", page: 0 }).total).toBe(60);
  });

  it("filters each tab by what the vendor asked to see", () => {
    const facts = buildListingSettingsFacts(inputs([
      candidate({ productId: 1, productVariantId: 11, productName: "A" }),
      candidate({ productId: 2, productVariantId: 21, productName: "B", defaultRetailPriceCents: null }),
      candidate({ productId: 3, productVariantId: 31, productName: "C" }),
    ], {
      savedPrices: new Map([[11, savedPrice(11, { overridePriceCents: 500, pricingMode: "fixed" })]]),
      costs: new Map([[11, cost(700)]]),
      pausedSince: new Map([[31, new Date("2026-10-02T00:00:00.000Z")]]),
    }));
    const products = (show: Parameters<typeof selectListingSettingsProducts>[1]["show"]) =>
      selectListingSettingsProducts(facts, { search: "", show, page: 0 }).rows.map((row) => row.productId);
    expect(products("exact_prices")).toEqual([1]);
    // An exact price is the product's own setting: the Products tab's Own settings column names it first.
    expect(products("own_settings")).toEqual([1]);
    expect(buildListingSettingsSummary(facts, GENERATED_AT).counts?.productsWithOwnSettings).toBe(1);
    expect(products("below_cost")).toEqual([1]);
    expect(products("cannot_price")).toEqual([2]);
    expect(products("needs_fix")).toEqual([2]);
    const prices = (show: Parameters<typeof selectListingSettingsPrices>[1]["show"]) =>
      selectListingSettingsPrices(facts, { search: "", show, page: 0 }).rows.map((row) => row.productVariantId);
    expect(prices("paused")).toEqual([31]);
    expect(prices("cannot_price")).toEqual([21]);
    expect(prices("retail_fallback")).toEqual([]);
  });

  it("lists only the retail fallbacks under retail_fallback", () => {
    const facts = buildListingSettingsFacts(inputs([
      candidate({ productId: 1, productVariantId: 11, productName: "A" }),
      candidate({ productId: 2, productVariantId: 21, productName: "B" }),
      candidate({ productId: 3, productVariantId: 31, productName: "C" }),
      candidate({ productId: 4, productVariantId: 41, productName: "D", defaultRetailPriceCents: null }),
    ], {
      savedPrices: new Map([
        [11, savedPrice(11, { pricingMode: "inherit" })],
        [21, savedPrice(21, { pricingMode: "catalog_default" })],
        [41, savedPrice(41, { pricingMode: "inherit" })],
      ]),
    }));
    const page = selectListingSettingsPrices(facts, { search: "", show: "retail_fallback", page: 0 });
    expect(page.rows.map((row) => [row.productVariantId, row.source])).toEqual([[11, "retail_fallback"]]);
    expect(page.total).toBe(1);
    expect(listingSettingsPricesResponseSchema.safeParse({ storeConnectionId: 5, page: 0, pageSize: 50, total: page.total,
      rows: page.rows, generatedAt: GENERATED_AT.toISOString() }).success).toBe(true);
  });
});

describe("listing settings summary", () => {
  it("counts what the page shows and says All set when nothing needs the vendor", () => {
    const summary = buildListingSettingsSummary(buildListingSettingsFacts(inputs([candidate()])), GENERATED_AT);
    expect(listingSettingsSummarySchema.parse(summary)).toEqual(summary);
    expect(summary).toMatchObject({
      catalog: { state: "ok", products: 1, sizes: 1 },
      counts: { productsNeedingFix: 0, exactPrices: 0, cannotPrice: 0, belowCost: 0, paused: 0 },
      attention: { items: [], total: 0 },
      rail: { state: "all_set", productsNeedingFix: 0, missingPolicy: null },
      access: { allowed: true },
      generatedAt: "2026-10-06T12:00:00.000Z",
    });
  });

  it("names the first missing store policy, shipping first", () => {
    const summaryFor = (policies: Record<string, string>) => buildListingSettingsSummary(
      buildListingSettingsFacts(inputs([candidate()], { listingConfig: config(policies) })), GENERATED_AT);
    expect(summaryFor({}).rail).toEqual({ state: "choose_policy", productsNeedingFix: 0, missingPolicy: "shipping" });
    expect(summaryFor({ fulfillmentPolicyId: "F1" }).rail.missingPolicy).toBe("return");
    expect(summaryFor({ fulfillmentPolicyId: "F1", returnPolicyId: "R1" }).rail.missingPolicy).toBe("payment");
    expect(summaryFor({}).attention.items[0]).toEqual({ code: "choose_store_policies", count: 3, productId: null, productName: null });
    const noConfig = buildListingSettingsSummary(buildListingSettingsFacts(inputs([candidate()], { listingConfig: null })), GENERATED_AT);
    expect(noConfig.rail.missingPolicy).toBe("shipping");
  });

  it("asks to reconnect the store before anything else", () => {
    const summary = buildListingSettingsSummary(buildListingSettingsFacts(inputs([candidate()], {
      store: store({ storeStatus: "needs_reauth" }), listingConfig: config({}),
    })), GENERATED_AT);
    expect(summary.rail.state).toBe("reconnect_store");
    expect(summary.attention.items.map((item) => item.code)).toEqual(["reconnect_store", "choose_store_policies"]);
    expect(summary.access).toMatchObject({ allowed: false, resolution: "reconnect_store" });
  });

  it("keeps the settings rail for a blocked account; the page explains the block", () => {
    const summary = buildListingSettingsSummary(buildListingSettingsFacts(inputs([candidate()], {
      store: store({ vendorStatus: "paused" }),
    })), GENERATED_AT);
    expect(summary.access).toMatchObject({ allowed: false, resolution: "resolve_pause" });
    expect(summary.rail.state).toBe("all_set");
  });

  it("lists at most three attention lines, store first, and counts them all", () => {
    const stale = (id: number): SavedListingContent => ({ revisionId: id, customText: "Mine", catalogHash: "0".repeat(64), updatedAt: "2026-10-01T00:00:00.000Z" });
    const summary = buildListingSettingsSummary(buildListingSettingsFacts(inputs([
      candidate({ productId: 1, productVariantId: 11, productName: "A", ebayBrowseCategoryId: null }),
      candidate({ productId: 2, productVariantId: 21, productName: "B", defaultRetailPriceCents: null }),
      candidate({ productId: 3, productVariantId: 31, productName: "C" }),
      candidate({ productId: 4, productVariantId: 41, productName: "D" }),
    ], {
      listingConfig: config({ fulfillmentPolicyId: "F1" }),
      contentSettings: new Map([[31, stale(1)], [41, stale(2)]]),
    })), GENERATED_AT);
    expect(listingSettingsSummarySchema.safeParse(summary).success).toBe(true);
    expect(summary.attention.total).toBe(4);
    expect(summary.attention.items).toEqual([
      { code: "choose_store_policies", count: 2, productId: null, productName: null },
      { code: "own_text_needs_check", count: 2, productId: null, productName: null },
      { code: "no_ebay_category", count: 1, productId: 1, productName: "A" },
    ]);
    expect(summary.counts).toMatchObject({ productsNeedingFix: 4, cannotPrice: 1, productsWithOwnSettings: 2 });
    expect(summary.rail).toEqual({ state: "choose_policy", productsNeedingFix: 4, missingPolicy: "return" });
  });

  it("reports the store defaults as saved, with policies not checked against eBay", () => {
    const defaults = buildListingSettingsStoreDefaults({
      pricing: pricing({ defaultRecipe: RETAIL_RECIPE, groups: [
        { id: "g", name: "G", priority: 1, scope: { type: "product", productId: 1 }, recipe: COST_RECIPE },
      ] }),
      listingConfig: config({ fulfillmentPolicyId: " F1 ", returnPolicyId: "", paymentPolicyId: "P1" }),
      ebayCategoryRules: { revisionId: 3, updatedAt: "2026-10-01T00:00:00.000Z", profile: { version: 1, rules: [],
        defaultCategory: { categoryId: "183438", categoryName: "Toploaders", path: ["Collectibles", "Toploaders"] } } },
      content: { revisionId: 2, updatedAt: "2026-10-01T00:00:00.000Z", profile: { defaultTemplate: { introduction: "Hello", footer: "" }, groups: [] } },
    });
    expect(defaults).toEqual({
      price: { recipe: RETAIL_RECIPE, groupRules: 1 },
      shippingPolicy: { policyId: "F1", verification: "not_checked" },
      returnPolicy: { policyId: null, verification: "not_checked" },
      paymentPolicy: { policyId: "P1", verification: "not_checked" },
      ebayCategory: { category: { categoryId: "183438", categoryName: "Toploaders" }, groupRules: 0 },
      description: { hasIntroduction: true, hasFooter: false, groupRules: 0 },
    });
  });

  it("reports a selection over 10,000 sizes with the store defaults and nothing about sizes", () => {
    const summary = buildTooLargeListingSettingsSummary({ store: store(), generatedAt: GENERATED_AT,
      storeDefaults: buildListingSettingsStoreDefaults({ pricing: EMPTY_PRICING, listingConfig: null,
        ebayCategoryRules: EMPTY_CATEGORY_RULES, content: EMPTY_CONTENT }) });
    expect(listingSettingsSummarySchema.parse(summary)).toEqual(summary);
    expect(summary).toMatchObject({ catalog: { state: "too_large", limit: 10_000 }, counts: null,
      rail: { state: "too_many_sizes" }, attention: { items: [], total: 0 } });
  });
});

describe("listing settings facts: categories and revisions for writes (plan PR 9, section 4.1)", () => {
  const NONE = { price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
    textAbove: null, textBelow: null, mainText: null } satisfies ProductListingSettingValues;
  /** Product 1 (Toploaders, own settings revision 801), product 2 (Toploaders, none), product 3 (Sleeves), product 4 (no category). */
  const catalog = [
    candidate({ productId: 1, productVariantId: 11, productName: "Alpha toploader", categoryId: TOPLOADERS_CATEGORY, sku: "A-11" }),
    candidate({ productId: 1, productVariantId: 12, productName: "Alpha toploader", categoryId: TOPLOADERS_CATEGORY, sku: "A-12",
      variantName: "Pack of 100" }),
    candidate({ productId: 2, productVariantId: 21, productName: "Beta toploader", categoryId: TOPLOADERS_CATEGORY, sku: "B-21" }),
    candidate({ productId: 3, productVariantId: 31, productName: "Gamma sleeve", categoryId: SLEEVES_CATEGORY, sku: "G-31" }),
    candidate({ productId: 4, productVariantId: 41, productName: "Delta loose", categoryId: null, sku: "D-41",
      defaultRetailPriceCents: null }),
  ];
  const ownRows: ListingSettingLayers = {
    products: new Map([[1, productListingSettingRowSchema.parse({ storeConnectionId: 5, productId: 1, revisionId: 801,
      updatedAt: "2026-10-01T00:00:00.000Z", values: { ...NONE, storeShelf: { mode: "none" } } })]]),
    categories: new Map(),
  };
  const facts = () => buildListingSettingsFacts(inputs(catalog, { layers: ownRows }));

  it("puts each product's category and own settings revision beside its row, never inside it", () => {
    const products = facts().products;
    expect(products.map((product) => [product.row.productId, product.categoryId, product.settingsRevisionId])).toEqual([
      [1, TOPLOADERS_CATEGORY, 801], [2, TOPLOADERS_CATEGORY, null], [4, null, null], [3, SLEEVES_CATEGORY, null],
    ]);
    for (const product of products) {
      expect(product.row).not.toHaveProperty("categoryId");
      expect(product.row).not.toHaveProperty("settingsRevisionId");
    }
    // The strict answers still parse: GET /products and GET /products/:id are unchanged.
    const page = selectListingSettingsProducts(facts(), { search: "", show: "all", page: 0 });
    expect(listingSettingsProductsResponseSchema.safeParse({ storeConnectionId: 5, page: 0, pageSize: 50, total: page.total,
      rows: page.rows, generatedAt: GENERATED_AT.toISOString() }).success).toBe(true);
    const one = selectListingSettingsProduct(facts(), 1)!;
    expect(listingSettingsProductDetailSchema.safeParse({ storeConnectionId: 5, ...one,
      sizes: one.sizes.map((size) => ({ ...size, stockUnits: 0 })), stock: { state: "ok", checkedAt: GENERATED_AT.toISOString() },
      generatedAt: GENERATED_AT.toISOString() }).success).toBe(true);
  });

  it("narrows the Products and Prices tabs to one Card Shellz category", () => {
    const built = facts();
    expect(selectListingSettingsProducts(built, { search: "", show: "all", page: 0, categoryId: TOPLOADERS_CATEGORY }).rows
      .map((row) => row.productId)).toEqual([1, 2]);
    expect(selectListingSettingsPrices(built, { search: "", show: "all", page: 0, categoryId: TOPLOADERS_CATEGORY }).rows
      .map((row) => row.productVariantId)).toEqual([11, 12, 21]);
    expect(selectListingSettingsPrices(built, { search: "", show: "all", page: 0, categoryId: SLEEVES_CATEGORY }).total).toBe(1);
    // A category no chosen product is in lists nothing; no category filter lists everything, as before.
    expect(selectListingSettingsProducts(built, { search: "", show: "all", page: 0, categoryId: 999 }).total).toBe(0);
    expect(selectListingSettingsPrices(built, { search: "", show: "all", page: 0 }).total).toBe(5);
    // Filters combine: a category and a search.
    expect(selectListingSettingsPrices(built, { search: "pack of 100", show: "all", page: 0, categoryId: TOPLOADERS_CATEGORY }).rows
      .map((row) => row.productVariantId)).toEqual([12]);
  });

  it("lists every matching product's id and revision, unpaged, with the Products tab's filters", () => {
    const built = facts();
    const all = selectListingSettingsProductIds(built, { search: "", show: "all" });
    expect(all).toEqual({ total: 4, rows: [{ productId: 1, revisionId: 801 }, { productId: 2, revisionId: null },
      { productId: 4, revisionId: null }, { productId: 3, revisionId: null }] });
    expect(listingSettingsProductIdsResponseSchema.safeParse(all).success).toBe(true);
    expect(selectListingSettingsProductIds(built, { search: "", show: "all", categoryId: TOPLOADERS_CATEGORY }).rows
      .map((row) => row.productId)).toEqual([1, 2]);
    expect(selectListingSettingsProductIds(built, { search: "", show: "all", productId: 1 })).toEqual({ total: 1,
      rows: [{ productId: 1, revisionId: 801 }] });
    expect(selectListingSettingsProductIds(built, { search: "", show: "all", productId: 3, categoryId: TOPLOADERS_CATEGORY }).total).toBe(0);
    // A search matches a product's name or a size's SKU, as on the Products tab.
    expect(selectListingSettingsProductIds(built, { search: "beta", show: "all" }).rows.map((row) => row.productId)).toEqual([2]);
    expect(selectListingSettingsProductIds(built, { search: "a-12", show: "all" }).rows.map((row) => row.productId)).toEqual([1]);
    // `show` filters as the tab does: products with their own settings, products that cannot be priced.
    expect(selectListingSettingsProductIds(built, { search: "", show: "cannot_price" }).rows.map((row) => row.productId)).toEqual([4]);
  });

  it("lists more than a page: every product of a large selection", () => {
    const many = Array.from({ length: 120 }, (_, index) => candidate({ productId: 1_000 + index, productVariantId: 10_000 + index,
      productName: `Product ${String(index).padStart(3, "0")}` }));
    const ids = selectListingSettingsProductIds(buildListingSettingsFacts(inputs(many)), { search: "", show: "all" });
    expect(ids.total).toBe(120);
    expect(ids.rows).toHaveLength(120);
    expect(ids.rows.every((row) => row.revisionId === null)).toBe(true);
  });
});

describe("olderGroupRuleCounts (plan P21, D16)", () => {
  const group = (id: string) => ({ id, name: id, priority: 1, scope: { type: "product" as const, productId: 1 }, recipe: COST_RECIPE });
  const contentGroup = (id: string) => ({ id, name: id, priority: 1, scope: { type: "product" as const, productId: 1 },
    template: { introduction: "", footer: "" } });
  const rule = (id: string) => ({ id, name: id, scope: { type: "product" as const, productId: 1 },
    category: { categoryId: "183438", categoryName: "Toploaders", path: ["Toploaders"] } });
  const rules = (count: number): EbayCategoryRulesState => ({ revisionId: 3, updatedAt: "2026-10-01T00:00:00.000Z",
    profile: { version: 1, defaultCategory: null, rules: Array.from({ length: count }, (_, index) => rule(`r${index}`)) } });

  it.each([
    ["a store with no profile at all", EMPTY_PRICING, EMPTY_CONTENT, EMPTY_CATEGORY_RULES, [0, 0, 0]],
    ["profiles with no groups", pricing({ defaultRecipe: RETAIL_RECIPE, groups: [] }),
      { revisionId: 2, updatedAt: "2026-10-01T00:00:00.000Z", profile: { defaultTemplate: { introduction: "Hi", footer: "" }, groups: [] } },
      rules(0), [0, 0, 0]],
    ["two pricing groups", pricing({ defaultRecipe: RETAIL_RECIPE, groups: [group("a"), group("b")] }), EMPTY_CONTENT, EMPTY_CATEGORY_RULES,
      [2, 0, 0]],
    ["one description group", EMPTY_PRICING, { revisionId: 2, updatedAt: "2026-10-01T00:00:00.000Z",
      profile: { defaultTemplate: { introduction: "", footer: "" }, groups: [contentGroup("c")] } }, EMPTY_CATEGORY_RULES, [0, 1, 0]],
    ["three eBay category rules", EMPTY_PRICING, EMPTY_CONTENT, rules(3), [0, 0, 3]],
  ] as const)("counts %s", (_label, pricingState, content, ebayCategoryRules, [pricingGroups, contentGroups, ebayRules]) => {
    const input = Object.freeze({ pricing: pricingState as PricingProfileState, content: content as ContentProfileState,
      ebayCategoryRules: ebayCategoryRules as EbayCategoryRulesState });
    const counts = olderGroupRuleCounts(input);
    expect(counts).toEqual({ pricingGroups, contentGroups, ebayCategoryRules: ebayRules });
    // The summary counts the same rules with the same function (plan 8.2: no behavior change there).
    const defaults = buildListingSettingsStoreDefaults({ ...input, listingConfig: null });
    expect([defaults.price.groupRules, defaults.description.groupRules, defaults.ebayCategory.groupRules])
      .toEqual([counts.pricingGroups, counts.contentGroups, counts.ebayCategoryRules]);
  });
});

describe("ownCategoryFields and productOwnFieldsOf (plan 8.12 #1)", () => {
  const VALUES: ProductListingSettingValues = { price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null,
    paymentPolicy: null, textAbove: null, textBelow: null, mainText: null };
  const own = (fields: ProductListingSettingField[]) => new Set(fields);

  it.each([
    ["nothing own", null, [], []],
    ["a product row with no value set", own([]), [[]], []],
    ["every category setting on the product row, in the stored shape's order", own([...PRODUCT_LISTING_SETTING_FIELDS].reverse()), [],
      [...CATEGORY_LISTING_SETTING_FIELDS]],
    ["the product's main text alone: not a category setting", own(["mainText"]), [], []],
    ["a policy left on one size", own([]), [[], ["returnPolicy"]], ["returnPolicy"]],
    ["a shelf left on a size, with the product's own text above", own(["textAbove"]), [["storeShelf"]], ["storeShelf", "textAbove"]],
    ["a size's own main text: not a category setting", own([]), [["mainText"]], []],
    ["the same field from the row and a size, once", own(["shippingPolicy"]), [["shippingPolicy", "paymentPolicy"], ["shippingPolicy"]],
      ["shippingPolicy", "paymentPolicy"]],
    ["the price from the row only", own(["price"]), [["storeShelf"]], ["price", "storeShelf"]],
  ] as const)("gives %s", (_label, productOwnFields, sizeLeftovers, expected) => {
    const leftovers = Object.freeze(sizeLeftovers.map((fields) => Object.freeze([...fields] as ListingSettingLeftoverField[])));
    expect(ownCategoryFields({ productOwnFields, sizeLeftovers: leftovers })).toEqual(expected);
  });

  it("reads a field as the product's own exactly when its stored value is not null, for every field", () => {
    expect([...productOwnFieldsOf(null)]).toEqual([]);
    expect([...productOwnFieldsOf(VALUES)]).toEqual([]);
    const set: ProductListingSettingValues = {
      price: RETAIL_RECIPE, ebayCategory: { categoryId: "183438", categoryName: "Toploaders", path: ["Toploaders"] },
      storeShelf: { mode: "none" }, shippingPolicy: { id: "F1", name: null }, returnPolicy: { id: "R1", name: "Returns" },
      paymentPolicy: { id: "P1", name: null }, textAbove: { mode: "none" }, textBelow: { mode: "own", text: "Below." },
      mainText: { text: "Own words.", catalogHash: "c".repeat(64) },
    };
    for (const field of PRODUCT_LISTING_SETTING_FIELDS) {
      expect([...productOwnFieldsOf({ ...VALUES, [field]: set[field] })]).toEqual([field]);
    }
    expect([...productOwnFieldsOf(set)].sort()).toEqual([...PRODUCT_LISTING_SETTING_FIELDS].sort());
  });
});

describe("listing settings facts: the category views (plan PR 9, 8.11)", () => {
  const SAVED_AT = "2026-10-01T00:00:00.000Z";
  const NONE = { price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
    textAbove: null, textBelow: null, mainText: null } satisfies ProductListingSettingValues;
  const { mainText: _productOnly, ...CATEGORY_NONE } = NONE;
  /** Products 1 and 2 in Toploaders (1 with two sizes), product 3 in Sleeves, product 4 with no category. */
  const catalog = [
    candidate({ productId: 1, productVariantId: 11, productName: "Alpha toploader", categoryId: TOPLOADERS_CATEGORY, sku: "A-11" }),
    candidate({ productId: 1, productVariantId: 12, productName: "Alpha toploader", categoryId: TOPLOADERS_CATEGORY, sku: "A-12",
      variantName: "Pack of 100" }),
    candidate({ productId: 2, productVariantId: 21, productName: "Beta toploader", categoryId: TOPLOADERS_CATEGORY, sku: "B-21" }),
    candidate({ productId: 3, productVariantId: 31, productName: "Gamma sleeve", categoryId: SLEEVES_CATEGORY, sku: "G-31" }),
    candidate({ productId: 4, productVariantId: 41, productName: "Delta loose", categoryId: null, sku: "D-41" }),
  ];
  const rows: ListingSettingLayers = {
    products: new Map([
      [1, productListingSettingRowSchema.parse({ storeConnectionId: 5, productId: 1, revisionId: 801, updatedAt: SAVED_AT,
        values: { ...NONE, textAbove: { mode: "own", text: "Product above." } } })],
      // Product 3's own main text is not a category setting.
      [3, productListingSettingRowSchema.parse({ storeConnectionId: 5, productId: 3, revisionId: 803, updatedAt: SAVED_AT,
        values: { ...NONE, mainText: { text: "Own words.", catalogHash: "c".repeat(64) } } })],
    ]),
    categories: new Map([[TOPLOADERS_CATEGORY, categoryListingSettingRowSchema.parse({ storeConnectionId: 5, categoryId: TOPLOADERS_CATEGORY,
      revisionId: 901, updatedAt: SAVED_AT, values: { ...CATEGORY_NONE, price: RETAIL_RECIPE, storeShelf: { mode: "none" },
        returnPolicy: { id: "R-cat", name: "Category returns" }, textBelow: { mode: "own", text: "Category below." } } })]]),
  };
  const base = (patch: Partial<ListingSettingsInputs> = {}) => inputs(catalog, {
    layers: rows,
    // Size 21 keeps a payment policy from today's per-size panel; size 12 a shelf.
    policyOverrides: new Map([[21, override(21, { paymentPolicyId: "P-size" })]]),
    shelfAssignments: new Map([[12, ["Supplies:Top"]]]),
    listingConfig: { ...config(), marketplaceConfig: { ...config().marketplaceConfig,
      storeShelfDefault: { ids: ["31", "32"], names: ["Store:First", "Store:Second"] } } },
    pricing: pricing({ defaultRecipe: COST_RECIPE, groups: [] }),
    content: { revisionId: 2, updatedAt: SAVED_AT, profile: { defaultTemplate: { introduction: "Store above.", footer: "" }, groups: [] } },
    ...patch,
  });
  const facts = (patch: Partial<ListingSettingsInputs> = {}) => buildListingSettingsFacts(base(patch));
  const page = (built: ReturnType<typeof facts>) => listingSettingsCategoriesResponseSchema.parse({ storeConnectionId: 5,
    ...selectListingSettingsCategories(built), generatedAt: GENERATED_AT.toISOString() });

  it("keeps each product's own category fields beside its row, from its row and its chosen sizes' leftovers", () => {
    expect(facts().products.map((product) => [product.row.productId, product.ownCategoryFields])).toEqual([
      [1, ["storeShelf", "textAbove"]], [2, ["paymentPolicy"]], [4, []], [3, []],
    ]);
    for (const product of facts().products) expect(product.row).not.toHaveProperty("ownCategoryFields");
  });

  it("lists every category of a chosen product by its live name, with its products, revision and set fields", () => {
    const built = facts({ categoryNames: new Map([[TOPLOADERS_CATEGORY, "Toploaders"], [SLEEVES_CATEGORY, "A sleeves"]]) });
    expect(page(built)).toEqual({ storeConnectionId: 5, categories: [
      { categoryId: SLEEVES_CATEGORY, name: "A sleeves", productCount: 1, revisionId: null, setFields: [] },
      { categoryId: TOPLOADERS_CATEGORY, name: "Toploaders", productCount: 2, revisionId: 901,
        setFields: ["price", "storeShelf", "returnPolicy", "textBelow"] },
    ], uncategorizedProductCount: 1, generatedAt: GENERATED_AT.toISOString() });
  });

  it("gives one category's settings from its row, else the store default, else none", () => {
    const toploaders = selectListingSettingsCategory(facts(), TOPLOADERS_CATEGORY)!;
    const answer = listingSettingsCategoryDetailSchema.parse({ storeConnectionId: 5, ...toploaders, generatedAt: GENERATED_AT.toISOString() });
    expect(answer.settings).toEqual({
      price: { source: "category", value: RETAIL_RECIPE },
      ebayCategory: { source: "none", value: null },
      storeShelf: { source: "category", value: { mode: "none" } },
      shippingPolicy: { source: "store_default", value: { id: "F1", name: null } },
      returnPolicy: { source: "category", value: { id: "R-cat", name: "Category returns" } },
      paymentPolicy: { source: "store_default", value: { id: "P1", name: null } },
      textAbove: { source: "store_default", value: { mode: "own", text: "Store above." } },
      textBelow: { source: "category", value: { mode: "own", text: "Category below." } },
    });
    expect(answer).toMatchObject({ categoryId: TOPLOADERS_CATEGORY, name: "Toploaders", productCount: 2, revisionId: 901,
      ownValues: [{ productId: 1, revisionId: 801, fields: ["storeShelf", "textAbove"] }, { productId: 2, revisionId: null, fields: ["paymentPolicy"] }] });
    expect(answer.examples.map((size) => size.productVariantId)).toEqual([11, 12, 21]);

    // A category with no row: the store default for each setting it has, the shelf default with its ids, an empty text part as none.
    const sleeves = selectListingSettingsCategory(facts(), SLEEVES_CATEGORY)!;
    expect(listingSettingsCategoryDetailSchema.parse({ storeConnectionId: 5, ...sleeves, generatedAt: GENERATED_AT.toISOString() })).toMatchObject({
      revisionId: null, productCount: 1, ownValues: [], examples: [expect.objectContaining({ productVariantId: 31 })],
      settings: {
        price: { source: "store_default", value: COST_RECIPE },
        storeShelf: { source: "store_default", value: { mode: "own", shelves: [{ id: "31", name: "Store:First" }, { id: "32", name: "Store:Second" }] } },
        textBelow: { source: "store_default", value: { mode: "none" } },
      },
    });
    // Nothing anywhere: none for each.
    const bare = selectListingSettingsCategory(facts({ layers: EMPTY_LISTING_SETTING_LAYERS, listingConfig: null, pricing: EMPTY_PRICING,
      content: EMPTY_CONTENT, policyOverrides: new Map(), shelfAssignments: new Map() }), TOPLOADERS_CATEGORY)!;
    expect(Object.values(bare.settings).every((setting) => setting.source === "none" && setting.value === null)).toBe(true);
    expect(bare.ownValues).toEqual([]);
  });

  it("gives at most three examples, in the sizes' order, and the same answer from a frozen facts object", () => {
    const many = Array.from({ length: 5 }, (_, index) => candidate({ productId: 10 + index, productVariantId: 100 + index,
      productName: `Product ${index}`, categoryId: TOPLOADERS_CATEGORY }));
    const built = buildListingSettingsFacts(inputs(many));
    const selection = selectListingSettingsCategory(Object.freeze(built), TOPLOADERS_CATEGORY)!;
    expect(selection.examples.map((size) => size.productVariantId)).toEqual([100, 101, 102]);
    expect(selection.productCount).toBe(5);
  });

  it("answers no category for one no chosen product is in, and refuses a chosen product's category with no name as a fault", () => {
    expect(selectListingSettingsCategory(facts(), 999)).toBeNull();
    const nameless = facts({ categoryNames: new Map([[TOPLOADERS_CATEGORY, "Toploaders"]]) });
    expect(() => selectListingSettingsCategories(nameless)).toThrow(expect.objectContaining({
      code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", context: expect.objectContaining({ categoryId: SLEEVES_CATEGORY }) }));
    expect(() => selectListingSettingsCategory(nameless, SLEEVES_CATEGORY)).toThrow(DropshipError);
    // The size and product views do not need it.
    expect(selectListingSettingsProduct(nameless, 3)).not.toBeNull();
  });
});
