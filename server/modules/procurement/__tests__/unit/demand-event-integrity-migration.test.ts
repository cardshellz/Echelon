import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "migrations/159_demand_event_integrity.sql"), "utf8");

describe("demand event integrity migration", () => {
  it("aligns the creator identity type and preserves an identity reference", () => {
    expect(migration).toContain("ALTER COLUMN created_by TYPE VARCHAR(100)");
    expect(migration).toContain("FOREIGN KEY (created_by) REFERENCES identity.users(id)");
  });

  it("enforces catalog identity and variant ownership for future writes", () => {
    expect(migration).toContain("FOREIGN KEY (product_id) REFERENCES catalog.products(id)");
    expect(migration).toContain("FOREIGN KEY (product_variant_id) REFERENCES catalog.product_variants(id)");
    expect(migration).toContain("FOREIGN KEY (product_variant_id, product_id)");
    expect(migration).toContain("REFERENCES catalog.product_variants(id, product_id)");
  });

  it("prevents inverted date windows", () => {
    expect(migration).toContain("CHECK (end_date IS NULL OR end_date >= start_date) NOT VALID");
  });
});
