import { expect, type Page, type Route, type TestInfo } from "playwright/test";
import { join, resolve } from "node:path";
import {
  ebayCategoryRulesStateSchema,
  saveEbayCategoryRulesInputSchema,
  type EbayCategory,
  type EbayCategoryOption,
  type EbayCategoryRulesState,
} from "../../shared/dropship/ebay-category-rules";
import { decideDropshipListingAccess } from "../../shared/dropship/listing-access";
import { contentProfileStateSchema, saveContentProfileInputSchema, type ContentProfileState } from "../../shared/dropship/listing-content";
import {
  listingPriceResponseSchema,
  saveListingPriceInputSchema,
  type ListingPriceSetting,
  type ListingPricingMode,
} from "../../shared/dropship/listing-price";
import {
  LISTING_SETTINGS_PAGE_SIZE,
  listingSettingsPricesResponseSchema,
  listingSettingsProductDetailSchema,
  listingSettingsProductsResponseSchema,
  listingSettingsSummarySchema,
  type ListingSettingsFixCode,
  type ListingSettingsProductDetail,
  type ListingSettingsProductRow,
  type ListingSettingsSizePrice,
  type ListingSettingsSummary,
} from "../../shared/dropship/listing-settings";
import {
  PRICING_REVIEW_PAGE_SIZE,
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
  category: string | null;
  /** Every size the vendor could choose; defaults to the chosen ones. */
  sizesTotal?: number;
  sizes: SizeFixture[];
}

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
  /** The checks W1 made, by review id, for paging and saving. */
  reviews: Record<string, { storeConnectionId: number; input: ReviewPricingRulesInput; review: PricingReviewResponse }>;
  /** Request keys the keyed writers saw, with the body and the answer, so a retry is answered from the first save. */
  keyedAnswers: Record<string, { body: string; json: Record<string, unknown> }>;
  /** The next revision a keyed writer saves (W1, W3, W4, W9 share one counter, as ids). */
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

function basisCentsFor(recipe: PricingRecipe, size: SizeFixture): number | null {
  return pricingBasisCents(recipe.basis, { productCostCents: size.costCents, catalogRetailCents: size.retailCents });
}

/** What the store's rules give a size: its price, or why there is none; null when the store has no rules. */
function rulePriceFor(recipe: PricingRecipe | null, size: SizeFixture) {
  return recipe === null ? null : calculateRulePrice(recipe, basisCentsFor(recipe, size));
}

/** One size's price fact (`listingSettingsSizePriceSchema`), from its saved setting and the store's rules. */
export function sizePriceFact(state: StubState, storeConnectionId: number, product: ProductFixture, size: SizeFixture): ListingSettingsSizePrice {
  const saved = state.sizePrices[sizeKey(storeConnectionId, size.productVariantId)] ?? null;
  const recipe = storeRecipe(state, storeConnectionId);
  const rule = rulePriceFor(recipe, size);
  const ruleOwned = (priceCents: number) => ({
    priceCents, source: "rules" as const, issue: null,
    rule: { kind: "store_default" as const, name: STORE_DEFAULT_RULE_NAME, recipe: recipe as PricingRecipe },
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
  const recipe = storeRecipe(state, storeConnectionId);
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
  return {
    storeConnectionId, productVariantId: size.productVariantId, revisionId: saved?.revisionId ?? null,
    overridePriceCents: mode === "fixed" ? saved?.overridePriceCents ?? null : null,
    effectivePriceCents: effective, defaultPriceCents: size.retailCents, source, pricingMode: mode,
    ruleName: recipe ? STORE_DEFAULT_RULE_NAME : null, pricingIssue: rule?.issue ?? null, rulePriceCents: rule?.priceCents ?? null,
    rulesConfigured: recipe !== null, ruleBasis: recipe?.basis ?? null, productCostCents: size.costCents,
    updatedAt: saved ? STAMP : null,
  };
}

function sizeFixes(price: ListingSettingsSizePrice): ListingSettingsFixCode[] {
  return price.priceCents === null ? ["size_cannot_be_priced"] : [];
}

function productFacts(state: StubState, storeConnectionId: number, product: ProductFixture) {
  const prices = product.sizes.map((size) => sizePriceFact(state, storeConnectionId, product, size));
  const priced = prices.map((price) => price.priceCents).filter((cents): cents is number => cents !== null);
  const fixes = [...new Set(prices.flatMap(sizeFixes))];
  const row: Omit<ListingSettingsProductRow, "matchedSize"> = {
    productId: product.productId, productName: product.productName, category: product.category,
    sizesChosen: product.sizes.length, sizesTotal: product.sizesTotal ?? product.sizes.length,
    priceRange: priced.length === 0 ? null : { minCents: Math.min(...priced), maxCents: Math.max(...priced) },
    exactPriceCount: prices.filter((price) => price.source === "exact").length,
    // Today's per-size policies, shelves and texts are not in the fixture: every size uses the store's.
    ownSettings: [], sizesDiffer: [], fixes,
  };
  return { prices, row };
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
    const listed = show === "all" || (show === "needs_fix" && row.fixes.length > 0) || (show === "exact_prices" && row.exactPriceCount > 0)
      || (show === "below_cost" && prices.some((price) => price.belowCostByCents !== null))
      || (show === "cannot_price" && prices.some((price) => price.priceCents === null));
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

/** One product's settings in full (the drawer), or null when it is not chosen. */
export function listingSettingsProductDetail(state: StubState, storeConnectionId: number, productId: number): ListingSettingsProductDetail | null {
  const product = state.catalog.find((entry) => entry.productId === productId);
  if (!product) return null;
  const { prices, row } = productFacts(state, storeConnectionId, product);
  const ids = product.sizes.map((size) => size.productVariantId);
  const one = <V>(value: V, source: "store_default" | "catalog" | "none") => [{ value, sources: [{ source, ruleName: null, productVariantIds: ids }] }];
  const selection = setupOf(state, storeConnectionId).selection;
  const policy = (policyId: string | null) => one({ policyId }, policyId === null ? "none" : "store_default");
  const category = state.categoryRules[storeConnectionId]?.profile?.defaultCategory ?? null;
  const template = state.contentProfiles[storeConnectionId]?.profile?.defaultTemplate ?? null;
  const hasText = template !== null && (template.introduction !== "" || template.footer !== "");
  return listingSettingsProductDetailSchema.parse({
    storeConnectionId,
    product: row,
    settings: {
      shippingPolicy: policy(selection.fulfillmentPolicyId ?? null),
      returnPolicy: policy(selection.returnPolicyId ?? null),
      paymentPolicy: policy(selection.paymentPolicyId ?? null),
      ebayCategory: category
        ? one({ categoryId: category.categoryId, categoryName: category.categoryName }, "store_default")
        : one({ ...CARD_SHELLZ_CATEGORY }, "catalog"),
      // The store shelf default reaches listings in PR 8 (A2): the size's own shelf shows, and these sizes have none.
      storeShelf: one({ names: [] }, "none"),
      descriptionTemplate: one({ hasIntroduction: (template?.introduction ?? "") !== "", hasFooter: (template?.footer ?? "") !== "",
        groupConflict: false }, hasText ? "store_default" : "none"),
      mainText: one({ own: false }, "catalog"),
    },
    sizes: product.sizes.map((size, index) => ({ price: prices[index], fixes: sizeFixes(prices[index]), stockUnits: size.stockUnits })),
    stock: { state: "ok", checkedAt: STAMP },
    generatedAt: STAMP,
  });
}

/**
 * The summary as the server works it out from what the stub holds (`liveSummary`), in the
 * order and with the counts `buildListingSettingsSummary` gives (dropship-listing-settings-facts.ts):
 * the shared listing access decision, then missing policies, then each product's first fix.
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
  for (const product of needingFix) {
    items.push({ code: "size_cannot_be_priced", count: product.prices.filter((price) => price.priceCents === null).length,
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
      productsNeedingFix: needingFix.length, productsWithSizesDiffer: 0, productsWithOwnSettings: 0,
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

/**
 * A keyed write (W1 apply, W3, W4, W9): the same key with the same body is answered from the
 * first save as a replay; the same key with another body is refused, as the routes do.
 */
async function keyedWrite(state: StubState, route: Route, key: string, body: Record<string, unknown>,
  answers: WriteAnswer[], save: () => Promise<Record<string, unknown> | ScriptedError> | Record<string, unknown> | ScriptedError) {
  const sent = JSON.stringify(body);
  const earlier = state.keyedAnswers[key];
  if (earlier) {
    if (earlier.body !== sent) {
      return fulfillError(route, { status: 409, code: "DROPSHIP_IDEMPOTENCY_CONFLICT", message: "This request key was used for another request." });
    }
    return route.fulfill({ json: { ...earlier.json, idempotentReplay: true } });
  }
  const answer = answers.shift();
  if (answer && answer !== "drop") return fulfillError(route, answer);
  const saved = await save();
  if ("status" in saved && "code" in saved) return fulfillError(route, saved as ScriptedError);
  const json = saved as Record<string, unknown>;
  state.keyedAnswers[key] = { body: sent, json };
  // The save reached the server, but its answer never came back.
  if (answer === "drop") return route.abort("connectionreset");
  return route.fulfill({ json: { ...json, idempotentReplay: false } });
}

function findSize(state: StubState, productVariantId: number): SizeFixture | null {
  for (const product of state.catalog) {
    const size = product.sizes.find((entry) => entry.productVariantId === productVariantId);
    if (size) return size;
  }
  return null;
}

function shelfName(state: StubState, storeConnectionId: number, id: string): string {
  return (state.storeShelves[storeConnectionId] ?? []).find((shelf) => shelf.categoryId === id)?.path ?? id;
}

/** What the stub holds before a journey changes it: one eBay store, product 11 chosen, nothing else saved. */
export const defaultStubState = (): StubState => ({
  stores: [MARZ], selected: true, previewCalls: 0, setupReads: [], summaryReads: [], productsReads: [], reads: [],
  vendor: { status: "active", entitlementStatus: "active" }, summaries: {}, liveSummary: false, storeStatuses: {}, tooLarge: false,
  summaryFailures: 0, listingSetups: {}, setupReadFailures: 0, setupReadError: null, pricingRules: {}, setupWrites: [],
  setupWriteAnswers: [], catalog: [ENVELOPE], sizePrices: {}, storeShelves: {}, storeShelvesError: null, categoryRules: {},
  contentProfiles: {}, pricingReviews: [], pricingReviewAnswers: [], pricingApplies: [], pricingApplyAnswers: [],
  categoryWrites: [], categoryWriteAnswers: [], categorySearches: [], contentWrites: [], contentWriteAnswers: [],
  priceWrites: [], priceWriteAnswers: [], reviews: {}, keyedAnswers: {}, nextRevision: 40, unexpected: [], errors: [],
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

/** W1 (price check and save), W3, W4 and W9: NOT_MINE when the request is none of them. */
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
      const rule = rulePriceFor(storeRecipe(state, storeId), size);
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

/** More than 10,000 sizes chosen: the lists and the product read are refused (dropship-listing-settings.routes.ts). */
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
  listingPriceResponseSchema.parse({ price: sizePriceSetting(loaded, MARZ.storeConnectionId, ENVELOPE.sizes[0]) });
  pricingProfileStateSchema.parse(SAVED_PRICING_RULES);
}
