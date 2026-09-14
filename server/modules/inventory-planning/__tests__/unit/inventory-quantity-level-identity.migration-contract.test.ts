import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");

describe("inventory quantity level identity migration contract", () => {
  const migration = source("migrations/0671_inventory_quantity_level_identity.sql");
  const schema = source("shared/schema/inventory.schema.ts");

  it("fails closed on duplicate exact variant/location cells without rewriting inventory", () => {
    expect(migration).toContain("GROUP BY product_variant_id, warehouse_location_id");
    expect(migration).toContain("HAVING COUNT(*) > 1");
    expect(migration).toContain("INVENTORY_LEVEL_IDENTITY_DUPLICATE");
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\s+inventory\.inventory_levels\b/i);
  });

  it("makes the exact level identity migration-owned and keeps Drizzle aligned", () => {
    expect(migration).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_levels_variant_location\n" +
        "  ON inventory.inventory_levels(product_variant_id, warehouse_location_id);",
    );
    expect(schema).toContain('uniqueIndex("idx_inventory_levels_variant_location")');
    expect(schema).toContain(".on(table.productVariantId, table.warehouseLocationId)");
  });
});
