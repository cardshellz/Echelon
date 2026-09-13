import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(
    process.cwd(),
    "server/modules/catalog/shopify-product-consolidation.repository.ts",
  ),
  "utf8",
);

describe("Shopify product consolidation repository contract", () => {
  it("orders command, mapping, product, and variant locks before evidence", () => {
    const commandLock = source.indexOf("shopify-product-consolidation-command:");
    const mappingLock = source.indexOf("shopify-product-mapping:");
    const productLock = source.indexOf("pg_advisory_xact_lock(918422");
    const variantLock = source.indexOf("pg_advisory_xact_lock(918424");
    const tableFence = source.indexOf("LOCK TABLE");
    const lockedEvidence = source.indexOf("const local = await loadLocalEvidence");

    expect(source).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(commandLock).toBeGreaterThan(-1);
    expect(mappingLock).toBeGreaterThan(commandLock);
    expect(productLock).toBeGreaterThan(mappingLock);
    expect(variantLock).toBeGreaterThan(productLock);
    expect(tableFence).toBeGreaterThan(variantLock);
    expect(lockedEvidence).toBeGreaterThan(tableFence);
  });

  it("fences every runtime dependency used by the locked evidence query", () => {
    const tableFenceStart = source.indexOf("LOCK TABLE");
    const tableFenceEnd = source.indexOf("IN SHARE ROW EXCLUSIVE MODE", tableFenceStart);
    const tableFence = source.slice(tableFenceStart, tableFenceEnd);

    expect(tableFenceStart).toBeGreaterThan(-1);
    expect(tableFenceEnd).toBeGreaterThan(tableFenceStart);
    for (const table of [
      "channels.channel_pricing",
      "channels.channel_pricing_rules",
      "dropship.dropship_catalog_rules",
      "dropship.dropship_vendor_selection_rules",
      "dropship.dropship_vendor_variant_overrides",
      "dropship.dropship_pricing_policies",
      "dropship.dropship_ebay_store_category_assignments",
      "dropship.dropship_ebay_listing_policy_overrides",
      "dropship.dropship_listing_price_settings",
      "dropship.dropship_vendor_listings",
      "dropship.dropship_listing_push_job_items",
      "dropship.dropship_package_profiles",
      "shipping.variant_shipping_attrs",
      "shipping.product_set_members",
      "shipping.rate_rule_members",
      "shipping.channel_packing_preferences",
      "warehouse.product_locations",
      "ebay.ebay_product_aspect_overrides",
      "procurement.vendor_products",
    ]) {
      expect(tableFence).toContain(table);
    }

    for (const evidenceAlias of [
      "other_channel_feed_count",
      "other_channel_listing_count",
      "channel_variant_availability_sync_count",
      "warehouse_product_location_count",
    ]) {
      expect(source).toContain(evidenceAlias);
    }
    expect(source).toContain("canonicalJson(lockedProductIds) !== canonicalJson(preliminaryProductIds)");
    expect(source).toContain("canonicalJson(lockedVariantIds) !== canonicalJson(preliminaryVariantIds)");
  });

  it("never writes quantity rows and verifies an exact before/after snapshot", () => {
    const quantityWrites = source.match(
      /(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+inventory\.inventory_levels/gi,
    ) ?? [];

    expect(quantityWrites).toEqual([]);
    expect(source).toContain("const beforeQuantities = await loadQuantitySnapshot");
    expect(source).toContain("const afterQuantities = await loadQuantitySnapshot");
    expect(source).toContain("SHOPIFY_PRODUCT_CONSOLIDATION_QUANTITY_INVARIANT_FAILED");
    expect(source).toContain("remoteMutationPerformed: false");
    expect(source).toContain("inventoryQuantityMutationPerformed: false");
  });
});
