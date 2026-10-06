import {
  LISTING_SETTINGS_PAGE_SIZE,
  listingSettingsPricesInputSchema,
  listingSettingsProductsInputSchema,
  listingSettingsStoreInputSchema,
  type ListingSettingsPricesResponse,
  type ListingSettingsProductsResponse,
  type ListingSettingsSummary,
} from "../../../../shared/dropship/listing-settings";
import { DropshipError } from "../domain/errors";
import {
  buildListingSettingsFacts,
  buildListingSettingsStoreDefaults,
  buildListingSettingsSummary,
  buildTooLargeListingSettingsSummary,
  selectListingSettingsPrices,
  selectListingSettingsProducts,
  type ListingSettingsFacts,
  type ListingSettingsInputs,
} from "./dropship-listing-settings-facts";
import type { DropshipListingStoreContext } from "./dropship-listing-preview-service";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";

/**
 * Read-only listing settings views (Listing settings design 8.4). Nothing here
 * writes or calls eBay. Each request reads the store's settings fingerprint
 * (one small query) and reuses the views built for that fingerprint, so a
 * save on any server shows on the next read.
 */

/** Costs and catalog facts have no revision to key on; the design lets them be this old. */
export const LISTING_SETTINGS_CACHE_TTL_MS = 60_000;
/**
 * The cache holds at most this many sizes across all stores, so a few large
 * selections cannot hold unbounded memory: the built views take about 1 KB a
 * size (measured at 10,000 sizes), so about 20 MB in all. Two stores at the
 * 10,000-size limit fit. The least recently used store leaves first.
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
}

export interface DropshipListingSettingsServiceDependencies {
  repository: ListingSettingsRepository;
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

function storeNotFound(storeConnectionId: number): DropshipError {
  return new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.", { storeConnectionId });
}
