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

  it("keeps the disposable integration schema aligned with transaction linkage", () => {
    expect(namedSchemaIntegrationFixture).toContain("build_order_id integer");
    expect(namedSchemaIntegrationFixture).toContain("build_order_component_id integer");
  });

  it("uses a database sequence for concurrency-safe build numbers", () => {
    expect(migration616).toContain("CREATE SEQUENCE IF NOT EXISTS inventory.build_order_number_seq");
    expect(migration616).toContain("nextval('inventory.build_order_number_seq')");
    expect(migration616).toContain("ALTER COLUMN system_number SET DEFAULT");
  });
});
