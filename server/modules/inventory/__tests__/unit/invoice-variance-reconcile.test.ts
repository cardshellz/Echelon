import { describe, expect, it, vi } from "vitest";

/**
 * COGS Phase 6: when an invoice price differs from the PO price,
 * reconcileInvoiceVariance must update the affected lots and cascade
 * the corrected cost to COGS rows.
 */
describe("COGSService.reconcileInvoiceVariance", () => {
  it("preserves mill precision and cascades COGS in one transaction", async () => {
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
              product_mills: 50000, packaging_mills: 0,
              landed_mills: 10000, total_mills: 60000, units_per_variant: 1,
            }],
          };
        }
        if (executeCallCount === 2) {
          // revalueLotCostMills: SELECT lot FOR UPDATE
          return {
            rows: [{
              id: 10,
              lot_number: "LOT-001",
              product_variant_id: 5,
              product_mills: 50000,
              packaging_mills: 0,
              landed_mills: 10000,
              old_total_mills: 60000,
              sku: "TEST-SKU",
            }],
          };
        }
        if (executeCallCount === 3) {
          // revalueLotCostMills: UPDATE inventory_lots
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
        if (executeCallCount === 6) {
          // revalueLotCostMills: INSERT cost_adjustment_log
          return { rows: [] };
        }
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn: any) => fn(db)),
    } as any;

    const svc = new COGSService(db);
    const result = await svc.reconcileInvoiceVariance({
      purchaseOrderId: 100,
      purchaseOrderLineId: 200,
      invoiceUnitCostCents: 551,
      invoiceUnitCostMills: 55055,
      invoiceNumber: "INV-001",
    });

    expect(result.lotsUpdated).toBe(1);
    expect(result.cogsRowsUpdated).toBe(1);
    // Exact new total is 65,055 mills. Across five units the rounded line
    // delta is 3,253 cents - 3,000 cents = 253 cents.
    expect(result.totalCogsDeltaCents).toBe(253);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("scales per-piece invoice cost to the receiving variant unit", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { COGSService } = await import("../../cogs.service");

    let executeCallCount = 0;
    const db: any = {
      execute: vi.fn(async () => {
        executeCallCount++;
        if (executeCallCount === 1) {
          return { rows: [{
            id: 10,
            product_mills: 4000,
            packaging_mills: 0,
            landed_mills: 0,
            total_mills: 4000,
            units_per_variant: 50,
          }] };
        }
        if (executeCallCount === 2) {
          return { rows: [{
            id: 10,
            lot_number: "LOT-PACK",
            product_variant_id: 5,
            product_mills: 4000,
            packaging_mills: 0,
            landed_mills: 0,
            old_total_mills: 4000,
            sku: "PACK-50",
          }] };
        }
        if (executeCallCount === 4) {
          return { rows: [{ id: 1, qty: 2, unit_cost_cents: 40, old_unit_cost_mills: 4000 }] };
        }
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn: any) => fn(db)),
    };

    const result = await new COGSService(db).reconcileInvoiceVariance({
      purchaseOrderId: 100,
      purchaseOrderLineId: 200,
      invoiceUnitCostCents: 1,
      invoiceUnitCostMills: 100,
    });

    // 100 mills per piece * 50 pieces = 5,000 mills per sellable pack.
    // Two already-consumed packs move from 4,000 to 5,000 mills: +20 cents.
    expect(result).toMatchObject({ lotsUpdated: 1, cogsRowsUpdated: 1, totalCogsDeltaCents: 20 });
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
          landed_cost_cents: 0, total_unit_cost_cents: 500, units_per_variant: 1,
        }],
      })),
      transaction: vi.fn(async (fn: any) => fn(db)),
    } as any;

    const svc = new COGSService(db);
    const result = await svc.reconcileInvoiceVariance({
      purchaseOrderId: 100,
      purchaseOrderLineId: 200,
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
      purchaseOrderLineId: 200,
      invoiceUnitCostCents: 550,
    });

    expect(result).toEqual({ lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0 });
  });

  it("uses a caller-owned transaction without opening a nested transaction", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { COGSService } = await import("../../cogs.service");

    const client = {
      execute: vi.fn(async () => ({ rows: [] })),
    } as any;
    const db = {
      transaction: vi.fn(),
    } as any;

    const result = await new COGSService(db).reconcileInvoiceVariance({
      purchaseOrderId: 100,
      purchaseOrderLineId: 200,
      invoiceUnitCostMills: 55055,
    }, client);

    expect(result).toEqual({ lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0 });
    expect(client.execute).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("does not commit earlier lot writes when a later lot revaluation fails", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { COGSService } = await import("../../cogs.service");

    const committedMutations: string[] = [];
    let executeCallCount = 0;
    const db: any = {
      transaction: vi.fn(async (fn: any) => {
        const pendingMutations: string[] = [];
        const tx = {
          execute: vi.fn(async () => {
            executeCallCount++;
            if (executeCallCount === 1) {
              return {
                rows: [
                  { id: 10, product_mills: 50000, packaging_mills: 0, landed_mills: 0, total_mills: 50000, units_per_variant: 1 },
                  { id: 11, product_mills: 50000, packaging_mills: 0, landed_mills: 0, total_mills: 50000, units_per_variant: 1 },
                ],
              };
            }
            if (executeCallCount === 2) {
              return {
                rows: [{
                  id: 10,
                  lot_number: "LOT-001",
                  product_variant_id: 5,
                  product_mills: 50000,
                  packaging_mills: 0,
                  landed_mills: 0,
                  old_total_mills: 50000,
                  sku: "TEST-SKU",
                }],
              };
            }
            if (executeCallCount === 3 || executeCallCount === 5) {
              pendingMutations.push(`mutation-${executeCallCount}`);
              return { rows: [] };
            }
            if (executeCallCount === 4) return { rows: [] };
            throw new Error("second lot revaluation failed");
          }),
        };

        try {
          const result = await fn(tx);
          committedMutations.push(...pendingMutations);
          return result;
        } catch (error) {
          throw error;
        }
      }),
    };

    await expect(new COGSService(db).reconcileInvoiceVariance({
      purchaseOrderId: 100,
      purchaseOrderLineId: 200,
      invoiceUnitCostMills: 55055,
    })).rejects.toThrow("second lot revaluation failed");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(committedMutations).toEqual([]);
  });
});
