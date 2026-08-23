import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations", "206_recipe_derived_atp_demands.sql"),
  "utf8",
);

describe("recipe-derived ATP migration", () => {
  it("persists executable build dependencies", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS inventory.build_order_dependencies");
    expect(migration).toContain("dependent_build_order_id <> prerequisite_build_order_id");
    expect(migration).toContain("UNIQUE (dependent_build_order_id, prerequisite_build_order_id, component_variant_id)");
    expect(migration).toContain("REFERENCES inventory.build_orders(id) ON DELETE RESTRICT");
  });

  it("persists one auditable build promise per WMS order item", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.order_build_demands");
    expect(migration).toContain("CONSTRAINT order_build_demands_order_item_uidx UNIQUE (order_item_id)");
    expect(migration).toContain("CONSTRAINT order_build_demands_root_build_order_uidx UNIQUE (root_build_order_id)");
    expect(migration).toContain("CHECK (status IN ('planning', 'awaiting_build', 'fulfilled', 'cancelled', 'failed'))");
    expect(migration).toContain("CHECK (status = 'planning' OR root_build_order_id IS NOT NULL)");
  });
});
