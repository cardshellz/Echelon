/**
 * Golden listing previews (Listing settings PR 8 plan, 4.11, sub-part 8b-0):
 * one vendor, two eBay stores over one catalog, and sizes that reach every
 * branch of today's price, business policy, store shelf, eBay category and
 * description resolution, with the exact preview and listing-settings facts
 * each size must keep.
 *
 * The pinned values were produced by the listing preview and the facts at
 * PR 8a (commit 46dd3f11), before any product or category settings reader
 * existed. PR 8b's readers must give exactly these values while a store has
 * no product or category settings and no store shelf default (plan D1, D14,
 * 4.13): they are what vendors see and what a queued push checks. So they are
 * written out here, never regenerated to make a test pass. The documented
 * changes (plan 4.10: a saved store shelf default, product or category
 * settings) are variants on top of this data, never edits to these pins.
 *
 * Stored rows are given the way the readers select them, so the real loaders
 * resolve them; ids, names and eBay category numbers are test values only.
 */
import type { ContentProfile } from "../../../../../shared/dropship/listing-content";
import type { CategoryListingSettingValues, ProductListingSettingValues } from "../../../../../shared/dropship/listing-setting-values";
import type { EbayCategoryRulesProfile } from "../../../../../shared/dropship/ebay-category-rules";
import type { SavedListingPriceRevision } from "../../../../../shared/dropship/listing-price";
import type { ListingSettingsPriceSource, ListingSettingsSettingKey, ListingSettingsValueSource } from "../../../../../shared/dropship/listing-settings";
import type { PricingProfile } from "../../../../../shared/dropship/pricing-rules";
import type { CatalogVariantPublicationPhotos } from "../../../catalog/catalog-publication-images.reader";
import type { DropshipEbayFulfillmentPolicyPreflight } from "../../application/dropship-ebay-fulfillment-policy-guard";
import type { DropshipEbayListingPolicyOverride } from "../../application/dropship-ebay-listing-policy-override";
import { productCatalogHash } from "../../application/dropship-listing-content-resolver";
import type {
  DropshipExistingVendorListing,
  DropshipListingCatalogCandidate,
  DropshipListingPreviewRow,
  DropshipListingStoreContext,
  DropshipPricingPolicyRecord,
} from "../../application/dropship-listing-preview-service";
import type { DropshipStoreListingConfig } from "../../application/dropship-marketplace-listing-provider";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import type { EbayStoreShelfDefault } from "../../domain/ebay-listing-setup-config";
import { EMPTY_CATEGORY_LISTING_SETTING_VALUES, EMPTY_PRODUCT_LISTING_SETTING_VALUES } from "../../domain/listing-setting-values";
import type { DropshipListingTierEligibility, DropshipListingTierStatus } from "../../domain/listing-tiers";
import type { ContentRevisionRow } from "../../infrastructure/dropship-listing-content.reader";

export const GOLDEN_PREVIEW_VENDOR_ID = 10;
export const GOLDEN_PREVIEW_NOW = new Date("2026-10-10T12:00:00.000Z");

/**
 * A catalog size with its Card Shellz category id (`catalog.products.category_id`).
 * Today's resolvers ignore the id; with no category settings saved they must
 * keep giving the same results, which is the case for every live store at the
 * PR 8b deploy. Product 600 has no Card Shellz category.
 */
export type GoldenPreviewCandidate = DropshipListingCatalogCandidate & { categoryId: number | null };

type GoldenProduct = Pick<GoldenPreviewCandidate, "productId" | "categoryId" | "category" | "productName" | "productLineIds"
  | "description" | "brand" | "condition" | "gtin" | "mpn" | "itemSpecifics" | "ebayBrowseCategoryId" | "ebayBrowseCategoryName">;
type GoldenSize = Pick<GoldenPreviewCandidate, "productVariantId" | "variantName" | "sku" | "title" | "unitsPerVariant"
  | "defaultRetailPriceCents" | "weightGrams" | "variantUomType">;

function goldenSize(product: GoldenProduct, size: GoldenSize): GoldenPreviewCandidate {
  // Photos come from the photo reader, never from the candidate.
  return { ...product, ...size, catalogUnitsPerVariant: size.unitsPerVariant, productIsActive: true, variantIsActive: true, imageUrls: [] };
}

const MAILER: GoldenProduct = {
  productId: 100, categoryId: 11, category: "Mailers", productName: "Armalope mailer", productLineIds: [3],
  description: "<p>Protect your cards in the mail.</p>", brand: "Card Shellz", condition: "NEW", gtin: null, mpn: "ARM",
  itemSpecifics: { Color: ["White"] }, ebayBrowseCategoryId: "184267", ebayBrowseCategoryName: "Card Shellz mailers",
};
const TEAM_BAGS: GoldenProduct = {
  productId: 200, categoryId: 12, category: "Sleeves", productName: "Team bag sleeves", productLineIds: [],
  description: "<p>Resealable team bags.</p>", brand: "Card Shellz", condition: "NEW", gtin: "0850012300011", mpn: null,
  itemSpecifics: { Size: ["Standard"] }, ebayBrowseCategoryId: "183438", ebayBrowseCategoryName: "Card sleeves",
};
const TOPLOADERS: GoldenProduct = {
  productId: 300, categoryId: 13, category: "Toploaders", productName: "35pt toploaders", productLineIds: [7],
  description: "<p>Rigid 35pt toploaders.</p>", brand: "Card Shellz", condition: "NEW", gtin: null, mpn: "TL35",
  itemSpecifics: { Thickness: ["35pt"] }, ebayBrowseCategoryId: "183439", ebayBrowseCategoryName: "Toploaders & holders",
};
const BINDERS: GoldenProduct = {
  productId: 600, categoryId: null, category: "Binders", productName: "Nine-pocket binder", productLineIds: [9],
  description: "<p>Nine-pocket pages included.</p>", brand: null, condition: "NEW", gtin: null, mpn: null,
  itemSpecifics: null, ebayBrowseCategoryId: null, ebayBrowseCategoryName: null,
};
const STORAGE: GoldenProduct = {
  productId: 700, categoryId: 14, category: "Storage", productName: "Card storage box", productLineIds: [12],
  description: "<p>Holds 800 cards.</p>", brand: "Card Shellz", condition: "NEW", gtin: null, mpn: null,
  itemSpecifics: null, ebayBrowseCategoryId: "183440", ebayBrowseCategoryName: "Card storage boxes",
};

/**
 * What each size is for. Store 22 has pricing rules, description templates and
 * eBay category rules; store 23 has none of them.
 * - 1001: store default price rule; store template; store eBay category; store policies; no shelf.
 * - 1002: exact price; own text; per-size shipping and payment policies; one shelf.
 * - 2001: group price rule from the retail price, below cost and over a warn-only limit; group template; two shelves.
 * - 2002: `inherit` priced by the group rule; own text saved against an older catalog, so it needs a check.
 * - 3001: store default price rule; eBay category rule; per-size return policy; no title of its own.
 * - 6001: two price rules tie (no price); no Card Shellz category id and no Card Shellz eBay category.
 * - 6002: `inherit` on the retail price because the rules tie.
 * - 7001: two description templates tie.
 * In store 23: retail prices, a price an earlier push saved (2001), an exact price
 * (1002), `inherit` on retail (2002), `rules` with no rules (3001), the Card Shellz
 * eBay category, and none at all for product 600.
 */
export const GOLDEN_PREVIEW_CANDIDATES: readonly GoldenPreviewCandidate[] = [
  goldenSize(MAILER, { productVariantId: 1001, variantName: "Pack of 50", sku: "ARM-50", title: "Armalope mailer, pack of 50",
    unitsPerVariant: 50, defaultRetailPriceCents: 899, weightGrams: 120, variantUomType: "pack" }),
  goldenSize(MAILER, { productVariantId: 1002, variantName: "Pack of 100", sku: "ARM-100", title: "Armalope mailer, pack of 100",
    unitsPerVariant: 100, defaultRetailPriceCents: 1_599, weightGrams: 230, variantUomType: "pack" }),
  goldenSize(TEAM_BAGS, { productVariantId: 2001, variantName: "Pack of 100", sku: "TB-100", title: "Team bag sleeves, pack of 100",
    unitsPerVariant: 100, defaultRetailPriceCents: 1_499, weightGrams: 90, variantUomType: "pack" }),
  goldenSize(TEAM_BAGS, { productVariantId: 2002, variantName: "Pack of 500", sku: "TB-500", title: "Team bag sleeves, pack of 500",
    unitsPerVariant: 500, defaultRetailPriceCents: 5_999, weightGrams: 410, variantUomType: "pack" }),
  goldenSize(TOPLOADERS, { productVariantId: 3001, variantName: "Pack of 25", sku: "TL35-25", title: null,
    unitsPerVariant: 25, defaultRetailPriceCents: 1_299, weightGrams: 260, variantUomType: "pack" }),
  goldenSize(BINDERS, { productVariantId: 6001, variantName: "Single binder", sku: "BND-1", title: "Nine-pocket binder",
    unitsPerVariant: 1, defaultRetailPriceCents: 2_499, weightGrams: 700, variantUomType: "each" }),
  goldenSize(BINDERS, { productVariantId: 6002, variantName: "Case of 4", sku: "BND-4", title: "Nine-pocket binder, case of 4",
    unitsPerVariant: 4, defaultRetailPriceCents: 8_999, weightGrams: 2_900, variantUomType: "case" }),
  goldenSize(STORAGE, { productVariantId: 7001, variantName: "800 count", sku: "BOX-800", title: "Card storage box, 800 count",
    unitsPerVariant: 1, defaultRetailPriceCents: 699, weightGrams: 340, variantUomType: "pack" }),
];

/** Every size of each product the vendor could choose; product 100 has a third size nobody chose. */
export const GOLDEN_PREVIEW_SIZES_TOTAL_BY_PRODUCT_ID: ReadonlyMap<number, number> = new Map([[100, 3], [200, 2], [300, 1], [600, 2], [700, 1]]);

function opsCost(unitCostCents: number): DropshipProductCost {
  return { status: "available", unitCostCents, planId: "ops", source: "variant_fixed_price", overrideId: `override-${unitCostCents}`,
    issue: null, retailPriceCents: null, discountBps: null };
}

/** The vendor's .ops cost of one sellable pack, the same in both stores. */
export const GOLDEN_PREVIEW_COSTS: ReadonlyMap<number, DropshipProductCost> = new Map([
  [1001, opsCost(809)], [1002, opsCost(1_350)], [2001, opsCost(1_600)], [2002, opsCost(2_000)],
  [3001, opsCost(455)], [6001, opsCost(1_000)], [6002, opsCost(3_800)], [7001, opsCost(300)],
]);

/** Card Shellz price limits: a warn-only ceiling on sleeves. */
export const GOLDEN_PREVIEW_PRICING_POLICIES: readonly DropshipPricingPolicyRecord[] = [
  { id: 5, scopeType: "category", productLineId: null, productId: null, productVariantId: null, category: "Sleeves",
    mode: "warn_only", floorPriceCents: null, ceilingPriceCents: 1_000 },
];

/** Stock each size can list; the ATP authority is canonical, so no quantity cap applies. */
export const GOLDEN_PREVIEW_ATP: ReadonlyMap<number, number> = new Map([
  [1001, 12], [1002, 12], [2001, 12], [2002, 12], [3001, 12], [6001, 12], [6002, 3], [7001, 12],
]);

/** Card Shellz category names (`catalog.product_categories`) of the candidates' category ids. */
export const GOLDEN_PREVIEW_CATEGORY_NAMES: ReadonlyMap<number, string> = new Map([[11, "Mailers"], [12, "Sleeves"], [13, "Toploaders"], [14, "Storage"]]);

function tierOnSale(tier: DropshipListingTierStatus["tier"], minimumCents: number): DropshipListingTierStatus {
  return { tier, eligible: true, reason: null, policyMinimumCents: minimumCents, minimumCents, alreadyOn: true,
    reserveShortfallCents: 0, balanceShortfallCents: 0, upcoming: null };
}

/** Both listing tiers are on sale for the vendor. */
export const GOLDEN_PREVIEW_LISTING_TIERS: DropshipListingTierEligibility = {
  pack: tierOnSale("pack", 10_000),
  case: tierOnSale("case", 50_000),
};

/** The photos the catalog publishes for a size: one catalog photo, not an upload. */
export function goldenPublicationPhotos(productVariantId: number): CatalogVariantPublicationPhotos {
  return { photos: [{ assetId: productVariantId * 10 + 1, url: `https://cdn.example.test/catalog/${productVariantId}-1.jpg`,
    position: 0, uploaded: false }], issues: [] };
}

/** The live eBay shipping-policy check: every policy is compatible, with evidence that names it. */
export function goldenFulfillmentPreflight(fulfillmentPolicyId: string): DropshipEbayFulfillmentPolicyPreflight {
  return { compatible: true, fulfillmentPolicyId, capabilityEvidenceHash: `capability:${fulfillmentPolicyId}`,
    originWarehouseId: 4, issues: [] };
}

export interface GoldenPreviewStore {
  name: string;
  context: DropshipListingStoreContext;
  config: DropshipStoreListingConfig;
  /** The stored rows as readPricingProfile, readContentProfile and readEbayCategoryRules select them; null = never saved. */
  pricingProfile: { id: number; profile: PricingProfile; created_at: Date } | null;
  contentProfile: { id: number; profile: ContentProfile; created_at: Date } | null;
  ebayCategoryRules: { id: number; profile: EbayCategoryRulesProfile; created_at: Date } | null;
  /** Current per-size description rows, as readListingContentSettings selects them. */
  contentSettings: readonly ContentRevisionRow[];
  savedPrices: readonly SavedListingPriceRevision[];
  existingListings: readonly DropshipExistingVendorListing[];
  policyOverrides: readonly DropshipEbayListingPolicyOverride[];
  /** Per-size store shelves. A stored row always has one or two names. */
  shelfAssignments: readonly { productVariantId: number; storeCategoryNames: string[] }[];
}

function storeContext(storeConnectionId: number): DropshipListingStoreContext {
  return { vendorId: GOLDEN_PREVIEW_VENDOR_ID, vendorStatus: "active", entitlementStatus: "active", storeConnectionId,
    storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true };
}

function ebayListingConfig(id: number, storeConnectionId: number, marketplaceConfig: Record<string, unknown>): DropshipStoreListingConfig {
  return { id, storeConnectionId, platform: "ebay", listingMode: "live", inventoryMode: "managed_quantity_sync",
    priceMode: "vendor_defined", marketplaceConfig, requiredConfigKeys: ["marketplaceId", "businessPolicies.fulfillmentPolicyId"],
    requiredProductFields: [], isActive: true };
}

/** The store with rules, templates and per-size settings. No store shelf default is saved. */
export const GOLDEN_PREVIEW_RULES_STORE: GoldenPreviewStore = {
  name: "store with rules",
  context: storeContext(22),
  config: ebayListingConfig(7, 22, {
    marketplaceId: "EBAY_US",
    merchantLocationKey: "cardshellz-dropship-22",
    businessPolicies: { fulfillmentPolicyId: "ship-1", returnPolicyId: "ret-1", paymentPolicyId: "pay-1" },
    // Display-only: kept out of the listing intent.
    businessPolicyNames: { fulfillmentPolicyId: { id: "ship-1", name: "Free shipping" } },
  }),
  pricingProfile: {
    id: 41,
    created_at: new Date("2026-10-01T12:00:00.000Z"),
    profile: {
      defaultRecipe: { basis: "product_cost", markupBps: 4_250, flatCents: 0, rounding: "up_99" },
      groups: [
        { id: "sleeves", name: "Sleeves", priority: 10, scope: { type: "category", category: "Sleeves" },
          recipe: { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" } },
        // Two groups at one priority that both match product 600 are a conflict.
        { id: "binders-a", name: "Binders A", priority: 30, scope: { type: "category", category: "Binders" },
          recipe: { basis: "product_cost", markupBps: 0, flatCents: 0, rounding: "cent" } },
        { id: "binders-b", name: "Binders B", priority: 30, scope: { type: "product_line", productLineId: 9 },
          recipe: { basis: "product_cost", markupBps: 5_000, flatCents: 0, rounding: "cent" } },
      ],
    },
  },
  contentProfile: {
    id: 12,
    created_at: new Date("2026-10-02T09:30:00.000Z"),
    profile: {
      defaultTemplate: { introduction: "Thanks for shopping with Armalope Cards.", footer: "Orders ship within one business day." },
      groups: [
        { id: "sleeves-text", name: "Sleeve buyers", priority: 10, scope: { type: "category", category: "Sleeves" },
          template: { introduction: "Every sleeve is acid free.", footer: "" } },
        // Two templates at one priority that both match product 700 are a conflict.
        { id: "storage-a", name: "Storage boxes", priority: 20, scope: { type: "category", category: "Storage" },
          template: { introduction: "Boxes ship flat.", footer: "" } },
        { id: "storage-b", name: "Storage line", priority: 20, scope: { type: "product_line", productLineId: 12 },
          template: { introduction: "", footer: "Lids sold separately." } },
      ],
    },
  },
  ebayCategoryRules: {
    id: 7,
    created_at: new Date("2026-09-30T12:00:00.000Z"),
    profile: {
      version: 1,
      defaultCategory: { categoryId: "900103", categoryName: "Mailers", path: ["Collectibles", "Shipping Supplies", "Mailers"] },
      rules: [
        { id: "toploaders", name: "Toploaders", scope: { type: "category", category: "Toploaders" },
          category: { categoryId: "900101", categoryName: "Toploaders", path: ["Collectibles", "Card Storage", "Toploaders"] } },
      ],
    },
  },
  contentSettings: [
    // Saved against the current catalog (listingCatalogHash of size 1002).
    { id: 501, product_variant_id: 1002, custom_text: "Our best-selling mailer.\n\nFits a toploader and a team bag.",
      catalog_hash: "9b71d94437ba9f94c7a7d0a9aaa43d8d48fdeeaff9dda5fcebf4c20b1bc04039", created_at: new Date("2026-10-03T08:00:00.000Z") },
    // Saved against an older catalog description of size 2002 ("<p>Team bags.</p>").
    { id: 502, product_variant_id: 2002, custom_text: "Bulk team bags for card shows.",
      catalog_hash: "5c2a55e895980efc111be9e164cd42d7def360ee445d4cc7dbb91528fed3c4e6", created_at: new Date("2026-10-03T08:05:00.000Z") },
  ],
  savedPrices: [
    { productVariantId: 1002, revisionId: 301, overridePriceCents: 1_499, pricingMode: "fixed", updatedAt: "2026-10-04T10:00:00.000Z" },
    { productVariantId: 2002, revisionId: 302, overridePriceCents: null, pricingMode: "inherit", updatedAt: "2026-10-04T10:01:00.000Z" },
    { productVariantId: 6002, revisionId: 303, overridePriceCents: null, pricingMode: "inherit", updatedAt: "2026-10-04T10:02:00.000Z" },
  ],
  // The rules own size 1001's price, so the price an earlier push saved is not used.
  existingListings: [
    { listingId: 9001, productVariantId: 1001, status: "active", vendorRetailPriceCents: 1_050, quantityCap: null,
      externalListingId: "110000000001" },
  ],
  policyOverrides: [
    { productVariantId: 1002, revisionId: 61, fulfillmentPolicyId: "ship-2", returnPolicyId: null, paymentPolicyId: "pay-2",
      updatedAt: new Date("2026-10-05T09:00:00.000Z") },
    { productVariantId: 3001, revisionId: 62, fulfillmentPolicyId: null, returnPolicyId: "ret-2", paymentPolicyId: null,
      updatedAt: new Date("2026-10-05T09:01:00.000Z") },
  ],
  shelfAssignments: [
    { productVariantId: 1002, storeCategoryNames: ["Mailers"] },
    { productVariantId: 2001, storeCategoryNames: ["Sleeves", "Team bags"] },
  ],
};

/** The store with no pricing rules, no templates and no eBay category rules. */
export const GOLDEN_PREVIEW_NO_RULES_STORE: GoldenPreviewStore = {
  name: "store without rules",
  context: storeContext(23),
  config: ebayListingConfig(8, 23, {
    marketplaceId: "EBAY_US",
    merchantLocationKey: "cardshellz-dropship-23",
    businessPolicies: { fulfillmentPolicyId: "ship-b", returnPolicyId: "ret-b", paymentPolicyId: "pay-b" },
  }),
  pricingProfile: null,
  contentProfile: null,
  ebayCategoryRules: null,
  contentSettings: [],
  savedPrices: [
    { productVariantId: 1002, revisionId: 311, overridePriceCents: 1_799, pricingMode: "fixed", updatedAt: "2026-10-04T11:00:00.000Z" },
    { productVariantId: 2002, revisionId: 312, overridePriceCents: null, pricingMode: "inherit", updatedAt: "2026-10-04T11:01:00.000Z" },
    { productVariantId: 3001, revisionId: 313, overridePriceCents: null, pricingMode: "rules", updatedAt: "2026-10-04T11:02:00.000Z" },
  ],
  existingListings: [
    { listingId: 9101, productVariantId: 2001, status: "active", vendorRetailPriceCents: 1_450, quantityCap: null,
      externalListingId: "110000000101" },
  ],
  policyOverrides: [],
  shelfAssignments: [],
};

export const GOLDEN_PREVIEW_STORES: readonly GoldenPreviewStore[] = [GOLDEN_PREVIEW_RULES_STORE, GOLDEN_PREVIEW_NO_RULES_STORE];

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

/**
 * One preview row's pinned fields. Optional keys are present exactly when the
 * row carries them. `listingIntentSha256` is the sha256 of the intent's JSON
 * as built (null without an intent); `rowSha256` is the sha256 of the whole
 * row's JSON with its keys sorted, so no other field can move unseen.
 */
export type GoldenPreviewRowPin = Pick<DropshipListingPreviewRow,
  | "productVariantId" | "previewStatus" | "blockers" | "warnings" | "priceCents" | "priceSettingRevisionId"
  | "marketplaceQuantity" | "marketplaceCategoryId" | "marketplaceCategoryName" | "storeCategoryNames"
  | "businessPolicySelection" | "previewHash"
> & Partial<Pick<DropshipListingPreviewRow,
  | "pricingRuleName" | "followsStorePricing" | "rulePriceEvidenceHash" | "contentEvidenceHash"
  | "marketplaceCategorySource" | "marketplaceCategoryRuleName" | "marketplaceCategoryFallback"
>> & { listingIntentSha256: string | null; rowSha256: string };

/** One size of the listing-settings facts (`buildListingSettingsFacts(...).sizes`), in its order there. */
export interface GoldenFactsSizePin {
  productVariantId: number;
  priceCents: number | null;
  priceSource: ListingSettingsPriceSource;
  ruleKind: string | null;
  issue: string | null;
  sources: Record<ListingSettingsSettingKey, ListingSettingsValueSource>;
  fixes: readonly string[];
}

export interface GoldenPreviewStorePins {
  storeConnectionId: number;
  summary: { total: number; ready: number; blocked: number; warning: number };
  /** The ids sent to the live eBay policy checks, sorted. */
  preflightedFulfillmentPolicyIds: readonly string[];
  checkedReturnPolicyIds: readonly string[];
  checkedPaymentPolicyIds: readonly string[];
  rows: readonly GoldenPreviewRowPin[];
  facts: {
    sizes: readonly GoldenFactsSizePin[];
    /** sha256 of `JSON.stringify(facts.sizes)` and of `JSON.stringify(facts.products)`. */
    sizesSha256: string;
    productsSha256: string;
  };
}

/** Pinned at commit 46dd3f11 (PR 8a), one entry per store above, in order. */
export const GOLDEN_PREVIEW_PINS: readonly GoldenPreviewStorePins[] = [
  {
    storeConnectionId: 22,
    summary: { total: 8, ready: 3, blocked: 3, warning: 2 },
    preflightedFulfillmentPolicyIds: ["ship-1", "ship-2"],
    checkedReturnPolicyIds: ["ret-1", "ret-2"],
    checkedPaymentPolicyIds: ["pay-1", "pay-2"],
    rows: [
      { productVariantId: 1001, previewStatus: "ready", blockers: [], warnings: [], priceCents: 1_199,
        pricingRuleName: "Store default rule", priceSettingRevisionId: null,
        rulePriceEvidenceHash: "7f541a3c8f28c9198c0f20e029b99a46a09817e3e377a248b49b90a041e3fb53",
        contentEvidenceHash: "a9f3c0151851c564d160eba79eec1e6e7d6ca846e49b22d9fbc58db67f008e61", marketplaceQuantity: 12,
        marketplaceCategoryId: "900103", marketplaceCategoryName: "Mailers", marketplaceCategorySource: "store_default",
        marketplaceCategoryRuleName: null, storeCategoryNames: [], businessPolicySelection: { fulfillmentPolicyId: "ship-1",
        returnPolicyId: "ret-1", paymentPolicyId: "pay-1", overriddenFields: [] },
        previewHash: "33928e0badbb70c9c15ba6bfdad579067183dfb485c91faefbdc099f62ade6d0",
        listingIntentSha256: "8ce143b894c8141124372a6d8c013f8fc540fde51fd909b7f25cf661ca4628ad",
        rowSha256: "88ad826ca768e7e1bb9b2d2481117948446a76e5be411a10acd0cd0eac8bc346" },
      { productVariantId: 1002, previewStatus: "ready", blockers: [], warnings: [], priceCents: 1_499, priceSettingRevisionId: 301,
        contentEvidenceHash: "63d12c7865b8cea52d8e5b3b86c2c84a7d27b0927f28646e052b8c729c43265f", marketplaceQuantity: 12,
        marketplaceCategoryId: "900103", marketplaceCategoryName: "Mailers", marketplaceCategorySource: "store_default",
        marketplaceCategoryRuleName: null, storeCategoryNames: ["Mailers"],
        businessPolicySelection: { fulfillmentPolicyId: "ship-2", returnPolicyId: "ret-1", paymentPolicyId: "pay-2",
        overriddenFields: ["fulfillmentPolicyId", "paymentPolicyId"] },
        previewHash: "ecd7ee6a0fcf94e21e4957d2bed80eca05c9e46d726dfbf1ad822ef5560aeef0",
        listingIntentSha256: "e4761eb0a99ec0710f1097f3d7c5e7e9949713af87cf47750a594643d0010e60",
        rowSha256: "d20c6311e2e5624f6454f8da915bbc5e7171bc1ae9085fa31eb8fb0d3e641ccf" },
      { productVariantId: 2001, previewStatus: "warning", blockers: [],
        warnings: ["pricing:above_ceiling:policy_5", "price_below_product_cost", "ebay_mpn_placeholder"], priceCents: 1_499,
        pricingRuleName: "Sleeves", priceSettingRevisionId: null,
        rulePriceEvidenceHash: "3c27abf2ed1cbc0c5cc5844a8901fc301ccdbdcaa8233f5da141270adc51b668",
        contentEvidenceHash: "b3b87a0383a01138ced980a1a31bce539333076dc8780c38fbf693cc0612d31c", marketplaceQuantity: 12,
        marketplaceCategoryId: "900103", marketplaceCategoryName: "Mailers", marketplaceCategorySource: "store_default",
        marketplaceCategoryRuleName: null, storeCategoryNames: ["Sleeves", "Team bags"],
        businessPolicySelection: { fulfillmentPolicyId: "ship-1", returnPolicyId: "ret-1", paymentPolicyId: "pay-1",
        overriddenFields: [] }, previewHash: "dd61c5cd12158fb2153d35a01fc3f78f8cfcec2c75ec561ecfb30918cb83d2f1",
        listingIntentSha256: "82d6e29cdb24adc93c16240455da51fb34e4d22be64ef571e9c143f421eccddb",
        rowSha256: "360a63029241506c625b69feaa6bae830b50d9d69859e0c0335802a941be8ad0" },
      { productVariantId: 2002, previewStatus: "blocked", blockers: ["listing_content_catalog_review_required"],
        warnings: ["pricing:above_ceiling:policy_5", "ebay_mpn_placeholder"], priceCents: 5_999, pricingRuleName: "Sleeves",
        followsStorePricing: true, priceSettingRevisionId: 302,
        rulePriceEvidenceHash: "f2f62525a7c6155fd5efc4b0d379205cb0881d8b1ebb2d73ccd41b9b909e1c10",
        contentEvidenceHash: "06a1c139add269c8a384f4dbc198466df85b8776ebcb973280e89f4891714ef2", marketplaceQuantity: 12,
        marketplaceCategoryId: "900103", marketplaceCategoryName: "Mailers", marketplaceCategorySource: "store_default",
        marketplaceCategoryRuleName: null, storeCategoryNames: [], businessPolicySelection: { fulfillmentPolicyId: "ship-1",
        returnPolicyId: "ret-1", paymentPolicyId: "pay-1", overriddenFields: [] },
        previewHash: "d4e42155f298d6848003dbe4724d514e29756611dbeba5a1c7e81ec0818139ae",
        listingIntentSha256: "520b324d2a3f16a587a42c9839306575ccb8b61f460584f4de7ded10916d01da",
        rowSha256: "894cfbc38df672f6e002d5e7cccbcb717db974e99cdb8d0fdc8fbceea353e4ef" },
      { productVariantId: 3001, previewStatus: "ready", blockers: [], warnings: [], priceCents: 699,
        pricingRuleName: "Store default rule", priceSettingRevisionId: null,
        rulePriceEvidenceHash: "bb1403c948e73bed362f2185c6ee46f36c74678750d5884550b9daeeb8152a84",
        contentEvidenceHash: "8596a317d7cd7a5432a99ecd2edee6a3801015c00d4d62004cbb2c60e32b7f3c", marketplaceQuantity: 12,
        marketplaceCategoryId: "900101", marketplaceCategoryName: "Toploaders", marketplaceCategorySource: "rule",
        marketplaceCategoryRuleName: "Toploaders", storeCategoryNames: [], businessPolicySelection: { fulfillmentPolicyId: "ship-1",
        returnPolicyId: "ret-2", paymentPolicyId: "pay-1", overriddenFields: ["returnPolicyId"] },
        previewHash: "4dbb3691eb54426918fe8bd326eb3983e8a0ffe1c2c3b94cdd76f0e42c9e3979",
        listingIntentSha256: "be686b9a39a0e89070d15f6ae4802fd187685936e4257cea8f713482887c96c4",
        rowSha256: "da312dd3c9283cdfa1c8f329fa87fc33c2c87db6936677cf7606bbf32000cbed" },
      { productVariantId: 6001, previewStatus: "blocked",
        blockers: ["pricing_rule_priority_conflict", "vendor_retail_price_required", "vendor_retail_price_required"],
        warnings: ["ebay_mpn_placeholder"], priceCents: null, pricingRuleName: null, priceSettingRevisionId: null,
        rulePriceEvidenceHash: "3d9b6b6cdfd103bc919e6e2f3a07894739f74d47105b9a2760d43226d36c1cfe",
        contentEvidenceHash: "9bc262d2fac001f0809967906ed03d7d1dce8bfde7afe2543110e0ebcc76b44b", marketplaceQuantity: 12,
        marketplaceCategoryId: "900103", marketplaceCategoryName: "Mailers", marketplaceCategorySource: "store_default",
        marketplaceCategoryRuleName: null, storeCategoryNames: [], businessPolicySelection: { fulfillmentPolicyId: "ship-1",
        returnPolicyId: "ret-1", paymentPolicyId: "pay-1", overriddenFields: [] },
        previewHash: "3e06c887018149da089933681d4746b551b90869869cbb59cd0b7d955dcb9f39", listingIntentSha256: null,
        rowSha256: "2841d6638b680e9ed9bf5dab759c7455346e4f49a27f654610788c0eed26e3ec" },
      { productVariantId: 6002, previewStatus: "warning", blockers: [], warnings: ["ebay_mpn_placeholder"], priceCents: 8_999,
        followsStorePricing: true, priceSettingRevisionId: 303,
        contentEvidenceHash: "5697ee34fb7be62c38ec7c6897e92a2c2b55d4582b407283cd9c78b8b48f8c2c", marketplaceQuantity: 3,
        marketplaceCategoryId: "900103", marketplaceCategoryName: "Mailers", marketplaceCategorySource: "store_default",
        marketplaceCategoryRuleName: null, storeCategoryNames: [], businessPolicySelection: { fulfillmentPolicyId: "ship-1",
        returnPolicyId: "ret-1", paymentPolicyId: "pay-1", overriddenFields: [] },
        previewHash: "312787562db4d03fa5f1163f73660524e0f8d7a172b4ae42ad8ebfa435575ede",
        listingIntentSha256: "0638a99d2440bdf314bff81874a1ba0c17fc4685653f9f6d57202856c95e37e0",
        rowSha256: "a6fd8cceba43560b10326cc58c7cf82f6823b443e092ff97241196b5a146dc02" },
      { productVariantId: 7001, previewStatus: "blocked", blockers: ["listing_content_template_conflict"],
        warnings: ["ebay_mpn_placeholder"], priceCents: 499, pricingRuleName: "Store default rule", priceSettingRevisionId: null,
        rulePriceEvidenceHash: "c51c5bc18a18f8382b8a02e2b9637da532f1c62500da94425b95734b7fd7e842",
        contentEvidenceHash: "b37cae0fa954a3e83248a59730b7a13258bd73c9fa4c2a4858a352e5e589a9b4", marketplaceQuantity: 12,
        marketplaceCategoryId: "900103", marketplaceCategoryName: "Mailers", marketplaceCategorySource: "store_default",
        marketplaceCategoryRuleName: null, storeCategoryNames: [], businessPolicySelection: { fulfillmentPolicyId: "ship-1",
        returnPolicyId: "ret-1", paymentPolicyId: "pay-1", overriddenFields: [] },
        previewHash: "0d490a8bc7325f4e49715ce6d9a596da57cd95614e8e80de95ad4d1e63f256fe",
        listingIntentSha256: "eab50dcd190894819a2d0be736fdfecab87f81476ed02880229ac82eb337c1c6",
        rowSha256: "ad6a6eed7de7db4d6533d29c9b0d2e3dd6f6c0ede61ff260e8b45a14e53e8b23" },
    ],
    facts: {
      sizes: [
        { productVariantId: 3001, priceCents: 699, priceSource: "rules", ruleKind: "store_default", issue: null,
          sources: { shippingPolicy: "store_default", returnPolicy: "size", paymentPolicy: "store_default",
          ebayCategory: "group_rule", storeShelf: "none", descriptionTemplate: "store_default", mainText: "catalog" }, fixes: [] },
        { productVariantId: 1001, priceCents: 1_199, priceSource: "rules", ruleKind: "store_default", issue: null,
          sources: { shippingPolicy: "store_default", returnPolicy: "store_default", paymentPolicy: "store_default",
          ebayCategory: "store_default", storeShelf: "none", descriptionTemplate: "store_default", mainText: "catalog" },
          fixes: [] },
        { productVariantId: 1002, priceCents: 1_499, priceSource: "exact", ruleKind: null, issue: null,
          sources: { shippingPolicy: "size", returnPolicy: "store_default", paymentPolicy: "size", ebayCategory: "store_default",
          storeShelf: "size", descriptionTemplate: "store_default", mainText: "size" }, fixes: [] },
        { productVariantId: 7001, priceCents: 499, priceSource: "rules", ruleKind: "store_default", issue: null,
          sources: { shippingPolicy: "store_default", returnPolicy: "store_default", paymentPolicy: "store_default",
          ebayCategory: "store_default", storeShelf: "none", descriptionTemplate: "none", mainText: "catalog" },
          fixes: ["description_group_conflict"] },
        { productVariantId: 6002, priceCents: 8_999, priceSource: "retail_fallback", ruleKind: null,
          issue: "pricing_rule_priority_conflict", sources: { shippingPolicy: "store_default", returnPolicy: "store_default",
          paymentPolicy: "store_default", ebayCategory: "store_default", storeShelf: "none", descriptionTemplate: "store_default",
          mainText: "catalog" }, fixes: [] },
        { productVariantId: 6001, priceCents: null, priceSource: "none", ruleKind: null, issue: "pricing_rule_priority_conflict",
          sources: { shippingPolicy: "store_default", returnPolicy: "store_default", paymentPolicy: "store_default",
          ebayCategory: "store_default", storeShelf: "none", descriptionTemplate: "store_default", mainText: "catalog" },
          fixes: ["size_cannot_be_priced"] },
        { productVariantId: 2001, priceCents: 1_499, priceSource: "rules", ruleKind: "group", issue: null,
          sources: { shippingPolicy: "store_default", returnPolicy: "store_default", paymentPolicy: "store_default",
          ebayCategory: "store_default", storeShelf: "size", descriptionTemplate: "group_rule", mainText: "catalog" }, fixes: [] },
        { productVariantId: 2002, priceCents: 5_999, priceSource: "rules", ruleKind: "group", issue: null,
          sources: { shippingPolicy: "store_default", returnPolicy: "store_default", paymentPolicy: "store_default",
          ebayCategory: "store_default", storeShelf: "none", descriptionTemplate: "group_rule", mainText: "size" },
          fixes: ["own_text_needs_check"] },
      ],
      sizesSha256: "1b89f6960072f5938fbdf183723298dd8d9d40dfa7e4f4330dcd3a501cdda1c3",
      productsSha256: "fd7f6283143f64d90d22a701d68e62f2c58a56d245c908ccc57e20b542cbf652",
    },
  },
  {
    storeConnectionId: 23,
    summary: { total: 8, ready: 2, blocked: 3, warning: 3 },
    preflightedFulfillmentPolicyIds: ["ship-b"],
    checkedReturnPolicyIds: ["ret-b"],
    checkedPaymentPolicyIds: ["pay-b"],
    rows: [
      { productVariantId: 1001, previewStatus: "ready", blockers: [], warnings: [], priceCents: 899, priceSettingRevisionId: null,
        contentEvidenceHash: "a3064346d6e047f48f09a9dadf5e7655b3c9c15505129bab56d19a3c34fc66d2", marketplaceQuantity: 12,
        marketplaceCategoryId: "184267", marketplaceCategoryName: "Card Shellz mailers", marketplaceCategorySource: "catalog",
        marketplaceCategoryRuleName: null, storeCategoryNames: [], businessPolicySelection: { fulfillmentPolicyId: "ship-b",
        returnPolicyId: "ret-b", paymentPolicyId: "pay-b", overriddenFields: [] },
        previewHash: "93d545737cbe3a8cda061828c2512cd2bd2eeed107ca93348bea9c150783117e",
        listingIntentSha256: "58572db8e3a2917b3591e91e4be43d41d7601dbbb3b53c261c84179176606076",
        rowSha256: "88f215028cc00731374b99a3266c88efdf09dba2f7e35519bb05e69972e8afc1" },
      { productVariantId: 1002, previewStatus: "ready", blockers: [], warnings: [], priceCents: 1_799, priceSettingRevisionId: 311,
        contentEvidenceHash: "64b48cfc11f0413e176c50b3c97fa34c0ab27a787cd65231b6ae31f3f1d0ab35", marketplaceQuantity: 12,
        marketplaceCategoryId: "184267", marketplaceCategoryName: "Card Shellz mailers", marketplaceCategorySource: "catalog",
        marketplaceCategoryRuleName: null, storeCategoryNames: [], businessPolicySelection: { fulfillmentPolicyId: "ship-b",
        returnPolicyId: "ret-b", paymentPolicyId: "pay-b", overriddenFields: [] },
        previewHash: "a5f5481cd9b079b97130cecd9b9b5389faebd374dd0b9859ac48d00db04f5271",
        listingIntentSha256: "50a87d597ca463bbff123429fd8351180dcd4d9d0fb8549c62efd58313ca08c7",
        rowSha256: "53c95dd1e36bc33137049663fba21b903c66b6fc6ccb64e038964dec1ced6223" },
      { productVariantId: 2001, previewStatus: "warning", blockers: [],
        warnings: ["pricing:above_ceiling:policy_5", "price_below_product_cost", "ebay_mpn_placeholder"], priceCents: 1_450,
        priceSettingRevisionId: null, contentEvidenceHash: "03eecc10ebd94b103b71fac12d46e132108cb49f635de483ce7f5650ddd16c88",
        marketplaceQuantity: 12, marketplaceCategoryId: "183438", marketplaceCategoryName: "Card sleeves",
        marketplaceCategorySource: "catalog", marketplaceCategoryRuleName: null, storeCategoryNames: [],
        businessPolicySelection: { fulfillmentPolicyId: "ship-b", returnPolicyId: "ret-b", paymentPolicyId: "pay-b",
        overriddenFields: [] }, previewHash: "2f54a2e8f0a74e5e9ab270edad0c6eb009fd90570d6af2f0b71add33d87abfb4",
        listingIntentSha256: "d4119ae00794dc4f48c78af5a7c8109158f322d4a03e3d9100add9c0035b1aa3",
        rowSha256: "e48628c5dc1fbcfad9045abbd48acf2e38dbadae5cfdc2500e3a71c79ea8ba9e" },
      { productVariantId: 2002, previewStatus: "warning", blockers: [],
        warnings: ["pricing:above_ceiling:policy_5", "ebay_mpn_placeholder"], priceCents: 5_999, followsStorePricing: true,
        priceSettingRevisionId: 312, contentEvidenceHash: "4189078c971a75d7a81d7e77ab1333edf9bb85c87994ad11db67cda3ff6da38f",
        marketplaceQuantity: 12, marketplaceCategoryId: "183438", marketplaceCategoryName: "Card sleeves",
        marketplaceCategorySource: "catalog", marketplaceCategoryRuleName: null, storeCategoryNames: [],
        businessPolicySelection: { fulfillmentPolicyId: "ship-b", returnPolicyId: "ret-b", paymentPolicyId: "pay-b",
        overriddenFields: [] }, previewHash: "3273e1468316e6b6087ed1593635d1c7a6ad8410d7aa34f5068818bb04d5d4e0",
        listingIntentSha256: "c67d88fd252769936e1605f67a37235a84ed1f5024a1081741b920576891c0ae",
        rowSha256: "aec4808d5d6e0f0187558bf1c44687c32103843b3137d2a197699f6b6b74b763" },
      { productVariantId: 3001, previewStatus: "blocked",
        blockers: ["pricing_rules_not_configured", "vendor_retail_price_required", "vendor_retail_price_required"], warnings: [],
        priceCents: null, pricingRuleName: null, priceSettingRevisionId: 313, rulePriceEvidenceHash: null,
        contentEvidenceHash: "c40173e4154347b4512a8b5e139c2268dedaafadf29c76d155cfb234c6c6cf98", marketplaceQuantity: 12,
        marketplaceCategoryId: "183439", marketplaceCategoryName: "Toploaders & holders", marketplaceCategorySource: "catalog",
        marketplaceCategoryRuleName: null, storeCategoryNames: [], businessPolicySelection: { fulfillmentPolicyId: "ship-b",
        returnPolicyId: "ret-b", paymentPolicyId: "pay-b", overriddenFields: [] },
        previewHash: "435389acfe86f3c66c372587e4585aa129e9ac09d140f0f0416d5627573c4945", listingIntentSha256: null,
        rowSha256: "9af6d69d32672dc8acee74e75014a4b80b923a36fee4c788a431bee591b400d4" },
      { productVariantId: 6001, previewStatus: "blocked", blockers: ["ebay_browse_category_required"],
        warnings: ["ebay_mpn_placeholder"], priceCents: 2_499, priceSettingRevisionId: null,
        contentEvidenceHash: "394c11adc26b18863e113d46f1e380245de26f8421dd5139daca8c1b2686039d", marketplaceQuantity: 12,
        marketplaceCategoryId: null, marketplaceCategoryName: null, marketplaceCategorySource: "none",
        marketplaceCategoryRuleName: null, storeCategoryNames: [], businessPolicySelection: { fulfillmentPolicyId: "ship-b",
        returnPolicyId: "ret-b", paymentPolicyId: "pay-b", overriddenFields: [] },
        previewHash: "c269c2d239e6f5c46fa08f931ecac20dc373365e730ff00859d323e53c2b19ae", listingIntentSha256: null,
        rowSha256: "2dd1883f85061f3ce2b2c5386071ebf83b2e79a720eb0acf5b0c2683991378a9" },
      { productVariantId: 6002, previewStatus: "blocked", blockers: ["ebay_browse_category_required"],
        warnings: ["ebay_mpn_placeholder"], priceCents: 8_999, priceSettingRevisionId: null,
        contentEvidenceHash: "d603955b3d1bd36f1a1e5abb9715bca2e760e7a14c29eecea2f7aa031e726dbf", marketplaceQuantity: 3,
        marketplaceCategoryId: null, marketplaceCategoryName: null, marketplaceCategorySource: "none",
        marketplaceCategoryRuleName: null, storeCategoryNames: [], businessPolicySelection: { fulfillmentPolicyId: "ship-b",
        returnPolicyId: "ret-b", paymentPolicyId: "pay-b", overriddenFields: [] },
        previewHash: "ca3ff54bd90ee3ded56fa94edf524c49e41c8d0888807b82464c34387a5001e9", listingIntentSha256: null,
        rowSha256: "cff7a844fb19171be864d8c6e4e0d32d572b3f64007ff55f832bd7dbaa36b14b" },
      { productVariantId: 7001, previewStatus: "warning", blockers: [], warnings: ["ebay_mpn_placeholder"], priceCents: 699,
        priceSettingRevisionId: null, contentEvidenceHash: "51a749088b5991c8b276bcfff3a66787d77f1e9f7665a72f7bff0532364a151e",
        marketplaceQuantity: 12, marketplaceCategoryId: "183440", marketplaceCategoryName: "Card storage boxes",
        marketplaceCategorySource: "catalog", marketplaceCategoryRuleName: null, storeCategoryNames: [],
        businessPolicySelection: { fulfillmentPolicyId: "ship-b", returnPolicyId: "ret-b", paymentPolicyId: "pay-b",
        overriddenFields: [] }, previewHash: "4aa55722f4f9db5f80dfcbffd97a27c93e1d85dcf67d26899985eea8df488292",
        listingIntentSha256: "ade33b38ac72f1a7545cd708b18b3de1ad8f22821e88661698a03d3e2d16c5df",
        rowSha256: "465bd9358d82d7e40d8b12510e170b97d728d9f349eddcc5cdfabd714ea11cb3" },
    ],
    facts: {
      sizes: [
        { productVariantId: 3001, priceCents: null, priceSource: "none", ruleKind: null, issue: "pricing_rules_not_configured",
          sources: { shippingPolicy: "store_default", returnPolicy: "store_default", paymentPolicy: "store_default",
          ebayCategory: "catalog", storeShelf: "none", descriptionTemplate: "none", mainText: "catalog" },
          fixes: ["size_cannot_be_priced"] },
        { productVariantId: 1001, priceCents: 899, priceSource: "catalog_price", ruleKind: null, issue: null,
          sources: { shippingPolicy: "store_default", returnPolicy: "store_default", paymentPolicy: "store_default",
          ebayCategory: "catalog", storeShelf: "none", descriptionTemplate: "none", mainText: "catalog" }, fixes: [] },
        { productVariantId: 1002, priceCents: 1_799, priceSource: "exact", ruleKind: null, issue: null,
          sources: { shippingPolicy: "store_default", returnPolicy: "store_default", paymentPolicy: "store_default",
          ebayCategory: "catalog", storeShelf: "none", descriptionTemplate: "none", mainText: "catalog" }, fixes: [] },
        { productVariantId: 7001, priceCents: 699, priceSource: "catalog_price", ruleKind: null, issue: null,
          sources: { shippingPolicy: "store_default", returnPolicy: "store_default", paymentPolicy: "store_default",
          ebayCategory: "catalog", storeShelf: "none", descriptionTemplate: "none", mainText: "catalog" }, fixes: [] },
        { productVariantId: 6002, priceCents: 8_999, priceSource: "catalog_price", ruleKind: null, issue: null,
          sources: { shippingPolicy: "store_default", returnPolicy: "store_default", paymentPolicy: "store_default",
          ebayCategory: "none", storeShelf: "none", descriptionTemplate: "none", mainText: "catalog" },
          fixes: ["no_ebay_category"] },
        { productVariantId: 6001, priceCents: 2_499, priceSource: "catalog_price", ruleKind: null, issue: null,
          sources: { shippingPolicy: "store_default", returnPolicy: "store_default", paymentPolicy: "store_default",
          ebayCategory: "none", storeShelf: "none", descriptionTemplate: "none", mainText: "catalog" },
          fixes: ["no_ebay_category"] },
        { productVariantId: 2001, priceCents: 1_450, priceSource: "last_published", ruleKind: null, issue: null,
          sources: { shippingPolicy: "store_default", returnPolicy: "store_default", paymentPolicy: "store_default",
          ebayCategory: "catalog", storeShelf: "none", descriptionTemplate: "none", mainText: "catalog" }, fixes: [] },
        { productVariantId: 2002, priceCents: 5_999, priceSource: "retail_fallback", ruleKind: null, issue: null,
          sources: { shippingPolicy: "store_default", returnPolicy: "store_default", paymentPolicy: "store_default",
          ebayCategory: "catalog", storeShelf: "none", descriptionTemplate: "none", mainText: "catalog" }, fixes: [] },
      ],
      sizesSha256: "ba5d01813445cb2e910e942e17ede64da544d0390dfd08f45bae1638343fc629",
      productsSha256: "c40f12b740c2000f9325481564455cf5f6ea43ad968cbe85f1b4097e4e7ac947",
    },
  },
];

// ---------------------------------------------------------------------------
// Variants (PR 8b, sub-part 8b-W): the documented changes on top of the data
// above (plan 4.10, 4.11). The pins above stay as they are; each variant is
// asserted against them, field by field.
// ---------------------------------------------------------------------------

/** A store shelf default as PR 6's setup save stores it in the listing config: first shelf, then second. */
export const GOLDEN_STORE_SHELF_DEFAULT: EbayStoreShelfDefault = {
  ids: ["8101", "8102"],
  names: ["Card supplies", "Card supplies > New"],
};

/** Product 100's own settings (both mailer sizes; 1002 keeps its own exact price, shelf and policies). */
export const GOLDEN_PRODUCT_100_SETTINGS: ProductListingSettingValues = {
  ...EMPTY_PRODUCT_LISTING_SETTING_VALUES,
  // Retail plus one dollar: 899 → 999 for size 1001.
  price: { basis: "catalog_retail", markupBps: 0, flatCents: 100, rounding: "cent" },
  ebayCategory: { categoryId: "900300", categoryName: "Bubble mailers", path: ["Collectibles", "Shipping Supplies", "Bubble mailers"] },
  storeShelf: { mode: "own", shelves: [{ id: "8201", name: "Mailers > Bubble" }] },
  shippingPolicy: { id: "ship-product", name: "Product shipping" },
  textAbove: { mode: "own", text: "Packed the same day." },
};

/** Card Shellz category 13's settings (toploaders: size 3001). */
export const GOLDEN_CATEGORY_13_SETTINGS: CategoryListingSettingValues = {
  ...EMPTY_CATEGORY_LISTING_SETTING_VALUES,
  // Retail plus two dollars: 1,299 → 1,499 for size 3001.
  price: { basis: "catalog_retail", markupBps: 0, flatCents: 200, rounding: "cent" },
  ebayCategory: { categoryId: "900400", categoryName: "Card holders", path: ["Collectibles", "Card Storage", "Card holders"] },
  storeShelf: { mode: "own", shelves: [{ id: "8301", name: "Toploaders shelf" }] },
  shippingPolicy: { id: "ship-category", name: null },
  textBelow: { mode: "own", text: "Ask about bulk pricing." },
};

// ---------------------------------------------------------------------------
// Cross-path scenario (PR 8b, sub-part 8b-G): every listing setting set on a
// product or a category somewhere, and a store shelf default, over the same
// stores. Every path in plan 4.9 must resolve the same price, eBay category,
// policies, shelf and description from it (plan 4.13), and the product sheet
// (the listing-settings facts) must say what the step 3 preview sends.
// ---------------------------------------------------------------------------

/** Product 200's own main text and payment policy (team bags: size 2001 has no own text, size 2002 keeps its own). */
export const GOLDEN_PRODUCT_200_SETTINGS: ProductListingSettingValues = {
  ...EMPTY_PRODUCT_LISTING_SETTING_VALUES,
  paymentPolicy: { id: "pay-product", name: null },
  // Written against today's product catalog facts, so it needs no check.
  mainText: { text: "Team bags that fit a toploader.\n\nResealable strip.", catalogHash: productCatalogHash(TEAM_BAGS) },
};

/** Card Shellz category 14's settings (storage: size 7001): a price from the .ops cost, a return policy, and "none" for the shelf and the text above. */
export const GOLDEN_CATEGORY_14_SETTINGS: CategoryListingSettingValues = {
  ...EMPTY_CATEGORY_LISTING_SETTING_VALUES,
  // Three times the .ops cost, rounded up to .99: 300 → 999 for size 7001.
  price: { basis: "product_cost", markupBps: 20_000, flatCents: 0, rounding: "up_99" },
  returnPolicy: { id: "ret-category", name: "Category returns" },
  storeShelf: { mode: "none" },
  textAbove: { mode: "none" },
};

/** The scenario's product and category settings, by product and by Card Shellz category. */
export const GOLDEN_CROSS_PATH_PRODUCTS: ReadonlyArray<readonly [productId: number, values: ProductListingSettingValues]> = [
  [100, GOLDEN_PRODUCT_100_SETTINGS], [200, GOLDEN_PRODUCT_200_SETTINGS],
];
export const GOLDEN_CROSS_PATH_CATEGORIES: ReadonlyArray<readonly [categoryId: number, values: CategoryListingSettingValues]> = [
  [13, GOLDEN_CATEGORY_13_SETTINGS], [14, GOLDEN_CATEGORY_14_SETTINGS],
];

/**
 * Product 600's own price (binders: size 6001's two group rules tie, size
 * 6002 is `inherit` in the store with rules). It has no Card Shellz category.
 */
export const GOLDEN_PRODUCT_600_SETTINGS: ProductListingSettingValues = {
  ...EMPTY_PRODUCT_LISTING_SETTING_VALUES,
  // 20% over the .ops cost: 1,000 → 1,200 for size 6001, 3,800 → 4,560 for size 6002.
  price: { basis: "product_cost", markupBps: 2_000, flatCents: 0, rounding: "cent" },
};

/**
 * Card Shellz category 12's price (team bags: size 2002 is `inherit` in both
 * stores). In the store with rules the older Sleeves group still prices both
 * sizes; in the store without rules the category's price does.
 */
export const GOLDEN_CATEGORY_12_SETTINGS: CategoryListingSettingValues = {
  ...EMPTY_CATEGORY_LISTING_SETTING_VALUES,
  // Retail plus 50 cents: 5,999 → 6,049 for size 2002.
  price: { basis: "catalog_retail", markupBps: 0, flatCents: 50, rounding: "cent" },
};

/** The cross-path settings plus those two prices: an `inherit` size after a product's and a category's price, and a group rule before a category's. */
export const GOLDEN_CROSS_PATH_PRICED_PRODUCTS: ReadonlyArray<readonly [productId: number, values: ProductListingSettingValues]> = [
  ...GOLDEN_CROSS_PATH_PRODUCTS, [600, GOLDEN_PRODUCT_600_SETTINGS],
];
export const GOLDEN_CROSS_PATH_PRICED_CATEGORIES: ReadonlyArray<readonly [categoryId: number, values: CategoryListingSettingValues]> = [
  ...GOLDEN_CROSS_PATH_CATEGORIES, [12, GOLDEN_CATEGORY_12_SETTINGS],
];
