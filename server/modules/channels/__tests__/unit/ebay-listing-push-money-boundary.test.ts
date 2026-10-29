import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresEbayListingPushRepository } from "../../infrastructure/ebay-listing-push.repository";

function repository(price: unknown, compareAtPrice: unknown) {
  const row = { id: 1, sku: "PACK", catalog_sku: "PACK", name: "Pack", option1_name: null,
    option1_value: null, option2_name: null, option2_value: null, price_cents: price,
    compare_at_price_cents: compareAtPrice, weight_grams: 100, ebay_weight_grams: 100, barcode: null, mpn: null,
    length_mm: null, width_mm: null, height_mm: null, shipping_package_type: null,
    ebay_fulfillment_policy_override: null, ebay_return_policy_override: null, ebay_payment_policy_override: null,
    external_variant_id: null, external_product_id: null, external_sku: null, mapping_exists: false };
  return new PostgresEbayListingPushRepository({ query: async () => ({ rows: [row] }) } as unknown as Pool,
    67, () => new Date("2026-10-19T00:00:00Z"), () => 10);
}

describe("eBay publication PostgreSQL cents boundary", () => {
  it.each([["0", 0], ["1299", 1299], ["9007199254740991", Number.MAX_SAFE_INTEGER], [1299, 1299], [null, null]])(
    "reads exact stored cents %s without changing units", async (input, expected) => {
      expect(await repository(input, input).readVariants(1)).toEqual([expect.objectContaining({ price_cents: expected, compare_at_price_cents: expected })]);
    });
  it.each(["9007199254740992", "9007199254740993", Number.MAX_SAFE_INTEGER + 1, "12.99", "1e3", "-1", -1, 12.99, " 1299 ", "", undefined])(
    "rejects invalid or inexact stored cents %s before producing a listing draft", async input => {
      await expect(repository(input, 1000).readVariants(1)).rejects.toThrow();
      await expect(repository(1000, input).readVariants(1)).rejects.toThrow();
    });
});
