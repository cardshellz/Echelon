import { describe, expect, it, vi } from "vitest";

import {
  createShopifyProductConsolidationService,
} from "../../shopify-product-consolidation.service";
import { shopifyProductConsolidationRequestHash } from "../../shopify-product-consolidation.domain";
import type {
  ShopifyProductConsolidationLocalEvidence,
  ShopifyProductConsolidationRepository,
} from "../../shopify-product-consolidation.repository";
import type {
  ShopifyProductMappingReconciliationRepository,
} from "../../shopify-product-mapping-reconciliation.repository";
import type {
  ShopifyProductMappingVerifier,
} from "../../shopify-product-mapping-verifier";

const credentials = {
  shopDomain: "cardshellz.myshopify.com",
  accessToken: "test-token",
  apiVersion: "2024-01",
};

function variant(id: number, productId: number, unitsPerVariant: number) {
  return {
    id,
    productId,
    sku: `SKU-${id}`,
    name: `Variant ${id}`,
    uomType: "pack",
    unitsPerVariant,
    hierarchyLevel: 2,
    parentVariantId: null,
    isBaseUnit: false,
    requiresShipping: true,
    trackInventory: true,
    salesEligibility: "sellable",
    inventoryPolicy: "deny",
    dropshipEligible: false,
    isActive: true,
    shopifyVariantId: String(2_000 + id),
    feedVariantIds: [] as string[],
    listingVariantIds: [] as string[],
    onHandQty: "0",
    reservedQty: "0",
    pickedQty: "0",
    packedQty: "0",
    backorderQty: "0",
    activeClaimCount: 0,
    openWorkReferenceCount: 0,
    activeChannelFeedCount: 0,
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
    immutableProductReferences: {
      demand_event_lines: 0,
      purchase_forecast_observations: 0,
      listing_publication_members: 0,
      listing_verification_members: 0,
      channel_exposure_policy_versions: 0,
      transformation_recipe_bindings: 0,
      transformation_recipe_component_snapshots: 0,
    },
  };
}

function product(id: number, variants: ReturnType<typeof variant>[]) {
  return {
    id,
    sku: `PRODUCT-${id}`,
    name: `Product ${id}`,
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
    variants,
  };
}

function fixture() {
  const localEvidence: ShopifyProductConsolidationLocalEvidence = {
    channelId: 36,
    shopDomain: credentials.shopDomain,
    shopifyProductId: "9001",
    ownerProductIds: [10, 11],
    canonicalProductId: 10,
    activeCutoverFreezeId: null,
    products: [
      product(10, [variant(100, 10, 1)]),
      product(11, [variant(101, 11, 5)]),
    ],
    externalVariantIds: ["2100", "2101"],
  };
  const repository: ShopifyProductConsolidationRepository = {
    loadLocalEvidence: vi.fn().mockResolvedValue(localEvidence),
    findCommand: vi.fn().mockResolvedValue(null),
    applyConsolidation: vi.fn(),
  };
  const channelContextRepository: Pick<
    ShopifyProductMappingReconciliationRepository,
    "loadChannelContext"
  > = {
    loadChannelContext: vi.fn().mockResolvedValue({
      channel: { id: 36, name: "Shopify", shopDomain: credentials.shopDomain },
      credentials,
    }),
  };
  const verifier: ShopifyProductMappingVerifier = {
    lookupProducts: vi.fn().mockResolvedValue(new Map([["9001", {
      productId: "9001",
      exists: true,
      title: "Easy Glide",
      status: "ACTIVE",
      shippingGroupCode: "protection",
    }]])),
    lookupVariantProductIds: vi.fn().mockResolvedValue(new Map([
      ["2100", "9001"],
      ["2101", "9001"],
    ])),
    verifyProductAndVariants: vi.fn(),
  };
  return { localEvidence, repository, channelContextRepository, verifier };
}

function appliedResult() {
  return {
    contractVersion: 1 as const,
    channelId: 36,
    shopDomain: credentials.shopDomain,
    shopifyProductId: "9001",
    previewHash: "a".repeat(64),
    canonicalProductId: 10,
    sourceProductIds: [11],
    movedVariantIds: [101],
    retiredVariantIds: [],
    archivedVariantIds: [],
    updatedParentVariantIds: [],
    archivedProductIds: [11],
    invalidatedDraftModelIds: [],
    replacementDraftModelIds: [],
    reparentedLocationCount: 1,
    reparentedAssetCount: 0,
    detachedFeedCount: 0,
    resetListingCount: 0,
    completedAt: "2026-09-12T16:00:00.000Z",
  };
}

describe("Shopify product consolidation service", () => {
  it("builds a read-only preview from one local snapshot and live Shopify parent evidence", async () => {
    const dependencies = fixture();
    const service = createShopifyProductConsolidationService({
      ...dependencies,
      clock: () => new Date("2026-09-12T16:00:00.000Z"),
    });

    const result = await service.preview({
      channelId: 36,
      request: { shopifyProductId: "9001", canonicalProductId: 10 },
    });

    expect(result).toMatchObject({
      contractVersion: 1,
      generatedAt: "2026-09-12T16:00:00.000Z",
      readOnly: true,
      plan: {
        shopifyProductId: "9001",
        canonicalProductId: 10,
        sourceProductIds: [11],
        canApply: true,
      },
    });
    expect(dependencies.repository.loadLocalEvidence).toHaveBeenCalledWith({
      channelId: 36,
      shopDomain: credentials.shopDomain,
      shopifyProductId: "9001",
      canonicalProductId: 10,
    });
    expect(dependencies.verifier.lookupVariantProductIds).toHaveBeenCalledWith(
      credentials,
      ["2100", "2101"],
    );
  });

  it("rejects malformed requests before reading credentials or evidence", async () => {
    const dependencies = fixture();
    const service = createShopifyProductConsolidationService(dependencies);

    await expect(service.preview({
      channelId: 36,
      request: { shopifyProductId: "not-an-id", canonicalProductId: 10 },
    })).rejects.toMatchObject({
      code: "INVALID_SHOPIFY_PRODUCT_CONSOLIDATION_REQUEST",
      statusCode: 400,
    });
    expect(dependencies.channelContextRepository.loadChannelContext)
      .not.toHaveBeenCalled();
    expect(dependencies.repository.loadLocalEvidence).not.toHaveBeenCalled();
  });

  it("fails closed when Shopify omits a requested variant-parent result", async () => {
    const dependencies = fixture();
    vi.mocked(dependencies.verifier.lookupVariantProductIds)
      .mockResolvedValueOnce(new Map([["2100", "9001"]]));
    const service = createShopifyProductConsolidationService(dependencies);

    await expect(service.preview({
      channelId: 36,
      request: { shopifyProductId: "9001", canonicalProductId: 10 },
    })).rejects.toMatchObject({
      code: "SHOPIFY_PRODUCT_CONSOLIDATION_REMOTE_EVIDENCE_INCOMPLETE",
      statusCode: 502,
      context: { variantIds: ["2101"] },
    });
  });

  it("reverifies local and Shopify evidence before forwarding an audited apply", async () => {
    const dependencies = fixture();
    vi.mocked(dependencies.repository.applyConsolidation).mockResolvedValue({
      idempotentReplay: false,
      command: {
        id: 44,
        channelId: 36,
        shopifyProductId: "9001",
        canonicalProductId: 10,
        idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
        requestHash: "b".repeat(64),
        previewHash: "a".repeat(64),
        operator: "user:7",
        reason: "Consolidate the reviewed product family",
        result: appliedResult(),
      },
    });
    const service = createShopifyProductConsolidationService({
      ...dependencies,
      clock: () => new Date("2026-09-12T16:00:00.000Z"),
    });
    const request = {
      shopifyProductId: "9001",
      canonicalProductId: 10,
      expectedShopDomain: credentials.shopDomain,
      expectedPreviewHash: "a".repeat(64),
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
      reason: "Consolidate the reviewed product family",
    };

    const result = await service.apply({
      channelId: 36,
      request,
      actor: "user:7",
    });

    expect(result).toMatchObject({
      commandId: 44,
      idempotentReplay: false,
      canonicalProductId: 10,
    });
    expect(dependencies.repository.applyConsolidation).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 36,
        request,
        actor: "user:7",
        remoteProductExists: true,
      }),
    );
  });

  it("returns an exact idempotent replay without reading Shopify again", async () => {
    const dependencies = fixture();
    const reason = "Consolidate the reviewed product family";
    const idempotencyKey = "123e4567-e89b-42d3-a456-426614174001";
    const request = {
      shopifyProductId: "9001",
      canonicalProductId: 10,
      expectedShopDomain: credentials.shopDomain,
      expectedPreviewHash: "a".repeat(64),
      idempotencyKey,
      reason,
    };
    vi.mocked(dependencies.repository.findCommand).mockResolvedValue({
      id: 45,
      channelId: 36,
      shopifyProductId: "9001",
      canonicalProductId: 10,
      idempotencyKey,
      requestHash: shopifyProductConsolidationRequestHash({
        actor: "user:7",
        request,
      }),
      previewHash: "a".repeat(64),
      operator: "user:7",
      reason,
      result: appliedResult(),
    });
    const service = createShopifyProductConsolidationService(dependencies);

    await expect(service.apply({ channelId: 36, request, actor: "user:7" }))
      .resolves.toMatchObject({ commandId: 45, idempotentReplay: true });
    expect(dependencies.channelContextRepository.loadChannelContext)
      .not.toHaveBeenCalled();
    expect(dependencies.verifier.lookupProducts).not.toHaveBeenCalled();
    expect(dependencies.repository.applyConsolidation).not.toHaveBeenCalled();
  });
});
