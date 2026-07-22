import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.resolve(process.cwd(), "migrations/0592_shipping_product_policies.sql"),
  "utf8",
);

describe("shipping product policy migration", () => {
  it("creates reusable product sets and immutable per-revision rule membership", () => {
    expect(migration).toContain("CREATE TABLE shipping.product_sets");
    expect(migration).toContain("CREATE TABLE shipping.product_set_members");
    expect(migration).toContain("CREATE TABLE shipping.rate_rules");
    expect(migration).toContain("CREATE TABLE shipping.rate_rule_members");
    expect(migration).toContain("CREATE TABLE shipping.rate_rule_bands");
    expect(migration).toContain("REFERENCES shipping.rate_tables(id) ON DELETE CASCADE");
    expect(migration).toContain("REFERENCES catalog.product_variants(id) ON DELETE RESTRICT");
  });

  it("keeps currency values as integer cents and constrains rule vocabulary", () => {
    expect(migration).toContain("rate_cents bigint");
    expect(migration).toContain("per_started_pound_cents bigint");
    expect(migration).toContain("threshold_cents bigint");
    expect(migration).toContain("'restriction', 'base_charge', 'adjustment', 'threshold'");
    expect(migration).toContain("'order', 'matched_items', 'each_item', 'carton'");
  });
});
