import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as databaseSchema from "@shared/schema";

import { PostgresInventoryAvailabilityMasterDataStore } from "../../infrastructure/inventory-availability-master-data.repository";
import { PostgresInventoryPromiseSafetyAdminStore } from "../../infrastructure/inventory-promise-safety-admin.repository";
import { PostgresInventoryChannelExposureAdminStore } from "../../infrastructure/inventory-channel-exposure-admin.repository";
import { loadInventoryAvailabilityBackfillSources } from "../../infrastructure/inventory-availability-backfill.repository";
import { planInventoryAvailabilityBackfill } from "../../domain/inventory-availability-backfill";
import { transformationModelDefinitionSchema } from "../../domain/inventory-availability-master-data.contracts";
import {
  projectCanonicalAtp,
  sealSupplySnapshot,
} from "../../domain/inventory-availability-planner";
import type { SupplySnapshotContentDto } from "@shared/types/inventory-availability-planner";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE_DB = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeWithDisposableDb = TEST_DB_URL && DISPOSABLE_DB ? describe : describe.skip;
const migrationSql = readFileSync(
  resolve(process.cwd(), "migrations/211_inventory_availability_foundation.sql"),
  "utf8",
);
const shadowMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/214_inventory_planner_shadow_evidence.sql"),
  "utf8",
);
const backfillMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0622_inventory_availability_backfill_review.sql"),
  "utf8",
);
const phase4MigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0623_inventory_claim_simulation_activation_outbox.sql"),
  "utf8",
);
const backfillProvenanceRefreshMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0628_inventory_backfill_provenance_refresh.sql"),
  "utf8",
);
const demandObservationDaysMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0630_inventory_demand_evidence_observation_days.sql"),
  "utf8",
);
const channelExposureMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0632_inventory_channel_exposure_policy.sql"),
  "utf8",
);
const publicationReadinessMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0633_inventory_publication_readiness.sql"),
  "utf8",
);
const availabilityCutoverMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0638_inventory_availability_cutover.sql"),
  "utf8",
);
const HASH = "a".repeat(64);
const FIXED_TIME = "2026-08-26T12:00:00.000Z";

function sslConfig(connectionString: string) {
  return /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false };
}

async function expectDatabaseError(
  operation: () => Promise<unknown>,
  message: string,
): Promise<void> {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeTruthy();
  expect((error as { message?: string }).message).toContain(message);
}

describeWithDisposableDb.sequential("inventory availability Slice 1 PostgreSQL guarantees", () => {
  let pool: pg.Pool;
  let createdAuditTable = false;
  let createdIdempotencyTable = false;

  beforeAll(async () => {
    const protectedUrls = [
      process.env.DATABASE_URL,
      process.env.EXTERNAL_DATABASE_URL,
    ].filter((value): value is string => Boolean(value));
    if (!TEST_DB_URL || !DISPOSABLE_DB || protectedUrls.includes(TEST_DB_URL)) {
      throw new Error("Inventory ATP integration tests require a distinct disposable database");
    }

    pool = new pg.Pool({
      connectionString: TEST_DB_URL,
      max: 8,
      ssl: sslConfig(TEST_DB_URL),
    });
    await pool.query(`
      DROP SCHEMA IF EXISTS inventory CASCADE;
      DROP SCHEMA IF EXISTS warehouse CASCADE;
      DROP SCHEMA IF EXISTS catalog CASCADE;
      DROP SCHEMA IF EXISTS channels CASCADE;
      CREATE SCHEMA catalog;
      CREATE SCHEMA warehouse;
      CREATE SCHEMA inventory;
      CREATE SCHEMA channels;

      CREATE TABLE channels.channels (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name varchar(100) NOT NULL,
        provider varchar(30) NOT NULL
      );
      CREATE TABLE channels.channel_connections (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE
      );

      CREATE TABLE catalog.products (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        sku varchar(100),
        name text NOT NULL DEFAULT 'Integration product',
        inventory_strategy varchar(30) NOT NULL DEFAULT 'physical_fungible',
        is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE catalog.product_variants (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
        sku varchar(100),
        name text NOT NULL DEFAULT 'Integration variant',
        units_per_variant integer NOT NULL,
        uom_type varchar(20) NOT NULL DEFAULT 'pack',
        hierarchy_level integer NOT NULL DEFAULT 1,
        is_active boolean NOT NULL DEFAULT true,
        requires_shipping boolean NOT NULL DEFAULT true,
        track_inventory boolean DEFAULT true,
        sales_eligibility varchar(20) NOT NULL DEFAULT 'sellable',
        CONSTRAINT product_variants_id_product_uq UNIQUE (id, product_id)
      );
      CREATE TABLE warehouse.warehouses (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        code varchar(20) NOT NULL DEFAULT 'TEST',
        name varchar(200) NOT NULL DEFAULT 'Integration warehouse',
        warehouse_type varchar(30) NOT NULL DEFAULT 'operations',
        inventory_source_type varchar(20) NOT NULL DEFAULT 'internal',
        is_active integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE warehouse.warehouse_locations (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT
      );
      CREATE TABLE inventory.build_recipes (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        code varchar(50) NOT NULL,
        version integer NOT NULL,
        status varchar(20) NOT NULL,
        output_product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
        name varchar(150) NOT NULL DEFAULT 'Integration recipe',
        recipe_type varchar(20) NOT NULL DEFAULT 'conversion',
        output_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
        output_units_per_variant integer NOT NULL,
        output_qty integer NOT NULL
      );
      CREATE TABLE inventory.build_recipe_components (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        recipe_id integer NOT NULL REFERENCES inventory.build_recipes(id) ON DELETE CASCADE,
        component_product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
        component_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
        component_units_per_variant integer NOT NULL,
        qty integer NOT NULL
      );
    `);
    const auditTable = await pool.query<{ audit_table: string | null }>(
      "SELECT to_regclass('public.audit_events')::text AS audit_table",
    );
    if (auditTable.rows[0]?.audit_table === null) {
      createdAuditTable = true;
      await pool.query(`
        CREATE TABLE public.audit_events (
          id bigserial PRIMARY KEY,
          timestamp timestamptz NOT NULL DEFAULT transaction_timestamp(),
          level text NOT NULL DEFAULT 'AUDIT',
          actor text NOT NULL,
          action text NOT NULL,
          target text,
          changes jsonb,
          context jsonb
        )
      `);
    }

    const idempotencyTable = await pool.query<{ idempotency_table: string | null }>(
      "SELECT to_regclass('public.idempotency_keys')::text AS idempotency_table",
    );
    if (idempotencyTable.rows[0]?.idempotency_table === null) {
      createdIdempotencyTable = true;
      await pool.query(`
        CREATE TABLE public.idempotency_keys (
          key text PRIMARY KEY,
          request_hash text NOT NULL,
          response_body jsonb,
          created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
          expires_at timestamptz
        )
      `);
    }

    const migrationClient = await pool.connect();
    try {
      await migrationClient.query("BEGIN");

      await migrationClient.query(migrationSql);
      await migrationClient.query(shadowMigrationSql);
      await migrationClient.query(backfillMigrationSql);
      await migrationClient.query(phase4MigrationSql);
      await migrationClient.query(backfillProvenanceRefreshMigrationSql);
      await migrationClient.query(demandObservationDaysMigrationSql);
      await migrationClient.query(channelExposureMigrationSql);
      await migrationClient.query(publicationReadinessMigrationSql);
      await migrationClient.query(availabilityCutoverMigrationSql);
      await migrationClient.query("COMMIT");
    } catch (error) {
      await migrationClient.query("ROLLBACK");
      throw error;
    } finally {
      migrationClient.release();
    }
  }, 300_000);

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        warehouse.fulfillment_provider_accounts,
        channels.channels,
        catalog.products,
        warehouse.warehouses,
        public.idempotency_keys,
        public.audit_events
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DROP SCHEMA inventory, warehouse, catalog, channels CASCADE");
      if (createdAuditTable) {
        await pool.query("DROP TABLE public.audit_events");
      }
      if (createdIdempotencyTable) {
        await pool.query("DROP TABLE public.idempotency_keys");
      }
      await pool.end();
    }
  });

  async function seedProductAndWarehouse(units: number[] = [1]) {
    const product = await pool.query<{ id: number }>(
      "INSERT INTO catalog.products DEFAULT VALUES RETURNING id",
    );
    const variants: number[] = [];
    for (const unitsPerVariant of units) {
      const variant = await pool.query<{ id: number }>(
        `INSERT INTO catalog.product_variants (product_id, units_per_variant)
         VALUES ($1, $2) RETURNING id`,
        [product.rows[0].id, unitsPerVariant],
      );
      variants.push(variant.rows[0].id);
    }
    const warehouse = await pool.query<{ id: number }>(
      "INSERT INTO warehouse.warehouses DEFAULT VALUES RETURNING id",
    );
    const location = await pool.query<{ id: number }>(
      `INSERT INTO warehouse.warehouse_locations (warehouse_id)
       VALUES ($1) RETURNING id`,
      [warehouse.rows[0].id],
    );
    return {
      productId: product.rows[0].id,
      variantIds: variants,
      warehouseId: warehouse.rows[0].id,
      locationId: location.rows[0].id,
    };
  }

  async function insertDraftModel(
    productId: number,
    suffix: string,
    buildToPromiseEnabled = false,
  ): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO inventory.transformation_model_versions (
         product_id, version, build_to_promise_enabled, definition_hash,
         validation_state, validation_errors, change_reason, idempotency_key,
         request_hash, created_by
       ) VALUES ($1, 1, $2, $3, 'invalid', '[{"code":"pending"}]'::jsonb,
         'integration model', $4, $3, 'integration-test')
       RETURNING id`,
      [productId, buildToPromiseEnabled, HASH, `model:${suffix}`],
    );
    return result.rows[0].id;
  }

  it("keeps runtime authority legacy and rejects an undeclared commit command", async () => {
    const dryRun = await pool.query<{ id: string }>(
      `INSERT INTO inventory.availability_activation_runs (
         mode, scope, state, request_hash, result_hash,
         expected_catalog_input_hash, expected_catalog_result_hash,
         captured_catalog_input_hash, captured_catalog_result_hash,
         evidence_payload, blocker_codes, idempotency_key, reason, requested_by,
         runtime_authority_changed, provider_write_attempted, outbox_enqueued,
         started_at, completed_at
       ) VALUES (
         'dry_run', 'full_catalog', 'ready_for_publication', $1, $1,
         $1, $1, $1, $1, '{}'::jsonb, '[]'::jsonb,
         'integration-cutover-dry-run', 'Integration cutover evidence', 'integration-test',
         false, false, false, $2, $2
       ) RETURNING id`,
      [HASH, FIXED_TIME],
    );
    const activation = await pool.query<{ id: string }>(
      `INSERT INTO inventory.availability_activation_runs (
         mode, scope, state, source_dry_run_id, request_hash, result_hash,
         expected_catalog_input_hash, expected_catalog_result_hash,
         captured_catalog_input_hash, captured_catalog_result_hash,
         evidence_payload, blocker_codes, idempotency_key, reason, requested_by,
         runtime_authority_changed, provider_write_attempted, outbox_enqueued,
         provider_publication_required, started_at, prepared_at
       ) VALUES (
         'activation', 'full_catalog', 'publishing', $1, $2, $2,
         $2, $2, $2, $2, '{}'::jsonb, '[]'::jsonb,
         'integration-cutover-prepare', 'Integration conservative preparation', 'integration-test',
         false, false, true, true, $3, $3
       ) RETURNING id`,
      [dryRun.rows[0]!.id, "b".repeat(64), FIXED_TIME],
    );
    await pool.query(
      `INSERT INTO inventory.availability_activation_freezes (
         activation_run_id, source_dry_run_id, evidence_hash, acquired_by, acquired_at
       ) VALUES ($1, $2, $3, 'integration-test', $4)`,
      [activation.rows[0]!.id, dryRun.rows[0]!.id, "c".repeat(64), FIXED_TIME],
    );

    try {
      const authority = await pool.query<{ authority: string; activation_run_id: string | null }>(
        `SELECT authority, activation_run_id
         FROM inventory.availability_runtime_authority WHERE singleton_key = true`,
      );
      expect(authority.rows[0]).toEqual({ authority: "legacy", activation_run_id: null });
      await expectDatabaseError(
        () => pool.query(
          `INSERT INTO inventory.availability_activation_commands (
             activation_run_id, command_type, idempotency_key, request_hash, result_hash,
             request_payload, result_payload, actor, reason, occurred_at
           ) VALUES ($1, 'commit', 'integration-cutover-commit', $2, $2,
             '{}'::jsonb, '{}'::jsonb, 'integration-test', 'Undeclared command', $3)`,
          [activation.rows[0]!.id, HASH, FIXED_TIME],
        ),
        "availability_activation_commands_type_chk",
      );
      await expectDatabaseError(
        () => pool.query(
          `UPDATE inventory.availability_runtime_authority
           SET authority = 'canonical', activation_run_id = $1, revision = revision + 1,
               changed_by = 'integration-test', change_reason = 'Invalid early switch'
           WHERE singleton_key = true`,
          [activation.rows[0]!.id],
        ),
        "canonical authority requires its activation run to be activating",
      );
    } finally {
      await pool.query(
        `UPDATE inventory.availability_activation_runs
         SET state = 'failed', failed_at = $2, completed_at = $2 WHERE id = $1`,
        [activation.rows[0]!.id, FIXED_TIME],
      );
      await pool.query(
        `UPDATE inventory.availability_activation_freezes
         SET released_by = 'integration-test', released_at = $2,
             release_reason = 'Integration cleanup'
         WHERE activation_run_id = $1`,
        [activation.rows[0]!.id, FIXED_TIME],
      );
    }
  });

  it("removes the repository-only recipe grouping key before strict backfill DTO validation", async () => {
    const output = await seedProductAndWarehouse([1]);
    const componentProduct = await pool.query<{ id: number }>(
      "INSERT INTO catalog.products DEFAULT VALUES RETURNING id",
    );
    const componentVariant = await pool.query<{ id: number }>(
      `INSERT INTO catalog.product_variants (product_id, units_per_variant)
       VALUES ($1, 1) RETURNING id`,
      [componentProduct.rows[0]!.id],
    );
    const recipe = await pool.query<{ id: number }>(
      `INSERT INTO inventory.build_recipes (
         code, version, status, output_product_id, output_variant_id,
         output_units_per_variant, output_qty
       ) VALUES ('BACKFILL-DTO', 1, 'active', $1, $2, 1, 1) RETURNING id`,
      [output.productId, output.variantIds[0]],
    );
    await pool.query(
      `INSERT INTO inventory.build_recipe_components (
         recipe_id, component_product_id, component_variant_id,
         component_units_per_variant, qty
       ) VALUES ($1, $2, $3, 1, 2)`,
      [recipe.rows[0]!.id, componentProduct.rows[0]!.id, componentVariant.rows[0]!.id],
    );

    const testDatabase = drizzle(pool, { schema: databaseSchema });
    const [source] = await loadInventoryAvailabilityBackfillSources(
      testDatabase,
      [output.productId],
    );

    expect(source?.recipes[0]?.components[0]).toMatchObject({
      componentVariantId: componentVariant.rows[0]!.id,
      componentProductId: componentProduct.rows[0]!.id,
      componentQty: 2,
    });
    expect(source?.recipes[0]?.components[0]).not.toHaveProperty("recipeId");
  });

  async function markModelValid(modelId: number): Promise<void> {
    await pool.query(
      `UPDATE inventory.transformation_model_versions
       SET validation_state = 'valid', validation_errors = '[]'::jsonb
       WHERE id = $1`,
      [modelId],
    );
  }

  async function sealModel(modelId: number): Promise<void> {
    await pool.query(
      `UPDATE inventory.transformation_model_versions
       SET lifecycle_status = 'sealed', sealed_by = 'integration-test', sealed_at = $2
       WHERE id = $1`,
      [modelId, FIXED_TIME],
    );
  }

  async function createActiveProviderIdentity() {
    const account = await pool.query<{ id: number }>(
      `INSERT INTO warehouse.fulfillment_provider_accounts (
         provider, account_namespace, identity_scheme, external_account_id,
         display_name_snapshot, evidence_hash, created_by
       ) VALUES ('acme_3pl', 'seller_us', 'provider_account_id', 'acct-1',
         'ACME 3PL', $1, 'integration-test') RETURNING id`,
      [HASH],
    );
    await pool.query(
      `UPDATE warehouse.fulfillment_provider_accounts
       SET lifecycle_status = 'active', verified_by = 'integration-test', verified_at = $2
       WHERE id = $1`,
      [account.rows[0].id, FIXED_TIME],
    );
    const location = await pool.query<{ id: number }>(
      `INSERT INTO warehouse.fulfillment_provider_locations (
         provider_account_id, identity_scheme, external_location_id,
         display_name_snapshot, evidence_hash, created_by
       ) VALUES ($1, 'provider_location_id', 'loc-1', 'ACME Toronto', $2, 'integration-test')
       RETURNING id`,
      [account.rows[0].id, HASH],
    );
    await pool.query(
      `UPDATE warehouse.fulfillment_provider_locations
       SET lifecycle_status = 'active', verified_by = 'integration-test', verified_at = $2
       WHERE id = $1`,
      [location.rows[0].id, FIXED_TIME],
    );
    return { accountId: account.rows[0].id, locationId: location.rows[0].id };
  }

  it("installs only the retained master-data foundation", async () => {
    const tables = await pool.query<{ table_schema: string; table_name: string }>(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema IN ('inventory', 'warehouse')
        AND (
          table_name LIKE 'transformation_%'
          OR table_name LIKE 'promise_%'
          OR table_name LIKE 'location_promise_%'
          OR table_name LIKE 'demand_evidence_%'
          OR table_name LIKE 'fulfillment_%'
        )
      ORDER BY table_schema, table_name
    `);
    expect(tables.rows).toHaveLength(15);
    expect(tables.rows.some((row) => row.table_name.startsWith("atp_"))).toBe(false);
  });

  it("serializes provider child activation against parent retirement", async () => {
    const account = await pool.query<{ id: number }>(
      `INSERT INTO warehouse.fulfillment_provider_accounts (
         provider, account_namespace, identity_scheme, external_account_id,
         display_name_snapshot, evidence_hash, created_by
       ) VALUES ('acme_3pl', 'seller_us', 'provider_account_id', 'acct-race',
         'ACME 3PL', $1, 'integration-test') RETURNING id`,
      [HASH],
    );
    await pool.query(
      `UPDATE warehouse.fulfillment_provider_accounts
       SET lifecycle_status = 'active', verified_by = 'integration-test', verified_at = $2
       WHERE id = $1`,
      [account.rows[0].id, FIXED_TIME],
    );
    const location = await pool.query<{ id: number }>(
      `INSERT INTO warehouse.fulfillment_provider_locations (
         provider_account_id, identity_scheme, external_location_id,
         display_name_snapshot, evidence_hash, created_by
       ) VALUES ($1, 'provider_location_id', 'loc-race', 'ACME Race', $2, 'integration-test')
       RETURNING id`,
      [account.rows[0].id, HASH],
    );

    const childClient = await pool.connect();
    const parentClient = await pool.connect();
    try {
      await childClient.query("BEGIN");
      await childClient.query(
        `UPDATE warehouse.fulfillment_provider_locations
         SET lifecycle_status = 'active', verified_by = 'integration-test', verified_at = $2
         WHERE id = $1`,
        [location.rows[0].id, FIXED_TIME],
      );

      await parentClient.query("BEGIN");
      await parentClient.query("SET LOCAL statement_timeout = '250ms'");
      await expectDatabaseError(
        () => parentClient.query(
          `UPDATE warehouse.fulfillment_provider_accounts
           SET lifecycle_status = 'retired', retired_by = 'integration-test', retired_at = $2
           WHERE id = $1`,
          [account.rows[0].id, FIXED_TIME],
        ),
        "statement timeout",
      );
      await parentClient.query("ROLLBACK");
      await childClient.query("COMMIT");
    } finally {
      childClient.release();
      parentClient.release();
    }

    await expectDatabaseError(
      () => pool.query(
        `UPDATE warehouse.fulfillment_provider_accounts
         SET lifecycle_status = 'retired', retired_by = 'integration-test', retired_at = $2
         WHERE id = $1`,
        [account.rows[0].id, FIXED_TIME],
      ),
      "active locations",
    );
  });

  it("rejects child activation after a serialized provider-parent retirement", async () => {
    const account = await pool.query<{ id: number }>(
      `INSERT INTO warehouse.fulfillment_provider_accounts (
         provider, account_namespace, identity_scheme, external_account_id,
         display_name_snapshot, evidence_hash, created_by
       ) VALUES ('acme_3pl', 'seller_us', 'provider_account_id', 'acct-parent-first',
         'ACME Parent First', $1, 'integration-test') RETURNING id`,
      [HASH],
    );
    await pool.query(
      `UPDATE warehouse.fulfillment_provider_accounts
       SET lifecycle_status = 'active', verified_by = 'integration-test', verified_at = $2
       WHERE id = $1`,
      [account.rows[0].id, FIXED_TIME],
    );
    const location = await pool.query<{ id: number }>(
      `INSERT INTO warehouse.fulfillment_provider_locations (
         provider_account_id, identity_scheme, external_location_id,
         display_name_snapshot, evidence_hash, created_by
       ) VALUES ($1, 'provider_location_id', 'loc-parent-first',
         'ACME Parent First', $2, 'integration-test') RETURNING id`,
      [account.rows[0].id, HASH],
    );

    const parentClient = await pool.connect();
    const childClient = await pool.connect();
    try {
      await parentClient.query("BEGIN");
      await parentClient.query(
        `UPDATE warehouse.fulfillment_provider_accounts
         SET lifecycle_status = 'retired', retired_by = 'integration-test', retired_at = $2
         WHERE id = $1`,
        [account.rows[0].id, FIXED_TIME],
      );

      await childClient.query("BEGIN");
      await childClient.query("SET LOCAL statement_timeout = '250ms'");
      await expectDatabaseError(
        () => childClient.query(
          `UPDATE warehouse.fulfillment_provider_locations
           SET lifecycle_status = 'active', verified_by = 'integration-test', verified_at = $2
           WHERE id = $1`,
          [location.rows[0].id, FIXED_TIME],
        ),
        "statement timeout",
      );
      await childClient.query("ROLLBACK");
      await parentClient.query("COMMIT");
    } finally {
      parentClient.release();
      childClient.release();
    }

    await expectDatabaseError(
      () => pool.query(
        `UPDATE warehouse.fulfillment_provider_locations
         SET lifecycle_status = 'active', verified_by = 'integration-test', verified_at = $2
         WHERE id = $1`,
        [location.rows[0].id, FIXED_TIME],
      ),
      "active provider account",
    );
  });

  it("requires exact 3PL capabilities and atomically retires node bindings", async () => {
    const scope = await seedProductAndWarehouse();
    const provider = await createActiveProviderIdentity();
    const node = await pool.query<{ id: number }>(
      `INSERT INTO warehouse.fulfillment_nodes (
         code, name, node_type, warehouse_id, provider_account_id, provider_location_id,
         inventory_authority, fulfillment_authority, created_by
       ) VALUES ('CA-3PL', 'Canada 3PL', 'third_party_logistics', $1, $2, $3,
         'external_provider', 'external_provider', 'integration-test') RETURNING id`,
      [scope.warehouseId, provider.accountId, provider.locationId],
    );

    await expectDatabaseError(
      () => pool.query(
        `UPDATE warehouse.fulfillment_nodes
         SET lifecycle_status = 'active', activated_by = 'integration-test', activated_at = $2
         WHERE id = $1`,
        [node.rows[0].id, FIXED_TIME],
      ),
      "observation binding",
    );

    for (const capability of [
      "inventory_observation",
      "fulfillment_execution",
      "custody_reconciliation",
    ]) {
      const binding = await pool.query<{ id: number }>(
        `INSERT INTO warehouse.fulfillment_node_provider_bindings (
           fulfillment_node_id, warehouse_id, provider_account_id, provider_location_id,
           capability, created_by
         ) VALUES ($1, $2, $3, $4, $5, 'integration-test') RETURNING id`,
        [
          node.rows[0].id,
          scope.warehouseId,
          provider.accountId,
          provider.locationId,
          capability,
        ],
      );
      await pool.query(
        `UPDATE warehouse.fulfillment_node_provider_bindings
         SET lifecycle_status = 'active', activated_by = 'integration-test', activated_at = $2
         WHERE id = $1`,
        [binding.rows[0].id, FIXED_TIME],
      );
    }
    await pool.query(
      `UPDATE warehouse.fulfillment_nodes
       SET lifecycle_status = 'active', activated_by = 'integration-test', activated_at = $2
       WHERE id = $1`,
      [node.rows[0].id, FIXED_TIME],
    );

    const invalidRetirement = await pool.connect();
    try {
      await invalidRetirement.query("BEGIN");
      await invalidRetirement.query(
        `UPDATE warehouse.fulfillment_nodes
         SET lifecycle_status = 'retired', retired_by = 'integration-test', retired_at = $2
         WHERE id = $1`,
        [node.rows[0].id, FIXED_TIME],
      );
      await expectDatabaseError(
        () => invalidRetirement.query("COMMIT"),
        "retains active provider bindings",
      );
      await invalidRetirement.query("ROLLBACK");
    } finally {
      invalidRetirement.release();
    }

    const retirement = await pool.connect();
    try {
      await retirement.query("BEGIN");
      await retirement.query(
        `UPDATE warehouse.fulfillment_nodes
         SET lifecycle_status = 'retired', retired_by = 'integration-test', retired_at = $2
         WHERE id = $1`,
        [node.rows[0].id, FIXED_TIME],
      );
      await retirement.query(
        `UPDATE warehouse.fulfillment_node_provider_bindings
         SET lifecycle_status = 'retired', retired_by = 'integration-test', retired_at = $2
         WHERE fulfillment_node_id = $1`,
        [node.rows[0].id, FIXED_TIME],
      );
      await retirement.query("COMMIT");
    } finally {
      retirement.release();
    }
    const activeBindings = await pool.query<{ count: string }>(
      `SELECT count(*) FROM warehouse.fulfillment_node_provider_bindings
       WHERE fulfillment_node_id = $1 AND lifecycle_status = 'active'`,
      [node.rows[0].id],
    );
    expect(activeBindings.rows[0].count).toBe("0");
  });

  it("requires an atomic head swap when a draft definition is sealed", async () => {
    const scope = await seedProductAndWarehouse();
    const modelId = await insertDraftModel(scope.productId, "head-swap");
    await pool.query(
      `INSERT INTO inventory.transformation_model_heads (
         product_id, draft_model_id, updated_by, update_reason
       ) VALUES ($1, $2, 'integration-test', 'create draft head')`,
      [scope.productId, modelId],
    );
    await markModelValid(modelId);

    const invalidSeal = await pool.connect();
    try {
      await invalidSeal.query("BEGIN");
      await invalidSeal.query(
        `UPDATE inventory.transformation_model_versions
         SET lifecycle_status = 'sealed', sealed_by = 'integration-test', sealed_at = $2
         WHERE id = $1`,
        [modelId, FIXED_TIME],
      );
      await expectDatabaseError(
        () => invalidSeal.query("COMMIT"),
        "head is not coherent",
      );
      await invalidSeal.query("ROLLBACK");
    } finally {
      invalidSeal.release();
    }

    const validSeal = await pool.connect();
    try {
      await validSeal.query("BEGIN");
      await validSeal.query(
        `UPDATE inventory.transformation_model_versions
         SET lifecycle_status = 'sealed', sealed_by = 'integration-test', sealed_at = $2
         WHERE id = $1`,
        [modelId, FIXED_TIME],
      );
      await validSeal.query(
        `UPDATE inventory.transformation_model_heads
         SET active_model_id = $2, draft_model_id = NULL, revision = 1,
             updated_by = 'integration-test', update_reason = 'seal draft'
         WHERE product_id = $1`,
        [scope.productId, modelId],
      );
      await validSeal.query("COMMIT");
    } finally {
      validSeal.release();
    }
    const head = await pool.query<{ active_model_id: number; draft_model_id: number | null }>(
      `SELECT active_model_id, draft_model_id
       FROM inventory.transformation_model_heads WHERE product_id = $1`,
      [scope.productId],
    );
    expect(head.rows[0]).toEqual({ active_model_id: modelId, draft_model_id: null });
  });

  it("executes location and safety policy lifecycle guards on their concrete row shapes", async () => {
    const scope = await seedProductAndWarehouse();
    const locationPolicy = await pool.query<{ id: number }>(
      `INSERT INTO inventory.location_promise_policy_versions (
         warehouse_location_id, version, eligibility_mode, definition_hash,
         change_reason, idempotency_key, request_hash, created_by
       ) VALUES ($1, 1, 'eligible', $2, 'location draft',
         'location-policy:row-shape', $2, 'integration-test') RETURNING id`,
      [scope.locationId, HASH],
    );
    await pool.query(
      `INSERT INTO inventory.location_promise_policy_heads (
         warehouse_location_id, draft_policy_id, updated_by, update_reason
       ) VALUES ($1, $2, 'integration-test', 'create location draft')`,
      [scope.locationId, locationPolicy.rows[0].id],
    );
    await pool.query(
      `UPDATE inventory.location_promise_policy_versions
       SET change_reason = 'reviewed location draft'
       WHERE id = $1`,
      [locationPolicy.rows[0].id],
    );

    const locationSeal = await pool.connect();
    try {
      await locationSeal.query("BEGIN");
      await locationSeal.query(
        `UPDATE inventory.location_promise_policy_versions
         SET lifecycle_status = 'sealed', sealed_by = 'integration-test', sealed_at = $2
         WHERE id = $1`,
        [locationPolicy.rows[0].id, FIXED_TIME],
      );
      await locationSeal.query(
        `UPDATE inventory.location_promise_policy_heads
         SET active_policy_id = $2, draft_policy_id = NULL, revision = 1,
             updated_by = 'integration-test', update_reason = 'seal location policy'
         WHERE warehouse_location_id = $1`,
        [scope.locationId, locationPolicy.rows[0].id],
      );
      await locationSeal.query("COMMIT");
    } catch (error) {
      await locationSeal.query("ROLLBACK");
      throw error;
    } finally {
      locationSeal.release();
    }

    const safetyScopeKey = `network:variant:${scope.variantIds[0]}`;
    const safetyPolicy = await pool.query<{ id: number }>(
      `INSERT INTO inventory.promise_safety_policy_versions (
         scope_key, scope_type, product_variant_id, version, policy_mode,
         definition_hash, change_reason, idempotency_key, request_hash, created_by
       ) VALUES ($1, 'network_variant', $2, 1, 'off', $3, 'safety draft',
         'safety-policy:row-shape', $3, 'integration-test') RETURNING id`,
      [safetyScopeKey, scope.variantIds[0], HASH],
    );
    await pool.query(
      `INSERT INTO inventory.promise_safety_policy_heads (
         scope_key, draft_policy_id, updated_by, update_reason
       ) VALUES ($1, $2, 'integration-test', 'create safety draft')`,
      [safetyScopeKey, safetyPolicy.rows[0].id],
    );
    await pool.query(
      `UPDATE inventory.promise_safety_policy_versions
       SET change_reason = 'reviewed safety draft'
       WHERE id = $1`,
      [safetyPolicy.rows[0].id],
    );

    const safetySeal = await pool.connect();
    try {
      await safetySeal.query("BEGIN");
      await safetySeal.query(
        `UPDATE inventory.promise_safety_policy_versions
         SET lifecycle_status = 'sealed', sealed_by = 'integration-test', sealed_at = $2
         WHERE id = $1`,
        [safetyPolicy.rows[0].id, FIXED_TIME],
      );
      await safetySeal.query(
        `UPDATE inventory.promise_safety_policy_heads
         SET active_policy_id = $2, draft_policy_id = NULL, revision = 1,
             updated_by = 'integration-test', update_reason = 'seal safety policy'
         WHERE scope_key = $1`,
        [safetyScopeKey, safetyPolicy.rows[0].id],
      );
      await safetySeal.query("COMMIT");
    } catch (error) {
      await safetySeal.query("ROLLBACK");
      throw error;
    } finally {
      safetySeal.release();
    }

    const activePolicies = await pool.query<{
      active_location_policy_id: number;
      active_safety_policy_id: number;
    }>(
      `SELECT
         location_head.active_policy_id AS active_location_policy_id,
         safety_head.active_policy_id AS active_safety_policy_id
       FROM inventory.location_promise_policy_heads AS location_head
       CROSS JOIN inventory.promise_safety_policy_heads AS safety_head
       WHERE location_head.warehouse_location_id = $1
         AND safety_head.scope_key = $2`,
      [scope.locationId, safetyScopeKey],
    );
    expect(activePolicies.rows[0]).toEqual({
      active_location_policy_id: locationPolicy.rows[0].id,
      active_safety_policy_id: safetyPolicy.rows[0].id,
    });
  });

  it("serializes head publication against definition retirement", async () => {
    const scope = await seedProductAndWarehouse();
    const modelId = await insertDraftModel(scope.productId, "head-race");
    await markModelValid(modelId);
    await sealModel(modelId);
    await pool.query(
      `INSERT INTO inventory.transformation_model_heads (
         product_id, updated_by, update_reason
       ) VALUES ($1, 'integration-test', 'empty head')`,
      [scope.productId],
    );

    const headClient = await pool.connect();
    const modelClient = await pool.connect();
    try {
      await headClient.query("BEGIN");
      await headClient.query(
        `UPDATE inventory.transformation_model_heads
         SET active_model_id = $2, revision = 1,
             updated_by = 'integration-test', update_reason = 'publish model'
         WHERE product_id = $1`,
        [scope.productId, modelId],
      );

      await modelClient.query("BEGIN");
      await modelClient.query("SET LOCAL statement_timeout = '250ms'");
      await expectDatabaseError(
        () => modelClient.query(
          `UPDATE inventory.transformation_model_versions
           SET lifecycle_status = 'retired', retired_by = 'integration-test', retired_at = $2
           WHERE id = $1`,
          [modelId, FIXED_TIME],
        ),
        "statement timeout",
      );
      await modelClient.query("ROLLBACK");
      await headClient.query("COMMIT");
    } finally {
      headClient.release();
      modelClient.release();
    }

    await expectDatabaseError(
      () => pool.query(
        `UPDATE inventory.transformation_model_versions
         SET lifecycle_status = 'retired', retired_by = 'integration-test', retired_at = $2
         WHERE id = $1`,
        [modelId, FIXED_TIME],
      ),
      "active transformation model",
    );
  });

  it("requires build authority and an exact immutable BOM snapshot before sealing", async () => {
    const scope = await seedProductAndWarehouse([1, 5]);
    const modelId = await insertDraftModel(scope.productId, "recipe-complete", true);
    const recipe = await pool.query<{ id: number }>(
      `INSERT INTO inventory.build_recipes (
         code, version, status, output_product_id, output_variant_id,
         output_units_per_variant, output_qty
       ) VALUES ('EA-TO-P5', 1, 'active', $1, $2, 5, 1) RETURNING id`,
      [scope.productId, scope.variantIds[1]],
    );
    await pool.query(
      `INSERT INTO inventory.build_recipe_components (
         recipe_id, component_product_id, component_variant_id,
         component_units_per_variant, qty
       ) VALUES ($1, $2, $3, 1, 5)`,
      [recipe.rows[0].id, scope.productId, scope.variantIds[0]],
    );
    const binding = await pool.query<{ id: number }>(
      `INSERT INTO inventory.transformation_recipe_bindings (
         model_id, recipe_id, relationship_role, recipe_code_snapshot,
         recipe_version_snapshot, recipe_definition_hash, output_product_id_snapshot,
         output_variant_id_snapshot, output_units_per_variant_snapshot,
         output_qty_snapshot, validation_state, validation_errors
       ) VALUES ($1, $2, 'component_build', 'EA-TO-P5', 1, $3, $4, $5, 5, 1,
         'valid', '[]'::jsonb) RETURNING id`,
      [modelId, recipe.rows[0].id, HASH, scope.productId, scope.variantIds[1]],
    );
    await pool.query(
      `INSERT INTO inventory.transformation_recipe_component_snapshots (
         transformation_recipe_binding_id, model_id, component_variant_id,
         component_product_id, component_units_per_variant, component_qty
       ) VALUES ($1, $2, $3, $4, 1, 5)`,
      [binding.rows[0].id, modelId, scope.variantIds[0], scope.productId],
    );
    await markModelValid(modelId);
    await sealModel(modelId);

    const missing = await seedProductAndWarehouse([1]);
    const missingModelId = await insertDraftModel(missing.productId, "recipe-missing", true);
    await markModelValid(missingModelId);
    await expectDatabaseError(
      () => sealModel(missingModelId),
      "invalid or ownership-mismatched members",
    );

    const mismatch = await seedProductAndWarehouse([1, 5]);
    const mismatchModelId = await insertDraftModel(mismatch.productId, "recipe-mismatch", false);
    const mismatchRecipe = await pool.query<{ id: number }>(
      `INSERT INTO inventory.build_recipes (
         code, version, status, output_product_id, output_variant_id,
         output_units_per_variant, output_qty
       ) VALUES ('EA-TO-P5-BAD', 1, 'active', $1, $2, 5, 1) RETURNING id`,
      [mismatch.productId, mismatch.variantIds[1]],
    );
    await pool.query(
      `INSERT INTO inventory.build_recipe_components (
         recipe_id, component_product_id, component_variant_id,
         component_units_per_variant, qty
       ) VALUES ($1, $2, $3, 1, 5)`,
      [mismatchRecipe.rows[0].id, mismatch.productId, mismatch.variantIds[0]],
    );
    const mismatchBinding = await pool.query<{ id: number }>(
      `INSERT INTO inventory.transformation_recipe_bindings (
         model_id, recipe_id, relationship_role, recipe_code_snapshot,
         recipe_version_snapshot, recipe_definition_hash, output_product_id_snapshot,
         output_variant_id_snapshot, output_units_per_variant_snapshot,
         output_qty_snapshot, validation_state, validation_errors
       ) VALUES ($1, $2, 'component_build', 'EA-TO-P5-BAD', 1, $3, $4, $5, 5, 1,
         'valid', '[]'::jsonb) RETURNING id`,
      [mismatchModelId, mismatchRecipe.rows[0].id, HASH, mismatch.productId, mismatch.variantIds[1]],
    );
    await pool.query(
      `INSERT INTO inventory.transformation_recipe_component_snapshots (
         transformation_recipe_binding_id, model_id, component_variant_id,
         component_product_id, component_units_per_variant, component_qty
       ) VALUES ($1, $2, $3, $4, 1, 4)`,
      [
        mismatchBinding.rows[0].id,
        mismatchModelId,
        mismatch.variantIds[0],
        mismatch.productId,
      ],
    );
    await markModelValid(mismatchModelId);
    await expectDatabaseError(
      () => sealModel(mismatchModelId),
      "invalid or ownership-mismatched members",
    );

    const directional = await seedProductAndWarehouse([1, 5, 25]);
    const directionalModelId = await insertDraftModel(
      directional.productId,
      "directional-extra-component",
      false,
    );
    const directionalRecipe = await pool.query<{ id: number }>(
      `INSERT INTO inventory.build_recipes (
         code, version, status, output_product_id, output_variant_id,
         output_units_per_variant, output_qty
       ) VALUES ('EA-TO-P5-EXTRA', 1, 'active', $1, $2, 5, 1) RETURNING id`,
      [directional.productId, directional.variantIds[1]],
    );
    await pool.query(
      `INSERT INTO inventory.build_recipe_components (
         recipe_id, component_product_id, component_variant_id,
         component_units_per_variant, qty
       ) VALUES
         ($1, $2, $3, 1, 5),
         ($1, $2, $4, 25, 1)`,
      [
        directionalRecipe.rows[0].id,
        directional.productId,
        directional.variantIds[0],
        directional.variantIds[2],
      ],
    );
    const directionalBinding = await pool.query<{ id: number }>(
      `INSERT INTO inventory.transformation_recipe_bindings (
         model_id, recipe_id, relationship_role, recipe_code_snapshot,
         recipe_version_snapshot, recipe_definition_hash, output_product_id_snapshot,
         output_variant_id_snapshot, output_units_per_variant_snapshot,
         output_qty_snapshot, validation_state, validation_errors
       ) VALUES ($1, $2, 'directional_conversion', 'EA-TO-P5-EXTRA', 1, $3,
         $4, $5, 5, 1, 'valid', '[]'::jsonb) RETURNING id`,
      [
        directionalModelId,
        directionalRecipe.rows[0].id,
        HASH,
        directional.productId,
        directional.variantIds[1],
      ],
    );
    await pool.query(
      `INSERT INTO inventory.transformation_recipe_component_snapshots (
         transformation_recipe_binding_id, model_id, component_variant_id,
         component_product_id, component_units_per_variant, component_qty
       ) VALUES
         ($1, $2, $3, $4, 1, 5),
         ($1, $2, $5, $4, 25, 1)`,
      [
        directionalBinding.rows[0].id,
        directionalModelId,
        directional.variantIds[0],
        directional.productId,
        directional.variantIds[2],
      ],
    );
    await pool.query(
      `INSERT INTO inventory.transformation_model_paths (
         model_id, source_variant_id, destination_variant_id, input_qty, output_qty,
         source_units_per_variant, destination_units_per_variant, operation_type,
         authority_state, transformation_recipe_binding_id, validation_state, validation_errors
       ) VALUES ($1, $2, $3, 5, 1, 1, 5, 'directed_conversion',
         'allowed', $4, 'valid', '[]'::jsonb)`,
      [
        directionalModelId,
        directional.variantIds[0],
        directional.variantIds[1],
        directionalBinding.rows[0].id,
      ],
    );
    await markModelValid(directionalModelId);
    await expectDatabaseError(
      () => sealModel(directionalModelId),
      "invalid or ownership-mismatched members",
    );
  });

  it("allows explicit blocked paths without executable conversion authority", async () => {
    const scope = await seedProductAndWarehouse([1, 5]);
    const modelId = await insertDraftModel(scope.productId, "blocked-path");
    await pool.query(
      `INSERT INTO inventory.transformation_model_paths (
         model_id, source_variant_id, destination_variant_id, input_qty, output_qty,
         source_units_per_variant, destination_units_per_variant, operation_type,
         authority_state, validation_state, validation_errors
       ) VALUES ($1, $2, $3, 1, 1, 1, 5, 'directed_conversion',
         'blocked', 'valid', '[]'::jsonb)`,
      [modelId, scope.variantIds[0], scope.variantIds[1]],
    );
    await markModelValid(modelId);
    await sealModel(modelId);
  });

  it("creates a validated draft graph, head, and audit atomically with idempotent replay", async () => {
    const scope = await seedProductAndWarehouse([1, 5]);
    const testDatabase = drizzle(pool, { schema: databaseSchema });
    const store = new PostgresInventoryAvailabilityMasterDataStore(testDatabase);
    const definition = transformationModelDefinitionSchema.parse({
      productId: scope.productId,
      buildToPromiseEnabled: false,
      paths: [{
        sourceProductId: scope.productId,
        sourceVariantId: scope.variantIds[0],
        destinationProductId: scope.productId,
        destinationVariantId: scope.variantIds[1],
        inputQty: 5,
        outputQty: 1,
        sourceUnitsPerVariant: 1,
        destinationUnitsPerVariant: 5,
        operationType: "assemble_pack",
        authorityState: "allowed",
        transformationRecipeBindingKey: null,
      }],
      recipeBindings: [],
    });
    const command = {
      actorId: "integration-test",
      changeReason: "Validated EA to P5 authority",
      idempotencyKey: "repository-integration:model-1",
      requestHash: "b".repeat(64),
      definition,
      occurredAt: new Date(FIXED_TIME),
    };

    const created = await store.createTransformationModelDraft(command);
    const replayed = await store.createTransformationModelDraft(command);

    expect(created).toMatchObject({
      version: 1,
      alreadyApplied: false,
    });
    expect(replayed).toEqual({ ...created, alreadyApplied: true });
    const persisted = await pool.query<{
      lifecycle_status: string;
      validation_state: string;
      validation_errors: unknown[];
      draft_model_id: number;
      revision: string;
      path_count: string;
      audit_count: string;
    }>(
      `SELECT model.lifecycle_status, model.validation_state, model.validation_errors,
              head.draft_model_id, head.revision,
              (SELECT count(*) FROM inventory.transformation_model_paths
               WHERE model_id = model.id) AS path_count,
              (SELECT count(*) FROM public.audit_events
               WHERE action = 'inventory_availability.transformation_model.draft_created'
                 AND target = 'inventory.transformation_model:' || model.id::text) AS audit_count
       FROM inventory.transformation_model_versions AS model
       JOIN inventory.transformation_model_heads AS head
         ON head.product_id = model.product_id
       WHERE model.id = $1`,
      [created.modelId],
    );
    expect(persisted.rows[0]).toEqual({
      lifecycle_status: "draft",
      validation_state: "valid",
      validation_errors: [],
      draft_model_id: created.modelId,
      revision: "0",
      path_count: "1",
      audit_count: "1",
    });
  });

  it("serializes concurrent draft creation by product owner", async () => {
    const scope = await seedProductAndWarehouse([1]);
    const testDatabase = drizzle(pool, { schema: databaseSchema });
    const store = new PostgresInventoryAvailabilityMasterDataStore(testDatabase);
    const definition = transformationModelDefinitionSchema.parse({
      productId: scope.productId,
      buildToPromiseEnabled: false,
      paths: [],
      recipeBindings: [],
    });
    const first = store.createTransformationModelDraft({
      actorId: "integration-test",
      changeReason: "First concurrent draft",
      idempotencyKey: "repository-integration:concurrent-1",
      requestHash: "c".repeat(64),
      definition,
      occurredAt: new Date(FIXED_TIME),
    });
    const second = store.createTransformationModelDraft({
      actorId: "integration-test",
      changeReason: "Second concurrent draft",
      idempotencyKey: "repository-integration:concurrent-2",
      requestHash: "d".repeat(64),
      definition,
      occurredAt: new Date(FIXED_TIME),
    });

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: {
        code: "INVENTORY_AVAILABILITY_DRAFT_EXISTS",
        status: 409,
      },
    });
    const counts = await pool.query<{ models: string; heads: string }>(
      `SELECT
         (SELECT count(*) FROM inventory.transformation_model_versions
          WHERE product_id = $1) AS models,
         (SELECT count(*) FROM inventory.transformation_model_heads
          WHERE product_id = $1) AS heads`,
      [scope.productId],
    );
    expect(counts.rows[0]).toEqual({ models: "1", heads: "1" });
  });

  it("atomically supersedes stale Phase 3 provenance without changing active authority", async () => {
    const scope = await seedProductAndWarehouse([1, 5]);
    const testDatabase = drizzle(pool, { schema: databaseSchema });
    const store = new PostgresInventoryAvailabilityMasterDataStore(testDatabase);
    const [initialSource] = await loadInventoryAvailabilityBackfillSources(
      testDatabase,
      [scope.productId],
    );
    const initialCandidate = planInventoryAvailabilityBackfill(initialSource!);
    expect(initialCandidate.definition).not.toBeNull();
    const created = await store.createTransformationModelDraft({
      actorId: "integration-test",
      changeReason: "Initial deterministic Phase 3 draft",
      idempotencyKey: "repository-integration:backfill-old",
      requestHash: "7".repeat(64),
      definition: initialCandidate.definition!,
      backfillEvidence: {
        inputHash: initialCandidate.inputHash,
        resultHash: initialCandidate.resultHash,
      },
      occurredAt: new Date(FIXED_TIME),
    });

    await pool.query(
      "UPDATE catalog.products SET name = 'Same definition, new source evidence' WHERE id = $1",
      [scope.productId],
    );
    const [currentSource] = await loadInventoryAvailabilityBackfillSources(
      testDatabase,
      [scope.productId],
    );
    const currentCandidate = planInventoryAvailabilityBackfill(currentSource!);
    expect(currentCandidate.definitionHash).toBe(initialCandidate.definitionHash);
    expect(currentCandidate.inputHash).not.toBe(initialCandidate.inputHash);
    expect(currentCandidate.resultHash).not.toBe(initialCandidate.resultHash);

    const command = {
      actorId: "integration-test",
      changeReason: "Supersede stale deterministic provenance",
      idempotencyKey: "repository-integration:backfill-refresh",
      requestHash: "8".repeat(64),
      productId: scope.productId,
      draftModelId: created.modelId,
      expectedDraftVersion: 1,
      expectedDraftDefinitionHash: created.definitionHash,
      expectedDraftHeadRevision: "0",
      expectedDraftOriginInputHash: initialCandidate.inputHash,
      expectedDraftOriginResultHash: initialCandidate.resultHash,
      definition: currentCandidate.definition!,
      backfillEvidence: {
        inputHash: currentCandidate.inputHash,
        resultHash: currentCandidate.resultHash,
      },
      occurredAt: new Date("2026-08-30T20:00:00.000Z"),
    };
    const refreshed = await store.supersedeTransformationModelBackfillDraft(command);
    const replayed = await store.supersedeTransformationModelBackfillDraft(command);

    expect(refreshed).toMatchObject({
      version: 2,
      supersededModelId: created.modelId,
      alreadyApplied: false,
    });
    expect(replayed).toEqual({ ...refreshed, alreadyApplied: true });
    const persisted = await pool.query<{
      old_status: string;
      superseded_by: string;
      supersession_reason: string;
      new_status: string;
      new_origin_input_hash: string;
      new_origin_result_hash: string;
      supersedes_model_id: number;
      active_model_id: number | null;
      draft_model_id: number;
      revision: string;
      audit_count: string;
    }>(
      `SELECT old.lifecycle_status AS old_status,
              old.superseded_by,
              old.supersession_reason,
              replacement.lifecycle_status AS new_status,
              replacement.origin_input_hash AS new_origin_input_hash,
              replacement.origin_result_hash AS new_origin_result_hash,
              replacement.supersedes_model_id,
              head.active_model_id,
              head.draft_model_id,
              head.revision,
              (SELECT count(*) FROM public.audit_events
               WHERE action = 'inventory_availability.transformation_model.backfill_refreshed'
                 AND target = 'inventory.transformation_model:' || replacement.id::text) AS audit_count
       FROM inventory.transformation_model_versions AS old
       JOIN inventory.transformation_model_versions AS replacement
         ON replacement.supersedes_model_id = old.id
       JOIN inventory.transformation_model_heads AS head
         ON head.product_id = old.product_id
       WHERE old.id = $1`,
      [created.modelId],
    );
    expect(persisted.rows[0]).toEqual({
      old_status: "superseded",
      superseded_by: "integration-test",
      supersession_reason: "Supersede stale deterministic provenance",
      new_status: "draft",
      new_origin_input_hash: currentCandidate.inputHash,
      new_origin_result_hash: currentCandidate.resultHash,
      supersedes_model_id: created.modelId,
      active_model_id: null,
      draft_model_id: refreshed.modelId,
      revision: "1",
      audit_count: "1",
    });
    await expectDatabaseError(
      () => pool.query(
        "UPDATE inventory.transformation_model_versions SET change_reason = 'tampered' WHERE id = $1",
        [created.modelId],
      ),
      "lifecycle transition superseded -> superseded is not allowed",
    );
  });

  it("deletes a complete draft graph but keeps sealed graph members immutable", async () => {
    const scope = await seedProductAndWarehouse([1, 5]);
    const modelId = await insertDraftModel(scope.productId, "discard-draft");
    const recipe = await pool.query<{ id: number }>(
      `INSERT INTO inventory.build_recipes (
         code, version, status, output_product_id, output_variant_id,
         output_units_per_variant, output_qty
       ) VALUES ('DISCARD', 1, 'active', $1, $2, 5, 1) RETURNING id`,
      [scope.productId, scope.variantIds[1]],
    );
    await pool.query(
      `INSERT INTO inventory.build_recipe_components (
         recipe_id, component_product_id, component_variant_id,
         component_units_per_variant, qty
       ) VALUES ($1, $2, $3, 1, 5)`,
      [recipe.rows[0].id, scope.productId, scope.variantIds[0]],
    );
    const binding = await pool.query<{ id: number }>(
      `INSERT INTO inventory.transformation_recipe_bindings (
         model_id, recipe_id, relationship_role, recipe_code_snapshot,
         recipe_version_snapshot, recipe_definition_hash, output_product_id_snapshot,
         output_variant_id_snapshot, output_units_per_variant_snapshot,
         output_qty_snapshot, validation_state, validation_errors
       ) VALUES ($1, $2, 'component_build', 'DISCARD', 1, $3, $4, $5, 5, 1,
         'valid', '[]'::jsonb) RETURNING id`,
      [modelId, recipe.rows[0].id, HASH, scope.productId, scope.variantIds[1]],
    );
    await pool.query(
      `INSERT INTO inventory.transformation_recipe_component_snapshots (
         transformation_recipe_binding_id, model_id, component_variant_id,
         component_product_id, component_units_per_variant, component_qty
       ) VALUES ($1, $2, $3, $4, 1, 5)`,
      [binding.rows[0].id, modelId, scope.variantIds[0], scope.productId],
    );
    await pool.query("DELETE FROM inventory.transformation_model_versions WHERE id = $1", [modelId]);
    const remaining = await pool.query<{ count: string }>(
      "SELECT count(*) FROM inventory.transformation_recipe_component_snapshots WHERE model_id = $1",
      [modelId],
    );
    expect(remaining.rows[0].count).toBe("0");
  });

  it("makes demand evidence append-only, bigint-safe, zero-day safe, and idempotent by input", async () => {
    const scope = await seedProductAndWarehouse();
    const result = await pool.query<{ id: string }>(
      `INSERT INTO inventory.demand_evidence_snapshots (
         product_variant_id, warehouse_id, window_started_at, window_ended_at,
         irreversible_consumption_units, observed_days, daily_demand_milli_units,
         trust_status, trust_reasons, method_version, input_fingerprint, calculated_at
       ) VALUES ($1, $2, '2026-07-11T00:00:00Z', '2026-08-08T00:00:00Z',
         $3::bigint, 0, $4::bigint, 'untrusted', '["INSUFFICIENT_OBSERVATION_DAYS"]'::jsonb,
         'irreversible_consumption_v1_28d', $5, '2026-08-08T01:00:00Z') RETURNING id`,
      [
        scope.variantIds[0],
        scope.warehouseId,
        "9007199254740993",
        "0",
        HASH,
      ],
    );
    expect(BigInt(result.rows[0].id)).toBeGreaterThan(0n);
    const safetyAdminStore = new PostgresInventoryPromiseSafetyAdminStore(
      drizzle(pool, { schema: databaseSchema }),
    );
    const view = await safetyAdminStore.getPromiseSafetyAdminView(scope.productId);
    expect(view?.demandEvidence[0]?.observedDays).toBe(0);
    await expectDatabaseError(
      () => pool.query(
        "UPDATE inventory.demand_evidence_snapshots SET observed_days = 8 WHERE id = $1",
        [result.rows[0].id],
      ),
      "append-only",
    );
    await expectDatabaseError(
      () => pool.query("DELETE FROM inventory.demand_evidence_snapshots WHERE id = $1", [result.rows[0].id]),
      "append-only",
    );
    await expectDatabaseError(
      () => pool.query(
        `INSERT INTO inventory.demand_evidence_snapshots (
           product_variant_id, warehouse_id, window_started_at, window_ended_at,
           irreversible_consumption_units, observed_days, daily_demand_milli_units,
           trust_status, trust_reasons, method_version, input_fingerprint, calculated_at
         ) VALUES ($1, $2, '2026-07-11T00:00:00Z', '2026-08-08T00:00:00Z',
           1, 0, 0, 'untrusted', '["INSUFFICIENT_OBSERVATION_DAYS"]'::jsonb,
           'irreversible_consumption_v1_28d', $3, '2026-08-08T02:00:00Z')`,
        [scope.variantIds[0], scope.warehouseId, HASH],
      ),
      "demand_evidence_snapshots_input_uq",
    );
  });

  it("persists policy drafts, replays idempotently, and audits predecessor versions", async () => {
    const scope = await seedProductAndWarehouse();
    await pool.query(
      "UPDATE catalog.products SET sku = 'QUAD', name = 'Quad Box' WHERE id = $1",
      [scope.productId],
    );
    const testDatabase = drizzle(pool, { schema: databaseSchema });
    const store = new PostgresInventoryAvailabilityMasterDataStore(testDatabase);
    await expect(store.listProductOptions({ q: "quad", limit: 50 })).resolves.toEqual([
      { id: scope.productId, sku: "QUAD", name: "Quad Box" },
    ]);

    const firstLocationCommand = {
      actorId: "integration-test",
      warehouseLocationId: scope.locationId,
      eligibilityMode: "eligible" as const,
      changeReason: "Reserve location may promise",
      idempotencyKey: "repository-integration:location-1",
      requestHash: "1".repeat(64),
      occurredAt: new Date(FIXED_TIME),
    };
    const firstLocation = await store.createLocationPromisePolicyDraft(firstLocationCommand);
    await expect(store.createLocationPromisePolicyDraft(firstLocationCommand)).resolves.toEqual({
      ...firstLocation,
      alreadyApplied: true,
    });
    const locationPublication = await pool.connect();
    try {
      await locationPublication.query("BEGIN");
      await locationPublication.query(
        `UPDATE inventory.location_promise_policy_versions
         SET lifecycle_status = 'sealed', sealed_by = 'integration-test', sealed_at = $2
         WHERE id = $1`,
        [firstLocation.policyId, FIXED_TIME],
      );
      await locationPublication.query(
        `UPDATE inventory.location_promise_policy_heads
         SET active_policy_id = $2, draft_policy_id = NULL, revision = revision + 1,
             updated_by = 'integration-test', update_reason = 'publish first location policy'
         WHERE warehouse_location_id = $1`,
        [scope.locationId, firstLocation.policyId],
      );
      await locationPublication.query("COMMIT");
    } catch (error) {
      await locationPublication.query("ROLLBACK");
      throw error;
    } finally {
      locationPublication.release();
    }
    const secondLocation = await store.createLocationPromisePolicyDraft({
      ...firstLocationCommand,
      eligibilityMode: "ineligible",
      changeReason: "Exclude damaged reserve location",
      idempotencyKey: "repository-integration:location-2",
      requestHash: "2".repeat(64),
    });
    const locationAudit = await pool.query<{ changes: { before: unknown } }>(
      `SELECT changes FROM public.audit_events
       WHERE action = 'inventory_availability.location_promise_policy.draft_created'
         AND target = $1
       ORDER BY id DESC LIMIT 1`,
      [`inventory.location_promise_policy:${secondLocation.policyId}`],
    );
    expect(locationAudit.rows[0].changes.before).toEqual({
      id: firstLocation.policyId,
      version: 1,
    });

    const safetyScope = {
      scopeType: "network_variant" as const,
      productVariantId: scope.variantIds[0],
    };
    const firstSafetyCommand = {
      actorId: "integration-test",
      scope: safetyScope,
      value: { policyMode: "off" as const },
      changeReason: "No floor for this SKU",
      idempotencyKey: "repository-integration:safety-1",
      requestHash: "3".repeat(64),
      occurredAt: new Date(FIXED_TIME),
    };
    const firstSafety = await store.createPromiseSafetyPolicyDraft(firstSafetyCommand);
    await expect(store.createPromiseSafetyPolicyDraft(firstSafetyCommand)).resolves.toEqual({
      ...firstSafety,
      alreadyApplied: true,
    });
    const safetyPublication = await pool.connect();
    try {
      await safetyPublication.query("BEGIN");
      await safetyPublication.query(
        `UPDATE inventory.promise_safety_policy_versions
         SET lifecycle_status = 'sealed', sealed_by = 'integration-test', sealed_at = $2
         WHERE id = $1`,
        [firstSafety.policyId, FIXED_TIME],
      );
      await safetyPublication.query(
        `UPDATE inventory.promise_safety_policy_heads
         SET active_policy_id = $2, draft_policy_id = NULL, revision = revision + 1,
             updated_by = 'integration-test', update_reason = 'publish first safety policy'
         WHERE scope_key = $1`,
        [firstSafety.scopeKey, firstSafety.policyId],
      );
      await safetyPublication.query("COMMIT");
    } catch (error) {
      await safetyPublication.query("ROLLBACK");
      throw error;
    } finally {
      safetyPublication.release();
    }
    const secondSafety = await store.createPromiseSafetyPolicyDraft({
      ...firstSafetyCommand,
      value: { policyMode: "fixed_units" as const, fixedUnits: 4 },
      changeReason: "Keep four units unpromised",
      idempotencyKey: "repository-integration:safety-2",
      requestHash: "4".repeat(64),
    });
    const safetyAudit = await pool.query<{ changes: { before: unknown } }>(
      `SELECT changes FROM public.audit_events
       WHERE action = 'inventory_availability.promise_safety_policy.draft_created'
         AND target = $1
       ORDER BY id DESC LIMIT 1`,
      [`inventory.promise_safety_policy:${secondSafety.policyId}`],
    );
    expect(safetyAudit.rows[0].changes.before).toEqual({
      id: firstSafety.policyId,
      version: 1,
    });

    await expect(store.createPromiseSafetyPolicyDraft({
      ...firstSafetyCommand,
      idempotencyKey: firstLocationCommand.idempotencyKey,
      requestHash: "5".repeat(64),
    })).rejects.toMatchObject({
      status: 409,
      code: "INVENTORY_AVAILABILITY_IDEMPOTENCY_KEY_REUSED",
    });
  });

  it("updates a draft atomically with a durable receipt, full audit, and stale rollback", async () => {
    const scope = await seedProductAndWarehouse([1, 5]);
    const testDatabase = drizzle(pool, { schema: databaseSchema });
    const store = new PostgresInventoryAvailabilityMasterDataStore(testDatabase);
    const initialDefinition = transformationModelDefinitionSchema.parse({
      productId: scope.productId,
      buildToPromiseEnabled: false,
      paths: [],
      recipeBindings: [],
    });
    const created = await store.createTransformationModelDraft({
      actorId: "integration-test",
      changeReason: "Create editable draft",
      idempotencyKey: "repository-integration:update-source",
      requestHash: "6".repeat(64),
      definition: initialDefinition,
      occurredAt: new Date(FIXED_TIME),
    });
    const identityBefore = await pool.query<{
      idempotency_key: string;
      request_hash: string;
      created_by: string;
      created_at: Date;
    }>(
      `SELECT idempotency_key, request_hash, created_by, created_at
       FROM inventory.transformation_model_versions WHERE id = $1`,
      [created.modelId],
    );
    const updatedDefinition = transformationModelDefinitionSchema.parse({
      productId: scope.productId,
      buildToPromiseEnabled: false,
      paths: [{
        sourceProductId: scope.productId,
        sourceVariantId: scope.variantIds[0],
        destinationProductId: scope.productId,
        destinationVariantId: scope.variantIds[1],
        inputQty: 5,
        outputQty: 1,
        sourceUnitsPerVariant: 1,
        destinationUnitsPerVariant: 5,
        operationType: "assemble_pack",
        authorityState: "allowed",
        transformationRecipeBindingKey: null,
      }],
      recipeBindings: [],
    });
    const updateCommand = {
      actorId: "integration-test",
      productId: scope.productId,
      draftModelId: created.modelId,
      expectedVersion: created.version,
      expectedDefinitionHash: created.definitionHash,
      expectedHeadRevision: "0",
      changeReason: "Add reviewed EA to P5 authority",
      idempotencyKey: "repository-integration:update-1",
      requestHash: "7".repeat(64),
      definition: updatedDefinition,
      occurredAt: new Date(FIXED_TIME),
    };
    const updated = await store.updateTransformationModelDraft(updateCommand);
    await expect(store.updateTransformationModelDraft(updateCommand)).resolves.toEqual({
      ...updated,
      alreadyApplied: true,
    });
    await expect(store.updateTransformationModelDraft({
      ...updateCommand,
      requestHash: "8".repeat(64),
    })).rejects.toMatchObject({
      status: 409,
      code: "INVENTORY_AVAILABILITY_IDEMPOTENCY_KEY_REUSED",
    });

    const persisted = await pool.query<{
      idempotency_key: string;
      request_hash: string;
      created_by: string;
      created_at: Date;
      revision: string;
      path_count: string;
      command_type: string;
      audit_before_id: number;
      audit_after_id: number;
    }>(
      `SELECT model.idempotency_key, model.request_hash, model.created_by, model.created_at,
              head.revision,
              (SELECT count(*) FROM inventory.transformation_model_paths
               WHERE model_id = model.id) AS path_count,
              receipt.response_body->>'commandType' AS command_type,
              (audit.changes->'before'->>'id')::integer AS audit_before_id,
              (audit.changes->'after'->>'id')::integer AS audit_after_id
       FROM inventory.transformation_model_versions AS model
       JOIN inventory.transformation_model_heads AS head ON head.product_id = model.product_id
       JOIN public.idempotency_keys AS receipt
         ON receipt.key = 'inventory-availability:' || $2
       JOIN public.audit_events AS audit
         ON audit.action = 'inventory_availability.transformation_model.draft_updated'
        AND audit.target = 'inventory.transformation_model:' || model.id::text
       WHERE model.id = $1`,
      [created.modelId, updateCommand.idempotencyKey],
    );
    expect(persisted.rows[0]).toMatchObject({
      ...identityBefore.rows[0],
      revision: "1",
      path_count: "1",
      command_type: "transformation_model_draft_update",
      audit_before_id: created.modelId,
      audit_after_id: created.modelId,
    });

    const staleKey = "repository-integration:update-stale";
    await expect(store.updateTransformationModelDraft({
      ...updateCommand,
      expectedDefinitionHash: updated.definitionHash,
      idempotencyKey: staleKey,
      requestHash: "9".repeat(64),
    })).rejects.toMatchObject({
      status: 409,
      code: "INVENTORY_AVAILABILITY_DRAFT_STALE",
    });
    const staleReceipt = await pool.query<{ count: string }>(
      "SELECT count(*) FROM public.idempotency_keys WHERE key = $1",
      [`inventory-availability:${staleKey}`],
    );
    expect(staleReceipt.rows[0].count).toBe("0");

    await expect(store.createLocationPromisePolicyDraft({
      actorId: "integration-test",
      warehouseLocationId: scope.locationId,
      eligibilityMode: "eligible",
      changeReason: "Cross-command key check",
      idempotencyKey: updateCommand.idempotencyKey,
      requestHash: "a".repeat(64),
      occurredAt: new Date(FIXED_TIME),
    })).rejects.toMatchObject({
      status: 409,
      code: "INVENTORY_AVAILABILITY_IDEMPOTENCY_KEY_REUSED",
    });
  });

  it("updates a promise-safety draft with optimistic locking, replay, and audit", async () => {
    const scope = await seedProductAndWarehouse([1]);
    const testDatabase = drizzle(pool, { schema: databaseSchema });
    const masterDataStore = new PostgresInventoryAvailabilityMasterDataStore(testDatabase);
    const safetyAdminStore = new PostgresInventoryPromiseSafetyAdminStore(testDatabase);
    const created = await masterDataStore.createPromiseSafetyPolicyDraft({
      actorId: "integration-test",
      scope: {
        scopeType: "network_variant",
        productVariantId: scope.variantIds[0],
      },
      value: { policyMode: "fixed_units", fixedUnits: 4 },
      changeReason: "Create editable safety draft",
      idempotencyKey: "repository-integration:safety-update-source",
      requestHash: "b".repeat(64),
      occurredAt: new Date(FIXED_TIME),
    });
    const updateCommand = {
      policyId: created.policyId,
      expectedVersion: created.version,
      expectedDefinitionHash: created.definitionHash,
      expectedHeadRevision: "0",
      value: { policyMode: "days_of_cover" as const,
        daysOfCoverMilliDays: 2_500,
        untrustedDemandFallbackUnits: 3,
        demandMethodVersion: "irreversible_consumption_v1_28d" },
      actorId: "integration-test",
      changeReason: "Use reviewed demand evidence with a fixed fallback",
      idempotencyKey: "repository-integration:safety-update-1",
      requestHash: "c".repeat(64),
      occurredAt: new Date(FIXED_TIME),
    };

    const updated = await safetyAdminStore.updatePromiseSafetyPolicyDraft(updateCommand);
    await expect(safetyAdminStore.updatePromiseSafetyPolicyDraft(updateCommand)).resolves.toEqual({
      ...updated,
      alreadyApplied: true,
    });
    const persisted = await pool.query<{
      policy_mode: string;
      days_of_cover_milli_days: number;
      untrusted_demand_fallback_units: number;
      definition_hash: string;
      revision: string;
      command_type: string;
      audit_after_hash: string;
    }>(
      `SELECT policy.policy_mode, policy.days_of_cover_milli_days,
              policy.untrusted_demand_fallback_units, policy.definition_hash,
              head.revision,
              receipt.response_body->>'commandType' AS command_type,
              audit.changes->'after'->>'definitionHash' AS audit_after_hash
       FROM inventory.promise_safety_policy_versions AS policy
       JOIN inventory.promise_safety_policy_heads AS head ON head.scope_key = policy.scope_key
       JOIN public.idempotency_keys AS receipt
         ON receipt.key = 'inventory-promise-safety-update:' || $2
       JOIN public.audit_events AS audit
         ON audit.action = 'inventory_availability.promise_safety_policy.draft_updated'
        AND audit.target = 'inventory.promise_safety_policy:' || policy.id::text
       WHERE policy.id = $1`,
      [created.policyId, updateCommand.idempotencyKey],
    );
    expect(persisted.rows[0]).toMatchObject({
      policy_mode: "days_of_cover",
      days_of_cover_milli_days: 2_500,
      untrusted_demand_fallback_units: 3,
      definition_hash: updated.definitionHash,
      revision: "1",
      command_type: "promise_safety_policy_draft_update",
      audit_after_hash: updated.definitionHash,
    });

    const staleKey = "repository-integration:safety-update-stale";
    await expect(safetyAdminStore.updatePromiseSafetyPolicyDraft({
      ...updateCommand,
      expectedDefinitionHash: updated.definitionHash,
      idempotencyKey: staleKey,
      requestHash: "d".repeat(64),
    })).rejects.toMatchObject({
      code: "INVENTORY_PROMISE_SAFETY_STALE_DRAFT",
    });
    const staleReceipt = await pool.query<{ count: string }>(
      "SELECT count(*) FROM public.idempotency_keys WHERE key = $1",
      [`inventory-promise-safety-update:${staleKey}`],
    );
    expect(staleReceipt.rows[0].count).toBe("0");

    await expect(masterDataStore.createLocationPromisePolicyDraft({
      actorId: "integration-test",
      warehouseLocationId: scope.locationId,
      eligibilityMode: "eligible",
      changeReason: "Reject a reused safety-update key",
      idempotencyKey: updateCommand.idempotencyKey,
      requestHash: "e".repeat(64),
      occurredAt: new Date(FIXED_TIME),
    })).rejects.toMatchObject({
      code: "INVENTORY_AVAILABILITY_IDEMPOTENCY_KEY_REUSED",
    });
  });

  it("uses reference locks that block catalog lifecycle writers", async () => {
    const scope = await seedProductAndWarehouse();
    const reader = await pool.connect();
    const writer = await pool.connect();
    try {
      await reader.query("BEGIN");
      await reader.query(
        "SELECT id FROM catalog.product_variants WHERE id = $1 FOR SHARE",
        [scope.variantIds[0]],
      );
      await writer.query("BEGIN");
      await writer.query("SET LOCAL statement_timeout = '250ms'");
      await expectDatabaseError(
        () => writer.query(
          "UPDATE catalog.product_variants SET is_active = false WHERE id = $1",
          [scope.variantIds[0]],
        ),
        "statement timeout",
      );
      await writer.query("ROLLBACK");
      await reader.query("COMMIT");
    } finally {
      reader.release();
      writer.release();
    }
  });

  it("keeps active authority and legacy runtime state unchanged while recording a draft", async () => {
    const scope = await seedProductAndWarehouse([1, 5]);
    await pool.query(`
      CREATE TABLE inventory.inventory_levels (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        warehouse_location_id integer NOT NULL,
        product_variant_id integer NOT NULL,
        variant_qty integer NOT NULL DEFAULT 0,
        reserved_qty integer NOT NULL DEFAULT 0,
        picked_qty integer NOT NULL DEFAULT 0,
        packed_qty integer NOT NULL DEFAULT 0,
        backorder_qty integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      DROP SCHEMA IF EXISTS wms CASCADE;
      CREATE SCHEMA wms;
      CREATE TABLE wms.order_build_demands (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        requested_qty integer NOT NULL,
        promised_qty integer NOT NULL,
        status varchar(30) NOT NULL,
        hold_applied boolean NOT NULL,
        hold_reason varchar(200) NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE channels.channel_reservations (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        reserve_base_qty integer NOT NULL,
        override_qty integer,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE channels.channel_allocation_rules (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        mode varchar(10) NOT NULL,
        share_pct integer,
        eligible boolean NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE channels.allocation_audit_log (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        total_atp_base integer NOT NULL,
        allocated_qty integer NOT NULL,
        allocation_method varchar(30) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE channels.channel_sync_log (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        atp_base integer NOT NULL,
        pushed_qty integer NOT NULL,
        status varchar(20) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE channels.sync_log (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        action varchar(30) NOT NULL,
        new_value text,
        status varchar(20) NOT NULL,
        source varchar(20) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    try {
      await pool.query(
        "UPDATE catalog.products SET inventory_strategy = 'recipe_managed' WHERE id = $1",
        [scope.productId],
      );
      await pool.query(
        `INSERT INTO inventory.inventory_levels (
           warehouse_location_id, product_variant_id, variant_qty, reserved_qty,
           picked_qty, packed_qty, backorder_qty
         ) VALUES ($1, $2, 100, 7, 2, 1, 3)`,
        [scope.locationId, scope.variantIds[0]],
      );
      await pool.query(
        `INSERT INTO wms.order_build_demands (
           requested_qty, promised_qty, status, hold_applied, hold_reason
         ) VALUES (9, 8, 'awaiting_build', true, 'recipe_build_required')`,
      );
      await pool.query(
        `INSERT INTO channels.channel_reservations (reserve_base_qty, override_qty)
         VALUES (11, 13);
         INSERT INTO channels.channel_allocation_rules (mode, share_pct, eligible)
         VALUES ('share', 40, true);
         INSERT INTO channels.allocation_audit_log (
           total_atp_base, allocated_qty, allocation_method
         ) VALUES (100, 40, 'percentage');
         INSERT INTO channels.channel_sync_log (atp_base, pushed_qty, status)
         VALUES (100, 40, 'success');
         INSERT INTO channels.sync_log (action, new_value, status, source)
         VALUES ('inventory_push', '40', 'pushed', 'manual');`,
      );

      const activeModelId = await insertDraftModel(scope.productId, "gate1-active");
      await pool.query(
        `INSERT INTO inventory.transformation_model_heads (
           product_id, draft_model_id, updated_by, update_reason
         ) VALUES ($1, $2, 'integration-test', 'create active sentinel')`,
        [scope.productId, activeModelId],
      );
      await markModelValid(activeModelId);
      const activation = await pool.connect();
      try {
        await activation.query("BEGIN");
        await activation.query(
          `UPDATE inventory.transformation_model_versions
           SET lifecycle_status = 'sealed', sealed_by = 'integration-test', sealed_at = $2
           WHERE id = $1`,
          [activeModelId, FIXED_TIME],
        );
        await activation.query(
          `UPDATE inventory.transformation_model_heads
           SET active_model_id = $2, draft_model_id = NULL, revision = revision + 1,
               updated_by = 'integration-test', update_reason = 'activate sentinel'
           WHERE product_id = $1`,
          [scope.productId, activeModelId],
        );
        await activation.query("COMMIT");
      } catch (error) {
        await activation.query("ROLLBACK");
        throw error;
      } finally {
        activation.release();
      }

      const snapshotSql = `SELECT
        (SELECT inventory_strategy FROM catalog.products WHERE id = $1) AS inventory_strategy,
        (SELECT COALESCE(jsonb_agg(to_jsonb(levels) ORDER BY id), '[]'::jsonb)::text
           FROM inventory.inventory_levels AS levels) AS inventory_levels,
        (SELECT COALESCE(jsonb_agg(to_jsonb(demand) ORDER BY id), '[]'::jsonb)::text
           FROM wms.order_build_demands AS demand) AS build_demands,
        (SELECT COALESCE(jsonb_agg(to_jsonb(reserve_row) ORDER BY id), '[]'::jsonb)::text
           FROM channels.channel_reservations AS reserve_row) AS channel_reservations,
        (SELECT COALESCE(jsonb_agg(to_jsonb(rule_row) ORDER BY id), '[]'::jsonb)::text
           FROM channels.channel_allocation_rules AS rule_row) AS allocation_rules,
        (SELECT COALESCE(jsonb_agg(to_jsonb(audit_row) ORDER BY id), '[]'::jsonb)::text
           FROM channels.allocation_audit_log AS audit_row) AS allocation_audits,
        (SELECT COALESCE(jsonb_agg(to_jsonb(sync_row) ORDER BY id), '[]'::jsonb)::text
           FROM channels.channel_sync_log AS sync_row) AS channel_sync_log,
        (SELECT COALESCE(jsonb_agg(to_jsonb(log_row) ORDER BY id), '[]'::jsonb)::text
           FROM channels.sync_log AS log_row) AS sync_log`;
      const before = await pool.query(snapshotSql, [scope.productId]);
      const testDatabase = drizzle(pool, { schema: databaseSchema });
      const store = new PostgresInventoryAvailabilityMasterDataStore(testDatabase);
      const definition = transformationModelDefinitionSchema.parse({
        productId: scope.productId,
        buildToPromiseEnabled: false,
        paths: [],
        recipeBindings: [],
      });
      const created = await store.createTransformationModelDraft({
        actorId: "integration-test",
        changeReason: "Gate 1 runtime isolation",
        idempotencyKey: "repository-integration:gate1-isolation",
        requestHash: "f".repeat(64),
        definition,
        occurredAt: new Date(FIXED_TIME),
      });
      const after = await pool.query(snapshotSql, [scope.productId]);
      expect(after.rows[0]).toEqual(before.rows[0]);

      const head = await pool.query<{
        active_model_id: number;
        draft_model_id: number;
        revision: string;
      }>(
        `SELECT active_model_id, draft_model_id, revision
         FROM inventory.transformation_model_heads WHERE product_id = $1`,
        [scope.productId],
      );
      expect(head.rows[0]).toMatchObject({
        active_model_id: activeModelId,
        draft_model_id: created.modelId,
      });

      await store.updateTransformationModelDraft({
        actorId: "integration-test",
        changeReason: "Gate 1 runtime isolation edit",
        idempotencyKey: "repository-integration:gate1-isolation-edit",
        requestHash: "e".repeat(64),
        productId: scope.productId,
        draftModelId: created.modelId,
        expectedVersion: created.version,
        expectedDefinitionHash: created.definitionHash,
        expectedHeadRevision: String(head.rows[0]!.revision),
        definition,
        occurredAt: new Date(FIXED_TIME),
      });
      const afterEdit = await pool.query(snapshotSql, [scope.productId]);
      expect(afterEdit.rows[0]).toEqual(before.rows[0]);
    } finally {
      await pool.query(`
        DROP TABLE IF EXISTS
          channels.channel_reservations,
          channels.channel_allocation_rules,
          channels.allocation_audit_log,
          channels.channel_sync_log,
          channels.sync_log
      `);
      await pool.query("DROP SCHEMA IF EXISTS wms CASCADE");
      await pool.query("DROP TABLE IF EXISTS inventory.inventory_levels");
    }
  });

  it("installs append-only Phase 2 shadow evidence with column-to-payload guarantees", async () => {
    const scope = await seedProductAndWarehouse([1]);
    const modelId = await insertDraftModel(scope.productId, "phase2-shadow");
    await markModelValid(modelId);
    await pool.query(
      `INSERT INTO inventory.transformation_model_heads (
         product_id, draft_model_id, updated_by, update_reason
       ) VALUES ($1, $2, 'integration-test', 'Phase 2 shadow model')`,
      [scope.productId, modelId],
    );

    const content: SupplySnapshotContentDto = {
      schemaVersion: "inventory_availability_snapshot_v1",
      capturedAt: "2026-08-27T12:00:00.000Z",
      productId: scope.productId,
      legacyInventoryStrategy: "physical_fungible",
      variants: [{
        id: scope.variantIds[0]!,
        productId: scope.productId,
        sku: "INTEGRATION-EA",
        name: "Integration Each",
        unitsPerVariant: 1,
        isActive: true,
      }],
      warehouses: [{
        id: scope.warehouseId,
        code: "INT",
        isActive: true,
        hubWarehouseId: null,
      }],
      locations: [{
        id: scope.locationId,
        warehouseId: scope.warehouseId,
        code: "INT-PICK",
        locationType: "pick",
        isPickable: true,
        isActive: true,
        isFrozen: false,
        promisePolicy: null,
      }],
      inventoryPositions: [],
      safetyPolicies: [{
        policyId: 1,
        version: 1,
        lifecycleSelection: "draft_head",
        scopeKey: "business",
        scopeType: "business",
        productVariantId: null,
        warehouseId: null,
        policyMode: "off",
        fixedUnits: null,
        daysOfCoverMilliDays: null,
        untrustedDemandFallbackUnits: null,
        demandMethodVersion: null,
        definitionHash: HASH,
      }],
      demandEvidence: [],
      transformationModels: [{
        modelId,
        productId: scope.productId,
        version: 1,
        lifecycleSelection: "draft_head",
        lifecycleStatus: "draft",
        buildToPromiseEnabled: false,
        definitionHash: HASH,
        validationState: "valid",
        validationErrors: [],
        paths: [],
        recipeBindings: [],
      }],
      legacyRecipes: [],
      outputLocations: [{
        productVariantId: scope.variantIds[0]!,
        warehouseId: scope.warehouseId,
        warehouseLocationId: scope.locationId,
      }],
      claimProjectionSource: "inventory_levels.reserved_qty",
    };
    const snapshot = sealSupplySnapshot(content);
    const projection = projectCanonicalAtp(snapshot, {
      targetVariantId: scope.variantIds[0]!,
      scope: { kind: "network" },
    });
    expect(projection).toMatchObject({ status: "ready", atpUnits: "0" });

    const run = await pool.query<{ id: string }>(
      `INSERT INTO inventory.planner_shadow_runs (
         product_id, model_id, model_version, model_definition_hash,
         legacy_inventory_strategy, snapshot_fingerprint, snapshot_payload,
         status, blocker_codes, idempotency_key, requested_by, captured_at, completed_at
       ) VALUES ($1, $2, 1, $3, 'physical_fungible', $4, $5::jsonb,
         'completed', '[]'::jsonb, 'integration:shadow:1', 'integration-test', $6, $7)
       RETURNING id`,
      [
        scope.productId,
        modelId,
        HASH,
        snapshot.snapshotFingerprint,
        JSON.stringify(snapshot),
        snapshot.capturedAt,
        "2026-08-27T12:00:01.000Z",
      ],
    );
    await pool.query(
      `INSERT INTO inventory.planner_shadow_results (
         run_id, warehouse_id, product_variant_id, legacy_atp_units,
         proposed_atp_units, difference_units, readiness_state,
         classifications, proposed_projection
       ) VALUES ($1, NULL, $2, 0, 0, 0, 'ready', '["match"]'::jsonb, $3::jsonb)`,
      [run.rows[0]!.id, scope.variantIds[0], JSON.stringify(projection)],
    );

    await expectDatabaseError(
      () => pool.query(
        "UPDATE inventory.planner_shadow_runs SET status = 'blocked' WHERE id = $1",
        [run.rows[0]!.id],
      ),
      "planner shadow evidence is append-only",
    );
    await expectDatabaseError(
      () => pool.query(
        "DELETE FROM inventory.planner_shadow_results WHERE run_id = $1",
        [run.rows[0]!.id],
      ),
      "planner shadow evidence is append-only",
    );

    const invalidRun = await pool.query<{ id: string }>(
      `INSERT INTO inventory.planner_shadow_runs (
         product_id, model_id, model_version, model_definition_hash,
         legacy_inventory_strategy, snapshot_fingerprint, snapshot_payload,
         status, blocker_codes, idempotency_key, requested_by, captured_at, completed_at
       ) VALUES ($1, $2, 1, $3, 'physical_fungible', $4, $5::jsonb,
         'completed', '[]'::jsonb, 'integration:shadow:invalid', 'integration-test', $6, $7)
       RETURNING id`,
      [
        scope.productId,
        modelId,
        HASH,
        snapshot.snapshotFingerprint,
        JSON.stringify(snapshot),
        snapshot.capturedAt,
        "2026-08-27T12:00:01.000Z",
      ],
    );
    await expectDatabaseError(
      () => pool.query(
        `INSERT INTO inventory.planner_shadow_results (
           run_id, warehouse_id, product_variant_id, legacy_atp_units,
           proposed_atp_units, difference_units, readiness_state,
           classifications, proposed_projection
         ) VALUES ($1, NULL, $2, 0, 1, 1, 'ready', '["match"]'::jsonb, $3::jsonb)`,
        [invalidRun.rows[0]!.id, scope.variantIds[0], JSON.stringify(projection)],
      ),
      "planner_shadow_results_evidence_chk",
    );
  });

  it("installs immutable Phase 3 origin and hash-bound review evidence", async () => {
    const scope = await seedProductAndWarehouse([1]);
    const inputHash = "b".repeat(64);
    const resultHash = "c".repeat(64);
    const model = await pool.query<{ id: number }>(
      `INSERT INTO inventory.transformation_model_versions (
         product_id, version, build_to_promise_enabled, definition_hash,
         validation_state, validation_errors, change_reason, idempotency_key,
         request_hash, origin, origin_input_hash, origin_result_hash, created_by
       ) VALUES ($1, 1, false, $2, 'valid', '[]'::jsonb,
         'Phase 3 deterministic draft', 'phase3:model:1', $2,
         'phase3_backfill', $3, $4, 'integration-test')
       RETURNING id`,
      [scope.productId, HASH, inputHash, resultHash],
    );
    await pool.query(
      `INSERT INTO inventory.transformation_model_heads (
         product_id, draft_model_id, updated_by, update_reason
       ) VALUES ($1, $2, 'integration-test', 'Phase 3 review')`,
      [scope.productId, model.rows[0]!.id],
    );

    const invalidScope = await seedProductAndWarehouse([1]);
    await expectDatabaseError(
      () => pool.query(
        `UPDATE inventory.transformation_model_versions
         SET origin_result_hash = $2
         WHERE id = $1`,
        [model.rows[0]!.id, "d".repeat(64)],
      ),
      "transformation model origin evidence is immutable",
    );
    await expectDatabaseError(
      () => pool.query(
        `INSERT INTO inventory.transformation_model_versions (
           product_id, version, build_to_promise_enabled, definition_hash,
           validation_state, validation_errors, change_reason, idempotency_key,
           request_hash, origin, created_by
         ) VALUES ($1, 1, false, $2, 'valid', '[]'::jsonb,
           'Invalid Phase 3 draft', 'phase3:model:invalid', $2,
           'phase3_backfill', 'integration-test')`,
        [invalidScope.productId, HASH],
      ),
      "transformation_model_versions_origin_chk",
    );

    const unheadedModel = await pool.query<{ id: number }>(
      `INSERT INTO inventory.transformation_model_versions (
         product_id, version, build_to_promise_enabled, definition_hash,
         validation_state, validation_errors, change_reason, idempotency_key,
         request_hash, created_by
       ) VALUES ($1, 1, false, $2, 'valid', '[]'::jsonb,
         'Unheaded draft', 'phase3:model:unheaded', $2, 'integration-test')
       RETURNING id`,
      [invalidScope.productId, HASH],
    );
    await expectDatabaseError(
      () => pool.query(
        `INSERT INTO inventory.transformation_model_reviews (
           model_id, product_id, model_version, model_definition_hash,
           decision, reason, reviewed_by, reviewed_at, idempotency_key, request_hash
         ) VALUES ($1, $2, 1, $3, 'approved', 'Not the current draft',
           'integration-test', $4, 'phase3:review:unheaded', $3)`,
        [unheadedModel.rows[0]!.id, invalidScope.productId, HASH, FIXED_TIME],
      ),
      "transformation model review must reference the current draft",
    );

    const wrongDefinitionHash = "e".repeat(64);
    await expectDatabaseError(
      () => pool.query(
        `INSERT INTO inventory.transformation_model_reviews (
           model_id, product_id, model_version, model_definition_hash,
           decision, reason, reviewed_by, reviewed_at, idempotency_key, request_hash
         ) VALUES ($1, $2, 1, $3, 'approved', 'Wrong definition hash',
           'integration-test', $4, 'phase3:review:wrong-hash', $3)`,
        [model.rows[0]!.id, scope.productId, wrongDefinitionHash, FIXED_TIME],
      ),
      "transformation_model_reviews_model_fk",
    );

    const review = await pool.query<{ id: string }>(
      `INSERT INTO inventory.transformation_model_reviews (
         model_id, product_id, model_version, model_definition_hash,
         decision, reason, reviewed_by, reviewed_at, idempotency_key, request_hash
       ) VALUES ($1, $2, 1, $3, 'approved', 'Exact definition verified',
         'integration-test', $4, 'phase3:review:1', $3)
       RETURNING id`,
      [model.rows[0]!.id, scope.productId, HASH, FIXED_TIME],
    );
    await expectDatabaseError(
      () => pool.query(
        "UPDATE inventory.transformation_model_reviews SET reason = 'changed' WHERE id = $1",
        [review.rows[0]!.id],
      ),
      "transformation model review evidence is append-only",
    );
    await expectDatabaseError(
      () => pool.query(
        "DELETE FROM inventory.transformation_model_reviews WHERE id = $1",
        [review.rows[0]!.id],
      ),
      "transformation model review evidence is append-only",
    );
    const secondReview = await pool.query<{ id: string }>(
      `INSERT INTO inventory.transformation_model_reviews (
         model_id, product_id, model_version, model_definition_hash,
         decision, reason, reviewed_by, reviewed_at, idempotency_key, request_hash
       ) VALUES ($1, $2, 1, $3, 'changes_required', 'Later contrary evidence',
         'integration-test', $4, 'phase3:review:2', $3)
       RETURNING id`,
      [model.rows[0]!.id, scope.productId, HASH, "2026-08-26T12:01:00.000Z"],
    );
    expect(BigInt(secondReview.rows[0]!.id)).toBeGreaterThan(BigInt(review.rows[0]!.id));
  });

  it("keeps Phase 4 claim and activation dry-run evidence non-operational and immutable", async () => {
    const requestKey = "integration:claim:1";
    const snapshot = {
      schemaVersion: "inventory_availability_claim_snapshot_v1",
      snapshotFingerprint: HASH,
    };
    const plan = {
      requestKey,
      status: "satisfied",
      snapshotFingerprint: HASH,
    };
    const claimRun = await pool.query<{ id: string }>(
      `INSERT INTO inventory.planner_claim_simulation_runs (
         request_key, request_hash, request_payload, root_product_ids,
         snapshot_fingerprint, snapshot_payload, plan_status, plan_payload,
         blocker_codes, idempotency_key, reason, requested_by,
         operational_write_attempted, captured_at, completed_at
       ) VALUES (
         $1, $2, $3::jsonb, '[10]'::jsonb, $2, $4::jsonb, 'satisfied', $5::jsonb,
         '[]'::jsonb, 'integration:claim:1', 'Synthetic evidence', 'integration-test',
         false, $6, $6
       ) RETURNING id`,
      [
        requestKey,
        HASH,
        JSON.stringify({ requestKey }),
        JSON.stringify(snapshot),
        JSON.stringify(plan),
        FIXED_TIME,
      ],
    );
    await expectDatabaseError(
      () => pool.query(
        "UPDATE inventory.planner_claim_simulation_runs SET reason = 'changed' WHERE id = $1",
        [claimRun.rows[0]!.id],
      ),
      "planner_claim_simulation_runs is append-only",
    );

    const activationRun = await pool.query<{ id: string }>(
      `INSERT INTO inventory.availability_activation_runs (
         mode, scope, state, request_hash, result_hash,
         expected_catalog_input_hash, expected_catalog_result_hash,
         captured_catalog_input_hash, captured_catalog_result_hash,
         evidence_payload, blocker_codes, idempotency_key, reason, requested_by,
         runtime_authority_changed, provider_write_attempted, outbox_enqueued,
         started_at, completed_at
       ) VALUES (
         'dry_run', 'full_catalog', 'ready_for_publication', $1, $1,
         $1, $1, $1, $1, '{}'::jsonb, '[]'::jsonb,
         'integration:activation:1', 'Full catalog dry run', 'integration-test',
         false, false, false, $2, $2
       ) RETURNING id`,
      [HASH, FIXED_TIME],
    );
    await expectDatabaseError(
      () => pool.query(
        "UPDATE inventory.availability_activation_runs SET state = 'blocked' WHERE id = $1",
        [activationRun.rows[0]!.id],
      ),
      "dry-run activation evidence is append-only",
    );
    await expectDatabaseError(
      () => pool.query(
        `INSERT INTO inventory.availability_activation_runs (
           mode, scope, state, request_hash, result_hash,
           expected_catalog_input_hash, expected_catalog_result_hash,
           captured_catalog_input_hash, captured_catalog_result_hash,
           evidence_payload, blocker_codes, idempotency_key, reason, requested_by,
           runtime_authority_changed, provider_write_attempted, outbox_enqueued,
           started_at, completed_at
         ) VALUES (
           'dry_run', 'full_catalog', 'ready_for_publication', $1, $1,
           $1, $1, $1, $1, '{}'::jsonb, '[]'::jsonb,
           'integration:activation:invalid', 'Must remain inactive', 'integration-test',
           false, true, false, $2, $2
         )`,
        [HASH, FIXED_TIME],
      ),
      "availability_activation_runs_dry_run_chk",
    );
  });

  it("enforces monotonic absolute publication revisions and independent provider readback", async () => {
    const scope = await seedProductAndWarehouse([1, 5]);
    const channel = await pool.query<{ id: number }>(
      "INSERT INTO channels.channels (name, provider) VALUES ('Shopify', 'shopify') RETURNING id",
    );
    const connection = await pool.query<{ id: number }>(
      "INSERT INTO channels.channel_connections (channel_id) VALUES ($1) RETURNING id",
      [channel.rows[0]!.id],
    );
    const node = await pool.query<{ id: number }>(
      `INSERT INTO warehouse.fulfillment_nodes (
         code, name, node_type, warehouse_id, inventory_authority,
         fulfillment_authority, created_by
       ) VALUES (
         'PRIMARY', 'Primary warehouse', 'internal_warehouse', $1,
         'echelon', 'echelon', 'integration-test'
       ) RETURNING id`,
      [scope.warehouseId],
    );
    const target = await pool.query<{ id: number }>(
      `INSERT INTO inventory.inventory_publication_targets (
         channel_id, channel_connection_id, fulfillment_node_id,
         provider_scope_type, external_scope_id, publication_authority,
         state, change_reason, created_by, activated_by, activated_at
       ) VALUES (
         $1, $2, $3, 'location', 'shopify-location-1', 'echelon',
         'preview', 'Integration preview', 'integration-test', 'integration-test', $4
       ) RETURNING id`,
      [channel.rows[0]!.id, connection.rows[0]!.id, node.rows[0]!.id, FIXED_TIME],
    );

    const outbox = await pool.query<{ id: string }>(
      `INSERT INTO inventory.inventory_publication_outbox (
         publication_target_id, product_variant_id, desired_revision, desired_quantity,
         channel_connection_id_snapshot, external_scope_id_snapshot,
         external_inventory_item_id_snapshot, idempotency_key, payload_hash, available_at
       ) VALUES ($1, $2, 1, 0, $3, 'shopify-location-1', 'inventory-item-1',
         'publication:1', $4, $5) RETURNING id`,
      [target.rows[0]!.id, scope.variantIds[0], connection.rows[0]!.id, HASH, FIXED_TIME],
    );
    await expectDatabaseError(
      () => pool.query(
        `INSERT INTO inventory.inventory_publication_outbox (
           publication_target_id, product_variant_id, desired_revision, desired_quantity,
           channel_connection_id_snapshot, external_scope_id_snapshot,
           external_inventory_item_id_snapshot, idempotency_key, payload_hash, available_at
         ) VALUES ($1, $2, 1, 2, $3, 'shopify-location-1', 'inventory-item-1',
           'publication:stale', $4, $5)`,
        [target.rows[0]!.id, scope.variantIds[0], connection.rows[0]!.id, HASH, FIXED_TIME],
      ),
      "publication revision must be greater than existing revision 1",
    );

    const standaloneReadback = await pool.query<{ id: string }>(
      `INSERT INTO inventory.inventory_publication_readbacks (
         publication_target_id, product_variant_id, observed_quantity,
         matches_desired, evidence_hash, observed_at
       ) VALUES ($1, $2, 7, NULL, $3, $4) RETURNING id`,
      [target.rows[0]!.id, scope.variantIds[1], HASH, FIXED_TIME],
    );
    expect(standaloneReadback.rows[0]!.id).toBeTruthy();
    await expectDatabaseError(
      () => pool.query(
        `INSERT INTO inventory.inventory_publication_readbacks (
           publication_target_id, product_variant_id,
           external_inventory_item_id_snapshot, observed_quantity,
           matches_desired, evidence_hash, observed_at
         ) VALUES ($1, $2, '   ', 7, NULL, $3, $4::timestamptz + interval '2 seconds')`,
        [target.rows[0]!.id, scope.variantIds[1], HASH, FIXED_TIME],
      ),
      "inventory_publication_readbacks_identity_snapshot_chk",
    );

    const linkedReadback = await pool.query<{ id: string }>(
      `INSERT INTO inventory.inventory_publication_readbacks (
         publication_target_id, product_variant_id, outbox_id, observed_quantity,
         matches_desired, evidence_hash, observed_at
       ) VALUES ($1, $2, $3, 0, true, $4, $5) RETURNING id`,
      [target.rows[0]!.id, scope.variantIds[0], outbox.rows[0]!.id, HASH, FIXED_TIME],
    );
    await expectDatabaseError(
      () => pool.query(
        "UPDATE inventory.inventory_publication_readbacks SET observed_quantity = 1 WHERE id = $1",
        [linkedReadback.rows[0]!.id],
      ),
      "inventory_publication_readbacks is append-only",
    );
    await expectDatabaseError(
      () => pool.query(
        `INSERT INTO inventory.inventory_publication_readbacks (
           publication_target_id, product_variant_id, outbox_id, observed_quantity,
           matches_desired, evidence_hash, observed_at
         ) VALUES ($1, $2, $3, 1, true, $4, $5::timestamptz + interval '1 second')`,
        [target.rows[0]!.id, scope.variantIds[0], outbox.rows[0]!.id, HASH, FIXED_TIME],
      ),
      "readback match flag does not match observed and desired quantities",
    );
  });

  it("enforces draft-head ownership and immutable sealed channel exposure/source definitions", async () => {
    const scope = await seedProductAndWarehouse([1]);
    const channel = await pool.query<{ id: number }>(
      "INSERT INTO channels.channels (name, provider) VALUES ('Exposure channel', 'shopify') RETURNING id",
    );
    const connection = await pool.query<{ id: number }>(
      "INSERT INTO channels.channel_connections (channel_id) VALUES ($1) RETURNING id",
      [channel.rows[0]!.id],
    );
    const node = await pool.query<{ id: number }>(
      `INSERT INTO warehouse.fulfillment_nodes (
         code, name, node_type, warehouse_id, inventory_authority,
         fulfillment_authority, created_by
       ) VALUES ('EXPOSURE', 'Exposure node', 'internal_warehouse', $1,
         'echelon', 'echelon', 'integration-test') RETURNING id`,
      [scope.warehouseId],
    );
    const target = await pool.query<{ id: number }>(
      `INSERT INTO inventory.inventory_publication_targets (
         channel_id, channel_connection_id, fulfillment_node_id,
         provider_scope_type, external_scope_id, publication_authority,
         state, change_reason, created_by
       ) VALUES ($1, $2, $3, 'location', 'exposure-location', 'echelon',
         'disabled', 'Integration exposure target', 'integration-test') RETURNING id`,
      [channel.rows[0]!.id, connection.rows[0]!.id, node.rows[0]!.id],
    );
    const scopeKey = `channel:${channel.rows[0]!.id}`;
    const policy = await pool.query<{ id: number }>(
      `INSERT INTO inventory.channel_exposure_policy_versions (
         scope_key, channel_id, scope_type, version, allocation_semantics,
         eligible, share_bps, holdback_sellable_units, max_publish_mode,
         min_publish_sellable_units, definition_hash, change_reason,
         idempotency_key, request_hash, created_by
       ) VALUES ($1, $2, 'channel', 1, 'exposure', true, 10000, 0,
         'unlimited', 0, $3, 'Integration draft', 'policy:1', $3,
         'integration-test') RETURNING id`,
      [scopeKey, channel.rows[0]!.id, HASH],
    );
    await pool.query(
      `INSERT INTO inventory.channel_exposure_policy_heads (
         scope_key, channel_id, draft_policy_id, revision, updated_by, update_reason
       ) VALUES ($1, $2, $3, 1, 'integration-test', 'Integration draft')`,
      [scopeKey, channel.rows[0]!.id, policy.rows[0]!.id],
    );
    await pool.query(
      "UPDATE inventory.channel_exposure_policy_versions SET share_bps = 7500 WHERE id = $1",
      [policy.rows[0]!.id],
    );
    await expectDatabaseError(
      () => pool.query(
        "UPDATE inventory.channel_exposure_policy_versions SET scope_key = 'channel:999' WHERE id = $1",
        [policy.rows[0]!.id],
      ),
      "channel exposure policy identity and request evidence are immutable",
    );

    const binding = await pool.query<{ id: number }>(
      `INSERT INTO inventory.publication_source_binding_versions (
         publication_target_id, version, definition_hash, change_reason,
         idempotency_key, request_hash, created_by
       ) VALUES ($1, 1, $2, 'Integration source draft', 'source:1', $2,
         'integration-test') RETURNING id`,
      [target.rows[0]!.id, HASH],
    );
    await pool.query(
      `INSERT INTO inventory.publication_source_binding_heads (
         publication_target_id, draft_binding_id, revision, updated_by, update_reason
       ) VALUES ($1, $2, 1, 'integration-test', 'Integration source draft')`,
      [target.rows[0]!.id, binding.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO inventory.publication_source_binding_members (
         binding_id, publication_target_id, fulfillment_node_id, priority
       ) VALUES ($1, $2, $3, 1)`,
      [binding.rows[0]!.id, target.rows[0]!.id, node.rows[0]!.id],
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE inventory.publication_source_binding_versions
         SET lifecycle_status = 'sealed', sealed_by = 'integration-test', sealed_at = $2
         WHERE id = $1`,
        [binding.rows[0]!.id, FIXED_TIME],
      );
      await client.query(
        `UPDATE inventory.publication_source_binding_heads
         SET active_binding_id = draft_binding_id, draft_binding_id = NULL, revision = revision + 1
         WHERE publication_target_id = $1`,
        [target.rows[0]!.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await expectDatabaseError(
      () => pool.query(
        "UPDATE inventory.publication_source_binding_members SET priority = 2 WHERE binding_id = $1",
        [binding.rows[0]!.id],
      ),
      "source binding members may change only on the current draft",
    );
  });

  it("enforces publication-target revisions and append-only exact target/SKU mappings", async () => {
    const scope = await seedProductAndWarehouse([1, 5]);
    const channel = await pool.query<{ id: number }>(
      "INSERT INTO channels.channels (name, provider) VALUES ('Readiness channel', 'shopify') RETURNING id",
    );
    const connection = await pool.query<{ id: number }>(
      "INSERT INTO channels.channel_connections (channel_id) VALUES ($1) RETURNING id",
      [channel.rows[0]!.id],
    );
    const node = await pool.query<{ id: number }>(
      `INSERT INTO warehouse.fulfillment_nodes (
         code, name, node_type, warehouse_id, inventory_authority,
         fulfillment_authority, created_by
       ) VALUES ('READINESS', 'Readiness node', 'internal_warehouse', $1,
         'echelon', 'echelon', 'integration-test') RETURNING id`,
      [scope.warehouseId],
    );
    const target = await pool.query<{ id: number; revision: string }>(
      `INSERT INTO inventory.inventory_publication_targets (
         channel_id, channel_connection_id, fulfillment_node_id,
         provider_scope_type, external_scope_id, publication_authority,
         state, change_reason, created_by
       ) VALUES ($1, $2, $3, 'location', 'readiness-location', 'echelon',
         'disabled', 'Integration readiness target', 'integration-test')
       RETURNING id, revision`,
      [channel.rows[0]!.id, connection.rows[0]!.id, node.rows[0]!.id],
    );
    expect(target.rows[0]!.revision).toBe("1");

    const previewed = await pool.query<{ state: string; revision: string }>(
      `UPDATE inventory.inventory_publication_targets
       SET state = 'preview', activated_by = 'integration-test', activated_at = $2,
           revision = revision + 1
       WHERE id = $1 RETURNING state, revision`,
      [target.rows[0]!.id, FIXED_TIME],
    );
    expect(previewed.rows[0]).toEqual({ state: "preview", revision: "2" });
    await expectDatabaseError(
      () => pool.query(
        "UPDATE inventory.inventory_publication_targets SET state = 'disabled' WHERE id = $1",
        [target.rows[0]!.id],
      ),
      "inventory publication target revision must increment by 1",
    );
    await expectDatabaseError(
      () => pool.query(
        `UPDATE inventory.inventory_publication_targets
         SET external_scope_id = 'changed', revision = revision + 1 WHERE id = $1`,
        [target.rows[0]!.id],
      ),
      "inventory publication target identity and creation evidence are immutable",
    );

    const disabledTarget = await pool.query<{ id: number }>(
      `INSERT INTO inventory.inventory_publication_targets (
         channel_id, channel_connection_id, fulfillment_node_id,
         provider_scope_type, external_scope_id, publication_authority,
         state, change_reason, created_by
       ) VALUES ($1, $2, $3, 'location', 'readiness-location-2', 'echelon',
         'disabled', 'Second readiness target', 'integration-test') RETURNING id`,
      [channel.rows[0]!.id, connection.rows[0]!.id, node.rows[0]!.id],
    );
    await expectDatabaseError(
      () => pool.query(
        `UPDATE inventory.inventory_publication_targets
         SET state = 'live', activated_by = 'integration-test', activated_at = $2,
             revision = revision + 1
         WHERE id = $1`,
        [disabledTarget.rows[0]!.id, FIXED_TIME],
      ),
      "a publication target must be previewed before it becomes live",
    );

    let mappingId: number;
    const mappingClient = await pool.connect();
    try {
      await mappingClient.query("BEGIN");
      const mapping = await mappingClient.query<{ id: number }>(
        `INSERT INTO inventory.publication_variant_mapping_versions (
           publication_target_id, product_variant_id, version,
           external_inventory_item_id, external_sku, definition_hash,
           change_reason, idempotency_key, request_hash, created_by
         ) VALUES ($1, $2, 1, 'inventory-item-1', 'EA', $3,
           'Integration exact mapping', 'mapping:1', $3, 'integration-test') RETURNING id`,
        [target.rows[0]!.id, scope.variantIds[0]!, HASH],
      );
      mappingId = mapping.rows[0]!.id;
      await mappingClient.query(
        `INSERT INTO inventory.publication_variant_mapping_heads (
           publication_target_id, product_variant_id, draft_mapping_id,
           revision, updated_by, update_reason
         ) VALUES ($1, $2, $3, 1, 'integration-test', 'Integration exact mapping')`,
        [target.rows[0]!.id, scope.variantIds[0]!, mappingId],
      );
      await mappingClient.query("COMMIT");
    } catch (error) {
      await mappingClient.query("ROLLBACK");
      throw error;
    } finally {
      mappingClient.release();
    }
    await pool.query(
      `UPDATE inventory.publication_variant_mapping_versions
       SET external_sku = 'EA-UPDATED' WHERE id = $1`,
      [mappingId],
    );

    await expectDatabaseError(async () => {
      const duplicateClient = await pool.connect();
      try {
        await duplicateClient.query("BEGIN");
        const duplicate = await duplicateClient.query<{ id: number }>(
          `INSERT INTO inventory.publication_variant_mapping_versions (
             publication_target_id, product_variant_id, version,
             external_inventory_item_id, external_sku, definition_hash,
             change_reason, idempotency_key, request_hash, created_by
           ) VALUES ($1, $2, 1, 'inventory-item-1', 'P5', $3,
             'Duplicate exact mapping', 'mapping:duplicate', $3, 'integration-test') RETURNING id`,
          [target.rows[0]!.id, scope.variantIds[1]!, HASH],
        );
        await duplicateClient.query(
          `INSERT INTO inventory.publication_variant_mapping_heads (
             publication_target_id, product_variant_id, draft_mapping_id,
             revision, updated_by, update_reason
           ) VALUES ($1, $2, $3, 1, 'integration-test', 'Duplicate exact mapping')`,
          [target.rows[0]!.id, scope.variantIds[1]!, duplicate.rows[0]!.id],
        );
        await duplicateClient.query("COMMIT");
      } catch (error) {
        await duplicateClient.query("ROLLBACK");
        throw error;
      } finally {
        duplicateClient.release();
      }
    }, "one provider inventory item cannot map to multiple SKUs");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE inventory.publication_variant_mapping_versions
         SET lifecycle_status = 'sealed', sealed_by = 'integration-test', sealed_at = $2
         WHERE id = $1`,
        [mappingId, FIXED_TIME],
      );
      await client.query(
        `UPDATE inventory.publication_variant_mapping_heads
         SET active_mapping_id = draft_mapping_id, draft_mapping_id = NULL,
             revision = revision + 1
         WHERE publication_target_id = $1 AND product_variant_id = $2`,
        [target.rows[0]!.id, scope.variantIds[0]!],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await expectDatabaseError(
      () => pool.query(
        "UPDATE inventory.publication_variant_mapping_versions SET external_sku = 'CHANGED' WHERE id = $1",
        [mappingId],
      ),
      "sealed publication variant mapping definition is immutable",
    );
    await expectDatabaseError(
      () => pool.query(
        "DELETE FROM inventory.publication_variant_mapping_versions WHERE id = $1",
        [mappingId],
      ),
      "inventory.publication_variant_mapping_versions is append-only",
    );
  });

  it("creates only disabled targets and saves exact mapping drafts idempotently", async () => {
    const scope = await seedProductAndWarehouse([1, 5]);
    const channel = await pool.query<{ id: number }>(
      "INSERT INTO channels.channels (name, provider) VALUES ('Readiness writer', 'shopify') RETURNING id",
    );
    const connection = await pool.query<{ id: number }>(
      "INSERT INTO channels.channel_connections (channel_id) VALUES ($1) RETURNING id",
      [channel.rows[0]!.id],
    );
    const node = await pool.query<{ id: number }>(
      `INSERT INTO warehouse.fulfillment_nodes (
         code, name, node_type, warehouse_id, inventory_authority,
         fulfillment_authority, created_by
       ) VALUES ('WRITER', 'Readiness writer node', 'internal_warehouse', $1,
         'echelon', 'echelon', 'integration-test') RETURNING id`,
      [scope.warehouseId],
    );
    const testDatabase = drizzle(pool, { schema: databaseSchema });
    const store = new PostgresInventoryChannelExposureAdminStore(testDatabase as never);
    const occurredAt = new Date(FIXED_TIME);
    const targetCommand = {
      channelId: channel.rows[0]!.id,
      channelConnectionId: connection.rows[0]!.id,
      legacyFulfillmentNodeId: node.rows[0]!.id,
      providerScopeType: "location" as const,
      externalScopeId: "writer-location",
      publicationAuthority: "echelon" as const,
      changeReason: "Integration disabled target",
      idempotencyKey: "integration-target-writer-1",
      actorId: "integration-test",
      requestHash: HASH,
      occurredAt,
    };
    const created = await store.createPublicationTarget(targetCommand);
    expect(created).toMatchObject({
      state: "disabled",
      revision: "1",
      alreadyApplied: false,
      runtimeAuthorityChanged: false,
      providerWriteAttempted: false,
      outboxEnqueued: false,
    });
    await expect(store.createPublicationTarget(targetCommand)).resolves.toMatchObject({
      publicationTargetId: created.publicationTargetId,
      state: "disabled",
      alreadyApplied: true,
    });

    const previewed = await store.setPublicationTargetPreviewState({
      publicationTargetId: created.publicationTargetId,
      expectedRevision: "1",
      state: "preview",
      changeReason: "Include exact target in readiness evidence",
      idempotencyKey: "integration-target-preview-1",
      actorId: "integration-test",
      requestHash: "b".repeat(64),
      occurredAt,
    });
    expect(previewed).toMatchObject({ state: "preview", revision: "2" });

    const mappingCommand = {
      publicationTargetId: created.publicationTargetId,
      productVariantId: scope.variantIds[0]!,
      externalInventoryItemId: "inventory-item-writer-1",
      externalSku: "EA",
      expectedHeadRevision: "0",
      expectedDraftMappingId: null,
      expectedDraftDefinitionHash: null,
      changeReason: "Integration exact mapping",
      idempotencyKey: "integration-mapping-writer-1",
      actorId: "integration-test",
      requestHash: "c".repeat(64),
      occurredAt,
    };
    const mapping = await store.saveVariantMappingDraft(mappingCommand);
    expect(mapping).toMatchObject({
      version: 1,
      headRevision: "1",
      alreadyApplied: false,
      runtimeAuthorityChanged: false,
      providerWriteAttempted: false,
    });
    await expect(store.saveVariantMappingDraft(mappingCommand)).resolves.toMatchObject({
      definitionId: mapping.definitionId,
      alreadyApplied: true,
    });
    await expect(store.saveVariantMappingDraft({
      ...mappingCommand,
      productVariantId: scope.variantIds[1]!,
      externalSku: "P5",
      idempotencyKey: "integration-mapping-writer-duplicate",
      requestHash: "d".repeat(64),
    })).rejects.toMatchObject({
      status: 409,
      code: "INVENTORY_PUBLICATION_VARIANT_MAPPING_IDENTITY_CONFLICT",
    });
  });
});
