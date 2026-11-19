import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingSettingEbayPort } from "../../application/dropship-listing-setting-ebay-values";
import type {
  ListingSettingPreflightTransaction,
  ListingSettingWriteRepository,
  ListingSettingWriteTransaction,
  ProductListingSettingsBulkInput,
  StoredPriceChangeReview,
} from "../../application/dropship-listing-setting-writes";
import { priceChangeReviewHash } from "../../application/dropship-listing-price-changes-service";
import type {
  ListingRulesConversionExecuteInput,
  ListingRulesConversionRepository,
  ListingRulesConversionTransaction,
} from "../../application/dropship-listing-rules-conversion-service";
import type { ListingRulesConversionNoticeRepository } from "../../application/dropship-listing-rules-conversion-notice-service";
import { DropshipError } from "../../domain/errors";

// The production repository's module opens the shared pool on import; nothing here reaches it, a repository is injected.
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { logger } from "../../../../platform/observability/logger";
import { createDropshipListingSettingWriteServices } from "../../infrastructure/dropship-listing-setting-writes.factory";
import { PgDropshipListingRulesConversionRepository } from "../../infrastructure/dropship-listing-rules-conversion.repository";

/**
 * The real wiring (plan PR 9, 3.10 (a), 7.12; v3r, C-feas-9): the services
 * the factory builds, with only the repository and the eBay port injected
 * through its `overrides` seam (no module mock of either). One heavy-write
 * gate per factory call, which production makes once per process
 * (registerDropshipListingSettingWritesRoutes), shared by the heavy writers;
 * the single writers (W5, W8, and W12 without a clear) are never gated. A
 * W12 clear is heavy and shares the gate with W6 in both directions, which a
 * gate built per service would fail (plan 3.10 (a), 8.13). So does W7's
 * apply (9f, plan 9.13), and its price check never opens its transaction
 * while another heavy write holds the gate.
 */

const MEMBER = "member-1";
const STORE = 22;
const W6_KEY = "products-bulk:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const w6Body = (idempotencyKey = W6_KEY) =>
  ({ idempotencyKey, products: [{ productId: 7, expectedRevisionId: null }], patch: { storeShelf: { mode: "none" } } });
const NOT_GATED = "TEST_REACHED_THE_TRANSACTION";
const W12_KEY = "category-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const CATEGORY = 3;
/** "Also clear theirs" of the shelf for product 7, which holds its own: a heavy write (plan 3.10). */
const w12Clear = (idempotencyKey = `${W12_KEY}-clear`) => ({ idempotencyKey, expectedRevisionId: null, patch: { storeShelf: { mode: "none" } },
  clear: { fields: ["storeShelf"], products: [{ productId: 7, expectedRevisionId: null }] } });
const w12Plain = () => ({ idempotencyKey: W12_KEY, expectedRevisionId: null, patch: { storeShelf: { mode: "none" } } });
const W7_KEY = "price-changes:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const REVIEW_ID = "6f1b1d7e-6d0e-4d43-9a43-2f9d3c0b7c11";
/** A stored release-only check of product 7, which has no chosen size: no row, so its apply writes only its ledger row. */
const W7_INPUT = { productIds: [7], releaseExactPrices: true as const };
const W7_REVIEW: StoredPriceChangeReview = { id: REVIEW_ID, kind: "product_prices", input: W7_INPUT, rows: [],
  reviewHash: priceChangeReviewHash("product_prices", W7_INPUT, []), createdAt: new Date("2026-10-13T08:55:00.000Z") };
const w7Apply = (idempotencyKey = W7_KEY) => ({ reviewId: REVIEW_ID, reviewHash: W7_REVIEW.reviewHash, idempotencyKey });

/** A committed W6's ledger row, by request key, as the replay probe reads it. */
type Ledgers = Map<string, { requestId: number; operation: "product_settings_bulk"; storeConnectionId: number; requestHash: string }>;

/**
 * A W6 transaction that answers every step; nothing else is expected to reach
 * it. Its writer records the request's ledger row, and its probe returns the
 * row a committed request under the same key left, so a retry replays.
 */
function w6Transaction(requestKey: string, ledgers: Ledgers): ListingSettingWriteTransaction {
  return {
    vendorId: 10, storeConnectionId: STORE, requestKey, actor: { actorType: "vendor", actorId: MEMBER },
    catalog: { loadStoreContext: async () => ({ vendorId: 10, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE,
      storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true }) },
    findRequestKeyUse: async () => ({ productRevision: null, categoryRevision: null, ledger: ledgers.get(requestKey) ?? null, children: [] }),
    readListingTextBytes: async () => ({ storeBytes: 0, keptStoreBytes: 0, targetBytes: 0 }),
    lockCatalog: async (input: { productIds?: readonly number[] }) => ({ lockedProductIds: [...(input.productIds ?? [])] }),
    saveProductsBulk: async (input: ProductListingSettingsBulkInput) => {
      ledgers.set(requestKey, { requestId: 900, operation: "product_settings_bulk", storeConnectionId: STORE, requestHash: input.requestHash });
      return { outcome: "changed", requestId: 900,
        changed: input.products.map((product) => ({ productId: product.productId, revisionId: 31 })), unchangedProductIds: [] };
    },
    clearSizeLeftovers: async () => ({ clearedSizeCount: 0, byKind: { policy: 0, shelf: 0, content: 0 }, productVariantIds: [] }),
  } as unknown as ListingSettingWriteTransaction;
}

/** A W12 clear's transaction: product 7, its one chosen size 101, its own shelf; every step answers, nothing else is expected. */
function w12Transaction(requestKey: string): ListingSettingWriteTransaction {
  const now = new Date("2026-10-13T09:00:00.000Z").toISOString();
  return {
    vendorId: 10, storeConnectionId: STORE, requestKey, actor: { actorType: "vendor", actorId: MEMBER },
    catalog: {
      loadStoreContext: async () => ({ vendorId: 10, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE,
        storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true }),
      listCatalogExposureRules: async () => [{ id: 1, scopeType: "catalog", action: "include" }],
      listPickedVariantIds: async (_vendorId: number, ids: readonly number[]) => new Set(ids),
      listCatalogCandidates: async (ids: readonly number[]) => ids.map((productVariantId) => ({ productId: 7, productVariantId,
        productLineIds: [], category: "Toploaders", categoryId: CATEGORY, ebayBrowseCategoryId: null, ebayBrowseCategoryName: null,
        productIsActive: true, variantIsActive: true, variantUomType: "pack", unitsPerVariant: 1, defaultRetailPriceCents: 999, sku: null,
        productName: "Toploader", variantName: "Pack", title: null, description: null, brand: null, gtin: null, mpn: null, condition: null,
        itemSpecifics: null, imageUrls: [], weightGrams: null })),
      listVariantOverrides: async () => [],
    },
    findRequestKeyUse: async () => ({ productRevision: null, categoryRevision: null, ledger: null, children: [] }),
    loadOlderGroupRuleCounts: async () => ({ pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 }),
    listCategoryProductIds: async () => [7],
    lockCatalog: async (input: { productIds?: readonly number[] }) => ({ lockedProductIds: [...(input.productIds ?? [])] }),
    listProductSizes: async () => [101],
    loadLeftoverFields: async () => new Map(),
    loadSettingFacts: async () => ({ products: new Map([[7, { ownFields: new Set(["storeShelf"]) }]]) }),
    readListingTextBytes: async () => ({ storeBytes: 0, keptStoreBytes: 0, targetBytes: 0 }),
    saveCategory: async () => ({ outcome: "changed", categoryName: "Toploaders", changedFields: ["storeShelf"], before: null,
      row: { storeConnectionId: STORE, categoryId: CATEGORY, revisionId: 41, updatedAt: now,
        values: { price: null, ebayCategory: null, storeShelf: { mode: "none" }, shippingPolicy: null, returnPolicy: null,
          paymentPolicy: null, textAbove: null, textBelow: null } } }),
    saveProductsBulk: async () => ({ outcome: "changed", requestId: 901, changed: [{ productId: 7, revisionId: 32 }], unchangedProductIds: [] }),
    clearSizeLeftovers: async () => ({ clearedSizeCount: 0, byKind: { policy: 0, shelf: 0, content: 0 }, productVariantIds: [] }),
  } as unknown as ListingSettingWriteTransaction;
}

/** A W7 apply's transaction for W7_REVIEW: every step answers; it writes its ledger row and nothing else. */
function w7Transaction(requestKey: string): ListingSettingWriteTransaction {
  return {
    vendorId: 10, storeConnectionId: STORE, requestKey, actor: { actorType: "vendor", actorId: MEMBER },
    catalog: { loadStoreContext: async () => ({ vendorId: 10, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE,
      storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true }) },
    findRequestKeyUse: async () => ({ productRevision: null, categoryRevision: null, ledger: null, children: [] }),
    findPriceChangeApplyByReview: async () => null,
    loadPriceChangeReview: async () => ({ ...W7_REVIEW, rowsBytes: 2 }),
    lockCatalog: async (input: { productIds?: readonly number[] }) => ({ lockedProductIds: [...(input.productIds ?? [])] }),
    listProductSizes: async () => [],
    loadSettingFacts: async () => ({ products: new Map(), categories: new Map() }),
    saveProductsBulk: async (input: ProductListingSettingsBulkInput) => ({ outcome: "unchanged", requestId: 902, changed: [],
      unchangedProductIds: input.products.map((product) => product.productId) }),
  } as unknown as ListingSettingWriteTransaction;
}

/**
 * Records every transaction it is asked to open. A W6 transaction, and a W12
 * clear's, waits on `hold` until the test releases it, so the first write
 * keeps the gate; any other key stops right after it is recorded (it was not
 * gated).
 */
class BlockingRepository implements ListingSettingWriteRepository {
  readonly executed: string[] = [];
  private readonly ledgers: Ledgers = new Map();
  private release!: () => void;
  private readonly hold = new Promise<void>((done) => { this.release = done; });
  private markOpened!: () => void;
  /** Resolves when the first transaction has been opened. */
  readonly opened = new Promise<void>((done) => { this.markOpened = done; });

  releaseAll(): void { this.release(); }

  async execute<T>(input: { memberId: string; storeConnectionId: number; idempotencyKey: string },
    operation: (tx: ListingSettingWriteTransaction) => Promise<T>): Promise<T> {
    this.executed.push(input.idempotencyKey);
    this.markOpened();
    if (input.idempotencyKey.startsWith(`${W12_KEY}-clear`)) {
      await this.hold;
      return operation(w12Transaction(input.idempotencyKey));
    }
    if (input.idempotencyKey.startsWith(W7_KEY)) {
      await this.hold;
      return operation(w7Transaction(input.idempotencyKey));
    }
    if (!input.idempotencyKey.startsWith("products-bulk:")) {
      throw new DropshipError(NOT_GATED, "The write reached its transaction.", { classification: "permanent" });
    }
    await this.hold;
    return operation(w6Transaction(input.idempotencyKey, this.ledgers));
  }

  async executeForSystem(): Promise<never> { throw new Error("No system write here."); }
  async executeReview(): Promise<never> { throw new Error("No price check opens its transaction here: the gate refuses it first."); }
  async readPriceChangeReviewForMember(): Promise<never> { throw new Error("No price check here."); }

  async preflight<T>(_input: unknown, _operation: (tx: ListingSettingPreflightTransaction) => Promise<T>): Promise<T> {
    throw new Error("No eBay id is set here, so no preflight runs.");
  }
}

const CONVERSION_KEY = "ls-convert:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const conversionBody = (idempotencyKey = CONVERSION_KEY) => ({ idempotencyKey, planHash: "a".repeat(64), writesHash: "b".repeat(64) });

/**
 * The rules conversion's own transaction (PR 11, plan D10): it records every
 * apply it opens, holds it until released, and answers with a body that
 * converts nothing (no older rules), so no plan is needed here.
 */
class BlockingConversionRepository implements ListingRulesConversionRepository {
  readonly executed: string[] = [];
  private release!: () => void;
  private readonly hold = new Promise<void>((done) => { this.release = done; });
  private markOpened!: () => void;
  readonly opened = new Promise<void>((done) => { this.markOpened = done; });

  releaseAll(): void { this.release(); }

  async executeConversion<T>(input: ListingRulesConversionExecuteInput, operation: (tx: ListingRulesConversionTransaction) => Promise<T>): Promise<T> {
    this.executed.push(input.actorType === "vendor" ? input.idempotencyKey : input.jobKey);
    this.markOpened();
    await this.hold;
    return operation({
      vendorId: 10, storeConnectionId: STORE, requestKey: CONVERSION_KEY, actor: { actorType: "vendor", actorId: MEMBER },
      authorize: async () => ({ vendorId: 10, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE,
        storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true }),
      findConversionByKey: async () => null,
      loadOlderGroupRuleCounts: async () => ({ pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 }),
    } as unknown as ListingRulesConversionTransaction);
  }
}

const ebay: ListingSettingEbayPort = {
  describeCategories: async () => { throw new Error("eBay is not asked here."); },
  discoverPolicies: async () => { throw new Error("eBay is not asked here."); },
  loadFulfillmentCapability: async () => { throw new Error("eBay is not asked here."); },
  listStoreShelves: async () => { throw new Error("eBay is not asked here."); },
};

async function failure(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

let repository: BlockingRepository;

beforeEach(() => {
  vi.clearAllMocks();
  repository = new BlockingRepository();
});

describe("createDropshipListingSettingWriteServices (plan 3.10 (a), 7.12)", () => {
  it("answers a second W6 sent while the first holds the gate with BUSY, and opens one transaction", async () => {
    const services = createDropshipListingSettingWriteServices({ repository, ebay });
    const first = services.products.saveBulkForMember(MEMBER, STORE, w6Body());
    await repository.opened;

    const busy = await failure(services.products.saveBulkForMember(MEMBER, STORE, w6Body(`${W6_KEY}-second`)));

    expect(busy).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: {
      reason: "heavy_write_in_progress", retryAfterSeconds: 5, retryable: true, classification: "transient" } });
    expect(repository.executed).toEqual([W6_KEY]);
    repository.releaseAll();
    await expect(first).resolves.toEqual({ outcome: "changed", requestId: 900, productCount: 1, changedProductCount: 1, clearedSizeCount: 0 });
    // The success line went through the platform logger.
    expect(logger.info).toHaveBeenCalledWith("dropship.listing_settings.products_bulk_saved", expect.objectContaining({ outcome: "changed" }));

    // Released: the next W6 opens its transaction.
    await expect(services.products.saveBulkForMember(MEMBER, STORE, w6Body(`${W6_KEY}-third`))).resolves.toMatchObject({ outcome: "changed" });
    expect(repository.executed).toEqual([W6_KEY, `${W6_KEY}-third`]);
  });

  it("answers the same key sent twice at once in one process with BUSY, not a wait on the request lock; its retry replays", async () => {
    const services = createDropshipListingSettingWriteServices({ repository, ebay });
    const first = services.products.saveBulkForMember(MEMBER, STORE, w6Body());
    await repository.opened;

    // A double submit: the gate refuses it before its transaction, so it never reaches the request lock (one dyno).
    const busy = await failure(services.products.saveBulkForMember(MEMBER, STORE, w6Body()));

    expect(busy).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: {
      reason: "heavy_write_in_progress", retryAfterSeconds: 5, classification: "transient" } });
    expect(repository.executed).toEqual([W6_KEY]);
    repository.releaseAll();
    const written = await first;
    expect(written).toMatchObject({ outcome: "changed" });

    // The resend after Retry-After: the probe finds the committed request's ledger row.
    await expect(services.products.saveBulkForMember(MEMBER, STORE, w6Body())).resolves.toEqual({ ...written, outcome: "replayed",
      changedProductCount: null, clearedSizeCount: null });
    expect(repository.executed).toEqual([W6_KEY, W6_KEY]);
  });

  it("answers a W12 clear sent while a W6 holds the gate with BUSY, before its transaction: one gate for every heavy writer", async () => {
    const services = createDropshipListingSettingWriteServices({ repository, ebay });
    const heavy = services.products.saveBulkForMember(MEMBER, STORE, w6Body());
    await repository.opened;
    try {
      const busy = await failure(services.categories.saveForMember(MEMBER, STORE, CATEGORY, w12Clear()));
      expect(busy).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: {
        reason: "heavy_write_in_progress", retryAfterSeconds: 5, retryable: true, classification: "transient" } });
      expect(repository.executed).toEqual([W6_KEY]);
    } finally {
      repository.releaseAll();
      await heavy;
    }
    // Released: the clear opens its transaction and saves.
    await expect(services.categories.saveForMember(MEMBER, STORE, CATEGORY, w12Clear())).resolves.toEqual({
      outcome: "changed", categoryId: CATEGORY, revisionId: 41, clearedProductCount: 1 });
    expect(repository.executed).toEqual([W6_KEY, `${W12_KEY}-clear`]);
    expect(logger.info).toHaveBeenCalledWith("dropship.listing_settings.category_saved", expect.objectContaining({ outcome: "changed",
      cleared_product_count: 1 }));
  });

  it("answers a W6 sent while a W12 clear holds the gate with BUSY: the gate is the factory's, not W6's", async () => {
    const services = createDropshipListingSettingWriteServices({ repository, ebay });
    const clear = services.categories.saveForMember(MEMBER, STORE, CATEGORY, w12Clear());
    await repository.opened;
    try {
      const busy = await failure(services.products.saveBulkForMember(MEMBER, STORE, w6Body()));
      expect(busy).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: { reason: "heavy_write_in_progress" } });
      // A W12 without a clear is a single write: never gated, it reaches its transaction.
      const plain = await failure(services.categories.saveForMember(MEMBER, STORE, CATEGORY, w12Plain()));
      expect(plain.code).toBe(NOT_GATED);
      expect(repository.executed).toEqual([`${W12_KEY}-clear`, W12_KEY]);
    } finally {
      repository.releaseAll();
      await expect(clear).resolves.toMatchObject({ outcome: "changed" });
    }
  });

  it("answers a W7 apply and a W7 price check sent while a W6 holds the gate with BUSY, before their transactions (plan 9.13)", async () => {
    const services = createDropshipListingSettingWriteServices({ repository, ebay });
    const heavy = services.products.saveBulkForMember(MEMBER, STORE, w6Body());
    await repository.opened;
    try {
      const applyBusy = await failure(services.priceChanges.applyForMember(MEMBER, STORE, w7Apply()));
      expect(applyBusy).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: {
        reason: "heavy_write_in_progress", retryAfterSeconds: 5, retryable: true, classification: "transient" } });
      const reviewBusy = await failure(services.priceChanges.reviewForMember(MEMBER, STORE, { kind: "product_prices", productIds: [7],
        releaseExactPrices: true }));
      expect(reviewBusy.code).toBe("DROPSHIP_LISTING_SETTINGS_BUSY");
      expect(repository.executed).toEqual([W6_KEY]);
    } finally {
      repository.releaseAll();
      await heavy;
    }
    // Released: the apply opens its transaction and writes its ledger row.
    await expect(services.priceChanges.applyForMember(MEMBER, STORE, w7Apply())).resolves.toEqual({ outcome: "unchanged",
      reviewId: REVIEW_ID, requestId: 902, changedProductCount: 0, releasedSizeCount: 0, categoryRevisionId: null });
    expect(repository.executed).toEqual([W6_KEY, W7_KEY]);
    expect(logger.info).toHaveBeenCalledWith("dropship.listing_settings.price_change_applied", expect.objectContaining({
      outcome: "unchanged", review_id: REVIEW_ID, request_id: 902 }));
  });

  it("answers a W6 sent while a W7 apply holds the gate with BUSY: the gate is the factory's, not W6's", async () => {
    const services = createDropshipListingSettingWriteServices({ repository, ebay });
    const applying = services.priceChanges.applyForMember(MEMBER, STORE, w7Apply());
    await repository.opened;
    try {
      const busy = await failure(services.products.saveBulkForMember(MEMBER, STORE, w6Body()));
      expect(busy).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: { reason: "heavy_write_in_progress" } });
      const second = await failure(services.priceChanges.applyForMember(MEMBER, STORE, w7Apply(`${W7_KEY}-second`)));
      expect(second.code).toBe("DROPSHIP_LISTING_SETTINGS_BUSY");
      expect(repository.executed).toEqual([W7_KEY]);
    } finally {
      repository.releaseAll();
      await expect(applying).resolves.toMatchObject({ outcome: "unchanged", requestId: 902 });
    }
  });

  it("never gates the single writers: a W5, a W8 and a W13 sent while a W6 holds the gate reach their transactions", async () => {
    const services = createDropshipListingSettingWriteServices({ repository, ebay });
    const heavy = services.products.saveBulkForMember(MEMBER, STORE, w6Body());
    await repository.opened;
    try {
      const w5 = await failure(services.products.saveForMember(MEMBER, STORE, 7, {
        idempotencyKey: "product-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b", expectedRevisionId: null, patch: { storeShelf: { mode: "none" } } }));
      const w8 = await failure(services.sizePrices.saveForMember(MEMBER, STORE, {
        idempotencyKey: "size-prices:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b", rows: [{ productVariantId: 101, priceCents: 1_499, expectedRevisionId: null }] }));
      const w13 = await failure(services.categoryMoves.acknowledgeForMember(MEMBER, STORE, {
        idempotencyKey: "category-moves:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b", items: [{ productId: 7, shownCategoryId: 3 }] }));
      expect([w5.code, w8.code, w13.code]).toEqual([NOT_GATED, NOT_GATED, NOT_GATED]);
      expect(repository.executed).toEqual([W6_KEY, "product-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b",
        "size-prices:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b", "category-moves:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b"]);
    } finally {
      repository.releaseAll();
      await heavy;
    }
  });

  it("never gates the notice's Got it (11e1): sent while a W6 holds the gate it reaches its own transaction, and logs one INFO", async () => {
    const presses: Array<{ memberId: string; storeConnectionId: number; conversionId: number; now: Date }> = [];
    const noticeRepository: ListingRulesConversionNoticeRepository = {
      acknowledgeNotice: async (input) => { presses.push(input); return { vendorId: 7, outcome: "acknowledged" }; },
    };
    const services = createDropshipListingSettingWriteServices({ repository, ebay, noticeRepository });
    const heavy = services.products.saveBulkForMember(MEMBER, STORE, w6Body());
    await repository.opened;
    try {
      await expect(services.conversionNotice.acknowledgeForMember(MEMBER, STORE, { conversionId: 41 })).resolves.toEqual({ outcome: "acknowledged" });
      expect(presses).toEqual([{ memberId: MEMBER, storeConnectionId: STORE, conversionId: 41, now: expect.any(Date) }]);
      // The W6 transaction alone used the PR 9 wrapper: the notice has its own (no request key, no store lock).
      expect(repository.executed).toEqual([W6_KEY]);
      expect(logger.info).toHaveBeenCalledWith("dropship.listing_settings.rules_conversion_notice_seen", expect.objectContaining({
        outcome: "acknowledged", vendor_id: 7, store_connection_id: STORE, conversion_id: 41, actor_id: MEMBER }));
    } finally {
      repository.releaseAll();
      await heavy;
    }
  });

  it("answers a rules conversion apply sent while a W6 holds the gate with BUSY, before its transaction (PR 11, plan 7.B.1)", async () => {
    const conversionRepository = new BlockingConversionRepository();
    conversionRepository.releaseAll();
    const services = createDropshipListingSettingWriteServices({ repository, ebay, conversionRepository });
    const heavy = services.products.saveBulkForMember(MEMBER, STORE, w6Body());
    await repository.opened;
    try {
      const busy = await failure(services.conversion.applyForMember(MEMBER, STORE, conversionBody()));
      expect(busy).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: {
        reason: "heavy_write_in_progress", retryAfterSeconds: 5, retryable: true, classification: "transient" } });
      expect(conversionRepository.executed).toEqual([]);
    } finally {
      repository.releaseAll();
      await heavy;
    }
    // Released: the apply opens its own transaction (not the PR 9 wrapper's) and answers.
    await expect(services.conversion.applyForMember(MEMBER, STORE, conversionBody())).resolves.toEqual({ outcome: "nothing_to_convert",
      conversionId: null, categoryCount: 0, productCount: 0 });
    expect(conversionRepository.executed).toEqual([CONVERSION_KEY]);
    expect(repository.executed).toEqual([W6_KEY]);
    expect(logger.info).toHaveBeenCalledWith("dropship.listing_settings.rules_conversion_applied", expect.objectContaining({
      outcome: "nothing_to_convert", store_connection_id: STORE, actor_id: MEMBER, request_key: CONVERSION_KEY }));
  });

  it("answers a W6 and a second apply sent while a rules conversion holds the gate with BUSY: one gate for every heavy writer", async () => {
    const conversionRepository = new BlockingConversionRepository();
    const services = createDropshipListingSettingWriteServices({ repository, ebay, conversionRepository });
    const applying = services.conversion.applyForMember(MEMBER, STORE, conversionBody());
    await conversionRepository.opened;
    try {
      expect((await failure(services.products.saveBulkForMember(MEMBER, STORE, w6Body()))).context)
        .toMatchObject({ reason: "heavy_write_in_progress" });
      expect((await failure(services.conversion.applyForMember(MEMBER, STORE, conversionBody(`${CONVERSION_KEY}-second`)))).code)
        .toBe("DROPSHIP_LISTING_SETTINGS_BUSY");
      expect(repository.executed).toEqual([]);
      expect(conversionRepository.executed).toEqual([CONVERSION_KEY]);
    } finally {
      conversionRepository.releaseAll();
      await expect(applying).resolves.toMatchObject({ outcome: "nothing_to_convert" });
    }
  });

  it("wires the production conversion repository with the cost-read reporter: WARN for a transient failure, DEBUG for a fatal one", async () => {
    // No conversionRepository override: the factory builds the real one. Its transaction is not opened (the pool is the mock's);
    // the spy reads the reporter the factory gave it, then stops the apply before any connection.
    let reporter: ((failure: Record<string, unknown>) => void) | null = null;
    const stopped = new Error("stopped before a connection");
    const spy = vi.spyOn(PgDropshipListingRulesConversionRepository.prototype, "executeConversion").mockImplementation(async function (
      this: PgDropshipListingRulesConversionRepository) {
      reporter = (this as unknown as { reportCostReadFailure: (failure: Record<string, unknown>) => void }).reportCostReadFailure;
      throw stopped;
    });
    try {
      const services = createDropshipListingSettingWriteServices({ repository, ebay });
      await expect(services.conversion.applyForMember(MEMBER, STORE, conversionBody())).rejects.toBe(stopped);
    } finally {
      spy.mockRestore();
    }
    expect(reporter).not.toBeNull();
    const failure = { vendorId: 10, storeConnectionId: STORE, variantCount: 3, stage: "load_costs" };
    reporter!({ ...failure, sqlState: "57014" });
    expect(logger.warn).toHaveBeenCalledWith("dropship.listing_settings.rules_conversion_cost_read_failed", { outcome: "deferred",
      error_code: "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE", error_class: "transient", vendor_id: 10, store_connection_id: STORE,
      variant_count: 3, stage: "load_costs", sql_state: "57014" });
    reporter!({ ...failure, sqlState: "42P01" });
    expect(logger.debug).toHaveBeenCalledWith("dropship.listing_settings.rules_conversion_cost_read_failed", expect.objectContaining({
      outcome: "failed", error_class: "fatal", stage: "load_costs", sql_state: "42P01" }));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("builds the gate per factory call, not per module: production calls it once per process", async () => {
    const held = createDropshipListingSettingWriteServices({ repository, ebay });
    const heavy = held.products.saveBulkForMember(MEMBER, STORE, w6Body());
    await repository.opened;
    const other = new BlockingRepository();
    const separate = createDropshipListingSettingWriteServices({ repository: other, ebay });
    const second = separate.products.saveBulkForMember(MEMBER, STORE, w6Body(`${W6_KEY}-elsewhere`));
    await other.opened;
    expect(other.executed).toEqual([`${W6_KEY}-elsewhere`]);
    repository.releaseAll();
    other.releaseAll();
    await expect(Promise.all([heavy, second])).resolves.toHaveLength(2);
  });
});
