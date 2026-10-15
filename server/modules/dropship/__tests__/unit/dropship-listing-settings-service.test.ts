import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  listingSettingsCategoriesResponseSchema,
  listingSettingsCategoryDetailSchema,
  listingSettingsProductDetailSchema,
  listingSettingsProductOwnSettingsSchema,
  listingSettingsUpdatedProductsResponseSchema,
} from "../../../../../shared/dropship/listing-settings";
import { productListingSettingRowSchema, type ProductListingSettingValues } from "../../../../../shared/dropship/listing-setting-values";
import { productCatalogHash } from "../../application/dropship-listing-content-resolver";
import { DropshipError } from "../../domain/errors";
import type { DropshipVendorVariantOverride } from "../../domain/vendor-selection";
import { prepareEbayCategoryRules, resolveEbayListingCategory } from "../../application/dropship-ebay-category-resolver";
import type { DropshipListingCatalogCandidate, DropshipListingStoreContext } from "../../application/dropship-listing-preview-service";
import type { ListingSettingsInputs } from "../../application/dropship-listing-settings-facts";
import { EMPTY_LISTING_SETTING_LAYERS } from "../../application/dropship-listing-setting-layers";
import {
  DropshipListingSettingsService,
  type ListingSettingsConversionLoad,
  type ListingSettingsLoad,
  type ListingSettingsProductOwnRead,
  type ListingSettingsRepository,
  type ListingSettingsStockSource,
} from "../../application/dropship-listing-settings-service";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type { DropshipAtpSnapshot } from "../../application/dropship-selection-atp-service";

const T0 = new Date("2026-10-06T12:00:00.000Z");

function candidate(productVariantId: number, productId = 501): DropshipListingCatalogCandidate {
  return {
    productId, productVariantId, productLineIds: [], category: "Toploaders", categoryId: null, ebayBrowseCategoryId: "183438",
    ebayBrowseCategoryName: "Toploaders", productIsActive: true, variantIsActive: true, variantUomType: "pack",
    unitsPerVariant: 1, defaultRetailPriceCents: 999, sku: `SKU-${productVariantId}`, productName: `Product ${productId}`,
    variantName: `Size ${productVariantId}`, title: "Title", description: "Text", brand: null, gtin: null, mpn: null,
    condition: "new", itemSpecifics: null, imageUrls: [], weightGrams: 10,
  };
}

const store: DropshipListingStoreContext = { vendorId: 7, vendorStatus: "active", entitlementStatus: "active",
  storeConnectionId: 5, storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true };
const emptyState = { revisionId: null, profile: null, updatedAt: null };

function inputs(candidates: DropshipListingCatalogCandidate[]): ListingSettingsInputs {
  const prepared = prepareEbayCategoryRules(null, null);
  const totals = new Map<number, number>();
  for (const row of candidates) totals.set(row.productId, (totals.get(row.productId) ?? 0) + 1);
  return {
    store, candidates, sizesTotalByProductId: totals, savedPrices: new Map(), existingListings: new Map(),
    pricing: emptyState, costs: new Map(), pricingPolicies: [], listingConfig: null, policyOverrides: new Map(),
    shelfAssignments: new Map(), ebayCategoryRules: emptyState,
    ebayCategories: new Map(candidates.map((row) => [row.productVariantId, resolveEbayListingCategory(row, prepared)])),
    content: emptyState, contentSettings: new Map(), pausedSince: new Map(),
    // No product or category rows (plan D1): the summary reads as it did before 8b.
    layers: EMPTY_LISTING_SETTING_LAYERS, categoryNames: new Map(),
    // No category marks: no product is moved (plan PR 9, 10.1).
    categoryMoves: { marks: new Map(), fromCategories: new Map(), fromCategoryNames: new Map() },
  };
}

class FakeRepository implements ListingSettingsRepository {
  fingerprint: string | null = "fp-1";
  next: ListingSettingsLoad | null = { state: "ok", fingerprint: "fp-1", inputs: inputs([candidate(11)]), costReadFailed: false };
  fingerprintReads: Array<{ memberId: string; storeConnectionId: number }> = [];
  loads: Array<{ memberId: string; storeConnectionId: number; now: Date }> = [];
  /** While set, a load waits for it (reads that miss the cache together); `loadError` makes a load fail. */
  gate: Promise<void> | null = null;
  loadError: Error | null = null;
  async readFingerprint(input: { memberId: string; storeConnectionId: number }) {
    this.fingerprintReads.push(input);
    return this.fingerprint;
  }
  async load(input: { memberId: string; storeConnectionId: number; now: Date }) {
    this.loads.push(input);
    if (this.gate) await this.gate;
    if (this.loadError) throw this.loadError;
    return this.next;
  }
  /** The views never read the conversion's inputs (PR 11): its dry run has its own test file. */
  async loadConversionInputs(): Promise<ListingSettingsConversionLoad | null> {
    throw new Error("A listing settings view read the rules conversion's inputs.");
  }
  ownRead: ListingSettingsProductOwnRead | Error = { row: null, catalog: null };
  ownReads: Array<{ vendorId: number; storeConnectionId: number; productId: number; productVariantIds: readonly number[] }> = [];
  async readProductOwnSettings(input: { vendorId: number; storeConnectionId: number; productId: number; productVariantIds: readonly number[] }) {
    this.ownReads.push(input);
    if (this.ownRead instanceof Error) throw this.ownRead;
    return this.ownRead;
  }
}

/** Stock as the preview reads it: the quantity source and the vendor's caps. */
class FakeStock implements ListingSettingsStockSource {
  snapshot: DropshipAtpSnapshot | Error = { authority: "legacy", quantities: new Map([[11, 7]]) };
  caps: DropshipVendorVariantOverride[] = [];
  atpReads: Array<{ targets: ReadonlyArray<{ productId: number; productVariantId: number }>; scope: unknown }> = [];
  capReads: Array<{ vendorId: number; productVariantIds: readonly number[] }> = [];
  atp = {
    getVariantAtp: async (targets: ReadonlyArray<{ productId: number; productVariantId: number }>, scope?: { storeConnectionId?: number }) => {
      this.atpReads.push({ targets, scope });
      if (this.snapshot instanceof Error) throw this.snapshot;
      return this.snapshot;
    },
  };
  overrides = {
    listVariantOverrides: async (input: { vendorId: number; productVariantIds: readonly number[] }) => {
      this.capReads.push(input);
      return this.caps;
    },
  };
}

let repository: FakeRepository;
let stock: FakeStock;
let now: Date;
let warnings: DropshipLogEvent[];
let service: DropshipListingSettingsService;

function makeService(options: { cacheMaxSizes?: number } = {}) {
  return new DropshipListingSettingsService({
    repository, stock, clock: { now: () => now },
    logger: { info: vi.fn(), warn: (event) => warnings.push(event), error: vi.fn() },
    ...options,
  });
}

beforeEach(() => {
  repository = new FakeRepository();
  stock = new FakeStock();
  now = T0;
  warnings = [];
  service = makeService();
});

describe("listing settings service", () => {
  it("builds the summary from one snapshot read and stamps when it was built", async () => {
    const summary = await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    expect(summary).toMatchObject({ storeConnectionId: 5, catalog: { state: "ok", products: 1, sizes: 1 }, generatedAt: T0.toISOString() });
    expect(repository.loads).toEqual([{ memberId: "member-1", storeConnectionId: 5, now: T0 }]);
  });

  it("reuses the views while the fingerprint is unchanged, inside the time limit", async () => {
    await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    now = new Date(T0.getTime() + 59_999);
    await service.listPricesForMember("member-1", { storeConnectionId: 5 });
    await service.listProductsForMember("member-1", { storeConnectionId: 5 });
    expect(repository.loads).toHaveLength(1);
    // The fingerprint is read on every request, so a save anywhere is seen at once.
    expect(repository.fingerprintReads).toHaveLength(3);
  });

  it("reads again when the fingerprint changes", async () => {
    await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    repository.fingerprint = "fp-2";
    repository.next = { state: "ok", fingerprint: "fp-2", inputs: inputs([candidate(11), candidate(12)]), costReadFailed: false };
    const summary = await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    expect(summary.catalog).toEqual({ state: "ok", products: 1, sizes: 2 });
    expect(repository.loads).toHaveLength(2);
  });

  it("reads again once the views are 60 seconds old", async () => {
    await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    now = new Date(T0.getTime() + 60_000);
    await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    expect(repository.loads).toHaveLength(2);
  });

  it("shares one load between reads that miss the cache at the same time, and keeps no failed one (PR 10)", async () => {
    let open: () => void = () => undefined;
    repository.gate = new Promise((resolve) => { open = resolve; });
    // The drawer's two reads and the step's summary, all at once on an empty cache.
    const reads = Promise.all([
      service.getProductForMember("member-1", { storeConnectionId: 5, productId: 501 }),
      service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 501 }),
      service.getSummaryForMember("member-1", { storeConnectionId: 5 }),
    ]);
    await vi.waitFor(() => expect(repository.fingerprintReads).toHaveLength(3));
    open();
    const [detail, own, summary] = await reads;
    expect([detail.product.productId, own.productId, summary.catalog]).toEqual([501, 501, { state: "ok", products: 1, sizes: 1 }]);
    expect(repository.loads).toHaveLength(1);
    // Then cached: one more read loads nothing.
    await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    expect(repository.loads).toHaveLength(1);

    // A failed build fails every read that joined it, and the next read loads again.
    repository.gate = null;
    repository.fingerprint = "fp-2";
    repository.loadError = new Error("connection reset");
    const failed = await Promise.allSettled([
      service.getSummaryForMember("member-1", { storeConnectionId: 5 }),
      service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 501 }),
    ]);
    expect(failed.map((result) => (result.status === "rejected" ? String(result.reason) : "ok"))).toEqual(["Error: connection reset", "Error: connection reset"]);
    expect(repository.loads).toHaveLength(2);
    repository.loadError = null;
    repository.next = { state: "ok", fingerprint: "fp-2", inputs: inputs([candidate(11)]), costReadFailed: false };
    await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    expect(repository.loads).toHaveLength(3);
  });

  it("keeps each member's and store's views apart", async () => {
    await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    await service.getSummaryForMember("member-2", { storeConnectionId: 5 });
    expect(repository.loads.map((load) => load.memberId)).toEqual(["member-1", "member-2"]);
  });

  it("shows views built without .ops costs once, logs it, and does not keep them", async () => {
    repository.next = { state: "ok", fingerprint: "fp-1", inputs: inputs([candidate(11)]), costReadFailed: true };
    await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    expect(repository.loads).toHaveLength(2);
    expect(warnings.map((event) => event.code)).toEqual(["DROPSHIP_LISTING_SETTINGS_COST_UNAVAILABLE", "DROPSHIP_LISTING_SETTINGS_COST_UNAVAILABLE"]);
    expect(warnings[0].context).toEqual({ storeConnectionId: 5, sizes: 1 });
  });

  it("keeps no more sizes than its budget, dropping the least recently used store first", async () => {
    service = makeService({ cacheMaxSizes: 3 });
    const loadFor = (sizes: number) => ({ state: "ok" as const, fingerprint: "fp-1", costReadFailed: false,
      inputs: inputs(Array.from({ length: sizes }, (_, index) => candidate(100 + index))) });
    repository.next = loadFor(2);
    await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    await service.getSummaryForMember("member-2", { storeConnectionId: 5 });
    // Two stores of two sizes are over a budget of three: member-1's views left first.
    await service.getSummaryForMember("member-2", { storeConnectionId: 5 });
    await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    expect(repository.loads.map((load) => load.memberId)).toEqual(["member-1", "member-2", "member-1"]);
    // Views larger than the whole budget are never kept.
    repository.next = loadFor(4);
    await service.getSummaryForMember("member-3", { storeConnectionId: 5 });
    await service.getSummaryForMember("member-3", { storeConnectionId: 5 });
    expect(repository.loads.filter((load) => load.memberId === "member-3")).toHaveLength(2);
  });

  it("gives the store defaults and no lists for a selection over 10,000 sizes", async () => {
    repository.next = { state: "too_large", fingerprint: "fp-1", store,
      storeLevel: { pricing: emptyState, listingConfig: null, ebayCategoryRules: emptyState, content: emptyState } };
    await expect(service.getSummaryForMember("member-1", { storeConnectionId: 5 }))
      .resolves.toMatchObject({ catalog: { state: "too_large", limit: 10_000 }, counts: null, rail: { state: "too_many_sizes" } });
    await expect(service.listPricesForMember("member-1", { storeConnectionId: 5 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", context: { storeConnectionId: 5 } });
    await expect(service.listProductsForMember("member-1", { storeConnectionId: 5 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE" });
    await expect(service.listProductIdsForMember("member-1", { storeConnectionId: 5 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", context: { storeConnectionId: 5 } });
  });

  it("lists product ids and their settings revisions from the cached views, with the filters (plan PR 9, 4.2)", async () => {
    const productRow = (productId: number, revisionId: number) => ({ storeConnectionId: 5, productId, revisionId,
      updatedAt: T0.toISOString(), values: { price: null, ebayCategory: null, storeShelf: { mode: "none" as const }, shippingPolicy: null,
        returnPolicy: null, paymentPolicy: null, textAbove: null, textBelow: null, mainText: null } });
    const load = inputs([{ ...candidate(11, 501), categoryId: 3 }, { ...candidate(21, 502), categoryId: 4 }]);
    repository.next = { state: "ok", fingerprint: "fp-1", costReadFailed: false,
      inputs: { ...load, layers: { products: new Map([[501, productRow(501, 77)]]), categories: new Map() } } };

    await expect(service.listProductIdsForMember("member-1", { storeConnectionId: 5 }))
      .resolves.toEqual({ total: 2, rows: [{ productId: 501, revisionId: 77 }, { productId: 502, revisionId: null }] });
    await expect(service.listProductIdsForMember("member-1", { storeConnectionId: 5, categoryId: 4 }))
      .resolves.toEqual({ total: 1, rows: [{ productId: 502, revisionId: null }] });
    await expect(service.listProductIdsForMember("member-1", { storeConnectionId: 5, productId: 501, search: "product 501" }))
      .resolves.toEqual({ total: 1, rows: [{ productId: 501, revisionId: 77 }] });
    await expect(service.listPricesForMember("member-1", { storeConnectionId: 5, categoryId: 3 }))
      .resolves.toMatchObject({ total: 1, rows: [{ productVariantId: 11 }] });
    await expect(service.listProductsForMember("member-1", { storeConnectionId: 5, categoryId: 3 }))
      .resolves.toMatchObject({ total: 1, rows: [{ productId: 501 }] });
    // One snapshot read serves them all (no new database read for the id list).
    expect(repository.loads).toHaveLength(1);
  });

  it("refuses id-list input outside its contract", async () => {
    for (const input of [{ storeConnectionId: 5, page: 0 }, { storeConnectionId: 5, show: "paused" }, { storeConnectionId: 5, productId: 0 },
      { storeConnectionId: 5, categoryId: Number.NaN }]) {
      await expect(service.listProductIdsForMember("member-1", input)).rejects.toBeInstanceOf(ZodError);
    }
    expect(repository.loads).toHaveLength(0);
  });

  it("refuses a store that is not on eBay", async () => {
    repository.next = { state: "not_ebay", fingerprint: "fp-1", store: { ...store, platform: "shopify" } };
    await expect(service.getSummaryForMember("member-1", { storeConnectionId: 5 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY" });
    await expect(service.listPricesForMember("member-1", { storeConnectionId: 5 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY" });
  });

  it("refuses a store the member's vendor does not own, before and during the load", async () => {
    repository.fingerprint = null;
    await expect(service.getSummaryForMember("member-1", { storeConnectionId: 5 }))
      .rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED", context: { storeConnectionId: 5 } });
    expect(repository.loads).toHaveLength(0);
    repository.fingerprint = "fp-1";
    repository.next = null;
    await expect(service.getSummaryForMember("member-1", { storeConnectionId: 5 }))
      .rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
  });

  it("refuses a blank member and bad input before reading anything", async () => {
    await expect(service.getSummaryForMember("  ", { storeConnectionId: 5 })).rejects.toMatchObject({ code: "DROPSHIP_AUTH_REQUIRED" });
    await expect(service.getSummaryForMember("member-1", { storeConnectionId: Number.NaN })).rejects.toBeInstanceOf(ZodError);
    await expect(service.listPricesForMember("member-1", { storeConnectionId: 5, page: 200 })).rejects.toBeInstanceOf(ZodError);
    await expect(service.listProductsForMember("member-1", { storeConnectionId: 5, show: ["all"] })).rejects.toBeInstanceOf(ZodError);
    expect(repository.fingerprintReads).toHaveLength(0);
  });

  it("pages and filters the lists from the same views", async () => {
    repository.next = { state: "ok", fingerprint: "fp-1", costReadFailed: false,
      inputs: inputs(Array.from({ length: 60 }, (_, index) => candidate(1_000 + index, 1 + index))) };
    const prices = await service.listPricesForMember("member-1", { storeConnectionId: 5, page: 1 });
    expect(prices).toMatchObject({ storeConnectionId: 5, page: 1, pageSize: 50, total: 60, generatedAt: T0.toISOString() });
    expect(prices.rows).toHaveLength(10);
    const products = await service.listProductsForMember("member-1", { storeConnectionId: 5, search: "product 7" });
    expect(products.rows.map((row) => row.productId)).toEqual([7]);
  });
});

describe("listing settings service: one product", () => {
  const T1 = new Date(T0.getTime() + 30_000);

  it("gives one product's settings with its sizes' stock, read now", async () => {
    repository.next = { state: "ok", fingerprint: "fp-1", inputs: inputs([candidate(11), candidate(12)]), costReadFailed: false };
    stock.snapshot = { authority: "legacy", quantities: new Map([[11, 40], [12, 0]]) };
    stock.caps = [{ productVariantId: 11, enabledOverride: true, marketplaceQuantityCap: 5 }];
    const detail = await service.getProductForMember("member-1", { storeConnectionId: 5, productId: 501 });
    expect(listingSettingsProductDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.sizes.map((size) => [size.price.productVariantId, size.stockUnits])).toEqual([[11, 5], [12, 0]]);
    expect(detail).toMatchObject({ storeConnectionId: 5, product: { productId: 501, sizesChosen: 2 },
      stock: { state: "ok", checkedAt: T0.toISOString() }, generatedAt: T0.toISOString() });
    expect(stock.capReads).toEqual([{ vendorId: 7, productVariantIds: [11, 12] }]);
    expect(stock.atpReads).toEqual([{ targets: [{ productId: 501, productVariantId: 11 }, { productId: 501, productVariantId: 12 }],
      scope: { storeConnectionId: 5 } }]);
  });

  it("reads stock on every request but the settings once", async () => {
    await service.getProductForMember("member-1", { storeConnectionId: 5, productId: 501 });
    now = T1;
    const detail = await service.getProductForMember("member-1", { storeConnectionId: 5, productId: 501 });
    expect(repository.loads).toHaveLength(1);
    expect(stock.atpReads).toHaveLength(2);
    expect(detail).toMatchObject({ stock: { state: "ok", checkedAt: T1.toISOString() }, generatedAt: T0.toISOString() });
  });

  it("shows the settings without stock when stock can't be read, and says whether trying again may help", async () => {
    stock.snapshot = new DropshipError("DROPSHIP_ALLOCATION_UNAVAILABLE", "Channel Allocation could not be computed.", { retryable: true });
    const transient = await service.getProductForMember("member-1", { storeConnectionId: 5, productId: 501 });
    expect(listingSettingsProductDetailSchema.safeParse(transient).success).toBe(true);
    expect(transient.stock).toEqual({ state: "unavailable", retryable: true, checkedAt: T0.toISOString() });
    expect(transient.sizes.map((size) => size.stockUnits)).toEqual([null]);
    stock.snapshot = new DropshipError("DROPSHIP_ALLOCATION_WAREHOUSE_SCOPE_REQUIRED", "No warehouse.", { retryable: false });
    const blocked = await service.getProductForMember("member-1", { storeConnectionId: 5, productId: 501 });
    expect(blocked.stock).toMatchObject({ state: "unavailable", retryable: false });
    expect(warnings.map((event) => [event.code, event.context])).toEqual([
      ["DROPSHIP_LISTING_SETTINGS_STOCK_UNAVAILABLE", { storeConnectionId: 5, productId: 501, sizes: 1,
        stockErrorCode: "DROPSHIP_ALLOCATION_UNAVAILABLE", retryable: true }],
      ["DROPSHIP_LISTING_SETTINGS_STOCK_UNAVAILABLE", { storeConnectionId: 5, productId: 501, sizes: 1,
        stockErrorCode: "DROPSHIP_ALLOCATION_WAREHOUSE_SCOPE_REQUIRED", retryable: false }],
    ]);
  });

  it("fails the request when the stock read fails in a way no provider reports", async () => {
    stock.snapshot = new Error("connection reset");
    await expect(service.getProductForMember("member-1", { storeConnectionId: 5, productId: 501 })).rejects.toThrow("connection reset");
    expect(warnings).toEqual([]);
  });

  it("refuses a product none of whose sizes is chosen, without reading stock", async () => {
    await expect(service.getProductForMember("member-1", { storeConnectionId: 5, productId: 999 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", context: { storeConnectionId: 5, productId: 999 } });
    expect(stock.atpReads).toHaveLength(0);
  });

  it("refuses bad input, a selection over 10,000 sizes and a store not on eBay", async () => {
    await expect(service.getProductForMember("member-1", { storeConnectionId: 5, productId: Number.NaN })).rejects.toBeInstanceOf(ZodError);
    await expect(service.getProductForMember("member-1", { storeConnectionId: 5, productId: 501, extra: 1 })).rejects.toBeInstanceOf(ZodError);
    expect(repository.fingerprintReads).toHaveLength(0);
    repository.next = { state: "too_large", fingerprint: "fp-1", store,
      storeLevel: { pricing: emptyState, listingConfig: null, ebayCategoryRules: emptyState, content: emptyState } };
    await expect(service.getProductForMember("member-1", { storeConnectionId: 5, productId: 501 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE" });
    repository.fingerprint = "fp-2";
    repository.next = { state: "not_ebay", fingerprint: "fp-2", store: { ...store, platform: "shopify" } };
    await expect(service.getProductForMember("member-1", { storeConnectionId: 5, productId: 501 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY" });
    expect(stock.atpReads).toHaveLength(0);
  });

  it("lists the categories and gives one category's settings from the same cached views, with no stock read (plan 8.3, 8.11)", async () => {
    const withCategories = inputs([{ ...candidate(11), categoryId: 3 }, { ...candidate(12, 502), categoryId: 3 }, candidate(13, 503)]);
    repository.next = { state: "ok", fingerprint: "fp-1", costReadFailed: false,
      inputs: { ...withCategories, categoryNames: new Map([[3, "Toploaders"]]) } };

    const list = await service.listCategoriesForMember("member-1", { storeConnectionId: 5 });
    const one = await service.getCategoryForMember("member-1", { storeConnectionId: 5, categoryId: 3 });

    expect(listingSettingsCategoriesResponseSchema.parse(list)).toEqual({ storeConnectionId: 5,
      categories: [{ categoryId: 3, name: "Toploaders", productCount: 2, revisionId: null, setFields: [] }],
      uncategorizedProductCount: 1, generatedAt: T0.toISOString() });
    expect(listingSettingsCategoryDetailSchema.parse(one)).toMatchObject({ storeConnectionId: 5, categoryId: 3, name: "Toploaders",
      productCount: 2, revisionId: null, ownValues: [], generatedAt: T0.toISOString() });
    expect(one.examples.map((size) => size.productVariantId)).toEqual([11, 12]);
    expect(repository.loads).toHaveLength(1);
    expect(stock.atpReads).toHaveLength(0);
  });

  it("refuses a category no chosen product is in, bad input, a selection over 10,000 sizes and a store not on eBay", async () => {
    await expect(service.getCategoryForMember("member-1", { storeConnectionId: 5, categoryId: 9 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", context: { storeConnectionId: 5, categoryId: 9 } });
    await expect(service.getCategoryForMember("member-1", { storeConnectionId: 5, categoryId: 0 })).rejects.toBeInstanceOf(ZodError);
    await expect(service.listCategoriesForMember("member-1", { storeConnectionId: 5, page: 0 })).rejects.toBeInstanceOf(ZodError);
    repository.fingerprint = "fp-2";
    repository.next = { state: "too_large", fingerprint: "fp-2", store,
      storeLevel: { pricing: emptyState, listingConfig: null, ebayCategoryRules: emptyState, content: emptyState } };
    await expect(service.listCategoriesForMember("member-1", { storeConnectionId: 5 })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE" });
    await expect(service.getCategoryForMember("member-1", { storeConnectionId: 5, categoryId: 3 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE" });
    repository.fingerprint = "fp-3";
    repository.next = { state: "not_ebay", fingerprint: "fp-3", store: { ...store, platform: "shopify" } };
    await expect(service.listCategoriesForMember("member-1", { storeConnectionId: 5 })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY" });
  });
});

describe("listing settings service: Card Shellz updated products (plan PR 9, 10.3, 10.6)", () => {
  /** Product 501 confirmed in no category and now in category 3; product 502 never marked. */
  function movedLoad(fingerprint: string, marks: Array<[number, number | null]>): ListingSettingsLoad {
    const base = inputs([{ ...candidate(11), categoryId: 3 }, { ...candidate(12, 502), categoryId: 3 }]);
    return { state: "ok", fingerprint, costReadFailed: false, inputs: { ...base, categoryNames: new Map([[3, "Toploaders"]]),
      categoryMoves: { marks: new Map(marks.map(([productId, categoryId]) => [productId,
        { storeConnectionId: 5, productId, categoryId, seenAt: T0.toISOString() }])), fromCategories: new Map(), fromCategoryNames: new Map() } } };
  }

  it("gives a page of the moved products and every Got it item from the cached views, read again when a mark changes the fingerprint", async () => {
    repository.next = movedLoad("fp-1", [[501, null]]);

    const first = await service.listUpdatedProductsForMember("member-1", { storeConnectionId: 5 });

    expect(listingSettingsUpdatedProductsResponseSchema.parse(first)).toEqual({ storeConnectionId: 5, page: 0, pageSize: 50, total: 1,
      rows: [{ productId: 501, productName: "Product 501", ownTextNeedsCheck: false,
        move: { from: { categoryId: null, name: null }, to: { categoryId: 3, name: "Toploaders" }, changedFields: [] } }],
      moves: { total: 1, items: [{ productId: 501, shownCategoryId: 3 }] }, generatedAt: T0.toISOString() });
    // The summary and the lists share the cached views.
    await service.getSummaryForMember("member-1", { storeConnectionId: 5 });
    expect(repository.loads).toHaveLength(1);
    expect((await service.listUpdatedProductsForMember("member-1", { storeConnectionId: 5, page: 1 })).rows).toEqual([]);
    expect(repository.loads).toHaveLength(1);

    // A Got it moves the mark: a new fingerprint, so the next read is built again, inside the time limit.
    repository.fingerprint = "fp-2";
    repository.next = movedLoad("fp-2", [[501, 3]]);
    const after = await service.listUpdatedProductsForMember("member-1", { storeConnectionId: 5 });
    expect(after).toMatchObject({ total: 0, rows: [], moves: { total: 0, items: [] } });
    expect(repository.loads).toHaveLength(2);
  });

  it("refuses bad input before reading, a selection over 10,000 sizes and a store not on eBay", async () => {
    await expect(service.listUpdatedProductsForMember("member-1", { storeConnectionId: 5, page: -1 })).rejects.toBeInstanceOf(ZodError);
    await expect(service.listUpdatedProductsForMember("member-1", { storeConnectionId: 5, show: "all" })).rejects.toBeInstanceOf(ZodError);
    await expect(service.listUpdatedProductsForMember("member-1", { storeConnectionId: 0 })).rejects.toBeInstanceOf(ZodError);
    expect(repository.fingerprintReads).toHaveLength(0);
    await expect(service.listUpdatedProductsForMember(" ", { storeConnectionId: 5 })).rejects.toMatchObject({ code: "DROPSHIP_AUTH_REQUIRED" });
    repository.next = { state: "too_large", fingerprint: "fp-1", store,
      storeLevel: { pricing: emptyState, listingConfig: null, ebayCategoryRules: emptyState, content: emptyState } };
    await expect(service.listUpdatedProductsForMember("member-1", { storeConnectionId: 5 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", context: { storeConnectionId: 5 } });
    repository.fingerprint = "fp-2";
    repository.next = { state: "not_ebay", fingerprint: "fp-2", store: { ...store, platform: "shopify" } };
    await expect(service.listUpdatedProductsForMember("member-1", { storeConnectionId: 5 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY" });
    repository.fingerprint = null;
    await expect(service.listUpdatedProductsForMember("member-1", { storeConnectionId: 5 }))
      .rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(stock.atpReads).toHaveLength(0);
  });
});

describe("listing settings service: one product's own settings (plan PR 10, 4.2)", () => {
  const T1 = new Date(T0.getTime() + 30_000);
  const values = (patch: Partial<ProductListingSettingValues>): ProductListingSettingValues => ({ price: null, ebayCategory: null,
    storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null, textAbove: null, textBelow: null, mainText: null, ...patch });
  const ownRow = (revisionId: number, patch: Partial<ProductListingSettingValues>) => productListingSettingRowSchema.parse({
    storeConnectionId: 5, productId: 501, revisionId, updatedAt: T0.toISOString(), values: values(patch) });
  const catalogOf = (row: DropshipListingCatalogCandidate) =>
    ({ productId: row.productId, description: row.description, brand: row.brand, condition: row.condition, itemSpecifics: row.itemSpecifics });

  it("gives the product's own values, stored names and revision from its row read now, never from the cached views", async () => {
    repository.next = { state: "ok", fingerprint: "fp-1", inputs: inputs([candidate(12), candidate(11), candidate(21, 502)]), costReadFailed: false };
    repository.ownRead = { row: ownRow(77, { shippingPolicy: { id: "F9", name: "Free shipping" }, returnPolicy: { id: "R9", name: null },
      storeShelf: { mode: "none" } }), catalog: null };

    const own = await service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 501 });

    expect(listingSettingsProductOwnSettingsSchema.parse(own)).toEqual({ storeConnectionId: 5, productId: 501, revisionId: 77,
      own: { price: null, ebayCategory: null, storeShelf: { mode: "none" }, shippingPolicy: { id: "F9", name: "Free shipping" },
        returnPolicy: { id: "R9", name: null }, paymentPolicy: null, textAbove: null, textBelow: null, mainText: null },
      generatedAt: T0.toISOString() });
    // The store's vendor, the product and its chosen sizes (as the views list them) go to the one row read.
    expect(repository.ownReads).toEqual([{ vendorId: 7, storeConnectionId: 5, productId: 501, productVariantIds: [11, 12] }]);

    // A save between two reads shows at once: the row is read on every request, the views once.
    now = T1;
    repository.ownRead = { row: ownRow(78, { shippingPolicy: null }), catalog: null };
    const after = await service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 501 });
    expect(after).toMatchObject({ revisionId: 78, own: { shippingPolicy: null }, generatedAt: T1.toISOString() });
    expect(repository.loads).toHaveLength(1);
    expect(repository.ownReads).toHaveLength(2);
  });

  it("gives nulls and no revision for a product with no own row", async () => {
    const own = await service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 501 });
    expect(own).toMatchObject({ productId: 501, revisionId: null, own: { price: null, storeShelf: null, mainText: null } });
    expect(listingSettingsProductOwnSettingsSchema.safeParse(own).success).toBe(true);
  });

  it("checks a main text against the catalog facts read with the row", async () => {
    const row = candidate(11);
    repository.ownRead = { row: ownRow(77, { mainText: { text: "Our words.", catalogHash: productCatalogHash(row) } }), catalog: catalogOf(row) };
    expect((await service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 501 })).own.mainText)
      .toEqual({ text: "Our words.", needsCheck: false });
    repository.ownRead = { row: ownRow(77, { mainText: { text: "Our words.", catalogHash: productCatalogHash(row) } }),
      catalog: catalogOf({ ...row, description: "Card Shellz changed this." }) };
    expect((await service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 501 })).own.mainText)
      .toEqual({ text: "Our words.", needsCheck: true });
  });

  it("refuses a product whose chosen sizes the catalog no longer lists while its main text needs them", async () => {
    repository.ownRead = { row: ownRow(77, { mainText: { text: "Our words.", catalogHash: "a".repeat(64) } }), catalog: null };
    await expect(service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 501 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", context: { storeConnectionId: 5, productId: 501 } });
  });

  it("refuses a product none of whose sizes is chosen, with the product detail's 404, before reading its row", async () => {
    await expect(service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 999 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", context: { storeConnectionId: 5, productId: 999 } });
    await expect(service.getProductForMember("member-1", { storeConnectionId: 5, productId: 999 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", context: { storeConnectionId: 5, productId: 999 } });
    expect(repository.ownReads).toHaveLength(0);
  });

  it("refuses bad input, a store it does not own, a selection over 10,000 sizes and a store not on eBay, before reading a row", async () => {
    await expect(service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: Number.NaN })).rejects.toBeInstanceOf(ZodError);
    await expect(service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 501, extra: 1 })).rejects.toBeInstanceOf(ZodError);
    await expect(service.getProductOwnSettings(" ", { storeConnectionId: 5, productId: 501 })).rejects.toMatchObject({ code: "DROPSHIP_AUTH_REQUIRED" });
    expect(repository.fingerprintReads).toHaveLength(0);
    repository.fingerprint = null;
    await expect(service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 501 }))
      .rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED", context: { storeConnectionId: 5 } });
    repository.fingerprint = "fp-1";
    repository.next = { state: "too_large", fingerprint: "fp-1", store,
      storeLevel: { pricing: emptyState, listingConfig: null, ebayCategoryRules: emptyState, content: emptyState } };
    await expect(service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 501 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", context: { storeConnectionId: 5 } });
    repository.fingerprint = "fp-2";
    repository.next = { state: "not_ebay", fingerprint: "fp-2", store: { ...store, platform: "shopify" } };
    await expect(service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 501 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY" });
    expect(repository.ownReads).toHaveLength(0);
  });

  it("fails the request when the row read fails, and reads nothing else: no stock, no eBay, no write", async () => {
    repository.ownRead = new Error("connection reset");
    await expect(service.getProductOwnSettings("member-1", { storeConnectionId: 5, productId: 501 })).rejects.toThrow("connection reset");
    // The read service has no eBay port and its repository no write: its port is four reads (PR 11 added the
    // conversion's, which this fake refuses), and the only calls are the three this read makes.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(repository)).filter((name) => name !== "constructor").sort())
      .toEqual(["load", "loadConversionInputs", "readFingerprint", "readProductOwnSettings"]);
    expect([repository.fingerprintReads.length, repository.loads.length, repository.ownReads.length]).toEqual([1, 1, 1]);
    expect(stock.atpReads).toHaveLength(0);
    expect(stock.capReads).toHaveLength(0);
    expect(warnings).toEqual([]);
  });
});
