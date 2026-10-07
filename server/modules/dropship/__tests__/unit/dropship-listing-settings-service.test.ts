import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { listingSettingsProductDetailSchema } from "../../../../../shared/dropship/listing-settings";
import { DropshipError } from "../../domain/errors";
import type { DropshipVendorVariantOverride } from "../../domain/vendor-selection";
import { prepareEbayCategoryRules, resolveEbayListingCategory } from "../../application/dropship-ebay-category-resolver";
import type { DropshipListingCatalogCandidate, DropshipListingStoreContext } from "../../application/dropship-listing-preview-service";
import type { ListingSettingsInputs } from "../../application/dropship-listing-settings-facts";
import {
  DropshipListingSettingsService,
  type ListingSettingsLoad,
  type ListingSettingsRepository,
  type ListingSettingsStockSource,
} from "../../application/dropship-listing-settings-service";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type { DropshipAtpSnapshot } from "../../application/dropship-selection-atp-service";

const T0 = new Date("2026-10-06T12:00:00.000Z");

function candidate(productVariantId: number, productId = 501): DropshipListingCatalogCandidate {
  return {
    productId, productVariantId, productLineIds: [], category: "Toploaders", ebayBrowseCategoryId: "183438",
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
  };
}

class FakeRepository implements ListingSettingsRepository {
  fingerprint: string | null = "fp-1";
  next: ListingSettingsLoad | null = { state: "ok", fingerprint: "fp-1", inputs: inputs([candidate(11)]), costReadFailed: false };
  fingerprintReads: Array<{ memberId: string; storeConnectionId: number }> = [];
  loads: Array<{ memberId: string; storeConnectionId: number; now: Date }> = [];
  async readFingerprint(input: { memberId: string; storeConnectionId: number }) {
    this.fingerprintReads.push(input);
    return this.fingerprint;
  }
  async load(input: { memberId: string; storeConnectionId: number; now: Date }) {
    this.loads.push(input);
    return this.next;
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
});
