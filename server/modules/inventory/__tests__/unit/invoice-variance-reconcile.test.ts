import { describe, expect, it, vi } from "vitest";

/**
 * COGS Phase 6: when an invoice price differs from the PO price,
 * reconcileInvoiceVariance must update the affected lots and cascade
 * the corrected cost to COGS rows.
 */
describe("COGSService.reconcileInvoiceVariance", () => {
  it("updates lots and cascades COGS when invoice cost differs", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { COGSService } = await import("../../cogs.service");

    let executeCallCount = 0;
    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(async () => {
        executeCallCount++;
        if (executeCallCount === 1) {
          // Find affected lots
          return {
            rows: [{
              id: 10, lot_number: "LOT-001", unit_cost_cents: 500,
              landed_cost_cents: 100, total_unit_cost_cents: 600,
            }],
          };
        }
        if (executeCallCount === 2) {
          // UPDATE inventory_lots
          return { rows: [] };
        }
        if (executeCallCount === 3) {
          // INSERT cost_adjustment_log
          return { rows: [] };
        }
        if (executeCallCount === 4) {
          // cascadeRecostForLot: SELECT affected COGS rows
          return {
            rows: [
              { id: 1, qty: 5, unit_cost_cents: 600 },
            ],
          };
        }
        if (executeCallCount === 5) {
          // cascadeRecostForLot: UPDATE order_item_costs
          return { rows: [] };
        }
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn: any) => fn(db)),
    } as any;

    const svc = new COGSService(db);
    const result = await svc.reconcileInvoiceVariance({
      purchaseOrderId: 100,
      productVariantId: 5,
      invoiceUnitCostCents: 550, // was 500 on PO
      invoiceNumber: "INV-001",
    });

    expect(result.lotsUpdated).toBe(1);
    expect(result.cogsRowsUpdated).toBe(1);
    // New total = 550 (invoice) + 100 (landed) = 650
    // Old total was 600, delta per unit = 50, qty = 5 → total delta = 250
    expect(result.totalCogsDeltaCents).toBe(250);
  });

  it("skips lots already at the right cost", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { COGSService } = await import("../../cogs.service");

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(async () => ({
        rows: [{
          id: 10, lot_number: "LOT-001", unit_cost_cents: 500,
          landed_cost_cents: 0, total_unit_cost_cents: 500,
        }],
      })),
      transaction: vi.fn(async (fn: any) => fn(db)),
    } as any;

    const svc = new COGSService(db);
    const result = await svc.reconcileInvoiceVariance({
      purchaseOrderId: 100,
      productVariantId: 5,
      invoiceUnitCostCents: 500, // same as PO
    });

    expect(result.lotsUpdated).toBe(0);
    expect(result.cogsRowsUpdated).toBe(0);
    // Only one execute call (the SELECT for affected lots)
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("returns zeros when no lots found for PO+variant", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { COGSService } = await import("../../cogs.service");

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(async (fn: any) => fn(db)),
    } as any;

    const svc = new COGSService(db);
    const result = await svc.reconcileInvoiceVariance({
      purchaseOrderId: 999,
      productVariantId: 5,
      invoiceUnitCostCents: 550,
    });

    expect(result).toEqual({ lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0 });
  });
});
