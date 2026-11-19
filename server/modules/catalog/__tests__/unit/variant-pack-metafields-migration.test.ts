import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VARIANT_UOM_DEFINITIONS, VARIANT_UOM_TYPES } from "../../../../../shared/catalog/variant-uom";

// Behaviour against a real database (queue on change, delete when unlinked,
// active row first for a shared id) was checked on the shared database in a
// rolled-back transaction; these pin the contract the storefront and the club
// app's outbox worker depend on.
const migrationsDir = resolve(process.cwd(), "migrations");
const migrationFile = readdirSync(migrationsDir).find((name) => name.endsWith("_variant_pack_shopify_metafields.sql"));
const migrationSql = migrationFile ? readFileSync(resolve(migrationsDir, migrationFile), "utf8") : "";

describe("variant pack metafields migration", () => {
  it("exists", () => {
    expect(migrationFile).toBeDefined();
  });

  it("labels every Echelon unit type the way the storefront prints it", () => {
    const labels = new Map(
      [...migrationSql.matchAll(/WHEN '([a-z_]+)' THEN '([^']+)'/g)].map((match) => [match[1], match[2]]),
    );
    expect([...labels.keys()].sort()).toEqual([...VARIANT_UOM_TYPES].sort());
    for (const definition of VARIANT_UOM_DEFINITIONS) {
      // "Box / Inner Pack" reads "Box of 500" on the card; the rest are Echelon's own labels.
      const expected = definition.type === "inner_pack" ? "Box" : definition.label;
      expect(labels.get(definition.type), definition.type).toBe(expected);
    }
  });

  it("writes the club app outbox's row shape and dedupe key for both keys", () => {
    for (const key of ["units_per_variant", "pack_type"]) {
      expect(migrationSql).toContain(`('productvariant', variant_gid, 'cardshellz', '${key}',`);
      expect(migrationSql).toContain(`'productvariant:' || variant_gid || ':cardshellz:${key}'`);
    }
    expect(migrationSql).toContain("variant_gid := 'gid://shopify/ProductVariant/' || target_shopify_variant_id;");
    expect(migrationSql).toContain("ON CONFLICT (dedupe_key) WHERE status = 'pending'");
  });

  it("fires on every change that alters what a Shopify variant should show", () => {
    expect(migrationSql).toMatch(/AFTER INSERT ON catalog\.product_variants/);
    expect(migrationSql).toMatch(
      /AFTER UPDATE OF uom_type, units_per_variant, shopify_variant_id, is_active ON catalog\.product_variants/,
    );
    expect(migrationSql).toMatch(/AFTER DELETE ON catalog\.product_variants/);
    // a moved link recomputes the Shopify variant it left
    expect(migrationSql).toContain("PERFORM catalog.enqueue_variant_pack_metafields(OLD.shopify_variant_id);");
  });

  it("leaves databases without the club app's tables alone, and runs inside the runner's transaction", () => {
    expect(migrationSql).toContain("IF to_regclass('membership.shopify_metafield_outbox') IS NULL THEN");
    expect(migrationSql).toContain("IF to_regclass('membership.shopify_dead_owners') IS NOT NULL THEN");
    expect(migrationSql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/m);
  });
});
