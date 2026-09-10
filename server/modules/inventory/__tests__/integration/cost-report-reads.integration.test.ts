import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { COGSService } from "../../cogs.service";
import { fixtureTable } from "../../../procurement/__tests__/integration/shipment-line-fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const suite = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;

suite.sequential("COGS read queries against the canonical PostgreSQL schema", () => {
  let pool: pg.Pool;
  let service: COGSService;
  const ownedSchemas: string[] = [];

  beforeAll(async () => {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url!).hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url!)) {
      throw new Error("Cost read tests require a separate explicitly disposable local PostgreSQL database.");
    }
    pool = new pg.Pool({ connectionString: url, ssl: false, max: 2, statement_timeout: 15_000 });
    // CREATE without IF NOT EXISTS prevents adopting or deleting existing data.
    for (const name of ["catalog", "inventory", "procurement", "warehouse"]) {
      await pool.query(`CREATE SCHEMA ${name}`);
      ownedSchemas.push(name);
    }
    for (const table of [schema.products, schema.productVariants, schema.inventoryLots,
      schema.purchaseOrders, schema.inboundShipments, schema.warehouseLocations]) {
      await pool.query(fixtureTable(table));
    }
    service = new COGSService(drizzle(pool, { schema }));
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE inventory.inventory_lots, catalog.product_variants, catalog.products RESTART IDENTITY");
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const name of ownedSchemas.reverse()) await pool.query(`DROP SCHEMA ${name} CASCADE`);
    } finally {
      await pool.end();
    }
  });

  async function seed() {
    await pool.query(`INSERT INTO catalog.products (id, sku, name) VALUES (1, 'BASE-A', 'Test product'), (2, NULL, 'No family SKU');
      INSERT INTO catalog.product_variants (id, product_id, sku, name, units_per_variant)
        VALUES (11, 1, 'PACK-A', '100-piece pack', 100), (12, 2, 'PIECE-B', 'Piece', 1);
      INSERT INTO inventory.inventory_lots (id, lot_number, product_variant_id, warehouse_location_id, qty_on_hand, qty_received,
        received_at, po_unit_cost_mills, landed_cost_mills, total_unit_cost_mills, unit_cost_mills, cost_provisional, inbound_shipment_id)
        VALUES (21, 'LOT-A', 11, 1, 100, 100, '2026-09-01T12:00:00Z', 350, 25, 375, 375, 1, 9),
          (22, 'LOT-ZERO', 12, 1, 3, 3, '2026-09-02T12:00:00Z', 0, 0, 0, 0, 0, NULL),
          (23, 'LOT-EMPTY', 11, 1, 0, 10, '2026-09-03T12:00:00Z', 350, 25, 375, 375, 0, NULL);
      INSERT INTO inventory.inventory_lots (id, lot_number, product_variant_id, warehouse_location_id, qty_on_hand, received_at, status)
        VALUES (24, 'LOT-INACTIVE', 11, 1, 8, '2026-09-03T12:00:00Z', 'depleted');`);
  }

  it("returns an explicit successful-empty response from both read queries", async () => {
    await expect(service.getInventoryValuation()).resolves.toEqual({
      totalValueCents: 0, totalQty: 0, zeroCostQty: 0, provisionalQty: 0,
      landedPendingLots: 0, landedPendingValueCents: 0, byProduct: [],
    });
    await expect(service.getAllCostLots()).resolves.toEqual({ lots: [], total: 0 });
  });

  it("reads the real products.sku column and keeps existing valuation quantities and amounts", async () => {
    await seed();
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='catalog' AND table_name='products'");
    expect(columns.rows.map((row) => row.column_name)).toContain("sku");
    expect(columns.rows.map((row) => row.column_name)).not.toContain("base_sku");
    const report = await service.getInventoryValuation();
    expect(report).toMatchObject({ totalValueCents: 375, totalQty: 103, zeroCostQty: 3, provisionalQty: 100, landedPendingLots: 1, landedPendingValueCents: 375 });
    expect(report.byProduct).toEqual([
      { productId: 1, productName: "Test product", baseSku: "BASE-A", totalQty: 100, avgCostPerPiece: 4, totalValueCents: 375, activeLots: 1, zeroCostQty: 0, hasLandedPending: true },
      { productId: 2, productName: "No family SKU", baseSku: "", totalQty: 3, avgCostPerPiece: 0, totalValueCents: 0, activeLots: 1, zeroCostQty: 3, hasLandedPending: false },
    ]);
  });

  it("preserves lot SKU aliases, exact costs, filters and pagination", async () => {
    await seed();
    const first = await service.getAllCostLots({ limit: 1 });
    expect(first.total).toBe(2);
    expect(first.lots).toHaveLength(1);
    expect(first.lots[0]).toMatchObject({ id: 21, base_sku: "BASE-A", sku: "PACK-A", qty_on_hand: 100, units_per_variant: 100, total_unit_cost_mills: "375" });
    expect((await service.getAllCostLots({ limit: 1, offset: 1 })).lots[0]).toMatchObject({ id: 22, base_sku: null });
    expect((await service.getAllCostLots({ productId: 1, search: "PACK-A", onlyPending: true })).total).toBe(1);
    expect(await service.getAllCostLots({ search: "does-not-exist" })).toEqual({ lots: [], total: 0 });
  });

  it("accepts rows committed between the separate count and page reads", async () => {
    const database = drizzle(pool, { schema });
    let inserted = false;
    const concurrentService = new COGSService({
      select: database.select.bind(database), insert: database.insert.bind(database),
      update: database.update.bind(database), delete: database.delete.bind(database),
      transaction: database.transaction.bind(database),
      execute: async (query: Parameters<typeof database.execute>[0]) => {
        const result = await database.execute(query);
        if (!inserted) {
          inserted = true;
          // The count has completed. A separate committed writer can add lots
          // before the owner's next statement starts its PostgreSQL snapshot.
          await seed();
        }
        return result;
      },
    });
    const report = await concurrentService.getAllCostLots();
    expect(report.total).toBe(0);
    expect(report.lots.map((lot) => lot.id)).toEqual([21, 22]);
  });
});
