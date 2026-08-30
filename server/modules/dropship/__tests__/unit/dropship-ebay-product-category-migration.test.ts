import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "migrations/215_dropship_ebay_product_category_scope.sql"),
  "utf8",
);

describe("dropship eBay product-category scope migration", () => {
  it("moves the required marketplace category from store config to canonical product data", () => {
    expect(sql).toContain("WHERE value <> 'categoryId'");
    expect(sql).toContain("required_product_fields || '[\"ebayBrowseCategoryId\"]'::jsonb");
    expect(sql).toContain("WHERE platform = 'ebay'");
  });

  it("creates append-only revisions and one current Store-category assignment per listing target", () => {
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS dropship.dropship_ebay_store_category_assignment_revisions",
    );
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS dropship.dropship_ebay_store_category_assignments",
    );
    expect(sql).toContain("UNIQUE (vendor_id, idempotency_key)");
    expect(sql).toContain("UNIQUE (store_connection_id, product_variant_id)");
    expect(sql).toContain("jsonb_array_length(store_category_ids) BETWEEN 0 AND 2");
    expect(sql).toContain("jsonb_array_length(store_category_ids) BETWEEN 1 AND 2");
  });
});
