import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ListingPriceSetting, SavedListingPriceRevision } from "../../../../../shared/dropship/listing-price";
import type { ProductListingSettingRow, ProductListingSettingValues } from "../../../../../shared/dropship/listing-setting-values";
import type { PricingProfileState } from "../../../../../shared/dropship/pricing-rules";
import { productCatalogHash } from "../../application/dropship-listing-content-resolver";
import type {
  DropshipListingCatalogCandidate,
  DropshipListingStoreContext,
  DropshipPricingPolicyRecord,
} from "../../application/dropship-listing-preview-service";
import type { ListingSettingEbayPort } from "../../application/dropship-listing-setting-ebay-values";
import type {
  ClearSizeLeftoversInput,
  ListingSettingPreflightTransaction,
  ListingSettingWriteRepository,
  ListingSettingWriteTransaction,
  ProductListingSettingSaveInput,
} from "../../application/dropship-listing-setting-writes";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import { DropshipError } from "../../domain/errors";
import type { RequestKeyUse } from "../../domain/listing-setting-request-key-use";
import { listingSettingChildKey, listingSettingRequestHash } from "../../domain/listing-setting-values";

/** W9's flow is pinned by its own tests; here it is a recorded stub so each size's outcome can be chosen. */
const w9 = vi.hoisted(() => ({ saveListingPriceInTransaction: vi.fn() }));
vi.mock("../../application/dropship-listing-price-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../application/dropship-listing-price-service")>()),
  saveListingPriceInTransaction: w9.saveListingPriceInTransaction,
}));
import { DropshipListingProductSettingsService } from "../../application/dropship-listing-product-settings-service";

/**
 * W5 with every port stubbed (plan PR 9, sections 6.5, 6.12): the call order,
 * replay answered from the probe with no writer, every refusal before the
 * first write in the documented precedence, the store text cap, the eBay
 * preflight, the clean-ups and the INFO line.
 */

const NOW = new Date("2026-10-12T09:00:00.000Z");
const MEMBER = "member-1";
const VENDOR = 10;
const STORE = 22;
const PRODUCT = 7;
const KEY = "product-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const RETAIL = 1_199;
/** 800 x 1.3 = 1,040 at a cent. */
const RECIPE = { basis: "product_cost", markupBps: 3_000, flatCents: 0, rounding: "cent" } as const;
const NO_PROFILE: PricingProfileState = { revisionId: null, profile: null, updatedAt: null };
const NOTHING: RequestKeyUse = { productRevision: null, categoryRevision: null, ledger: null, children: [] };
const EMPTY_VALUES: ProductListingSettingValues = { price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null,
  returnPolicy: null, paymentPolicy: null, textAbove: null, textBelow: null, mainText: null };
const storeContext: DropshipListingStoreContext = {
  vendorId: VENDOR, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE, storeStatus: "connected",
  setupStatus: "ready", platform: "ebay", storeLaunchReady: true,
};

function candidate(productVariantId: number, productId = PRODUCT): DropshipListingCatalogCandidate {
  return {
    productId, productVariantId, productLineIds: [], category: "Toploaders", categoryId: 3, ebayBrowseCategoryId: null,
    ebayBrowseCategoryName: null, productIsActive: true, variantIsActive: true, variantUomType: "pack", unitsPerVariant: 25,
    defaultRetailPriceCents: RETAIL, sku: `S-${productVariantId}`, productName: "Toploader", variantName: `Size ${productVariantId}`,
    title: "Toploader", description: "Rigid card protection.", brand: "Card Shellz", gtin: null, mpn: null, condition: "new",
    itemSpecifics: null, imageUrls: [], weightGrams: 100,
  };
}

function cost(unitCostCents: number): DropshipProductCost {
  return { status: "available", unitCostCents, planId: "ops", source: "plan_percent", overrideId: null, issue: null,
    retailPriceCents: RETAIL, discountBps: 2_000 };
}

function productRow(revisionId: number, values: Partial<ProductListingSettingValues> = {}): ProductListingSettingRow {
  return { storeConnectionId: STORE, productId: PRODUCT, revisionId, updatedAt: "2026-10-01T00:00:00.000Z", values: { ...EMPTY_VALUES, ...values } };
}

function savedPrice(productVariantId: number, revisionId: number, overridePriceCents: number | null = 999): SavedListingPriceRevision {
  return { productVariantId, revisionId, overridePriceCents, pricingMode: overridePriceCents === null ? "inherit" : "fixed",
    updatedAt: "2026-10-01T00:00:00.000Z" };
}

/** The write transaction: each port records its name in `calls`; answers are set per test. */
class FakeTransaction {
  readonly calls: string[] = [];
  readonly vendorId = VENDOR;
  readonly storeConnectionId = STORE;
  readonly requestKey = KEY;
  readonly actor = { actorType: "vendor" as const, actorId: MEMBER };
  use: RequestKeyUse = NOTHING;
  /** listProductSizes' answers, in order: before the lock, then after it. */
  sizeAnswers: number[][] = [[101, 102]];
  catalogSizes = new Map([[101, candidate(101)], [102, candidate(102)], [201, candidate(201, 8)]]);
  current: ProductListingSettingRow | null = null;
  saved: SavedListingPriceRevision[] = [];
  policies: DropshipPricingPolicyRecord[] = [];
  costs = new Map([[101, cost(800)], [102, cost(800)]]);
  textBytes = { storeBytes: 1_000, keptStoreBytes: 1_000, targetBytes: 0 };
  saveResult: { outcome: "changed" | "unchanged" | "replayed"; changedFields: string[] } = { outcome: "changed", changedFields: ["storeShelf"] };
  locked: unknown = null;
  readonly catalog = {
    loadStoreContext: vi.fn(async () => { this.calls.push("gate"); return storeContext; }),
    listCatalogExposureRules: vi.fn(async () => { this.calls.push("exposureRules"); return [{ id: 1, scopeType: "catalog", action: "include" }]; }),
    listSelectionRules: vi.fn(async () => { this.calls.push("selectionRules"); return [{ id: 2, scopeType: "catalog", action: "include", isActive: true }]; }),
    listCatalogCandidates: vi.fn(async (ids: readonly number[]) => {
      this.calls.push("candidates");
      return ids.flatMap((id) => this.catalogSizes.get(id) ?? []);
    }),
    listVariantOverrides: vi.fn(async () => { this.calls.push("overrides"); return []; }),
    listSavedListingPrices: vi.fn(async () => { this.calls.push("savedPrices"); return this.saved; }),
    listExistingListings: vi.fn(async () => { this.calls.push("existingListings"); return []; }),
    listPricingPolicies: vi.fn(async () => { this.calls.push("pricingPolicies"); return this.policies; }),
    getStoreListingConfig: vi.fn(async () => { throw new Error("The write transaction does not read the listing config."); }),
  };
  readonly findRequestKeyUse = vi.fn(async () => { this.calls.push("probe"); return this.use; });
  /** After the scripted answers run out, the fixture's two sizes. */
  readonly listProductSizes = vi.fn(async () => { this.calls.push("listProductSizes"); return this.sizeAnswers.shift() ?? [101, 102]; });
  readonly lockCatalog = vi.fn(async (input: { productIds?: readonly number[] }) => {
    this.calls.push("lockCatalog");
    this.locked = input;
    return { lockedProductIds: [...(input.productIds ?? [])] };
  });
  readonly loadProducts = vi.fn(async () => {
    this.calls.push("loadProducts");
    return new Map(this.current ? [[PRODUCT, this.current]] : []);
  });
  readonly loadCategories = vi.fn(async () => { this.calls.push("loadCategories"); return new Map(); });
  readonly loadPricingProfile = vi.fn(async () => { this.calls.push("pricingProfile"); return NO_PROFILE; });
  readonly loadProductCosts = vi.fn(async () => { this.calls.push("costs"); return this.costs; });
  readonly readListingTextBytes = vi.fn(async () => { this.calls.push("textBytes"); return this.textBytes; });
  readonly saveProduct = vi.fn(async (input: ProductListingSettingSaveInput) => {
    this.calls.push("saveProduct");
    const row = productRow((this.current?.revisionId ?? 0) + 1);
    return { outcome: this.saveResult.outcome, row: this.saveResult.outcome === "unchanged" ? this.current : row,
      before: this.current, changedFields: this.saveResult.changedFields, input };
  });
  readonly sizePrice = vi.fn((productVariantId: number) => { this.calls.push(`sizePrice:${productVariantId}`); return { size: productVariantId }; });
  readonly clearSizeLeftovers = vi.fn(async (input: ClearSizeLeftoversInput) => {
    this.calls.push("clearSizeLeftovers");
    return { clearedSizeCount: 2, byKind: { policy: 0, shelf: 2, content: 0 }, productVariantIds: [101, 102], input };
  });
}

class FakePreflight {
  readonly calls: string[] = [];
  readonly vendorId = VENDOR;
  readonly storeConnectionId = STORE;
  context: DropshipListingStoreContext = storeContext;
  use: RequestKeyUse = NOTHING;
  current: ProductListingSettingRow | null = null;
  readonly catalog = {
    loadStoreContext: vi.fn(async () => { this.calls.push("gate"); return this.context; }),
    getStoreListingConfig: vi.fn(async () => {
      this.calls.push("listingConfig");
      return { id: 1, storeConnectionId: STORE, platform: "ebay", listingMode: "live", inventoryMode: "managed_quantity_sync",
        priceMode: "vendor_defined", marketplaceConfig: { marketplaceId: "EBAY_US" }, requiredConfigKeys: [], requiredProductFields: [],
        isActive: true };
    }),
  };
  readonly findRequestKeyUse = vi.fn(async () => { this.calls.push("probe"); return this.use; });
  readonly loadProducts = vi.fn(async () => { this.calls.push("loadProducts"); return new Map(this.current ? [[PRODUCT, this.current]] : []); });
  readonly loadCategories = vi.fn(async () => new Map());
}

class FakeRepository implements ListingSettingWriteRepository {
  readonly order: string[] = [];
  tx = new FakeTransaction();
  pre = new FakePreflight();
  async execute<T>(input: { memberId: string; storeConnectionId: number; idempotencyKey: string },
    operation: (tx: ListingSettingWriteTransaction) => Promise<T>): Promise<T> {
    this.order.push(`execute:${input.idempotencyKey}`);
    return operation(this.tx as unknown as ListingSettingWriteTransaction);
  }
  async executeForSystem(): Promise<never> { throw new Error("W5 never runs as the system."); }
  async preflight<T>(input: { memberId: string; storeConnectionId: number; idempotencyKey: string | null },
    operation: (tx: ListingSettingPreflightTransaction) => Promise<T>): Promise<T> {
    this.order.push(`preflight:${input.idempotencyKey}`);
    return operation(this.pre as unknown as ListingSettingPreflightTransaction);
  }
}

function ebayPort() {
  const calls: string[] = [];
  const port: ListingSettingEbayPort = {
    describeCategories: vi.fn(async () => { calls.push("describe"); return new Map(); }),
    discoverPolicies: vi.fn(async () => {
      calls.push("discover");
      return { marketplaceId: "EBAY_US", merchantLocations: [], fulfillmentPolicies: [],
        returnPolicies: [{ id: "return-new", name: "Thirty days" }], paymentPolicies: [] };
    }),
    loadFulfillmentCapability: vi.fn(async () => { calls.push("capability"); throw new Error("not used"); }),
    listStoreShelves: vi.fn(async () => {
      calls.push("shelves");
      return [{ categoryId: "101", categoryName: "Top", path: "Supplies:Top", level: 2 }];
    }),
  };
  return { port, calls };
}

let repository: FakeRepository;
let ebay: ReturnType<typeof ebayPort>;
let log: { info: Mock<(action: string, fields: Record<string, unknown>) => void> };
let timer: Mock<() => number>;
let service: DropshipListingProductSettingsService;
let sizeOutcomes: Map<number, DropshipError | { revisionId: number }>;

const body = (fields: Record<string, unknown> = {}) =>
  ({ idempotencyKey: KEY, expectedRevisionId: null, patch: { storeShelf: { mode: "none" } }, ...fields });
const shown = (...prices: Array<[number, number | null]>) => prices.map(([productVariantId, priceCents]) => ({ productVariantId, priceCents }));
const typed = (productVariantId: number, priceCents: number, expectedRevisionId: number | null = null) =>
  ({ productVariantId, pricingMode: "fixed", priceCents, expectedRevisionId });
const released = (productVariantId: number, expectedRevisionId: number | null) => ({ productVariantId, pricingMode: "inherit", expectedRevisionId });

function priceSetting(productVariantId: number, revisionId: number): ListingPriceSetting {
  return { storeConnectionId: STORE, productVariantId, revisionId, overridePriceCents: 1_499, effectivePriceCents: 1_499,
    defaultPriceCents: null, source: "override", pricingMode: "fixed", updatedAt: NOW.toISOString() };
}

async function refusal(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

/** No statement after the first refusal wrote anything. */
function expectNothingWritten(tx: FakeTransaction) {
  expect(tx.saveProduct).not.toHaveBeenCalled();
  expect(tx.sizePrice).not.toHaveBeenCalled();
  expect(tx.clearSizeLeftovers).not.toHaveBeenCalled();
  expect(w9.saveListingPriceInTransaction).not.toHaveBeenCalled();
}

const save = (input: unknown, productId: unknown = PRODUCT) => service.saveForMember(MEMBER, STORE, productId, input);

beforeEach(() => {
  w9.saveListingPriceInTransaction.mockReset();
  repository = new FakeRepository();
  ebay = ebayPort();
  sizeOutcomes = new Map();
  w9.saveListingPriceInTransaction.mockImplementation(async (_tx: unknown, target: { productVariantId: number }) => {
    repository.tx.calls.push(`w9:${target.productVariantId}`);
    const outcome = sizeOutcomes.get(target.productVariantId) ?? { revisionId: target.productVariantId + 1_000 };
    if (outcome instanceof DropshipError) throw outcome;
    return { price: priceSetting(target.productVariantId, outcome.revisionId), idempotentReplay: false };
  });
  log = { info: vi.fn() };
  let tick = 100;
  timer = vi.fn(() => { const value = tick; tick += 42; return value; });
  service = new DropshipListingProductSettingsService({ repository, ebay: ebay.port, clock: { now: () => NOW }, timer, log });
});

describe("DropshipListingProductSettingsService.saveForMember (W5, plan PR 9, 6.5)", () => {
  it("runs the checks and writes in order: gate, probe, sizes, lock, chosen, versions, price check, product, size prices, clean-ups", async () => {
    repository.tx.sizeAnswers = [[101, 102], [101, 102]];
    repository.tx.saved = [savedPrice(101, 41)];
    const expectedPrices = Object.freeze([Object.freeze({ productVariantId: 102, priceCents: 1_040 }),
      Object.freeze({ productVariantId: 101, priceCents: 1_040 })]);
    const input = Object.freeze(body({
      patch: Object.freeze({ storeShelf: Object.freeze({ mode: "none" }), price: Object.freeze({ ...RECIPE }) }),
      sizePrices: Object.freeze([Object.freeze(released(101, 41))]),
      expectedPrices,
    }));

    const result = await save(input);

    expect(result).toEqual({ outcome: "changed", productId: PRODUCT, revisionId: 1, sizes: [{ productVariantId: 101, revisionId: 1_101 }],
      clearedSizeCount: 2 });
    expect(repository.order).toEqual([`execute:${KEY}`]);
    expect(repository.tx.calls).toEqual([
      "gate", "probe", "listProductSizes", "lockCatalog", "listProductSizes",
      "exposureRules", "selectionRules", "candidates", "overrides",
      "loadProducts", "savedPrices",
      "pricingProfile", "loadCategories", "existingListings", "costs", "pricingPolicies",
      "saveProduct", "sizePrice:101", "w9:101", "clearSizeLeftovers",
    ]);
    expect(repository.tx.locked).toEqual({ productIds: [PRODUCT], productVariantIds: [101, 102] });
    // The input is never changed (CLAUDE.md §4); the frozen body would have thrown.
    expect(expectedPrices.map((row) => row.productVariantId)).toEqual([102, 101]);
  });

  it("writes the product first with the stored patch, then each size through W9 with its child key, the parent hash and one clock", async () => {
    repository.tx.sizeAnswers = [[101, 102], [101, 102]];
    repository.tx.saved = [savedPrice(102, 52)];
    await save(body({ patch: { price: RECIPE }, sizePrices: [released(102, 52), typed(101, 1_500)],
      expectedPrices: shown([101, 1_500], [102, 1_040]) }));

    const sorted = { sizePrices: [typed(101, 1_500), released(102, 52)], expectedPrices: shown([101, 1_500], [102, 1_040]) };
    const hash = listingSettingRequestHash({ operation: "product_settings_v1", storeConnectionId: STORE, productId: PRODUCT,
      expectedRevisionId: null, patch: { price: RECIPE }, ...sorted });
    expect(repository.tx.saveProduct).toHaveBeenCalledWith({ productId: PRODUCT, expectedRevisionId: null, patch: { price: RECIPE },
      requestHash: hash, now: NOW });
    const calls = w9.saveListingPriceInTransaction.mock.calls;
    expect(calls.map((call) => call.slice(1))).toEqual([
      [{ storeConnectionId: STORE, productVariantId: 101 }, { priceCents: 1_500, pricingMode: "fixed", expectedRevisionId: null,
        idempotencyKey: listingSettingChildKey(KEY, "size", 101) }, hash, NOW],
      [{ storeConnectionId: STORE, productVariantId: 102 }, { priceCents: null, pricingMode: "inherit", expectedRevisionId: 52,
        idempotencyKey: listingSettingChildKey(KEY, "size", 102) }, hash, NOW],
    ]);
    // No leftover field in the patch (price has its own flow): no clean-up.
    expect(repository.tx.clearSizeLeftovers).not.toHaveBeenCalled();
  });

  it("hashes the same request the same whatever order its sizes are sent in", async () => {
    repository.tx.sizeAnswers = [[101, 102], [101, 102], [101, 102], [101, 102]];
    const first = body({ patch: { price: null }, sizePrices: [typed(102, 1_500), typed(101, 1_400)], expectedPrices: shown([102, 1_500], [101, 1_400]) });
    const second = body({ patch: { price: null }, sizePrices: [typed(101, 1_400), typed(102, 1_500)], expectedPrices: shown([101, 1_400], [102, 1_500]) });
    await save(first);
    await save(second);
    const hashes = repository.tx.saveProduct.mock.calls.map(([call]) => call.requestHash);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("answers a replay from the probe: no writer, no size list, no price check, no eBay", async () => {
    const tx = repository.tx;
    const hash = listingSettingRequestHash({ operation: "product_settings_v1", storeConnectionId: STORE, productId: PRODUCT,
      expectedRevisionId: null, patch: { storeShelf: { mode: "none" } }, sizePrices: [], expectedPrices: null });
    tx.use = { productRevision: { revisionId: 31, productId: PRODUCT, storeConnectionId: STORE, requestHash: hash, requestId: null },
      categoryRevision: null, ledger: null, children: [
        { kind: "size", revisionId: 55, productVariantId: 102, storeConnectionId: STORE, requestHash: hash },
        { kind: "shelf", revisionId: 66, productVariantId: 101, storeConnectionId: STORE, requestHash: hash },
      ] };
    for (const writer of ["saveProduct", "sizePrice", "clearSizeLeftovers", "lockCatalog", "listProductSizes", "loadPricingProfile"] as const) {
      (tx[writer] as Mock).mockImplementation(() => { throw new Error(`${writer} must not run on a replay`); });
    }

    const result = await save(body());

    expect(result).toEqual({ outcome: "replayed", productId: PRODUCT, revisionId: 31, sizes: [{ productVariantId: 102, revisionId: 55 }],
      clearedSizeCount: null });
    expect(tx.calls).toEqual(["gate", "probe"]);
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.product_saved", expect.objectContaining({
      outcome: "replayed", before: [], after: [{ product_id: PRODUCT, revision_id: 31 }, { product_variant_id: 102, revision_id: 55 }],
      changed_count: 0, cleared_size_count: null, cleared_by_kind: null }));
  });

  it("answers a key used for another change as a permanent 409, writing nothing", async () => {
    repository.tx.use = { productRevision: { revisionId: 31, productId: 99, storeConnectionId: STORE, requestHash: "b".repeat(64), requestId: null },
      categoryRevision: null, ledger: null, children: [] };
    const error = await refusal(save(body()));
    expect(error.code).toBe("DROPSHIP_IDEMPOTENCY_CONFLICT");
    expect(error.context).toMatchObject({ mismatched: ["productRevision.productId", "productRevision.requestHash"], classification: "permanent" });
    expect(repository.tx.calls).toEqual(["gate", "probe"]);
  });

  it("never sends an empty stored patch to the product writer: size prices alone write no product row", async () => {
    repository.tx.sizeAnswers = [[101, 102], [101, 102]];
    const result = await save(body({ patch: {}, sizePrices: [typed(101, 1_500)], expectedPrices: shown([101, 1_500], [102, RETAIL]) }));
    expect(repository.tx.saveProduct).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "changed", revisionId: null, sizes: [{ productVariantId: 101, revisionId: 1_101 }], clearedSizeCount: 0 });
  });

  it("answers unchanged when the product writer changed nothing and nothing else was written", async () => {
    repository.tx.current = productRow(30, { storeShelf: { mode: "none" } });
    repository.tx.saveResult = { outcome: "unchanged", changedFields: [] };
    repository.tx.clearSizeLeftovers.mockImplementation(async () => ({ clearedSizeCount: 0, byKind: { policy: 0, shelf: 0, content: 0 },
      productVariantIds: [] }) as never);
    const result = await save(body({ expectedRevisionId: 30 }));
    expect(result).toEqual({ outcome: "unchanged", productId: PRODUCT, revisionId: 30, sizes: [], clearedSizeCount: 0 });
  });

  it("refuses a size price for a size that is not a chosen size of the product, before any write", async () => {
    repository.tx.sizeAnswers = [[101, 102], [101, 102]];
    const error = await refusal(save(body({ patch: {}, sizePrices: [typed(201, 1_500), typed(101, 1_500)],
      expectedPrices: shown([101, 1_500], [102, RETAIL]) })));
    expect(error.code).toBe("DROPSHIP_LISTING_PRICE_NOT_AVAILABLE");
    expect(error.context).toMatchObject({ storeConnectionId: STORE, productId: PRODUCT, productVariantId: 201, classification: "permanent" });
    expectNothingWritten(repository.tx);
  });

  it("refuses a product with no chosen size as not found, before anything else is checked", async () => {
    repository.tx.sizeAnswers = [[], []];
    repository.tx.current = productRow(30);
    const error = await refusal(save(body({ expectedRevisionId: 29 })));
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND");
    expect(repository.tx.loadProducts).not.toHaveBeenCalled();
    expectNothingWritten(repository.tx);
  });

  describe("refusal precedence (plan 6.13 #4): not found, product version, size versions, moved sizes, moved prices, refusals", () => {
    beforeEach(() => {
      repository.tx.current = productRow(30);
      repository.tx.saved = [savedPrice(101, 41)];
    });

    it("answers a stale product before stale sizes, moved sizes or moved prices", async () => {
      repository.tx.sizeAnswers = [[101, 102], [101, 102, 103]];
      const error = await refusal(save(body({ expectedRevisionId: 29, patch: { price: RECIPE }, sizePrices: [typed(101, 1, 40)],
        expectedPrices: shown([101, 1]) })));
      expect(error.code).toBe("DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT");
      expect(error.context).toMatchObject({ conflicts: [{ productId: PRODUCT, expectedRevisionId: 29, actualRevisionId: 30 }], conflictCount: 1 });
      expectNothingWritten(repository.tx);
    });

    it("answers stale sizes before moved sizes: a request both stale and moved gets the version conflict", async () => {
      repository.tx.sizeAnswers = [[101, 102], [101, 102, 103]];
      const error = await refusal(save(body({ expectedRevisionId: 30, patch: { price: RECIPE }, sizePrices: [typed(101, 1_500, 40)],
        expectedPrices: shown([101, 1_500]) })));
      expect(error.code).toBe("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT");
      expect(error.context).toMatchObject({ conflictCount: 1, conflicts: [{ productVariantId: 101, expectedRevisionId: 40, actualRevisionId: 41 }] });
      expectNothingWritten(repository.tx);
    });

    it("answers a size added under the lock as moved, naming it, before any price is compared", async () => {
      repository.tx.sizeAnswers = [[101, 102], [101, 102, 103]];
      const error = await refusal(save(body({ expectedRevisionId: 30, patch: { price: RECIPE }, expectedPrices: shown([101, 1]) })));
      expect(error.code).toBe("DROPSHIP_LISTING_PRICES_MOVED");
      expect(error.context).toMatchObject({ sizes: [{ productVariantId: 103 }], sizeCount: 1 });
      expect(repository.tx.loadPricingProfile).not.toHaveBeenCalled();
      expectNothingWritten(repository.tx);
    });

    it("answers a missing, an extra and a differing shown price as moved, each named, before a price refusal", async () => {
      repository.tx.sizeAnswers = [[101, 102], [101, 102]];
      repository.tx.policies = [{ id: 5, scopeType: "catalog", productLineId: null, productId: null, productVariantId: null, category: null,
        mode: "block_listing_push", floorPriceCents: 1_100, ceilingPriceCents: null }];
      const error = await refusal(save(body({ expectedRevisionId: 30, patch: { price: RECIPE },
        expectedPrices: shown([102, 999], [104, 500]) })));
      expect(error.code).toBe("DROPSHIP_LISTING_PRICES_MOVED");
      expect(error.context).toMatchObject({ sizeCount: 3, sizes: [
        { productVariantId: 101, priceCents: 999 },
        { productVariantId: 102, expectedPriceCents: 999, priceCents: 1_040 },
        { productVariantId: 104, expectedPriceCents: 500 },
      ] });
      expectNothingWritten(repository.tx);
    });

    it("refuses a recipe that would leave sizes without a usable price, naming every size", async () => {
      repository.tx.sizeAnswers = [[101, 102], [101, 102]];
      repository.tx.saved = [];
      repository.tx.policies = [{ id: 5, scopeType: "catalog", productLineId: null, productId: null, productVariantId: null, category: null,
        mode: "block_listing_push", floorPriceCents: 1_100, ceilingPriceCents: null }];
      const error = await refusal(save(body({ expectedRevisionId: 30, patch: { price: RECIPE }, expectedPrices: shown([101, 1_040], [102, 1_040]) })));
      expect(error.code).toBe("DROPSHIP_LISTING_PRICE_WOULD_BE_LOST");
      expect(error.context).toMatchObject({ sizeCount: 2, sizes: [
        { productVariantId: 101, beforePriceCents: RETAIL, afterPriceCents: 1_040, refusal: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST",
          blockers: ["pricing:below_floor:policy_5"] },
        { productVariantId: 102, beforePriceCents: RETAIL, afterPriceCents: 1_040, refusal: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST" },
      ], classification: "permanent" });
      expectNothingWritten(repository.tx);
    });

    it("answers WOULD_BE_LOST when a typed refusal sits next to a lost price, each size with its own refusal (P14: every, not some)", async () => {
      repository.tx.sizeAnswers = [[101, 102], [101, 102]];
      repository.tx.saved = [];
      repository.tx.policies = [{ id: 5, scopeType: "catalog", productLineId: null, productId: null, productVariantId: null, category: null,
        mode: "block_listing_push", floorPriceCents: 1_100, ceilingPriceCents: null }];
      // The recipe gives 1,040 under the 1,100 floor (102 lost); 101 is typed at 500 under it (outside the limit).
      const error = await refusal(save(body({ expectedRevisionId: 30, patch: { price: RECIPE }, sizePrices: [typed(101, 500)],
        expectedPrices: shown([101, 500], [102, 1_040]) })));
      expect(error.code).toBe("DROPSHIP_LISTING_PRICE_WOULD_BE_LOST");
      expect(error.context).toMatchObject({ sizeCount: 2, sizes: [
        { productVariantId: 101, refusal: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", beforePriceCents: RETAIL, afterPriceCents: 500 },
        { productVariantId: 102, refusal: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", beforePriceCents: RETAIL, afterPriceCents: 1_040 },
      ] });
      expectNothingWritten(repository.tx);
    });

    it("answers OUTSIDE_LIMIT when every refusal is a price typed in this request", async () => {
      repository.tx.sizeAnswers = [[101, 102], [101, 102]];
      repository.tx.saved = [];
      repository.tx.policies = [{ id: 5, scopeType: "catalog", productLineId: null, productId: null, productVariantId: null, category: null,
        mode: "block_listing_push", floorPriceCents: 1_100, ceilingPriceCents: null }];
      const error = await refusal(save(body({ expectedRevisionId: 30, patch: {}, sizePrices: [typed(101, 500)],
        expectedPrices: shown([101, 500], [102, RETAIL]) })));
      expect(error.code).toBe("DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT");
      expect(error.context).toMatchObject({ sizeCount: 1, sizes: [{ productVariantId: 101, refusal: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT" }] });
      expectNothingWritten(repository.tx);
    });
  });

  describe("the store text cap (plan 3.10 (e), 6.5 step 10a)", () => {
    it("refuses a change that raises the store's saved text past the cap, before any write", async () => {
      repository.tx.textBytes = { storeBytes: 29_999_990, keptStoreBytes: 29_999_990, targetBytes: 0 };
      const error = await refusal(save(body({ patch: { textAbove: { mode: "own", text: "Eleven char" } } })));
      expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_TOO_LARGE");
      expect(error.context).toMatchObject({ reason: "store_text_limit", textBytes: 30_000_001, maxTextBytes: 30_000_000 });
      expect(repository.tx.readListingTextBytes).toHaveBeenCalledWith({ productIds: [PRODUCT],
        replacedFields: { textAbove: true, textBelow: false, mainText: false } });
      expectNothingWritten(repository.tx);
    });

    it("accepts shortening text on a store already over the cap, and logs the store's text after it", async () => {
      repository.tx.textBytes = { storeBytes: 40_000_000, keptStoreBytes: 39_000_000, targetBytes: 1_000_000 };
      await save(body({ patch: { textBelow: { mode: "own", text: "Short." }, mainText: null } }));
      expect(repository.tx.readListingTextBytes).toHaveBeenCalledWith({ productIds: [PRODUCT],
        replacedFields: { textAbove: false, textBelow: true, mainText: true } });
      expect(repository.tx.saveProduct).toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.product_saved", expect.objectContaining({ store_text_bytes: 39_000_006 }));
    });

    it("reads no text count when the change sets no text", async () => {
      await save(body({ patch: { textAbove: { mode: "none" }, mainText: null, storeShelf: null } }));
      expect(repository.tx.readListingTextBytes).not.toHaveBeenCalled();
      expect(log.info.mock.calls[0][1]).not.toHaveProperty("store_text_bytes");
    });

    it("stamps the main text with the product's catalog hash and counts its bytes", async () => {
      await save(body({ patch: { mainText: { text: "Own words." } } }));
      expect(repository.tx.saveProduct).toHaveBeenCalledWith(expect.objectContaining({
        patch: { mainText: { text: "Own words.", catalogHash: productCatalogHash(candidate(101)) } } }));
      expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.product_saved", expect.objectContaining({ store_text_bytes: 1_010 }));
    });
  });

  it("clears the leftovers of every leftover field the patch touches, a value or a reset, after the size prices", async () => {
    repository.tx.sizeAnswers = [[101, 102], [101, 102]];
    await save(body({ patch: { returnPolicy: null, storeShelf: { mode: "none" }, mainText: null, textAbove: null, price: null },
      sizePrices: [typed(101, 1_500)], expectedPrices: shown([101, 1_500], [102, RETAIL]) }));
    expect(repository.tx.clearSizeLeftovers).toHaveBeenCalledWith({ productIds: [PRODUCT],
      fields: ["returnPolicy", "storeShelf", "mainText"], requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), now: NOW });
    const calls = repository.tx.calls;
    expect(calls.indexOf("clearSizeLeftovers")).toBeGreaterThan(calls.indexOf("w9:101"));
  });

  it("logs one INFO line with the common fields, the product's fields and elapsed_ms from the timer", async () => {
    repository.tx.current = productRow(30);
    repository.tx.sizeAnswers = [[101, 102], [101, 102]];
    repository.tx.saved = [savedPrice(101, 41)];
    await save(body({ expectedRevisionId: 30, sizePrices: [typed(101, 1_500, 41)], expectedPrices: shown([101, 1_500], [102, RETAIL]) }));
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.product_saved", {
      outcome: "changed", vendor_id: VENDOR, store_connection_id: STORE, actor_id: MEMBER, request_key: KEY,
      before: [{ product_id: PRODUCT, revision_id: 30 }, { product_variant_id: 101, revision_id: 41 }],
      after: [{ product_id: PRODUCT, revision_id: 31 }, { product_variant_id: 101, revision_id: 1_101 }],
      changed_count: 2, size_count: 1, elapsed_ms: 42, product_id: PRODUCT, changed_fields: ["storeShelf"],
      cleared_size_count: 2, cleared_by_kind: { policy: 0, shelf: 2, content: 0 },
    });
  });

  it("gathers W9's version conflicts and limits, and stops on any other refusal naming its size", async () => {
    repository.tx.sizeAnswers = [[101, 102], [101, 102], [101, 102], [101, 102]];
    sizeOutcomes.set(101, new DropshipError("DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", "x", { blockers: ["pricing:below_floor:policy_5"] }));
    const limit = await refusal(save(body({ patch: {}, sizePrices: [typed(101, 1_500), typed(102, 1_600)],
      expectedPrices: shown([101, 1_500], [102, 1_600]) })));
    expect(limit.context).toMatchObject({ sizeCount: 1, sizes: [{ productVariantId: 101, priceCents: 1_500, blockers: ["pricing:below_floor:policy_5"] }] });

    sizeOutcomes.set(101, new DropshipError("DROPSHIP_PRICING_RULES_NOT_CONFIGURED", "Configure rules."));
    const stop = await refusal(save(body({ patch: {}, sizePrices: [typed(101, 1_500), typed(102, 1_600)],
      expectedPrices: shown([101, 1_500], [102, 1_600]) })));
    expect(stop).toMatchObject({ code: "DROPSHIP_PRICING_RULES_NOT_CONFIGURED", context: { productVariantId: 101, storeConnectionId: STORE } });
  });

  describe("eBay values (plan P13, 6.5 steps 2-3)", () => {
    it("reads the preflight before the write, asks eBay only for the new id, and stores eBay's value with ebay_ms logged", async () => {
      repository.pre.current = productRow(30, { shippingPolicy: { id: "ship-old", name: "Saved" } });
      repository.tx.current = productRow(30, { shippingPolicy: { id: "ship-old", name: "Saved" } });

      await save(body({ expectedRevisionId: 30, patch: { shippingPolicy: { id: "ship-old" }, returnPolicy: { id: "return-new" } } }));

      expect(repository.order).toEqual([`preflight:${KEY}`, `execute:${KEY}`]);
      expect(repository.pre.calls).toEqual(["gate", "probe", "loadProducts", "listingConfig"]);
      expect(ebay.calls).toEqual(["discover"]);
      expect(repository.tx.saveProduct).toHaveBeenCalledWith(expect.objectContaining({ patch: {
        shippingPolicy: { id: "ship-old", name: "Saved" }, returnPolicy: { id: "return-new", name: "Thirty days" } } }));
      expect(log.info.mock.calls[0][1]).toMatchObject({ ebay_ms: 42 });
    });

    it("refuses new eBay ids for a store that needs a sign-in before any eBay call or write", async () => {
      repository.pre.context = { ...storeContext, storeStatus: "needs_reauth" };
      const error = await refusal(save(body({ patch: { storeShelf: { mode: "own", shelfIds: ["101"] } } })));
      expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", context: { fields: ["storeShelf"] } });
      expect(ebay.calls).toEqual([]);
      expect(repository.order).toEqual([`preflight:${KEY}`]);
    });

    it("asks eBay nothing when the preflight finds the key used, and answers BUSY when the write then finds it new", async () => {
      const hash = "c".repeat(64);
      repository.pre.use = { productRevision: null, categoryRevision: null, ledger: null,
        children: [{ kind: "shelf", revisionId: 66, productVariantId: 101, storeConnectionId: STORE, requestHash: hash }] };

      const error = await refusal(save(body({ patch: { storeShelf: { mode: "own", shelfIds: ["101"] } } })));

      expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_BUSY");
      expect(error.context).toMatchObject({ reason: "request_key_changed", retryAfterSeconds: 5, classification: "transient" });
      expect(repository.pre.calls).toEqual(["gate", "probe"]);
      expect(ebay.calls).toEqual([]);
      expect(repository.tx.calls).toEqual(["gate", "probe"]);
    });

    it("answers the retry of a committed eBay-setting save from the probes: no eBay call, no BUSY, no writer", async () => {
      // The retry plans 3.5 and 6.11 expect after a lost answer: both probes find this request's own rows.
      const patch = { returnPolicy: { id: "return-new" } };
      const hash = listingSettingRequestHash({ operation: "product_settings_v1", storeConnectionId: STORE, productId: PRODUCT,
        expectedRevisionId: null, patch, sizePrices: [], expectedPrices: null });
      const use: RequestKeyUse = {
        productRevision: { revisionId: 31, productId: PRODUCT, storeConnectionId: STORE, requestHash: hash, requestId: null },
        categoryRevision: null, ledger: null,
        children: [{ kind: "policy", revisionId: 77, productVariantId: 101, storeConnectionId: STORE, requestHash: hash }],
      };
      repository.pre.use = use;
      repository.tx.use = use;
      const tx = repository.tx;
      for (const writer of ["saveProduct", "sizePrice", "clearSizeLeftovers", "lockCatalog", "listProductSizes", "loadPricingProfile"] as const) {
        (tx[writer] as Mock).mockImplementation(() => { throw new Error(`${writer} must not run on a replay`); });
      }

      const result = await save(body({ patch }));

      expect(result).toEqual({ outcome: "replayed", productId: PRODUCT, revisionId: 31, sizes: [], clearedSizeCount: null });
      expect(ebay.calls).toEqual([]);
      expect(repository.order).toEqual([`preflight:${KEY}`, `execute:${KEY}`]);
      expect(repository.pre.calls).toEqual(["gate", "probe"]);
      expect(tx.calls).toEqual(["gate", "probe"]);
      expect(log.info.mock.calls[0][1]).not.toHaveProperty("ebay_ms");
    });

    it("runs no preflight for a change that sets no eBay id", async () => {
      await save(body({ patch: { storeShelf: { mode: "none" }, shippingPolicy: null, ebayCategory: null } }));
      expect(repository.order).toEqual([`execute:${KEY}`]);
      expect(log.info.mock.calls[0][1]).not.toHaveProperty("ebay_ms");
    });
  });

  it("refuses an input outside the route contract as a 400 before any transaction", async () => {
    for (const [input, productId] of [[body({ idempotencyKey: "short" }), PRODUCT], [body(), 0], [body({ patch: {} }), PRODUCT]] as const) {
      const error = await refusal(save(input, productId));
      expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVALID_INPUT");
    }
    await expect(service.saveForMember(" ", STORE, PRODUCT, body())).rejects.toMatchObject({ code: "DROPSHIP_AUTH_REQUIRED" });
    expect(repository.order).toEqual([]);
  });
});
