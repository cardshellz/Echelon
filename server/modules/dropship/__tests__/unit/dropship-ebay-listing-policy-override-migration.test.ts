import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "migrations/217_dropship_ebay_listing_policy_overrides.sql"),
  "utf8",
);

describe("dropship eBay listing policy override migration", () => {
  it("creates an immutable revision ledger and one current store-variant assignment", () => {
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS dropship.dropship_ebay_listing_policy_override_revisions",
    );
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS dropship.dropship_ebay_listing_policy_overrides",
    );
    expect(sql).toContain("UNIQUE (vendor_id, idempotency_key)");
    expect(sql).toContain("UNIQUE (store_connection_id, product_variant_id)");
    expect(sql).toContain("fulfillment_policy_id IS NOT NULL");
    expect(sql).toContain("return_policy_id IS NOT NULL");
    expect(sql).toContain("payment_policy_id IS NOT NULL");
  });
});
