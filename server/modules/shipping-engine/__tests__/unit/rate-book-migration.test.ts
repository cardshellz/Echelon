import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/137_shipping_rate_books.sql"),
  "utf8",
);

describe("shipping rate-book migration", () => {
  it("creates reusable zone sets, rate books, and deterministic assignments", () => {
    expect(migration).toContain("CREATE TABLE shipping.zone_sets");
    expect(migration).toContain("CREATE TABLE shipping.rate_books");
    expect(migration).toContain("CREATE TABLE shipping.rate_book_assignments");
    expect(migration).toContain("shipping_rate_book_assignment_global_idx");
    expect(migration).toContain("shipping_rate_book_assignment_warehouse_idx");
  });

  it("backfills the existing retail data without importing dropship data", () => {
    expect(migration).toContain("shopify-retail-default");
    expect(migration).toContain("UPDATE shipping.zone_rules");
    expect(migration).toContain("UPDATE shipping.rate_tables");
    expect(migration).not.toMatch(/(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?dropship\./i);
  });

  it("keeps the new references nullable for expand-contract deployment safety", () => {
    expect(migration).toContain("ADD COLUMN zone_set_id INTEGER REFERENCES");
    expect(migration).toContain("ADD COLUMN rate_book_id INTEGER REFERENCES");
    expect(migration).not.toMatch(/ALTER COLUMN (?:zone_set_id|rate_book_id) SET NOT NULL/i);
  });
});

