import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingSettingEbayPort } from "../../application/dropship-listing-setting-ebay-values";
import type {
  ListingSettingPreflightTransaction,
  ListingSettingWriteRepository,
  ListingSettingWriteTransaction,
  ProductListingSettingsBulkInput,
} from "../../application/dropship-listing-setting-writes";
import { DropshipError } from "../../domain/errors";

// The production repository's module opens the shared pool on import; nothing here reaches it, a repository is injected.
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { logger } from "../../../../platform/observability/logger";
import { createDropshipListingSettingWriteServices } from "../../infrastructure/dropship-listing-setting-writes.factory";

/**
 * The real wiring (plan PR 9, 3.10 (a), 7.12; v3r, C-feas-9): the services
 * the factory builds, with only the repository and the eBay port injected
 * through its `overrides` seam (no module mock of either). One heavy-write
 * gate per factory call, which production makes once per process
 * (registerDropshipListingSettingWritesRoutes), shared by the heavy writers;
 * the single writers (W5, W8) are never gated. 9e adds a W12 clear here and
 * 9f a W7 apply.
 */

const MEMBER = "member-1";
const STORE = 22;
const W6_KEY = "products-bulk:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const w6Body = (idempotencyKey = W6_KEY) =>
  ({ idempotencyKey, products: [{ productId: 7, expectedRevisionId: null }], patch: { storeShelf: { mode: "none" } } });
const NOT_GATED = "TEST_REACHED_THE_TRANSACTION";

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

/**
 * Records every transaction it is asked to open. A W6 transaction waits on
 * `hold` until the test releases it, so the first write keeps the gate; any
 * other key stops right after it is recorded (it was not gated).
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
    if (!input.idempotencyKey.startsWith("products-bulk:")) {
      throw new DropshipError(NOT_GATED, "The write reached its transaction.", { classification: "permanent" });
    }
    await this.hold;
    return operation(w6Transaction(input.idempotencyKey, this.ledgers));
  }

  async executeForSystem(): Promise<never> { throw new Error("No system write here."); }

  async preflight<T>(_input: unknown, _operation: (tx: ListingSettingPreflightTransaction) => Promise<T>): Promise<T> {
    throw new Error("No eBay id is set here, so no preflight runs.");
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

  it("never gates the single writers: a W5 and a W8 sent while a W6 holds the gate reach their transactions", async () => {
    const services = createDropshipListingSettingWriteServices({ repository, ebay });
    const heavy = services.products.saveBulkForMember(MEMBER, STORE, w6Body());
    await repository.opened;
    try {
      const w5 = await failure(services.products.saveForMember(MEMBER, STORE, 7, {
        idempotencyKey: "product-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b", expectedRevisionId: null, patch: { storeShelf: { mode: "none" } } }));
      const w8 = await failure(services.sizePrices.saveForMember(MEMBER, STORE, {
        idempotencyKey: "size-prices:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b", rows: [{ productVariantId: 101, priceCents: 1_499, expectedRevisionId: null }] }));
      expect([w5.code, w8.code]).toEqual([NOT_GATED, NOT_GATED]);
      expect(repository.executed).toEqual([W6_KEY, "product-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b",
        "size-prices:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b"]);
    } finally {
      repository.releaseAll();
      await heavy;
    }
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
