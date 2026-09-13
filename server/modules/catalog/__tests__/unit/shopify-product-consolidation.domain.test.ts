import { describe, expect, it } from "vitest";

import {
  buildShopifyProductConsolidationPlan,
  shopifyProductConsolidationApplyRequestSchema,
  type ShopifyProductConsolidationEvidence,
  type ShopifyProductConsolidationProductEvidence,
  type ShopifyProductConsolidationVariantEvidence,
} from "../../shopify-product-consolidation.domain";

const emptyRuntimeConfigurationReferences = {
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
} as const;

function variant(
  input: Partial<ShopifyProductConsolidationVariantEvidence>
    & Pick<ShopifyProductConsolidationVariantEvidence, "id" | "productId" | "unitsPerVariant">,
): ShopifyProductConsolidationVariantEvidence {
  return {
    id: input.id,
    productId: input.productId,
    sku: input.sku ?? `SKU-${input.id}`,
    name: input.name ?? `Variant ${input.id}`,
    uomType: input.uomType ?? "pack",
    unitsPerVariant: input.unitsPerVariant,
    hierarchyLevel: input.hierarchyLevel ?? 2,
    parentVariantId: input.parentVariantId ?? null,
    isBaseUnit: input.isBaseUnit ?? false,
    requiresShipping: input.requiresShipping ?? true,
    trackInventory: input.trackInventory ?? true,
    salesEligibility: input.salesEligibility ?? "sellable",
    inventoryPolicy: input.inventoryPolicy ?? "deny",
    dropshipEligible: input.dropshipEligible ?? false,
    isActive: input.isActive ?? true,
    shopifyVariantId: input.shopifyVariantId ?? null,
    feedVariantIds: input.feedVariantIds ?? [],
    listingVariantIds: input.listingVariantIds ?? [],
    onHandQty: input.onHandQty ?? "0",
    reservedQty: input.reservedQty ?? "0",
    pickedQty: input.pickedQty ?? "0",
    packedQty: input.packedQty ?? "0",
    backorderQty: input.backorderQty ?? "0",
    activeClaimCount: input.activeClaimCount ?? 0,
    openWorkReferenceCount: input.openWorkReferenceCount ?? 0,
    activeChannelFeedCount: input.activeChannelFeedCount ?? 0,
    runtimeConfigurationReferences:
      input.runtimeConfigurationReferences ?? emptyRuntimeConfigurationReferences,
    procurementVendorProductCount: input.procurementVendorProductCount ?? 0,
    buildRecipeReferenceCount: input.buildRecipeReferenceCount ?? 0,
    nonDraftTransformationReferenceCount:
      input.nonDraftTransformationReferenceCount ?? 0,
    immutableProductReferences: input.immutableProductReferences ?? {
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

function product(
  input: Partial<ShopifyProductConsolidationProductEvidence>
    & Pick<ShopifyProductConsolidationProductEvidence, "id" | "variants">,
): ShopifyProductConsolidationProductEvidence {
  return {
    id: input.id,
    sku: input.sku ?? `PRODUCT-${input.id}`,
    name: input.name ?? `Product ${input.id}`,
    status: input.status ?? "active",
    isActive: input.isActive ?? true,
    shopifyProductId: input.shopifyProductId ?? "7117934559391",
    shippingGroupCode: input.shippingGroupCode ?? "protection",
    inventoryStrategy: input.inventoryStrategy ?? "variant_calculated",
    baseUnit: input.baseUnit ?? "piece",
    inventoryType: input.inventoryType ?? "inventory",
    activeTransformationModelId: input.activeTransformationModelId ?? null,
    draftTransformationModelId: input.draftTransformationModelId ?? null,
    activeReplenRuleCount: input.activeReplenRuleCount ?? 0,
    activeReplenTaskCount: input.activeReplenTaskCount ?? 0,
    legacyChannelConfigurationCount:
      input.legacyChannelConfigurationCount ?? 0,
    activeChannelExposurePolicyCount:
      input.activeChannelExposurePolicyCount ?? 0,
    activeMarketplaceListingScopeCount:
      input.activeMarketplaceListingScopeCount ?? 0,
    openWmsWorkReferenceCount: input.openWmsWorkReferenceCount ?? 0,
    activeDropshipConfigurationCount:
      input.activeDropshipConfigurationCount ?? 0,
    channelPricingRuleCount: input.channelPricingRuleCount ?? 0,
    ebayAspectOverrideCount: input.ebayAspectOverrideCount ?? 0,
    productLevelProcurementMappingCount:
      input.productLevelProcurementMappingCount ?? 0,
    variants: input.variants,
  };
}

function easyGlideEvidence(): ShopifyProductConsolidationEvidence {
  return {
    channelId: 1,
    shopDomain: "cardshellz.myshopify.com",
    shopifyProductId: "7117934559391",
    remoteProductExists: true,
    remoteProductTitle: "Easy Glide Soft Sleeves Standard",
    ownerProductIds: [39, 103],
    canonicalProductId: 103,
    activeCutoverFreezeId: null,
    products: [
      product({
        id: 39,
        sku: "EG-SLV-STD",
        variants: [
          variant({
            id: 78,
            productId: 39,
            unitsPerVariant: 100,
            sku: "EG-SLV-STD-P100",
            shopifyVariantId: "501",
            onHandQty: "1",
            reservedQty: "1",
            pickedQty: "5",
          }),
          variant({
            id: 79,
            productId: 39,
            unitsPerVariant: 500,
            sku: "EG-SLV-STD-B500",
            isActive: false,
          }),
          variant({
            id: 80,
            productId: 39,
            unitsPerVariant: 10_000,
            sku: "EG-SLV-STD-C10000",
            shopifyVariantId: "999",
          }),
        ],
      }),
      product({
        id: 103,
        sku: "EG-SLV-STD-5PCK",
        variants: [
          variant({
            id: 207,
            productId: 103,
            unitsPerVariant: 10_000,
            sku: "EG-SLV-STD-5PCK-C10000",
            shopifyVariantId: "503",
            onHandQty: "2",
          }),
          variant({
            id: 265,
            productId: 103,
            unitsPerVariant: 500,
            sku: "EG-SLV-STD-5PCK-B500",
            shopifyVariantId: "502",
            onHandQty: "6",
          }),
        ],
      }),
    ],
    remoteVariantProductIds: {
      "501": "7117934559391",
      "502": "7117934559391",
      "503": "7117934559391",
      "999": null,
    },
  };
}

describe("Shopify product consolidation planning", () => {
  it("keeps exact inventory identities while moving the unique package and retiring only the empty duplicate", () => {
    const plan = buildShopifyProductConsolidationPlan(easyGlideEvidence());

    expect(plan.canApply).toBe(true);
    expect(plan.sourceProductIds).toEqual([39]);
    expect(plan.actions).toEqual([
      expect.objectContaining({ action: "move", sourceVariantId: 78, targetVariantId: 78, remoteVariantId: "501" }),
      expect.objectContaining({ action: "archive_inactive", sourceVariantId: 79, targetVariantId: 79 }),
      expect.objectContaining({ action: "retire_duplicate", sourceVariantId: 80, targetVariantId: 207 }),
      expect.objectContaining({ action: "retain", sourceVariantId: 207, targetVariantId: 207, remoteVariantId: "503" }),
      expect.objectContaining({ action: "retain", sourceVariantId: 265, targetVariantId: 265, remoteVariantId: "502" }),
    ]);
    expect(plan.blockers).toEqual([]);
  });

  it("does not treat reservations and picks on a reparented survivor as inventory to move", () => {
    const plan = buildShopifyProductConsolidationPlan(easyGlideEvidence());
    const move = plan.actions.find((action) => action.sourceVariantId === 78);

    expect(move?.action).toBe("move");
    expect(plan.blockers.some((item) => item.variantId === 78)).toBe(false);
  });

  it("blocks retirement when the duplicate still owns physical or operational quantity", () => {
    const evidence = easyGlideEvidence();
    const source = evidence.products[0];
    const changed: ShopifyProductConsolidationEvidence = {
      ...evidence,
      products: [
        { ...source, variants: source.variants.map((item) => item.id === 80
          ? { ...item, onHandQty: "2", pickedQty: "1" }
          : item) },
        evidence.products[1],
      ],
    };

    const plan = buildShopifyProductConsolidationPlan(changed);

    expect(plan.canApply).toBe(false);
    expect(plan.blockers.map((item) => item.code)).toEqual(expect.arrayContaining([
      "duplicate_variant_has_inventory",
      "duplicate_variant_has_encumbrance",
    ]));
  });

  it("blocks retirement while a duplicate still owns channel runtime configuration", () => {
    const evidence = easyGlideEvidence();
    const source = evidence.products[0];
    const changed: ShopifyProductConsolidationEvidence = {
      ...evidence,
      products: [
        { ...source, variants: source.variants.map((item) => item.id === 80
          ? {
              ...item,
              runtimeConfigurationReferences: {
                ...item.runtimeConfigurationReferences,
                channel_pricing: 1,
              },
            }
          : item) },
        evidence.products[1],
      ],
    };

    const plan = buildShopifyProductConsolidationPlan(changed);

    expect(plan.canApply).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "duplicate_variant_has_runtime_configuration",
      variantId: 80,
      context: { references: { channel_pricing: 1 } },
    }));
  });

  it("blocks retirement while a duplicate still owns a warehouse slot", () => {
    const evidence = easyGlideEvidence();
    const source = evidence.products[0];
    const changed: ShopifyProductConsolidationEvidence = {
      ...evidence,
      products: [
        { ...source, variants: source.variants.map((item) => item.id === 80
          ? {
              ...item,
              runtimeConfigurationReferences: {
                ...item.runtimeConfigurationReferences,
                warehouse_product_locations: 1,
              },
            }
          : item) },
        evidence.products[1],
      ],
    };

    const plan = buildShopifyProductConsolidationPlan(changed);

    expect(plan.canApply).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "duplicate_variant_has_runtime_configuration",
      variantId: 80,
      context: { references: { warehouse_product_locations: 1 } },
    }));
  });

  it("blocks a variant identity that belongs to a different live Shopify product", () => {
    const evidence = easyGlideEvidence();
    const changed: ShopifyProductConsolidationEvidence = {
      ...evidence,
      remoteVariantProductIds: {
        ...evidence.remoteVariantProductIds,
        "999": "7884029231140",
      },
    };

    const plan = buildShopifyProductConsolidationPlan(changed);

    expect(plan.canApply).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "variant_remote_mapping_outside_consolidation",
      productId: 39,
      variantId: 80,
      context: {
        reviewedShopifyProductId: "7117934559391",
        remoteMappings: { "999": "7884029231140" },
      },
    }));
  });

  it("blocks incompatible inventory semantics and procurement mappings", () => {
    const evidence = easyGlideEvidence();
    const source = evidence.products[0];
    const changed: ShopifyProductConsolidationEvidence = {
      ...evidence,
      products: [
        {
          ...source,
          variants: source.variants.map((item) => item.id === 80
            ? {
                ...item,
                inventoryPolicy: "continue",
                procurementVendorProductCount: 1,
              }
            : item),
        },
        evidence.products[1],
      ],
    };

    const plan = buildShopifyProductConsolidationPlan(changed);

    expect(plan.canApply).toBe(false);
    expect(plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "variant_definition_mismatch", variantId: 80 }),
      expect.objectContaining({ code: "variant_has_procurement_mapping", variantId: 80 }),
    ]));
  });

  it("blocks a reparent when immutable evidence still binds the variant to its original product", () => {
    const evidence = easyGlideEvidence();
    const source = evidence.products[0];
    const changed: ShopifyProductConsolidationEvidence = {
      ...evidence,
      products: [
        { ...source, variants: source.variants.map((item) => item.id === 78
          ? {
              ...item,
              immutableProductReferences: {
                ...item.immutableProductReferences,
                purchase_forecast_observations: 3,
              },
            }
          : item) },
        evidence.products[1],
      ],
    };

    const plan = buildShopifyProductConsolidationPlan(changed);

    expect(plan.canApply).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "variant_has_immutable_product_history",
      variantId: 78,
      context: { references: { purchase_forecast_observations: 3 } },
    }));
  });

  it("blocks a reparent when procurement still binds the retained variant to its source product", () => {
    const evidence = easyGlideEvidence();
    const source = evidence.products[0];
    const changed: ShopifyProductConsolidationEvidence = {
      ...evidence,
      products: [
        {
          ...source,
          variants: source.variants.map((item) => item.id === 78
            ? { ...item, procurementVendorProductCount: 2 }
            : item),
        },
        evidence.products[1],
      ],
    };

    const plan = buildShopifyProductConsolidationPlan(changed);

    expect(plan.canApply).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "variant_has_procurement_mapping",
      productId: 39,
      variantId: 78,
      context: { procurementVendorProductCount: 2 },
    }));
  });

  it("blocks source product archival while direct WMS work is still open", () => {
    const evidence = easyGlideEvidence();
    const changed: ShopifyProductConsolidationEvidence = {
      ...evidence,
      products: evidence.products.map((item) => item.id === 39
        ? { ...item, openWmsWorkReferenceCount: 1 }
        : item),
    };

    const plan = buildShopifyProductConsolidationPlan(changed);

    expect(plan.canApply).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "source_runtime_configuration",
      productId: 39,
      context: { references: { open_wms_work: 1 } },
    }));
  });

  it("blocks catalog mutation while either owner has an active transformation model", () => {
    const evidence = easyGlideEvidence();
    const changed: ShopifyProductConsolidationEvidence = {
      ...evidence,
      products: evidence.products.map((item) => item.id === 103
        ? { ...item, activeTransformationModelId: 285 }
        : item),
    };

    const plan = buildShopifyProductConsolidationPlan(changed);

    expect(plan.canApply).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "active_transformation_model",
      productId: 103,
    }));
  });

  it("blocks a stale review after duplicate ownership has already been resolved", () => {
    const evidence = easyGlideEvidence();
    const changed: ShopifyProductConsolidationEvidence = {
      ...evidence,
      ownerProductIds: [103],
      products: [evidence.products[1]],
    };

    const plan = buildShopifyProductConsolidationPlan(changed);

    expect(plan.canApply).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "duplicate_ownership_not_present",
      context: { ownerProductIds: [103] },
    }));
  });

  it("binds ordering and all evidence into a deterministic preview hash", () => {
    const evidence = easyGlideEvidence();
    const reordered: ShopifyProductConsolidationEvidence = {
      ...evidence,
      ownerProductIds: [...evidence.ownerProductIds].reverse(),
      products: [...evidence.products].reverse().map((item) => ({
        ...item,
        variants: [...item.variants].reverse(),
      })),
    };

    expect(buildShopifyProductConsolidationPlan(evidence).previewHash)
      .toBe(buildShopifyProductConsolidationPlan(reordered).previewHash);
  });

  it("requires a UUID, reviewed hash, store, actor reason, and exact product choice for apply", () => {
    expect(shopifyProductConsolidationApplyRequestSchema.safeParse({
      shopifyProductId: "7117934559391",
      canonicalProductId: 103,
      expectedShopDomain: "cardshellz.myshopify.com",
      expectedPreviewHash: "a".repeat(64),
      idempotencyKey: "8cb98793-a694-4d33-ab1e-841e577ba008",
      reason: "Consolidate the reviewed Easy Glide package family",
    }).success).toBe(true);
    expect(shopifyProductConsolidationApplyRequestSchema.safeParse({
      shopifyProductId: "7117934559391",
      canonicalProductId: 103,
      expectedShopDomain: "cardshellz.myshopify.com",
      expectedPreviewHash: "a".repeat(64),
      idempotencyKey: "not-a-uuid",
      reason: "",
    }).success).toBe(false);
  });
});
