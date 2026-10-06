import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { prepareEbayCategoryRules, resolveEbayListingCategory } from "../../application/dropship-ebay-category-resolver";
import type { DropshipListingCatalogCandidate, DropshipListingStoreContext } from "../../application/dropship-listing-preview-service";
import type { ListingSettingsInputs } from "../../application/dropship-listing-settings-facts";
import {
  DropshipListingSettingsService,
  type ListingSettingsLoad,
  type ListingSettingsRepository,
} from "../../application/dropship-listing-settings-service";
import type { DropshipLogEvent } from "../../application/dropship-ports";

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

let repository: FakeRepository;
let now: Date;
let warnings: DropshipLogEvent[];
let service: DropshipListingSettingsService;

function makeService(options: { cacheMaxSizes?: number } = {}) {
  return new DropshipListingSettingsService({
    repository, clock: { now: () => now },
    logger: { info: vi.fn(), warn: (event) => warnings.push(event), error: vi.fn() },
    ...options,
  });
}

beforeEach(() => {
  repository = new FakeRepository();
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
