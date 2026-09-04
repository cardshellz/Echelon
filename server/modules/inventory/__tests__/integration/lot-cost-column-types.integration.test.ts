/**
 * Migration 219 executed against real PostgreSQL.
 *
 * The 2026-09-04 production failure was invisible to unit tests because it
 * lived in the wire format of one column: NUMERIC(10,4) reads back padded to
 * its declared scale ("0.0000") while bigint reads back as "0", and the FIFO
 * lot cost normalizer parses with BigInt(), which rejects a decimal point. Any
 * test with a hand-built lot object passes either way, so this suite drives the
 * real database: it reproduces the pre-migration failure, applies the
 * migration, and proves the read path is fixed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { normalizeBuildLotCosts } from "../../infrastructure/build.repository";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE_DB = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeWithDisposableDb = TEST_DB_URL && DISPOSABLE_DB ? describe : describe.skip;

const MIGRATION_219 = readFileSync(
  resolve(process.cwd(), "migrations/219_inventory_lot_packaging_cost_bigint.sql"),
  "utf8",
);
const MIGRATION_098 = readFileSync(
  resolve(process.cwd(), "migrations/098_lot_packaging_cost.sql"),
  "utf8",
);

/** The lot columns the cost normalizer reads, minus packaging_cost_cents. */
const LOT_COST_COLUMNS = `
  unit_cost_cents BIGINT NOT NULL DEFAULT 0,
  po_unit_cost_cents BIGINT DEFAULT 0,
  landed_cost_cents BIGINT DEFAULT 0,
  total_unit_cost_cents BIGINT DEFAULT 0,
  unit_cost_mills BIGINT NOT NULL DEFAULT 0,
  po_unit_cost_mills BIGINT NOT NULL DEFAULT 0,
  packaging_cost_mills BIGINT NOT NULL DEFAULT 0,
  landed_cost_mills BIGINT NOT NULL DEFAULT 0,
  total_unit_cost_mills BIGINT NOT NULL DEFAULT 0
`;

function sslConfig(connectionString: string) {
  return /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false };
}

describeWithDisposableDb.sequential("inventory lot cost column types", () => {
  let pool: pg.Pool;

  async function columnType(): Promise<string> {
    const result = await pool.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'inventory' AND table_name = 'inventory_lots'
         AND column_name = 'packaging_cost_cents'`,
    );
    return result.rows[0]?.data_type;
  }

  async function readLot(id: number): Promise<Record<string, unknown>> {
    const result = await pool.query(
      `SELECT id, unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
              landed_cost_cents, total_unit_cost_cents, unit_cost_mills,
              po_unit_cost_mills, packaging_cost_mills, landed_cost_mills,
              total_unit_cost_mills
       FROM inventory.inventory_lots WHERE id = $1`,
      [id],
    );
    return result.rows[0];
  }

  beforeAll(async () => {
    const protectedUrls = [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL]
      .filter((value): value is string => Boolean(value));
    if (protectedUrls.includes(TEST_DB_URL!)) {
      throw new Error(
        "ECHELON_TEST_DATABASE_URL must not equal DATABASE_URL or EXTERNAL_DATABASE_URL",
      );
    }
    if (!DISPOSABLE_DB) {
      throw new Error("Lot cost column tests require an explicitly disposable database");
    }
    pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 4, ssl: sslConfig(TEST_DB_URL!) });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // Rebuild the table in its pre-migration production shape: every cost
    // column bigint except packaging_cost_cents, which migration 098 added as
    // NUMERIC(10,4) the day after migration 0576 aligned the others.
    await pool.query(`
      DROP SCHEMA IF EXISTS inventory CASCADE;
      CREATE SCHEMA inventory;
      CREATE TABLE inventory.inventory_lots (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        ${LOT_COST_COLUMNS}
      );
    `);
    await pool.query(MIGRATION_098);
  });

  it("reproduces the production failure before the migration runs", async () => {
    expect(await columnType()).toBe("numeric");

    const inserted = await pool.query(
      `INSERT INTO inventory.inventory_lots DEFAULT VALUES RETURNING id`,
    );
    const lot = await readLot(inserted.rows[0].id);

    // The exact value that broke every transfer: zero, padded to scale 4.
    expect(lot.packaging_cost_cents).toBe("0.0000");
    expect(() => normalizeBuildLotCosts(lot))
      .toThrowError(expect.objectContaining({ code: "INVALID_BUILD_COST" }));
  });

  it("converts the column to bigint and unblocks the read path", async () => {
    const inserted = await pool.query(
      `INSERT INTO inventory.inventory_lots DEFAULT VALUES RETURNING id`,
    );

    await pool.query(MIGRATION_219);

    expect(await columnType()).toBe("bigint");
    const lot = await readLot(inserted.rows[0].id);
    expect(lot.packaging_cost_cents).toBe("0");
    expect(() => normalizeBuildLotCosts(lot)).not.toThrow();
  });

  it("preserves an existing packaging cost through the conversion", async () => {
    const inserted = await pool.query(
      `INSERT INTO inventory.inventory_lots (packaging_cost_cents, total_unit_cost_cents)
       VALUES (125, 500) RETURNING id`,
    );

    await pool.query(MIGRATION_219);

    const lot = await readLot(inserted.rows[0].id);
    expect(lot.packaging_cost_cents).toBe("125");

    const costs = normalizeBuildLotCosts(lot);
    expect(costs.packagingMills).toBe(BigInt(12500));
    expect(costs.totalMills).toBe(BigInt(50000));
  });

  it("keeps the column default usable after the type change", async () => {
    await pool.query(MIGRATION_219);

    const inserted = await pool.query(
      `INSERT INTO inventory.inventory_lots DEFAULT VALUES RETURNING id`,
    );
    const lot = await readLot(inserted.rows[0].id);
    expect(lot.packaging_cost_cents).toBe("0");
  });

  it("is idempotent: a second run changes nothing", async () => {
    await pool.query(MIGRATION_219);
    await expect(pool.query(MIGRATION_219)).resolves.toBeDefined();
    expect(await columnType()).toBe("bigint");
  });

  it("is a no-op when the column does not exist at all", async () => {
    await pool.query(`ALTER TABLE inventory.inventory_lots DROP COLUMN packaging_cost_cents`);
    await expect(pool.query(MIGRATION_219)).resolves.toBeDefined();
    expect(await columnType()).toBeUndefined();
  });
});
