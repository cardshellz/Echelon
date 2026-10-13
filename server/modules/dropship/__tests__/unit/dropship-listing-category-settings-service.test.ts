import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { MAX_BULK_TEXT_BYTES } from "../../../../../shared/dropship/listing-setting-writes";
import type { CategoryListingSettingValues } from "../../../../../shared/dropship/listing-setting-values";
import { DropshipListingCategorySettingsService } from "../../application/dropship-listing-category-settings-service";
import { LISTING_SETTINGS_CACHE_TTL_MS } from "../../application/dropship-listing-settings-service";
import type { DropshipListingCatalogCandidate, DropshipListingStoreContext } from "../../application/dropship-listing-preview-service";
import type { ListingSettingEbayPort } from "../../application/dropship-listing-setting-ebay-values";
import type {
  CategoryListingSettingSaveInput,
  CategoryListingSettingSaveResult,
  ClearSizeLeftoversInput,
  ListingSettingFacts,
  ListingSettingPreflightTransaction,
  ListingSettingWriteRepository,
  ListingSettingWriteTransaction,
  ListingTextBytes,
  ProductListingSettingsBulkInput,
  ProductListingSettingsBulkResult,
} from "../../application/dropship-listing-setting-writes";
import type { ProductListingSettingField } from "../../../../../shared/dropship/listing-setting-values";
import { DropshipError } from "../../domain/errors";
import type { RequestKeyUse } from "../../domain/listing-setting-request-key-use";
import { listingSettingRequestHash, type ListingSettingLeftoverField } from "../../domain/listing-setting-values";

// The real chosen check runs; it is wrapped only so its mode (ids only, first batch only) can be asserted.
const chosen = vi.hoisted(() => ({ spy: null as Mock | null }));
vi.mock("../../application/dropship-listing-setting-write-support", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../application/dropship-listing-setting-write-support")>();
  chosen.spy = vi.fn(actual.loadChosenSizes);
  return { ...actual, loadChosenSizes: chosen.spy };
});
import { ListingSettingHeavyWriteGate } from "../../application/dropship-listing-setting-write-support";

/**
 * W12 with every port stubbed (plan PR 9, sections 8.5, 8.13): the call
 * order (the replay probe, D16, the category's products, lockCatalog before
 * the chosen check; when clearing the products again, the leftovers under
 * their feature locks, the text-free facts, the derived set and the text
 * budget, all before the category row), the replay with no writer, every
 * refusal before the first write, the heavy-write gate only when clearing,
 * the eBay step and the INFO line. No port that reads product text is ever
 * called (the stubs throw).
 */

const NOW = new Date("2026-10-13T09:00:00.000Z");
const MEMBER = "member-1";
const VENDOR = 10;
const STORE = 22;
const CATEGORY = 3;
const KEY = "category-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const NOTHING: RequestKeyUse = { productRevision: null, categoryRevision: null, ledger: null, children: [] };
const storeContext: DropshipListingStoreContext = {
  vendorId: VENDOR, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE, storeStatus: "connected",
  setupStatus: "ready", platform: "ebay", storeLaunchReady: true,
};
const NO_TEXT: ListingTextBytes = { storeBytes: 0, keptStoreBytes: 0, targetBytes: 0 };
const CATEGORY_VALUES: CategoryListingSettingValues = {
  price: null, ebayCategory: null, storeShelf: { mode: "none" }, shippingPolicy: { id: "ship-a", name: "Ships in a day" },
  returnPolicy: null, paymentPolicy: null, textAbove: null, textBelow: null,
};

/** Products 7 (sizes 101, 102), 8 (103) and 9 (104) are in the category; 5 (105) is not. */
const SIZES_BY_PRODUCT = new Map([[7, [101, 102]], [8, [103]], [9, [104]], [5, [105]]]);
const PRODUCT_OF = new Map([...SIZES_BY_PRODUCT].flatMap(([productId, sizes]) => sizes.map((size) => [size, productId] as const)));

function candidate(productVariantId: number): DropshipListingCatalogCandidate {
  return {
    productId: PRODUCT_OF.get(productVariantId) ?? 1, productVariantId, productLineIds: [], category: "Toploaders", categoryId: CATEGORY,
    ebayBrowseCategoryId: null, ebayBrowseCategoryName: null, productIsActive: true, variantIsActive: true, variantUomType: "pack",
    unitsPerVariant: 25, defaultRetailPriceCents: 1_199, sku: `S-${productVariantId}`, productName: "Toploader", variantName: "Pack",
    title: "Toploader", description: "Rigid card protection.", brand: "Card Shellz", gtin: null, mpn: null, condition: "new",
    itemSpecifics: null, imageUrls: [], weightGrams: 100,
  };
}

/** The write transaction: each port records its name in `calls`; answers are set per test. */
class FakeTransaction {
  readonly calls: string[] = [];
  readonly vendorId = VENDOR;
  readonly storeConnectionId = STORE;
  readonly requestKey = KEY;
  readonly actor = { actorType: "vendor" as const, actorId: MEMBER };
  use: RequestKeyUse = NOTHING;
  groups = { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 };
  /** The category's products, by read: the first read, then the re-read under the locks. */
  categoryProducts: number[][] = [[7, 8, 9]];
  /** null: every product the lock was given exists. */
  lockedProductIds: number[] | null = null;
  /** Sizes the vendor switched off: not chosen. */
  notChosen = new Set<number>();
  leftovers = new Map<number, ListingSettingLeftoverField[]>();
  ownFields = new Map<number, ProductListingSettingField[]>([[7, ["textAbove", "storeShelf"]], [8, ["storeShelf"]]]);
  textBytes: ListingTextBytes = NO_TEXT;
  categoryResult: CategoryListingSettingSaveResult | null = null;
  bulkResult: ProductListingSettingsBulkResult | null = null;
  readonly catalog = {
    loadStoreContext: vi.fn(async () => { this.calls.push("gate"); return storeContext; }),
    listCatalogExposureRules: vi.fn(async () => { this.calls.push("exposureRules"); return [{ id: 1, scopeType: "catalog", action: "include" }]; }),
    listSelectionRules: vi.fn(async () => { this.calls.push("selectionRules"); return [{ id: 2, scopeType: "catalog", action: "include", isActive: true }]; }),
    listCatalogCandidates: vi.fn(async (ids: readonly number[]) => { this.calls.push("candidates"); return ids.map(candidate); }),
    listVariantOverrides: vi.fn(async (input: { productVariantIds: readonly number[] }) => {
      this.calls.push("overrides");
      return input.productVariantIds.filter((id) => this.notChosen.has(id)).map((productVariantId) => ({ productVariantId, enabledOverride: false }));
    }),
  };
  readonly findRequestKeyUse = vi.fn(async () => { this.calls.push("probe"); return this.use; });
  readonly loadOlderGroupRuleCounts = vi.fn(async () => { this.calls.push("groups"); return this.groups; });
  readonly listCategoryProductIds = vi.fn(async (_categoryId: number) => {
    this.calls.push("categoryProducts");
    const reads = this.calls.filter((call) => call === "categoryProducts").length;
    return [...(this.categoryProducts[Math.min(reads, this.categoryProducts.length) - 1] ?? [])];
  });
  readonly lockCatalog = vi.fn(async (input: { categoryIds?: readonly number[]; productIds?: readonly number[] }) => {
    this.calls.push("lockCatalog");
    return { lockedProductIds: this.lockedProductIds ?? [...(input.productIds ?? [])].sort((a, b) => a - b) };
  });
  readonly listProductSizes = vi.fn(async (productIds: readonly number[]) => {
    this.calls.push("productSizes");
    return productIds.flatMap((productId) => SIZES_BY_PRODUCT.get(productId) ?? []).sort((a, b) => a - b);
  });
  readonly loadLeftoverFields = vi.fn(async (_sizeIds: readonly number[]) => { this.calls.push("leftovers"); return this.leftovers; });
  readonly loadSettingFacts = vi.fn(async (input: { productIds: readonly number[] }): Promise<ListingSettingFacts> => {
    this.calls.push("settingFacts");
    // W12 reads only the own-field flags; the revision and price beside them are W7's (plan 8.2).
    return {
      products: new Map(input.productIds.filter((id) => this.ownFields.has(id)).map((id) => [id,
        { revisionId: 100 + id, price: null, ownFields: new Set(this.ownFields.get(id)) }])),
      categories: new Map(),
    };
  });
  readonly readListingTextBytes = vi.fn(async () => { this.calls.push("textBytes"); return this.textBytes; });
  readonly saveCategory = vi.fn(async (input: CategoryListingSettingSaveInput): Promise<CategoryListingSettingSaveResult> => {
    this.calls.push("saveCategory");
    return this.categoryResult ?? { outcome: "changed", categoryName: "Toploaders", changedFields: ["shippingPolicy"],
      before: { storeConnectionId: STORE, categoryId: CATEGORY, revisionId: 40, updatedAt: NOW.toISOString(), values: CATEGORY_VALUES },
      row: { storeConnectionId: STORE, categoryId: CATEGORY, revisionId: 41, updatedAt: NOW.toISOString(),
        values: { ...CATEGORY_VALUES, ...input.patch } as CategoryListingSettingValues } };
  });
  readonly saveProductsBulk = vi.fn(async (input: ProductListingSettingsBulkInput): Promise<ProductListingSettingsBulkResult> => {
    this.calls.push("saveProductsBulk");
    return this.bulkResult ?? { outcome: "changed", requestId: 900,
      changed: input.products.map((product) => ({ productId: product.productId, revisionId: product.productId + 5_000 })), unchangedProductIds: [] };
  });
  readonly clearSizeLeftovers = vi.fn(async (_input: ClearSizeLeftoversInput) => {
    this.calls.push("clearSizeLeftovers");
    return { clearedSizeCount: 2, byKind: { policy: 2, shelf: 0, content: 0 }, productVariantIds: [101, 103] };
  });
  // W12 reads no product text and no row with text: these throw if reached (plan 8.13, v3r C-feas-2).
  readonly loadProducts = vi.fn(async () => { throw new Error("W12 reads no product row: it uses the text-free settings facts."); });
  readonly loadCategories = vi.fn(async () => { throw new Error("W12's transaction reads no category row: saveCategory does."); });
  readonly sizePrice = vi.fn(() => { throw new Error("W12 writes no size price."); });
}

class FakePreflight {
  readonly calls: string[] = [];
  readonly vendorId = VENDOR;
  readonly storeConnectionId = STORE;
  context: DropshipListingStoreContext = storeContext;
  use: RequestKeyUse = NOTHING;
  known: CategoryListingSettingValues | null = CATEGORY_VALUES;
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
  readonly loadProducts = vi.fn(async () => { throw new Error("W12's preflight reads no product."); });
  readonly loadCategories = vi.fn(async (ids: readonly number[]) => {
    this.calls.push("category");
    return new Map(this.known === null ? [] : ids.map((id) => [id, { storeConnectionId: STORE, categoryId: id, revisionId: 40,
      updatedAt: NOW.toISOString(), values: this.known! }]));
  });
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
  async executeForSystem(): Promise<never> { throw new Error("W12 never runs as the system."); }
  async executeReview(): Promise<never> { throw new Error("W12 never runs a price check (W7's review)."); }
  async readPriceChangeReviewForMember(): Promise<never> { throw new Error("W12 never reads a price check's pages."); }
  async preflight<T>(input: { memberId: string; storeConnectionId: number; idempotencyKey: string | null },
    operation: (tx: ListingSettingPreflightTransaction) => Promise<T>): Promise<T> {
    this.order.push(`preflight:${input.idempotencyKey}`);
    return operation(this.pre as unknown as ListingSettingPreflightTransaction);
  }
}

/** The real gate, recording when a write enters and leaves it. */
class RecordingGate extends ListingSettingHeavyWriteGate {
  constructor(private readonly order: string[]) { super(); }
  override async run<T>(work: () => Promise<T>): Promise<T> {
    this.order.push("gate:enter");
    try {
      return await super.run(work);
    } finally {
      this.order.push("gate:leave");
    }
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
    listStoreShelves: vi.fn(async () => { calls.push("shelves"); return [{ categoryId: "11", categoryName: "Top", path: "Supplies:Top", level: 2 }]; }),
  };
  return { port, calls };
}

let repository: FakeRepository;
let ebay: ReturnType<typeof ebayPort>;
let log: { info: Mock<(action: string, fields: Record<string, unknown>) => void> };
let gate: RecordingGate;
let clock: { now: Mock<() => Date> };
let service: DropshipListingCategorySettingsService;

const clearProduct = (productId: number, expectedRevisionId: number | null = null) => ({ productId, expectedRevisionId });
/** A change with no clear and no eBay id (so no preflight): no shelf for the category. */
const body = (fields: Record<string, unknown> = {}) =>
  ({ idempotencyKey: KEY, expectedRevisionId: 40, patch: { storeShelf: { mode: "none" } }, ...fields });
/** "Also clear theirs" of the shelf: products 7 and 8 hold their own. */
const clearing = (fields: Record<string, unknown> = {}) => body({
  clear: { fields: ["storeShelf"], products: [clearProduct(8), clearProduct(7, 707)] }, ...fields });
const hashOf = (input: { expectedRevisionId: number | null; patch: Record<string, unknown>; clear: unknown }) => listingSettingRequestHash({
  operation: "category_settings_v1", storeConnectionId: STORE, categoryId: CATEGORY, ...input });

async function refusal(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

/** Nothing was written. */
function expectNothingWritten(tx: FakeTransaction) {
  expect(tx.saveCategory).not.toHaveBeenCalled();
  expect(tx.saveProductsBulk).not.toHaveBeenCalled();
  expect(tx.clearSizeLeftovers).not.toHaveBeenCalled();
}

const save = (input: unknown) => service.saveForMember(MEMBER, STORE, CATEGORY, input);

beforeEach(() => {
  chosen.spy!.mockClear();
  repository = new FakeRepository();
  ebay = ebayPort();
  log = { info: vi.fn() };
  gate = new RecordingGate(repository.order);
  clock = { now: vi.fn(() => NOW) };
  let tick = 100;
  const timer = vi.fn(() => { const value = tick; tick += 42; return value; });
  service = new DropshipListingCategorySettingsService({ repository, ebay: ebay.port, heavyWrites: gate, clock, timer, log });
});

describe("DropshipListingCategorySettingsService.saveForMember (W12, plan PR 9, 8.5)", () => {
  it("saves a change with no clear outside the heavy-write gate: probe, D16, products, lock, then the chosen check, then the row", async () => {
    const input = Object.freeze(body({ patch: Object.freeze({ storeShelf: Object.freeze({ mode: "none" }) }) }));

    const result = await save(input);

    expect(result).toEqual({ outcome: "changed", categoryId: CATEGORY, revisionId: 41, clearedProductCount: 0 });
    // No eBay id set: no preflight; no clear: no gate.
    expect(repository.order).toEqual([`execute:${KEY}`]);
    expect(repository.tx.calls).toEqual(["gate", "probe", "groups", "categoryProducts", "lockCatalog", "productSizes",
      "exposureRules", "selectionRules", "candidates", "overrides", "saveCategory"]);
    expect(repository.tx.lockCatalog).toHaveBeenCalledWith({ categoryIds: [CATEGORY], productIds: [7, 8, 9] });
    // Ids only, and one chosen size is all it asks (v3r, C-money-8, C-feas-14).
    expect(chosen.spy).toHaveBeenCalledExactlyOnceWith(expect.anything(), [101, 102, 103, 104], NOW, { keepCandidates: false, firstOnly: true });
    expect(repository.tx.saveCategory).toHaveBeenCalledWith({ categoryId: CATEGORY, expectedRevisionId: 40,
      patch: { storeShelf: { mode: "none" } },
      requestHash: hashOf({ expectedRevisionId: 40, patch: { storeShelf: { mode: "none" } }, clear: null }), now: NOW });
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(ebay.calls).toEqual([]);
    expect(repository.tx.loadProducts).not.toHaveBeenCalled();
    expect(repository.tx.loadLeftoverFields).not.toHaveBeenCalled();
    expect(repository.tx.loadSettingFacts).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_saved", {
      outcome: "changed", vendor_id: VENDOR, store_connection_id: STORE, actor_id: MEMBER, request_key: KEY,
      before: [{ category_id: CATEGORY, revision_id: 40 }], after: [{ category_id: CATEGORY, revision_id: 41 }],
      changed_count: 1, size_count: 0, elapsed_ms: 42, category_id: CATEGORY, changed_fields: ["shippingPolicy"], cleared_fields: [],
      request_id: null, cleared_product_count: 0, cleared_size_count: 0,
    });
  });

  it("clears inside the heavy-write gate: the products again, the leftovers, the facts, the set and the budget before any write", async () => {
    // A policy leftover on 103 is no reason to clear the shelf.
    repository.tx.leftovers = new Map([[103, ["paymentPolicy"]]]);

    const result = await save(clearing());

    expect(result).toEqual({ outcome: "changed", categoryId: CATEGORY, revisionId: 41, clearedProductCount: 2 });
    expect(repository.order).toEqual(["gate:enter", `execute:${KEY}`, "gate:leave"]);
    expect(repository.tx.calls).toEqual(["gate", "probe", "groups", "categoryProducts", "lockCatalog", "productSizes",
      "exposureRules", "selectionRules", "candidates", "overrides", "categoryProducts", "leftovers", "settingFacts", "textBytes",
      "saveCategory", "saveProductsBulk", "clearSizeLeftovers"]);
    // Every chosen size: with a clear the whole set is needed.
    expect(chosen.spy).toHaveBeenCalledExactlyOnceWith(expect.anything(), [101, 102, 103, 104], NOW, { keepCandidates: false, firstOnly: false });
    expect(repository.tx.loadLeftoverFields).toHaveBeenCalledWith([101, 102, 103, 104]);
    expect(repository.tx.loadSettingFacts).toHaveBeenCalledWith({ productIds: [7, 8, 9] });
    expect(repository.tx.readListingTextBytes).toHaveBeenCalledWith({ productIds: [7, 8],
      replacedFields: { textAbove: false, textBelow: false, mainText: false } });
    const requestHash = hashOf({ expectedRevisionId: 40, patch: { storeShelf: { mode: "none" } },
      clear: { fields: ["storeShelf"], products: [clearProduct(7, 707), clearProduct(8)] } });
    expect(repository.tx.saveProductsBulk).toHaveBeenCalledWith({ operation: "category_settings_clear",
      products: [clearProduct(7, 707), clearProduct(8)], patch: { storeShelf: null }, requestHash, now: NOW });
    expect(repository.tx.clearSizeLeftovers).toHaveBeenCalledWith({ productIds: [7, 8], fields: ["storeShelf"], requestHash, now: NOW });
    expect(repository.tx.loadProducts).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_saved", expect.objectContaining({
      outcome: "changed", changed_count: 3, size_count: 0, request_id: 900, cleared_fields: ["storeShelf"],
      cleared_product_count: 2, cleared_size_count: 2,
      before: [{ category_id: CATEGORY, revision_id: 40 }, { product_id: 7, revision_id: 707 }, { product_id: 8, revision_id: null }],
      after: [{ category_id: CATEGORY, revision_id: 41 }, { product_id: 7, revision_id: 5_007 }, { product_id: 8, revision_id: 5_008 }],
    }));
  });

  it("hashes a clear the same whatever order its fields and products are sent in", async () => {
    const patch = { textBelow: { mode: "none" }, storeShelf: { mode: "none" } };
    repository.tx.ownFields = new Map([[7, ["textBelow"]], [8, ["storeShelf"]]]);
    await save(body({ patch, clear: { fields: ["textBelow", "storeShelf"], products: [clearProduct(8), clearProduct(7)] } }));
    const first = repository.tx.saveCategory.mock.calls[0][0].requestHash;
    repository.tx = new FakeTransaction();
    repository.tx.ownFields = new Map([[7, ["textBelow"]], [8, ["storeShelf"]]]);
    await save(body({ patch: { storeShelf: { mode: "none" }, textBelow: { mode: "none" } },
      clear: { fields: ["storeShelf", "textBelow"], products: [clearProduct(7), clearProduct(8)] } }));
    expect(repository.tx.saveCategory.mock.calls[0][0].requestHash).toBe(first);
    // The products' patch names the cleared settings in the stored shape's order.
    expect(repository.tx.saveProductsBulk.mock.calls[0][0].patch).toEqual({ storeShelf: null, textBelow: null });
    expect(Object.keys(repository.tx.saveProductsBulk.mock.calls[0][0].patch)).toEqual(["storeShelf", "textBelow"]);
  });

  it("clears only: the category's value re-sent saves unchanged, and the products' own values are cleared", async () => {
    repository.tx.categoryResult = { outcome: "unchanged", categoryName: "Toploaders", changedFields: [],
      before: { storeConnectionId: STORE, categoryId: CATEGORY, revisionId: 40, updatedAt: NOW.toISOString(), values: CATEGORY_VALUES },
      row: { storeConnectionId: STORE, categoryId: CATEGORY, revisionId: 40, updatedAt: NOW.toISOString(), values: CATEGORY_VALUES } };

    const result = await save(clearing());

    expect(result).toEqual({ outcome: "changed", categoryId: CATEGORY, revisionId: 40, clearedProductCount: 2 });
    expect(repository.tx.saveProductsBulk).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.category_saved", expect.objectContaining({
      changed_fields: [], changed_count: 2, before: [{ product_id: 7, revision_id: 707 }, { product_id: 8, revision_id: null }] }));
  });

  it("answers unchanged when the change sets what the category has and clears nothing", async () => {
    repository.tx.categoryResult = { outcome: "unchanged", categoryName: "Toploaders", changedFields: [], before: null, row: null };
    await expect(save(body())).resolves.toEqual({ outcome: "unchanged", categoryId: CATEGORY, revisionId: null, clearedProductCount: 0 });
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.category_saved", expect.objectContaining({
      outcome: "unchanged", before: [], after: [], changed_count: 0 }));
  });

  it("counts a product whose only own value is a chosen size's leftover, and clears that leftover; another field's own value is no reason", async () => {
    repository.tx.ownFields = new Map([[7, ["textAbove"]], [8, []]]);
    repository.tx.leftovers = new Map([[103, ["storeShelf"]], [104, ["returnPolicy"]]]);

    await save(body({ clear: { fields: ["storeShelf"], products: [clearProduct(8)] } }));

    expect(repository.tx.saveProductsBulk).toHaveBeenCalledWith(expect.objectContaining({ products: [clearProduct(8)] }));
    expect(repository.tx.clearSizeLeftovers).toHaveBeenCalledWith(expect.objectContaining({ productIds: [8], fields: ["storeShelf"] }));
  });

  it("calls no leftover clean-up when only texts are cleared", async () => {
    await save(body({ patch: { textAbove: { mode: "own", text: "Category above." } },
      clear: { fields: ["textAbove"], products: [clearProduct(7, 707)] } }));
    expect(repository.tx.saveProductsBulk).toHaveBeenCalledWith(expect.objectContaining({ patch: { textAbove: null } }));
    expect(repository.tx.clearSizeLeftovers).not.toHaveBeenCalled();
  });

  it("answers a replay from the probe with no writer, no D16 read and no chosen check, even after a group rule was added", async () => {
    const requestHash = hashOf({ expectedRevisionId: 40, patch: { storeShelf: { mode: "none" } },
      clear: { fields: ["storeShelf"], products: [clearProduct(7, 707), clearProduct(8)] } });
    repository.tx.use = { ...NOTHING, categoryRevision: { revisionId: 41, categoryId: CATEGORY, storeConnectionId: STORE, requestHash },
      ledger: { requestId: 900, operation: "category_settings_clear", storeConnectionId: STORE, requestHash } };
    repository.tx.groups = { pricingGroups: 1, contentGroups: 0, ebayCategoryRules: 0 };

    const result = await save(clearing());

    expect(result).toEqual({ outcome: "replayed", categoryId: CATEGORY, revisionId: 41, clearedProductCount: null });
    expect(repository.tx.calls).toEqual(["gate", "probe"]);
    expectNothingWritten(repository.tx);
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.category_saved", expect.objectContaining({
      outcome: "replayed", request_id: 900, cleared_product_count: null, cleared_size_count: null, before: [],
      after: [{ category_id: CATEGORY, revision_id: 41 }], changed_count: 0 }));
  });

  it("answers a clear-only replay with the revision the first answer named, though the key wrote only the clear's ledger row", async () => {
    // The first answer: the category unchanged at the revision the request expected (40), two products cleared.
    const requestHash = hashOf({ expectedRevisionId: 40, patch: { storeShelf: { mode: "none" } },
      clear: { fields: ["storeShelf"], products: [clearProduct(7, 707), clearProduct(8)] } });
    repository.tx.use = { ...NOTHING, ledger: { requestId: 900, operation: "category_settings_clear", storeConnectionId: STORE, requestHash } };

    const result = await save(clearing());

    expect(result).toEqual({ outcome: "replayed", categoryId: CATEGORY, revisionId: 40, clearedProductCount: null });
    expect(repository.tx.calls).toEqual(["gate", "probe"]);
    expectNothingWritten(repository.tx);
    // The log lists what the key wrote: no category revision.
    expect(log.info).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_saved", expect.objectContaining({
      outcome: "replayed", request_id: 900, before: [], after: [], changed_count: 0 }));
  });

  it("replays a change that sets an eBay id with no eBay call: the preflight stops at its probe, the write answers from the key", async () => {
    const patch = { storeShelf: { mode: "none" }, returnPolicy: { id: "return-new" } };
    const requestHash = hashOf({ expectedRevisionId: 40, patch, clear: null });
    const use: RequestKeyUse = { ...NOTHING, categoryRevision: { revisionId: 41, categoryId: CATEGORY, storeConnectionId: STORE, requestHash } };
    repository.pre.use = use;
    repository.tx.use = use;

    const result = await save(body({ patch }));

    expect(result).toEqual({ outcome: "replayed", categoryId: CATEGORY, revisionId: 41, clearedProductCount: null });
    expect(ebay.calls).toEqual([]);
    expect(repository.order).toEqual([`preflight:${KEY}`, `execute:${KEY}`]);
    // Neither the category row nor the listing config is read once the key is known to be used.
    expect(repository.pre.calls).toEqual(["gate", "probe"]);
    expect(repository.tx.calls).toEqual(["gate", "probe"]);
    expectNothingWritten(repository.tx);
    expect(log.info).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_saved", expect.not.objectContaining({
      ebay_ms: expect.anything() }));
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.category_saved", expect.objectContaining({ outcome: "replayed",
      after: [{ category_id: CATEGORY, revision_id: 41 }] }));
  });

  it("answers a key used for another change or another store with 409, before any read", async () => {
    repository.tx.use = { ...NOTHING, categoryRevision: { revisionId: 41, categoryId: CATEGORY, storeConnectionId: 24, requestHash: "e".repeat(64) } };
    const conflict = await refusal(save(body()));
    expect(conflict).toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT",
      context: { mismatched: ["categoryRevision.requestHash", "categoryRevision.storeConnectionId"] } });
    expect(repository.tx.calls).toEqual(["gate", "probe"]);

    repository.tx = new FakeTransaction();
    repository.tx.use = { ...NOTHING, productRevision: { revisionId: 31, productId: 7, storeConnectionId: STORE, requestHash: "e".repeat(64),
      requestId: null } };
    await expect(refusal(save(body()))).resolves.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    expectNothingWritten(repository.tx);
  });

  it.each([
    ["pricing groups", { pricingGroups: 2, contentGroups: 0, ebayCategoryRules: 0 }],
    ["description groups", { pricingGroups: 0, contentGroups: 1, ebayCategoryRules: 0 }],
    ["eBay category rules", { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 3 }],
  ])("refuses a store that holds older %s (D16) right after the probe, before any lock or write", async (_label, groups) => {
    repository.tx.groups = groups;
    const error = await refusal(save(clearing()));
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT",
      context: { storeConnectionId: STORE, ...groups, retryable: false, classification: "permanent" } });
    expect(repository.tx.calls).toEqual(["gate", "probe", "groups"]);
    expect(repository.tx.lockCatalog).not.toHaveBeenCalled();
    expectNothingWritten(repository.tx);
    expect(log.info).not.toHaveBeenCalled();
  });

  it.each([
    ["with no chosen product", () => { repository.tx.notChosen = new Set([101, 102, 103, 104]); }],
    ["that does not exist (no product in it)", () => { repository.tx.categoryProducts = [[]]; }],
  ])("refuses a category %s with 404 after the lock, before any write", async (_label, arrange) => {
    arrange();
    const error = await refusal(save(clearing()));
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND",
      context: { storeConnectionId: STORE, categoryId: CATEGORY, classification: "permanent" } });
    expect(repository.tx.calls.indexOf("lockCatalog")).toBeLessThan(repository.tx.calls.indexOf("productSizes"));
    expectNothingWritten(repository.tx);
    expect(repository.tx.loadLeftoverFields).not.toHaveBeenCalled();
  });

  it("refuses with 409 a product moved into or out of the category between the first read and the lock, before reading leftovers", async () => {
    repository.tx.categoryProducts = [[7, 8, 9], [7, 8, 9, 12]];
    const error = await refusal(save(clearing()));
    expect(error).toMatchObject({ code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
      context: { categoryId: CATEGORY, conflicts: [{ productId: 12 }], conflictCount: 1, classification: "permanent" } });
    expect(repository.tx.loadLeftoverFields).not.toHaveBeenCalled();
    expectNothingWritten(repository.tx);
  });

  it.each([
    ["one the vendor was not shown (it gained an own value)", [clearProduct(7)], [8]],
    ["one that no longer holds an own value", [clearProduct(7), clearProduct(8), clearProduct(9)], [9]],
    ["a product outside the category", [clearProduct(7), clearProduct(8), clearProduct(5)], [5]],
  ])("refuses a clear set that differs from the derived one with 409 naming the products: %s", async (_label, products, conflicts) => {
    const error = await refusal(save(body({ clear: { fields: ["storeShelf"], products } })));
    expect(error).toMatchObject({ code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
      context: { conflicts: conflicts.map((productId) => ({ productId })), conflictCount: conflicts.length } });
    // The cached view does not see a Card Shellz change for up to its time limit, so the words say how long a reload can take.
    expect(error.message).toBe("Which products have their own values in this category changed after you opened it. Reload it before saving "
      + `again. A change Card Shellz made can take up to ${LISTING_SETTINGS_CACHE_TTL_MS / 1_000} seconds to show.`);
    expect(repository.tx.readListingTextBytes).not.toHaveBeenCalled();
    expectNothingWritten(repository.tx);
  });

  it("leaves a product the lock did not find out of the set: naming it is a conflict, never a fault", async () => {
    repository.tx.lockedProductIds = [7, 9];
    const error = await refusal(save(clearing()));
    expect(error).toMatchObject({ code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", context: { conflicts: [{ productId: 8 }] } });
    expectNothingWritten(repository.tx);
  });

  it("refuses a clear whose set carries more stored text than the budget with 422, before any write; at the budget it saves", async () => {
    repository.tx.textBytes = { storeBytes: MAX_BULK_TEXT_BYTES + 5, keptStoreBytes: MAX_BULK_TEXT_BYTES + 5, targetBytes: MAX_BULK_TEXT_BYTES + 1 };
    const error = await refusal(save(clearing()));
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE",
      context: { textBytes: MAX_BULK_TEXT_BYTES + 1, maxTextBytes: MAX_BULK_TEXT_BYTES, productCount: 2 } });
    expectNothingWritten(repository.tx);

    repository.tx = new FakeTransaction();
    repository.tx.textBytes = { storeBytes: MAX_BULK_TEXT_BYTES, keptStoreBytes: MAX_BULK_TEXT_BYTES, targetBytes: MAX_BULK_TEXT_BYTES };
    await expect(save(clearing())).resolves.toMatchObject({ outcome: "changed", clearedProductCount: 2 });
  });

  it("passes the category's version conflict through, with nothing after it written", async () => {
    repository.tx.saveCategory.mockRejectedValueOnce(new DropshipError("DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT",
      "This category's listing settings changed after you opened them.", { categoryId: CATEGORY, expectedRevisionId: 40, actualRevisionId: 42,
        retryable: false, classification: "permanent" }));
    await expect(refusal(save(clearing()))).resolves.toMatchObject({ code: "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT" });
    expect(repository.tx.saveProductsBulk).not.toHaveBeenCalled();
    expect(repository.tx.clearSizeLeftovers).not.toHaveBeenCalled();
  });

  it("refuses a price (plan P34) and a cleared setting the patch does not set as the vendor's input, before any connection", async () => {
    for (const input of [body({ patch: { price: null } }), body({ patch: { price: { basis: "catalog_retail", markupBps: 0, flatCents: 0,
      rounding: "cent" } } }), body({ clear: { fields: ["returnPolicy"], products: [clearProduct(7)] } })]) {
      await expect(refusal(save(input))).resolves.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT" });
    }
    await expect(refusal(service.saveForMember(MEMBER, STORE, 0, body()))).resolves.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT" });
    await expect(refusal(service.saveForMember(" ", STORE, CATEGORY, body()))).resolves.toMatchObject({ code: "DROPSHIP_AUTH_REQUIRED" });
    expect(repository.order).toEqual([]);
  });

  it("asks eBay only for an id the category does not store, outside the transaction and the gate, and stores eBay's name", async () => {
    const result = await save(clearing({ patch: { storeShelf: { mode: "none" }, shippingPolicy: { id: "ship-a" },
      returnPolicy: { id: "return-new" } } }));
    expect(result).toMatchObject({ outcome: "changed" });
    expect(repository.order).toEqual([`preflight:${KEY}`, "gate:enter", `execute:${KEY}`, "gate:leave"]);
    expect(repository.pre.calls).toEqual(["gate", "probe", "category", "listingConfig"]);
    expect(ebay.calls).toEqual(["discover"]);
    // The known id keeps its stored name with no eBay call; the new one gets eBay's.
    expect(repository.tx.saveCategory).toHaveBeenCalledWith(expect.objectContaining({ patch: { storeShelf: { mode: "none" },
      shippingPolicy: { id: "ship-a", name: "Ships in a day" }, returnPolicy: { id: "return-new", name: "Thirty days" } } }));
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.category_saved", expect.objectContaining({ ebay_ms: 42 }));
  });

  it("saves known ids and resets on a store that needs a sign-in with no eBay call; a new id is refused before any call", async () => {
    repository.pre.context = { ...storeContext, storeStatus: "needs_reauth" };
    await expect(save(body({ patch: { shippingPolicy: { id: "ship-a" }, returnPolicy: null } }))).resolves.toMatchObject({ outcome: "changed" });
    expect(ebay.calls).toEqual([]);
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.category_saved", expect.not.objectContaining({ ebay_ms: expect.anything() }));

    repository.tx = new FakeTransaction();
    const error = await refusal(save(body({ patch: { shippingPolicy: { id: "ship-a" }, returnPolicy: { id: "return-new" } } })));
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", context: { fields: ["returnPolicy"] } });
    expect(ebay.calls).toEqual([]);
    expect(repository.tx.calls).toEqual([]);
  });

  it("treats every id as new for a category with no row, and never asks eBay for a reset", async () => {
    repository.pre.known = null;
    await save(body({ patch: { shippingPolicy: null, returnPolicy: { id: "return-new" } } }));
    expect(ebay.calls).toEqual(["discover"]);
    expect(repository.tx.saveCategory).toHaveBeenCalledWith(expect.objectContaining({ patch: {
      shippingPolicy: null, returnPolicy: { id: "return-new", name: "Thirty days" } } }));
  });

  it("asks eBay nothing when the preflight finds the key used, and answers BUSY when the write then finds it new", async () => {
    repository.pre.use = { ...NOTHING, ledger: { requestId: 900, operation: "category_settings_clear", storeConnectionId: STORE,
      requestHash: "e".repeat(64) } };
    const error = await refusal(save(body({ patch: { returnPolicy: { id: "return-new" } } })));
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: { reason: "request_key_changed", retryable: true,
      classification: "transient" } });
    expect(ebay.calls).toEqual([]);
    expect(repository.tx.calls).toEqual(["gate", "probe"]);
  });

  it("releases the gate after a refusal, so the next clear runs", async () => {
    repository.tx.groups = { pricingGroups: 1, contentGroups: 0, ebayCategoryRules: 0 };
    await refusal(save(clearing()));
    repository.tx = new FakeTransaction();
    await expect(save(clearing())).resolves.toMatchObject({ outcome: "changed" });
    expect(repository.order).toEqual(["gate:enter", `execute:${KEY}`, "gate:leave", "gate:enter", `execute:${KEY}`, "gate:leave"]);
  });
});
