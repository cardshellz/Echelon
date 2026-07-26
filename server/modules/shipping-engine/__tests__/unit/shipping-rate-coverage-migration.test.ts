import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "migrations/0598_shipping_rate_coverage_manifest.sql",
  ),
  "utf8",
);

describe("shipping rate coverage migration", () => {
  it("creates named program groups and immutable revision manifests", () => {
    expect(migration).toContain(
      "CREATE TABLE shipping.rate_book_destination_groups",
    );
    expect(migration).toContain(
      "CREATE TABLE shipping.rate_book_destination_group_members",
    );
    expect(migration).toContain(
      "CREATE TABLE shipping.rate_table_coverages",
    );
    expect(migration).toContain(
      "CREATE TABLE shipping.rate_table_coverage_destinations",
    );
    expect(migration).toContain(
      "REFERENCES shipping.rate_tables(id) ON DELETE CASCADE",
    );
    expect(migration).toContain(
      "REFERENCES shipping.rate_book_destination_groups(id) ON DELETE RESTRICT",
    );
  });

  it("constrains explicit availability and optimistic locking", () => {
    expect(migration).toContain(
      "CHECK (availability IN ('offered', 'not_offered'))",
    );
    expect(migration).toContain("CHECK (lock_version > 0)");
    expect(migration).toContain(
      "CHECK (destination_group_lock_version > 0)",
    );
    expect(migration).toContain(
      "COALESCE(origin_warehouse_id, 0)",
    );
    expect(migration).toContain(
      "destination_region IS NOT NULL",
    );
  });
});
