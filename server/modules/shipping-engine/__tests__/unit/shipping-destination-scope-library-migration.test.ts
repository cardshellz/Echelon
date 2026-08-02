import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0605_shipping_destination_scope_library.sql",
  ),
  "utf8",
);

describe("shipping destination scope library migration", () => {
  it("links pricing groups to canonical scopes with matching snapshots", () => {
    expect(migration).toContain(
      "source_destination_scope_lock_version integer",
    );
    expect(migration).toContain(
      "pricing-scope-' || destination_group.id",
    );
    expect(migration).toContain(
      "shipping_rate_book_destination_group_scope_idx",
    );
    expect(migration).toContain(
      "shipping_rate_book_destination_group_source_version_chk",
    );
  });

  it("freezes canonical scope identity on published rate coverage", () => {
    expect(migration).toContain(
      "ALTER TABLE shipping.rate_table_coverages",
    );
    expect(migration).toContain(
      "coverage.source_destination_scope_id IS NULL",
    );
    expect(migration).toContain(
      "shipping_rate_table_coverage_source_version_chk",
    );
    expect(migration).toContain(
      "shipping_rate_table_coverage_source_idx",
    );
  });

  it("does not modify live rates, assignments, or channel policies", () => {
    expect(migration).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?shipping\.rate_table_rows/i,
    );
    expect(migration).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?shipping\.rate_book_assignments/i,
    );
    expect(migration).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?shipping\.channel_policies/i,
    );
  });
});
