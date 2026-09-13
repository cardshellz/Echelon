import { describe, expect, it, vi } from "vitest";

import {
  createShopifyProductConsolidationService,
} from "../../shopify-product-consolidation.service";
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
});
