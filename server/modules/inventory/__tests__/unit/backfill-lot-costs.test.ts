import { describe, expect, it, vi } from "vitest";

/**
 * COGS Phase 7: backfill zero-cost lots from a manual SKU→cost upload.
 */
describe("COGSService.backfillLotCostsBySku", () => {
  it("stamps cost on zero-cost lots and cascades to COGS", async () => {
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
          // Resolve variant by SKU
          return { rows: [{ id: 5 }] };
        }
        if (executeCallCount === 2) {
          // Find zero-cost lots
          return {
            rows: [
              { id: 10, lot_number: "LOT-001", landed_cost_cents: 0 },
              { id: 11, lot_number: "LOT-002", landed_cost_cents: 50 },
            ],
          };
        }
        if (executeCallCount === 3) {
          // UPDATE lot 10
          return { rows: [] };
        }
        if (executeCallCount === 4) {
          // cascadeRecostForLot lot 10: SELECT
          return { rows: [{ id: 1, qty: 3, unit_cost_cents: 0 }] };
        }
        if (executeCallCount === 5) {
          // cascadeRecostForLot lot 10: UPDATE
          return { rows: [] };
        }
        if (executeCallCount === 6) {
          // UPDATE lot 11
          return { rows: [] };
        }
        if (executeCallCount === 7) {
          // cascadeRecostForLot lot 11: SELECT (no affected rows)
          return { rows: [] };
        }
        if (executeCallCount === 8) {
          // UPDATE variant catalog costs
          return { rows: [] };
        }
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn: any) => fn(db)),
    } as any;

    const svc = new COGSService(db);
    const result = await svc.backfillLotCostsBySku([
      { sku: "TEST-SKU", unitCostCents: 500 },
    ]);

    expect(result.processed).toBe(1);
    expect(result.lotsUpdated).toBe(2);
    expect(result.cogsRowsUpdated).toBe(1);
    expect(result.skipped).toHaveLength(0);
  });

  it("skips unknown SKUs and invalid entries", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { COGSService } = await import("../../cogs.service");

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(async () => ({ rows: [] })), // variant not found
      transaction: vi.fn(async (fn: any) => fn(db)),
    } as any;

    const svc = new COGSService(db);
    const result = await svc.backfillLotCostsBySku([
      { sku: "", unitCostCents: 500 },           // empty sku
      { sku: "GOOD-SKU", unitCostCents: 0 },     // zero cost
      { sku: "UNKNOWN", unitCostCents: 500 },     // not found
    ]);

    expect(result.processed).toBe(0);
    expect(result.lotsUpdated).toBe(0);
    expect(result.skipped).toEqual([
      { sku: "(empty)", reason: "invalid_entry" },
      { sku: "GOOD-SKU", reason: "invalid_entry" },
      { sku: "UNKNOWN", reason: "sku_not_found" },
    ]);
  });

  it("skips SKUs that have no zero-cost lots", async () => {
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
        if (executeCallCount === 1) return { rows: [{ id: 5 }] }; // variant found
        return { rows: [] }; // no zero-cost lots
      }),
      transaction: vi.fn(async (fn: any) => fn(db)),
    } as any;

    const svc = new COGSService(db);
    const result = await svc.backfillLotCostsBySku([
      { sku: "ALREADY-COSTED", unitCostCents: 500 },
    ]);

    expect(result.processed).toBe(1);
    expect(result.lotsUpdated).toBe(0);
    expect(result.skipped).toEqual([
      { sku: "ALREADY-COSTED", reason: "no_zero_cost_lots" },
    ]);
  });
});
