import { describe, expect, it, vi } from "vitest";

/**
 * Phase A / BUG-2: createLot must populate total_unit_cost_cents so the
 * valuation/reporting path (which reads COALESCE(total_unit_cost_cents, ...))
 * matches the cost the FIFO pick books from unit_cost_cents — instead of the
 * old behavior where total defaulted to 0 and every received lot valued at $0.
 * Also locks po_line_id traceability (BUG-4) and cost_source provenance (BUG-5).
 */
function buildDb(capture: { inserted: any }) {
  return {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ lotNumber: "LOT-20260607-000" }]),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((val: any) => {
        capture.inserted = val;
        return { returning: vi.fn().mockResolvedValue([{ id: 1, ...val }]) };
      }),
    })),
  } as any;
}

describe("InventoryLotService.createLot — cost-layer population", () => {
  it("writes total_unit_cost_cents = unitCostCents, plus po_line_id and cost_source for a PO receipt", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");
    const capture: { inserted: any } = { inserted: null };
    const svc = new InventoryLotService(buildDb(capture));

    await svc.createLot({
      productVariantId: 10,
      warehouseLocationId: 20,
      qty: 100,
      unitCostCents: 600, // blended: product 500 + packaging 100
      productCostCents: 500,
      packagingCostCents: 100,
      purchaseOrderId: 133,
      poLineId: 215,
    });

    const v = capture.inserted;
    expect(v).toBeTruthy();
    // The crux of BUG-2: total must NOT be 0; it equals what the pick books.
    expect(v.totalUnitCostCents).toBe(600);
    expect(v.poUnitCostCents).toBe(500);
    expect(v.packagingCostCents).toBe(100);
    expect(v.poLineId).toBe(215); // BUG-4: lot ↔ PO line traceability
    expect(v.costSource).toBe("po"); // BUG-5: provenance
    expect(v.qtyReceived).toBe(100);
  });

  it("defaults cost_source to 'manual' and po_line_id to null for a non-PO lot, but still sets total", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");
    const capture: { inserted: any } = { inserted: null };
    const svc = new InventoryLotService(buildDb(capture));

    await svc.createLot({
      productVariantId: 10,
      warehouseLocationId: 20,
      qty: 5,
      unitCostCents: 250,
    });

    const v = capture.inserted;
    expect(v.totalUnitCostCents).toBe(250);
    expect(v.costSource).toBe("manual");
    expect(v.poLineId).toBeNull();
  });

  it("stores mills as the cost source of truth; po is the remainder (no double-count)", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");
    const capture: { inserted: any } = { inserted: null };
    const svc = new InventoryLotService(buildDb(capture));

    // The receive path passes per-variant-unit mills directly (already scaled to case).
    await svc.createLot({
      productVariantId: 10,
      warehouseLocationId: 20,
      qty: 3,
      unitCostCents: 3933, // cents mirror — ignored when mills are present
      unitCostMills: 393333, // authoritative per-case total ($39.3333)
      packagingCostMills: 60000, // $6.00 packaging
      purchaseOrderId: 140,
      poLineId: 229,
    });

    const v = capture.inserted;
    // Mills stored verbatim; total = product + packaging + landed.
    expect(v.totalUnitCostMills).toBe(393333);
    expect(v.packagingCostMills).toBe(60000);
    expect(v.landedCostMills).toBe(0);
    // PO (product) = remainder, so the breakdown always reconciles to total.
    expect(v.poUnitCostMills).toBe(333333);
    // Cent mirrors derived half-up (display / GL).
    expect(v.totalUnitCostCents).toBe(3933);
    expect(v.poUnitCostCents).toBe(3333);
    expect(v.packagingCostCents).toBe(600);
  });
});
