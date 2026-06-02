import { describe, expect, it, vi } from "vitest";

/**
 * COGS Phase 5: when a lot's cost changes (landed cost finalization),
 * cascadeRecostForLot must update all order_item_costs rows referencing
 * that lot so shipped order COGS reflect the true landed cost.
 */
describe("COGSService.cascadeRecostForLot", () => {
  it("updates COGS rows when lot cost changes", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { COGSService } = await import("../../cogs.service");

    const executeResults: any[] = [];
    let executeCallCount = 0;
    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(async (query: any) => {
        executeCallCount++;
        if (executeCallCount === 1) {
          // SELECT affected rows
          return {
            rows: [
              { id: 1, qty: 3, unit_cost_cents: 500 },
              { id: 2, qty: 2, unit_cost_cents: 500 },
            ],
          };
        }
        // UPDATE bulk recost
        executeResults.push("updated");
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn: any) => fn(db)),
    } as any;

    const svc = new COGSService(db);
    const result = await svc.cascadeRecostForLot(10, 800); // lot 10, new cost $8.00

    // 5 units total, delta = (800 - 500) * 3 + (800 - 500) * 2 = 900 + 600 = 1500
    expect(result.rowsUpdated).toBe(2);
    expect(result.totalDeltaCents).toBe(1500);
    // The UPDATE query was executed
    expect(executeResults).toHaveLength(1);
  });

  it("returns zero when no COGS rows need updating", async () => {
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
    const result = await svc.cascadeRecostForLot(10, 500);

    expect(result.rowsUpdated).toBe(0);
    expect(result.totalDeltaCents).toBe(0);
    // Only the SELECT query, no UPDATE
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("updateLotLandedCost triggers cascade after cost update", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { COGSService } = await import("../../cogs.service");

    const executeCalls: string[] = [];
    let executeCallCount = 0;
    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(async () => {
        executeCallCount++;
        if (executeCallCount === 1) {
          // getLot: return a lot with old cost
          return {
            rows: [{
              id: 10, lot_number: "LOT-001", product_variant_id: 5,
              po_unit_cost_cents: 300, landed_cost_cents: 0,
              total_unit_cost_cents: 300, sku: "TEST-SKU",
            }],
          };
        }
        if (executeCallCount === 2) {
          // UPDATE inventory_lots
          executeCalls.push("update_lot");
          return { rows: [] };
        }
        if (executeCallCount === 3) {
          // cascadeRecostForLot SELECT
          executeCalls.push("cascade_select");
          return {
            rows: [{ id: 1, qty: 5, unit_cost_cents: 300 }],
          };
        }
        if (executeCallCount === 4) {
          // cascadeRecostForLot UPDATE
          executeCalls.push("cascade_update");
          return { rows: [] };
        }
        // cost_adjustment_log INSERT
        executeCalls.push("log_insert");
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn: any) => fn(db)),
    } as any;

    const svc = new COGSService(db);
    const result = await svc.updateLotLandedCost(10, 200);

    // Cost = po(300) + landed(200) = 500
    expect(result?.newCostCents).toBe(500);
    // Cascade should have been called
    expect(executeCalls).toContain("cascade_select");
    expect(executeCalls).toContain("cascade_update");
  });
});
