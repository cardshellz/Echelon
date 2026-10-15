import type { CatalogScope } from "../../../../../shared/dropship/catalog-scope";
import type { EbayCategory, EbayCategoryRulesState } from "../../../../../shared/dropship/ebay-category-rules";
import type { ContentProfileState, DescriptionTemplate } from "../../../../../shared/dropship/listing-content";
import type { SavedListingPriceRevision } from "../../../../../shared/dropship/listing-price";
import {
  categoryListingSettingRowSchema, productListingSettingRowSchema,
  type CategoryListingSettingRow, type CategoryListingSettingValues, type ProductListingSettingRow, type ProductListingSettingValues,
} from "../../../../../shared/dropship/listing-setting-values";
import type { PricingProfileState, PricingRecipe } from "../../../../../shared/dropship/pricing-rules";
import { prepareEbayCategoryRules, resolveEbayListingCategory } from "../../application/dropship-ebay-category-resolver";
import type { DropshipListingCatalogCandidate, DropshipListingStoreContext } from "../../application/dropship-listing-preview-service";
import type { ListingSettingLayers } from "../../application/dropship-listing-setting-layers";
import type { ListingSettingsInputs } from "../../application/dropship-listing-settings-facts";
import { conversionCategoryNamesToRead, type ConversionInputs } from "../../application/dropship-listing-rules-conversion";
import type { DropshipStoreListingConfig } from "../../application/dropship-marketplace-listing-provider";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import type { ConversionCategory } from "../../domain/listing-rules-conversion-names";
import { EMPTY_CATEGORY_LISTING_SETTING_VALUES, EMPTY_PRODUCT_LISTING_SETTING_VALUES } from "../../domain/listing-setting-values";

/*
 * Inputs for the PR 11 conversion planner (plan 4.A.2), built in memory: no
 * I/O and no harness. `listingInputs` resolves eBay categories with the same
 * rules and layers it hands the read model, as the load does
 * (dropship-listing-settings.repository.ts). Every builder returns new
 * objects, so a test may freeze what it builds.
 */

export const STORE = 5;
export const VENDOR = 7;
export const UPDATED_AT = "2026-10-01T12:00:00.000Z";

/** Card Shellz categories (catalog.product_categories), as the names read gives them. */
export const MAILERS: ConversionCategory = { id: 11, name: "Mailers" };
export const SLEEVES: ConversionCategory = { id: 12, name: "Sleeves" };
export const TOPLOADERS: ConversionCategory = { id: 13, name: "Toploaders" };

export const COST_PLUS_10: PricingRecipe = { basis: "product_cost", markupBps: 1_000, flatCents: 0, rounding: "cent" };
export const COST_PLUS_40: PricingRecipe = { basis: "product_cost", markupBps: 4_000, flatCents: 0, rounding: "cent" };
export const COST_PLUS_25: PricingRecipe = { basis: "product_cost", markupBps: 2_500, flatCents: 0, rounding: "up_99" };
export const RETAIL_PLUS_20: PricingRecipe = { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "cent" };

export const EBAY_SLEEVES: EbayCategory = { categoryId: "183438", categoryName: "Card Sleeves", path: ["Collectibles", "Card Sleeves"] };
export const EBAY_TOPLOADERS: EbayCategory = { categoryId: "183439", categoryName: "Card Toploaders", path: ["Collectibles", "Card Toploaders"] };
export const EBAY_STORE_DEFAULT: EbayCategory = { categoryId: "261328", categoryName: "Card Supplies", path: ["Collectibles", "Card Supplies"] };

export const STORE_TEMPLATE: DescriptionTemplate = { introduction: "Store above", footer: "Store below" };

export const byCategory = (category: string): CatalogScope => ({ type: "category", category });
export const byProductLine = (productLineId: number): CatalogScope => ({ type: "product_line", productLineId });
export const byProduct = (productId: number): CatalogScope => ({ type: "product", productId });
export const bySizes = (...productVariantIds: number[]): CatalogScope => ({ type: "listings", productVariantIds });

/** A chosen size. Product-level fields (name, category copy and id, product lines) are the caller's to keep equal per product. */
export function candidate(patch: Partial<DropshipListingCatalogCandidate> & Pick<DropshipListingCatalogCandidate, "productVariantId" | "productId">):
  DropshipListingCatalogCandidate {
  return {
    productName: `Product ${patch.productId}`, variantName: `Size ${patch.productVariantId}`, sku: `SKU-${patch.productVariantId}`,
    productLineIds: [], category: null, categoryId: null,
    ebayBrowseCategoryId: "184267", ebayBrowseCategoryName: "Card Shellz base",
    productIsActive: true, variantIsActive: true, variantUomType: "pack", unitsPerVariant: 25,
    defaultRetailPriceCents: 1_000, title: `Product ${patch.productId}`, description: "<p>Card Shellz text.</p>",
    brand: "Card Shellz", gtin: null, mpn: null, condition: "new", itemSpecifics: null, imageUrls: [], weightGrams: 100,
    ...patch,
  };
}

/** A size of a product in a Card Shellz category whose copy of the name is the category's own. */
export function inCategory(category: ConversionCategory, patch: Partial<DropshipListingCatalogCandidate>
  & Pick<DropshipListingCatalogCandidate, "productVariantId" | "productId">): DropshipListingCatalogCandidate {
  return candidate({ category: category.name, categoryId: category.id, ...patch });
}

export function storeContext(): DropshipListingStoreContext {
  return { vendorId: VENDOR, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE,
    storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true };
}

export function listingConfig(): DropshipStoreListingConfig {
  return { id: 1, storeConnectionId: STORE, platform: "ebay", listingMode: "live", inventoryMode: "managed_quantity_sync",
    priceMode: "vendor_defined", marketplaceConfig: { marketplaceId: "EBAY_US",
      businessPolicies: { fulfillmentPolicyId: "F1", returnPolicyId: "R1", paymentPolicyId: "P1" } },
    requiredConfigKeys: [], requiredProductFields: [], isActive: true };
}

export function availableCost(unitCostCents: number): DropshipProductCost {
  return { status: "available", unitCostCents, planId: "ops", source: "plan_percent", overrideId: null, issue: null,
    retailPriceCents: 1_000, discountBps: 2_000 };
}

export function savedPrice(productVariantId: number, patch: Partial<SavedListingPriceRevision> = {}): SavedListingPriceRevision {
  return { productVariantId, revisionId: 900 + productVariantId, overridePriceCents: null, updatedAt: UPDATED_AT, ...patch };
}

export interface GroupSpec<V> { id: string; name?: string; priority: number; scope: CatalogScope; value: V }

export function pricingState(groups: readonly GroupSpec<PricingRecipe>[], defaultRecipe: PricingRecipe = COST_PLUS_10,
  revisionId = 41): PricingProfileState {
  return { revisionId, updatedAt: UPDATED_AT, profile: { defaultRecipe, groups: groups.map((group) => ({
    id: group.id, name: group.name ?? `Price ${group.id}`, priority: group.priority, scope: group.scope, recipe: group.value,
  })) } };
}

export function contentState(groups: readonly GroupSpec<DescriptionTemplate>[], defaultTemplate: DescriptionTemplate = STORE_TEMPLATE,
  revisionId = 51): ContentProfileState {
  return { revisionId, updatedAt: UPDATED_AT, profile: { defaultTemplate, groups: groups.map((group) => ({
    id: group.id, name: group.name ?? `Text ${group.id}`, priority: group.priority, scope: group.scope, template: group.value,
  })) } };
}

export interface EbayRuleSpec { id: string; name?: string; scope: CatalogScope; category: EbayCategory }

export function ebayRulesState(rules: readonly EbayRuleSpec[], defaultCategory: EbayCategory | null = EBAY_STORE_DEFAULT,
  revisionId = 61): EbayCategoryRulesState {
  return { revisionId, updatedAt: UPDATED_AT, profile: { version: 1, defaultCategory, rules: rules.map((rule) => ({
    id: rule.id, name: rule.name ?? `eBay ${rule.id}`, scope: rule.scope, category: rule.category,
  })) } };
}

export const NO_PROFILE = { revisionId: null, profile: null, updatedAt: null } as const;

export function productRow(productId: number, values: Partial<ProductListingSettingValues>, revisionId = 700 + productId): ProductListingSettingRow {
  return productListingSettingRowSchema.parse({ storeConnectionId: STORE, productId, revisionId, updatedAt: UPDATED_AT,
    values: { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, ...values } });
}

export function categoryRow(categoryId: number, values: Partial<CategoryListingSettingValues>, revisionId = 800 + categoryId): CategoryListingSettingRow {
  return categoryListingSettingRowSchema.parse({ storeConnectionId: STORE, categoryId, revisionId, updatedAt: UPDATED_AT,
    values: { ...EMPTY_CATEGORY_LISTING_SETTING_VALUES, ...values } });
}

export function layersOf(products: readonly ProductListingSettingRow[] = [], categories: readonly CategoryListingSettingRow[] = []): ListingSettingLayers {
  return { products: new Map(products.map((row) => [row.productId, row])), categories: new Map(categories.map((row) => [row.categoryId, row])) };
}

/** The live name of each category, as the load reads it for every chosen size's category. */
export const CATEGORY_NAMES: ReadonlyMap<number, string> = new Map([MAILERS, SLEEVES, TOPLOADERS].map((category) => [category.id, category.name]));

/** The read model's inputs for `candidates`, with every other read empty unless patched. */
export function listingInputs(candidates: readonly DropshipListingCatalogCandidate[],
  patch: Partial<Omit<ListingSettingsInputs, "candidates" | "ebayCategories">> = {}): ListingSettingsInputs {
  const ebayCategoryRules = patch.ebayCategoryRules ?? NO_PROFILE;
  const layers = patch.layers ?? layersOf();
  const prepared = prepareEbayCategoryRules(ebayCategoryRules.revisionId, ebayCategoryRules.profile, layers);
  const sizesTotal = new Map<number, number>();
  for (const row of candidates) sizesTotal.set(row.productId, (sizesTotal.get(row.productId) ?? 0) + 1);
  return {
    store: storeContext(),
    candidates,
    sizesTotalByProductId: sizesTotal,
    savedPrices: new Map(),
    existingListings: new Map(),
    pricing: NO_PROFILE,
    costs: new Map(),
    pricingPolicies: [],
    listingConfig: listingConfig(),
    policyOverrides: new Map(),
    shelfAssignments: new Map(),
    content: NO_PROFILE,
    contentSettings: new Map(),
    pausedSince: new Map(),
    categoryNames: CATEGORY_NAMES,
    categoryMoves: { marks: new Map(), fromCategories: new Map(), fromCategoryNames: new Map() },
    ...patch,
    ebayCategoryRules,
    layers,
    ebayCategories: new Map(candidates.map((row) => [row.productVariantId, resolveEbayListingCategory(row, prepared)])),
  };
}

/** Every category by its exact name. */
export function categoriesByName(...categories: readonly ConversionCategory[]): ReadonlyMap<string, readonly ConversionCategory[]> {
  const byName = new Map<string, ConversionCategory[]>();
  for (const category of categories) byName.set(category.name, [...(byName.get(category.name) ?? []), category]);
  return byName;
}

/** The fixture's Card Shellz categories (catalog.product_categories). */
export const FIXTURE_CATALOG: readonly ConversionCategory[] = [MAILERS, SLEEVES, TOPLOADERS];

/**
 * The names read as 11a2's loader makes it: a key for every name the store's
 * category rules target (conversionCategoryNamesToRead), holding the
 * categories of `catalog` with exactly that name, or none.
 */
export function categoriesNamed(listing: ListingSettingsInputs, catalog: readonly ConversionCategory[] = FIXTURE_CATALOG):
  ReadonlyMap<string, readonly ConversionCategory[]> {
  return new Map(conversionCategoryNamesToRead(listing).map((name) => [name, catalog.filter((category) => category.name === name)]));
}

/** The category rows read for every target: the layers' row (so a chosen category's row is in both reads), else null. */
export function categoryRowsOf(listing: ListingSettingsInputs, byName: ReadonlyMap<string, readonly ConversionCategory[]>):
  ReadonlyMap<number, CategoryListingSettingRow | null> {
  return new Map([...byName.values()].flat().map((category) => [category.id, listing.layers.categories.get(category.id) ?? null]));
}

/**
 * The planner's inputs, read as the loader reads them: the names the rules
 * target among `catalog` (the fixture's categories by default) and every
 * target's row. A test may hand either map in whole instead.
 */
export function conversionInputs(listing: ListingSettingsInputs,
  patch: Partial<Omit<ConversionInputs, "listing">> & { catalog?: readonly ConversionCategory[] } = {}): ConversionInputs {
  const byName = patch.categoriesByName ?? categoriesNamed(listing, patch.catalog);
  return {
    listing,
    categoriesByName: byName,
    categoryRows: patch.categoryRows ?? categoryRowsOf(listing, byName),
    storeTextBytes: patch.storeTextBytes ?? 0,
  };
}

/**
 * Freezes a value all the way down. Maps and sets also refuse writes (freezing
 * one does not stop `set`), so a planner that mutates an input throws.
 */
export function deepFreeze<T>(value: T, seen = new Set<unknown>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, item] of value) {
      deepFreeze(key, seen);
      deepFreeze(item, seen);
    }
    refuseWrites(value, ["set", "delete", "clear"]);
  } else if (value instanceof Set) {
    for (const item of value) deepFreeze(item, seen);
    refuseWrites(value, ["add", "delete", "clear"]);
  } else if (!(value instanceof Date)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item, seen);
  }
  return Object.freeze(value);
}

function refuseWrites(target: object, methods: readonly string[]): void {
  for (const method of methods) {
    Object.defineProperty(target, method, { value: () => { throw new TypeError(`A frozen input was written (${method}).`); } });
  }
}
