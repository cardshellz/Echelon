import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "migrations/0601_shipping_product_rule_additional_unit.sql",
  ),
  "utf8",
);

describe("shipping product additional-unit migration", () => {
  it("adds a dedicated integer-cent amount and action", () => {
    expect(migration).toContain("ADD COLUMN per_additional_unit_cents bigint");
    expect(migration).toContain("'base_plus_per_additional_unit'");
    expect(migration).toContain("per_additional_unit_cents >= 0");
  });

  it("requires the quantity formula to use combined matching items", () => {
    expect(migration).toContain("shipping_rate_rule_additional_unit_chk");
    expect(migration).toContain(
      "action = 'base_plus_per_additional_unit'",
    );
    expect(migration).toContain("rate_cents IS NOT NULL");
    expect(migration).toContain("per_additional_unit_cents IS NOT NULL");
    expect(migration).toContain("measurement_scope = 'matched_items'");
    expect(migration).toContain("per_started_pound_cents IS NULL");
    expect(migration).toContain("threshold_cents IS NULL");
  });
});
