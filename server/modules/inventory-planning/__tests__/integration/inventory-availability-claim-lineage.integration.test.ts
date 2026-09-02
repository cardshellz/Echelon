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
const executionContractMigration = readFileSync(
  resolve(process.cwd(), "migrations/0642_inventory_availability_claim_execution_contract.sql"),
  "utf8",
);
const buildHandoffMigration = readFileSync(
  resolve(process.cwd(), "migrations/0644_inventory_availability_claim_build_handoff.sql"),
  "utf8",
);
const buildExecutionMigration = readFileSync(
  resolve(process.cwd(), "migrations/0646_inventory_availability_claim_build_execution.sql"),
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
  const qualifiedExecutionContractMigration = executionContractMigration
    .replaceAll("inventory.", `"${schemas.inventory}".`)
    .replaceAll("warehouse.", `"${schemas.warehouse}".`)
    .replaceAll("catalog.", `"${schemas.catalog}".`)
    .replaceAll("wms.", `"${schemas.wms}".`);
  const qualifiedBuildHandoffMigration = buildHandoffMigration
    .replaceAll("inventory.", `"${schemas.inventory}".`)
    .replaceAll("warehouse.", `"${schemas.warehouse}".`)
    .replaceAll("catalog.", `"${schemas.catalog}".`)
    .replaceAll("wms.", `"${schemas.wms}".`);
  const qualifiedBuildExecutionMigration = buildExecutionMigration
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
      CREATE TABLE "${schemas.inventory}".build_orders (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.inventory}".build_component_reservations (id integer PRIMARY KEY);
    `);
    await pool.query(qualifiedMigration);
    await pool.query(qualifiedExecutionContractMigration);
    await pool.query(qualifiedBuildHandoffMigration);
    await pool.query(qualifiedBuildExecutionMigration);
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
      "availability_claim_build_handoffs",
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

  it("installs exact committed-output, producer, and cost-breakdown evidence", async () => {
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND (table_name, column_name) IN (
           ('availability_claim_operations', 'committed_output_qty'),
           ('availability_claim_resources', 'producer_operation_key'),
           ('availability_claim_lot_allocations', 'po_unit_cost_mills'),
           ('availability_claim_lot_allocations', 'packaging_unit_cost_mills'),
           ('availability_claim_lot_allocations', 'landed_unit_cost_mills')
         )`,
      [schemas.inventory],
    );
    expect(columns.rows).toHaveLength(5);

    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = $1::regnamespace
         AND conname IN (
           'availability_claim_operations_committed_output_chk',
           'availability_claim_resources_producer_operation_fk',
           'availability_claim_lot_allocations_cost_breakdown_chk'
         )`,
      [schemas.inventory],
    );
    expect(constraints.rows.map((row) => row.conname).sort()).toEqual([
      "availability_claim_lot_allocations_cost_breakdown_chk",
      "availability_claim_operations_committed_output_chk",
      "availability_claim_resources_producer_operation_fk",
    ]);
  });

  it("installs one-to-one build handoff and exact adopted-reservation ownership", async () => {
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND (table_name, column_name) IN (
           ('build_component_reservations', 'reservation_owner'),
           ('build_component_reservations', 'availability_claim_id'),
           ('build_component_reservations', 'availability_claim_lot_allocation_id')
         )`,
      [schemas.inventory],
    );
    expect(columns.rows).toHaveLength(3);

    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = $1::regnamespace
         AND conname IN (
           'availability_claim_build_handoffs_operation_uq',
           'availability_claim_build_handoffs_build_order_uq',
           'build_component_reservations_claim_allocation_fk',
           'build_component_reservations_owner_chk'
         )`,
      [schemas.inventory],
    );
    expect(constraints.rows.map((row) => row.conname).sort()).toEqual([
      "availability_claim_build_handoffs_build_order_uq",
      "availability_claim_build_handoffs_operation_uq",
      "build_component_reservations_claim_allocation_fk",
      "build_component_reservations_owner_chk",
    ]);
  });

  it("keeps build execution receipts distinct from package execution receipts", async () => {
    const constraint = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = $1::regnamespace
         AND conname = 'availability_claim_commands_type_chk'`,
      [schemas.inventory],
    );
    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0]?.definition).toContain("execute_build");
  });
});
