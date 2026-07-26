import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0597_shipping_military_zone_rules.sql"),
  "utf8",
);

describe("military zone rules migration", () => {
  it("seeds deterministic military zones for every existing warehouse", () => {
    expect(migration).toContain("retail-us-state-zip");
    expect(migration).toContain("CROSS JOIN warehouse.warehouses");
    expect(migration).toContain("'US-' || regions.code");
    expect(migration).toContain("('AA')");
    expect(migration).toContain("('AE')");
    expect(migration).toContain("('AP')");
  });

  it("is safe to retry after a partial or completed migration", () => {
    expect(migration).toContain("ON CONFLICT DO NOTHING");
  });

  it("fails instead of silently recording an incomplete repair", () => {
    expect(migration).toContain("retail-us-state-zip zone set is required");
    expect(migration).toContain("military zone rules were not seeded for every warehouse");
    expect(migration).toContain("RAISE EXCEPTION");
  });
});
