import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { calculateRecipeDefinitionHash } from "../../domain/inventory-availability-master-data.contracts";
import { PostgresTransformationExecutionAuthorityRepository } from "../../infrastructure/transformation-execution-authority.repository";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const MODEL_HASH = "a".repeat(64);
const BINDING_HASH = calculateRecipeDefinitionHash({
  bindingKey: "fixture-only",
  recipeId: 77,
  relationshipRole: "component_build",
  warehouseId: null,
  recipeCodeSnapshot: "BUILD-EA",
  recipeVersionSnapshot: 3,
  recipeDefinitionHash: "b".repeat(64),
  outputProductIdSnapshot: 10,
  outputVariantIdSnapshot: 101,
  outputUnitsPerVariantSnapshot: 1,
  outputQtySnapshot: 4,
  components: [{
    componentVariantId: 201,
    componentProductId: 20,
    componentUnitsPerVariant: 1,
    componentQty: 2,
  }],
});

const fixtureSql = `
  CREATE SCHEMA inventory;
  CREATE SCHEMA catalog;
  CREATE TABLE inventory.availability_runtime_authority (
    singleton_key boolean PRIMARY KEY, authority text NOT NULL,
    revision bigint NOT NULL, activation_run_id bigint
  );
  CREATE TABLE catalog.product_variants (
    id integer PRIMARY KEY, product_id integer NOT NULL, units_per_variant integer NOT NULL,
      inventory_tracking_override boolean
    );
  CREATE TABLE inventory.transformation_model_versions (
    id integer PRIMARY KEY, product_id integer NOT NULL, version integer NOT NULL,
    lifecycle_status text NOT NULL, validation_state text NOT NULL,
    validation_errors jsonb NOT NULL, definition_hash text NOT NULL
  );
  CREATE TABLE inventory.transformation_model_heads (
    product_id integer PRIMARY KEY, active_model_id integer, revision bigint NOT NULL
  );
  CREATE TABLE inventory.transformation_model_paths (
    id integer PRIMARY KEY, model_id integer NOT NULL,
    source_variant_id integer NOT NULL, destination_variant_id integer NOT NULL,
    input_qty integer NOT NULL, output_qty integer NOT NULL,
    source_units_per_variant integer NOT NULL, destination_units_per_variant integer NOT NULL,
    operation_type text NOT NULL, authority_state text NOT NULL,
    validation_state text NOT NULL, validation_errors jsonb NOT NULL,
    transformation_recipe_binding_id integer
  );
  CREATE TABLE inventory.transformation_recipe_bindings (
    id integer PRIMARY KEY, model_id integer NOT NULL, recipe_id integer NOT NULL,
    relationship_role text NOT NULL, warehouse_id integer,
    recipe_code_snapshot text NOT NULL, recipe_version_snapshot integer NOT NULL,
    recipe_definition_hash text NOT NULL, output_product_id_snapshot integer NOT NULL,
    output_variant_id_snapshot integer NOT NULL, output_units_per_variant_snapshot integer NOT NULL,
    output_qty_snapshot integer NOT NULL, validation_state text NOT NULL,
    validation_errors jsonb NOT NULL
  );
  CREATE TABLE inventory.transformation_recipe_component_snapshots (
    transformation_recipe_binding_id integer NOT NULL, model_id integer NOT NULL,
    component_variant_id integer NOT NULL, component_product_id integer NOT NULL,
    component_units_per_variant integer NOT NULL, component_qty integer NOT NULL
  );
  CREATE TABLE inventory.build_orders (
    id integer PRIMARY KEY, recipe_id integer NOT NULL, recipe_code text NOT NULL,
    recipe_version integer NOT NULL, recipe_type text NOT NULL,
    output_product_id integer NOT NULL, output_variant_id integer NOT NULL,
    output_units_per_variant integer NOT NULL, output_qty_per_build integer NOT NULL,
    warehouse_id integer NOT NULL, transformation_authority text,
    transformation_authority_revision bigint, transformation_activation_run_id bigint,
    transformation_model_head_revision bigint, transformation_model_id integer,
    transformation_model_version integer, transformation_model_definition_hash text,
    transformation_recipe_binding_id integer, transformation_recipe_definition_hash text,
    transformation_authorized_at timestamptz, transformation_authorized_by text
  );
  CREATE TABLE inventory.build_order_components (
    build_order_id integer NOT NULL, component_variant_id integer NOT NULL,
    component_product_id integer NOT NULL, component_units_per_variant integer NOT NULL,
    qty_per_build integer NOT NULL
  );

  INSERT INTO inventory.availability_runtime_authority VALUES (true, 'canonical', 7, 11);
  INSERT INTO catalog.product_variants VALUES
    (101, 10, 1), (105, 10, 5), (125, 10, 25), (201, 20, 1);
  INSERT INTO inventory.transformation_model_versions VALUES
    (501, 10, 2, 'sealed', 'valid', '[]', '${MODEL_HASH}'),
    (502, 10, 3, 'sealed', 'valid', '[]', '${"c".repeat(64)}');
  INSERT INTO inventory.transformation_model_heads VALUES (10, 501, 0);
  INSERT INTO inventory.transformation_model_paths VALUES
    (601, 501, 125, 105, 1, 5, 25, 5, 'break_pack', 'allowed', 'valid', '[]', NULL);
  INSERT INTO inventory.transformation_recipe_bindings VALUES
    (701, 501, 77, 'component_build', NULL, 'BUILD-EA', 3, '${BINDING_HASH}',
     10, 101, 1, 4, 'valid', '[]');
  INSERT INTO inventory.transformation_recipe_component_snapshots VALUES
    (701, 501, 201, 20, 1, 2);
  INSERT INTO inventory.build_orders VALUES
    (801, 77, 'BUILD-EA', 3, 'assembly', 10, 101, 1, 4, 1,
     'canonical', 7, 11, 0, 501, 2, '${MODEL_HASH}', 701, '${BINDING_HASH}',
     '2026-09-13T12:00:00Z', 'operator@example.com'),
    (802, 77, 'BUILD-EA', 3, 'assembly', 10, 101, 1, 4, 1,
     NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    (803, 77, 'BUILD-EA', 3, 'assembly', 10, 101, 1, 4, 1,
     NULL, NULL, NULL, NULL, 501, NULL, NULL, NULL, NULL, NULL, NULL);
  INSERT INTO inventory.build_order_components VALUES
    (801, 201, 20, 1, 2), (802, 201, 20, 1, 2), (803, 201, 20, 1, 2);
`;

describeDatabase.sequential("PostgreSQL transformation execution authority", () => {
  let database: InventoryCutoverTestDatabase;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixtureSql);
  });

  afterAll(async () => {
    await database?.close();
  });

  it("pins the exact active directed path and locks its catalog UOM snapshots", async () => {
    const first = await database.pool.connect();
    const second = await database.pool.connect();
    try {
      await first.query("BEGIN");
      const authority = new PostgresTransformationExecutionAuthorityRepository(drizzle(first) as any);
      const request = {
        productId: 10,
        operation: "break_pack" as const,
        source: { variantId: 125, productId: 10, unitsPerVariant: 25 },
        destination: { variantId: 105, productId: 10, unitsPerVariant: 5 },
      };
      const planned = await authority.authorizePackageConversion(request);
      await authority.pinPackageConversion(drizzle(first) as any, request, planned);

      await second.query("BEGIN");
      await second.query("SET LOCAL lock_timeout = '100ms'");
      await expect(second.query("UPDATE catalog.product_variants SET units_per_variant = 20 WHERE id = 125"))
        .rejects.toMatchObject({ code: "55P03" });
      await second.query("ROLLBACK");
      await first.query("ROLLBACK");
    } finally {
      first.release();
      second.release();
    }
  });

  it("fails a pinned package conversion after active catalog UOM drift", async () => {
    const authority = new PostgresTransformationExecutionAuthorityRepository(drizzle(database.pool) as any);
    const request = {
      productId: 10,
      operation: "break_pack" as const,
      source: { variantId: 125, productId: 10, unitsPerVariant: 25 },
      destination: { variantId: 105, productId: 10, unitsPerVariant: 5 },
    };
    const planned = await authority.authorizePackageConversion(request);
    await database.pool.query("UPDATE catalog.product_variants SET units_per_variant = 20 WHERE id = 125");
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await expect(authority.pinPackageConversion(drizzle(client) as any, request, planned))
        .rejects.toMatchObject({ code: "PACKAGE_CONVERSION_PATH_INVALID" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await database.pool.query("UPDATE catalog.product_variants SET units_per_variant = 25 WHERE id = 125");
    }
  });

  it("validates an exact retained retired build binding after active-head supersession", async () => {
    await database.pool.query("UPDATE inventory.transformation_model_versions SET lifecycle_status = 'retired' WHERE id = 501");
    await database.pool.query("UPDATE inventory.transformation_model_heads SET active_model_id = 502, revision = 1 WHERE product_id = 10");
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const authority = new PostgresTransformationExecutionAuthorityRepository(drizzle(client) as any);
      await expect(authority.validatePinnedBuildOrder(drizzle(client) as any, 801)).resolves.toMatchObject({
        modelId: 501,
        bindingId: 701,
        headRevision: "0",
      });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("fails retained build execution when a component UOM no longer matches its binding", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET units_per_variant = 2 WHERE id = 201");
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const authority = new PostgresTransformationExecutionAuthorityRepository(drizzle(client) as any);
      await expect(authority.validatePinnedBuildOrder(drizzle(client) as any, 801))
        .rejects.toMatchObject({ code: "BUILD_BINDING_INVALID" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("classifies an entirely unpinned pre-cutover build separately from partial evidence", async () => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const authority = new PostgresTransformationExecutionAuthorityRepository(drizzle(client) as any);
      await expect(authority.validatePinnedBuildOrder(drizzle(client) as any, 802))
        .rejects.toMatchObject({ code: "BUILD_CANONICAL_AUTHORIZATION_MISSING" });
      await expect(authority.validatePinnedBuildOrder(drizzle(client) as any, 803))
        .rejects.toMatchObject({ code: "BUILD_AUTHORIZATION_STATE_INVALID" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
