import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../fixtures/inventory-cutover-database";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const MODEL_HASH = "a".repeat(64);
const BINDING_HASH = "b".repeat(64);

const prerequisiteSql = `
  CREATE SCHEMA inventory;
  CREATE TABLE inventory.availability_activation_runs (
    id bigint PRIMARY KEY
  );
  CREATE TABLE inventory.transformation_model_versions (
    id integer PRIMARY KEY,
    product_id integer NOT NULL,
    version integer NOT NULL,
    definition_hash varchar(64) NOT NULL
  );
  CREATE UNIQUE INDEX transformation_model_versions_review_evidence_uq
    ON inventory.transformation_model_versions(id, product_id, version, definition_hash);
  CREATE TABLE inventory.transformation_recipe_bindings (
    id integer PRIMARY KEY,
    model_id integer NOT NULL,
    recipe_id integer NOT NULL,
    recipe_definition_hash varchar(64) NOT NULL
  );
  CREATE UNIQUE INDEX transformation_recipe_bindings_id_model_uq
    ON inventory.transformation_recipe_bindings(id, model_id);
  CREATE TABLE inventory.build_orders (
    id integer PRIMARY KEY,
    recipe_id integer NOT NULL,
    output_product_id integer NOT NULL,
    status varchar(20) NOT NULL
  );
`;

describeDatabase.sequential("build-order transformation authority migration", () => {
  let database: InventoryCutoverTestDatabase;

  beforeAll(async () => {
    const migration = readFileSync(
      resolve(process.cwd(), "migrations/0668_build_order_transformation_authority.sql"),
      "utf8",
    );
    database = await createInventoryCutoverTestDatabase(
      databaseUrl,
      disposable,
      `${prerequisiteSql}\n${migration}`,
    );
    await database.pool.query("INSERT INTO inventory.availability_activation_runs(id) VALUES (7)");
    await database.pool.query(
      `INSERT INTO inventory.transformation_model_versions(id, product_id, version, definition_hash)
       VALUES (11, 20, 3, $1)`,
      [MODEL_HASH],
    );
    await database.pool.query(
      `INSERT INTO inventory.transformation_recipe_bindings(
         id, model_id, recipe_id, recipe_definition_hash
       ) VALUES (13, 11, 17, $1)`,
      [BINDING_HASH],
    );
  });

  afterAll(async () => {
    await database?.close();
  });

  it("accepts legacy-null or complete canonical evidence and permits ordinary lifecycle updates", async () => {
    await database.pool.query(
      "INSERT INTO inventory.build_orders(id, output_product_id, status, recipe_id) VALUES (1, 20, 'draft', 17)",
    );
    await database.pool.query(
      `UPDATE inventory.build_orders
       SET transformation_authority = 'canonical',
           transformation_authority_revision = 5,
           transformation_activation_run_id = 7,
           transformation_model_head_revision = 2,
           transformation_model_id = 11,
           transformation_model_version = 3,
           transformation_model_definition_hash = $1,
           transformation_recipe_binding_id = 13,
           transformation_recipe_definition_hash = $2,
           transformation_authorized_at = '2026-09-13T22:00:00Z',
           transformation_authorized_by = 'operator-1'
       WHERE id = 1`,
      [MODEL_HASH, BINDING_HASH],
    );

    await expect(database.pool.query(
      "UPDATE inventory.build_orders SET status = 'released' WHERE id = 1 RETURNING status",
    )).resolves.toMatchObject({ rows: [{ status: "released" }] });
  });

  it("rejects partial evidence and canonical model or binding tuples without retained evidence", async () => {
    await expect(database.pool.query(
      `INSERT INTO inventory.build_orders(id, recipe_id, output_product_id, status, transformation_authority)
       VALUES (2, 17, 20, 'draft', 'canonical')`,
    )).rejects.toMatchObject({ code: "23514" });

    await expect(database.pool.query(
      `INSERT INTO inventory.build_orders(
         id, recipe_id, output_product_id, status, transformation_authority,
         transformation_authority_revision, transformation_activation_run_id,
         transformation_model_head_revision, transformation_model_id,
         transformation_model_version, transformation_model_definition_hash,
         transformation_recipe_binding_id, transformation_recipe_definition_hash,
         transformation_authorized_at, transformation_authorized_by
       ) VALUES (
         3, 17, 20, 'released', 'canonical', 5, 7, 2, 11, 3, $1,
         13, $2, '2026-09-13T22:00:00Z', 'operator-1'
       )`,
      ["c".repeat(64), BINDING_HASH],
    )).rejects.toMatchObject({ code: "23503" });

    await expect(database.pool.query(
      `INSERT INTO inventory.build_orders(
         id, recipe_id, output_product_id, status, transformation_authority,
         transformation_authority_revision, transformation_activation_run_id,
         transformation_model_head_revision, transformation_model_id,
         transformation_model_version, transformation_model_definition_hash,
         transformation_recipe_binding_id, transformation_recipe_definition_hash,
         transformation_authorized_at, transformation_authorized_by
       ) VALUES (
         4, 17, 20, 'released', 'canonical', 5, 7, 2, 11, 3, $1,
         13, $2, '2026-09-13T22:00:00Z', 'operator-1'
       )`,
      [MODEL_HASH, "d".repeat(64)],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps frozen canonical authority immutable after release", async () => {
    await expect(database.pool.query(
      `UPDATE inventory.build_orders
       SET transformation_recipe_definition_hash = $1
       WHERE id = 1`,
      ["d".repeat(64)],
    )).rejects.toMatchObject({ code: "23514" });
  });
});
