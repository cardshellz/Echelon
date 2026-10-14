import { beforeEach, describe, expect, it, vi } from "vitest";
import { readUnresolvedReceivingCustody } from "../../../procurement/receiving-custody-public";
import { assertReceivingCustodyCountable } from "../../application/receiving-custody-count-guard";
import { InventoryUseCases } from "../../application/inventory.use-cases";
import { PostgresCanonicalClaimInventoryRepository } from "../../infrastructure/canonical-claim-inventory.repository";

vi.mock("../../../procurement/receiving-custody-public", () => ({ readUnresolvedReceivingCustody: vi.fn() }));
vi.mock("../../infrastructure/operational-quantity-posting", async importOriginal => ({
  ...await importOriginal<typeof import("../../infrastructure/operational-quantity-posting")>(),
  openOperationalQuantityPosting: vi.fn(async () => null),
}));

const identity = { productVariantId: 101, warehouseLocationId: 2 };
const held = [{ custodyId: "4", receivingOrderId: 77, productId: 10 }];
const conflict = { code: "RECEIVING_CUSTODY_COUNT_CONFLICT" };
const occurredAt = new Date("2026-10-14T12:00:00Z");

beforeEach(() => { vi.clearAllMocks(); vi.mocked(readUnresolvedReceivingCustody).mockResolvedValue(held); });

describe("receiving custody count guard", () => {
  it("returns actionable receipt identity and does not reinterpret held quantity as stock", async () => {
    const tx = { query: vi.fn() };
    await expect(assertReceivingCustodyCountable(tx, identity)).rejects.toMatchObject({
      ...conflict, context: { ...identity, receivingOrderIds: [77], custodyIds: ["4"] },
    });
    expect(readUnresolvedReceivingCustody).toHaveBeenCalledWith({ execute: expect.any(Function) }, identity);
    expect(tx.query).not.toHaveBeenCalled();
  });

  it("allows a checked empty custody result", async () => {
    vi.mocked(readUnresolvedReceivingCustody).mockResolvedValue([]);
    await expect(assertReceivingCustodyCountable({ query: vi.fn() }, identity)).resolves.toBeUndefined();
  });

  it("fails closed on unavailable or invalid custody evidence", async () => {
    const unavailable = new Error("custody fence unavailable");
    vi.mocked(readUnresolvedReceivingCustody).mockRejectedValueOnce(unavailable);
    await expect(assertReceivingCustodyCountable({ query: vi.fn() }, identity)).rejects.toBe(unavailable);
    vi.mocked(readUnresolvedReceivingCustody).mockResolvedValueOnce([{ ...held[0], custodyId: "" }]);
    await expect(assertReceivingCustodyCountable({ query: vi.fn() }, identity)).rejects.toThrow();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])("rejects invalid identity %s before reading custody", async productVariantId => {
    await expect(assertReceivingCustodyCountable({ query: vi.fn() }, { ...identity, productVariantId })).rejects.toThrow();
    expect(readUnresolvedReceivingCustody).not.toHaveBeenCalled();
  });
});

describe("physical inventory boundaries", () => {
  function owner() {
    const execute = vi.fn(async () => ({ rows: [] }));
    const db = { execute, transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(db),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };
    const storage = { upsertInventoryLevel: vi.fn(async () => { throw new Error("ordinary quantity owner reached"); }),
      createInventoryTransaction: vi.fn() };
    return { service: new InventoryUseCases(db as never, storage as never), storage, execute };
  }

  it("blocks positive manual or picker adjustment before creating an available lot", async () => {
    const { service, storage } = owner();
    await expect(service.adjustInventory({ ...identity, qtyDelta: 2, reason: "counted ten, recorded eight" })).rejects.toMatchObject(conflict);
    expect(storage.upsertInventoryLevel).not.toHaveBeenCalled();
  });

  it("does not block an ordinary stock decrement", async () => {
    const { service } = owner();
    await expect(service.adjustInventory({ ...identity, qtyDelta: -2, reason: "remove known ordinary stock" })).rejects.toThrow("ordinary quantity owner reached");
    expect(readUnresolvedReceivingCustody).not.toHaveBeenCalled();
  });

  it("preserves the explicit source-cost transformation owner", async () => {
    const { service } = owner();
    await expect(service.adjustInventory({ ...identity, qtyDelta: 2, reason: "exact conversion", conversion: {
      sourceLots: [{ lotId: 1, qty: 1 }], productMills: BigInt(100), packagingMills: BigInt(0), landedMills: BigInt(0),
      provisional: false, operationKey: "conversion:1", occurredAt,
    } })).rejects.toThrow("ordinary quantity owner reached");
    expect(readUnresolvedReceivingCustody).not.toHaveBeenCalled();
  });

  it("blocks manual receiving without a reviewed receipt source", async () => {
    const { service, storage } = owner();
    await expect(service.receiveInventory({ ...identity, qty: 2, referenceId: "manual" })).rejects.toMatchObject(conflict);
    expect(storage.upsertInventoryLevel).not.toHaveBeenCalled();
  });

  it("does not approve an unchanged count while its location still contains held goods", async () => {
    const { service, storage } = owner();
    await expect(service.recordCycleCountReconciliationNoop({ ...identity, countedQty: 8, cycleCountId: 3,
      cycleCountItemId: 4, actor: "user:1", reason: "unchanged" })).rejects.toMatchObject(conflict);
    expect(storage.createInventoryTransaction).not.toHaveBeenCalled();
  });

  it.each(["adjustment", "noop"])("protects direct canonical count %s calls", async mode => {
    const client = { query: vi.fn() };
    const writer = new PostgresCanonicalClaimInventoryRepository();
    const input = { client, ...identity, inventoryLevelId: 11, quantityBefore: 8,
      countedQty: mode === "noop" ? 8 : 10, cycleCountId: 3, cycleCountItemId: 4,
      actor: "user:1", reason: "physical count", occurredAt };
    await expect(mode === "noop" ? writer.recordCycleCountNoop(input) : writer.applyCycleCountAdjustment(input)).rejects.toMatchObject(conflict);
    expect(client.query).not.toHaveBeenCalled();
  });
});
