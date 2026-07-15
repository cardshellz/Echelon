import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0588_dropship_vendor_rate_book.sql"),
  "utf8",
);

describe("dropship vendor rate-book migration", () => {
  it("creates an independent active dropship rate book", () => {
    expect(migration).toContain("dropship-vendor-default");
    expect(migration).toContain("Dropship vendor fulfillment");
    expect(migration).toContain("'active'");
    expect(migration).toContain("ON CONFLICT (code) DO NOTHING");
  });

  it("assigns the book to vendor-fulfillment pricing", () => {
    expect(migration).toContain("'dropship'");
    expect(migration).toContain("'vendor_fulfillment_charge'");
    expect(migration).toContain("assignment.is_active = TRUE");
  });

  it("does not touch legacy dropship pricing tables", () => {
    expect(migration).not.toMatch(/(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?dropship\./i);
  });
});
