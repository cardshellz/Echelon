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
    const productLock = source.indexOf("await inventoryPlanning.lockProducts");
    const variantLock = source.indexOf("pg_advisory_xact_lock(918424");
    const tableFenceBeforePlanning = source.indexOf("LOCK TABLE");
    const planningFence = source.indexOf("await inventoryPlanning.fenceDependencies");
    const tableFenceAfterPlanning = source.indexOf("LOCK TABLE", planningFence);
    const lockedEvidence = source.indexOf("const local = await loadLocalEvidence");

    expect(source).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(commandLock).toBeGreaterThan(-1);
    expect(mappingLock).toBeGreaterThan(commandLock);
    expect(productLock).toBeGreaterThan(mappingLock);
    expect(variantLock).toBeGreaterThan(productLock);
    expect(tableFenceBeforePlanning).toBeGreaterThan(variantLock);
    expect(planningFence).toBeGreaterThan(tableFenceBeforePlanning);
    expect(tableFenceAfterPlanning).toBeGreaterThan(planningFence);
    expect(lockedEvidence).toBeGreaterThan(tableFenceAfterPlanning);
  });

  it("fences every runtime dependency used by the locked evidence query", () => {
    const firstFenceStart = source.indexOf("LOCK TABLE");
    const firstFenceEnd = source.indexOf("IN SHARE ROW EXCLUSIVE MODE", firstFenceStart);
    const planningFence = source.indexOf("await inventoryPlanning.fenceDependencies");
    const secondFenceStart = source.indexOf("LOCK TABLE", planningFence);
    const secondFenceEnd = source.indexOf("IN SHARE ROW EXCLUSIVE MODE", secondFenceStart);
    const tableFence = source.slice(firstFenceStart, firstFenceEnd)
      + source.slice(secondFenceStart, secondFenceEnd);

    expect(firstFenceStart).toBeGreaterThan(-1);
    expect(firstFenceEnd).toBeGreaterThan(firstFenceStart);
    expect(secondFenceStart).toBeGreaterThan(planningFence);
    expect(secondFenceEnd).toBeGreaterThan(secondFenceStart);
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

  it("uses the inventory-planning owner instead of reading or writing its tables", () => {
    for (const table of [
      "inventory.transformation_model_heads",
      "inventory.transformation_model_versions",
      "inventory.transformation_model_paths",
      "inventory.transformation_recipe_bindings",
      "inventory.transformation_recipe_component_snapshots",
      "inventory.availability_activation_freezes",
      "inventory.availability_claims",
      "inventory.channel_exposure_policy_heads",
      "inventory.channel_exposure_policy_versions",
      "inventory.inventory_publication_outbox",
    ]) {
      expect(source).not.toContain(table);
    }
    expect(source).toContain("inventoryPlanning.loadEvidence");
    expect(source).toContain("inventoryPlanning.invalidateDrafts");
  });
});
