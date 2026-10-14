import { expect, type Page, type Route, type TestInfo } from "playwright/test";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  ebayCategoryRulesStateSchema,
  saveEbayCategoryRulesInputSchema,
  type EbayCategory,
  type EbayCategoryOption,
  type EbayCategoryRulesState,
} from "../../shared/dropship/ebay-category-rules";
import { decideDropshipListingAccess } from "../../shared/dropship/listing-access";
import { contentProfileStateSchema, saveContentProfileInputSchema, type ContentProfileState } from "../../shared/dropship/listing-content";
import { saveProductSettingsInputSchema, saveProductSettingsResponseSchema } from "../../shared/dropship/listing-setting-writes";
import {
  listingPriceResponseSchema,
  saveListingPriceInputSchema,
  type ListingPriceSetting,
  type ListingPricingMode,
} from "../../shared/dropship/listing-price";
import {
  LISTING_SETTINGS_FIELD_SETTINGS,
  LISTING_SETTINGS_FIELDS,
  LISTING_SETTINGS_FIX_CODES,
  LISTING_SETTINGS_PAGE_SIZE,
  LISTING_SETTINGS_VALUE_SOURCES,
  listingSettingsPricesResponseSchema,
  listingSettingsProductDetailSchema,
  listingSettingsProductOwnSettingsSchema,
  listingSettingsProductsResponseSchema,
  listingSettingsSummarySchema,
  type ListingSettingsFixCode,
  type ListingSettingsProductDetail,
  type ListingSettingsProductOwnSettings,
  type ListingSettingsProductRow,
  type ListingSettingsProductSettings,
  type ListingSettingsSettingKey,
  type ListingSettingsSizePrice,
  type ListingSettingsSummary,
  type ListingSettingsValueSource,
} from "../../shared/dropship/listing-settings";
import {
  categoryListingSettingValuesSchema,
  productListingSettingValuesSchema,
  type CategoryListingSettingValues,
  type ListingSettingTemplateText,
  type ProductListingSettingValues,
} from "../../shared/dropship/listing-setting-values";
import {
  CATEGORY_PRICE_RULE_NAME,
  PRICING_REVIEW_PAGE_SIZE,
  PRODUCT_PRICE_RULE_NAME,
  applyPricingRulesInputSchema,
  calculateRulePrice,
  pricingBasisCents,
  pricingProfileStateSchema,
  pricingReviewResponseSchema,
  reviewPricingRulesInputSchema,
  type PricingImpactRow,
  type PricingProfileState,
  type PricingRecipe,
  type PricingReviewResponse,
  type ReviewPricingRulesInput,
} from "../../shared/dropship/pricing-rules";

/**
 * The stub Card Shellz server and fixtures the Catalog page's browser journeys run against
 * (`dropship-policy-catalog-steps.spec.ts`, `dropship-policy-listing-settings-step.spec.ts`).
 * Every API call the page makes is answered here; anything else is recorded in
 * `state.unexpected` and answered 500, so a journey that ends with `unexpected` empty proves
 * the page asked for nothing the stub does not know.
 *
 * Writers are compare-and-set and keyed as the real routes are: a save against an older
 * revision is refused, the same request key with the same body is answered from the first
 * save, and the same key with another body is refused. Every request body a writer receives
 * and every answer a read sends is checked against the shared contract, so a fixture or a
 * request that drifts from it fails the journey with its own message.
 *
 * Money is integer cents throughout; rule prices come from the shared resolver
 * (`calculateRulePrice`), so a price here is the price the server would give.
 *
 * A size's settings come from one resolver (`layeredSettings`) over the store defaults and the
 * product, category and size layers in `StubState`, closest first, as the server's facts do;
 * the product detail, the lists, the live summary and the product's own settings read all use it.
 */

/** Where screenshots go when CATALOG_SHOTS_DIR is set (never in CI). */
export const SHOTS_DIR = process.env.CATALOG_SHOTS_DIR ?? null;
/** The Catalog page's own addresses; the harness is served for each, so a reload keeps the step. */
export const CATALOG_PATH = "/dropship-portal/catalog";
export const STAMP = "2026-09-30T12:00:00.000Z";
export const MEMBER_ID = "m-1";

export interface StoreFixture { storeConnectionId: number; platform: string; name: string }
export const MARZ: StoreFixture = { storeConnectionId: 5, platform: "ebay", name: "Marz Cards" };
export const OUTLET: StoreFixture = { storeConnectionId: 9, platform: "ebay", name: "Marz Cards Outlet" };
export const SHOP: StoreFixture = { storeConnectionId: 3, platform: "shopify", name: "Test Shop" };

export const ROW = {
  productId: 11, productVariantId: 101, productSku: "ENV-SGL", productName: "Envelope Single Pocket", variantSku: "ENV-SGL-P50",
  variantName: "Pack of 50", category: "Mailers", productLineIds: [], productLineNames: [], unitsPerVariant: 50,
  selectionDecision: { selected: true, reason: "selected", marketplaceQuantity: 25, quantityCapApplied: false, autoConnectNewSkus: true, autoListNewSkus: false },
  listingTier: { tier: "pack", eligible: true, reason: null, policyMinimumCents: 10_000, reserveShortfallCents: 0, balanceShortfallCents: 0 },
};

export function previewRow(storeConnectionId: number) {
  return {
    productVariantId: 101, productId: 11, sku: "ENV-SGL-P50", title: "Envelope Single Pocket, Pack of 50", platform: "ebay",
    listingMode: "create", currentListingStatus: "not_listed", previewStatus: "ready", blockers: [], warnings: [], marketplaceQuantity: 25,
    priceCents: 699, marketplaceCategoryId: "183435", marketplaceCategoryName: "Card Sleeves", storeCategoryNames: [],
    businessPolicySelection: null, previewHash: `${storeConnectionId}`.padStart(64, "d"), priceSettingRevisionId: null,
    contentEvidenceHash: "c".repeat(64),
  };
}

/** The listing config revision every setup answer carries (migration 0728); a save sends it back. */
export const SETUP_REVISION = 3;

export function listingSetup(storeConnectionId: number) {
  const defaults = { fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: "payments" };
  return { storeConnectionId, marketplaceId: "EBAY_US", complete: true, missingFields: [] as string[],
    revision: SETUP_REVISION, access: { canEdit: true, reason: null } as { canEdit: boolean; reason: string | null },
    checks: { ebay: "checked", fulfillment: { status: "checked" } },
    storedNames: { fulfillmentPolicyName: "USPS Ground Advantage", returnPolicyName: "30-day returns", paymentPolicyName: "Managed payments" },
    storeShelfDefault: null as { ids: string[]; names: string[] } | null,
    selection: { merchantLocationKey: "managed", ...defaults },
    fulfillmentCapability: { marketplaceId: "EBAY_US", requiredHandlingTimeBusinessDays: 1, destinationCountry: "US",
      destinationRegions: ["PA"], destinationCoverageComplete: true, supportedServices: [], evidenceHash: "fixture",
      source: { omsChannelId: 1, originWarehouseId: 1, rateBookId: 1, rateBookCode: "fixture", rateTableId: 1, serviceLevelId: 1,
        fulfillmentRoutingRevision: 1 } },
    options: { merchantLocations: [{ id: "managed", name: "Managed" }],
      fulfillmentPolicies: [{ id: "ground", name: "USPS Ground Advantage", compatible: true, compatibilityIssues: [] }],
      returnPolicies: [{ id: "returns", name: "30-day returns" }],
      paymentPolicies: [{ id: "payments", name: "Managed payments" }] } };
}

/** A store that has saved no eBay policies yet, with two of each to choose from. */
export function listingSetupWithNothingSaved(storeConnectionId: number) {
  const setup = listingSetup(storeConnectionId);
  return { ...setup, complete: false, missingFields: ["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"],
    selection: { merchantLocationKey: "managed", fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null },
    options: { ...setup.options,
      fulfillmentPolicies: [...setup.options.fulfillmentPolicies,
        { id: "priority", name: "USPS Priority Mail", compatible: true, compatibilityIssues: [] }],
      returnPolicies: [...setup.options.returnPolicies, { id: "no-returns", name: "No returns" }],
      paymentPolicies: [...setup.options.paymentPolicies, { id: "payments-other", name: "Other payments" }] } };
}

/** Everything saved, with a second shipping policy the vendor can switch to. */
export function listingSetupWithAnotherShippingPolicy(storeConnectionId: number) {
  const setup = listingSetup(storeConnectionId);
  return { ...setup, options: { ...setup.options, fulfillmentPolicies: [...setup.options.fulfillmentPolicies,
    { id: "priority", name: "USPS Priority Mail", compatible: true, compatibilityIssues: [] }] } };
}

/**
 * The saved shipping policy ("ground") is gone from eBay, so that field opens empty (the server
 * names it missing); two other shipping policies fit, and a second return policy can be chosen.
 */
export function listingSetupWithSavedShippingGone(storeConnectionId: number) {
  const setup = listingSetup(storeConnectionId);
  return { ...setup, complete: false, missingFields: ["fulfillmentPolicyId"],
    options: { ...setup.options,
      fulfillmentPolicies: [{ id: "priority", name: "USPS Priority Mail", compatible: true, compatibilityIssues: [] },
        { id: "express", name: "USPS Priority Mail Express", compatible: true, compatibilityIssues: [] }],
      returnPolicies: [...setup.options.returnPolicies, { id: "no-returns", name: "No returns" }] } };
}

/** The issue the server names for a shipping policy with too short a handling time (ebay-fulfillment-policy-compatibility.ts). */
export const HANDLING_TIME_ISSUE = { code: "handling_time_too_short", message: "Policy must allow at least 1 business day of handling time." };

/**
 * The same answer without the Card Shellz shipping check: a save that sends no shipping policy
 * skips it (dropship-ebay-listing-setup-service.ts planSetupSave), and so does a read while
 * shipping can't be read; every shipping policy is then unchecked (buildFulfillmentPolicyOptions).
 */
// Not generic: a generic spread would intersect the setup's capability object with null, which
// types the result as never (TypeScript reduces the conflicting intersection), though it runs fine.
export function withShippingNotChecked(setup: ReturnType<typeof listingSetup>,
  fulfillment: Record<string, unknown> = { status: "not_checked" }) {
  return { ...setup, complete: false, checks: { ...setup.checks, fulfillment }, fulfillmentCapability: null,
    options: { ...setup.options, fulfillmentPolicies: setup.options.fulfillmentPolicies.map((policy) => ({
      ...policy, compatible: false, compatibilityChecked: false, compatibilityIssues: [] })) } };
}

export const POLICY_FIELDS = ["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"] as const;

/** A save or repair the stub received. */
export interface SetupWrite { method: string; path: string; body: Record<string, unknown> }

/** A write the stub received for W1, W3, W4 or W9, as sent. */
export interface StubWrite { method: string; path: string; body: Record<string, unknown> }

/** A refusal the stub sends instead of saving: the route's status, code and words. */
export interface ScriptedError { status: number; code: string; message: string; context?: Record<string, unknown> }

/**
 * How the next write answers: `"drop"` cuts the connection after the request reached the stub
 * (as a network drop does; for W1, W3, W4 and W9 the save is made first, so the same request
 * key is answered from it), a scripted refusal, or for W2 a confirmed save whose answer carries
 * this `outcome` instead of `changed` (`unchanged`: nothing needed changing; `replayed`: answered
 * from an earlier save with this key). Every 2xx is a confirmed save to the page (C26).
 */
export type WriteAnswer = "drop" | ScriptedError;
export type SetupWriteAnswer = WriteAnswer | { outcome: "unchanged" | "replayed" };

/** One request the page made, as it reached the stub. */
export interface StubRequest { method: string; path: string; search: string }

export type SummaryRail = { state: string; productsNeedingFix: number; missingPolicy: string | null };

/** The listing settings summary the rail reads (shared/dropship/listing-settings.ts). */
export function listingSettingsSummary(storeConnectionId: number, rail: SummaryRail = { state: "all_set", productsNeedingFix: 0, missingPolicy: null }) {
  const policy = (policyId: string) => ({ policyId, verification: "not_checked" });
  return { storeConnectionId, storeStatus: "connected", access: { allowed: true }, catalog: { state: "ok", products: 1, sizes: 1 },
    storeDefaults: { price: { recipe: null, groupRules: 0 }, shippingPolicy: policy("ground"), returnPolicy: policy("returns"),
      paymentPolicy: policy("payments"), ebayCategory: { category: null, groupRules: 0 },
      description: { hasIntroduction: false, hasFooter: false, groupRules: 0 } },
    counts: { productsNeedingFix: rail.productsNeedingFix, productsWithSizesDiffer: 0, productsWithOwnSettings: 0, exactPrices: 0,
      belowCost: 0, cannotPrice: 0, paused: 0 },
    attention: { items: [], total: 0 }, rail, generatedAt: STAMP };
}

// ---------------------------------------------------------------------------
// The catalog the listing settings reads are worked out from
// ---------------------------------------------------------------------------

/** One chosen size: its Card Shellz retail price and the vendor's .ops cost, in integer cents. */
export interface SizeFixture {
  productVariantId: number;
  sizeName: string;
  sku: string | null;
  /** The Card Shellz retail price; null when Card Shellz has none. */
  retailCents: number | null;
  /** The vendor's .ops cost for one pack; null when it is not on file. */
  costCents: number | null;
  stockUnits: number;
}

/** One chosen product and its chosen sizes. */
export interface ProductFixture {
  productId: number;
  productName: string;
  productSku: string | null;
  /** The Card Shellz category's current name, which a value from its settings is shown under. */
  category: string | null;
  /**
   * The Card Shellz category's id (catalog.product_categories.id), whose settings
   * (`categorySettings`) the product follows; null or left out for none, as today's fixtures.
   */
  categoryId?: number | null;
  /** Every size the vendor could choose; defaults to the chosen ones. */
  sizesTotal?: number;
  sizes: SizeFixture[];
}

/**
 * A product in a Card Shellz category with two sizes, for the layered resolver's load-time check
 * (and for journeys that want one): $3.99 and $8.99 retail.
 */
export const LAYERED_SAMPLE: ProductFixture = {
  productId: 21, productName: "Penny Sleeves", productSku: "PSL", category: "Sleeves", categoryId: 40,
  sizes: [
    { productVariantId: 301, sizeName: "Pack of 100", sku: "PSL-100", retailCents: 399, costCents: 210, stockUnits: 40 },
    { productVariantId: 302, sizeName: "Pack of 500", sku: "PSL-500", retailCents: 899, costCents: 610, stockUnits: 9 },
  ],
};

/** Product 11 and its one chosen size, as ROW: $6.99 retail, $4.10 cost (the price stub's numbers). */
export const ENVELOPE: ProductFixture = {
  productId: ROW.productId, productName: ROW.productName, productSku: ROW.productSku, category: ROW.category,
  sizes: [{ productVariantId: ROW.productVariantId, sizeName: ROW.variantName, sku: ROW.variantSku, retailCents: 699, costCents: 410, stockUnits: 25 }],
};

/** A size's saved price setting (W9): what the vendor chose, and its revision. */
export interface SavedSizePrice {
  revisionId: number;
  pricingMode: ListingPricingMode;
  /** Set exactly when `pricingMode` is `fixed`. */
  overridePriceCents: number | null;
}

/**
 * The layers a size's settings come from besides the store defaults (plan PR 10, 3.2, CI-M6):
 * each product's own row (W5, W6), each Card Shellz category's row (W12), and what today's
 * per-size panels left on single sizes. They are stored in the server's own shapes and parsed
 * with its stored contract each time a read uses them (productLayerOf, categoryLayerOf,
 * sizeLeftoverOf), because test/ is not type-checked in CI: a fixture that drifts fails the
 * journey with the schema's words.
 */
export interface ProductSettingsLayer { revisionId: number; values: ProductListingSettingValues }
export interface CategorySettingsLayer { revisionId: number; values: CategoryListingSettingValues }
/** What today's per-size panels left on one size: policy ids (an override), one or two shelf names, its own main text. */
export interface SizeLeftoverLayer {
  shippingPolicyId?: string;
  returnPolicyId?: string;
  paymentPolicyId?: string;
  shelfNames?: string[];
  mainText?: string;
}

const revisionIdSchema = z.number().int().positive().max(2_147_483_647);
const productSettingsLayerSchema = z.object({ revisionId: revisionIdSchema, values: productListingSettingValuesSchema }).strict();
const categorySettingsLayerSchema = z.object({ revisionId: revisionIdSchema, values: categoryListingSettingValuesSchema }).strict();
const sizeLeftoverLayerSchema = z.object({
  shippingPolicyId: z.string().min(1).optional(),
  returnPolicyId: z.string().min(1).optional(),
  paymentPolicyId: z.string().min(1).optional(),
  // A per-size shelf row always holds one or two names (migration 215).
  shelfNames: z.array(z.string().min(1)).min(1).max(2).optional(),
  mainText: z.string().min(1).optional(),
}).strict();

/**
 * The product-level catalog hash every fixture product's facts give (productCatalogHash on the
 * server): a product main text saved with it is up to date; with any other hash it needs a check.
 */
export const STUB_PRODUCT_CATALOG_HASH = "a".repeat(64);

export function productKey(storeConnectionId: number, productId: number): string {
  return `${storeConnectionId}:${productId}`;
}

export function categoryKey(storeConnectionId: number, categoryId: number): string {
  return `${storeConnectionId}:${categoryId}`;
}

/** The name `resolvePricingRule` gives the store default recipe (shared/dropship/pricing-rules.ts). */
const STORE_DEFAULT_RULE_NAME = "Store default rule";
/** The category Card Shellz picks for every fixture product when the store sets none. */
const CARD_SHELLZ_CATEGORY = { categoryId: "183435", categoryName: "Card Sleeves" } as const;
const EVIDENCE_HASH = "e".repeat(64);
const NO_RULES_STATE = { revisionId: null, profile: null, updatedAt: null };

export function sizeKey(storeConnectionId: number, productVariantId: number): string {
  return `${storeConnectionId}:${productVariantId}`;
}

// ---------------------------------------------------------------------------
// eBay categories the picker can search and browse (as dropship-policy-ebay-categories.spec.ts)
// ---------------------------------------------------------------------------

export const COLLECTIBLES: EbayCategoryOption = { categoryId: "1", categoryName: "Collectibles", path: ["Collectibles"], leaf: false };
export const CARD_SUPPLIES: EbayCategoryOption = { categoryId: "261328", categoryName: "Card Supplies", path: ["Collectibles", "Card Supplies"], leaf: false };
export const SLEEVES: EbayCategoryOption = { categoryId: "183435", categoryName: "Card Sleeves", path: ["Collectibles", "Card Supplies", "Card Sleeves"], leaf: true };
export const TOPLOADERS: EbayCategoryOption = { categoryId: "183436", categoryName: "Toploaders", path: ["Collectibles", "Card Supplies", "Toploaders"], leaf: true };
const EBAY_CATEGORIES = [COLLECTIBLES, CARD_SUPPLIES, SLEEVES, TOPLOADERS];

function ebayCategory(option: EbayCategoryOption): EbayCategory {
  return { categoryId: option.categoryId, categoryName: option.categoryName, path: [...option.path] };
}

/** One eBay store shelf (`GET /api/dropship/ebay/store-categories/:id`). */
export interface StoreShelfFixture { categoryId: string; categoryName: string; path: string; level: number }

export interface StubState {
  stores: StoreFixture[];
  selected: boolean;
  previewCalls: number;
  setupReads: number[];
  summaryReads: number[];
  /** Products tab reads, as "<store>?<query>". */
  productsReads: string[];
  /** Every API request, in order. */
  reads: StubRequest[];
  /** The vendor account the onboarding read reports; it decides which writers take a save. */
  vendor: { status: string; entitlementStatus: string };
  /** The listing settings summary by store; a store left out gets listingSettingsSummary(), or the live one. */
  summaries: Record<number, unknown>;
  /**
   * True: a store left out of `summaries` gets a summary worked out from what the stub holds
   * (its saved policies, store price, eBay category, description and the catalog's prices), so
   * a save shows in it. False: today's fixed listingSettingsSummary().
   */
  liveSummary: boolean;
  /** The summary's store status by store (live summary only); a store left out is connected. */
  storeStatuses: Record<number, string>;
  /** More than 10,000 sizes chosen (live summary and lists only). */
  tooLarge: boolean;
  /** How many summary reads still fail before they answer. */
  summaryFailures: number;
  /** eBay listing setup by store; a store left out gets listingSetup(). */
  listingSetups: Record<number, unknown>;
  /** How many eBay listing setup reads still fail (eBay unavailable) before they answer. */
  setupReadFailures: number;
  /** Every eBay listing setup read is refused with this while it is set (a sign-in eBay asks for, say). */
  setupReadError: ScriptedError | null;
  /** Saved pricing rules by store; a store left out has none. */
  pricingRules: Record<number, PricingProfileState>;
  /** eBay listing setup saves (PUT) and ship-from repairs (POST), in order. */
  setupWrites: SetupWrite[];
  /** How the next setup writes answer, in order; once used up, a write is saved. */
  setupWriteAnswers: SetupWriteAnswer[];
  /** The chosen products and sizes the listing settings reads list (every store chooses the same). */
  catalog: ProductFixture[];
  /** Saved size prices (W9) by sizeKey(store, size). */
  sizePrices: Record<string, SavedSizePrice>;
  /** Each product's own settings row by productKey(store, product); a product left out has none (plan PR 10, 3.2). */
  productSettings: Record<string, ProductSettingsLayer>;
  /** Each Card Shellz category's settings row by categoryKey(store, category); a category left out has none. */
  categorySettings: Record<string, CategorySettingsLayer>;
  /** What today's per-size panels left on single sizes, by sizeKey(store, size); a size left out has none. */
  sizeLeftovers: Record<string, SizeLeftoverLayer>;
  /** The store's eBay shelves by store; a store left out has none. */
  storeShelves: Record<number, StoreShelfFixture[]>;
  /** The shelves read is refused with this while it is set. */
  storeShelvesError: ScriptedError | null;
  /** Saved eBay category rules (W3) by store; a store left out has none. */
  categoryRules: Record<number, EbayCategoryRulesState>;
  /** Saved description templates (W4) by store; a store left out has none. */
  contentProfiles: Record<number, ContentProfileState>;
  /** W1 price checks (POST …/pricing-rules/reviews), and how the next ones answer. */
  pricingReviews: StubWrite[];
  pricingReviewAnswers: WriteAnswer[];
  /** W1 saves (POST …/pricing-rules/apply), and how the next ones answer. */
  pricingApplies: StubWrite[];
  pricingApplyAnswers: WriteAnswer[];
  /** W3 saves (PUT …/ebay-category-rules), and how the next ones answer. */
  categoryWrites: StubWrite[];
  categoryWriteAnswers: WriteAnswer[];
  /** eBay category searches (the `q` sent). */
  categorySearches: string[];
  /** W4 saves (PUT …/content-profile), and how the next ones answer. */
  contentWrites: StubWrite[];
  contentWriteAnswers: WriteAnswer[];
  /** W9 saves (PUT …/variants/:id/price), and how the next ones answer. */
  priceWrites: StubWrite[];
  priceWriteAnswers: WriteAnswer[];
  /** W5 saves of one product's own settings (PUT …/listing-settings/products/:id; plan PR 10, 4.6), and how the next ones answer. */
  productSettingsWrites: StubWrite[];
  productSettingsWriteAnswers: WriteAnswer[];
  /** The checks W1 made, by review id, for paging and saving. */
  reviews: Record<string, { storeConnectionId: number; input: ReviewPricingRulesInput; review: PricingReviewResponse }>;
  /** Request keys the keyed writers saw, with the body and the answer, so a retry is answered from the first save. */
  keyedAnswers: Record<string, { body: string; json: Record<string, unknown> }>;
  /** The next revision a keyed writer saves (W1, W3, W4, W5, W9 share one counter, as ids). */
  nextRevision: number;
  unexpected: string[];
  errors: string[];
}

/** Saved pricing rules: catalog reference retail + 15%. */
export const SAVED_PRICING_RULES: PricingProfileState = { revisionId: 3, updatedAt: STAMP, profile: {
  defaultRecipe: { basis: "catalog_retail", markupBps: 1_500, flatCents: 0, rounding: "cent" }, groups: [] } };

export function storeConnection(store: StoreFixture) {
  return { storeConnectionId: store.storeConnectionId, vendorId: 1, platform: store.platform, externalAccountId: `acct-${store.storeConnectionId}`,
    externalDisplayName: store.name, shopDomain: null, status: "connected", setupStatus: "ready", disconnectReason: null,
    disconnectedAt: null, graceEndsAt: null, tokenExpiresAt: null, hasAccessToken: true, hasRefreshToken: true, launchReady: true,
    lastSyncAt: null, lastOrderSyncAt: null, lastInventorySyncAt: null, orderProcessingConfig: { defaultWarehouseId: null },
    createdAt: STAMP, updatedAt: STAMP };
}

export function onboardingJson(vendor: StubState["vendor"] = { status: "active", entitlementStatus: "active" }) {
  return {
    vendor: { vendorId: 1, memberId: MEMBER_ID, businessName: "Marz Cards", contactName: null, email: "vendor@example.com", phone: null,
      status: vendor.status, entitlementStatus: vendor.entitlementStatus, membershipGraceEndsAt: null, includedStoreConnections: 3,
      standingReason: null, pausedAt: null },
    entitlement: { memberId: MEMBER_ID, cardShellzEmail: "vendor@example.com", status: "active", planId: "ops", planName: "Ops",
      subscriptionId: "sub-1", includesDropship: true, reasonCode: "active" },
    storeConnections: { activeCount: 1, connectedCount: 1, launchReadyConnectedCount: 1, credentialAttentionCount: 0,
      needsAttentionCount: 0, totalCount: 1, includedLimit: 3, canConnectStore: true },
    catalog: { adminExposureRuleCount: 1, vendorSelectionRuleCount: 1, adminCatalogAvailable: true, hasVendorSelection: true },
    wallet: { availableBalanceCents: 10_000, pendingBalanceCents: 0, activeFundingMethodCount: 1, activeStripeFundingMethodCount: 1,
      activeStripeCardFundingMethodCount: 1, activeUsdcBaseFundingMethodCount: 0, autoReloadEnabled: true, autoReloadFundingMethodId: 10,
      autoReloadFundingMethodActive: true, autoReloadFundingMethodReady: true, autoReloadFundingMethodIsCard: true, hasActiveFundingMethod: true,
      hasStripeReadyFundingMethod: true, hasUsdcBaseFundingMethod: false, hasCardBackstop: true, autoReloadConfigured: true,
      hasSpendableBalance: true, walletReady: true },
    steps: [
      { key: "vendor_profile", label: "Vendor profile", status: "complete", required: true },
      { key: "store_connection", label: "Store connection", status: "complete", required: true },
      { key: "catalog_available", label: "Card Shellz catalog", status: "complete", required: true },
      { key: "catalog_selection", label: "Catalog selection", status: "complete", required: true },
      { key: "wallet_payment", label: "Wallet and auto-reload", status: "complete", required: true },
    ],
  };
}

export function settingsJson(state: StubState) {
  return { settings: {
    vendor: { vendorId: 1, memberId: MEMBER_ID, businessName: "Marz Cards", email: "vendor@example.com", status: state.vendor.status,
      entitlementStatus: state.vendor.entitlementStatus, includedStoreConnections: 3 },
    account: { hasContactEmail: true, hasBusinessName: true },
    storeConnections: state.stores.map(storeConnection),
    wallet: { availableBalanceCents: 10_000, pendingBalanceCents: 0, autoReloadEnabled: true, fundingMethodCount: 1,
      activeStripeFundingMethodCount: 1, activeUsdcBaseFundingMethodCount: 0, autoReloadFundingMethodReady: true },
    notificationPreferences: { configuredCount: 0 }, sections: [], generatedAt: STAMP,
  } };
}

// ---------------------------------------------------------------------------
// Prices, as the server works them out (dropship-listing-settings-facts.ts, W9's projection)
// ---------------------------------------------------------------------------

type SetupFixture = ReturnType<typeof listingSetup>;

function setupOf(state: StubState, storeConnectionId: number): SetupFixture {
  return (state.listingSetups[storeConnectionId] ?? listingSetup(storeConnectionId)) as SetupFixture;
}

function storeRecipe(state: StubState, storeConnectionId: number): PricingRecipe | null {
  return state.pricingRules[storeConnectionId]?.profile?.defaultRecipe ?? null;
}

// ---------------------------------------------------------------------------
// The layers, resolved as the server resolves them (plan PR 10, 3.2, CI-M6)
// ---------------------------------------------------------------------------

/** A layer as a read uses it, parsed with the stored contract (a copy; the state is never changed). */
function productLayerOf(state: StubState, storeConnectionId: number, productId: number): ProductSettingsLayer | null {
  const layer = state.productSettings[productKey(storeConnectionId, productId)];
  return layer === undefined ? null : productSettingsLayerSchema.parse(layer);
}

function categoryLayerOf(state: StubState, storeConnectionId: number, categoryId: number): CategorySettingsLayer | null {
  const layer = state.categorySettings[categoryKey(storeConnectionId, categoryId)];
  return layer === undefined ? null : categorySettingsLayerSchema.parse(layer);
}

function sizeLeftoverOf(state: StubState, storeConnectionId: number, productVariantId: number): SizeLeftoverLayer {
  const layer = state.sizeLeftovers[sizeKey(storeConnectionId, productVariantId)];
  return layer === undefined ? {} : sizeLeftoverLayerSchema.parse(layer);
}

/** The recipe that prices a size by rule, closest first: the product's own price, its category's, the store's. */
export interface LayeredPrice {
  recipe: PricingRecipe;
  /** `kind` and `name` as the size price's `rule` names them (listingSettingsPriceRuleSchema). */
  kind: "product" | "category" | "store_default";
  name: string;
}

/** One size's value for one setting and where it gets it (the facts' ListingSettingsSizeValue). Equal keys are equal values. */
export interface LayeredValue<V> { key: string; value: V; source: ListingSettingsValueSource; ruleName: string | null }
type SettingValue<K extends ListingSettingsSettingKey> = ListingSettingsProductSettings[K][number]["value"];
export type LayeredSizeValues = { [K in ListingSettingsSettingKey]: LayeredValue<SettingValue<K>> };

export interface LayeredSize {
  size: SizeFixture;
  values: LayeredSizeValues;
  /** The size uses the product's own main text, written against other catalog facts (the `own_text_needs_check` fix). */
  ownTextNeedsCheck: boolean;
}

export interface LayeredProduct {
  product: ProductFixture;
  /** The product's own settings row; null when it has none. */
  own: ProductSettingsLayer | null;
  /** The product's Card Shellz category and its settings row (null when it has none); null for no category. */
  category: { categoryId: number; name: string; layer: CategorySettingsLayer | null } | null;
  /** What prices the product's sizes by rule; null when nothing does. */
  price: LayeredPrice | null;
  /** Its chosen sizes, in the fixture's order. */
  sizes: LayeredSize[];
}

/** The template part sources, closest first (resolveContentTemplate's order); the closer of a size's two is its value's source. */
const TEMPLATE_PART_SOURCES = ["product", "group_rule", "category", "store_default", "none"] as const;
const POLICY_LEFTOVER = { shippingPolicy: "shippingPolicyId", returnPolicy: "returnPolicyId", paymentPolicy: "paymentPolicyId" } as const;
const POLICY_DEFAULT = { shippingPolicy: "fulfillmentPolicyId", returnPolicy: "returnPolicyId", paymentPolicy: "paymentPolicyId" } as const;

function layeredValue<V>(key: string, value: V, source: ListingSettingsValueSource, ruleName: string | null = null): LayeredValue<V> {
  return { key, value, source, ruleName };
}

/**
 * One product's settings, size by size, from the layers: the closest setting wins, size (a
 * leftover; for prices only an exact price, which `sizePrices` holds) → product → category →
 * store default (REC:993), as dropship-listing-settings-facts.ts sizeValues resolves them. A
 * value from the category is named by the category's current name. With every layer empty each
 * value is the store-level one these reads gave before the layers existed; two store-level reads
 * keep today's stub words on purpose (the store shelf default is not read; a store template
 * with no text is no source). Older group rules are not modelled here. Null when not chosen.
 */
export function layeredSettings(state: StubState, storeConnectionId: number, productId: number): LayeredProduct | null {
  const product = state.catalog.find((entry) => entry.productId === productId);
  return product ? layeredProduct(state, storeConnectionId, product) : null;
}

/** The product's Card Shellz category with its settings row; a category id without a name is a fixture fault. */
function categoryOf(state: StubState, storeConnectionId: number, product: ProductFixture): LayeredProduct["category"] {
  const categoryId = product.categoryId ?? null;
  if (categoryId === null) return null;
  if (product.category === null) {
    throw new Error(`Fixture product ${product.productId} has a category id but no category name to show its values under.`);
  }
  return { categoryId, name: product.category, layer: categoryLayerOf(state, storeConnectionId, categoryId) };
}

function layeredProduct(state: StubState, storeConnectionId: number, product: ProductFixture): LayeredProduct {
  const own = productLayerOf(state, storeConnectionId, product.productId);
  const category = categoryOf(state, storeConnectionId, product);
  const ownValues = own?.values ?? null;
  const categoryValues = category?.layer?.values ?? null;
  const categoryName = category?.name ?? null;
  const selection = setupOf(state, storeConnectionId).selection as Record<string, string | null | undefined>;
  const storeCategory = state.categoryRules[storeConnectionId]?.profile?.defaultCategory ?? null;
  const template = state.contentProfiles[storeConnectionId]?.profile?.defaultTemplate ?? null;
  const storeHasText = template !== null && (template.introduction !== "" || template.footer !== "");

  const policy = (setting: keyof typeof POLICY_LEFTOVER, leftover: SizeLeftoverLayer): LayeredValue<{ policyId: string | null }> => {
    const sizeId = leftover[POLICY_LEFTOVER[setting]] ?? null;
    if (sizeId !== null) return layeredValue(sizeId, { policyId: sizeId }, "size");
    const productPolicy = ownValues?.[setting]?.id ?? null;
    if (productPolicy !== null) return layeredValue(productPolicy, { policyId: productPolicy }, "product");
    const categoryPolicy = categoryValues?.[setting]?.id ?? null;
    if (categoryPolicy !== null) return layeredValue(categoryPolicy, { policyId: categoryPolicy }, "category", categoryName);
    const storePolicy = selection[POLICY_DEFAULT[setting]] ?? null;
    return storePolicy ? layeredValue(storePolicy, { policyId: storePolicy }, "store_default") : layeredValue("", { policyId: null }, "none");
  };
  const ebayCategory = (): LayeredSizeValues["ebayCategory"] => {
    const set = ownValues?.ebayCategory ?? null;
    const fromCategory = categoryValues?.ebayCategory ?? null;
    const [chosen, source] = set ? [set, "product" as const] : fromCategory ? [fromCategory, "category" as const]
      : storeCategory ? [storeCategory, "store_default" as const] : [CARD_SHELLZ_CATEGORY, "catalog" as const];
    return layeredValue(chosen.categoryId, { categoryId: chosen.categoryId, categoryName: chosen.categoryName }, source,
      source === "category" ? categoryName : null);
  };
  const shelf = (leftover: SizeLeftoverLayer): LayeredSizeValues["storeShelf"] => {
    const names = (value: { mode: "none" } | { mode: "own"; shelves: Array<{ name: string }> }) =>
      value.mode === "none" ? [] : value.shelves.map((entry) => entry.name);
    const [chosen, source]: [string[], ListingSettingsValueSource] = leftover.shelfNames ? [[...leftover.shelfNames], "size"]
      : ownValues?.storeShelf ? [names(ownValues.storeShelf), "product"]
        : categoryValues?.storeShelf ? [names(categoryValues.storeShelf), "category"]
          // Today's stub reads no store shelf default here (PR 7's fixture); kept, so no journey's shelf row moves.
          : [[], "none"];
    return layeredValue(JSON.stringify(chosen), { names: chosen }, source, source === "category" ? categoryName : null);
  };
  const templatePart = (setting: "textAbove" | "textBelow", storeText: string) => {
    const text = (value: ListingSettingTemplateText) => (value.mode === "own" ? value.text : "");
    if (ownValues?.[setting]) return { text: text(ownValues[setting]), source: "product" as const };
    if (categoryValues?.[setting]) return { text: text(categoryValues[setting]), source: "category" as const };
    return storeHasText ? { text: storeText, source: "store_default" as const } : { text: storeText, source: "none" as const };
  };
  const descriptionTemplate = (): LayeredSizeValues["descriptionTemplate"] => {
    const above = templatePart("textAbove", template?.introduction ?? "");
    const below = templatePart("textBelow", template?.footer ?? "");
    const source = TEMPLATE_PART_SOURCES.find((entry) => entry === above.source || entry === below.source) ?? "none";
    return layeredValue(JSON.stringify([above.text, below.text]),
      { hasIntroduction: above.text !== "", hasFooter: below.text !== "", groupConflict: false }, source,
      source === "category" ? categoryName : null);
  };

  const sizes = product.sizes.map((size): LayeredSize => {
    const leftover = sizeLeftoverOf(state, storeConnectionId, size.productVariantId);
    // A size's own text, else the product's, else the Card Shellz text; equal texts are one value.
    const productText = leftover.mainText === undefined ? ownValues?.mainText ?? null : null;
    const mainText: LayeredSizeValues["mainText"] = leftover.mainText !== undefined
      ? layeredValue(`text:${leftover.mainText}`, { own: true }, "size")
      : productText !== null ? layeredValue(`text:${productText.text}`, { own: true }, "product")
        : layeredValue("catalog", { own: false }, "catalog");
    return {
      size,
      values: {
        shippingPolicy: policy("shippingPolicy", leftover),
        returnPolicy: policy("returnPolicy", leftover),
        paymentPolicy: policy("paymentPolicy", leftover),
        ebayCategory: ebayCategory(),
        storeShelf: shelf(leftover),
        descriptionTemplate: descriptionTemplate(),
        mainText,
      },
      ownTextNeedsCheck: productText !== null && productText.catalogHash !== STUB_PRODUCT_CATALOG_HASH,
    };
  });
  return { product, own, category, price: layeredPrice(state, storeConnectionId, product, own, category), sizes };
}

/** The product's own price, else its category's, else the store's recipe (resolvePricingRule's levels). */
function layeredPrice(state: StubState, storeConnectionId: number, product: ProductFixture,
  own: ProductSettingsLayer | null, category: LayeredProduct["category"]): LayeredPrice | null {
  if (own?.values.price) return { recipe: own.values.price, kind: "product", name: product.productName.trim() ? product.productName : PRODUCT_PRICE_RULE_NAME };
  if (category?.layer?.values.price) return { recipe: category.layer.values.price, kind: "category", name: category.name };
  const recipe = storeRecipe(state, storeConnectionId);
  return recipe === null ? null : { recipe, kind: "store_default", name: STORE_DEFAULT_RULE_NAME };
}

function priceOf(state: StubState, storeConnectionId: number, product: ProductFixture): LayeredPrice | null {
  return layeredPrice(state, storeConnectionId, product, productLayerOf(state, storeConnectionId, product.productId),
    categoryOf(state, storeConnectionId, product));
}

/** The closest source first, as the facts order a value's sources. */
const SOURCE_ORDER: ReadonlyMap<ListingSettingsValueSource, number> = new Map(LISTING_SETTINGS_VALUE_SOURCES.map((source, index) => [source, index]));

/**
 * A setting's distinct values among the sizes, the most used first (ties in size order), each
 * with its sizes grouped by where they get it, closest first (the facts' settingValues).
 */
function settingEntries<K extends ListingSettingsSettingKey>(sizes: readonly LayeredSize[], key: K): ListingSettingsProductSettings[K] {
  const byKey = new Map<string, { value: SettingValue<K>; firstIndex: number; count: number;
    sources: Map<string, { source: ListingSettingsValueSource; ruleName: string | null; productVariantIds: number[] }> }>();
  sizes.forEach((entry, index) => {
    const value = entry.values[key] as LayeredValue<SettingValue<K>>;
    let option = byKey.get(value.key);
    if (!option) {
      option = { value: value.value, firstIndex: index, count: 0, sources: new Map() };
      byKey.set(value.key, option);
    }
    option.count += 1;
    const sourceId = JSON.stringify([value.source, value.ruleName]);
    const from = option.sources.get(sourceId) ?? { source: value.source, ruleName: value.ruleName, productVariantIds: [] };
    from.productVariantIds.push(entry.size.productVariantId);
    option.sources.set(sourceId, from);
  });
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex)
    .map((option) => ({ value: option.value, sources: [...option.sources.values()].sort((a, b) =>
      (SOURCE_ORDER.get(a.source) ?? 0) - (SOURCE_ORDER.get(b.source) ?? 0) || (a.ruleName ?? "").localeCompare(b.ruleName ?? "")) })) as ListingSettingsProductSettings[K];
}

const OWN_VALUE_SOURCES: ReadonlySet<ListingSettingsValueSource> = new Set<ListingSettingsValueSource>(["size", "product"]);

// ---------------------------------------------------------------------------
// Prices, as the server works them out (with the layers' recipes)
// ---------------------------------------------------------------------------

function basisCentsFor(recipe: PricingRecipe, size: SizeFixture): number | null {
  return pricingBasisCents(recipe.basis, { productCostCents: size.costCents, catalogRetailCents: size.retailCents });
}

/** What the store's rules give a size: its price, or why there is none; null when the store has no rules. */
function rulePriceFor(recipe: PricingRecipe | null, size: SizeFixture) {
  return recipe === null ? null : calculateRulePrice(recipe, basisCentsFor(recipe, size));
}

/** One size's price fact (`listingSettingsSizePriceSchema`), from its saved setting and the recipe that prices it by rule. */
export function sizePriceFact(state: StubState, storeConnectionId: number, product: ProductFixture, size: SizeFixture): ListingSettingsSizePrice {
  const saved = state.sizePrices[sizeKey(storeConnectionId, size.productVariantId)] ?? null;
  const layered = priceOf(state, storeConnectionId, product);
  const recipe = layered?.recipe ?? null;
  const rule = rulePriceFor(recipe, size);
  const ruleOwned = (priceCents: number) => ({
    priceCents, source: "rules" as const, issue: null,
    rule: { kind: (layered as LayeredPrice).kind, name: (layered as LayeredPrice).name, recipe: recipe as PricingRecipe },
    basis: (recipe as PricingRecipe).basis, basisAmountCents: basisCentsFor(recipe as PricingRecipe, size),
  });
  const noRule = { rule: null, basis: null, basisAmountCents: null };
  let facts: Pick<ListingSettingsSizePrice, "priceCents" | "source" | "issue" | "rule" | "basis" | "basisAmountCents">;
  if (saved?.pricingMode === "fixed") {
    facts = { priceCents: saved.overridePriceCents, source: "exact", issue: null, ...noRule };
  } else if (saved?.pricingMode === "inherit") {
    // A3 and L1: the rule price while the rules give one, otherwise the retail price, never the last published one.
    if (rule?.priceCents != null) facts = ruleOwned(rule.priceCents);
    else if (size.retailCents !== null) facts = { priceCents: size.retailCents, source: "retail_fallback", issue: rule ? rule.issue as ListingSettingsSizePrice["issue"] : null, ...noRule };
    else facts = { priceCents: null, source: "none", issue: rule ? rule.issue as ListingSettingsSizePrice["issue"] : "price_unavailable", ...noRule };
  } else if (recipe !== null && rule !== null) {
    facts = rule.priceCents !== null ? ruleOwned(rule.priceCents)
      : { priceCents: null, source: "none", issue: rule.issue as ListingSettingsSizePrice["issue"], rule: null, basis: recipe.basis, basisAmountCents: null };
  } else if (saved?.pricingMode === "rules") {
    facts = { priceCents: null, source: "none", issue: "pricing_rules_not_configured", ...noRule };
  } else {
    facts = size.retailCents !== null ? { priceCents: size.retailCents, source: "catalog_price", issue: null, ...noRule }
      : { priceCents: null, source: "none", issue: "price_unavailable", ...noRule };
  }
  const belowCost = facts.priceCents !== null && size.costCents !== null && facts.priceCents < size.costCents
    ? size.costCents - facts.priceCents : null;
  return {
    productVariantId: size.productVariantId, productId: product.productId, productName: product.productName, sizeName: size.sizeName,
    sku: size.sku, ...facts, costCents: size.costCents, belowCostByCents: belowCost, limits: [], pausedSince: null,
    settingRevisionId: saved?.revisionId ?? null,
  };
}

/** One size's own price read (W9 `GET …/variants/:id/price`), as the route projects it. */
export function sizePriceSetting(state: StubState, storeConnectionId: number, size: SizeFixture): ListingPriceSetting {
  const saved = state.sizePrices[sizeKey(storeConnectionId, size.productVariantId)] ?? null;
  const product = findProductOf(state, size.productVariantId);
  const layered = product === null ? null : priceOf(state, storeConnectionId, product);
  const recipe = layered?.recipe ?? null;
  const rule = rulePriceFor(recipe, size);
  const mode: ListingPricingMode = saved?.pricingMode ?? (recipe ? "rules" : "catalog_default");
  let effective: number | null;
  let source: ListingPriceSetting["source"];
  if (mode === "fixed") {
    effective = saved?.overridePriceCents ?? null;
    source = "override";
  } else if (mode === "rules" || (mode === "inherit" && rule?.priceCents != null)) {
    effective = rule?.priceCents ?? null;
    source = effective === null ? "unavailable" : "rules";
  } else {
    effective = size.retailCents;
    source = effective === null ? "unavailable" : "catalog_default";
  }
  // A product's or a category's own price is named by its level, as resolvePricingRule names it.
  const ruleName = layered === null ? null : layered.kind === "product" ? PRODUCT_PRICE_RULE_NAME
    : layered.kind === "category" ? CATEGORY_PRICE_RULE_NAME : STORE_DEFAULT_RULE_NAME;
  return {
    storeConnectionId, productVariantId: size.productVariantId, revisionId: saved?.revisionId ?? null,
    overridePriceCents: mode === "fixed" ? saved?.overridePriceCents ?? null : null,
    effectivePriceCents: effective, defaultPriceCents: size.retailCents, source, pricingMode: mode,
    ruleName, pricingIssue: rule?.issue ?? null, rulePriceCents: rule?.priceCents ?? null,
    rulesConfigured: recipe !== null, ruleBasis: recipe?.basis ?? null, productCostCents: size.costCents,
    updatedAt: saved ? STAMP : null,
    ...(layered && layered.kind !== "store_default" ? { ruleLevel: layered.kind } : {}),
  };
}

/** A size's fixes, in the contract's order: it can't be priced, or it uses the product's own text, which needs a check. */
function sizeFixes(price: ListingSettingsSizePrice, size: LayeredSize): ListingSettingsFixCode[] {
  const fixes = new Set<ListingSettingsFixCode>();
  if (price.priceCents === null) fixes.add("size_cannot_be_priced");
  if (size.ownTextNeedsCheck) fixes.add("own_text_needs_check");
  return LISTING_SETTINGS_FIX_CODES.filter((code) => fixes.has(code));
}

function productFacts(state: StubState, storeConnectionId: number, product: ProductFixture) {
  const layered = layeredProduct(state, storeConnectionId, product);
  const prices = product.sizes.map((size) => sizePriceFact(state, storeConnectionId, product, size));
  const sizeFixList = layered.sizes.map((size, index) => sizeFixes(prices[index], size));
  const priced = prices.map((price) => price.priceCents).filter((cents): cents is number => cents !== null);
  const fixes = new Set(sizeFixList.flat());
  // Each field's settings, as the facts read them: own when a size or the product holds its own
  // value; sizes differ when the sizes' values are not all the same.
  const sizeValues = layered.sizes.map((size) => size.values);
  const row: Omit<ListingSettingsProductRow, "matchedSize"> = {
    productId: product.productId, productName: product.productName, category: product.category,
    sizesChosen: product.sizes.length, sizesTotal: product.sizesTotal ?? product.sizes.length,
    priceRange: priced.length === 0 ? null : { minCents: Math.min(...priced), maxCents: Math.max(...priced) },
    exactPriceCount: prices.filter((price) => price.source === "exact").length,
    ownSettings: LISTING_SETTINGS_FIELDS.filter((field) => LISTING_SETTINGS_FIELD_SETTINGS[field]
      .some((setting) => sizeValues.some((values) => OWN_VALUE_SOURCES.has(values[setting].source)))),
    sizesDiffer: LISTING_SETTINGS_FIELDS.filter((field) => LISTING_SETTINGS_FIELD_SETTINGS[field]
      .some((setting) => new Set(sizeValues.map((values) => values[setting].key)).size > 1)),
    fixes: LISTING_SETTINGS_FIX_CODES.filter((code) => fixes.has(code)),
  };
  return { prices, row, layered, sizeFixes: sizeFixList };
}

function textMatches(text: string | null, search: string): boolean {
  return text !== null && text.toLowerCase().includes(search);
}

function pageOf<T>(rows: T[], page: number): T[] {
  return rows.slice(page * LISTING_SETTINGS_PAGE_SIZE, (page + 1) * LISTING_SETTINGS_PAGE_SIZE);
}

/** The Products tab's answer: the catalog's products, searched, filtered and paged as the route does. */
export function listingSettingsProducts(state: StubState, storeConnectionId: number, query: URLSearchParams) {
  const page = Number(query.get("page") ?? 0);
  const search = (query.get("search") ?? "").trim().toLowerCase();
  const show = query.get("show") ?? "all";
  const rows: ListingSettingsProductRow[] = [];
  for (const product of state.catalog) {
    const { prices, row } = productFacts(state, storeConnectionId, product);
    const productMatches = search === "" || textMatches(product.productName, search) || textMatches(product.productSku, search);
    const size = productMatches ? null : product.sizes.find((entry) => textMatches(entry.sizeName, search) || textMatches(entry.sku, search));
    if (!productMatches && !size) continue;
    // `own_settings` and `sizes_differ` follow the layers only, as the live summary counts them (exact prices are not counted here).
    const listed = show === "all" || (show === "needs_fix" && row.fixes.length > 0) || (show === "exact_prices" && row.exactPriceCount > 0)
      || (show === "below_cost" && prices.some((price) => price.belowCostByCents !== null))
      || (show === "cannot_price" && prices.some((price) => price.priceCents === null))
      || (show === "own_settings" && row.ownSettings.length > 0) || (show === "sizes_differ" && row.sizesDiffer.length > 0);
    if (!listed) continue;
    rows.push({ ...row, matchedSize: size ? { productVariantId: size.productVariantId, sizeName: size.sizeName, sku: size.sku } : null });
  }
  return listingSettingsProductsResponseSchema.parse({ storeConnectionId, page, pageSize: LISTING_SETTINGS_PAGE_SIZE, total: rows.length,
    rows: pageOf(rows, page), generatedAt: STAMP });
}

/** The Prices tab's answer: every chosen size, searched, filtered and paged as the route does. */
export function listingSettingsPrices(state: StubState, storeConnectionId: number, query: URLSearchParams) {
  const page = Number(query.get("page") ?? 0);
  const search = (query.get("search") ?? "").trim().toLowerCase();
  const show = query.get("show") ?? "all";
  const rows: ListingSettingsSizePrice[] = [];
  for (const product of state.catalog) {
    const productMatches = search === "" || textMatches(product.productName, search) || textMatches(product.productSku, search);
    for (const size of product.sizes) {
      if (!productMatches && !textMatches(size.sizeName, search) && !textMatches(size.sku, search)) continue;
      const price = sizePriceFact(state, storeConnectionId, product, size);
      const listed = show === "all" || (show === "exact_prices" && price.source === "exact")
        || (show === "below_cost" && price.belowCostByCents !== null) || (show === "cannot_price" && price.priceCents === null)
        || (show === "paused" && price.pausedSince !== null) || (show === "retail_fallback" && price.source === "retail_fallback");
      if (listed) rows.push(price);
    }
  }
  return listingSettingsPricesResponseSchema.parse({ storeConnectionId, page, pageSize: LISTING_SETTINGS_PAGE_SIZE, total: rows.length,
    rows: pageOf(rows, page), generatedAt: STAMP });
}

/** One product's settings in full (the drawer), from the layers, or null when it is not chosen. */
export function listingSettingsProductDetail(state: StubState, storeConnectionId: number, productId: number): ListingSettingsProductDetail | null {
  const product = state.catalog.find((entry) => entry.productId === productId);
  if (!product) return null;
  const { prices, row, layered, sizeFixes: fixes } = productFacts(state, storeConnectionId, product);
  return listingSettingsProductDetailSchema.parse({
    storeConnectionId,
    product: row,
    settings: {
      shippingPolicy: settingEntries(layered.sizes, "shippingPolicy"),
      returnPolicy: settingEntries(layered.sizes, "returnPolicy"),
      paymentPolicy: settingEntries(layered.sizes, "paymentPolicy"),
      ebayCategory: settingEntries(layered.sizes, "ebayCategory"),
      storeShelf: settingEntries(layered.sizes, "storeShelf"),
      descriptionTemplate: settingEntries(layered.sizes, "descriptionTemplate"),
      mainText: settingEntries(layered.sizes, "mainText"),
    },
    sizes: product.sizes.map((size, index) => ({ price: prices[index], fixes: fixes[index], stockUnits: size.stockUnits })),
    stock: { state: "ok", checkedAt: STAMP },
    generatedAt: STAMP,
  });
}

/**
 * One product's own settings row (`GET …/products/:productId/own`, plan PR 10, 4.2) as the
 * server's productOwnSettingsView gives it: only the product layer's values, with their stored
 * names and texts and its revision; null when the product is not chosen. A main text needs a
 * check when it was saved with another hash than STUB_PRODUCT_CATALOG_HASH.
 */
export function listingSettingsProductOwn(state: StubState, storeConnectionId: number, productId: number): ListingSettingsProductOwnSettings | null {
  const layered = layeredSettings(state, storeConnectionId, productId);
  if (layered === null) return null;
  const values = layered.own?.values ?? null;
  return listingSettingsProductOwnSettingsSchema.parse({
    storeConnectionId, productId, revisionId: layered.own?.revisionId ?? null,
    own: {
      price: values?.price ?? null,
      ebayCategory: values?.ebayCategory ? { categoryId: values.ebayCategory.categoryId, categoryName: values.ebayCategory.categoryName } : null,
      storeShelf: values?.storeShelf ?? null,
      shippingPolicy: values?.shippingPolicy ?? null,
      returnPolicy: values?.returnPolicy ?? null,
      paymentPolicy: values?.paymentPolicy ?? null,
      textAbove: values?.textAbove ?? null,
      textBelow: values?.textBelow ?? null,
      mainText: values?.mainText ? { text: values.mainText.text, needsCheck: values.mainText.catalogHash !== STUB_PRODUCT_CATALOG_HASH } : null,
    },
    generatedAt: STAMP,
  });
}

/** Per-product attention lines, in the order the facts name a product's problems (PRODUCT_ATTENTION_FIXES). */
const PRODUCT_ATTENTION_FIXES = ["no_ebay_category", "size_cannot_be_priced", "description_group_conflict"] as const;

/**
 * The summary as the server works it out from what the stub holds (`liveSummary`), in the
 * order and with the counts `buildListingSettingsSummary` gives (dropship-listing-settings-facts.ts):
 * the shared listing access decision, then missing policies, then own text to check, then each
 * product's first fix. `productsWithOwnSettings` counts the layers' own values only (exact prices
 * are not counted, as before the layers).
 */
export function liveListingSettingsSummary(state: StubState, storeConnectionId: number): ListingSettingsSummary {
  const setup = setupOf(state, storeConnectionId);
  const policy = (policyId: string | null | undefined) => ({ policyId: policyId ?? null, verification: "not_checked" as const });
  const rules = state.pricingRules[storeConnectionId]?.profile ?? null;
  const categoryProfile = state.categoryRules[storeConnectionId]?.profile ?? null;
  const contentProfile = state.contentProfiles[storeConnectionId]?.profile ?? null;
  const storeStatus = state.storeStatuses[storeConnectionId] ?? "connected";
  const products = state.catalog.map((product) => productFacts(state, storeConnectionId, product));
  const prices = products.flatMap((product) => product.prices);
  const needingFix = products.filter((product) => product.row.fixes.length > 0);
  const policyIds = [setup.selection.fulfillmentPolicyId, setup.selection.returnPolicyId, setup.selection.paymentPolicyId];
  const missingPolicy = !policyIds[0] ? "shipping" as const : !policyIds[1] ? "return" as const : !policyIds[2] ? "payment" as const : null;
  const access = decideDropshipListingAccess({ action: "preview", vendorStatus: state.vendor.status,
    entitlementStatus: state.vendor.entitlementStatus, store: { status: storeStatus, launchReady: true } });
  const reconnect = !access.allowed && access.resolution === "reconnect_store";
  const items: ListingSettingsSummary["attention"]["items"] = [];
  if (reconnect) items.push({ code: "reconnect_store", count: 1, productId: null, productName: null });
  const missingCount = policyIds.filter((id) => !id).length;
  if (missingCount > 0) items.push({ code: "choose_store_policies", count: missingCount, productId: null, productName: null });
  const ownText = products.filter((product) => product.row.fixes.includes("own_text_needs_check")).length;
  if (ownText > 0) items.push({ code: "own_text_needs_check", count: ownText, productId: null, productName: null });
  for (const product of products) {
    const code = PRODUCT_ATTENTION_FIXES.find((fix) => product.row.fixes.includes(fix));
    if (!code) continue;
    items.push({ code, count: product.sizeFixes.filter((fixes) => fixes.includes(code)).length,
      productId: product.row.productId, productName: product.row.productName });
  }
  const railState = state.tooLarge ? "too_many_sizes" : reconnect ? "reconnect_store"
    : missingPolicy !== null ? "choose_policy" : needingFix.length > 0 ? "products_need_fix" : "all_set";
  return listingSettingsSummarySchema.parse({
    storeConnectionId, storeStatus, access,
    catalog: state.tooLarge ? { state: "too_large", limit: 10_000 }
      : { state: "ok", products: state.catalog.length, sizes: prices.length },
    storeDefaults: {
      price: { recipe: rules?.defaultRecipe ?? null, groupRules: rules?.groups.length ?? 0 },
      shippingPolicy: policy(setup.selection.fulfillmentPolicyId), returnPolicy: policy(setup.selection.returnPolicyId),
      paymentPolicy: policy(setup.selection.paymentPolicyId),
      ebayCategory: { category: categoryProfile?.defaultCategory
        ? { categoryId: categoryProfile.defaultCategory.categoryId, categoryName: categoryProfile.defaultCategory.categoryName } : null,
      groupRules: categoryProfile?.rules.length ?? 0 },
      description: { hasIntroduction: (contentProfile?.defaultTemplate.introduction ?? "") !== "",
        hasFooter: (contentProfile?.defaultTemplate.footer ?? "") !== "", groupRules: contentProfile?.groups.length ?? 0 },
    },
    counts: state.tooLarge ? null : {
      productsNeedingFix: needingFix.length,
      productsWithSizesDiffer: products.filter((product) => product.row.sizesDiffer.length > 0).length,
      productsWithOwnSettings: products.filter((product) => product.row.ownSettings.length > 0).length,
      exactPrices: prices.filter((price) => price.source === "exact").length,
      belowCost: prices.filter((price) => price.belowCostByCents !== null).length,
      cannotPrice: prices.filter((price) => price.priceCents === null).length, paused: 0,
    },
    attention: { items: items.slice(0, 3), total: items.length },
    rail: { state: railState, productsNeedingFix: needingFix.length, missingPolicy },
    generatedAt: STAMP,
  });
}

// ---------------------------------------------------------------------------
// The price check (W1) as the review route builds it
// ---------------------------------------------------------------------------

function reviewIdFor(count: number): string {
  return `00000000-0000-4000-8000-${String(count).padStart(12, "0")}`;
}

function buildReview(state: StubState, storeConnectionId: number, input: ReviewPricingRulesInput, count: number): PricingReviewResponse {
  // A size a product's or category's own price prices keeps it through a store price change; this check
  // does not model that yet (PR 10d, 10f), so a journey that needs it fails here instead of being answered wrong.
  if (state.catalog.some((product) => {
    const kind = priceOf(state, storeConnectionId, product)?.kind;
    return kind === "product" || kind === "category";
  })) {
    throw new Error("The stub's W1 price check does not price products or categories that have their own price.");
  }
  const recipe = input.profile.defaultRecipe;
  const rows: PricingImpactRow[] = [];
  for (const product of state.catalog) {
    for (const size of product.sizes) {
      const now = sizePriceFact(state, storeConnectionId, product, size);
      const preserved = !input.releaseFixedOverrides && now.source === "exact";
      const basisCents = basisCentsFor(recipe, size);
      const next = preserved ? null : calculateRulePrice(recipe, basisCents);
      const priceCents = preserved ? now.priceCents : next?.priceCents ?? null;
      rows.push({
        productVariantId: size.productVariantId, title: product.productName, sku: size.sku,
        previousPriceCents: now.priceCents, priceCents, productCostCents: size.costCents,
        ruleName: preserved ? null : STORE_DEFAULT_RULE_NAME, preserved, issues: next?.issue ? [next.issue] : [],
        settingRevisionId: now.settingRevisionId, evidenceHash: EVIDENCE_HASH, sizeName: size.sizeName,
        basis: preserved ? null : recipe.basis, basisCents: preserved ? null : basisCents,
        warnings: priceCents !== null && size.costCents !== null && priceCents < size.costCents ? ["price_below_product_cost"] : [],
      });
    }
  }
  return pricingReviewResponseSchema.parse({
    reviewId: reviewIdFor(count), reviewHash: String(count % 10).repeat(64), createdAt: STAMP, page: 0,
    summary: { total: rows.length, changed: rows.filter((row) => !row.preserved && row.priceCents !== row.previousPriceCents).length,
      preserved: rows.filter((row) => row.preserved).length, blocked: rows.filter((row) => !row.preserved && row.priceCents === null).length },
    rows,
  });
}

function reviewPage(review: PricingReviewResponse, page: number): PricingReviewResponse {
  return { ...review, page, rows: review.rows.slice(page * PRICING_REVIEW_PAGE_SIZE, (page + 1) * PRICING_REVIEW_PAGE_SIZE) };
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

function fulfillError(route: Route, answer: ScriptedError) {
  return route.fulfill({ status: answer.status, json: { error: { code: answer.code, message: answer.message,
    ...(answer.context ? { context: answer.context } : {}) } } });
}

/** A request body the shared contract refuses: recorded as unexpected and answered 400, as the route would. */
function refuseBody(state: StubState, route: Route, method: string, path: string, issues: string) {
  state.unexpected.push(`${method} ${path} (body off contract: ${issues})`);
  return route.fulfill({ status: 400, json: { error: { code: "STUB_INVALID_INPUT", message: "The request body is not what the route takes." } } });
}

/** How a keyed writer words its answer: first save or replay. PR 7's writers carry `idempotentReplay`. */
type KeyedAnswerShape = (json: Record<string, unknown>, replayed: boolean) => Record<string, unknown>;
const WITH_REPLAY_FLAG: KeyedAnswerShape = (json, replayed) => ({ ...json, idempotentReplay: replayed });

/**
 * A keyed write (W1 apply, W3, W4, W5, W9): the same key with the same body is answered from the
 * first save as a replay; the same key with another body is refused, as the routes do. `shape`
 * words the answer (W5's contract says a replay with its `outcome`, not a flag).
 */
async function keyedWrite(state: StubState, route: Route, key: string, body: Record<string, unknown>,
  answers: WriteAnswer[], save: () => Promise<Record<string, unknown> | ScriptedError> | Record<string, unknown> | ScriptedError,
  shape: KeyedAnswerShape = WITH_REPLAY_FLAG) {
  const sent = JSON.stringify(body);
  const earlier = state.keyedAnswers[key];
  if (earlier) {
    if (earlier.body !== sent) {
      return fulfillError(route, { status: 409, code: "DROPSHIP_IDEMPOTENCY_CONFLICT", message: "This request key was used for another request." });
    }
    return route.fulfill({ json: shape(earlier.json, true) });
  }
  const answer = answers.shift();
  if (answer && answer !== "drop") return fulfillError(route, answer);
  const saved = await save();
  if ("status" in saved && "code" in saved) return fulfillError(route, saved as ScriptedError);
  const json = saved as Record<string, unknown>;
  state.keyedAnswers[key] = { body: sent, json };
  // The save reached the server, but its answer never came back.
  if (answer === "drop") return route.abort("connectionreset");
  return route.fulfill({ json: shape(json, false) });
}

// ---------------------------------------------------------------------------
// W5: one product's own settings (plan PR 10, 4.6, 4.9)
// ---------------------------------------------------------------------------

/** The policy fields 10a's drawer saves; the W5 stub refuses any other (10b adds the rest). */
const PRODUCT_POLICY_FIELDS = ["shippingPolicy", "returnPolicy", "paymentPolicy"] as const;
type ProductPolicyField = (typeof PRODUCT_POLICY_FIELDS)[number];
const POLICY_OPTIONS = { shippingPolicy: "fulfillmentPolicies", returnPolicy: "returnPolicies", paymentPolicy: "paymentPolicies" } as const;
/** No value of its own on any field: a product with no row reads this way. */
const NO_PRODUCT_VALUES: ProductListingSettingValues = {
  price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
  textAbove: null, textBelow: null, mainText: null,
};

/**
 * W5 as dropship-listing-product-settings-service.ts saves it, for the policy fields 10a sends:
 * compare-and-set on the product's settings revision (8a's 409), a new eBay policy named from
 * eBay's list (the setup answer), refused while eBay needs a sign-in (D4) or when eBay doesn't
 * list it; null sets the field back to the default. Any field saved clears that field's
 * leftovers on the product's sizes (`clearedSizeCount`). Nothing changed is `unchanged`.
 */
function saveProductSettings(state: StubState, storeConnectionId: number, product: ProductFixture,
  input: { expectedRevisionId: number | null; patch: Partial<Record<ProductPolicyField, { id: string } | null>> }): Record<string, unknown> | ScriptedError {
  const key = productKey(storeConnectionId, product.productId);
  const current = productLayerOf(state, storeConnectionId, product.productId);
  if (input.expectedRevisionId !== (current?.revisionId ?? null)) {
    return { status: 409, code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
      message: "Listing settings changed after you opened them. Reload them before saving again.",
      context: { storeConnectionId, conflicts: [{ productId: product.productId, expectedRevisionId: input.expectedRevisionId,
        actualRevisionId: current?.revisionId ?? null }], conflictCount: 1, retryable: false, classification: "permanent" } };
  }
  const values: ProductListingSettingValues = { ...(current?.values ?? NO_PRODUCT_VALUES) };
  const setup = setupOf(state, storeConnectionId);
  const fields = PRODUCT_POLICY_FIELDS.filter((field) => input.patch[field] !== undefined);
  // An id the product's own row doesn't hold already asks eBay, which a sign-in stops (D4, P13).
  const asksEbay = fields.filter((field) => {
    const sent = input.patch[field];
    return sent !== null && sent !== undefined && values[field]?.id !== sent.id;
  });
  if (asksEbay.length > 0 && state.setupReadError !== null) {
    return { status: 403, code: "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED",
      message: "Sign in to eBay again to choose new eBay values. Settings that keep their saved eBay values can still be saved.",
      context: { storeConnectionId, fields: asksEbay } };
  }
  for (const field of fields) {
    const sent = input.patch[field];
    if (sent === null || sent === undefined) {
      values[field] = null;
      continue;
    }
    const listed = (setup.options[POLICY_OPTIONS[field]] as Array<{ id: string; name: string }>).find((option) => option.id === sent.id);
    if (!listed) {
      if (values[field]?.id === sent.id) continue;
      return { status: 422, code: "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID", message: "That policy is not one of the store's eBay policies.",
        context: { storeConnectionId, retryable: false, classification: "permanent", invalidFields: [field] } };
    }
    values[field] = { id: listed.id, name: listed.name };
  }
  // Saving a field clears what today's per-size panels left on this product's sizes for it.
  let clearedSizeCount = 0;
  for (const size of product.sizes) {
    const sizeId = sizeKey(storeConnectionId, size.productVariantId);
    const leftover = state.sizeLeftovers[sizeId];
    if (!leftover) continue;
    const kept = { ...leftover };
    for (const field of fields) delete kept[POLICY_LEFTOVER[field]];
    if (Object.keys(kept).length !== Object.keys(leftover).length) {
      clearedSizeCount += 1;
      state.sizeLeftovers[sizeId] = kept;
    }
  }
  const changed = JSON.stringify(values) !== JSON.stringify(current?.values ?? NO_PRODUCT_VALUES);
  let revisionId = current?.revisionId ?? null;
  if (changed) {
    revisionId = state.nextRevision++;
    state.productSettings[key] = productSettingsLayerSchema.parse({ revisionId, values });
  }
  return saveProductSettingsResponseSchema.parse({
    outcome: changed || clearedSizeCount > 0 ? "changed" : "unchanged", productId: product.productId, revisionId, sizes: [], clearedSizeCount,
  });
}

/** A W5 replay says so in its `outcome`, with no clean-up count (saveProductSettingsResponseSchema). */
const PRODUCT_SETTINGS_ANSWER: KeyedAnswerShape = (json, replayed) =>
  saveProductSettingsResponseSchema.parse(replayed ? { ...json, outcome: "replayed", clearedSizeCount: null } : json);

function findSize(state: StubState, productVariantId: number): SizeFixture | null {
  return findProductOf(state, productVariantId)?.sizes.find((entry) => entry.productVariantId === productVariantId) ?? null;
}

function findProductOf(state: StubState, productVariantId: number): ProductFixture | null {
  return state.catalog.find((product) => product.sizes.some((entry) => entry.productVariantId === productVariantId)) ?? null;
}

function shelfName(state: StubState, storeConnectionId: number, id: string): string {
  return (state.storeShelves[storeConnectionId] ?? []).find((shelf) => shelf.categoryId === id)?.path ?? id;
}

/** What the stub holds before a journey changes it: one eBay store, product 11 chosen, nothing else saved. */
export const defaultStubState = (): StubState => ({
  stores: [MARZ], selected: true, previewCalls: 0, setupReads: [], summaryReads: [], productsReads: [], reads: [],
  vendor: { status: "active", entitlementStatus: "active" }, summaries: {}, liveSummary: false, storeStatuses: {}, tooLarge: false,
  summaryFailures: 0, listingSetups: {}, setupReadFailures: 0, setupReadError: null, pricingRules: {}, setupWrites: [],
  setupWriteAnswers: [], catalog: [ENVELOPE], sizePrices: {}, productSettings: {}, categorySettings: {}, sizeLeftovers: {},
  storeShelves: {}, storeShelvesError: null, categoryRules: {},
  contentProfiles: {}, pricingReviews: [], pricingReviewAnswers: [], pricingApplies: [], pricingApplyAnswers: [],
  categoryWrites: [], categoryWriteAnswers: [], categorySearches: [], contentWrites: [], contentWriteAnswers: [],
  priceWrites: [], priceWriteAnswers: [], productSettingsWrites: [], productSettingsWriteAnswers: [],
  reviews: {}, keyedAnswers: {}, nextRevision: 40, unexpected: [], errors: [],
});

/**
 * Opens the real Catalog page at `path` against the stub server, with `initial` over the
 * defaults. Returns the state the stub reads and writes, so a journey can change what the
 * server holds between steps and check what the page sent.
 */
export async function openCatalog(page: Page, path: string, initial: Partial<StubState> = {}) {
  const state: StubState = { ...defaultStubState(), ...initial };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    try {
      await answerApi(state, route);
    } catch (error) {
      // A fixture the contract refuses: the journey fails on `errors` with the schema's words.
      state.errors.push(`stub: ${error instanceof Error ? error.message : String(error)}`);
      // The error is kept above; if the request was answered or its page closed before it was
      // thrown, there is nothing left to answer, and that second error says nothing new.
      await route.fulfill({ status: 500, json: { error: { message: "The stub could not answer." } } })
        .catch((answerError: unknown) => state.errors.push(`stub: ${answerError instanceof Error ? answerError.message : String(answerError)}`));
    }
  });
  await page.route(`**${CATALOG_PATH}**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><div id="root"></div>
    <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-catalog-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto(path);
  return state;
}

/** What a part of the router returns for a request that is not its own. */
const NOT_MINE = Symbol("not mine");

async function answerApi(state: StubState, route: Route) {
  const url = new URL(route.request().url());
  const method = route.request().method();
  const path = url.pathname;
  state.reads.push({ method, path, search: url.search });
  const storePath = /^\/api\/dropship\/(?:ebay\/(?:listing-setup|store-categories|listing-policy-overrides)|listings\/stores)\/(\d+)(\/.*)?$/.exec(path);
  const storeId = storePath ? Number(storePath[1]) : null;
  const listings = storeId === null ? null : `/api/dropship/listings/stores/${storeId}`;
  if (path === "/api/dropship/auth/me") {
    return route.fulfill({ json: { principal: { authIdentityId: 1, memberId: MEMBER_ID, cardShellzEmail: "vendor@example.com", hasPasskey: false,
      authMethod: "password", entitlementStatus: "active", authenticatedAt: STAMP }, sensitiveProofs: {} } });
  }
  if (path === "/api/dropship/onboarding/state" && method === "GET") return route.fulfill({ json: onboardingJson(state.vendor) });
  if (path === "/api/dropship/settings" && method === "GET") return route.fulfill({ json: settingsJson(state) });
  if (path === "/api/dropship/catalog" && method === "GET") {
    const selectedOnly = url.searchParams.get("selectedOnly") === "true";
    const row = { ...ROW, selectionDecision: { ...ROW.selectionDecision, selected: state.selected, reason: state.selected ? "selected" : "not_selected" } };
    const rows = selectedOnly && !state.selected ? [] : [row];
    return route.fulfill({ json: { rows, total: rows.length, page: 1, limit: Number(url.searchParams.get("limit") ?? 50),
      facets: { categories: [], productLines: [], products: [] } } });
  }
  if (path === "/api/dropship/catalog/selection-rules" && method === "GET") {
    return route.fulfill({ json: { rules: state.selected
      ? [{ id: 1, scopeType: "variant", action: "include", productVariantId: 101, isActive: true }] : [] } });
  }
  if (storeId !== null && ((method === "PUT" && path === `/api/dropship/ebay/listing-setup/${storeId}`)
    || (method === "POST" && path === `/api/dropship/ebay/listing-setup/${storeId}/ship-from/repair`))) {
    return answerSetupWrite(state, route, storeId, method, path);
  }
  if (listings !== null && storeId !== null) {
    if (await answerListingWrite(state, route, storeId, listings, method, path, url) !== NOT_MINE) return;
  }
  if (storeId !== null && method === "GET" && state.stores.some((store) => store.storeConnectionId === storeId && store.platform === "ebay")) {
    if (await answerStoreRead(state, route, storeId, path, url) !== NOT_MINE) return;
  }
  if (path === "/api/dropship/listings/preview" && method === "POST") {
    state.previewCalls += 1;
    const storeConnectionId = (route.request().postDataJSON() as { storeConnectionId: number }).storeConnectionId;
    return route.fulfill({ json: { preview: { vendorId: 1, storeConnectionId, platform: "ebay", generatedAt: STAMP,
      rows: [previewRow(storeConnectionId)], summary: { total: 1, ready: 1, blocked: 0, warning: 0 } } } });
  }
  state.unexpected.push(`${method} ${path}`);
  return route.fulfill({ status: 500, json: { error: { message: "Unexpected request" } } });
}

/** W2 (`PUT …/listing-setup/:id`) and W10 (`POST …/ship-from/repair`). */
function answerSetupWrite(state: StubState, route: Route, storeId: number, method: string, path: string) {
  const body = route.request().postDataJSON() as Record<string, unknown>;
  state.setupWrites.push({ method, path, body });
  const answer = state.setupWriteAnswers.shift();
  // The save reached the server but its answer never came back.
  if (answer === "drop") return route.abort("connectionreset");
  if (answer && "status" in answer) return fulfillError(route, answer);
  const current = setupOf(state, storeId);
  // Compare-and-set, as the server does (migration 0728): a write against an older revision
  // changes nothing and is refused (dropship-listing-config.repository.ts revisionConflict).
  if (body.expectedRevision !== current.revision) {
    return route.fulfill({ status: 409, json: { error: { code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
      message: "These store settings changed after they were loaded. Load the latest settings and save again.",
      context: { storeConnectionId: storeId, expectedRevision: body.expectedRevision, currentRevision: current.revision,
        retryable: false } } } });
  }
  // A save changes only what it sends; the server keeps the rest.
  const sent = Object.fromEntries(POLICY_FIELDS.filter((field) => typeof body[field] === "string").map((field) => [field, body[field]]));
  const shelfDefault = body.storeShelfDefault as { ids: string[] } | null | undefined;
  const shelves = shelfDefault === undefined ? {}
    : { storeShelfDefault: shelfDefault === null ? null : { ids: shelfDefault.ids, names: shelfDefault.ids.map((id) => shelfName(state, storeId, id)) } };
  // The repair fixes only where items ship from; anything else the setup still lacks (a saved
  // policy eBay no longer lists, say) is still named missing.
  const stillMissing = current.missingFields.filter((field) => field !== "merchantLocationKey");
  const saved = method === "PUT"
    ? { ...current, ...shelves, revision: current.revision + 1, selection: { ...current.selection, ...sent } }
    : { ...current, revision: current.revision + 1, complete: stillMissing.length === 0, missingFields: stillMissing,
      selection: { ...current.selection, merchantLocationKey: "managed" } };
  state.listingSetups[storeId] = saved;
  const answered = method === "PUT" && body.fulfillmentPolicyId === undefined ? withShippingNotChecked(saved) : saved;
  return route.fulfill({ json: { ...answered, outcome: answer && "outcome" in answer ? answer.outcome : "changed" } });
}

/** W1 (price check and save), W3, W4, W5 and W9: NOT_MINE when the request is none of them. */
async function answerListingWrite(state: StubState, route: Route, storeId: number, listings: string, method: string, path: string, url: URL) {
  const json = () => route.request().postDataJSON() as Record<string, unknown>;
  if (method === "POST" && path === `${listings}/pricing-rules/reviews`) {
    const body = json();
    state.pricingReviews.push({ method, path, body });
    const parsed = reviewPricingRulesInputSchema.safeParse(body);
    if (!parsed.success) return refuseBody(state, route, method, path, parsed.error.message);
    const answer = state.pricingReviewAnswers.shift();
    if (answer === "drop") return route.abort("connectionreset");
    if (answer) return fulfillError(route, answer);
    const saved = state.pricingRules[storeId] ?? NO_RULES_STATE;
    if (parsed.data.expectedRevisionId !== saved.revisionId) {
      return fulfillError(route, { status: 409, code: "DROPSHIP_PRICING_REVIEW_STALE", message: "The pricing rules changed. Review them again." });
    }
    const review = buildReview(state, storeId, parsed.data, state.pricingReviews.length);
    state.reviews[review.reviewId] = { storeConnectionId: storeId, input: parsed.data, review };
    return route.fulfill({ json: reviewPage(review, 0) });
  }
  const reviewRead = /\/pricing-rules\/reviews\/([^/]+)$/.exec(path);
  if (method === "GET" && reviewRead && path.startsWith(listings)) {
    const held = state.reviews[decodeURIComponent(reviewRead[1])];
    if (!held || held.storeConnectionId !== storeId) {
      return fulfillError(route, { status: 404, code: "DROPSHIP_PRICING_REVIEW_NOT_FOUND", message: "That review is gone." });
    }
    return route.fulfill({ json: reviewPage(held.review, Number(url.searchParams.get("page") ?? 0)) });
  }
  if (method === "POST" && path === `${listings}/pricing-rules/apply`) {
    const body = json();
    state.pricingApplies.push({ method, path, body });
    const parsed = applyPricingRulesInputSchema.safeParse(body);
    if (!parsed.success) return refuseBody(state, route, method, path, parsed.error.message);
    return keyedWrite(state, route, parsed.data.idempotencyKey, body, state.pricingApplyAnswers, () => {
      const held = state.reviews[parsed.data.reviewId];
      if (!held || held.storeConnectionId !== storeId || held.review.reviewHash !== parsed.data.reviewHash) {
        return { status: 404, code: "DROPSHIP_PRICING_REVIEW_NOT_FOUND", message: "That review is gone." };
      }
      if (held.review.summary.blocked > 0) {
        return { status: 422, code: "DROPSHIP_PRICING_REVIEW_BLOCKED", message: "Some listings can't be priced by these rules." };
      }
      const revisionId = state.nextRevision++;
      state.pricingRules[storeId] = pricingProfileStateSchema.parse({ revisionId, profile: held.input.profile, updatedAt: STAMP });
      return { revisionId };
    });
  }
  if (method === "PUT" && path === `${listings}/ebay-category-rules`) {
    const body = json();
    state.categoryWrites.push({ method, path, body });
    const parsed = saveEbayCategoryRulesInputSchema.safeParse(body);
    if (!parsed.success) return refuseBody(state, route, method, path, parsed.error.message);
    return keyedWrite(state, route, parsed.data.idempotencyKey, body, state.categoryWriteAnswers, () => {
      const current = state.categoryRules[storeId] ?? NO_RULES_STATE;
      if (parsed.data.expectedRevisionId !== current.revisionId) {
        return { status: 409, code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT", message: "The eBay category rules changed since you opened them." };
      }
      const lookup = (categoryId: string) => EBAY_CATEGORIES.find((option) => option.categoryId === categoryId && option.leaf) ?? null;
      const { defaultCategoryId, rules } = parsed.data.draft;
      const missing = [defaultCategoryId, ...rules.map((rule) => rule.categoryId)].find((id) => id !== null && lookup(id) === null);
      if (missing !== undefined) {
        return { status: 404, code: "DROPSHIP_EBAY_CATEGORY_NOT_FOUND", message: "eBay has no such category.", context: { categoryId: missing } };
      }
      const saved = ebayCategoryRulesStateSchema.parse({ revisionId: state.nextRevision++, updatedAt: STAMP, profile: {
        version: 1,
        defaultCategory: defaultCategoryId === null ? null : ebayCategory(lookup(defaultCategoryId) as EbayCategoryOption),
        rules: rules.map((rule) => ({ id: rule.id, name: rule.name, scope: rule.scope, category: ebayCategory(lookup(rule.categoryId) as EbayCategoryOption) })),
      } });
      state.categoryRules[storeId] = saved;
      return { state: saved };
    });
  }
  if (method === "PUT" && path === `${listings}/content-profile`) {
    const body = json();
    state.contentWrites.push({ method, path, body });
    const parsed = saveContentProfileInputSchema.safeParse(body);
    if (!parsed.success) return refuseBody(state, route, method, path, parsed.error.message);
    return keyedWrite(state, route, parsed.data.idempotencyKey, body, state.contentWriteAnswers, () => {
      const current = state.contentProfiles[storeId] ?? NO_RULES_STATE;
      if (parsed.data.expectedRevisionId !== current.revisionId) {
        return { status: 409, code: "DROPSHIP_CONTENT_VERSION_CONFLICT", message: "The description templates changed. Reload to review." };
      }
      const saved = contentProfileStateSchema.parse({ revisionId: state.nextRevision++, profile: parsed.data.profile, updatedAt: STAMP });
      state.contentProfiles[storeId] = saved;
      return { state: saved };
    });
  }
  const productSettingsPath = new RegExp(`^${listings}/listing-settings/products/(\\d+)$`).exec(path);
  if (method === "PUT" && productSettingsPath) {
    const body = json();
    state.productSettingsWrites.push({ method, path, body });
    const parsed = saveProductSettingsInputSchema.safeParse(body);
    if (!parsed.success) return refuseBody(state, route, method, path, parsed.error.message);
    // D1: the drawer never sends a price, a size's price or shown prices; 10a sends the three policies only.
    const extra = Object.keys(body).filter((name) => !["idempotencyKey", "expectedRevisionId", "patch"].includes(name));
    const fields = Object.keys(parsed.data.patch).filter((name) => !(PRODUCT_POLICY_FIELDS as readonly string[]).includes(name));
    if (extra.length > 0 || fields.length > 0) {
      return refuseBody(state, route, method, path, `10a sends policies only, not ${[...extra, ...fields].join(", ")}`);
    }
    const product = state.catalog.find((entry) => entry.productId === Number(productSettingsPath[1])) ?? null;
    if (product === null) {
      return fulfillError(route, { status: 404, code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", message: "This product has no chosen size in this store. Reload the page." });
    }
    const patch = parsed.data.patch as Partial<Record<ProductPolicyField, { id: string } | null>>;
    return keyedWrite(state, route, parsed.data.idempotencyKey, body, state.productSettingsWriteAnswers,
      () => saveProductSettings(state, storeId, product, { expectedRevisionId: parsed.data.expectedRevisionId, patch }), PRODUCT_SETTINGS_ANSWER);
  }
  const pricePath = new RegExp(`^${listings}/variants/(\\d+)/price$`).exec(path);
  if (method === "PUT" && pricePath) {
    const body = json();
    state.priceWrites.push({ method, path, body });
    const parsed = saveListingPriceInputSchema.safeParse(body);
    if (!parsed.success) return refuseBody(state, route, method, path, parsed.error.message);
    const size = findSize(state, Number(pricePath[1]));
    if (size === null) {
      return fulfillError(route, { status: 404, code: "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", message: "This size isn't chosen for the store." });
    }
    return keyedWrite(state, route, parsed.data.idempotencyKey, body, state.priceWriteAnswers, () => {
      const key = sizeKey(storeId, size.productVariantId);
      const current = state.sizePrices[key] ?? null;
      if (parsed.data.expectedRevisionId !== (current?.revisionId ?? null)) {
        return { status: 409, code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", message: "This price changed since it was loaded." };
      }
      const mode: ListingPricingMode = parsed.data.priceCents !== null ? "fixed" : parsed.data.pricingMode ?? "catalog_default";
      const product = findProductOf(state, size.productVariantId) as ProductFixture;
      const rule = rulePriceFor(priceOf(state, storeId, product)?.recipe ?? null, size);
      // W9 never lets a size lose a usable price (listing-price-save-guard.ts).
      if (mode === "inherit" && rule?.priceCents == null && size.retailCents === null) {
        return { status: 422, code: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", message: "This size would have no price." };
      }
      state.sizePrices[key] = { revisionId: state.nextRevision++, pricingMode: mode, overridePriceCents: parsed.data.priceCents };
      return { price: sizePriceSetting(state, storeId, size) };
    });
  }
  return NOT_MINE;
}

/** The store reads (setup, summary, lists, product, shelves, rules, texts, prices): NOT_MINE when the path is none of them. */
async function answerStoreRead(state: StubState, route: Route, storeId: number, path: string, url: URL) {
  const listings = `/api/dropship/listings/stores/${storeId}`;
  if (path === `/api/dropship/ebay/listing-setup/${storeId}`) {
    state.setupReads.push(storeId);
    if (state.setupReadError) return fulfillError(route, state.setupReadError);
    if (state.setupReadFailures > 0) {
      state.setupReadFailures -= 1;
      return route.fulfill({ status: 502, json: { error: { code: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
        message: "eBay did not return the connected store's listing setup.",
        context: { resource: "fulfillmentPolicies", status: 503, retryable: true, diagnosticReference: "browser-test-setup-read" } } } });
    }
    return route.fulfill({ json: setupOf(state, storeId) });
  }
  if (path === `${listings}/listing-settings/summary`) {
    state.summaryReads.push(storeId);
    if (state.summaryFailures > 0) {
      state.summaryFailures -= 1;
      return route.fulfill({ status: 500, json: { error: { code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR",
        message: "Listing settings could not be loaded. Please retry." } } });
    }
    return route.fulfill({ json: state.summaries[storeId]
      ?? (state.liveSummary ? liveListingSettingsSummary(state, storeId) : listingSettingsSummary(storeId)) });
  }
  // The Listing settings step's Products tab (its default tab) reads its first page on mount.
  if (path === `${listings}/listing-settings/products`) {
    state.productsReads.push(`${storeId}?${url.searchParams.toString()}`);
    if (state.tooLarge) return fulfillTooLarge(route);
    return route.fulfill({ json: listingSettingsProducts(state, storeId, url.searchParams) });
  }
  if (path === `${listings}/listing-settings/prices`) {
    if (state.tooLarge) return fulfillTooLarge(route);
    return route.fulfill({ json: listingSettingsPrices(state, storeId, url.searchParams) });
  }
  // One product's own settings row (plan PR 10, 4.2): refused while too large, as the server refuses every list read.
  const ownPath = new RegExp(`^${listings}/listing-settings/products/(\\d+)/own$`).exec(path);
  if (ownPath) {
    if (state.tooLarge) return fulfillTooLarge(route);
    const own = listingSettingsProductOwn(state, storeId, Number(ownPath[1]));
    if (own === null) {
      return fulfillError(route, { status: 404, code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", message: "That product isn't chosen for this store." });
    }
    return route.fulfill({ json: own });
  }
  const productPath = new RegExp(`^${listings}/listing-settings/products/(\\d+)$`).exec(path);
  if (productPath) {
    if (state.tooLarge) return fulfillTooLarge(route);
    const detail = listingSettingsProductDetail(state, storeId, Number(productPath[1]));
    if (detail === null) {
      return fulfillError(route, { status: 404, code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", message: "That product isn't chosen for this store." });
    }
    return route.fulfill({ json: detail });
  }
  if (path === `/api/dropship/ebay/listing-policy-overrides/${storeId}/saved`) {
    return route.fulfill({ json: { storeConnectionId: storeId, verification: "not_checked",
      defaults: { fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: "payments" }, assignments: [], fetchedAt: STAMP } });
  }
  if (path === `/api/dropship/ebay/store-categories/${storeId}`) {
    if (state.storeShelvesError) return fulfillError(route, state.storeShelvesError);
    return route.fulfill({ json: { storeConnectionId: storeId, categories: state.storeShelves[storeId] ?? [], assignments: [], fetchedAt: STAMP } });
  }
  if (path === `${listings}/pricing-rules/targets` && url.searchParams.get("type") === "listings") {
    return route.fulfill({ json: { total: 1, rows: [{ id: "101", name: "Envelope Single Pocket · Pack of 50 · ENV-SGL-P50" }] } });
  }
  const pricePath = new RegExp(`^${listings}/variants/(\\d+)/price$`).exec(path);
  if (pricePath) {
    const size = findSize(state, Number(pricePath[1]));
    if (size === null) return NOT_MINE;
    return route.fulfill({ json: listingPriceResponseSchema.parse({ price: sizePriceSetting(state, storeId, size) }) });
  }
  if (path === `${listings}/pricing-rules`) return route.fulfill({ json: state.pricingRules[storeId] ?? NO_RULES_STATE });
  if (path === `${listings}/ebay-category-rules`) return route.fulfill({ json: state.categoryRules[storeId] ?? NO_RULES_STATE });
  if (path === `${listings}/content-profile`) return route.fulfill({ json: state.contentProfiles[storeId] ?? NO_RULES_STATE });
  if (path === `${listings}/ebay-categories/search`) {
    const query = url.searchParams.get("q") ?? "";
    state.categorySearches.push(query);
    const words = query.trim().toLowerCase();
    return route.fulfill({ json: { categories: EBAY_CATEGORIES.filter((option) => option.leaf && option.categoryName.toLowerCase().includes(words)) } });
  }
  if (path === `${listings}/ebay-categories`) {
    const parentId = url.searchParams.get("parentId");
    const parent = parentId === null ? null : EBAY_CATEGORIES.find((option) => option.categoryId === parentId) ?? null;
    const depth = parent === null ? 1 : parent.path.length + 1;
    const children = EBAY_CATEGORIES.filter((option) => option.path.length === depth
      && (parent === null || option.path.slice(0, -1).join("/") === parent.path.join("/")));
    return route.fulfill({ json: { parent, children } });
  }
  return NOT_MINE;
}

/** More than 10,000 sizes chosen: the lists, the product read and its own settings are refused (dropship-listing-settings.routes.ts). */
function fulfillTooLarge(route: Route) {
  return fulfillError(route, { status: 422, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
    message: "More than 10,000 sizes are chosen.", context: { limit: 10_000 } });
}

export async function shot(page: Page, testInfo: TestInfo, name: string) {
  if (!SHOTS_DIR) return;
  await page.screenshot({ path: join(SHOTS_DIR, `${testInfo.project.name}-${name}.png`) });
}

export function step(page: Page, name: "choose" | "setup" | "publish") {
  return page.getByTestId(`catalog-step-${name}`);
}

/**
 * Today's step 2 panels sit in the collapsed "Older settings" section under the new step (A1).
 * Closed, they stay mounted but hidden, and hidden elements are not in the role tree, so a journey
 * that reads or clicks inside them opens the section first. It stays open across steps and stores.
 */
export async function openOlderSettings(page: Page) {
  await page.getByRole("button", { name: "Show older settings" }).click();
  await expect(page.getByRole("button", { name: "Hide older settings" })).toHaveAttribute("aria-expanded", "true");
}

/** The old setup panel, for words the new step's banner or Shipping row also show (R:503, R:504). */
export function oldSetupPanel(page: Page) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: /^eBay listing setup/ }) }).last();
}

// The default fixtures are checked against the contract when a spec loads, so one that drifts
// fails with the schema's message before any journey runs.
{
  const loaded = defaultStubState();
  listingSettingsSummarySchema.parse(listingSettingsSummary(MARZ.storeConnectionId));
  liveListingSettingsSummary(loaded, MARZ.storeConnectionId);
  listingSettingsProducts(loaded, MARZ.storeConnectionId, new URLSearchParams());
  listingSettingsPrices(loaded, MARZ.storeConnectionId, new URLSearchParams());
  listingSettingsProductDetail(loaded, MARZ.storeConnectionId, ENVELOPE.productId);
  listingSettingsProductOwn(loaded, MARZ.storeConnectionId, ENVELOPE.productId);
  listingPriceResponseSchema.parse({ price: sizePriceSetting(loaded, MARZ.storeConnectionId, ENVELOPE.sizes[0]) });
  pricingProfileStateSchema.parse(SAVED_PRICING_RULES);

  // Every layer at once (plan PR 10, 3.2): a product row, its category's row and two sizes' leftovers.
  // Each read's answer is parsed with its contract, whose checks tie the rows' flags to the values.
  const store = MARZ.storeConnectionId;
  const layered: StubState = { ...defaultStubState(), liveSummary: true, catalog: [ENVELOPE, LAYERED_SAMPLE],
    productSettings: { [productKey(store, LAYERED_SAMPLE.productId)]: { revisionId: 7, values: {
      price: { basis: "catalog_retail", markupBps: 1_000, flatCents: 0, rounding: "cent" },
      ebayCategory: null, storeShelf: { mode: "own", shelves: [{ id: "11", name: "Supplies:Sleeves" }] },
      shippingPolicy: { id: "priority", name: "USPS Priority Mail" }, returnPolicy: null, paymentPolicy: null,
      textAbove: { mode: "own", text: "Ships in a rigid mailer." }, textBelow: null,
      mainText: { text: "Our own words.", catalogHash: "b".repeat(64) } } } },
    categorySettings: { [categoryKey(store, LAYERED_SAMPLE.categoryId as number)]: { revisionId: 8, values: {
      price: null, ebayCategory: { categoryId: SLEEVES.categoryId, categoryName: SLEEVES.categoryName, path: [...SLEEVES.path] },
      storeShelf: { mode: "none" }, shippingPolicy: null, returnPolicy: { id: "no-returns", name: "No returns" }, paymentPolicy: null,
      textAbove: null, textBelow: { mode: "none" } } } },
    sizeLeftovers: { [sizeKey(store, 302)]: { shippingPolicyId: "ground", shelfNames: ["Sale"], mainText: "This size's words." } } };
  for (const product of layered.catalog) {
    listingSettingsProductDetail(layered, store, product.productId);
    listingSettingsProductOwn(layered, store, product.productId);
  }
  liveListingSettingsSummary(layered, store);
  listingSettingsProducts(layered, store, new URLSearchParams());
  listingSettingsPrices(layered, store, new URLSearchParams());
  // W5 (plan PR 10, 4.9): a save of two policy fields on the sample's stored revision answers through the
  // shared contract, clears the size leftover it covers, and its replay answer is on contract too.
  const saving: StubState = { ...layered, productSettings: { ...layered.productSettings }, sizeLeftovers: { ...layered.sizeLeftovers } };
  const saved = saveProductSettings(saving, store, LAYERED_SAMPLE, { expectedRevisionId: 7, patch: { shippingPolicy: { id: "ground" }, returnPolicy: null } });
  if ("status" in saved || saved.clearedSizeCount !== 1 || PRODUCT_SETTINGS_ANSWER(saved, true).outcome !== "replayed") {
    throw new Error(`The stub's W5 save changed: ${JSON.stringify(saved)}`);
  }
  listingSettingsProductOwn(saving, store, LAYERED_SAMPLE.productId);
  // The resolver's order, pinned once here: size, then product, then category (named), then the store default.
  const sample = layeredSettings(layered, store, LAYERED_SAMPLE.productId) as LayeredProduct;
  const got = sample.sizes.map(({ values }) => [values.shippingPolicy.source, values.returnPolicy.source,
    values.returnPolicy.ruleName, values.paymentPolicy.source, values.storeShelf.source, values.mainText.source].join(","));
  const want = ["product,category,Sleeves,store_default,product,product", "size,category,Sleeves,store_default,size,size"];
  if (JSON.stringify(got) !== JSON.stringify(want) || sample.price?.kind !== "product" || !sample.sizes[0].ownTextNeedsCheck) {
    throw new Error(`The stub's layered resolver changed: ${JSON.stringify(got)}`);
  }
}
