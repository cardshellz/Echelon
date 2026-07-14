import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/139_shipping_state_zip_pricing.sql"),
  "utf8",
);

describe("state and ZIP pricing migration", () => {
  it("creates a dedicated state-first geography set", () => {
    expect(migration).toContain("retail-us-state-zip");
    expect(migration).toContain("pricingGeography");
    expect(migration).toContain("UPDATE shipping.rate_books");
  });

  it("seeds state pricing areas for every warehouse", () => {
    expect(migration).toContain("CROSS JOIN warehouse.warehouses");
    expect(migration).toContain("'US-' || regions.code");
    expect(migration).toContain("('PA')");
    expect(migration).toContain("('PR')");
  });

  it("prevents two active rules for the same geography", () => {
    expect(migration).toContain("shipping_zone_rules_active_geography_idx");
    expect(migration).toContain("COALESCE(destination_region, '')");
    expect(migration).toContain("WHERE is_active = TRUE");
  });
});
