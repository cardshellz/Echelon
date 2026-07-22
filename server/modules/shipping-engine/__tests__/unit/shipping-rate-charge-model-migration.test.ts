import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/160_shipping_rate_charge_models.sql"),
  "utf8",
);

describe("shipping rate charge model migration", () => {
  it("preserves existing fixed rows through a defaulted charge model", () => {
    expect(migration).toContain("charge_model varchar(40) NOT NULL DEFAULT 'fixed_band'");
    expect(migration).not.toMatch(/TRUNCATE|DELETE FROM shipping\.rate_table/i);
  });

  it("supports one open-ended maximum in the unique row identity", () => {
    expect(migration).toContain("ALTER COLUMN max_measure DROP NOT NULL");
    expect(migration).toContain("COALESCE(max_measure, -1)");
  });

  it("constrains formula rows to base plus non-negative per-pound cents", () => {
    expect(migration).toContain("base_plus_per_started_pound");
    expect(migration).toContain("per_started_pound_cents >= 0");
    expect(migration).toContain("min_measure = 0");
    expect(migration).toContain("max_measure IS NULL");
  });
});
