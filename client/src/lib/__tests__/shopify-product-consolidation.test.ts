import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchShopifyProductConsolidationPreview } from "../shopify-product-consolidation";

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
});

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
