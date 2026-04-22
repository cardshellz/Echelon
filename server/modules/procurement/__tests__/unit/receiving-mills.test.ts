import { describe, it, expect, vi } from "vitest";
import {
  ReceivingService,
  __testing__,
} from "../../receiving.service";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for the mills (4-decimal per-unit cost) contract on
// procurement.receiving_lines (follow-up to migration 0562).
//
// Covers:
//   1. resolveReceivingLineCost priority:
//      - explicit mills on receiving line > explicit cents on receiving line
//        > PO line mills > PO line cents > undefined.
//   2. ReceivingService.close() stamps BOTH unit_cost and unit_cost_mills on
//      the receiving_line row after successful receive:
//      - When the receiving line already carries a cost (manual override),
//        mills is derived from cents exactly (centsToMills).
//      - When pulled from a PO line with 4-decimal mills, the stored cents
//        on the receiving_line matches millsToCents(po.unitCostMills) and
//        mills is preserved verbatim.
//      - When no source is available, neither column is overwritten.
//   3. Half-up rounding: 375 mills ($0.0375) → unit_cost = 4 cents,
//      unit_cost_mills = 375.
// ─────────────────────────────────────────────────────────────────────────────

const { resolveReceivingLineCost } = __testing__;

describe("resolveReceivingLineCost — priority", () => {
  it("uses explicit mills on the receiving line when present", async () => {
    const storage = { getPurchaseOrderLineById: vi.fn() };
    const out = await resolveReceivingLineCost(
      { unitCostMills: 375, unitCost: null, purchaseOrderLineId: 42 },
      storage as any,
    );
    // 375 mills → round_half_up(375/100) = 4 cents
    expect(out).toEqual({ cents: 4, mills: 375 });
    expect(storage.getPurchaseOrderLineById).not.toHaveBeenCalled();
  });

  it("falls back to explicit cents on the receiving line (derives mills exactly)", async () => {
    const storage = { getPurchaseOrderLineById: vi.fn() };
    const out = await resolveReceivingLineCost(
      { unitCost: 1299, purchaseOrderLineId: 42 },
      storage as any,
    );
    // 1299 cents → 129900 mills (no rounding; 1 cent = 100 mills)
    expect(out).toEqual({ cents: 1299, mills: 129900 });
    expect(storage.getPurchaseOrderLineById).not.toHaveBeenCalled();
  });

  it("pulls mills from the linked PO line when receiving line has no cost", async () => {
    const storage = {
      getPurchaseOrderLineById: vi
        .fn()
        .mockResolvedValue({ unitCostMills: 375, unitCostCents: 5 }),
    };
    const out = await resolveReceivingLineCost(
      { purchaseOrderLineId: 42 },
      storage as any,
    );
    // PO mills is authoritative — cents is re-derived (5 in storage would
    // be wrong; we return millsToCents(375) = 4).
    expect(out).toEqual({ cents: 4, mills: 375 });
    expect(storage.getPurchaseOrderLineById).toHaveBeenCalledWith(42);
  });

  it("falls back to PO line cents when PO line has no mills", async () => {
    const storage = {
      getPurchaseOrderLineById: vi
        .fn()
        .mockResolvedValue({ unitCostMills: null, unitCostCents: 750 }),
    };
    const out = await resolveReceivingLineCost(
      { purchaseOrderLineId: 99 },
      storage as any,
    );
    expect(out).toEqual({ cents: 750, mills: 75000 });
  });

  it("returns undefined/undefined when no source is available", async () => {
    const storage = { getPurchaseOrderLineById: vi.fn().mockResolvedValue(null) };
    const out = await resolveReceivingLineCost(
      { purchaseOrderLineId: 99 },
      storage as any,
    );
    expect(out).toEqual({ cents: undefined, mills: undefined });
  });

  it("swallows storage errors and returns undefined/undefined", async () => {
    const storage = {
      getPurchaseOrderLineById: vi
        .fn()
        .mockRejectedValue(new Error("DB is on fire")),
    };
    const out = await resolveReceivingLineCost(
      { purchaseOrderLineId: 99 },
      storage as any,
    );
    expect(out).toEqual({ cents: undefined, mills: undefined });
  });

  it("rejects negative mills defensively (falls through, does not apply)", async () => {
    const storage = { getPurchaseOrderLineById: vi.fn() };
    const out = await resolveReceivingLineCost(
      // Negative mills should be ignored (our path never writes negatives).
      // Cents field takes over.
      { unitCostMills: -5 as any, unitCost: 123 },
      storage as any,
    );
    expect(out).toEqual({ cents: 123, mills: 12300 });
  });
});

// ─── ReceivingService.close — stamps mills on receiving_line ─────────

interface LineFixture {
  id: number;
  receivedQty: number;
  productVariantId: number;
  putawayLocationId: number;
  purchaseOrderLineId?: number;
  unitCost?: number | null;
  unitCostMills?: number | null;
}

function buildService(
  lines: LineFixture[],
  poLines: Record<number, { unitCostMills?: number | null; unitCostCents?: number | null }> = {},
  opts: { shipmentLandedCost?: number | null } = {},
) {
  const updateReceivingLineCalls: Array<{ id: number; updates: any }> = [];
  const receiveInventoryCalls: Array<any> = [];

  const storage = {
    getReceivingOrderById: vi
      .fn()
      .mockResolvedValue({ id: 1, status: "open", vendorId: null, purchaseOrderId: 123 }),
    getReceivingLines: vi.fn().mockResolvedValue(lines),
    updateReceivingOrder: vi.fn().mockResolvedValue({}),
    updateReceivingLine: vi.fn((id: number, updates: any) => {
      updateReceivingLineCalls.push({ id, updates });
      return Promise.resolve({});
    }),
    getProductVariantBySku: vi.fn(),
    getProductVariantById: vi.fn().mockResolvedValue({ id: 11, hierarchyLevel: 1, unitsPerVariant: 1, productId: 1 }),
    getProductVariantsByProductId: vi.fn().mockResolvedValue([]),
    getPurchaseOrderLineById: vi.fn((id: number) =>
      Promise.resolve(poLines[id] ? { id, ...poLines[id] } : null),
    ),
  } as any;

  const db = {
    transaction: vi.fn(async (fn: any) => fn({ execute: vi.fn() })),
    execute: vi.fn(),
  } as any;

  const inventoryCore = {
    receiveInventory: vi.fn((params: any) => {
      receiveInventoryCalls.push(params);
      return Promise.resolve();
    }),
  } as any;

  const channelSync = {
    queueSyncAfterInventoryChange: vi.fn().mockResolvedValue(undefined),
  } as any;

  const shipmentTracking =
    opts.shipmentLandedCost !== undefined
      ? {
          getLandedCostForPoLine: vi.fn().mockResolvedValue(opts.shipmentLandedCost),
        }
      : null;

  const svc = new ReceivingService(db, inventoryCore, channelSync, storage, null, shipmentTracking as any);
  return { svc, updateReceivingLineCalls, receiveInventoryCalls, storage };
}

describe("ReceivingService.close — stamps unit_cost + unit_cost_mills", () => {
  it("stamps mills from linked PO line (375 mills → 4 cents, 375 mills)", async () => {
    const { svc, updateReceivingLineCalls, receiveInventoryCalls } = buildService(
      [
        {
          id: 501,
          receivedQty: 100,
          productVariantId: 11,
          putawayLocationId: 22,
          purchaseOrderLineId: 42,
          // No cost on the receiving line — pull from PO.
        },
      ],
      { 42: { unitCostMills: 375 } },
    );

    await svc.close(1, "u1");

    // inventoryCore saw the cents mirror (millsToCents(375) = 4).
    expect(receiveInventoryCalls[0].unitCostCents).toBe(4);

    // The receiving_line row was updated with BOTH mirrors.
    const putaway = updateReceivingLineCalls.find((c) => c.id === 501 && c.updates.putawayComplete === 1);
    expect(putaway).toBeTruthy();
    expect(putaway!.updates.unitCost).toBe(4);
    expect(putaway!.updates.unitCostMills).toBe(375);
  });

  it("manual override on receiving line round-trips (mills authoritative)", async () => {
    const { svc, updateReceivingLineCalls } = buildService(
      [
        {
          id: 502,
          receivedQty: 50,
          productVariantId: 11,
          putawayLocationId: 22,
          purchaseOrderLineId: 42, // linked, but receiving-line override wins
          unitCostMills: 12345, // $1.2345 — a damaged-unit markdown, say
        },
      ],
      { 42: { unitCostMills: 20000 } }, // PO says $2.0000 — ignored
    );

    await svc.close(1, "u1");

    const putaway = updateReceivingLineCalls.find((c) => c.id === 502 && c.updates.putawayComplete === 1);
    expect(putaway).toBeTruthy();
    // millsToCents(12345) = round_half_up(12345/100) = 123
    expect(putaway!.updates.unitCost).toBe(123);
    expect(putaway!.updates.unitCostMills).toBe(12345);
  });

  it("cents-only manual override derives mills exactly (no rounding loss)", async () => {
    const { svc, updateReceivingLineCalls } = buildService([
      {
        id: 503,
        receivedQty: 10,
        productVariantId: 11,
        putawayLocationId: 22,
        unitCost: 1299, // legacy caller / CSV pre-0562
      },
    ]);

    await svc.close(1, "u1");

    const putaway = updateReceivingLineCalls.find((c) => c.id === 503 && c.updates.putawayComplete === 1);
    expect(putaway).toBeTruthy();
    expect(putaway!.updates.unitCost).toBe(1299);
    // 1299 cents × 100 = 129900 mills (exact, no rounding).
    expect(putaway!.updates.unitCostMills).toBe(129900);
  });

  it("leaves unit_cost/unit_cost_mills untouched when no cost source exists", async () => {
    const { svc, updateReceivingLineCalls } = buildService([
      {
        id: 504,
        receivedQty: 5,
        productVariantId: 11,
        putawayLocationId: 22,
        // No cost anywhere.
      },
    ]);

    await svc.close(1, "u1");

    const putaway = updateReceivingLineCalls.find((c) => c.id === 504 && c.updates.putawayComplete === 1);
    expect(putaway).toBeTruthy();
    // Only the status fields were written; cost fields are absent so we
    // don't clobber an already-null column.
    expect(putaway!.updates).toEqual({ putawayComplete: 1, status: "complete" });
    expect("unitCost" in putaway!.updates).toBe(false);
    expect("unitCostMills" in putaway!.updates).toBe(false);
  });

  it("landed cost override still mirrors mills from cents (no precision loss at cents level)", async () => {
    const { svc, updateReceivingLineCalls, receiveInventoryCalls } = buildService(
      [
        {
          id: 505,
          receivedQty: 3,
          productVariantId: 11,
          putawayLocationId: 22,
          purchaseOrderLineId: 42,
        },
      ],
      { 42: { unitCostMills: 10000 } }, // $1.0000 on PO
      { shipmentLandedCost: 250 }, // landed $2.50 after freight allocation
    );

    await svc.close(1, "u1");

    // inventoryCore sees landed cost (250c).
    expect(receiveInventoryCalls[0].unitCostCents).toBe(250);
    const putaway = updateReceivingLineCalls.find((c) => c.id === 505 && c.updates.putawayComplete === 1);
    expect(putaway!.updates.unitCost).toBe(250);
    expect(putaway!.updates.unitCostMills).toBe(25000); // centsToMills(250)
  });

  it("regression: service still writes canonical half-up rounding for 350 mills", async () => {
    // 350 mills = $0.0350 — exactly 3.5 cents, half-up → 4 cents.
    const { svc, updateReceivingLineCalls } = buildService(
      [
        {
          id: 506,
          receivedQty: 1,
          productVariantId: 11,
          putawayLocationId: 22,
          purchaseOrderLineId: 42,
        },
      ],
      { 42: { unitCostMills: 350 } },
    );

    await svc.close(1, "u1");
    const putaway = updateReceivingLineCalls.find((c) => c.id === 506 && c.updates.putawayComplete === 1);
    expect(putaway!.updates.unitCost).toBe(4);
    expect(putaway!.updates.unitCostMills).toBe(350);
  });
});
