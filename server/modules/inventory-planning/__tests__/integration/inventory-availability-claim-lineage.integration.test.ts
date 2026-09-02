import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE_DB = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeWithDisposableDb = TEST_DB_URL && DISPOSABLE_DB ? describe : describe.skip;
const sourceMigration = readFileSync(
  resolve(process.cwd(), "migrations/0640_inventory_availability_claim_lineage.sql"),
  "utf8",
);

function sslConfig(connectionString: string) {
  return /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false };
}

describeWithDisposableDb.sequential("canonical availability claim lineage PostgreSQL guarantees", () => {
  let pool: pg.Pool;
  const suffix = `${process.pid}`;
  const schemas = {
    inventory: `claim_inventory_${suffix}`,
    warehouse: `claim_warehouse_${suffix}`,
    catalog: `claim_catalog_${suffix}`,
    wms: `claim_wms_${suffix}`,
  } as const;

  const qualifiedMigration = sourceMigration
    .replaceAll("inventory.", `"${schemas.inventory}".`)
    .replaceAll("warehouse.", `"${schemas.warehouse}".`)
    .replaceAll("catalog.", `"${schemas.catalog}".`)
    .replaceAll("wms.", `"${schemas.wms}".`);

  beforeAll(async () => {
    const protectedUrls = [
      process.env.DATABASE_URL,
      process.env.EXTERNAL_DATABASE_URL,
    ].filter((value): value is string => Boolean(value));
    if (!TEST_DB_URL || !DISPOSABLE_DB || protectedUrls.includes(TEST_DB_URL)) {
      throw new Error("Canonical claim integration tests require a distinct disposable database");
    }
    pool = new pg.Pool({
      connectionString: TEST_DB_URL,
      max: 2,
      ssl: sslConfig(TEST_DB_URL),
    });
    await pool.query(`
      CREATE SCHEMA "${schemas.catalog}";
      CREATE SCHEMA "${schemas.warehouse}";
      CREATE SCHEMA "${schemas.inventory}";
      CREATE SCHEMA "${schemas.wms}";

      CREATE TABLE "${schemas.catalog}".product_variants (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.warehouse}".warehouses (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.warehouse}".warehouse_locations (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.wms}".orders (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.wms}".order_items (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.inventory}".availability_activation_runs (id bigint PRIMARY KEY);
      CREATE TABLE "${schemas.inventory}".inventory_levels (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.inventory}".inventory_lots (id integer PRIMARY KEY);
    `);
    await pool.query(qualifiedMigration);
  }, 300_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`
      DROP SCHEMA IF EXISTS "${schemas.inventory}" CASCADE;
      DROP SCHEMA IF EXISTS "${schemas.warehouse}" CASCADE;
      DROP SCHEMA IF EXISTS "${schemas.catalog}" CASCADE;
      DROP SCHEMA IF EXISTS "${schemas.wms}" CASCADE;
    `);
    await pool.end();
  });

  it("creates every claim-lineage table and permits a claimless no-op receipt", async () => {
    for (const table of [
      "availability_claims",
      "availability_claim_lines",
      "availability_claim_operations",
      "availability_claim_operation_inputs",
      "availability_claim_resources",
      "availability_claim_lot_allocations",
      "availability_claim_commands",
      "availability_claim_events",
    ]) {
      const relation = await pool.query<{ relation: string | null }>(
        "SELECT to_regclass($1)::text AS relation",
        [`${schemas.inventory}.${table}`],
      );
      expect(relation.rows[0]?.relation).toContain(table);
    }

    await pool.query(`INSERT INTO "${schemas.wms}".orders (id) VALUES (1)`);
    await pool.query(
      `INSERT INTO "${schemas.inventory}".availability_claim_commands (
         claim_id, order_id, command_type, idempotency_key, request_hash, result_hash,
         request_payload, result_payload, actor, reason, occurred_at
       ) VALUES (NULL, 1, 'claim', 'noop:1', $1, $2, '{}'::jsonb, '{}'::jsonb,
                 'integration-test', 'no claim required', now())`,
      ["a".repeat(64), "b".repeat(64)],
    );
  });

  it("rejects mutation of command evidence", async () => {
    await expect(pool.query(
      `UPDATE "${schemas.inventory}".availability_claim_commands
       SET reason = 'changed' WHERE idempotency_key = 'noop:1'`,
    )).rejects.toThrow(/append-only/);
  });
});
