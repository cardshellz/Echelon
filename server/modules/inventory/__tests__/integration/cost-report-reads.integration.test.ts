import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { COGSService } from "../../cogs.service";
import { fixtureTable } from "../../../procurement/__tests__/integration/shipment-line-fixture";
import { getFinanceSummary, getFinanceOrders, getFinanceOrderDetail } from "../../../oms/finance-analytics.service";

// Redirect only the legacy module-level transport. Every statement still runs
// against the explicitly owned PostgreSQL fixture below.
const financeTransport = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../../../db", () => ({ db: financeTransport }));

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
    pool = new pg.Pool({ connectionString: url, ssl: false, max: 2, statement_timeout: 15_000,
      options: "-c search_path=channels,catalog,public" });
    // CREATE without IF NOT EXISTS prevents adopting or deleting existing data.
    for (const name of ["catalog", "inventory", "procurement", "warehouse", "wms", "oms", "channels"]) {
      await pool.query(`CREATE SCHEMA ${name}`);
      ownedSchemas.push(name);
    }
    for (const table of [schema.products, schema.productVariants, schema.inventoryLots,
      schema.purchaseOrders, schema.inboundShipments, schema.warehouseLocations,
      schema.orders, schema.orderItems, schema.orderItemCosts, schema.channels,
      schema.omsOrders, schema.omsOrderLines, schema.omsOrderLineAdjustments, schema.omsOrderEvents]) {
      await pool.query(fixtureTable(table));
    }
    service = new COGSService(drizzle(pool, { schema }));
  });

  beforeEach(async () => {
    const database = drizzle(pool, { schema });
    financeTransport.execute.mockReset().mockImplementation(database.execute.bind(database));
    await pool.query("TRUNCATE channels.channels, oms.oms_orders, oms.oms_order_lines, oms.order_line_adjustments, oms.oms_order_events RESTART IDENTITY");
    await pool.query("TRUNCATE oms.order_item_costs, wms.order_items, wms.orders, inventory.inventory_lots, catalog.product_variants, catalog.products RESTART IDENTITY");
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

  async function seedFinanceLinks() {
    await seed();
    await pool.query(`INSERT INTO channels.channels (id, name, provider) VALUES (1, 'Synthetic channel', 'shopify');
      INSERT INTO oms.oms_orders (id, channel_id, external_order_id, ordered_at, total_cents, subtotal_cents)
        VALUES (101, 1, 'provider-101', '2026-09-10', 10000, 10000),
          (102, 1, 'provider-102', '2026-09-10', 20000, 20000);
      INSERT INTO wms.orders (id, order_number, customer_name, source, oms_fulfillment_order_id, source_table_id)
        VALUES (31, 'FIN-DIRECT', 'Synthetic', 'oms', '101', '102'),
          (32, 'FIN-LEGACY', 'Synthetic', 'shopify', 'gid://shopify/Order/11998330978463', '101'),
          (33, 'FIN-GID', 'Synthetic', 'shopify', 'gid://shopify/Order/11998330978463', NULL),
          (34, 'FIN-PROVIDER-COLLISION', 'Synthetic', 'shopify', '101', NULL),
          (35, 'FIN-OVERFLOW', 'Synthetic', 'oms', '999999999999999999999999999999999', NULL),
          (36, 'FIN-OTHER', 'Synthetic', 'oms', '102', NULL);
      INSERT INTO wms.order_items (id, order_id, sku, name, quantity)
        SELECT id + 10, id, 'PACK-A', 'Synthetic item', 1 FROM wms.orders;
      INSERT INTO oms.order_item_costs (order_id, order_item_id, inventory_lot_id, product_variant_id, qty, unit_cost_cents, total_cost_cents)
        SELECT id, id + 10, 21, 11, 1, CASE WHEN id=31 THEN 100 WHEN id=32 THEN 200 WHEN id=36 THEN 50 ELSE 999 END,
          CASE WHEN id=31 THEN 100 WHEN id=32 THEN 200 WHEN id=36 THEN 50 ELSE 999 END FROM wms.orders;`);
  }

  it("attributes finance summary, channel, list and detail costs consistently across internal and legacy links", async () => {
    await seedFinanceLinks();
    const from = new Date('2026-09-10T00:00:00Z');
    const to = new Date('2026-09-11T00:00:00Z');
    const summary = await getFinanceSummary(from, to);
    expect(summary.waterfall.cogsCents).toMatchObject({ value: 350, priorValue: 0 });
    expect(summary.waterfall.grossMarginCents.value).toBe(29650);
    expect(summary.channels).toMatchObject([{ channelId: 1, cogsCents: 350 }]);
    const list = await getFinanceOrders({ from, to });
    expect(list.orders.find(order => order.id === 101)?.cogsCents).toBe(300);
    expect(list.orders.find(order => order.id === 102)?.cogsCents).toBe(50);
    const detail = await getFinanceOrderDetail(101);
    expect(detail?.cogsTotalCents).toBe(300);
    expect(detail?.costs.map(cost => cost.totalCostCents)).toEqual([100, 200]);
  });

  it("does not turn an unavailable aggregate COGS query into zero cost and inflated margin", async () => {
    const database = drizzle(pool, { schema });
    financeTransport.execute.mockImplementation(async (query) => {
      const compiled = new (await import('drizzle-orm/pg-core')).PgDialect().sqlToQuery(query).sql;
      if (compiled.includes('AS cogs_mills') && !compiled.includes('oo.channel_id')) {
        throw Object.assign(new Error('Synthetic COGS read failure'), { code: '57014' });
      }
      return database.execute(query);
    });
    await expect(getFinanceSummary(new Date('2026-09-10'), new Date('2026-09-11')))
      .rejects.toMatchObject({ code: '57014' });
  });

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

  it("uses recorded order and extended line cents without inventing quantities or repeating same-SKU costs", async () => {
    await seed();
    await pool.query(`INSERT INTO wms.orders (id, order_number, customer_name, total_cents) VALUES (31, 'COST-READ-31', 'Synthetic cost read', 1500);
      INSERT INTO wms.order_items (id, order_id, sku, name, quantity, unit_price_cents, paid_price_cents, total_price_cents)
        VALUES (41, 31, 'PACK-A', 'First pack line', 3, 333, 333, 1000),
          (42, 31, 'PACK-A', 'Second pack line', 1, 300, 300, 300),
          (43, 31, 'PIECE-B', 'Cancelled zero-quantity line', 0, 500, 500, 0);
      INSERT INTO oms.order_item_costs (order_id, order_item_id, inventory_lot_id, product_variant_id, qty, unit_cost_cents, total_cost_cents)
        VALUES (31, 41, 21, 11, 2, 100, 200), (31, 41, 21, 11, 1, 105, 105),
          (31, 42, 21, 11, 1, 100, 100);`);
    const report = await service.getOrderCOGSByNumber('COST-READ-31');
    expect(report).toMatchObject({ orderId: 31, totalRevenueCents: 1500, totalCogsCents: 405, grossMarginCents: 1095, marginPercent: 73 });
    expect(report?.lineItems).toMatchObject([
      { orderItemId: 41, productName: 'First pack line', qty: 3, revenueCents: 1000, cogsCents: 305, marginCents: 695, marginPercent: 69.5 },
      { orderItemId: 42, productName: 'Second pack line', qty: 1, revenueCents: 300, cogsCents: 100, marginCents: 200, marginPercent: 66.67 },
      { orderItemId: 43, productName: 'Cancelled zero-quantity line', qty: 0, revenueCents: 0, cogsCents: 0, marginCents: 0, marginPercent: 0 },
    ]);
    expect(report?.lineItems.map((line) => line.lotBreakdown.length)).toEqual([2, 1, 0]);
  });

  it("distinguishes a missing order from an existing empty zero-total order", async () => {
    await expect(service.getOrderCOGS(999)).resolves.toBeNull();
    await pool.query("INSERT INTO wms.orders (id, order_number, customer_name, total_cents) VALUES (31, 'EMPTY-31', 'Synthetic cost read', 0)");
    await expect(service.getOrderCOGS(31)).resolves.toMatchObject({ totalRevenueCents: 0, totalCogsCents: 0, grossMarginCents: 0, marginPercent: 0, lineItems: [] });
  });

  it("rejects a stored order total beyond the exact JSON integer range", async () => {
    await pool.query("INSERT INTO wms.orders (id, order_number, customer_name, total_cents) VALUES (31, 'UNSAFE-31', 'Synthetic cost read', 9007199254740992)");
    await expect(service.getOrderCOGS(31)).rejects.toMatchObject({ code: 'ORDER_COGS_INVALID_DATA' });
  });

  it("rounds authoritative extended mills only after aggregation and rejects unsupported order currency", async () => {
    await seed();
    await pool.query(`INSERT INTO wms.orders (id, order_number, customer_name, total_cents, currency)
        VALUES (31, 'PRECISE-31', 'Synthetic cost read', 100, 'USD');
      INSERT INTO wms.order_items (id, order_id, sku, name, quantity, total_price_cents)
        VALUES (41, 31, 'PACK-A', 'Precise cost line', 2, 100);
      INSERT INTO oms.order_item_costs (order_id, order_item_id, inventory_lot_id, product_variant_id, qty,
        unit_cost_cents, total_cost_cents, unit_cost_mills, total_cost_mills)
        VALUES (31, 41, 21, 11, 1, 0, 0, 49, 49), (31, 41, 21, 11, 1, 0, 0, 49, 49);`);
    const report = await service.getOrderCOGS(31);
    expect(report).toMatchObject({ totalRevenueCents: 100, totalCogsCents: 1, totalCogsMills: '98', grossMarginCents: 99 });
    expect(report?.lineItems[0]).toMatchObject({ cogsCents: 1, cogsMills: '98' });
    await pool.query("UPDATE wms.orders SET currency='EUR' WHERE id=31");
    await expect(service.getOrderCOGS(31)).rejects.toMatchObject({ code: 'ORDER_COGS_CURRENCY_UNSUPPORTED', currency: 'EUR' });
  });

  it("keeps one consistent snapshot while a writer commits another order line and its cost", async () => {
    await seed();
    await pool.query(`INSERT INTO wms.orders (id, order_number, customer_name, total_cents) VALUES (31, 'SNAPSHOT-31', 'Synthetic cost read', 100);
      INSERT INTO wms.order_items (id, order_id, sku, name, quantity, total_price_cents) VALUES (41, 31, 'PACK-A', 'Original line', 1, 100);`);
    const database = drizzle(pool, { schema });
    let inserted = false;
    const concurrentService = new COGSService({
      select: database.select.bind(database), insert: database.insert.bind(database), update: database.update.bind(database),
      delete: database.delete.bind(database), execute: database.execute.bind(database),
      transaction: (callback, config) => database.transaction(async (tx) => {
        // The reader has already loaded its order/items when it requests the
        // ledger. Commit an independent writer before that SQL statement runs.
        const reader = { select: tx.select.bind(tx), execute: async (query: Parameters<typeof tx.execute>[0]) => {
          if (!inserted) {
            inserted = true;
            await database.transaction(async (writer) => writer.execute(sql`
              UPDATE wms.orders SET total_cents=200 WHERE id=31;
              INSERT INTO wms.order_items (id, order_id, sku, name, quantity, total_price_cents) VALUES (42, 31, 'PACK-A', 'New line', 1, 100);
              INSERT INTO oms.order_item_costs (order_id, order_item_id, inventory_lot_id, product_variant_id, qty,
                unit_cost_cents, total_cost_cents, unit_cost_mills, total_cost_mills) VALUES (31, 42, 21, 11, 1, 50, 50, 5000, 5000);
            `));
          }
          return tx.execute(query);
        } };
        return callback(reader);
      }, config),
    });
    expect(await concurrentService.getOrderCOGS(31)).toMatchObject({ totalRevenueCents: 100, totalCogsCents: 0,
      lineItems: [{ orderItemId: 41 }] });
    const next = await service.getOrderCOGS(31);
    expect(next).toMatchObject({ totalRevenueCents: 200, totalCogsCents: 50 });
    expect(next?.lineItems.map((line) => line.orderItemId)).toEqual([41, 42]);
  });
});
