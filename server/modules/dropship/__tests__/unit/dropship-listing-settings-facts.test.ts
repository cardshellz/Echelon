import { describe, expect, it } from "vitest";
import type { ContentProfileState, SavedListingContent } from "../../../../../shared/dropship/listing-content";
import type { SavedListingPriceRevision } from "../../../../../shared/dropship/listing-price";
import {
  listingSettingsPricesResponseSchema,
  listingSettingsProductsResponseSchema,
  listingSettingsSummarySchema,
} from "../../../../../shared/dropship/listing-settings";
import type { EbayCategoryRulesState } from "../../../../../shared/dropship/ebay-category-rules";
import type { PricingProfileState } from "../../../../../shared/dropship/pricing-rules";
import { prepareEbayCategoryRules, resolveEbayListingCategory } from "../../application/dropship-ebay-category-resolver";
import type { DropshipEbayListingPolicyOverride } from "../../application/dropship-ebay-listing-policy-override-service";
import { listingCatalogHash } from "../../application/dropship-listing-content-resolver";
import type {
  DropshipListingCatalogCandidate, DropshipListingStoreContext, DropshipPricingPolicyRecord,
} from "../../application/dropship-listing-preview-service";
import {
  buildListingSettingsFacts,
  buildListingSettingsStoreDefaults,
  buildListingSettingsSummary,
  buildTooLargeListingSettingsSummary,
  selectListingSettingsPrices,
  selectListingSettingsProducts,
  type ListingSettingsInputs,
} from "../../application/dropship-listing-settings-facts";
import type { DropshipStoreListingConfig } from "../../application/dropship-marketplace-listing-provider";
import type { DropshipProductCost } from "../../application/dropship-product-cost";

const GENERATED_AT = new Date("2026-10-06T12:00:00.000Z");
const EMPTY_PRICING: PricingProfileState = { revisionId: null, profile: null, updatedAt: null };
const EMPTY_CONTENT: ContentProfileState = { revisionId: null, profile: null, updatedAt: null };
const EMPTY_CATEGORY_RULES: EbayCategoryRulesState = { revisionId: null, profile: null, updatedAt: null };
const RETAIL_RECIPE = { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" } as const;
const COST_RECIPE = { basis: "product_cost", markupBps: 5_000, flatCents: 0, rounding: "cent" } as const;

function candidate(patch: Partial<DropshipListingCatalogCandidate> = {}): DropshipListingCatalogCandidate {
  return {
    productId: 501, productVariantId: 101, productLineIds: [9], category: "Toploaders",
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

function inputs(candidates: DropshipListingCatalogCandidate[], patch: Partial<ListingSettingsInputs> = {}): ListingSettingsInputs {
  const categoryRules = patch.ebayCategoryRules ?? EMPTY_CATEGORY_RULES;
  const prepared = prepareEbayCategoryRules(categoryRules.revisionId, categoryRules.profile);
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

  it("reports a size paused by a cost change", () => {
    const price = onlyPrice(inputs([candidate()], { pausedSince: new Map([[101, new Date("2026-10-02T09:30:00.000Z")]]) }));
    expect(price.pausedSince).toBe("2026-10-02T09:30:00.000Z");
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
    expect(same.sizes[0].values.description.key.length).toBeLessThan(100);
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
    expect(products("below_cost")).toEqual([1]);
    expect(products("cannot_price")).toEqual([2]);
    expect(products("needs_fix")).toEqual([2]);
    const prices = (show: Parameters<typeof selectListingSettingsPrices>[1]["show"]) =>
      selectListingSettingsPrices(facts, { search: "", show, page: 0 }).rows.map((row) => row.productVariantId);
    expect(prices("paused")).toEqual([31]);
    expect(prices("cannot_price")).toEqual([21]);
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
