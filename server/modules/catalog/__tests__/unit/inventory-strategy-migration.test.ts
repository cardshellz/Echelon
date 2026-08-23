import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("catalog product inventory strategy migration", () => {
  const readSqlArtifact = (relativePath: string) => readFileSync(
    resolve(process.cwd(), relativePath),
    "utf8",
  );
  const migration = readSqlArtifact("migrations/205_catalog_product_inventory_strategy.sql");
  const integrationFixture = readSqlArtifact("test/fixtures/named-schema-integration.sql");

  it("defaults existing products to the legacy fungible package hierarchy", () => {
    expect(migration).toContain("SET inventory_strategy = 'physical_fungible'");
    expect(migration).toContain("ALTER COLUMN inventory_strategy SET DEFAULT 'physical_fungible'");
    expect(migration).toContain("ALTER COLUMN inventory_strategy SET NOT NULL");
  });

  it("moves existing recipe output products to recipe-managed inventory", () => {
    expect(migration).toContain("FROM inventory.build_recipes br");
    expect(migration).toContain("br.output_product_id = p.id");
    expect(migration).toContain("SET inventory_strategy = 'recipe_managed'");
  });

  it("constrains stored strategy values", () => {
    expect(migration).toContain("products_inventory_strategy_chk");
    expect(migration).toContain("'physical_only'");
  });

  it("keeps the disposable integration schema aligned with the product contract", () => {
    expect(integrationFixture).toContain(
      "inventory_strategy varchar(30) NOT NULL DEFAULT 'physical_fungible'",
    );
  });
});
