import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readProjectFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
    .replace(/\s+/g, " ")
    .trim();
}

describe("variant UOM migration contract", () => {
  const migration = readProjectFile("migrations/196_catalog_variant_uom_type.sql");
  const integrationFixture = readProjectFile("test/fixtures/named-schema-integration.sql");

  it("adds a required product variant UOM with a backward-compatible default", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS uom_type varchar(20)");
    expect(migration).toContain("ALTER COLUMN uom_type SET DEFAULT 'pack'");
    expect(migration).toContain("ALTER COLUMN uom_type SET NOT NULL");
  });

  it("keeps the disposable integration schema aligned with the production contract", () => {
    expect(integrationFixture).toContain("uom_type varchar(20) NOT NULL DEFAULT 'pack'");
    expect(integrationFixture).toContain("CONSTRAINT product_variants_uom_type_chk");
    expect(integrationFixture).toContain("CONSTRAINT product_variants_each_invariants_chk");
  });
});