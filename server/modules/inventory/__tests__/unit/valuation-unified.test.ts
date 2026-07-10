import { describe, expect, it, vi } from "vitest";

function sqlText(query: any): string {
  if (!query) return "";
  if (typeof query === "string") return query.toLowerCase();
  if (Array.isArray(query)) return query.map(sqlText).join(" ");
  if (typeof query.sql === "string") return query.sql.toLowerCase();
  if (Array.isArray(query.value)) return query.value.map(sqlText).join(" ");
  if (Array.isArray(query.queryChunks)) return query.queryChunks.map(sqlText).join(" ");
  return String(query).toLowerCase();
}

/**
 * COGS Phase 8: unified valuation uses total_unit_cost_cents (PO + landed)
 * instead of unit_cost_cents alone, and reports zero-cost / provisional flags.
 */
describe("InventoryLotService.getInventoryValuation (unified)", () => {
  it("values lots using totalUnitCostCents (includes landed)", async () => {
    const { InventoryLotService } = await import("../../lots.service");

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([
                {
                  productVariantId: 1,
                  sku: "SKU-A",
                  qty: 10,
                  // totalCost should use COALESCE(total_unit_cost_cents, unit_cost_cents)
                  // If total_unit_cost = 700 (500 PO + 200 landed), qty=10 → value = 7000
                  totalCost: 7000,
                  zeroCostQty: 0,
                  provisionalQty: 0,
                },
                {
                  productVariantId: 2,
                  sku: "SKU-B",
                  qty: 5,
                  totalCost: 0,
                  zeroCostQty: 5,
                  provisionalQty: 5,
                },
              ]),
            }),
          }),
        }),
      }),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
    } as any;

    const svc = new InventoryLotService(db);
    const result = await svc.getInventoryValuation();

    expect(result.total.qty).toBe(15);
    expect(result.total.valueCents).toBe(7000);
    expect(result.total.zeroCostQty).toBe(5);
    expect(result.total.provisionalQty).toBe(5);

    expect(result.byVariant).toHaveLength(2);
    expect(result.byVariant[0]).toMatchObject({
      sku: "SKU-A",
      qty: 10,
      valueCents: 7000,
      avgCostCents: 700,
      zeroCostQty: 0,
    });
    expect(result.byVariant[1]).toMatchObject({
      sku: "SKU-B",
      qty: 5,
      valueCents: 0,
      zeroCostQty: 5,
      provisionalQty: 5,
    });
  });

  it("returns zeros on empty inventory", async () => {
    const { InventoryLotService } = await import("../../lots.service");

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
    } as any;

    const svc = new InventoryLotService(db);
    const result = await svc.getInventoryValuation();

    expect(result.total).toEqual({ qty: 0, valueCents: 0, zeroCostQty: 0, provisionalQty: 0 });
    expect(result.byVariant).toHaveLength(0);
  });
});

describe("COGSService.getInventoryValuation (product-level)", () => {
  it("includes zeroCostQty and provisionalQty in result", async () => {
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
          // Main product valuation query
          return {
            rows: [
              {
                product_id: 1,
                product_name: "Widget",
                base_sku: "WDG",
                total_qty: "20",
                avg_cost_per_piece_mills: "35000",
                total_value_mills: "700000",
                active_lots: "4",
                zero_cost_qty: "3",
                has_landed_pending: false,
              },
            ],
          };
        }
        if (executeCallCount === 2) {
          // Pending/provisional summary
          return {
            rows: [{
              landed_pending_count: "1",
              landed_pending_value_mills: "50000",
              provisional_qty: "8",
            }],
          };
        }
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn: any) => fn(db)),
    } as any;

    const svc = new COGSService(db);
    const result = await svc.getInventoryValuation();

    expect(result.totalValueCents).toBe(7000);
    expect(result.totalQty).toBe(20);
    expect(result.zeroCostQty).toBe(3);
    expect(result.provisionalQty).toBe(8);
    expect(result.landedPendingLots).toBe(1);
    expect(result.landedPendingValueCents).toBe(500);

    expect(result.byProduct[0]).toMatchObject({
      productId: 1,
      productName: "Widget",
      baseSku: "WDG",
      zeroCostQty: 3,
    });

    const executedSql = db.execute.mock.calls.map(([query]: any[]) => sqlText(query)).join("\n");
    expect(executedSql).toContain("il.cost_provisional = 1 and il.inbound_shipment_id is not null");
    expect(executedSql).not.toContain("coalesce(il.landed_cost_cents, 0) = 0");
  });

  it("filters landed pending lots by provisional shipment-linked lots", async () => {
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
    await svc.getAllCostLots({ onlyPending: true });

    const executedSql = db.execute.mock.calls.map(([query]: any[]) => sqlText(query)).join("\n");
    expect(executedSql).toContain("il.cost_provisional = 1 and il.inbound_shipment_id is not null");
    expect(executedSql).not.toContain("coalesce(il.landed_cost_cents, 0) = 0");
  });
});
