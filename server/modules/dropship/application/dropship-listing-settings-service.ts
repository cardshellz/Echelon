import {
  LISTING_SETTINGS_PAGE_SIZE,
  listingSettingsCategoryInputSchema,
  listingSettingsPricesInputSchema,
  listingSettingsProductIdsInputSchema,
  listingSettingsProductInputSchema,
  listingSettingsProductsInputSchema,
  listingSettingsStoreInputSchema,
  listingSettingsUpdatedProductsInputSchema,
  type ListingSettingsCategoriesResponse,
  type ListingSettingsCategoryDetail,
  type ListingSettingsPricesResponse,
  type ListingSettingsProductDetail,
  type ListingSettingsProductIdsResponse,
  type ListingSettingsProductOwnSettings,
  type ListingSettingsProductsResponse,
  type ListingSettingsSummary,
  type ListingSettingsUpdatedProductsResponse,
} from "../../../../shared/dropship/listing-settings";
import type { ProductListingSettingRow } from "../../../../shared/dropship/listing-setting-values";
import { DropshipError } from "../domain/errors";
import {
  buildListingSettingsFacts,
  buildListingSettingsStoreDefaults,
  buildListingSettingsSummary,
  buildTooLargeListingSettingsSummary,
  listingSettingsStockUnits,
  productOwnSettingsView,
  selectListingSettingsCategories,
  selectListingSettingsCategory,
  selectListingSettingsPrices,
  selectListingSettingsProduct,
  selectListingSettingsProductIds,
  selectListingSettingsProducts,
  selectListingSettingsUpdatedProducts,
  type ListingSettingsFacts,
  type ListingSettingsInputs,
  type ListingSettingsProductCatalog,
  type ListingSettingsProductSelection,
} from "./dropship-listing-settings-facts";
import type { DropshipListingPreviewRepository, DropshipListingStoreContext } from "./dropship-listing-preview-service";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";
import type { DropshipAtpProvider } from "./dropship-selection-atp-service";

/**
 * Read-only listing settings views (Listing settings design 8.4). Nothing here
 * writes or calls eBay. Each request reads the store's settings fingerprint
 * (one small query) and reuses the views built for that fingerprint, so a
 * save on any server shows on the next read. One product's view adds its
 * sizes' stock, read live and never cached; one product's own settings add
 * its own settings row, read live and never cached (PR 10).
 */

/** Costs and catalog facts have no revision to key on; the design lets them be this old. */
export const LISTING_SETTINGS_CACHE_TTL_MS = 60_000;
/**
 * The cache holds at most this many sizes across all stores, so a few large
 * selections cannot hold unbounded memory: the built views take under 1 KB a
 * size (about 0.7 KB measured at 10,000 sizes), so under 20 MB in all. Two
 * stores at the 10,000-size limit fit. The least recently used store leaves first.
 */
export const LISTING_SETTINGS_CACHE_MAX_SIZES = 20_000;

export type ListingSettingsStoreLevelInputs = Pick<ListingSettingsInputs, "pricing" | "listingConfig" | "ebayCategoryRules" | "content">;

export type ListingSettingsLoad =
  | { state: "ok"; fingerprint: string; inputs: ListingSettingsInputs; costReadFailed: boolean }
  | { state: "too_large"; fingerprint: string; store: DropshipListingStoreContext; storeLevel: ListingSettingsStoreLevelInputs }
  | { state: "not_ebay"; fingerprint: string; store: DropshipListingStoreContext };

export interface ListingSettingsRepository {
  /** The store's settings fingerprint, or null when the member's vendor does not own the store. One small query. */
  readFingerprint(input: { memberId: string; storeConnectionId: number }): Promise<string | null>;
  /**
   * Everything the views are built from, with the fingerprint, read in one
   * read-only snapshot. Null when the member's vendor does not own the store.
   */
  load(input: { memberId: string; storeConnectionId: number; now: Date }): Promise<ListingSettingsLoad | null>;
  /**
   * One product's own settings row (null when it has none), read with PR 8a's
   * reader, and, only when that row holds a main text, the product's catalog
   * facts from one of `productVariantIds` the catalog still lists for it (each
   * gives the same product facts; null when it lists none), both in one
   * read-only snapshot with no lock (plan PR 10, 4.2). The cached views keep
   * no product row, only its revision.
   */
  readProductOwnSettings(input: {
    vendorId: number; storeConnectionId: number; productId: number; productVariantIds: readonly number[];
  }): Promise<ListingSettingsProductOwnRead>;
}

/** What one product's own settings are built from: its row and, for a main text, its catalog facts, from one snapshot. */
export interface ListingSettingsProductOwnRead {
  row: ProductListingSettingRow | null;
  catalog: ListingSettingsProductCatalog | null;
}

/** The reads one product's stock needs: the same quantity source and vendor caps the preview uses. */
export interface ListingSettingsStockSource {
  atp: DropshipAtpProvider;
  overrides: Pick<DropshipListingPreviewRepository, "listVariantOverrides">;
}

export interface DropshipListingSettingsServiceDependencies {
  repository: ListingSettingsRepository;
  stock: ListingSettingsStockSource;
  clock: DropshipClock;
  logger: DropshipLogger;
  cacheTtlMs?: number;
  cacheMaxSizes?: number;
}

type ListingSettingsView =
  | { state: "ok"; facts: ListingSettingsFacts; builtAt: Date }
  | { state: "too_large"; summary: ListingSettingsSummary }
  | { state: "not_ebay" };

interface CacheEntry { fingerprint: string; cachedAtMs: number; sizes: number; view: ListingSettingsView }

export class DropshipListingSettingsService {
  private readonly cache = new Map<string, CacheEntry>();
  /**
   * The builds in flight, by member, store and fingerprint. Reads that miss
   * the cache together (the drawer's detail and own read, PR 10; the step's
   * summary and lists) share one load and build instead of each running the
   * heaviest read here. An entry goes when its build settles, so a failed one
   * is never reused; a new fingerprint never joins an older build.
   */
  private readonly building = new Map<string, Promise<ListingSettingsView>>();
  private cachedSizes = 0;
  private readonly ttlMs: number;
  private readonly maxSizes: number;

  constructor(private readonly deps: DropshipListingSettingsServiceDependencies) {
    this.ttlMs = deps.cacheTtlMs ?? LISTING_SETTINGS_CACHE_TTL_MS;
    this.maxSizes = deps.cacheMaxSizes ?? LISTING_SETTINGS_CACHE_MAX_SIZES;
  }

  async getSummaryForMember(memberId: string, input: unknown): Promise<ListingSettingsSummary> {
    const { storeConnectionId } = listingSettingsStoreInputSchema.parse(input);
    const view = await this.viewFor(memberId, storeConnectionId);
    if (view.state === "too_large") return view.summary;
    const sized = requireEbay(view, storeConnectionId);
    return buildListingSettingsSummary(sized.facts, sized.builtAt);
  }

  async listPricesForMember(memberId: string, input: unknown): Promise<ListingSettingsPricesResponse> {
    const parsed = listingSettingsPricesInputSchema.parse(input);
    const view = requireSizes(await this.viewFor(memberId, parsed.storeConnectionId), parsed.storeConnectionId);
    const page = selectListingSettingsPrices(view.facts, parsed);
    return { storeConnectionId: parsed.storeConnectionId, page: parsed.page, pageSize: LISTING_SETTINGS_PAGE_SIZE,
      total: page.total, rows: page.rows, generatedAt: view.builtAt.toISOString() };
  }

  async listProductsForMember(memberId: string, input: unknown): Promise<ListingSettingsProductsResponse> {
    const parsed = listingSettingsProductsInputSchema.parse(input);
    const view = requireSizes(await this.viewFor(memberId, parsed.storeConnectionId), parsed.storeConnectionId);
    const page = selectListingSettingsProducts(view.facts, parsed);
    return { storeConnectionId: parsed.storeConnectionId, page: parsed.page, pageSize: LISTING_SETTINGS_PAGE_SIZE,
      total: page.total, rows: page.rows, generatedAt: view.builtAt.toISOString() };
  }

  /**
   * Every chosen product the filters match, with its own settings' revision,
   * from the same cached views (no extra read): "Select all N" and one
   * product's editor send these revisions back with a write.
   */
  async listProductIdsForMember(memberId: string, input: unknown): Promise<ListingSettingsProductIdsResponse> {
    const parsed = listingSettingsProductIdsInputSchema.parse(input);
    const view = requireSizes(await this.viewFor(memberId, parsed.storeConnectionId), parsed.storeConnectionId);
    return selectListingSettingsProductIds(view.facts, parsed);
  }

  /**
   * One chosen product's settings in full, with its sizes' stock read now.
   * Stock that can't be read leaves the settings readable (`stock.state`
   * "unavailable"); any other failure fails the request.
   */
  async getProductForMember(memberId: string, input: unknown): Promise<ListingSettingsProductDetail> {
    const parsed = listingSettingsProductInputSchema.parse(input);
    const view = requireSizes(await this.viewFor(memberId, parsed.storeConnectionId), parsed.storeConnectionId);
    const selection = selectListingSettingsProduct(view.facts, parsed.productId);
    if (!selection) throw productNotFound(parsed);
    const stock = await this.readStock(view.facts.store, selection);
    return {
      storeConnectionId: parsed.storeConnectionId,
      product: selection.product,
      settings: selection.settings,
      sizes: selection.sizes.map((size) => ({
        ...size,
        stockUnits: stock.units === null ? null : requiredUnits(stock.units, size.price.productVariantId),
      })),
      stock: stock.state,
      generatedAt: view.builtAt.toISOString(),
    };
  }

  /**
   * One chosen product's own settings, for its editor (plan PR 10, 4.2): the
   * same member check, cached views, 404 and 422 as the product's settings in
   * full. Its values, stored names and texts and its revision come from one
   * read of its own row made now, never from the cache, so a save shows at
   * once and the editor sends back the revision of the values it shows (W5's
   * `expectedRevisionId`). A main text is checked against the catalog facts
   * read in that same snapshot. No stock read, no eBay call, no write.
   */
  async getProductOwnSettings(memberId: string, input: unknown): Promise<ListingSettingsProductOwnSettings> {
    const parsed = listingSettingsProductInputSchema.parse(input);
    const view = requireSizes(await this.viewFor(memberId, parsed.storeConnectionId), parsed.storeConnectionId);
    const product = view.facts.products.find((row) => row.row.productId === parsed.productId);
    if (!product) throw productNotFound(parsed);
    const generatedAt = this.deps.clock.now();
    const read = await this.deps.repository.readProductOwnSettings({
      vendorId: view.facts.store.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      productId: parsed.productId,
      productVariantIds: product.sizes.map((size) => size.price.productVariantId),
    });
    // The catalog no longer lists any of the sizes the cached views chose (Card Shellz changed them within the
    // views' time limit): the product is not chosen now, as the next build of the views will say too.
    if (read.row?.values.mainText != null && read.catalog === null) throw productNotFound(parsed);
    return {
      storeConnectionId: parsed.storeConnectionId,
      ...productOwnSettingsView({ productId: parsed.productId, row: read.row, catalog: read.catalog }),
      generatedAt: generatedAt.toISOString(),
    };
  }

  /**
   * Every Card Shellz category that holds a chosen product, with its own
   * settings' revision and what it sets, from the same cached views. Read
   * only: no gate (a vendor who cannot change listings still reads them).
   */
  async listCategoriesForMember(memberId: string, input: unknown): Promise<ListingSettingsCategoriesResponse> {
    const { storeConnectionId } = listingSettingsStoreInputSchema.parse(input);
    const view = requireSizes(await this.viewFor(memberId, storeConnectionId), storeConnectionId);
    return { storeConnectionId, ...selectListingSettingsCategories(view.facts), generatedAt: view.builtAt.toISOString() };
  }

  /** One category's settings in full; 404 when none of the store's chosen products is in it (or it does not exist). */
  async getCategoryForMember(memberId: string, input: unknown): Promise<ListingSettingsCategoryDetail> {
    const parsed = listingSettingsCategoryInputSchema.parse(input);
    const view = requireSizes(await this.viewFor(memberId, parsed.storeConnectionId), parsed.storeConnectionId);
    const selection = selectListingSettingsCategory(view.facts, parsed.categoryId);
    if (!selection) {
      throw new DropshipError("DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND",
        "None of this category's products is chosen for this store.",
        { storeConnectionId: parsed.storeConnectionId, categoryId: parsed.categoryId });
    }
    return { storeConnectionId: parsed.storeConnectionId, ...selection, generatedAt: view.builtAt.toISOString() };
  }

  /**
   * "Card Shellz updated products" (plan PR 9, 10.3, 10.6): one page of the
   * chosen products Card Shellz moved to another category since the vendor
   * last confirmed it, or whose own text needs a check, and every moved
   * product's "Got it" item, from the same cached views. The category marks
   * are in the fingerprint (P29), so a first mark, or a "Got it" that
   * acknowledges at least one product, shows at once. A move itself is Card
   * Shellz's, seen within the cache's time limit, and so is a "Got it" whose
   * products all moved again: it writes no mark (W13 answers them as
   * `movedAgainProductIds`). Read only: no gate, no lock, no write.
   */
  async listUpdatedProductsForMember(memberId: string, input: unknown): Promise<ListingSettingsUpdatedProductsResponse> {
    const parsed = listingSettingsUpdatedProductsInputSchema.parse(input);
    const view = requireSizes(await this.viewFor(memberId, parsed.storeConnectionId), parsed.storeConnectionId);
    return { storeConnectionId: parsed.storeConnectionId, page: parsed.page, pageSize: LISTING_SETTINGS_PAGE_SIZE,
      ...selectListingSettingsUpdatedProducts(view.facts, parsed), generatedAt: view.builtAt.toISOString() };
  }

  private async readStock(store: DropshipListingStoreContext, selection: ListingSettingsProductSelection): Promise<{
    state: ListingSettingsProductDetail["stock"]; units: ReadonlyMap<number, number> | null;
  }> {
    const productVariantIds = selection.sizes.map((size) => size.price.productVariantId);
    try {
      const overrides = await this.deps.stock.overrides.listVariantOverrides({ vendorId: store.vendorId, productVariantIds });
      const snapshot = await this.deps.stock.atp.getVariantAtp(
        selection.sizes.map((size) => ({ productId: size.price.productId, productVariantId: size.price.productVariantId })),
        { storeConnectionId: store.storeConnectionId },
      );
      const units = listingSettingsStockUnits({ snapshot, overrides, productVariantIds });
      return { state: { state: "ok", checkedAt: this.deps.clock.now().toISOString() }, units };
    } catch (error) {
      // The stock reads report the failures they know (the allocation engine, the channel quantity, the
      // Dropship OMS channel's set-up) as DropshipErrors. Anything else, such as a lost database
      // connection, fails the request: it is a fault, not a missing number.
      if (!(error instanceof DropshipError)) throw error;
      const retryable = error.context?.retryable === true;
      this.deps.logger.warn({ code: "DROPSHIP_LISTING_SETTINGS_STOCK_UNAVAILABLE",
        message: "Listing settings showed a product without stock because the stock read failed.",
        context: { storeConnectionId: store.storeConnectionId, productId: selection.product.productId,
          sizes: productVariantIds.length, stockErrorCode: error.code, retryable } });
      return { state: { state: "unavailable", retryable, checkedAt: this.deps.clock.now().toISOString() }, units: null };
    }
  }

  private async viewFor(memberId: string, storeConnectionId: number): Promise<ListingSettingsView> {
    if (!memberId.trim()) throw new DropshipError("DROPSHIP_AUTH_REQUIRED", "Dropship authentication is required.");
    const key = `${memberId}:${storeConnectionId}`;
    const fingerprint = await this.deps.repository.readFingerprint({ memberId, storeConnectionId });
    if (fingerprint === null) throw storeNotFound(storeConnectionId);
    const nowMs = this.deps.clock.now().getTime();
    const cached = this.cache.get(key);
    if (cached && cached.fingerprint === fingerprint && nowMs - cached.cachedAtMs < this.ttlMs) {
      this.touch(key, cached);
      return cached.view;
    }
    const flightKey = `${key}:${fingerprint}`;
    const running = this.building.get(flightKey);
    if (running) return running;
    // One chain, returned to every caller that joins it, so its failure is always handled by them.
    const build = this.buildAndCache(memberId, storeConnectionId, key).finally(() => this.building.delete(flightKey));
    this.building.set(flightKey, build);
    return build;
  }

  /** Loads and builds the views, and caches them unless their costs couldn't be read. */
  private async buildAndCache(memberId: string, storeConnectionId: number, key: string): Promise<ListingSettingsView> {
    const now = this.deps.clock.now();
    const load = await this.deps.repository.load({ memberId, storeConnectionId, now });
    if (!load) throw storeNotFound(storeConnectionId);
    const view = buildView(load, now);
    if (load.state === "ok" && load.costReadFailed) {
      // A cost read that failed would show sizes as unpriced for the whole TTL; build it, show it, keep nothing.
      this.deps.logger.warn({ code: "DROPSHIP_LISTING_SETTINGS_COST_UNAVAILABLE",
        message: "Listing settings were built without .ops costs because the cost read failed; the view was not cached.",
        context: { storeConnectionId, sizes: load.inputs.candidates.length } });
      this.evict(key);
    } else {
      this.store(key, { fingerprint: load.fingerprint, cachedAtMs: now.getTime(),
        sizes: load.state === "ok" ? load.inputs.candidates.length : 0, view });
    }
    return view;
  }

  private touch(key: string, entry: CacheEntry): void {
    // Map order is insertion order; re-inserting marks the entry most recently used.
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private store(key: string, entry: CacheEntry): void {
    this.evict(key);
    if (entry.sizes > this.maxSizes) return;
    this.cache.set(key, entry);
    this.cachedSizes += entry.sizes;
    for (const [oldestKey] of this.cache) {
      if (this.cachedSizes <= this.maxSizes) break;
      this.evict(oldestKey);
    }
  }

  private evict(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    this.cachedSizes -= entry.sizes;
  }
}

function buildView(load: ListingSettingsLoad, now: Date): ListingSettingsView {
  switch (load.state) {
    case "ok": return { state: "ok", facts: buildListingSettingsFacts(load.inputs), builtAt: now };
    case "too_large": return { state: "too_large", summary: buildTooLargeListingSettingsSummary({
      store: load.store, storeDefaults: buildListingSettingsStoreDefaults(load.storeLevel), generatedAt: now }) };
    case "not_ebay": return { state: "not_ebay" };
  }
}

function requireEbay(view: ListingSettingsView, storeConnectionId: number): Extract<ListingSettingsView, { state: "ok" }> {
  if (view.state === "not_ebay") {
    throw new DropshipError("DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", "Listing settings work for eBay stores only.", { storeConnectionId });
  }
  if (view.state !== "ok") throw new Error(`Listing settings view state ${view.state} has no sizes.`);
  return view;
}

/** The lists need the sizes; over 10,000 of them, there are none to list. */
function requireSizes(view: ListingSettingsView, storeConnectionId: number): Extract<ListingSettingsView, { state: "ok" }> {
  if (view.state === "too_large") {
    throw new DropshipError("DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
      "More than 10,000 sizes are chosen for this store. Choose 10,000 or fewer to check their settings.", { storeConnectionId });
  }
  return requireEbay(view, storeConnectionId);
}

function requiredUnits(units: ReadonlyMap<number, number>, productVariantId: number): number {
  const value = units.get(productVariantId);
  if (value === undefined) throw new Error(`Listing settings has no stock for size ${productVariantId}.`);
  return value;
}

function productNotFound(input: { storeConnectionId: number; productId: number }): DropshipError {
  return new DropshipError("DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", "None of this product's sizes is chosen for this store.",
    { storeConnectionId: input.storeConnectionId, productId: input.productId });
}

function storeNotFound(storeConnectionId: number): DropshipError {
  return new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.", { storeConnectionId });
}
