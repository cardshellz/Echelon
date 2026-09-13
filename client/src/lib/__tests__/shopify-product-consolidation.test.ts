import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyShopifyProductConsolidation,
  fetchShopifyProductConsolidationPreview,
  ShopifyProductConsolidationApiError,
} from "../shopify-product-consolidation";

afterEach(() => vi.unstubAllGlobals());

describe("Shopify product consolidation client", () => {
  it("submits the selected canonical product and validates the evidence response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(previewResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchShopifyProductConsolidationPreview({
      channelId: 36,
      shopifyProductId: "9001",
      canonicalProductId: 10,
    });

    expect(result.readOnly).toBe(true);
    expect(result.plan.previewHash).toBe("a".repeat(64));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/channels/36/shopify-mapping-reconciliation/ownership-review/consolidation/preview",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ shopifyProductId: "9001", canonicalProductId: 10 }),
      }),
    );
  });

  it("fails closed on a malformed success response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ readOnly: true })));

    await expect(fetchShopifyProductConsolidationPreview({
      channelId: 36,
      shopifyProductId: "9001",
      canonicalProductId: 10,
    })).rejects.toThrow("Product consolidation preview returned an invalid response");
  });

  it("submits an evidence-bound apply command and validates its receipt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(applyResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      shopifyProductId: "9001",
      canonicalProductId: 10,
      expectedShopDomain: "cardshellz.myshopify.com",
      expectedPreviewHash: "a".repeat(64),
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
      reason: "Consolidate the reviewed product family",
    };

    const result = await applyShopifyProductConsolidation({
      channelId: 36,
      request,
    });

    expect(result).toMatchObject({ commandId: 71, idempotentReplay: false });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/channels/36/shopify-mapping-reconciliation/ownership-review/consolidation/apply",
      expect.objectContaining({ method: "POST", body: JSON.stringify(request) }),
    );
  });

  it("preserves a classified apply error for a stale preview", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: "Evidence changed",
      code: "SHOPIFY_PRODUCT_CONSOLIDATION_PREVIEW_STALE",
    }, 409)));

    await expect(applyShopifyProductConsolidation({
      channelId: 36,
      request: {
        shopifyProductId: "9001",
        canonicalProductId: 10,
        expectedShopDomain: "cardshellz.myshopify.com",
        expectedPreviewHash: "a".repeat(64),
        idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
        reason: "Consolidate the reviewed product family",
      },
    })).rejects.toEqual(expect.objectContaining<ShopifyProductConsolidationApiError>({
      status: 409,
      code: "SHOPIFY_PRODUCT_CONSOLIDATION_PREVIEW_STALE",
    }));
  });
});

function applyResponse() {
  return {
    contractVersion: 1,
    channelId: 36,
    shopDomain: "cardshellz.myshopify.com",
    shopifyProductId: "9001",
    previewHash: "a".repeat(64),
    canonicalProductId: 10,
    sourceProductIds: [11],
    movedVariantIds: [101],
    retiredVariantIds: [102],
    archivedVariantIds: [103],
    updatedParentVariantIds: [],
    archivedProductIds: [11],
    invalidatedDraftModelIds: [201],
    replacementDraftModelIds: [202],
    reparentedLocationCount: 1,
    reparentedAssetCount: 1,
    detachedFeedCount: 2,
    resetListingCount: 2,
    completedAt: "2026-09-12T16:00:00.000Z",
    commandId: 71,
    idempotentReplay: false,
  };
}

function previewResponse() {
  const immutableProductReferences = {
    demand_event_lines: 0,
    purchase_forecast_observations: 0,
    listing_publication_members: 0,
    listing_verification_members: 0,
    channel_exposure_policy_versions: 0,
    transformation_recipe_bindings: 0,
    transformation_recipe_component_snapshots: 0,
  };
  const variant = {
    id: 100,
    productId: 10,
    sku: "SKU-100",
    name: "Pack 100",
    uomType: "pack",
    unitsPerVariant: 100,
    hierarchyLevel: 2,
    parentVariantId: null,
    isBaseUnit: false,
    requiresShipping: true,
    trackInventory: true,
    salesEligibility: "sellable",
    inventoryPolicy: "deny",
    dropshipEligible: false,
    isActive: true,
    shopifyVariantId: "2100",
    feedVariantIds: [],
    listingVariantIds: [],
    onHandQty: "1",
    reservedQty: "0",
    pickedQty: "0",
    packedQty: "0",
    backorderQty: "0",
    activeClaimCount: 0,
    openWorkReferenceCount: 0,
    activeChannelFeedCount: 1,
    runtimeConfigurationReferences: {
      channel_reservations: 0,
      channel_variant_overrides: 0,
      channel_allocation_rules: 0,
      channel_pricing: 0,
      channel_pricing_rules: 0,
      other_channel_feeds: 0,
      other_channel_listings: 0,
      channel_variant_availability_sync: 0,
      dropship_catalog_rules: 0,
      dropship_vendor_selection_rules: 0,
      dropship_vendor_variant_overrides: 0,
      dropship_pricing_policies: 0,
      dropship_ebay_store_category_assignments: 0,
      dropship_ebay_listing_policy_overrides: 0,
      dropship_listing_price_settings: 0,
      dropship_vendor_listings: 0,
      dropship_open_listing_job_items: 0,
      dropship_package_profiles: 0,
      shipping_variant_attrs: 0,
      shipping_product_set_members: 0,
      shipping_rate_rule_members: 0,
      shipping_channel_packing_preferences: 0,
      warehouse_product_locations: 0,
    },
    procurementVendorProductCount: 0,
    buildRecipeReferenceCount: 0,
    nonDraftTransformationReferenceCount: 0,
    immutableProductReferences,
  };
  const product = {
    id: 10,
    sku: "PRODUCT-10",
    name: "Product 10",
    status: "active",
    isActive: true,
    shopifyProductId: "9001",
    shippingGroupCode: "protection",
    inventoryStrategy: "variant_calculated",
    baseUnit: "piece",
    inventoryType: "inventory",
    activeTransformationModelId: null,
    draftTransformationModelId: null,
    activeReplenRuleCount: 0,
    activeReplenTaskCount: 0,
    legacyChannelConfigurationCount: 0,
    activeChannelExposurePolicyCount: 0,
    activeMarketplaceListingScopeCount: 0,
    openWmsWorkReferenceCount: 0,
    activeDropshipConfigurationCount: 0,
    channelPricingRuleCount: 0,
    ebayAspectOverrideCount: 0,
    productLevelProcurementMappingCount: 0,
    variants: [variant],
  };
  return {
    contractVersion: 1,
    generatedAt: "2026-09-12T16:00:00.000Z",
    readOnly: true,
    evidence: {
      channelId: 36,
      shopDomain: "cardshellz.myshopify.com",
      shopifyProductId: "9001",
      remoteProductExists: true,
      remoteProductTitle: "Product 10",
      ownerProductIds: [10],
      canonicalProductId: 10,
      activeCutoverFreezeId: null,
      products: [product],
      remoteVariantProductIds: { "2100": "9001" },
    },
    plan: {
      contractVersion: 1,
      channelId: 36,
      shopDomain: "cardshellz.myshopify.com",
      shopifyProductId: "9001",
      remoteProductTitle: "Product 10",
      canonicalProductId: 10,
      sourceProductIds: [],
      actions: [{
        action: "retain",
        sourceProductId: 10,
        sourceVariantId: 100,
        targetVariantId: 100,
        sku: "SKU-100",
        uomType: "pack",
        unitsPerVariant: 100,
        remoteVariantId: "2100",
      }],
      blockers: [],
      canApply: true,
      previewHash: "a".repeat(64),
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}
