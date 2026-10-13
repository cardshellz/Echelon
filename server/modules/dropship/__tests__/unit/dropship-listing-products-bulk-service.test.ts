import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { MAX_BULK_TEXT_BYTES, MAX_STORE_LISTING_TEXT_BYTES } from "../../../../../shared/dropship/listing-setting-writes";
import type { DropshipListingStoreContext } from "../../application/dropship-listing-preview-service";
import { DropshipListingProductsBulkService } from "../../application/dropship-listing-products-bulk-service";
import type { ListingSettingEbayPort } from "../../application/dropship-listing-setting-ebay-values";
import { ListingSettingHeavyWriteGate } from "../../application/dropship-listing-setting-write-support";
import type {
  ClearSizeLeftoversInput,
  ListingSettingPreflightTransaction,
  ListingSettingWriteRepository,
  ListingSettingWriteTransaction,
  ListingTextBytes,
  ListingTextBytesInput,
  ProductListingSettingsBulkInput,
  ProductListingSettingsBulkResult,
} from "../../application/dropship-listing-setting-writes";
import { DropshipError } from "../../domain/errors";
import type { RequestKeyUse } from "../../domain/listing-setting-request-key-use";
import { listingSettingRequestHash } from "../../domain/listing-setting-values";

/**
 * W6 with every port stubbed (plan PR 9, sections 7.5, 7.12): the call order
 * inside the heavy-write gate, the replay answered from the ledger with no
 * writer, the pure and the in-transaction text checks before lockCatalog, the
 * store text cap, the clean-ups over the locked products (also on
 * unchanged), the eBay step and the INFO line.
 */

const NOW = new Date("2026-10-13T09:00:00.000Z");
const MEMBER = "member-1";
const VENDOR = 10;
const STORE = 22;
const KEY = "products-bulk:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const NOTHING: RequestKeyUse = { productRevision: null, categoryRevision: null, ledger: null, children: [] };
const storeContext: DropshipListingStoreContext = {
  vendorId: VENDOR, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE, storeStatus: "connected",
  setupStatus: "ready", platform: "ebay", storeLaunchReady: true,
};
const NO_TEXT: ListingTextBytes = { storeBytes: 0, keptStoreBytes: 0, targetBytes: 0 };

/** The write transaction: each port records its name in `calls`; answers are set per test. */
class FakeTransaction {
  readonly calls: string[] = [];
  readonly vendorId = VENDOR;
  readonly storeConnectionId = STORE;
  readonly requestKey = KEY;
  readonly actor = { actorType: "vendor" as const, actorId: MEMBER };
  use: RequestKeyUse = NOTHING;
  textBytes: ListingTextBytes = NO_TEXT;
  /** null: every product the lock was given exists. */
  lockedProductIds: number[] | null = null;
  bulkResult: ProductListingSettingsBulkResult | null = null;
  readonly catalog = {
    loadStoreContext: vi.fn(async () => { this.calls.push("gate"); return storeContext; }),
  };
  readonly findRequestKeyUse = vi.fn(async () => { this.calls.push("probe"); return this.use; });
  readonly readListingTextBytes = vi.fn(async (_input: ListingTextBytesInput) => { this.calls.push("textBytes"); return this.textBytes; });
  readonly lockCatalog = vi.fn(async (input: { productIds?: readonly number[] }) => {
    this.calls.push("lockCatalog");
    return { lockedProductIds: this.lockedProductIds ?? [...(input.productIds ?? [])] };
  });
  readonly saveProductsBulk = vi.fn(async (input: ProductListingSettingsBulkInput): Promise<ProductListingSettingsBulkResult> => {
    this.calls.push("saveProductsBulk");
    return this.bulkResult ?? { outcome: "changed", requestId: 900,
      changed: input.products.map((product) => ({ productId: product.productId, revisionId: product.productId + 5_000 })), unchangedProductIds: [] };
  });
  readonly clearSizeLeftovers = vi.fn(async (_input: ClearSizeLeftoversInput) => {
    this.calls.push("clearSizeLeftovers");
    return { clearedSizeCount: 3, byKind: { policy: 1, shelf: 2, content: 0 }, productVariantIds: [101, 102, 103] };
  });
}

class FakePreflight {
  readonly calls: string[] = [];
  readonly vendorId = VENDOR;
  readonly storeConnectionId = STORE;
  context: DropshipListingStoreContext = storeContext;
  use: RequestKeyUse = NOTHING;
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
  readonly loadProducts = vi.fn(async () => { throw new Error("W6's preflight reads no product: every set eBay id is new."); });
  readonly loadCategories = vi.fn(async () => { throw new Error("W6's preflight reads no category."); });
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
  async executeForSystem(): Promise<never> { throw new Error("W6 never runs as the system."); }
  async executeReview(): Promise<never> { throw new Error("W6 never runs a price check (W7's review)."); }
  async readPriceChangeReviewForMember(): Promise<never> { throw new Error("W6 never reads a price check's pages."); }
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
    listStoreShelves: vi.fn(async () => {
      calls.push("shelves");
      return [{ categoryId: "11", categoryName: "Top", path: "Supplies:Top", level: 2 }];
    }),
  };
  return { port, calls };
}

let repository: FakeRepository;
let ebay: ReturnType<typeof ebayPort>;
let log: { info: Mock<(action: string, fields: Record<string, unknown>) => void> };
let gate: RecordingGate;
let service: DropshipListingProductsBulkService;

const product = (productId: number, expectedRevisionId: number | null = null) => ({ productId, expectedRevisionId });
const body = (fields: Record<string, unknown> = {}) =>
  ({ idempotencyKey: KEY, products: [product(9, 49), product(7)], patch: { storeShelf: { mode: "none" } }, ...fields });
const ownText = (text: string) => ({ mode: "own", text });
const hashOf = (products: ReturnType<typeof product>[], patch: Record<string, unknown>) => listingSettingRequestHash({
  operation: "product_settings_bulk_v1", storeConnectionId: STORE,
  products: [...products].sort((left, right) => left.productId - right.productId), patch });
const ledger = (requestHash: string, storeConnectionId = STORE) =>
  ({ requestId: 900, operation: "product_settings_bulk" as const, storeConnectionId, requestHash });

async function refusal(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

/** Nothing was locked or written. */
function expectNothingWritten(tx: FakeTransaction) {
  expect(tx.lockCatalog).not.toHaveBeenCalled();
  expect(tx.saveProductsBulk).not.toHaveBeenCalled();
  expect(tx.clearSizeLeftovers).not.toHaveBeenCalled();
}

/** n products with ids from 1, none stored yet. */
const manyProducts = (count: number) => Array.from({ length: count }, (_, index) => product(index + 1));
/** A patch whose own texts carry exactly `bytes` ASCII bytes (at most two parts of 4,000). */
function textPatch(bytes: number): Record<string, unknown> {
  const above = Math.min(bytes, 4_000);
  return { textAbove: ownText("a".repeat(above)), ...(bytes > above ? { textBelow: ownText("b".repeat(bytes - above)) } : {}) };
}

const save = (input: unknown) => service.saveBulkForMember(MEMBER, STORE, input);

beforeEach(() => {
  repository = new FakeRepository();
  ebay = ebayPort();
  log = { info: vi.fn() };
  gate = new RecordingGate(repository.order);
  let tick = 100;
  const timer = vi.fn(() => { const value = tick; tick += 42; return value; });
  service = new DropshipListingProductsBulkService({ repository, ebay: ebay.port, heavyWrites: gate, clock: { now: () => NOW }, timer, log });
});

describe("DropshipListingProductsBulkService.saveBulkForMember (W6, plan PR 9, 7.5)", () => {
  it("runs inside the heavy-write gate: gate, probe, text count, lock, writer, clean-ups; one clock; inputs unchanged", async () => {
    const products = Object.freeze([Object.freeze(product(9, 49)), Object.freeze(product(7))]);
    const input = Object.freeze(body({ products, patch: Object.freeze({ storeShelf: Object.freeze({ mode: "none" }) }) }));

    const result = await save(input);

    expect(result).toEqual({ outcome: "changed", requestId: 900, productCount: 2, changedProductCount: 2, clearedSizeCount: 3 });
    // No eBay id set: no preflight; the transaction runs inside the gate.
    expect(repository.order).toEqual(["gate:enter", `execute:${KEY}`, "gate:leave"]);
    expect(repository.tx.calls).toEqual(["gate", "probe", "textBytes", "lockCatalog", "saveProductsBulk", "clearSizeLeftovers"]);
    expect(repository.tx.readListingTextBytes).toHaveBeenCalledWith({ productIds: [7, 9],
      replacedFields: { textAbove: false, textBelow: false, mainText: false } });
    expect(repository.tx.lockCatalog).toHaveBeenCalledWith({ productIds: [7, 9] });
    const hash = hashOf([product(9, 49), product(7)], { storeShelf: { mode: "none" } });
    expect(repository.tx.saveProductsBulk).toHaveBeenCalledWith({ operation: "product_settings_bulk",
      products: [product(7), product(9, 49)], patch: { storeShelf: { mode: "none" } }, requestHash: hash, now: NOW });
    expect(repository.tx.clearSizeLeftovers).toHaveBeenCalledWith({ productIds: [7, 9], fields: ["storeShelf"], requestHash: hash, now: NOW });
    expect(ebay.calls).toEqual([]);
    // The frozen input was read, never changed (CLAUDE.md §4).
    expect(products.map((entry) => entry.productId)).toEqual([9, 7]);
  });

  it("hashes the same request the same whatever order its products are sent in", async () => {
    await save(body({ products: [product(9, 49), product(7)] }));
    await save(body({ idempotencyKey: `${KEY}-2`, products: [product(7), product(9, 49)] }));
    const hashes = repository.tx.saveProductsBulk.mock.calls.map(([call]) => call.requestHash);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("logs one INFO line with the common fields, W6's own, elapsed_ms from the timer, and no text", async () => {
    await save(body({ patch: { textAbove: ownText("Ships in one day."), shippingPolicy: null } }));
    expect(log.info).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.products_bulk_saved", {
      outcome: "changed", vendor_id: VENDOR, store_connection_id: STORE, actor_id: MEMBER, request_key: KEY,
      before: [{ product_id: 7, revision_id: null }, { product_id: 9, revision_id: 49 }],
      after: [{ product_id: 7, revision_id: 5_007 }, { product_id: 9, revision_id: 5_009 }],
      changed_count: 2, size_count: 0, elapsed_ms: 42,
      request_id: 900, product_count: 2, changed_fields: ["shippingPolicy", "textAbove"], cleared_size_count: 3,
      text_bytes: 34, store_text_bytes: 34,
    });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("Ships in one day");
  });

  it("lists at most 100 products in before and after, with the full counts beside them", async () => {
    await save(body({ products: manyProducts(150) }));
    const fields = log.info.mock.calls[0][1];
    expect(fields.before).toHaveLength(100);
    expect(fields.after).toHaveLength(100);
    expect(fields).toMatchObject({ changed_count: 150, product_count: 150 });
  });

  it("answers a replay from the ledger row with no counts: no text count, no lock, no writer, no clean-up", async () => {
    const tx = repository.tx;
    tx.use = { ...NOTHING, ledger: ledger(hashOf([product(9, 49), product(7)], { storeShelf: { mode: "none" } })) };
    for (const port of ["readListingTextBytes", "lockCatalog", "saveProductsBulk", "clearSizeLeftovers"] as const) {
      (tx[port] as Mock).mockImplementation(() => { throw new Error(`${port} must not run on a replay`); });
    }

    const result = await save(body());

    expect(result).toEqual({ outcome: "replayed", requestId: 900, productCount: 2, changedProductCount: null, clearedSizeCount: null });
    expect(tx.calls).toEqual(["gate", "probe"]);
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.products_bulk_saved", expect.objectContaining({
      outcome: "replayed", before: [], after: [], changed_count: 0, request_id: 900, cleared_size_count: null, text_bytes: null }));
    expect(log.info.mock.calls[0][1]).not.toHaveProperty("store_text_bytes");
  });

  it("answers a key used for another change as a permanent 409, and a ledger-less key use as fatal, writing nothing", async () => {
    repository.tx.use = { ...NOTHING, ledger: ledger("b".repeat(64)) };
    const conflict = await refusal(save(body()));
    expect(conflict.code).toBe("DROPSHIP_IDEMPOTENCY_CONFLICT");
    expect(conflict.context).toMatchObject({ mismatched: ["ledger.requestHash"], classification: "permanent" });

    // The same key on the member's other store.
    repository.tx.use = { ...NOTHING, ledger: ledger(hashOf([product(9, 49), product(7)], { storeShelf: { mode: "none" } }), 24) };
    const otherStore = await refusal(save(body()));
    expect(otherStore.context?.mismatched).toEqual(["ledger.storeConnectionId"]);

    // A policy child of this request with no ledger row: a committed W6 always writes its ledger row.
    repository.tx.use = { ...NOTHING, children: [{ kind: "policy", revisionId: 5, productVariantId: 101, storeConnectionId: STORE,
      requestHash: hashOf([product(9, 49), product(7)], { storeShelf: { mode: "none" } }) }] };
    const incomplete = await refusal(save(body()));
    expect(incomplete).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", context: { classification: "fatal" } });
    expectNothingWritten(repository.tx);
  });

  it("passes the writer's version conflict through, with nothing cleaned", async () => {
    repository.tx.saveProductsBulk.mockImplementation(async () => {
      throw new DropshipError("DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", "Listing settings changed after you opened them.", {
        storeConnectionId: STORE, conflicts: [{ productId: 9, expectedRevisionId: 49, actualRevisionId: 50 }], conflictCount: 1,
        retryable: false, classification: "permanent" });
    });
    const error = await refusal(save(body()));
    expect(error).toMatchObject({ code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", context: { conflictCount: 1 } });
    expect(repository.tx.clearSizeLeftovers).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(repository.order).toEqual(["gate:enter", `execute:${KEY}`, "gate:leave"]);
  });

  describe("the clean-ups (plan P17, P18; v3r, C-money-2)", () => {
    it("run after the writer even when no product changed, and make the answer changed", async () => {
      repository.tx.bulkResult = { outcome: "unchanged", requestId: 901, changed: [], unchangedProductIds: [7, 9] };
      const result = await save(body({ patch: { shippingPolicy: null, mainText: null } }));
      expect(repository.tx.calls.slice(-2)).toEqual(["saveProductsBulk", "clearSizeLeftovers"]);
      expect(repository.tx.clearSizeLeftovers).toHaveBeenCalledWith(expect.objectContaining({ fields: ["shippingPolicy", "mainText"] }));
      expect(result).toEqual({ outcome: "changed", requestId: 901, productCount: 2, changedProductCount: 0, clearedSizeCount: 3 });
    });

    it("answer unchanged when nothing changed and no size had a leftover", async () => {
      repository.tx.bulkResult = { outcome: "unchanged", requestId: 901, changed: [], unchangedProductIds: [7, 9] };
      repository.tx.clearSizeLeftovers.mockImplementation(async () => {
        repository.tx.calls.push("clearSizeLeftovers");
        return { clearedSizeCount: 0, byKind: { policy: 0, shelf: 0, content: 0 }, productVariantIds: [] };
      });
      expect(await save(body())).toEqual({ outcome: "unchanged", requestId: 901, productCount: 2, changedProductCount: 0, clearedSizeCount: 0 });
    });

    it("clean only the products lockCatalog locked, never the request's list", async () => {
      repository.tx.lockedProductIds = [9];
      await save(body({ products: [product(9, 49), product(7), product(8)] }));
      expect(repository.tx.clearSizeLeftovers).toHaveBeenCalledWith(expect.objectContaining({ productIds: [9] }));
    });

    it("are skipped when every named product is gone (a reset of deleted products is unchanged, never a fault)", async () => {
      repository.tx.lockedProductIds = [];
      repository.tx.bulkResult = { outcome: "unchanged", requestId: 902, changed: [], unchangedProductIds: [7, 9] };
      const result = await save(body({ patch: { shippingPolicy: null } }));
      expect(repository.tx.clearSizeLeftovers).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: "unchanged", requestId: 902, productCount: 2, changedProductCount: 0, clearedSizeCount: 0 });
    });

    it("are skipped when the patch touches no leftover field (text above and below only)", async () => {
      const result = await save(body({ patch: { textAbove: ownText("Above."), textBelow: { mode: "none" } } }));
      expect(repository.tx.clearSizeLeftovers).not.toHaveBeenCalled();
      expect(result).toMatchObject({ outcome: "changed", clearedSizeCount: 0 });
    });
  });

  describe("the text budget (plan P9 (b), 3.10 (b))", () => {
    /** The products and patch text that carry exactly `MAX_BULK_TEXT_BYTES`, and the smallest total above it a request can carry. */
    function edges(): { at: { count: number; bytes: number }; above: { count: number; bytes: number } } {
      let at: { count: number; bytes: number } | null = null;
      let above: { count: number; bytes: number; total: number } | null = null;
      for (let count = 10_000; count >= 1; count -= 1) {
        const exact = MAX_BULK_TEXT_BYTES / count;
        if (at === null && Number.isInteger(exact) && exact <= 8_000) at = { count, bytes: exact };
        const over = Math.floor(MAX_BULK_TEXT_BYTES / count) + 1;
        if (over <= 8_000 && (above === null || count * over < above.total)) above = { count, bytes: over, total: count * over };
      }
      return { at: at!, above: above! };
    }

    it("refuses a patch whose own text over its products passes the budget before any connection, and accepts it at the budget", async () => {
      const { at, above } = edges();
      // MAX + 1 is not a product count times a text size, so the pure check is pinned at the smallest total above MAX.
      const refused = await refusal(save(body({ products: manyProducts(above.count), patch: textPatch(above.bytes) })));
      expect(refused).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", context: {
        textBytes: above.count * above.bytes, maxTextBytes: MAX_BULK_TEXT_BYTES, productCount: above.count,
        retryable: false, classification: "permanent" } });
      expect(above.count * above.bytes).toBeGreaterThan(MAX_BULK_TEXT_BYTES);
      expect(repository.order).toEqual([]);

      const accepted = await save(body({ products: manyProducts(at.count), patch: textPatch(at.bytes) }));
      expect(at.count * at.bytes).toBe(MAX_BULK_TEXT_BYTES);
      expect(accepted).toMatchObject({ outcome: "changed", productCount: at.count });
      expect(log.info.mock.calls[0][1]).toMatchObject({ text_bytes: MAX_BULK_TEXT_BYTES });
    });

    it("refuses an over-budget patch that also sets an eBay id before its preflight connection and before eBay", async () => {
      const { above } = edges();
      const refused = await refusal(save(body({ products: manyProducts(above.count),
        patch: { ...textPatch(above.bytes), returnPolicy: { id: "return-new" } } })));
      expect(refused).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", context: { textBytes: above.count * above.bytes } });
      // No `preflight:` entry: the pure check ran before the read-only preflight opened a connection.
      expect(repository.order).toEqual([]);
      expect(repository.pre.calls).toEqual([]);
      expect(ebay.calls).toEqual([]);
    });

    it("counts the stored text inside the transaction: refused at exactly MAX + 1 before lockCatalog, accepted at exactly MAX", async () => {
      // "Ships fast." is 11 bytes on one product: 10 bytes of room refuse it by one byte.
      repository.tx.textBytes = { storeBytes: MAX_BULK_TEXT_BYTES - 10, keptStoreBytes: MAX_BULK_TEXT_BYTES - 10, targetBytes: MAX_BULK_TEXT_BYTES - 10 };
      const refused = await refusal(save(body({ products: [product(7)], patch: { textBelow: ownText("Ships fast.") } })));
      expect(refused).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE",
        context: { textBytes: MAX_BULK_TEXT_BYTES + 1, maxTextBytes: MAX_BULK_TEXT_BYTES, productCount: 1 } });
      expect(repository.tx.calls).toEqual(["gate", "probe", "textBytes"]);
      expect(repository.tx.readListingTextBytes).toHaveBeenCalledWith({ productIds: [7],
        replacedFields: { textAbove: false, textBelow: true, mainText: false } });
      expectNothingWritten(repository.tx);

      repository.tx.textBytes = { storeBytes: MAX_BULK_TEXT_BYTES - 11, keptStoreBytes: MAX_BULK_TEXT_BYTES - 11, targetBytes: MAX_BULK_TEXT_BYTES - 11 };
      const accepted = await save(body({ idempotencyKey: `${KEY}-2`, products: [product(7)], patch: { textBelow: ownText("Ships fast.") } }));
      expect(accepted).toMatchObject({ outcome: "changed" });
      expect(log.info.mock.calls[0][1]).toMatchObject({ text_bytes: MAX_BULK_TEXT_BYTES });
    });

    it("counts every named product's patch text inside the transaction", async () => {
      // 11 bytes on two products is 22: 11 bytes of room refuse it, though one product would fit.
      repository.tx.textBytes = { storeBytes: 0, keptStoreBytes: 0, targetBytes: MAX_BULK_TEXT_BYTES - 11 };
      const refused = await refusal(save(body({ products: [product(7), product(9, 49)], patch: { textBelow: ownText("Ships fast.") } })));
      expect(refused).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE",
        context: { textBytes: MAX_BULK_TEXT_BYTES + 11, productCount: 2 } });
      expectNothingWritten(repository.tx);
    });

    it("counts stored text alone when the patch sets none (a shelf reset over long stored texts)", async () => {
      repository.tx.textBytes = { storeBytes: MAX_BULK_TEXT_BYTES + 1, keptStoreBytes: MAX_BULK_TEXT_BYTES + 1, targetBytes: MAX_BULK_TEXT_BYTES + 1 };
      const error = await refusal(save(body()));
      expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", context: { textBytes: MAX_BULK_TEXT_BYTES + 1 } });
      expectNothingWritten(repository.tx);
    });
  });

  describe("the store text cap (plan 3.10 (e); v3r, C-feas-3)", () => {
    it("refuses a set text that raises the store to exactly cap + 1, before lockCatalog, and saves one that reaches exactly the cap", async () => {
      // "Short" is 5 bytes: 4 bytes of room refuse it by one byte.
      repository.tx.textBytes = { storeBytes: MAX_STORE_LISTING_TEXT_BYTES - 4, keptStoreBytes: MAX_STORE_LISTING_TEXT_BYTES - 4, targetBytes: 0 };
      const error = await refusal(save(body({ products: [product(7)], patch: { textAbove: ownText("Short") } })));
      expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", context: { reason: "store_text_limit",
        textBytes: MAX_STORE_LISTING_TEXT_BYTES + 1, maxTextBytes: MAX_STORE_LISTING_TEXT_BYTES, classification: "permanent" } });
      expect(repository.tx.calls).toEqual(["gate", "probe", "textBytes"]);
      expectNothingWritten(repository.tx);

      repository.tx.textBytes = { storeBytes: MAX_STORE_LISTING_TEXT_BYTES - 5, keptStoreBytes: MAX_STORE_LISTING_TEXT_BYTES - 5, targetBytes: 0 };
      const saved = await save(body({ idempotencyKey: `${KEY}-2`, products: [product(7)], patch: { textAbove: ownText("Short") } }));
      expect(saved).toMatchObject({ outcome: "changed" });
      expect(log.info.mock.calls[0][1]).toMatchObject({ store_text_bytes: MAX_STORE_LISTING_TEXT_BYTES });
    });

    it("counts every named product, a missing one too: three products of 5 bytes over 10 bytes of room are refused", async () => {
      repository.tx.textBytes = { storeBytes: MAX_STORE_LISTING_TEXT_BYTES - 10, keptStoreBytes: MAX_STORE_LISTING_TEXT_BYTES - 10, targetBytes: 0 };
      const error = await refusal(save(body({ products: [product(7), product(8), product(9, 49)], patch: { textAbove: ownText("Short") } })));
      expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", context: { reason: "store_text_limit",
        textBytes: MAX_STORE_LISTING_TEXT_BYTES + 5 } });
      expectNothingWritten(repository.tx);

      // The same text on two products lands exactly at the cap: saved.
      const saved = await save(body({ idempotencyKey: `${KEY}-2`, products: [product(7), product(9, 49)], patch: { textAbove: ownText("Short") } }));
      expect(saved).toMatchObject({ outcome: "changed" });
      expect(log.info.mock.calls[0][1]).toMatchObject({ store_text_bytes: MAX_STORE_LISTING_TEXT_BYTES });
    });

    it("lets a store already over the cap shorten its text", async () => {
      repository.tx.textBytes = { storeBytes: MAX_STORE_LISTING_TEXT_BYTES + 5_000, keptStoreBytes: MAX_STORE_LISTING_TEXT_BYTES,
        targetBytes: 4_000 };
      const result = await save(body({ products: [product(7)], patch: { textAbove: ownText("Short") } }));
      expect(result).toMatchObject({ outcome: "changed" });
      expect(log.info.mock.calls[0][1]).toMatchObject({ store_text_bytes: MAX_STORE_LISTING_TEXT_BYTES + 5 });
    });

    it("is not checked when the patch sets no text: a reset over a store past the cap saves, and logs no store text", async () => {
      repository.tx.textBytes = { storeBytes: MAX_STORE_LISTING_TEXT_BYTES + 1, keptStoreBytes: MAX_STORE_LISTING_TEXT_BYTES + 1, targetBytes: 0 };
      const result = await save(body({ patch: { textAbove: null, textBelow: { mode: "none" }, mainText: null } }));
      expect(result).toMatchObject({ outcome: "changed" });
      expect(repository.tx.readListingTextBytes).toHaveBeenCalledWith({ productIds: [7, 9],
        replacedFields: { textAbove: true, textBelow: true, mainText: true } });
      expect(log.info.mock.calls[0][1]).not.toHaveProperty("store_text_bytes");
    });
  });

  describe("the eBay step (plan 7.4, 7.11 #1)", () => {
    it("asks eBay nothing for resets and a shelf none: no preflight", async () => {
      await save(body({ patch: { ebayCategory: null, storeShelf: { mode: "none" }, shippingPolicy: null, returnPolicy: null } }));
      expect(repository.order).toEqual(["gate:enter", `execute:${KEY}`, "gate:leave"]);
      expect(ebay.calls).toEqual([]);
    });

    it("treats every set id as new: preflight (gate, probe, marketplace, no product read), eBay, then the write with eBay's values", async () => {
      await save(body({ patch: { returnPolicy: { id: "return-new" }, storeShelf: { mode: "own", shelfIds: ["11"] } } }));
      expect(repository.order).toEqual([`preflight:${KEY}`, "gate:enter", `execute:${KEY}`, "gate:leave"]);
      expect(repository.pre.calls).toEqual(["gate", "probe", "listingConfig"]);
      expect(ebay.calls).toEqual(["discover", "shelves"]);
      expect(repository.tx.saveProductsBulk).toHaveBeenCalledWith(expect.objectContaining({ patch: {
        storeShelf: { mode: "own", shelves: [{ id: "11", name: "Supplies:Top" }] },
        returnPolicy: { id: "return-new", name: "Thirty days" },
      } }));
      expect(log.info.mock.calls[0][1]).toMatchObject({ ebay_ms: 42 });
    });

    it("refuses a set id on a store that needs a sign-in before any eBay call or write", async () => {
      repository.pre.context = { ...storeContext, storeStatus: "needs_reauth" };
      const error = await refusal(save(body({ patch: { shippingPolicy: { id: "ship-new" }, returnPolicy: null } })));
      expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", context: { fields: ["shippingPolicy"] } });
      expect(ebay.calls).toEqual([]);
      expect(repository.order).toEqual([`preflight:${KEY}`]);
    });

    it("asks eBay nothing when the preflight finds the key used, and replays in the write transaction", async () => {
      const patch = { returnPolicy: { id: "return-new" } };
      const used = { ...NOTHING, ledger: ledger(hashOf([product(9, 49), product(7)], patch)) };
      repository.pre.use = used;
      repository.tx.use = used;
      const result = await save(body({ patch }));
      expect(result).toMatchObject({ outcome: "replayed" });
      expect(ebay.calls).toEqual([]);
      expect(repository.pre.calls).toEqual(["gate", "probe"]);
      expect(log.info.mock.calls[0][1]).not.toHaveProperty("ebay_ms");
    });

    it("answers BUSY when the preflight saw the key used but the write finds nothing, so unresolved eBay values are never written", async () => {
      repository.pre.use = { ...NOTHING, ledger: ledger(hashOf([product(9, 49), product(7)], { returnPolicy: { id: "return-new" } })) };
      const error = await refusal(save(body({ patch: { returnPolicy: { id: "return-new" } } })));
      expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: { reason: "request_key_changed", classification: "transient" } });
      expect(repository.tx.calls).toEqual(["gate", "probe"]);
      expectNothingWritten(repository.tx);
    });
  });

  describe("the heavy-write gate (plan 3.10 (a))", () => {
    it("refuses a second write while one holds the gate, before its transaction (no pool connection), and frees it after", async () => {
      let release!: () => void;
      const held = new Promise<void>((done) => { release = done; });
      const execute = vi.spyOn(repository, "execute");
      const first = gate.run(() => held);

      const busy = await refusal(save(body()));

      expect(busy).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: { reason: "heavy_write_in_progress", retryAfterSeconds: 5 } });
      expect(execute).not.toHaveBeenCalled();
      expect(log.info).not.toHaveBeenCalled();
      release();
      await first;
      await expect(save(body())).resolves.toMatchObject({ outcome: "changed" });
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("frees the gate when the write fails", async () => {
      repository.tx.saveProductsBulk.mockImplementationOnce(async () => { throw new Error("connection reset"); });
      await expect(save(body())).rejects.toThrow("connection reset");
      await expect(save(body())).resolves.toMatchObject({ outcome: "changed" });
    });

    it("runs the preflight and eBay outside it: an eBay step never holds the gate", async () => {
      let gateHeldDuringEbay: boolean | null = null;
      (ebay.port.discoverPolicies as Mock).mockImplementation(async () => {
        // A second heavy write here would get in: the gate is free while eBay is asked.
        gateHeldDuringEbay = await gate.run(async () => false).catch(() => true);
        return { marketplaceId: "EBAY_US", merchantLocations: [], fulfillmentPolicies: [],
          returnPolicies: [{ id: "return-new", name: "Thirty days" }], paymentPolicies: [] };
      });
      await save(body({ patch: { returnPolicy: { id: "return-new" } } }));
      expect(gateHeldDuringEbay).toBe(false);
    });
  });

  describe("the route input", () => {
    it.each([
      ["a price", { patch: { price: null } }],
      ["a main text value", { patch: { mainText: { text: "Own words." } } }],
      ["no products", { products: [] }],
      ["a 7-character key", { idempotencyKey: "abcdefg" }],
    ])("refuses %s with 400 before any repository call", async (_label, fields) => {
      const error = await refusal(save(body(fields)));
      expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", context: { classification: "permanent" } });
      expect(repository.order).toEqual([]);
    });

    it("refuses a missing member and a bad store id before any repository call", async () => {
      await expect(service.saveBulkForMember("", STORE, body())).rejects.toMatchObject({ code: "DROPSHIP_AUTH_REQUIRED" });
      await expect(service.saveBulkForMember(MEMBER, Number.NaN, body())).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT" });
      expect(repository.order).toEqual([]);
    });
  });
});
