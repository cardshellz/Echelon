import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration615 = fs.readFileSync(
  path.resolve(process.cwd(), "migrations/0615_inventory_build_workflow.sql"),
  "utf8",
);
const migration616 = fs.readFileSync(
  path.resolve(process.cwd(), "migrations/0616_build_order_number_sequence.sql"),
  "utf8",
);
const migration617 = fs.readFileSync(
  path.resolve(process.cwd(), "migrations/0617_inventory_build_conversion_safety.sql"),
  "utf8",
);
const migration618 = fs.readFileSync(
  path.resolve(process.cwd(), "migrations/0618_inventory_build_execution_runs.sql"),
  "utf8",
);
const migration208 = fs.readFileSync(
  path.resolve(process.cwd(), "migrations/208_build_recipe_version_audit.sql"),
  "utf8",
);
const namedSchemaIntegrationFixture = fs.readFileSync(
  path.resolve(process.cwd(), "test/fixtures/named-schema-integration.sql"),
  "utf8",
);

describe("inventory build workflow migrations", () => {
  it("creates versioned recipes and immutable order snapshots", () => {
    expect(migration615).toContain("CREATE TABLE IF NOT EXISTS inventory.build_recipes");
    expect(migration615).toContain("UNIQUE (code, version)");
    expect(migration615).toContain("CREATE UNIQUE INDEX IF NOT EXISTS build_recipes_one_active_version_uidx");
    expect(migration615).toContain("recipe_code varchar(50) NOT NULL");
    expect(migration615).toContain("recipe_version integer NOT NULL");
    expect(migration615).toContain("output_qty_per_build integer NOT NULL");
  });

  it("enforces idempotent build commands and bounded execution states", () => {
    expect(migration615).toContain("idempotency_key varchar(100) NOT NULL UNIQUE");
    expect(migration615).toContain("completed_builds >= 0 AND completed_builds <= planned_builds");
    expect(migration615).toContain("'draft', 'released', 'in_progress', 'completed', 'cancelled', 'failed'");
  });

  it("links inventory evidence to the exact build operation", () => {
    expect(migration615).toContain("ADD COLUMN IF NOT EXISTS build_order_id integer");
    expect(migration615).toContain("ADD COLUMN IF NOT EXISTS build_order_component_id integer");
    expect(migration615).toContain("inventory_transactions_build_order_idx");
    expect(migration615).toContain("inventory_lots_build_order_idx");
  });

  it("classifies build recipes and snapshots product UOM facts", () => {
    expect(migration617).toContain("ADD COLUMN IF NOT EXISTS recipe_type varchar(20)");
    expect(migration617).toContain("ADD COLUMN IF NOT EXISTS output_product_id integer");
    expect(migration617).toContain("ADD COLUMN IF NOT EXISTS output_units_per_variant integer");
    expect(migration617).toContain("ADD COLUMN IF NOT EXISTS component_product_id integer");
    expect(migration617).toContain("ADD COLUMN IF NOT EXISTS component_units_per_variant integer");
    expect(migration617).toContain("WHEN evidence.same_product AND evidence.base_units_conserved THEN 'conversion'");
  });

  it("makes recipe and order snapshot evidence required and bounded", () => {
    expect(migration617).toContain("ALTER COLUMN output_units_per_variant SET NOT NULL");
    expect(migration617).toContain("ALTER COLUMN component_units_per_variant SET NOT NULL");
    expect(migration617).not.toContain("recipe_type SET DEFAULT");
    expect(migration617).toContain("build_recipes_recipe_type_chk");
    expect(migration617).toContain("build_orders_recipe_type_chk");
    expect(migration617).toContain("CHECK (recipe_type IN ('conversion', 'assembly'))");
    expect(migration617).toContain("CHECK (output_product_id > 0 AND output_units_per_variant > 0)");
    expect(migration617).toContain("Cannot enforce build conversion snapshots");
    expect(migration617).toContain("legacy rows have missing or non-positive catalog product/UOM data");
  });
  it("keeps the disposable integration schema aligned with transaction linkage", () => {
    expect(namedSchemaIntegrationFixture).toContain("build_order_id integer");
    expect(namedSchemaIntegrationFixture).toContain("build_order_component_id integer");
    expect(namedSchemaIntegrationFixture).toContain("build_run_id integer");
    expect(namedSchemaIntegrationFixture).toContain("build_reversal_id integer");
  });

  it("uses a database sequence for concurrency-safe build numbers", () => {
    expect(migration616).toContain("CREATE SEQUENCE IF NOT EXISTS inventory.build_order_number_seq");
    expect(migration616).toContain("nextval('inventory.build_order_number_seq')");
    expect(migration616).toContain("ALTER COLUMN system_number SET DEFAULT");
  });

  it("adds idempotent runs, exact reservations, and immutable consumption evidence", () => {
    expect(migration618).toContain("CREATE TABLE IF NOT EXISTS inventory.build_runs");
    expect(migration618).toContain("idempotency_key varchar(100) NOT NULL UNIQUE");
    expect(migration618).toContain("CREATE TABLE IF NOT EXISTS inventory.build_component_reservations");
    expect(migration618).toContain("consumed_qty + released_qty <= reserved_qty");
    expect(migration618).toContain("CREATE TABLE IF NOT EXISTS inventory.build_run_consumptions");
    expect(migration618).toContain("total_unit_cost_mills = po_unit_cost_mills");
  });

  it("links run and compensating reversal evidence into inventory ledgers", () => {
    expect(migration618).toContain("CREATE TABLE IF NOT EXISTS inventory.build_run_reversals");
    expect(migration618).toContain("ADD COLUMN IF NOT EXISTS build_run_id integer");
    expect(migration618).toContain("ADD COLUMN IF NOT EXISTS build_reversal_id integer");
    expect(migration618).toContain("inventory_transactions_build_reversal_idx");
    expect(migration618).toContain("resulting_completed_builds integer NOT NULL");
    expect(migration618).toContain("resulting_order_status varchar(20) NOT NULL");
    expect(migration618).toContain("cancelled_reservation_qty integer");
    expect(migration618).toMatch(/DO \$\$[\s\S]*END\s+\$\$;/);
  });


  it("adds durable evidence and lifecycle constraints for recipe edits", () => {
    expect(migration208).toContain("supersedes_recipe_id integer");
    expect(migration208).toContain("build_recipes_supersedes_recipe_fk");
    expect(migration208).toContain("build_recipes_change_idempotency_uidx");
    expect(migration208).toContain("build_recipes_version_change_evidence_chk");
    expect(migration208).toContain("build_recipes_retirement_evidence_chk");
    expect(migration208).toContain("system:migration:208");
    expect(migration208).toContain("change_request_hash ~ '^[0-9a-f]{64}$'");
  });

});
