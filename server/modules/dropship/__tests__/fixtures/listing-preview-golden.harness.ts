/**
 * The golden listing previews' harness (moved out of
 * __tests__/unit/listing-preview-golden.test.ts by Listing settings PR 11a2,
 * plan 4.B.1): the store client the real readers run over, the preview's
 * port and runner, the read model's inputs as the listing-settings load
 * reads them, and the "product sheet says what the step 3 preview sends"
 * comparison. It is not a test file: the preview golden (G2) and the rules
 * conversion golden import it, so both run the same readers over the same
 * stored rows, and every check the conversion golden makes is one G2
 * already makes on today's data. The code is G2's as it was, with two
 * changes of shape and none of behavior: the sheet comparison is a function
 * of a store and its stored rows (G2 passed a scenario holding both), and it
 * reads a product's own main text from that product's stored row, which is
 * what G2's scenario values become (productValuesToColumns). G2's pins and
 * assertions are as before. PR 11c (D23): the port answers the four
 * resolver reads through loadResolverInputs, as the PostgreSQL repository
 * does, unless a run asks for the separate reads (GoldenResolverReads).
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { expect, vi } from "vitest";
import type { EbayCategorySource } from "../../../../../shared/dropship/ebay-category-rules";
import type { ListingPriceSetting } from "../../../../../shared/dropship/listing-price";
import type { ListingSettingsValueSource } from "../../../../../shared/dropship/listing-settings";
import {
  CATEGORY_PRICE_RULE_NAME, PRODUCT_PRICE_RULE_NAME, type PricingProfile, type PricingProfileState,
} from "../../../../../shared/dropship/pricing-rules";
import { classifyListing, type CostActionVendorFacts } from "../../application/dropship-cost-change-listing-action-service";
import { prepareEbayCategoryRules, resolveEbayListingCategory } from "../../application/dropship-ebay-category-resolver";
import { textDescriptionHtml } from "../../application/dropship-listing-content-resolver";
import {
  DropshipListingPreviewService,
  type DropshipListingCatalogCandidate,
  type DropshipListingPreviewRepository,
  type DropshipListingPreviewResult,
} from "../../application/dropship-listing-preview-service";
import { DropshipListingPriceService, type ListingPriceTransaction } from "../../application/dropship-listing-price-service";
import {
  buildListingSettingsFacts,
  type ListingSettingsFacts, type ListingSettingsInputs, type ListingSettingsSizeFacts,
} from "../../application/dropship-listing-settings-facts";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import { DropshipPricingRulesService, type PricingRulesTransaction, type StoredPricingReview } from "../../application/dropship-pricing-rules-service";
import type { DropshipVendorProvisioningService } from "../../application/dropship-vendor-provisioning-service";
import type { CostChangeListingPriceClassification } from "../../domain/cost-change-listing-action";
import { ConfigDrivenDropshipMarketplaceListingProvider } from "../../infrastructure/dropship-config-driven-marketplace-listing.provider";
import { readEbayCategoryRules, readResolvedEbayCategories } from "../../infrastructure/dropship-ebay-category-rules.reader";
import { readContentProfile, readListingContentSettings, readResolvedListingContents } from "../../infrastructure/dropship-listing-content.reader";
import { readCatalogCategoryNames, readListingSettingLayers } from "../../infrastructure/dropship-listing-setting-layers.reader";
import { readListingResolverInputs } from "../../infrastructure/dropship-listing-resolver-inputs.reader";
import { readPricingProfile } from "../../infrastructure/dropship-pricing-profile.reader";
import { loadListingRulePrices } from "../../infrastructure/dropship-rule-price.loader";
import { PgShellzClubProductCostAdapter } from "../../infrastructure/shellz-club-product-cost.adapter";
import {
  GOLDEN_PREVIEW_ATP,
  GOLDEN_PREVIEW_CANDIDATES,
  GOLDEN_PREVIEW_CATEGORY_NAMES,
  GOLDEN_PREVIEW_COSTS,
  GOLDEN_PREVIEW_LISTING_TIERS,
  GOLDEN_PREVIEW_NOW,
  GOLDEN_PREVIEW_PRICING_POLICIES,
  GOLDEN_PREVIEW_SIZES_TOTAL_BY_PRODUCT_ID,
  GOLDEN_PREVIEW_VENDOR_ID,
  goldenFulfillmentPreflight,
  goldenPublicationPhotos,
  type GoldenPreviewCandidate,
  type GoldenPreviewStore,
} from "./listing-preview-golden.fixture";

export const VARIANT_IDS = GOLDEN_PREVIEW_CANDIDATES.map((row) => row.productVariantId);
/**
 * The golden vendor's one-time picks: every golden size (at main the vendor's
 * one `catalog` include rule chose them all, PLAN-B v4.1 §9 rows 2-3).
 */
export const GOLDEN_PICKED_VARIANT_IDS: readonly number[] = Object.freeze([...VARIANT_IDS]);

/** The golden previews' member, as the preview's actor names it. */
const GOLDEN_MEMBER_ID = "member-golden";
const QUIET_LOGGER = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Statements a read path may send: a read, never a write or a row lock. */
const READ_ONLY_STATEMENT = /^\s*SELECT\b/i;
const ROW_LOCK = /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i;

/** Stored product and category listing-settings rows, as PR 8a's readers select them. */
export interface GoldenLayerRows {
  products: readonly (Record<string, unknown> & { product_id: number })[];
  categories: readonly (Record<string, unknown> & { category_id: number })[];
}
export const NO_LAYER_ROWS: GoldenLayerRows = { products: [], categories: [] };

/**
 * Answers the reads the preview's real loaders send, from one store's stored
 * rows, and fails the test on anything else: a write, a row lock, an unknown
 * read, or a read for another vendor or store. Product and category listing
 * settings read as no rows (plan 4.11) unless a variant (8b-W) saves some.
 * The listing-settings load also reads the Card Shellz category names.
 */
export class GoldenStoreClient {
  readonly statements: string[] = [];
  constructor(private readonly store: GoldenPreviewStore, private readonly layerRows: GoldenLayerRows = NO_LAYER_ROWS) {}

  asPgClient(): Pick<PoolClient, "query"> {
    return this as unknown as Pick<PoolClient, "query">;
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
    this.statements.push(sql);
    if (!READ_ONLY_STATEMENT.test(sql) || ROW_LOCK.test(sql)) throw new Error(`A preview read sent a write or a lock: ${sql}`);
    const storeId = this.store.context.storeConnectionId;
    if (/FROM dropship\.dropship_pricing_profiles\b/.test(sql)) {
      this.expectScope(sql, params, [storeId, GOLDEN_PREVIEW_VENDOR_ID]);
      return { rows: this.store.pricingProfile ? [structuredClone(this.store.pricingProfile)] : [] };
    }
    if (/FROM dropship\.dropship_content_profiles\b/.test(sql)) {
      this.expectScope(sql, params, [GOLDEN_PREVIEW_VENDOR_ID, storeId]);
      return { rows: this.store.contentProfile ? [structuredClone(this.store.contentProfile)] : [] };
    }
    if (/FROM dropship\.dropship_listing_content_settings\b/.test(sql)) {
      this.expectScope(sql, params, [GOLDEN_PREVIEW_VENDOR_ID, storeId]);
      const ids = params[2] as readonly number[];
      return { rows: structuredClone(this.store.contentSettings.filter((row) => ids.includes(row.product_variant_id))) };
    }
    if (/FROM dropship\.dropship_ebay_category_rule_profiles\b/.test(sql)) {
      this.expectScope(sql, params, [GOLDEN_PREVIEW_VENDOR_ID, storeId]);
      return { rows: this.store.ebayCategoryRules ? [structuredClone(this.store.ebayCategoryRules)] : [] };
    }
    if (/FROM dropship\.dropship_product_listing_settings\b/.test(sql)) {
      this.expectScope(sql, params, [GOLDEN_PREVIEW_VENDOR_ID, storeId]);
      const ids = params[2] as readonly number[];
      return { rows: structuredClone(this.layerRows.products.filter((row) => ids.includes(row.product_id))) };
    }
    if (/FROM dropship\.dropship_category_listing_settings\b/.test(sql)) {
      this.expectScope(sql, params, [GOLDEN_PREVIEW_VENDOR_ID, storeId]);
      const ids = params[2] as readonly number[];
      return { rows: structuredClone(this.layerRows.categories.filter((row) => ids.includes(row.category_id))) };
    }
    if (/FROM catalog\.product_categories\b/.test(sql)) {
      const ids = params[0] as readonly number[];
      return { rows: [...GOLDEN_PREVIEW_CATEGORY_NAMES].filter(([id]) => ids.includes(id)).map(([id, name]) => ({ id, name })) };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }

  private expectScope(sql: string, params: readonly unknown[], scope: readonly number[]): void {
    if (scope.some((id, index) => params[index] !== id)) {
      throw new Error(`A read for another vendor or store (${JSON.stringify(params.slice(0, scope.length))}): ${sql}`);
    }
  }
}

type PortInput<K extends keyof DropshipListingPreviewRepository> = Parameters<NonNullable<DropshipListingPreviewRepository[K]>>[0];

export function inVariantIds<T extends { productVariantId: number }>(rows: readonly T[], ids: readonly number[]): T[] {
  return structuredClone(rows.filter((row) => ids.includes(row.productVariantId)));
}

/**
 * How the golden port answers the preview's four resolver reads (PR 11, D23):
 * `one_snapshot` (the default) as the PostgreSQL repository does, through
 * loadResolverInputs and the real composition (readListingResolverInputs);
 * `separate` as a port without it, the four separate loaders. G2 runs both
 * over every store and pins that they read the same and give the same preview.
 */
export type GoldenResolverReads = "one_snapshot" | "separate";

/**
 * The preview's port over one store's fixture. Prices, descriptions and eBay
 * categories go through the real loaders over the store's client, as the
 * PostgreSQL repository runs them inside its read-only transaction; the
 * other reads hand back the fixture's rows.
 */
export class GoldenPreviewRepository implements DropshipListingPreviewRepository {
  loadResolverInputs?: DropshipListingPreviewRepository["loadResolverInputs"];
  loadRulePrices?: DropshipListingPreviewRepository["loadRulePrices"];
  loadListingContents?: DropshipListingPreviewRepository["loadListingContents"];
  loadEbayCategories?: DropshipListingPreviewRepository["loadEbayCategories"];

  constructor(private readonly store: GoldenPreviewStore, private readonly client: GoldenStoreClient,
    private readonly resolverReads: GoldenResolverReads = "one_snapshot") {
    if (resolverReads === "one_snapshot") {
      this.loadResolverInputs = (input) => readListingResolverInputs(this.client.asPgClient(), input);
    } else {
      this.loadRulePrices = (input) => loadListingRulePrices(this.client.asPgClient(), input);
      this.loadListingContents = (input) => readResolvedListingContents(this.client.asPgClient(), input);
      this.loadEbayCategories = (input) => readResolvedEbayCategories(this.client.asPgClient(), input);
    }
  }

  /**
   * The preview's one read of the product and category settings (plan D26), through the real reader. A port
   * with loadResolverInputs reads them there, so the preview reaching this one would be the split read D23 removed.
   */
  loadListingSettingLayers(input: PortInput<"loadListingSettingLayers">) {
    if (this.resolverReads === "one_snapshot") {
      throw new Error("The preview read its settings apart from the profiles (PR 11, D23).");
    }
    return readListingSettingLayers(this.client.asPgClient(), input);
  }
  async listSavedListingPrices(input: PortInput<"listSavedListingPrices">) {
    return inVariantIds(this.store.savedPrices, input.productVariantIds);
  }
  async loadStoreContext(input: PortInput<"loadStoreContext">) {
    const { context } = this.store;
    return input.vendorId === context.vendorId && input.storeConnectionId === context.storeConnectionId ? { ...context } : null;
  }
  async getStoreListingConfig(storeConnectionId: number) {
    return storeConnectionId === this.store.config.storeConnectionId ? structuredClone(this.store.config) : null;
  }
  async listCatalogExposureRules() {
    return [{ id: 1, scopeType: "catalog" as const, action: "include" as const }];
  }
  async listPickedVariantIds(vendorId: number, productVariantIds: readonly number[]) {
    if (vendorId !== GOLDEN_PREVIEW_VENDOR_ID) return new Set<number>();
    return new Set(productVariantIds.filter((id) => GOLDEN_PICKED_VARIANT_IDS.includes(id)));
  }
  async listCatalogCandidates(productVariantIds: readonly number[]) {
    return inVariantIds(GOLDEN_PREVIEW_CANDIDATES, productVariantIds);
  }
  async listVariantOverrides() {
    return [];
  }
  async listExistingListings(input: PortInput<"listExistingListings">) {
    return inVariantIds(this.store.existingListings, input.productVariantIds);
  }
  async listPricingPolicies() {
    return structuredClone([...GOLDEN_PREVIEW_PRICING_POLICIES]);
  }
  async listEbayStoreCategoryAssignments(input: PortInput<"listEbayStoreCategoryAssignments">) {
    return inVariantIds(this.store.shelfAssignments, input.productVariantIds);
  }
  async listEbayListingPolicyOverrides(input: PortInput<"listEbayListingPolicyOverrides">) {
    return inVariantIds(this.store.policyOverrides, input.productVariantIds);
  }
  async getPackageReadiness(productVariantIds: readonly number[]) {
    return new Map(productVariantIds.map((id) => [id, { hasCatalogPackageData: true, hasActiveBox: true, hasActiveRateTable: true }]));
  }
  async createListingPushJob(): Promise<never> {
    throw new Error("The golden preview never queues a push.");
  }
}

export function goldenCosts(productVariantIds: readonly number[]): Map<number, DropshipProductCost> {
  return new Map(productVariantIds.flatMap((id) => {
    const cost = GOLDEN_PREVIEW_COSTS.get(id);
    return cost ? [[id, structuredClone(cost)] as const] : [];
  }));
}

/**
 * The .ops cost source reads tables outside dropship; the loader's cost read
 * answers from the fixture, and only over a store's golden client. Called in
 * a beforeEach (vi.restoreAllMocks in the afterEach undoes it).
 */
export function mockGoldenCostSource(): void {
  vi.spyOn(PgShellzClubProductCostAdapter, "forTransaction").mockImplementation((client) => {
    if (!(client instanceof GoldenStoreClient)) throw new Error("The rule-price loader read costs outside the store's client.");
    return { loadProductCosts: async ({ productVariantIds }: { productVariantIds: readonly number[] }) => goldenCosts(productVariantIds) } as
      unknown as PgShellzClubProductCostAdapter;
  });
}

/** What the preview sent to the live eBay policy checks. */
export interface PolicyChecks {
  fulfillmentPolicyIds: string[];
  returnPolicyIds: string[];
  paymentPolicyIds: string[];
}

export interface GoldenPreviewOptions {
  /** Variants (8b-W): product and category settings the store has saved. */
  layerRows?: GoldenLayerRows;
  /** Variants (8b-W): shipping policies the live eBay check finds incompatible. */
  incompatibleFulfillmentPolicyIds?: ReadonlySet<string>;
  /** PR 11 (D23): how the port answers the four resolver reads; one snapshot unless a test asks for the separate reads. */
  resolverReads?: GoldenResolverReads;
}

export async function runGoldenPreview(store: GoldenPreviewStore, options: GoldenPreviewOptions = {}): Promise<{
  preview: DropshipListingPreviewResult; checks: PolicyChecks; statements: readonly string[];
}> {
  const client = new GoldenStoreClient(store, options.layerRows);
  const checks: PolicyChecks = { fulfillmentPolicyIds: [], returnPolicyIds: [], paymentPolicyIds: [] };
  const service = new DropshipListingPreviewService({
    vendorProvisioning: {
      provisionForMember: async () => { throw new Error("The golden preview names its vendor."); },
    } as unknown as DropshipVendorProvisioningService,
    repository: new GoldenPreviewRepository(store, client, options.resolverReads),
    listingPhotos: {
      listPublicationPhotos: async ({ productVariantIds }) => new Map(productVariantIds.map((id) => [id, goldenPublicationPhotos(id)])),
    },
    productCosts: { loadProductCosts: async ({ productVariantIds }) => goldenCosts(productVariantIds) },
    atp: {
      getVariantAtp: async (targets) => ({ authority: "canonical", quantities: new Map(targets.map((target) =>
        [target.productVariantId, GOLDEN_PREVIEW_ATP.get(target.productVariantId) ?? 0])) }),
    },
    marketplaceListing: new ConfigDrivenDropshipMarketplaceListingProvider(),
    ebayFulfillmentPolicyGuard: {
      evaluateForStoreConnection: async (input) => {
        checks.fulfillmentPolicyIds.push(input.fulfillmentPolicyId);
        const preflight = goldenFulfillmentPreflight(input.fulfillmentPolicyId);
        return options.incompatibleFulfillmentPolicyIds?.has(input.fulfillmentPolicyId)
          ? { ...preflight, compatible: false, issues: [{ code: "shipping_service_unsupported:GoldenCourier", message: "Unsupported." }] }
          : preflight;
      },
      evaluateWithAccessToken: async () => { throw new Error("The preview checks policies through the store connection."); },
    },
    ebayReturnPaymentPolicies: {
      check: async (input) => {
        checks.returnPolicyIds.push(...input.returnPolicyIds);
        checks.paymentPolicyIds.push(...input.paymentPolicyIds);
        return { missingReturnPolicyIds: new Set(), missingPaymentPolicyIds: new Set() };
      },
    },
    listingTiers: { resolveForVendor: async () => ({ eligibility: structuredClone(GOLDEN_PREVIEW_LISTING_TIERS) }) },
    clock: { now: () => GOLDEN_PREVIEW_NOW },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const preview = await service.generatePreview({ vendorId: GOLDEN_PREVIEW_VENDOR_ID,
    storeConnectionId: store.context.storeConnectionId, productVariantIds: VARIANT_IDS,
    actor: { actorType: "vendor", actorId: "member-golden" } });
  return { preview, checks, statements: client.statements };
}

/**
 * The listing-settings read model's inputs over one store's stored rows, read
 * as the listing-settings load reads them (loadListingSettingsInputsWithClient):
 * the product and category layers once, the live names of every chosen size's
 * category (PR 9e), and eBay categories prepared with the same layers. The
 * preview golden's facts are buildListingSettingsFacts over these; the rules
 * conversion golden plans over them.
 */
export async function goldenListingInputs(store: GoldenPreviewStore, layerRows: GoldenLayerRows = NO_LAYER_ROWS):
  Promise<ListingSettingsInputs> {
  const client = new GoldenStoreClient(store, layerRows).asPgClient();
  const storeId = store.context.storeConnectionId;
  const candidates = structuredClone([...GOLDEN_PREVIEW_CANDIDATES]);
  const layers = await readListingSettingLayers(client, { vendorId: GOLDEN_PREVIEW_VENDOR_ID, storeConnectionId: storeId, candidates });
  const ebayCategoryRules = await readEbayCategoryRules(client, GOLDEN_PREVIEW_VENDOR_ID, storeId);
  const preparedCategories = prepareEbayCategoryRules(ebayCategoryRules.revisionId, ebayCategoryRules.profile, layers);
  return {
    store: { ...store.context },
    candidates,
    sizesTotalByProductId: GOLDEN_PREVIEW_SIZES_TOTAL_BY_PRODUCT_ID,
    savedPrices: new Map(inVariantIds(store.savedPrices, VARIANT_IDS).map((row) => [row.productVariantId, row])),
    existingListings: new Map(inVariantIds(store.existingListings, VARIANT_IDS).map((row) => [row.productVariantId, row])),
    pricing: await readPricingProfile(client, storeId, GOLDEN_PREVIEW_VENDOR_ID),
    costs: goldenCosts(VARIANT_IDS),
    pricingPolicies: structuredClone([...GOLDEN_PREVIEW_PRICING_POLICIES]),
    listingConfig: structuredClone(store.config),
    policyOverrides: new Map(inVariantIds(store.policyOverrides, VARIANT_IDS).map((row) => [row.productVariantId, row])),
    shelfAssignments: new Map(inVariantIds(store.shelfAssignments, VARIANT_IDS).map((row) => [row.productVariantId, row.storeCategoryNames])),
    ebayCategoryRules,
    ebayCategories: new Map(candidates.map((row) => [row.productVariantId, resolveEbayListingCategory(row, preparedCategories)])),
    content: await readContentProfile(client, GOLDEN_PREVIEW_VENDOR_ID, storeId),
    contentSettings: await readListingContentSettings(client, GOLDEN_PREVIEW_VENDOR_ID, storeId, VARIANT_IDS),
    pausedSince: new Map<number, Date>(),
    layers,
    categoryNames: await readCatalogCategoryNames(client,
      [...new Set(candidates.flatMap((row) => row.categoryId === null ? [] : [row.categoryId]))]),
    // No category marks: no product is moved, so the pinned projections are as before (plan PR 9, 10.1).
    categoryMoves: { marks: new Map(), fromCategories: new Map(), fromCategoryNames: new Map() },
  };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function candidateOf(productVariantId: number): GoldenPreviewCandidate {
  const candidate = GOLDEN_PREVIEW_CANDIDATES.find((row) => row.productVariantId === productVariantId);
  if (!candidate) throw new Error(`No golden size ${productVariantId}.`);
  return structuredClone(candidate);
}

export function factsSize(facts: ListingSettingsFacts, productVariantId: number): ListingSettingsSizeFacts {
  const size = facts.sizes.find((entry) => entry.price.productVariantId === productVariantId);
  if (!size) throw new Error(`No facts for size ${productVariantId}.`);
  return size;
}

/** The catalog, selection and store reads every per-store service makes first, over the store. */
export function goldenSelectedCatalog(store: GoldenPreviewStore, client: GoldenStoreClient) {
  return {
    vendorId: GOLDEN_PREVIEW_VENDOR_ID,
    catalog: new GoldenPreviewRepository(store, client),
    // The keyset over the vendor's picks (SELR's listVariantIds): picked sizes only.
    listVariantIds: async (afterId: number, limit: number) => GOLDEN_PICKED_VARIANT_IDS.filter((id) => id > afterId)
      .sort((left, right) => left - right).slice(0, limit),
    listProductLines: async () => [],
  };
}

/**
 * W9's GET for one size over the store's stored rows, through W9's own
 * loader call (dropship-listing-price.repository.ts: one size, no layers
 * given). A fresh store client for each size, as each GET is its own
 * transaction.
 */
export async function goldenPerSizePrice(store: GoldenPreviewStore, layerRows: GoldenLayerRows, productVariantId: number):
  Promise<ListingPriceSetting> {
  const client = new GoldenStoreClient(store, layerRows);
  const storeConnectionId = store.context.storeConnectionId;
  const saved = store.savedPrices.find((entry) => entry.productVariantId === productVariantId) ?? null;
  const tx = { vendorId: GOLDEN_PREVIEW_VENDOR_ID, catalog: new GoldenPreviewRepository(store, client),
    loadSaved: async () => structuredClone(saved),
    loadRulePrice: async (candidate: DropshipListingCatalogCandidate) => (await loadListingRulePrices(client.asPgClient(), {
      vendorId: GOLDEN_PREVIEW_VENDOR_ID, storeConnectionId, candidates: [candidate] })).get(candidate.productVariantId) ?? null,
    loadProductCost: async (candidate: DropshipListingCatalogCandidate) =>
      goldenCosts([candidate.productVariantId]).get(candidate.productVariantId) ?? null,
    loadReplay: async () => null,
    save: async () => { throw new Error("The golden per-size price never saves."); },
  } satisfies ListingPriceTransaction;
  const service = new DropshipListingPriceService({ repository: { execute: async (_request, operation) => operation(tx) },
    clock: { now: () => GOLDEN_PREVIEW_NOW }, logger: QUIET_LOGGER });
  return service.getForMember(GOLDEN_MEMBER_ID, { storeConnectionId, productVariantId });
}

/**
 * The pricing review (W1) over the store's stored rows, proposing
 * `propose(current)` at the stored profile's revision: the profile it read
 * and the review it stored (each size's price now and under the proposal).
 * It never applies.
 */
export async function goldenPricingReview(store: GoldenPreviewStore, layerRows: GoldenLayerRows,
  propose: (current: PricingProfileState) => PricingProfile,
  /** Every review the service stores, in order (a refused review stores none: Listing settings PR 12, D26). */
  storedReviews: StoredPricingReview[] = []): Promise<{ current: PricingProfileState; review: StoredPricingReview }> {
  const client = new GoldenStoreClient(store, layerRows);
  const storeId = store.context.storeConnectionId;
  const current = await readPricingProfile(client.asPgClient(), storeId, GOLDEN_PREVIEW_VENDOR_ID);
  let stored: StoredPricingReview | null = null;
  const tx = { ...goldenSelectedCatalog(store, client),
    costs: { loadProductCosts: async ({ productVariantIds }: { productVariantIds: readonly number[] }) => goldenCosts(productVariantIds) },
    loadProfile: async () => current,
    loadRuleLayers: (candidates: readonly { productId: number; categoryId: number | null }[]) => readListingSettingLayers(client.asPgClient(),
      { vendorId: GOLDEN_PREVIEW_VENDOR_ID, storeConnectionId: storeId, candidates }),
    storeReview: async (review: StoredPricingReview) => { stored = review; storedReviews.push(review); },
    loadReview: async () => stored, findApplication: async () => null,
    lockSelection: async () => { throw new Error("The golden review never applies."); },
    applyReview: async () => { throw new Error("The golden review never applies."); },
  } satisfies PricingRulesTransaction;
  const service = new DropshipPricingRulesService({ repository: { execute: async (_member, _store, operation) => operation(tx) },
    clock: { now: () => GOLDEN_PREVIEW_NOW }, newId: () => "6f1b1d7e-6d0e-4d43-9a43-2f9d3c0b7c11", logger: QUIET_LOGGER });

  await service.reviewForMember(GOLDEN_MEMBER_ID, storeId, { profile: propose(current), expectedRevisionId: current.revisionId,
    releaseFixedOverrides: false });

  if (stored === null) throw new Error("The golden pricing review stored no review.");
  return { current, review: stored };
}

/**
 * The facts the cost-change classifier reads for the store, as
 * loadVendorFacts reads them: a profile only for a store that has one, and
 * layers for every store with listings.
 */
export async function goldenCostChangeFacts(store: GoldenPreviewStore, layerRows: GoldenLayerRows): Promise<CostActionVendorFacts> {
  const client = new GoldenStoreClient(store, layerRows).asPgClient();
  const storeId = store.context.storeConnectionId;
  const state = await readPricingProfile(client, storeId, GOLDEN_PREVIEW_VENDOR_ID);
  return {
    listings: [],
    savedPrices: store.savedPrices.map((saved) => ({ storeConnectionId: storeId, productVariantId: saved.productVariantId,
      overridePriceCents: saved.overridePriceCents, pricingMode: saved.pricingMode ?? null })),
    profiles: state.profile ? new Map([[storeId, state]]) : new Map(),
    layersByStore: new Map([[storeId, await readListingSettingLayers(client, { vendorId: GOLDEN_PREVIEW_VENDOR_ID,
      storeConnectionId: storeId, candidates: GOLDEN_PREVIEW_CANDIDATES })]]),
    candidates: new Map(GOLDEN_PREVIEW_CANDIDATES.map((candidate) => [candidate.productVariantId, {
      productVariantId: candidate.productVariantId, productId: candidate.productId, category: candidate.category,
      categoryId: candidate.categoryId, productLineIds: candidate.productLineIds, defaultRetailPriceCents: candidate.defaultRetailPriceCents }])),
    pricingPolicies: structuredClone([...GOLDEN_PREVIEW_PRICING_POLICIES]),
  };
}

/** The cost-change classifier for one size of the store, at its .ops cost, as an active eBay listing. */
export function goldenClassifyAtCost(store: GoldenPreviewStore, facts: CostActionVendorFacts, productVariantId: number):
  CostChangeListingPriceClassification {
  const candidate = candidateOf(productVariantId);
  const existing = store.existingListings.find((listing) => listing.productVariantId === productVariantId);
  const cost = GOLDEN_PREVIEW_COSTS.get(productVariantId)!;
  return classifyListing(facts, { listingId: existing?.listingId ?? productVariantId, storeConnectionId: store.context.storeConnectionId,
    productVariantId, status: "active", externalListingId: null, vendorRetailPriceCents: existing?.vendorRetailPriceCents ?? null, publishedPriceCents: null, platform: "ebay",
    variantSku: candidate.sku, variantName: candidate.variantName, productName: candidate.productName }, cost.unitCostCents!);
}

/**
 * The size's own text, else its product's own main text: what the
 * description's main text is (plan 4.7). The product's is its stored row's
 * `body_text` (productValuesToColumns writes `mainText.text` there).
 */
function ownMainText(store: GoldenPreviewStore, layerRows: GoldenLayerRows, candidate: GoldenPreviewCandidate): string | null {
  const sizeText = store.contentSettings.find((row) => row.product_variant_id === candidate.productVariantId)?.custom_text ?? null;
  if (sizeText !== null) return sizeText;
  const text = layerRows.products.find((row) => row.product_id === candidate.productId)?.body_text ?? null;
  if (text !== null && typeof text !== "string") throw new Error(`Product ${candidate.productId}'s stored main text is not text.`);
  return text;
}

/** How the facts name where a size's eBay category comes from, for each resolver source. */
const FACTS_SOURCE_OF_EBAY_CATEGORY: Readonly<Record<EbayCategorySource, ListingSettingsValueSource>> = {
  product: "product", rule: "group_rule", category: "category", store_default: "store_default", catalog: "catalog", none: "none",
};
/** The preview's template label for each facts template source; a group is labelled by its name. */
const TEMPLATE_LABEL_OF_SOURCE: Partial<Record<ListingSettingsValueSource, string | null>> = {
  product: "This product", category: "Category settings", store_default: "Store template", none: null,
};
const POLICY_SETTINGS = [
  ["shippingPolicy", "fulfillmentPolicyId"], ["returnPolicy", "returnPolicyId"], ["paymentPolicy", "paymentPolicyId"],
] as const;

/**
 * The product sheet (the listing-settings facts) says what the step 3
 * preview sends, size by size, over one store's stored rows (PR 8b, 8b-G;
 * plan 4.9, 4.13): price and the rule that priced it, eBay category and its
 * source, policies, shelves, and the description and its parts. Returns the
 * sizes it compared, the preview's rows, so a caller whose store has no pins
 * can check that every chosen size was compared.
 */
export async function expectSheetSaysWhatPreviewSends(store: GoldenPreviewStore, layerRows: GoldenLayerRows): Promise<number[]> {
  const { preview } = await runGoldenPreview(store, { layerRows });
  const facts = buildListingSettingsFacts(await goldenListingInputs(store, layerRows));
  // The description each row was built from: the preview's own content read, with the preview's one layers read.
  const client = new GoldenStoreClient(store, layerRows).asPgClient();
  const scope = { vendorId: GOLDEN_PREVIEW_VENDOR_ID, storeConnectionId: store.context.storeConnectionId };
  const layers = await readListingSettingLayers(client, { ...scope, candidates: GOLDEN_PREVIEW_CANDIDATES });
  const contents = await readResolvedListingContents(client, { ...scope, candidates: structuredClone([...GOLDEN_PREVIEW_CANDIDATES]), layers });

  for (const row of preview.rows) {
    const candidate = candidateOf(row.productVariantId);
    const size = factsSize(facts, row.productVariantId);
    const where = `size ${row.productVariantId}`;
    const categoryName = candidate.categoryId === null ? undefined : GOLDEN_PREVIEW_CATEGORY_NAMES.get(candidate.categoryId);

    // Price, and the rule that priced it.
    expect(size.price.priceCents, where).toBe(row.priceCents);
    if (size.price.source === "rules") {
      const rule = size.price.rule!;
      expect(row.pricingRuleName, where).toBe(rule.kind === "product" ? PRODUCT_PRICE_RULE_NAME
        : rule.kind === "category" ? CATEGORY_PRICE_RULE_NAME : rule.name);
      expect(rule.name, where).toBe(rule.kind === "product" ? candidate.productName : rule.kind === "category" ? categoryName : rule.name);
      expect(row.rulePriceEvidenceHash, where).toMatch(/^[a-f0-9]{64}$/);
    } else if (size.price.source === "exact") {
      expect(row.priceSettingRevisionId, where).toBe(size.price.settingRevisionId);
      expect(row.pricingRuleName ?? null, where).toBeNull();
    } else {
      expect(row.pricingRuleName ?? null, where).toBeNull();
    }

    // eBay category.
    const ebay = size.values.ebayCategory;
    expect(ebay.value, where).toStrictEqual({ categoryId: row.marketplaceCategoryId, categoryName: row.marketplaceCategoryName });
    expect(ebay.source, where).toBe(FACTS_SOURCE_OF_EBAY_CATEGORY[row.marketplaceCategorySource!]);
    expect(ebay.ruleName, where).toBe(row.marketplaceCategorySource === "rule" ? row.marketplaceCategoryRuleName
      : row.marketplaceCategorySource === "category" ? categoryName : null);

    // Policies: the same ids, and a non-default source exactly where the preview counts an override.
    for (const [setting, field] of POLICY_SETTINGS) {
      expect(size.values[setting].value.policyId, `${where} ${setting}`).toBe(row.businessPolicySelection![field]);
      expect(size.values[setting].source !== "store_default", `${where} ${setting}`)
        .toBe(row.businessPolicySelection!.overriddenFields.includes(field));
    }

    // Store shelf: the row shows the shelves its listing intent sends. A blocked size has no intent and
    // shows none (as before PR 8b), while the sheet still says which shelf it would get.
    expect(row.storeCategoryNames, where).toStrictEqual(row.listingIntent ? size.values.storeShelf.value.names : []);

    // Description: the row's description is its content's; the sheet's template and main text are its parts.
    const content = contents.get(row.productVariantId)!;
    expect(content.evidenceHash, where).toBe(row.contentEvidenceHash);
    if (row.listingIntent) expect(row.listingIntent.description, where).toBe(content.descriptionHtml);
    const own = ownMainText(store, layerRows, candidate);
    expect(content.source, where).toBe(own === null ? "catalog" : "custom");
    expect(size.values.mainText.key, where).toBe(own === null ? "catalog" : sha256(own));
    const template = size.values.descriptionTemplate;
    if (template.value.groupConflict) {
      expect(content.issues, where).toContain("listing_content_template_conflict");
      expect(content.templateName, where).toBeNull();
      continue;
    }
    expect(content.templateName, where).toBe(template.source === "group_rule" ? template.ruleName : TEMPLATE_LABEL_OF_SOURCE[template.source]);
    // descriptionHtml = text above + main text + text below; the sheet keys the template by its two parts.
    const body = own === null ? content.catalogHtml : textDescriptionHtml(own);
    const at = content.descriptionHtml.indexOf(body);
    expect(at, where).toBeGreaterThanOrEqual(0);
    expect(sha256(JSON.stringify([content.descriptionHtml.slice(0, at), content.descriptionHtml.slice(at + body.length)])), where)
      .toBe(template.key);
  }
  return preview.rows.map((row) => row.productVariantId);
}
