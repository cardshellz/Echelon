import { describe, it, expect, vi } from "vitest";
import { InventoryUseCases } from "../../application/inventory.use-cases";

/**
 * Spec D — reverseReceiptInventory (the inventory module's public reversal
 * API; writer-ratchet P2.1 makes this the ONLY receipt-reversal writer into
 * inventory.inventory_lots / inventory_levels / inventory_transactions).
 *
 * Covers:
 *   - lot decrement at original cost (mills round-trip, never re-costed)
 *   - location level decrement + ledger audit row
 *   - insufficient on-hand block (consumed/sold) + allowNegative override
 *   - no-lot legacy receipts still decrement the level + write the ledger row
 */

function makeHarness(opts: {
  lots?: Array<{ id: number; qty_on_hand: number; unit_cost_mills: number }>;
  level?: { id: number; variant_qty: number } | null;
}) {
  const lots = (opts.lots ?? [{ id: 9001, qty_on_hand: 360, unit_cost_mills: 375 }]).map((l) => ({ ...l }));
  const level = opts.level === undefined ? { id: 301, variant_qty: 360 } : opts.level;
  const state = {
    lots,
    levelQty: level ? level.variant_qty : null,
    ledgerRows: [] as any[],
  };

  const route = (query: any): { rows: any[] } => {
    let text = "";
    const params: any[] = [];
    for (const chunk of query?.queryChunks ?? []) {
      if (chunk && Array.isArray(chunk.value)) text += chunk.value.join("");
      else { text += "?"; params.push(chunk); }
    }
    const t = text.replace(/\s+/g, " ").trim();

    // Freeze check (drizzle select builder is mocked separately — see below).
    if (t.includes("FROM inventory.inventory_lots l") && t.includes("inventory_transactions t")) {
      return { rows: state.lots.map((l) => ({ id: l.id, qty_on_hand: l.qty_on_hand, unit_cost_mills: l.unit_cost_mills })) };
    }
    if (t.startsWith("UPDATE inventory.inventory_lots")) {
      const decrement = params[0];
      const lotId = params[params.length - 1];
      const lot = state.lots.find((l) => l.id === lotId);
      if (lot) lot.qty_on_hand -= decrement;
      return { rows: [{ qty_on_hand: lot?.qty_on_hand ?? 0 }] };
    }
    if (t.includes("FROM inventory.inventory_levels") && t.includes("FOR UPDATE")) {
      return { rows: level ? [{ id: level.id, variant_qty: state.levelQty }] : [] };
    }
    if (t.startsWith("UPDATE inventory.inventory_levels")) {
      if (state.levelQty !== null) state.levelQty -= params[0];
      return { rows: [] };
    }
    if (t.startsWith("INSERT INTO inventory.inventory_transactions")) {
      state.ledgerRows.push(params);
      return { rows: [{ id: 1 }] };
    }
    throw new Error(`Unrouted SQL in test harness: ${t.slice(0, 140)}`);
  };

  const mockStorage: any = {};
  const mockDb: any = {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ cycleCountFreezeId: null }]),
    })),
    transaction: async (fn: any) =>
      fn({
        select: vi.fn(() => ({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([{ cycleCountFreezeId: null }]),
        })),
        execute: vi.fn(async (q: any) => route(q)),
      }),
  };

  const uc = new InventoryUseCases(mockDb, mockStorage);
  return { uc, state };
}

const baseParams = {
  receivingLineId: 1001,
  receivingOrderId: 100,
  productVariantId: 11,
  warehouseLocationId: 7,
  qty: 360,
  reversalId: 42,
  reason: "Reversal #42 of receipt RCV-1: wrong UOM",
  userId: "user-1",
};

describe("reverseReceiptInventory", () => {
  it("decrements the lot at its original cost and writes the ledger row", async () => {
    const { uc, state } = makeHarness({});
    const result = await uc.reverseReceiptInventory(baseParams);

    expect(state.lots[0].qty_on_hand).toBe(0);
    expect(state.levelQty).toBe(0);
    expect(result.lotUnitCostMills).toBe(375);
    expect(state.ledgerRows).toHaveLength(1);
    const row = state.ledgerRows[0];
    // Params: variantId, locationId, -qty, qtyBefore, qtyAfter, ..., orderId,
    // lineId, notes, userId, unitCostCents (millsToCents(375) = 4).
    expect(row[0]).toBe(11);
    expect(row[1]).toBe(7);
    expect(row[2]).toBe(-360);
    expect(row[row.length - 1]).toBe(4);
  });

  it("blocks when the lot was already consumed/sold", async () => {
    const { uc, state } = makeHarness({
      lots: [{ id: 9001, qty_on_hand: 50, unit_cost_mills: 375 }],
      level: { id: 301, variant_qty: 50 },
    });
    await expect(uc.reverseReceiptInventory(baseParams)).rejects.toMatchObject({
      code: "REVERSAL_INSUFFICIENT_ON_HAND",
    });
    // Nothing mutated.
    expect(state.lots[0].qty_on_hand).toBe(50);
    expect(state.levelQty).toBe(50);
    expect(state.ledgerRows).toHaveLength(0);
  });

  it("allowNegative posts the decrement anyway", async () => {
    const { uc, state } = makeHarness({
      lots: [{ id: 9001, qty_on_hand: 50, unit_cost_mills: 375 }],
      level: { id: 301, variant_qty: 50 },
    });
    const result = await uc.reverseReceiptInventory({ ...baseParams, allowNegative: true });
    expect(result.lotUnitCostMills).toBe(375);
    expect(state.lots[0].qty_on_hand).toBe(-310);
    expect(state.levelQty).toBe(-310);
    expect(state.ledgerRows).toHaveLength(1);
  });

  it("handles legacy receipts with no lot (level decrement + ledger only)", async () => {
    const { uc, state } = makeHarness({ lots: [] });
    const result = await uc.reverseReceiptInventory(baseParams);
    expect(result.lotUnitCostMills).toBeNull();
    expect(state.levelQty).toBe(0);
    expect(state.ledgerRows).toHaveLength(1);
    // No cost snapshot → null unit_cost_cents on the ledger row.
    expect(state.ledgerRows[0][state.ledgerRows[0].length - 1]).toBeNull();
  });

  it("rejects non-positive qty", async () => {
    const { uc } = makeHarness({});
    await expect(uc.reverseReceiptInventory({ ...baseParams, qty: 0 })).rejects.toThrow();
    await expect(uc.reverseReceiptInventory({ ...baseParams, qty: -5 })).rejects.toThrow();
  });
});
