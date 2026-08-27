import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE_DB = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeWithDisposableDb = TEST_DB_URL && DISPOSABLE_DB ? describe : describe.skip;
const migrationSql = readFileSync(
  resolve(process.cwd(), "migrations/211_inventory_availability_foundation.sql"),
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
      CREATE SCHEMA catalog;
      CREATE SCHEMA warehouse;
      CREATE SCHEMA inventory;

      CREATE TABLE catalog.products (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY
      );
      CREATE TABLE catalog.product_variants (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
        units_per_variant integer NOT NULL,
        CONSTRAINT product_variants_id_product_uq UNIQUE (id, product_id)
      );
      CREATE TABLE warehouse.warehouses (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY
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

    const migrationClient = await pool.connect();
    try {
      await migrationClient.query("BEGIN");
      await migrationClient.query(migrationSql);
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
        catalog.products,
        warehouse.warehouses
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DROP SCHEMA inventory, warehouse, catalog CASCADE");
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
    expect(tables.rows).toHaveLength(14);
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

  it("makes demand evidence append-only, bigint-safe, and idempotent by input", async () => {
    const scope = await seedProductAndWarehouse();
    const result = await pool.query<{ id: string }>(
      `INSERT INTO inventory.demand_evidence_snapshots (
         product_variant_id, warehouse_id, window_started_at, window_ended_at,
         irreversible_consumption_units, observed_days, daily_demand_milli_units,
         trust_status, trust_reasons, method_version, input_fingerprint, calculated_at
       ) VALUES ($1, $2, '2026-08-01T00:00:00Z', '2026-08-08T00:00:00Z',
         $3::bigint, 7, $4::bigint, 'trusted', '[]'::jsonb,
         'irreversible-demand-v1', $5, '2026-08-08T01:00:00Z') RETURNING id`,
      [
        scope.variantIds[0],
        scope.warehouseId,
        "9007199254740993",
        "1286742750677284714",
        HASH,
      ],
    );
    expect(BigInt(result.rows[0].id)).toBeGreaterThan(0n);
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
         ) VALUES ($1, $2, '2026-08-01T00:00:00Z', '2026-08-08T00:00:00Z',
           1, 7, 1, 'trusted', '[]'::jsonb,
           'irreversible-demand-v1', $3, '2026-08-08T02:00:00Z')`,
        [scope.variantIds[0], scope.warehouseId, HASH],
      ),
      "demand_evidence_snapshots_input_uq",
    );
  });
});
