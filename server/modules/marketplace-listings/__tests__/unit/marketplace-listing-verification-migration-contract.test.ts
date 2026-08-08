import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "migrations/0610_marketplace_listing_verification_snapshots.sql"),
  "utf8",
);

describe("marketplace listing verification migration", () => {
  it("creates append-only owner-scoped verification snapshots and normalized members", () => {
    expect(sql).toContain("CREATE TABLE marketplace.listing_verification_snapshots");
    expect(sql).toContain("CREATE TABLE marketplace.listing_verification_members");
    expect(sql).toContain("UNIQUE (scope_id, idempotency_key)");
    expect(sql).toContain("listing_verification_snapshots_scope_account_fk");
    expect(sql).toContain("listing_verification_snapshots_publication_scope_product_fk");
    expect(sql).toContain("listing_verification_members_variant_product_fk");
    expect(sql).toContain("listing_verification_snapshots_immutable");
    expect(sql).toContain("listing_verification_members_immutable");
    expect(sql).toContain("marketplace.reject_registration_history_mutation()");
  });
});