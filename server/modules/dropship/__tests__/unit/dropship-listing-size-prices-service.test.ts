import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ZodError } from "zod";
import type { ListingPriceSetting } from "../../../../../shared/dropship/listing-price";
import type { DropshipListingStoreContext } from "../../application/dropship-listing-preview-service";
import type { ListingSettingWriteRepository, ListingSettingWriteTransaction } from "../../application/dropship-listing-setting-writes";
import { DropshipError } from "../../domain/errors";
import type { RequestKeyUse } from "../../domain/listing-setting-request-key-use";
import { listingSettingChildKey, listingSettingRequestHash } from "../../domain/listing-setting-values";

/** W9's flow is pinned by its own tests; here it is a recorded stub so each size's outcome can be chosen. */
const w9 = vi.hoisted(() => ({ saveListingPriceInTransaction: vi.fn() }));
vi.mock("../../application/dropship-listing-price-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../application/dropship-listing-price-service")>()),
  saveListingPriceInTransaction: w9.saveListingPriceInTransaction,
}));
import { DropshipListingSizePricesService } from "../../application/dropship-listing-size-prices-service";

const NOW = new Date("2026-10-12T09:00:00.000Z");
const MEMBER = "member-1";
const VENDOR = 10;
const STORE = 22;
const KEY = "size-prices:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const HASH_OF = (rows: unknown) => listingSettingRequestHash({ operation: "size_prices_v1", storeConnectionId: STORE, rows });
const NOTHING: RequestKeyUse = { productRevision: null, categoryRevision: null, ledger: null, children: [] };
const storeContext: DropshipListingStoreContext = {
  vendorId: VENDOR, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE, storeStatus: "connected",
  setupStatus: "ready", platform: "ebay", storeLaunchReady: true,
};
/** Size → product, as the catalog has them. */
const PRODUCT_OF = new Map([[101, 7], [102, 7], [103, 8], [104, 9]]);

type Outcome = { revisionId: number; idempotentReplay?: boolean } | DropshipError;

class FakeTransaction {
  readonly calls: string[] = [];
  readonly vendorId = VENDOR;
  readonly storeConnectionId = STORE;
  readonly requestKey = KEY;
  readonly actor = { actorType: "vendor" as const, actorId: MEMBER };
  context: DropshipListingStoreContext | null = storeContext;
  use: RequestKeyUse = NOTHING;
  locked: unknown = null;
  readonly catalog = {
    loadStoreContext: vi.fn(async () => { this.calls.push("loadStoreContext"); return this.context; }),
    listCatalogCandidates: vi.fn(async (ids: readonly number[]) => {
      this.calls.push("listCatalogCandidates");
      return ids.filter((id) => PRODUCT_OF.has(id)).map((id) => ({ productVariantId: id, productId: PRODUCT_OF.get(id)! }));
    }),
  };
  readonly findRequestKeyUse = vi.fn(async () => { this.calls.push("findRequestKeyUse"); return this.use; });
  readonly lockCatalog = vi.fn(async (input: unknown) => { this.calls.push("lockCatalog"); this.locked = input; });
  readonly sizePrice = vi.fn((productVariantId: number) => { this.calls.push(`sizePrice:${productVariantId}`); return { size: productVariantId }; });
}

class FakeRepository implements ListingSettingWriteRepository {
  readonly executions: Array<{ memberId: string; storeConnectionId: number; idempotencyKey: string }> = [];
  tx = new FakeTransaction();
  async execute<T>(input: { memberId: string; storeConnectionId: number; idempotencyKey: string },
    operation: (tx: ListingSettingWriteTransaction) => Promise<T>): Promise<T> {
    this.executions.push(input);
    return operation(this.tx as unknown as ListingSettingWriteTransaction);
  }
  async executeForSystem(): Promise<never> { throw new Error("W8 never runs as the system."); }
  async executeReview(): Promise<never> { throw new Error("W8 never runs a price check (W7's review)."); }
  async readPriceChangeReviewForMember(): Promise<never> { throw new Error("W8 never reads a price check's pages."); }
  async preflight(): Promise<never> { throw new Error("W8 never preflights: it asks eBay nothing."); }
}

let repository: FakeRepository;
let outcomes: Map<number, Outcome>;
let log: { info: Mock<(action: string, fields: Record<string, unknown>) => void> };
let clock: { now: Mock<() => Date> };
let timer: Mock<() => number>;
let service: DropshipListingSizePricesService;

const row = (productVariantId: number, priceCents = 1_499, expectedRevisionId: number | null = null) =>
  ({ productVariantId, priceCents, expectedRevisionId });
const body = (...rows: ReturnType<typeof row>[]) => ({ idempotencyKey: KEY, rows });

function priceSetting(productVariantId: number, revisionId: number): ListingPriceSetting {
  return { storeConnectionId: STORE, productVariantId, revisionId, overridePriceCents: 1_499, effectivePriceCents: 1_499,
    defaultPriceCents: null, source: "override", pricingMode: "fixed", updatedAt: NOW.toISOString() };
}
const versionConflict = (actualRevisionId: number | null) => new DropshipError("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT",
  "This listing price changed after you opened it.", { expectedRevisionId: null, actualRevisionId });
const outsideLimit = () => new DropshipError("DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", "That price is below the minimum.", {
  storeConnectionId: STORE, productVariantId: 0, beforePriceCents: null, afterPriceCents: 1, blockers: ["pricing:below_floor:policy_5"],
  pricingMode: "fixed", note: "never sent" });

async function refusal(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

beforeEach(() => {
  w9.saveListingPriceInTransaction.mockReset();
  repository = new FakeRepository();
  outcomes = new Map();
  w9.saveListingPriceInTransaction.mockImplementation(async (_tx: unknown, target: { productVariantId: number }) => {
    repository.tx.calls.push(`w9:${target.productVariantId}`);
    const outcome = outcomes.get(target.productVariantId) ?? { revisionId: target.productVariantId + 1_000 };
    if (outcome instanceof DropshipError) throw outcome;
    return { price: priceSetting(target.productVariantId, outcome.revisionId), idempotentReplay: outcome.idempotentReplay ?? false };
  });
  log = { info: vi.fn() };
  clock = { now: vi.fn(() => NOW) };
  let tick = 100;
  timer = vi.fn(() => { const value = tick; tick += 42; return value; });
  service = new DropshipListingSizePricesService({ repository, clock, timer, log });
});

describe("DropshipListingSizePricesService.saveForMember (W8, plan PR 9, section 4.3)", () => {
  it("saves every size through W9's flow in one transaction: gate, probe, candidates, lockCatalog, then sizes ascending", async () => {
    const input = Object.freeze(body(Object.freeze(row(103, 2_000, 7)), Object.freeze(row(101)), Object.freeze(row(102, 999, 5))));

    const result = await service.saveForMember(MEMBER, STORE, input);

    expect(result).toEqual({ outcome: "changed", sizes: [
      { productVariantId: 101, revisionId: 1_101, idempotentReplay: false },
      { productVariantId: 102, revisionId: 1_102, idempotentReplay: false },
      { productVariantId: 103, revisionId: 1_103, idempotentReplay: false },
    ] });
    expect(repository.executions).toEqual([{ memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: KEY }]);
    expect(repository.tx.calls).toEqual(["loadStoreContext", "findRequestKeyUse", "listCatalogCandidates", "lockCatalog",
      "sizePrice:101", "w9:101", "sizePrice:102", "w9:102", "sizePrice:103", "w9:103"]);
    expect(repository.tx.catalog.listCatalogCandidates).toHaveBeenCalledWith([101, 102, 103]);
    expect(repository.tx.locked).toEqual({ productIds: [7, 8], productVariantIds: [101, 102, 103] });
    // The input is never changed (CLAUDE.md §4); the frozen body would have thrown.
    expect(input.rows.map((value) => value.productVariantId)).toEqual([103, 101, 102]);
  });

  it("gives each size its own child key, the parent hash, a typed price and the one clock reading", async () => {
    await service.saveForMember(MEMBER, STORE, body(row(102, 999, 5), row(101)));

    const sorted = [row(101), row(102, 999, 5)];
    const calls = w9.saveListingPriceInTransaction.mock.calls;
    expect(calls).toHaveLength(2);
    for (const [index, size] of sorted.entries()) {
      const [tx, target, saveInput, requestHash, now] = calls[index];
      expect(tx).toEqual({ size: size.productVariantId });
      expect(target).toEqual({ storeConnectionId: STORE, productVariantId: size.productVariantId });
      expect(saveInput).toEqual({ priceCents: size.priceCents, pricingMode: "fixed", expectedRevisionId: size.expectedRevisionId,
        idempotencyKey: listingSettingChildKey(KEY, "size", size.productVariantId) });
      expect(requestHash).toBe(HASH_OF(sorted));
      expect(now).toBe(NOW);
    }
    expect(clock.now).toHaveBeenCalledOnce();
  });

  it("hashes the sizes in id order, so the order sent never makes another request", async () => {
    await service.saveForMember(MEMBER, STORE, body(row(102), row(101)));
    await service.saveForMember(MEMBER, STORE, body(row(101), row(102)));
    const hashes = w9.saveListingPriceInTransaction.mock.calls.map((call) => call[3]);
    expect(new Set(hashes)).toEqual(new Set([HASH_OF([row(101), row(102)])]));
  });

  it("logs one INFO line after the commit, with ids, counts and the monotonic elapsed time, and no text", async () => {
    await service.saveForMember(MEMBER, STORE, body(row(101, 1_499, 3), row(102)));

    expect(log.info).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.size_prices_saved", {
      outcome: "changed", vendor_id: VENDOR, store_connection_id: STORE, actor_id: MEMBER, request_key: KEY,
      before: [{ product_variant_id: 101, revision_id: 3 }, { product_variant_id: 102, revision_id: null }],
      after: [{ product_variant_id: 101, revision_id: 1_101 }, { product_variant_id: 102, revision_id: 1_102 }],
      changed_count: 2, size_count: 2, elapsed_ms: 42,
    });
    expect(timer).toHaveBeenCalledTimes(2);
  });

  it("gathers version conflicts first: two conflicts and a limit refusal answer 409 naming both conflicts", async () => {
    outcomes.set(101, versionConflict(9)).set(102, outsideLimit()).set(103, versionConflict(null));

    const error = await refusal(service.saveForMember(MEMBER, STORE, body(row(101, 1_499, 4), row(102), row(103), row(104))));

    expect(error.code).toBe("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT");
    expect(error.context).toEqual({ storeConnectionId: STORE, conflictCount: 2, retryable: false, classification: "permanent",
      conflicts: [{ productVariantId: 101, expectedRevisionId: 4, actualRevisionId: 9 },
        { productVariantId: 103, expectedRevisionId: null, actualRevisionId: null }] });
    expect(error.message).toBe("2 sizes' prices changed after you opened them. Reload before saving again.");
    // Every size was tried, so the vendor sees all of them at once; the throw rolls back size 104's save.
    expect(repository.tx.calls.filter((call) => call.startsWith("w9:"))).toEqual(["w9:101", "w9:102", "w9:103", "w9:104"]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("answers limit refusals alone with one 422 naming every refused size and its blockers, never W9's other context", async () => {
    outcomes.set(102, outsideLimit()).set(104, outsideLimit());

    const error = await refusal(service.saveForMember(MEMBER, STORE, body(row(101), row(102, 250), row(104, 300))));

    expect(error.code).toBe("DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT");
    expect(error.context).toEqual({ storeConnectionId: STORE, sizeCount: 2, retryable: false, classification: "permanent",
      sizes: [{ productVariantId: 102, priceCents: 250, blockers: ["pricing:below_floor:policy_5"] },
        { productVariantId: 104, priceCents: 300, blockers: ["pricing:below_floor:policy_5"] }] });
    expect(error.message).toBe("2 sizes' prices would be outside what Card Shellz allows. Enter prices Card Shellz allows.");
    expect(log.info).not.toHaveBeenCalled();
  });

  it("words a single refusal for one size", async () => {
    outcomes.set(101, versionConflict(2));
    expect((await refusal(service.saveForMember(MEMBER, STORE, body(row(101))))).message)
      .toBe("1 size's price changed after you opened it. Reload before saving again.");
  });

  it("lists at most 100 refused sizes, with the full count", async () => {
    const many = Array.from({ length: 150 }, (_, index) => row(2_000 + index));
    for (const size of many) outcomes.set(size.productVariantId, outsideLimit());
    const error = await refusal(service.saveForMember(MEMBER, STORE, body(...many)));
    expect(error.context).toMatchObject({ sizeCount: 150 });
    expect(error.context?.sizes).toHaveLength(100);
  });

  const stopOn102 = (failure: unknown) => {
    w9.saveListingPriceInTransaction.mockImplementation(async (_tx: unknown, target: { productVariantId: number }) => {
      repository.tx.calls.push(`w9:${target.productVariantId}`);
      if (target.productVariantId === 102) throw failure;
      return { price: priceSetting(target.productVariantId, target.productVariantId + 1_000), idempotentReplay: false };
    });
  };

  it.each([
    // W9 throws this one with no context (dropship-listing-price-service.ts); the answer names the size it stopped on.
    ["a size that is not available", new DropshipError("DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", "Listing price is not available for this item.")],
    ["a price that would be lost", new DropshipError("DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", "This size would be left with no price.")],
  ])("stops at once on %s, trying no later size, and names that size", async (_label, failure) => {
    stopOn102(failure);

    const error = await refusal(service.saveForMember(MEMBER, STORE, body(row(101), row(102), row(103))));

    expect(error).toMatchObject({ code: failure.code, message: failure.message,
      context: { storeConnectionId: STORE, productVariantId: 102, retryable: false, classification: "permanent" } });
    expect(repository.tx.calls.filter((call) => call.startsWith("w9:"))).toEqual(["w9:101", "w9:102"]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("keeps a size refusal that already names its size, and any other failure, exactly as thrown", async () => {
    const named = new DropshipError("DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", "This size would be left with no price.", {
      storeConnectionId: STORE, productVariantId: 102, beforePriceCents: 1_499, afterPriceCents: null });
    for (const failure of [named, new Error("connection lost"), new DropshipError("DROPSHIP_LISTING_PRICE_INVARIANT_FAILED", "Another size.")]) {
      stopOn102(failure);
      await expect(service.saveForMember(MEMBER, STORE, body(row(101), row(102), row(103)))).rejects.toBe(failure);
      expect(repository.tx.calls.filter((call) => call.startsWith("w9:")).slice(-2)).toEqual(["w9:101", "w9:102"]);
    }
    expect(log.info).not.toHaveBeenCalled();
  });

  it("answers a replay from the probe's size children, reading and writing nothing else (plan P16)", async () => {
    const sorted = [row(101), row(102)];
    repository.tx.use = { ...NOTHING, children: [
      { kind: "size", revisionId: 51, productVariantId: 101, storeConnectionId: STORE, requestHash: HASH_OF(sorted) },
      { kind: "size", revisionId: 52, productVariantId: 102, storeConnectionId: STORE, requestHash: HASH_OF(sorted) },
    ] };

    const result = await service.saveForMember(MEMBER, STORE, body(row(102), row(101)));

    expect(result).toEqual({ outcome: "replayed", sizes: [
      { productVariantId: 101, revisionId: 51, idempotentReplay: true },
      { productVariantId: 102, revisionId: 52, idempotentReplay: true },
    ] });
    expect(repository.tx.calls).toEqual(["loadStoreContext", "findRequestKeyUse"]);
    expect(w9.saveListingPriceInTransaction).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.size_prices_saved", expect.objectContaining({
      outcome: "replayed", changed_count: 0, size_count: 2, before: [],
      after: [{ product_variant_id: 101, revision_id: 51 }, { product_variant_id: 102, revision_id: 52 }] }));
  });

  it("refuses a key another request used, before any write: an overlapping size with another price", async () => {
    repository.tx.use = { ...NOTHING, children: [
      { kind: "size", revisionId: 51, productVariantId: 101, storeConnectionId: STORE, requestHash: HASH_OF([row(101, 999)]) },
    ] };

    const error = await refusal(service.saveForMember(MEMBER, STORE, body(row(101), row(102))));

    expect(error.code).toBe("DROPSHIP_IDEMPOTENCY_CONFLICT");
    expect(error.context).toMatchObject({ mismatched: ["size.requestHash"], classification: "permanent" });
    expect(repository.tx.calls).toEqual(["loadStoreContext", "findRequestKeyUse"]);
  });

  it("refuses a key another request used for a disjoint set of sizes (C-feas-6)", async () => {
    repository.tx.use = { ...NOTHING, children: [
      { kind: "size", revisionId: 61, productVariantId: 103, storeConnectionId: STORE, requestHash: HASH_OF([row(103)]) },
    ] };
    expect((await refusal(service.saveForMember(MEMBER, STORE, body(row(101), row(102))))).code).toBe("DROPSHIP_IDEMPOTENCY_CONFLICT");
    expect(w9.saveListingPriceInTransaction).not.toHaveBeenCalled();
  });

  it("refuses a key whose rows are another writer's, and a key whose sizes are only partly recorded", async () => {
    const hash = HASH_OF([row(101), row(102)]);
    repository.tx.use = { ...NOTHING, ledger: { requestId: 3, operation: "product_settings_bulk", storeConnectionId: STORE, requestHash: hash } };
    expect((await refusal(service.saveForMember(MEMBER, STORE, body(row(101), row(102))))).code).toBe("DROPSHIP_IDEMPOTENCY_CONFLICT");

    repository.tx.use = { ...NOTHING, children: [{ kind: "size", revisionId: 51, productVariantId: 101, storeConnectionId: STORE, requestHash: hash }] };
    const incomplete = await refusal(service.saveForMember(MEMBER, STORE, body(row(101), row(102))));
    expect(incomplete.code).toBe("DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE");
    expect(incomplete.context).toMatchObject({ classification: "fatal" });
    expect(w9.saveListingPriceInTransaction).not.toHaveBeenCalled();
  });

  it("refuses at the gate before the probe or any catalog read", async () => {
    repository.tx.context = { ...storeContext, storeStatus: "paused" };
    expect((await refusal(service.saveForMember(MEMBER, STORE, body(row(101))))).code).toBe("DROPSHIP_LISTING_STORE_BLOCKED");
    expect(repository.tx.calls).toEqual(["loadStoreContext"]);
  });

  it("refuses a size W9 answered as a replay inside a new request: nothing can replay under the store lock", async () => {
    outcomes.set(102, { revisionId: 77, idempotentReplay: true });
    const error = await refusal(service.saveForMember(MEMBER, STORE, body(row(101), row(102))));
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(log.info).not.toHaveBeenCalled();
  });

  it.each([
    ["201 sizes", MEMBER, STORE, body(...Array.from({ length: 201 }, (_, index) => row(index + 1)))],
    ["a short key", MEMBER, STORE, { idempotencyKey: "short", rows: [row(101)] }],
    ["a store id that is not a number", MEMBER, Number.NaN, body(row(101))],
    ["a zero price", MEMBER, STORE, body(row(101, 0))],
  ])("refuses %s before any transaction, as the vendor's input (400), never a bare ZodError", async (_label, member, store, input) => {
    const error = await refusal(service.saveForMember(member, store, input));
    expect(error).not.toBeInstanceOf(ZodError);
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT",
      context: { retryable: false, classification: "permanent", issues: [expect.objectContaining({ code: expect.any(String) })] } });
    expect(repository.executions).toEqual([]);
    expect(clock.now).not.toHaveBeenCalled();
  });

  it("refuses a blank member before parsing or any transaction", async () => {
    expect((await refusal(service.saveForMember(" ", STORE, body(row(101))))).code).toBe("DROPSHIP_AUTH_REQUIRED");
    expect(repository.executions).toEqual([]);
  });
});
