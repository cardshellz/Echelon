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
const pickLineageMigration = readFileSync(
  resolve(process.cwd(), "migrations/0647_inventory_availability_claim_pick_lineage.sql"),
  "utf8",
);
const pickerObservationMigration = readFileSync(
  resolve(process.cwd(), "migrations/0648_inventory_availability_claim_picker_observation.sql"),
  "utf8",
);
const claimReplacementMigration = readFileSync(
  resolve(process.cwd(), "migrations/0649_inventory_availability_claim_replacement.sql"),
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
    oms: `claim_oms_${suffix}`,
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
  const qualifiedPickLineageMigration = pickLineageMigration
    .replaceAll("inventory.", `"${schemas.inventory}".`)
    .replaceAll("warehouse.", `"${schemas.warehouse}".`)
    .replaceAll("catalog.", `"${schemas.catalog}".`)
    .replaceAll("wms.", `"${schemas.wms}".`)
    .replaceAll("oms.", `"${schemas.oms}".`);
  const qualifiedPickerObservationMigration = pickerObservationMigration
    .replaceAll("inventory.", `"${schemas.inventory}".`);
  const qualifiedClaimReplacementMigration = claimReplacementMigration
    .replaceAll("inventory.", `"${schemas.inventory}".`);

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
      CREATE SCHEMA "${schemas.oms}";

      CREATE TABLE "${schemas.catalog}".product_variants (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.warehouse}".warehouses (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.warehouse}".warehouse_locations (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.wms}".orders (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.wms}".order_items (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.inventory}".availability_activation_runs (id bigint PRIMARY KEY);
      CREATE TABLE "${schemas.inventory}".inventory_levels (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.inventory}".inventory_lots (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.oms}".order_item_costs (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.inventory}".build_orders (id integer PRIMARY KEY);
      CREATE TABLE "${schemas.inventory}".build_component_reservations (id integer PRIMARY KEY);
    `);
    await pool.query(qualifiedMigration);
    await pool.query(qualifiedExecutionContractMigration);
    await pool.query(qualifiedBuildHandoffMigration);
    await pool.query(qualifiedBuildExecutionMigration);
    await pool.query(qualifiedPickLineageMigration);
    await pool.query(qualifiedPickerObservationMigration);
    await pool.query(qualifiedClaimReplacementMigration);
  }, 300_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`
      DROP SCHEMA IF EXISTS "${schemas.inventory}" CASCADE;
      DROP SCHEMA IF EXISTS "${schemas.warehouse}" CASCADE;
      DROP SCHEMA IF EXISTS "${schemas.catalog}" CASCADE;
      DROP SCHEMA IF EXISTS "${schemas.wms}" CASCADE;
      DROP SCHEMA IF EXISTS "${schemas.oms}" CASCADE;
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
      "availability_claim_pick_movements",
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
    expect(constraint.rows[0]?.definition).toContain("pick");
    expect(constraint.rows[0]?.definition).toContain("unpick");
    expect(constraint.rows[0]?.definition).toContain("pick_observation");
    expect(constraint.rows[0]?.definition).toContain("replace");
  });

  it("enforces one same-order predecessor for each replacement claim", async () => {
    await pool.query(`
      INSERT INTO "${schemas.wms}".orders (id) VALUES (2), (3), (4);
      INSERT INTO "${schemas.inventory}".availability_activation_runs (id) VALUES (1);
    `);
    const claimEvidence = (claimKey: string) => ({
      request: { requestKey: claimKey },
      plan: {
        requestKey: claimKey,
        status: "satisfied",
        snapshotFingerprint: "c".repeat(64),
      },
    });
    const predecessorEvidence = claimEvidence("order:2:availability:revision:1");
    const predecessor = await pool.query<{ id: string }>(
      `INSERT INTO "${schemas.inventory}".availability_claims (
         claim_key, order_id, revision, status, plan_status, scope_kind,
         activation_run_id, runtime_authority_revision, request_hash, plan_hash,
         snapshot_fingerprint, request_payload, plan_payload, model_evidence,
         requested_by, reason, reserved_at, superseded_at
       ) VALUES ($1, 2, 1, 'superseded', 'satisfied', 'network',
                 1, 1, $2, $3, $4, $5::jsonb, $6::jsonb, '[]'::jsonb,
                 'integration-test', 'changed accepted demand', now(), now())
       RETURNING id`,
      [
        predecessorEvidence.request.requestKey,
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        JSON.stringify(predecessorEvidence.request),
        JSON.stringify(predecessorEvidence.plan),
      ],
    );
    const predecessorId = predecessor.rows[0]!.id;
    const crossOrderPredecessorEvidence = claimEvidence("order:4:availability:revision:1");
    const crossOrderPredecessor = await pool.query<{ id: string }>(
      `INSERT INTO "${schemas.inventory}".availability_claims (
         claim_key, order_id, revision, status, plan_status, scope_kind,
         activation_run_id, runtime_authority_revision, request_hash, plan_hash,
         snapshot_fingerprint, request_payload, plan_payload, model_evidence,
         requested_by, reason, reserved_at, superseded_at
       ) VALUES ($1, 4, 1, 'superseded', 'satisfied', 'network',
                 1, 1, $2, $3, $4, $5::jsonb, $6::jsonb, '[]'::jsonb,
                 'integration-test', 'cross-order constraint fixture', now(), now())
       RETURNING id`,
      [
        crossOrderPredecessorEvidence.request.requestKey,
        "2".repeat(64),
        "3".repeat(64),
        "c".repeat(64),
        JSON.stringify(crossOrderPredecessorEvidence.request),
        JSON.stringify(crossOrderPredecessorEvidence.plan),
      ],
    );
    const replacementEvidence = claimEvidence("order:2:availability:revision:2");
    await pool.query(
      `INSERT INTO "${schemas.inventory}".availability_claims (
         claim_key, order_id, revision, supersedes_claim_id, status, plan_status, scope_kind,
         activation_run_id, runtime_authority_revision, request_hash, plan_hash,
         snapshot_fingerprint, request_payload, plan_payload, model_evidence,
         requested_by, reason, reserved_at
       ) VALUES ($1, 2, 2, $2, 'active', 'satisfied', 'network',
                 1, 1, $3, $4, $5, $6::jsonb, $7::jsonb, '[]'::jsonb,
                 'integration-test', 'changed accepted demand', now())`,
      [
        replacementEvidence.request.requestKey,
        predecessorId,
        "d".repeat(64),
        "e".repeat(64),
        "c".repeat(64),
        JSON.stringify(replacementEvidence.request),
        JSON.stringify(replacementEvidence.plan),
      ],
    );

    const wrongOrderEvidence = claimEvidence("order:3:availability:revision:1");
    await expect(pool.query(
      `INSERT INTO "${schemas.inventory}".availability_claims (
         claim_key, order_id, revision, supersedes_claim_id, status, plan_status, scope_kind,
         activation_run_id, runtime_authority_revision, request_hash, plan_hash,
         snapshot_fingerprint, request_payload, plan_payload, model_evidence,
         requested_by, reason, reserved_at, released_at
       ) VALUES ($1, 3, 1, $2, 'released', 'satisfied', 'network',
                 1, 1, $3, $4, $5, $6::jsonb, $7::jsonb, '[]'::jsonb,
                 'integration-test', 'invalid cross-order predecessor', now(), now())`,
      [
        wrongOrderEvidence.request.requestKey,
        crossOrderPredecessor.rows[0]!.id,
        "f".repeat(64),
        "1".repeat(64),
        "c".repeat(64),
        JSON.stringify(wrongOrderEvidence.request),
        JSON.stringify(wrongOrderEvidence.plan),
      ],
    )).rejects.toMatchObject({ constraint: "availability_claims_supersedes_same_order_fk" });

    await expect(pool.query(
      `UPDATE "${schemas.inventory}".availability_claims
       SET supersedes_claim_id = NULL
       WHERE order_id = 2 AND revision = 2`,
    )).rejects.toMatchObject({
      constraint: "availability_claims_replacement_lineage_immutable_chk",
    });

    const skippedRevisionEvidence = claimEvidence("order:4:availability:revision:3");
    await expect(pool.query(
      `INSERT INTO "${schemas.inventory}".availability_claims (
         claim_key, order_id, revision, supersedes_claim_id, status, plan_status, scope_kind,
         activation_run_id, runtime_authority_revision, request_hash, plan_hash,
         snapshot_fingerprint, request_payload, plan_payload, model_evidence,
         requested_by, reason, reserved_at
       ) VALUES ($1, 4, 3, $2, 'active', 'satisfied', 'network',
                 1, 1, $3, $4, $5, $6::jsonb, $7::jsonb, '[]'::jsonb,
                 'integration-test', 'invalid skipped revision', now())`,
      [
        skippedRevisionEvidence.request.requestKey,
        crossOrderPredecessor.rows[0]!.id,
        "4".repeat(64),
        "5".repeat(64),
        "c".repeat(64),
        JSON.stringify(skippedRevisionEvidence.request),
        JSON.stringify(skippedRevisionEvidence.plan),
      ],
    )).rejects.toMatchObject({ constraint: "availability_claims_supersedes_revision_chk" });

    const inactiveSuccessorEvidence = claimEvidence("order:4:availability:revision:2");
    await expect(pool.query(
      `INSERT INTO "${schemas.inventory}".availability_claims (
         claim_key, order_id, revision, supersedes_claim_id, status, plan_status, scope_kind,
         activation_run_id, runtime_authority_revision, request_hash, plan_hash,
         snapshot_fingerprint, request_payload, plan_payload, model_evidence,
         requested_by, reason, reserved_at, released_at
       ) VALUES ($1, 4, 2, $2, 'released', 'satisfied', 'network',
                 1, 1, $3, $4, $5, $6::jsonb, $7::jsonb, '[]'::jsonb,
                 'integration-test', 'invalid inactive successor', now(), now())`,
      [
        inactiveSuccessorEvidence.request.requestKey,
        crossOrderPredecessor.rows[0]!.id,
        "6".repeat(64),
        "7".repeat(64),
        "c".repeat(64),
        JSON.stringify(inactiveSuccessorEvidence.request),
        JSON.stringify(inactiveSuccessorEvidence.plan),
      ],
    )).rejects.toMatchObject({ constraint: "availability_claims_supersedes_status_chk" });
  });

  it("installs picked balances and append-only movement evidence", async () => {
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND (table_name, column_name) IN (
           ('availability_claim_lines', 'picked_target_qty'),
           ('availability_claim_resources', 'picked_qty'),
           ('availability_claim_lot_allocations', 'picked_qty'),
           ('availability_claim_pick_movements', 'reverses_pick_movement_id'),
           ('availability_claim_pick_movements', 'order_item_cost_id')
         )`,
      [schemas.inventory],
    );
    expect(columns.rows).toHaveLength(5);

    const trigger = await pool.query<{ trigger_name: string }>(
      `SELECT trigger_name
       FROM information_schema.triggers
       WHERE event_object_schema = $1
         AND event_object_table = 'availability_claim_pick_movements'
         AND trigger_name = 'availability_claim_pick_movements_append_only'`,
      [schemas.inventory],
    );
    expect(trigger.rows).toHaveLength(2);
  });

  it("installs one same-order successor per superseded claim and a distinct replacement receipt", async () => {
    const column = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'availability_claims'
         AND column_name = 'supersedes_claim_id'`,
      [schemas.inventory],
    );
    expect(column.rows).toHaveLength(1);

    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = $1::regnamespace
         AND conname IN (
           'availability_claims_id_order_uq',
           'availability_claims_supersedes_same_order_fk',
           'availability_claims_supersedes_chk'
         )`,
      [schemas.inventory],
    );
    expect(constraints.rows.map((row) => row.conname).sort()).toEqual([
      "availability_claims_id_order_uq",
      "availability_claims_supersedes_chk",
      "availability_claims_supersedes_same_order_fk",
    ]);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = $1
         AND indexname = 'availability_claims_supersedes_claim_uq'`,
      [schemas.inventory],
    );
    expect(indexes.rows).toHaveLength(1);

    const triggers = await pool.query<{ trigger_name: string }>(
      `SELECT trigger_name
       FROM information_schema.triggers
       WHERE event_object_schema = $1
         AND event_object_table = 'availability_claims'
         AND trigger_name = 'availability_claims_replacement_lineage_guard'`,
      [schemas.inventory],
    );
    expect(triggers.rows).toHaveLength(2);

    const commandType = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = $1::regnamespace
         AND conname = 'availability_claim_commands_type_chk'`,
      [schemas.inventory],
    );
    expect(commandType.rows[0]?.definition).toContain("replace");
  });
});
