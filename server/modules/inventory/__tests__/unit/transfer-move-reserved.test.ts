import { describe, it, expect, vi, beforeEach } from "vitest";
import { InventoryUseCases } from "../../application/inventory.use-cases";

/**
 * Option A: transfers may move the spillover reserved allocation (and re-point
 * eligible pending order lines) with the stock, but only when the caller opts in
 * via moveReserved and no order line is mid-pick at the source bin.
 *
 * These tests drive the real transfer() use-case against mocked storage + a
 * mocked tx so we can assert the exact reserved/on-hand deltas and ledger rows.
 */

const FROM_LOC = { id: 6, code: "FLOOR-06", isActive: 1, warehouseId: 1, zone: "F" };
const TO_LOC = { id: 4, code: "FLOOR-04", isActive: 1, warehouseId: 1, zone: "F" };

function makeHarness(opts: {
  sourceLevel: { id: number; variantQty: number; reservedQty: number };
  conflictRows?: any[]; // rows returned by the mid-pick conflict probe
  repointRows?: any[]; // rows returned by the order_items re-point UPDATE
}) {
  const adjustCalls: Array<{ id: number; adj: any }> = [];
  const txns: any[] = [];

  // tx.select().from().where().limit() -> resolves to [location] in call order.
  const locationQueue = [[FROM_LOC], [TO_LOC]];
  const makeSelectChain = () => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(locationQueue.shift() ?? []),
    };
    return chain;
  };

  // tx.execute is used for (1) the mid-pick conflict probe, then (2) re-point.
  const executeQueue = [
    { rows: opts.conflictRows ?? [] },
    { rows: opts.repointRows ?? [] },
  ];
  const execute = vi.fn(() => Promise.resolve(executeQueue.shift() ?? { rows: [] }));

  const tx = { select: makeSelectChain, execute };

  const mockDb: any = {
    transaction: (fn: any) => fn(tx),
    select: makeSelectChain,
    execute,
  };

  const mockStorage: any = {
    lockInventoryLevel: vi.fn(() => Promise.resolve(opts.sourceLevel)),
    upsertInventoryLevel: vi.fn(() => Promise.resolve({ id: 99, variantQty: 0, reservedQty: 0 })),
    adjustInventoryLevel: vi.fn((id: number, adj: any) => {
      adjustCalls.push({ id, adj });
      return Promise.resolve({ id });
    }),
    createInventoryTransaction: vi.fn((t: any) => {
      txns.push(t);
      return Promise.resolve(t);
    }),
  };

  const useCases = new InventoryUseCases(mockDb, mockStorage);
  return { useCases, adjustCalls, txns, execute, mockStorage };
}

describe("transfer() — Option A move-reserved", () => {
  it("plain transfer within availability never touches reserved", async () => {
    const h = makeHarness({ sourceLevel: { id: 1, variantQty: 67, reservedQty: 3 } });
    // available = 64; move 50 <= 64 → no reserved movement
    const res = await h.useCases.transfer({
      productVariantId: 10,
      fromLocationId: 6,
      toLocationId: 4,
      qty: 50,
    });
    expect(res).toEqual({ reservedMoved: 0, orderItemsRepointed: 0 });
    // Both adjust calls move only variantQty, no reservedQty key.
    for (const c of h.adjustCalls) {
      expect(c.adj.reservedQty).toBeUndefined();
    }
    // Only the single 'transfer' ledger row.
    expect(h.txns.map((t) => t.transactionType)).toEqual(["transfer"]);
  });

  it("blocks with TRANSFER_BLOCKED_BY_RESERVATION when reserved is in the way and moveReserved is false", async () => {
    const h = makeHarness({ sourceLevel: { id: 1, variantQty: 64, reservedQty: 3 } });
    // available = 61; ask for 64 → spillover 3 reserved, not opted in
    await expect(
      h.useCases.transfer({ productVariantId: 10, fromLocationId: 6, toLocationId: 4, qty: 64 }),
    ).rejects.toMatchObject({
      code: "TRANSFER_BLOCKED_BY_RESERVATION",
      context: expect.objectContaining({ reservedAtSource: 3, availableAtSource: 61, needed: 64 }),
    });
    // Nothing mutated.
    expect(h.adjustCalls).toHaveLength(0);
    expect(h.txns).toHaveLength(0);
  });

  it("moves only the spillover reserved, on both sides, in single combined adjusts", async () => {
    const h = makeHarness({
      sourceLevel: { id: 1, variantQty: 64, reservedQty: 3 },
      repointRows: [{ id: 111 }, { id: 222 }],
    });
    // available = 61; ask for 64 with moveReserved → reservedToMove = 3
    const res = await h.useCases.transfer({
      productVariantId: 10,
      fromLocationId: 6,
      toLocationId: 4,
      qty: 64,
      moveReserved: true,
    });
    expect(res).toEqual({ reservedMoved: 3, orderItemsRepointed: 2 });

    // Source adjust: -64 on-hand AND -3 reserved together.
    expect(h.adjustCalls[0]).toEqual({ id: 1, adj: { variantQty: -64, reservedQty: -3 } });
    // Dest adjust: +64 on-hand AND +3 reserved together.
    expect(h.adjustCalls[1]).toEqual({ id: 99, adj: { variantQty: 64, reservedQty: 3 } });

    // Two ledger rows: the transfer and the reserve_move.
    const types = h.txns.map((t) => t.transactionType);
    expect(types).toContain("transfer");
    expect(types).toContain("reserve_move");
    const moveRow = h.txns.find((t) => t.transactionType === "reserve_move");
    expect(moveRow.variantQtyDelta).toBe(3);
    expect(moveRow.sourceState).toBe("reserved");
    expect(moveRow.targetState).toBe("reserved");
  });

  it("refuses with TRANSFER_BLOCKED_BY_ACTIVE_PICK when an order at the source is mid-pick", async () => {
    const h = makeHarness({
      sourceLevel: { id: 1, variantQty: 64, reservedQty: 3 },
      conflictRows: [{ id: 555 }], // a live picked/in-progress line at FLOOR-06
    });
    await expect(
      h.useCases.transfer({
        productVariantId: 10,
        fromLocationId: 6,
        toLocationId: 4,
        qty: 64,
        moveReserved: true,
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_BLOCKED_BY_ACTIVE_PICK" });
    // Conflict is checked before any mutation.
    expect(h.adjustCalls).toHaveLength(0);
    expect(h.txns).toHaveLength(0);
  });

  it("rejects non-positive qty and same-location transfers", async () => {
    const h = makeHarness({ sourceLevel: { id: 1, variantQty: 10, reservedQty: 0 } });
    await expect(
      h.useCases.transfer({ productVariantId: 10, fromLocationId: 6, toLocationId: 4, qty: 0 }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      h.useCases.transfer({ productVariantId: 10, fromLocationId: 6, toLocationId: 6, qty: 5 }),
    ).rejects.toThrow(/must differ/);
  });

  it("still rejects when on-hand itself is insufficient (before reserved logic)", async () => {
    const h = makeHarness({ sourceLevel: { id: 1, variantQty: 10, reservedQty: 0 } });
    await expect(
      h.useCases.transfer({
        productVariantId: 10,
        fromLocationId: 6,
        toLocationId: 4,
        qty: 20,
        moveReserved: true,
      }),
    ).rejects.toThrow(/Insufficient on-hand/);
  });
});
