import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { InventoryLotService } from "../../lots.service";
import { COGSService } from "../../cogs.service";

function sqlText(query: any): string {
  return new PgDialect().sqlToQuery(query).sql.replace(/\s+/g," ").toLowerCase();
}
function valuationDb(empty = false) {
  return { execute: vi.fn(async (query: any) => {
    const text = sqlText(query);
    if (text.includes("from inventory.inventory_lots")) return { rows: empty ? [] : [
      { id: 1,product_variant_id: 1,qty_on_hand: 10,qty_received: 10,cost_precision_version: 1,
        unit_cost_mills: "70000",total_unit_cost_mills: "70000",po_unit_cost_mills: "50000",packaging_cost_mills: "0",landed_cost_mills: "20000",
        cost_provisional: 0,inbound_shipment_id: null },
      { id: 2,product_variant_id: 2,qty_on_hand: 5,qty_received: 5,cost_precision_version: 1,
        unit_cost_mills: "0",total_unit_cost_mills: "0",po_unit_cost_mills: "0",packaging_cost_mills: "0",landed_cost_mills: "0",
        cost_provisional: 1,inbound_shipment_id: 5 },
    ] };
    if (text.includes("from catalog.product_variants")) return { rows: [
      { variant_id: 1,product_id: 1,sku: "SKU-A",product_name: "Widget A",base_sku: "A" },
      { variant_id: 2,product_id: 2,sku: "SKU-B",product_name: "Widget B",base_sku: "B" },
    ] };
    throw new Error(`Unexpected valuation query: ${text}`);
  }) } as any;
}

describe("Inventory and COGS valuation projections of the same raw lot evidence", () => {
  it("uses all-in exact costs and preserves legacy response shapes", async () => {
    const db = valuationDb();
    const variants = await new InventoryLotService(db).getInventoryValuation();
    const products = await new COGSService(db).getInventoryValuation();
    expect(variants.total).toEqual({ qty: 15,valueCents: 7000,zeroCostQty: 5,provisionalQty: 5 });
    expect(variants.byVariant).toMatchObject([{ sku: "SKU-A",qty: 10,valueCents: 7000,avgCostCents: 700 },{ sku: "SKU-B",qty: 5,valueCents: 0 }]);
    expect(products).toMatchObject({ totalValueCents: 7000,totalQty: 15,zeroCostQty: 5,provisionalQty: 5,
      landedPendingLots: 1,landedPendingValueCents: 0 });
    expect(products.byProduct.reduce((sum,p)=>sum+p.totalValueCents,0)).toBe(variants.total.valueCents);
  });
  it("returns complete validated empty projections", async () => {
    const variants = await new InventoryLotService(valuationDb(true)).getInventoryValuation();
    const products = await new COGSService(valuationDb(true)).getInventoryValuation();
    expect(variants.total).toEqual({ qty: 0,valueCents: 0,zeroCostQty: 0,provisionalQty: 0 });
    expect(products).toMatchObject({ totalValueCents: 0,totalQty: 0,byProduct: [] });
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
