import { resolve } from "node:path";

import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COGSService } from "../../cogs.service";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE_DB = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeWithDisposableDb = TEST_DB_URL && DISPOSABLE_DB ? describe : describe.skip;

function sslConfig(connectionString: string) {
  return /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false };
}

describeWithDisposableDb.sequential("invoice variance COGS PostgreSQL transactions", () => {
  let pool: pg.Pool;
  let service: COGSService;

  beforeAll(async () => {
    const protectedUrls = [
      process.env.DATABASE_URL,
      process.env.EXTERNAL_DATABASE_URL,
    ].filter((value): value is string => Boolean(value));
    if (protectedUrls.includes(TEST_DB_URL!)) {
      throw new Error(
        "ECHELON_TEST_DATABASE_URL must not equal DATABASE_URL or EXTERNAL_DATABASE_URL",
      );
    }
    if (!DISPOSABLE_DB) {
      throw new Error("Invoice variance integration tests require an explicitly disposable database");
    }

    pool = new pg.Pool({
      connectionString: TEST_DB_URL,
      max: 4,
      ssl: sslConfig(TEST_DB_URL!),
    });
    await pool.query(`
      DROP SCHEMA IF EXISTS oms CASCADE;
      DROP SCHEMA IF EXISTS inventory CASCADE;
      DROP SCHEMA IF EXISTS catalog CASCADE;
      CREATE SCHEMA catalog;
      CREATE SCHEMA inventory;
      CREATE SCHEMA oms;

      CREATE TABLE catalog.product_variants (
        id INTEGER PRIMARY KEY,
        sku VARCHAR(100) NOT NULL
      );

      CREATE TABLE inventory.inventory_lots (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        lot_number VARCHAR(50) NOT NULL,
        product_variant_id INTEGER NOT NULL,
        purchase_order_id INTEGER,
        unit_cost_cents BIGINT NOT NULL DEFAULT 0,
        po_unit_cost_cents BIGINT NOT NULL DEFAULT 0,
        packaging_cost_cents BIGINT NOT NULL DEFAULT 0,
        landed_cost_cents BIGINT NOT NULL DEFAULT 0,
        total_unit_cost_cents BIGINT NOT NULL DEFAULT 0,
        unit_cost_mills BIGINT NOT NULL DEFAULT 0,
        po_unit_cost_mills BIGINT NOT NULL DEFAULT 0,
        packaging_cost_mills BIGINT NOT NULL DEFAULT 0,
        landed_cost_mills BIGINT NOT NULL DEFAULT 0,
        total_unit_cost_mills BIGINT NOT NULL DEFAULT 0,
        cost_provisional INTEGER NOT NULL DEFAULT 0,
        cost_source VARCHAR(20) NOT NULL DEFAULT 'po'
      );

      CREATE TABLE oms.order_item_costs (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        inventory_lot_id INTEGER NOT NULL,
        qty INTEGER NOT NULL,
        unit_cost_cents BIGINT NOT NULL,
        total_cost_cents BIGINT NOT NULL,
        unit_cost_mills BIGINT NOT NULL DEFAULT 0,
        total_cost_mills BIGINT NOT NULL DEFAULT 0
      );

      CREATE TABLE inventory.cost_adjustment_log (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        lot_id INTEGER NOT NULL,
        lot_number VARCHAR(50) NOT NULL,
        product_variant_id INTEGER NOT NULL,
        sku VARCHAR(100) NOT NULL,
        old_cost_cents BIGINT NOT NULL,
        new_cost_cents BIGINT NOT NULL,
        delta_cents BIGINT NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL
      );

      INSERT INTO catalog.product_variants (id, sku)
      VALUES (5, 'INVOICE-VARIANCE-TEST');
    `);

    service = new COGSService(drizzle(pool) as any);
  });

  beforeEach(async () => {
    await pool.query(`
      DROP TRIGGER IF EXISTS fail_second_lot_adjustment ON inventory.cost_adjustment_log;
      DROP FUNCTION IF EXISTS inventory.fail_second_lot_adjustment();
      TRUNCATE inventory.cost_adjustment_log, oms.order_item_costs,
        inventory.inventory_lots RESTART IDENTITY;
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`
        DROP SCHEMA IF EXISTS oms CASCADE;
        DROP SCHEMA IF EXISTS inventory CASCADE;
        DROP SCHEMA IF EXISTS catalog CASCADE;
      `);
      await pool.end();
    }
  });

  async function seedTwoLots() {
    const lots = await pool.query<{ id: number }>(`
      INSERT INTO inventory.inventory_lots (
        lot_number, product_variant_id, purchase_order_id,
        unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
        landed_cost_cents, total_unit_cost_cents,
        unit_cost_mills, po_unit_cost_mills, packaging_cost_mills,
        landed_cost_mills, total_unit_cost_mills, cost_source
      ) VALUES
        ('LOT-001', 5, 100, 600, 500, 0, 100, 600, 60000, 50000, 0, 10000, 60000, 'po'),
        ('LOT-002', 5, 100, 570, 500, 20, 50, 570, 57000, 50000, 2000, 5000, 57000, 'po')
      RETURNING id
    `);
    await pool.query(
      `INSERT INTO oms.order_item_costs (
         inventory_lot_id, qty, unit_cost_cents, total_cost_cents,
         unit_cost_mills, total_cost_mills
       ) VALUES
         ($1, 5, 600, 3000, 60000, 300000),
         ($2, 2, 570, 1140, 57000, 114000)`,
      [lots.rows[0].id, lots.rows[1].id],
    );
    return lots.rows.map((row) => row.id);
  }

  it("revalues every lot and existing COGS row with exact mills", async () => {
    await seedTwoLots();

    const result = await service.reconcileInvoiceVariance({
      purchaseOrderId: 100,
      productVariantId: 5,
      invoiceUnitCostCents: 551,
      invoiceUnitCostMills: 55055,
      invoiceNumber: "INV-PG-001",
    });

    expect(result).toEqual({
      lotsUpdated: 2,
      cogsRowsUpdated: 2,
      totalCogsDeltaCents: 354,
    });

    const lots = await pool.query(`
      SELECT lot_number, po_unit_cost_mills, landed_cost_mills,
             packaging_cost_mills, total_unit_cost_mills, unit_cost_cents,
             cost_source
      FROM inventory.inventory_lots
      ORDER BY id
    `);
    expect(lots.rows).toEqual([
      {
        lot_number: "LOT-001",
        po_unit_cost_mills: "55055",
        landed_cost_mills: "10000",
        packaging_cost_mills: "0",
        total_unit_cost_mills: "65055",
        unit_cost_cents: "651",
        cost_source: "invoice",
      },
      {
        lot_number: "LOT-002",
        po_unit_cost_mills: "55055",
        landed_cost_mills: "5000",
        packaging_cost_mills: "2000",
        total_unit_cost_mills: "62055",
        unit_cost_cents: "621",
        cost_source: "invoice",
      },
    ]);

    const cogs = await pool.query(`
      SELECT unit_cost_mills, total_cost_mills, unit_cost_cents, total_cost_cents
      FROM oms.order_item_costs
      ORDER BY id
    `);
    expect(cogs.rows).toEqual([
      {
        unit_cost_mills: "65055",
        total_cost_mills: "325275",
        unit_cost_cents: "651",
        total_cost_cents: "3253",
      },
      {
        unit_cost_mills: "62055",
        total_cost_mills: "124110",
        unit_cost_cents: "621",
        total_cost_cents: "1241",
      },
    ]);

    const adjustmentCount = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM inventory.cost_adjustment_log",
    );
    expect(adjustmentCount.rows[0].count).toBe("2");
  });

  it("rolls back the first lot and COGS row when the second lot fails", async () => {
    const [, secondLotId] = await seedTwoLots();
    await pool.query(`
      CREATE FUNCTION inventory.fail_second_lot_adjustment()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.lot_id = ${secondLotId} THEN
          RAISE EXCEPTION 'forced second lot failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_second_lot_adjustment
      BEFORE INSERT ON inventory.cost_adjustment_log
      FOR EACH ROW EXECUTE FUNCTION inventory.fail_second_lot_adjustment();
    `);

    await expect(service.reconcileInvoiceVariance({
      purchaseOrderId: 100,
      productVariantId: 5,
      invoiceUnitCostCents: 551,
      invoiceUnitCostMills: 55055,
      invoiceNumber: "INV-PG-ROLLBACK",
    })).rejects.toThrow("forced second lot failure");

    const lots = await pool.query(`
      SELECT lot_number, po_unit_cost_mills, total_unit_cost_mills, cost_source
      FROM inventory.inventory_lots
      ORDER BY id
    `);
    expect(lots.rows).toEqual([
      {
        lot_number: "LOT-001",
        po_unit_cost_mills: "50000",
        total_unit_cost_mills: "60000",
        cost_source: "po",
      },
      {
        lot_number: "LOT-002",
        po_unit_cost_mills: "50000",
        total_unit_cost_mills: "57000",
        cost_source: "po",
      },
    ]);

    const cogs = await pool.query(`
      SELECT unit_cost_mills, total_cost_mills
      FROM oms.order_item_costs
      ORDER BY id
    `);
    expect(cogs.rows).toEqual([
      { unit_cost_mills: "60000", total_cost_mills: "300000" },
      { unit_cost_mills: "57000", total_cost_mills: "114000" },
    ]);

    const adjustmentCount = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM inventory.cost_adjustment_log",
    );
    expect(adjustmentCount.rows[0].count).toBe("0");
  });
});
