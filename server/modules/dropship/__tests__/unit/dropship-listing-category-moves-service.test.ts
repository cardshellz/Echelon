import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { DropshipListingStoreContext } from "../../application/dropship-listing-preview-service";
import type {
  CategoryMovesAcknowledgeInput,
  CategoryMovesAcknowledgeResult,
  ListingSettingWriteRepository,
  ListingSettingWriteTransaction,
} from "../../application/dropship-listing-setting-writes";
import { DropshipListingCategoryMovesService } from "../../application/dropship-listing-category-moves-service";
import { DropshipError } from "../../domain/errors";
import type { RequestKeyUse } from "../../domain/listing-setting-request-key-use";
import { listingSettingRequestHash } from "../../domain/listing-setting-values";

const NOW = new Date("2026-10-13T09:00:00.000Z");
const MEMBER = "member-1";
const VENDOR = 10;
const STORE = 22;
const KEY = "category-moves:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
type Item = { productId: number; shownCategoryId: number | null };
const HASH_OF = (items: Item[]) => listingSettingRequestHash({ operation: "category_moves_acknowledge_v1", storeConnectionId: STORE, items });
const NOTHING: RequestKeyUse = { productRevision: null, categoryRevision: null, ledger: null, children: [] };
const storeContext: DropshipListingStoreContext = {
  vendorId: VENDOR, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE, storeStatus: "connected",
  setupStatus: "ready", platform: "ebay", storeLaunchReady: true,
};

const item = (productId: number, shownCategoryId: number | null = 3): Item => ({ productId, shownCategoryId });
const body = (...items: Item[]) => ({ idempotencyKey: KEY, items });
const ledgerOf = (requestHash: string, fields: Partial<NonNullable<RequestKeyUse["ledger"]>> = {}): RequestKeyUse => ({
  ...NOTHING, ledger: { requestId: 900, operation: "category_moves_acknowledge", storeConnectionId: STORE, requestHash, ...fields },
});

/** The 8a writer is pinned by its own tests; here it answers what each case chooses and records what it was given. */
class FakeTransaction {
  readonly calls: string[] = [];
  readonly vendorId = VENDOR;
  readonly storeConnectionId = STORE;
  readonly requestKey = KEY;
  readonly actor = { actorType: "vendor" as const, actorId: MEMBER };
  context: DropshipListingStoreContext | null = storeContext;
  use: RequestKeyUse = NOTHING;
  written: CategoryMovesAcknowledgeInput[] = [];
  answer: (input: CategoryMovesAcknowledgeInput) => CategoryMovesAcknowledgeResult = (input) => ({
    outcome: "acknowledged", acknowledgedProductIds: input.items.map((entry) => entry.productId), movedAgainProductIds: [],
  });
  readonly catalog = {
    loadStoreContext: vi.fn(async () => { this.calls.push("loadStoreContext"); return this.context; }),
  };
  readonly findRequestKeyUse = vi.fn(async () => { this.calls.push("findRequestKeyUse"); return this.use; });
  readonly acknowledgeCategoryMoves = vi.fn(async (input: CategoryMovesAcknowledgeInput) => {
    this.calls.push("acknowledgeCategoryMoves");
    this.written.push(input);
    return this.answer(input);
  });
  /** W13 takes no catalog lock and writes nothing else (plan 10.4): any of these is a fault here. */
  readonly lockCatalog = vi.fn(async () => { throw new Error("W13 takes no catalog lock."); });
  readonly saveProduct = vi.fn(async () => { throw new Error("W13 writes no product row."); });
  readonly saveProductsBulk = vi.fn(async () => { throw new Error("W13 writes no product rows."); });
  readonly saveCategory = vi.fn(async () => { throw new Error("W13 writes no category row."); });
  readonly clearSizeLeftovers = vi.fn(async () => { throw new Error("W13 clears no leftover."); });
}

class FakeRepository implements ListingSettingWriteRepository {
  readonly executions: Array<{ memberId: string; storeConnectionId: number; idempotencyKey: string }> = [];
  tx = new FakeTransaction();
  async execute<T>(input: { memberId: string; storeConnectionId: number; idempotencyKey: string },
    operation: (tx: ListingSettingWriteTransaction) => Promise<T>): Promise<T> {
    this.executions.push(input);
    this.tx.calls.push("execute");
    return operation(this.tx as unknown as ListingSettingWriteTransaction);
  }
  async executeForSystem(): Promise<never> { throw new Error("W13 never runs as the system."); }
  async executeReview(): Promise<never> { throw new Error("W13 never runs a price check."); }
  async readPriceChangeReviewForMember(): Promise<never> { throw new Error("W13 never reads a price check's pages."); }
  async preflight(): Promise<never> { throw new Error("W13 never preflights: it asks eBay nothing."); }
}

let repository: FakeRepository;
let log: { info: Mock<(action: string, fields: Record<string, unknown>) => void> };
let clock: { now: Mock<() => Date> };
let timer: Mock<() => number>;
let service: DropshipListingCategoryMovesService;

async function refusal(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

beforeEach(() => {
  repository = new FakeRepository();
  log = { info: vi.fn() };
  clock = { now: vi.fn(() => NOW) };
  let tick = 100;
  timer = vi.fn(() => { const value = tick; tick += 37; return value; });
  service = new DropshipListingCategoryMovesService({ repository, clock, timer, log });
});

describe("DropshipListingCategoryMovesService.acknowledgeForMember (W13, plan PR 9, 10.4)", () => {
  it("runs the gate, the probe, then the writer, in one transaction, with items by product and one clock reading", async () => {
    // Deeply frozen: the object, its items array and each item, so an in-place change (a sort) throws.
    const items = Object.freeze([item(30, 5), item(7, null), item(12)].map((entry) => Object.freeze(entry)));
    const input = Object.freeze({ idempotencyKey: KEY, items });
    repository.tx.answer = () => ({ outcome: "acknowledged", acknowledgedProductIds: [7, 30], movedAgainProductIds: [12] });

    const result = await service.acknowledgeForMember(MEMBER, STORE, input);

    expect(result).toEqual({ outcome: "acknowledged", acknowledgedProductIds: [7, 30], movedAgainProductIds: [12] });
    expect(repository.executions).toEqual([{ memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: KEY }]);
    expect(repository.tx.calls).toEqual(["execute", "loadStoreContext", "findRequestKeyUse", "acknowledgeCategoryMoves"]);
    const sorted = [item(7, null), item(12), item(30, 5)];
    expect(repository.tx.written).toEqual([{ items: sorted, requestHash: HASH_OF(sorted), now: NOW }]);
    expect(repository.tx.acknowledgeCategoryMoves.mock.calls[0][0].now).toBe(NOW);
    expect(clock.now).toHaveBeenCalledOnce();
    expect(repository.tx.lockCatalog).not.toHaveBeenCalled();
    // The input is never changed (CLAUDE.md §4): the frozen body would have thrown, and the order is the one sent.
    expect(input.items.map((entry) => entry.productId)).toEqual([30, 7, 12]);
  });

  it("hashes the items in product order, so the order sent never makes another request", async () => {
    await service.acknowledgeForMember(MEMBER, STORE, body(item(12), item(7, null)));
    await service.acknowledgeForMember(MEMBER, STORE, body(item(7, null), item(12)));
    const hashes = repository.tx.written.map((written) => written.requestHash);
    expect(new Set(hashes)).toEqual(new Set([HASH_OF([item(7, null), item(12)])]));
    // The shown category is part of the request: another one is another request.
    await service.acknowledgeForMember(MEMBER, STORE, body(item(7, 4), item(12)));
    expect(repository.tx.written[2].requestHash).not.toBe(hashes[0]);
  });

  it("answers a replay from the probe with empty lists and calls no writer (plan P16)", async () => {
    repository.tx.use = ledgerOf(HASH_OF([item(7)]));

    const result = await service.acknowledgeForMember(MEMBER, STORE, body(item(7)));

    expect(result).toEqual({ outcome: "replayed", acknowledgedProductIds: [], movedAgainProductIds: [] });
    expect(repository.tx.calls).toEqual(["execute", "loadStoreContext", "findRequestKeyUse"]);
    expect(repository.tx.acknowledgeCategoryMoves).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_moves_acknowledged", expect.objectContaining({
      outcome: "replayed", item_count: 1, acknowledged_count: null, moved_again_count: null, changed_count: 0,
      acknowledged_product_ids: [], moved_again_product_ids: [], before: [], after: [],
    }));
  });

  it.each([
    ["another request's hash", ledgerOf("e".repeat(64)), ["ledger.requestHash"]],
    ["another store", ledgerOf(HASH_OF([item(7)]), { storeConnectionId: 24 }), ["ledger.storeConnectionId"]],
    ["another writer's ledger row (W6)", ledgerOf(HASH_OF([item(7)]), { operation: "product_settings_bulk" }), ["ledger.operation"]],
    ["a W8 size price under the key", { ...NOTHING, children: [{ kind: "size" as const, revisionId: 501, productVariantId: 101,
      storeConnectionId: STORE, requestHash: "f".repeat(64) }] }, ["size", "size.requestHash"]],
    ["a W5 product revision under the key", { ...NOTHING, productRevision: { revisionId: 31, productId: 7, storeConnectionId: STORE,
      requestHash: HASH_OF([item(7)]), requestId: null } }, ["productRevision"]],
  ])("refuses a key used for %s with the permanent 409 key conflict, writing nothing", async (_label, use, mismatched) => {
    repository.tx.use = use;

    const error = await refusal(service.acknowledgeForMember(MEMBER, STORE, body(item(7))));

    expect(error.code).toBe("DROPSHIP_IDEMPOTENCY_CONFLICT");
    expect(error.context).toMatchObject({ storeConnectionId: STORE, mismatched, retryable: false, classification: "permanent" });
    expect(repository.tx.acknowledgeCategoryMoves).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it.each([
    ["no store for this vendor", null, "DROPSHIP_STORE_CONNECTION_REQUIRED"],
    ["a paused vendor", { ...storeContext, vendorStatus: "paused" }, "DROPSHIP_LISTING_VENDOR_BLOCKED"],
    ["a lapsed .ops entitlement", { ...storeContext, entitlementStatus: "lapsed" }, "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED"],
    ["a disconnected store", { ...storeContext, storeStatus: "disconnected" }, "DROPSHIP_LISTING_STORE_BLOCKED"],
    ["a store that is not eBay", { ...storeContext, platform: "shopify" }, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY"],
  ])("refuses %s at the gate, before the probe and the writer", async (_label, context, code) => {
    repository.tx.context = context as DropshipListingStoreContext | null;
    repository.tx.use = ledgerOf(HASH_OF([item(7)]));

    const error = await refusal(service.acknowledgeForMember(MEMBER, STORE, body(item(7))));

    expect(error.code).toBe(code);
    expect(repository.tx.calls).toEqual(["execute", "loadStoreContext"]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("refuses a writer replay after the probe said new as a fatal broken contract (plan 10.4 step 4)", async () => {
    repository.tx.answer = () => ({ outcome: "replayed", acknowledgedProductIds: [], movedAgainProductIds: [] });

    const error = await refusal(service.acknowledgeForMember(MEMBER, STORE, body(item(7))));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context).toMatchObject({ storeConnectionId: STORE, classification: "fatal" });
    expect(log.info).not.toHaveBeenCalled();
  });

  it("refuses a writer answer naming a product the request did not send, inside the transaction", async () => {
    repository.tx.answer = () => ({ outcome: "acknowledged", acknowledgedProductIds: [7], movedAgainProductIds: [99] });

    const error = await refusal(service.acknowledgeForMember(MEMBER, STORE, body(item(7), item(8))));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context).toMatchObject({ storeConnectionId: STORE, productIds: [99], classification: "fatal" });
  });

  it("passes the writer's own refusal unchanged (its BULK_INVALID, the store lock's BUSY)", async () => {
    const busy = new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "Listing settings are being changed by another request. Try again.",
      { retryable: true, classification: "transient" });
    repository.tx.answer = () => { throw busy; };
    await expect(service.acknowledgeForMember(MEMBER, STORE, body(item(7)))).rejects.toBe(busy);
  });

  it("logs one INFO line after the commit with ids, counts and the monotonic elapsed time, at most 100 ids each", async () => {
    const items = Array.from({ length: 150 }, (_, index) => item(1_000 + index, index % 2 === 0 ? 3 : null));
    repository.tx.answer = (input) => ({ outcome: "acknowledged",
      acknowledgedProductIds: input.items.slice(0, 120).map((entry) => entry.productId),
      movedAgainProductIds: input.items.slice(120).map((entry) => entry.productId) });

    await service.acknowledgeForMember(MEMBER, STORE, body(...items));

    expect(log.info).toHaveBeenCalledOnce();
    const [action, fields] = log.info.mock.calls[0];
    expect(action).toBe("dropship.listing_settings.category_moves_acknowledged");
    expect(fields).toEqual({
      outcome: "acknowledged", vendor_id: VENDOR, store_connection_id: STORE, actor_id: MEMBER, request_key: KEY,
      // Unknown here: the marks before the change are in the writer's audit row for this request key.
      before: null,
      after: items.slice(0, 100).map((entry) => ({ product_id: entry.productId, category_id: entry.shownCategoryId })),
      changed_count: 120, size_count: 0, elapsed_ms: 37,
      item_count: 150, acknowledged_count: 120, moved_again_count: 30,
      acknowledged_product_ids: items.slice(0, 100).map((entry) => entry.productId),
      moved_again_product_ids: items.slice(120).map((entry) => entry.productId),
    });
    expect(timer).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["no member", "", 22, body(item(7)), "DROPSHIP_AUTH_REQUIRED"],
    ["a store id that is not a positive int4", MEMBER, Number.NaN, body(item(7)), "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT"],
    ["a 7-character key", MEMBER, STORE, { idempotencyKey: "abcdefg", items: [item(7)] }, "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT"],
    ["no item", MEMBER, STORE, body(), "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT"],
    ["a product twice", MEMBER, STORE, body(item(7), item(7, null)), "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT"],
    ["a shown category of 0", MEMBER, STORE, body(item(7, 0)), "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT"],
    ["an unknown key", MEMBER, STORE, { ...body(item(7)), storeConnectionId: STORE }, "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT"],
  ])("refuses %s before any transaction", async (_label, member, store, input, code) => {
    const error = await refusal(service.acknowledgeForMember(member, store, input));
    expect(error.code).toBe(code);
    expect(error.context).toMatchObject({ classification: "permanent" });
    expect(repository.executions).toEqual([]);
  });
});
