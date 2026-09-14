import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProductVariantBySku: vi.fn(),
  getProductBySku: vi.fn(),
  getProductById: vi.fn(),
  getProductByShopifyProductId: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  createProductVariant: vi.fn(),
  updateProductVariant: vi.fn(),
  deleteProductAssetsByProductId: vi.fn(),
  createProductAsset: vi.fn(),
  upsertProductLocationBySku: vi.fn(),
  fetchShopifyCatalogProducts: vi.fn(),
  repairShopifyProductMapping: vi.fn(),
}));

vi.mock("../..", () => ({
  catalogStorage: {
    getProductVariantBySku: mocks.getProductVariantBySku,
    getProductBySku: mocks.getProductBySku,
    getProductById: mocks.getProductById,
    getProductByShopifyProductId: mocks.getProductByShopifyProductId,
    createProduct: mocks.createProduct,
    updateProduct: mocks.updateProduct,
    createProductVariant: mocks.createProductVariant,
    updateProductVariant: mocks.updateProductVariant,
    deleteProductAssetsByProductId: mocks.deleteProductAssetsByProductId,
    createProductAsset: mocks.createProductAsset,
  },
}));

vi.mock("../../../warehouse", () => ({
  warehouseStorage: {
    upsertProductLocationBySku: mocks.upsertProductLocationBySku,
  },
}));

vi.mock("../../../integrations/shopify", () => ({
  fetchShopifyCatalogProducts: mocks.fetchShopifyCatalogProducts,
}));

vi.mock("../../../../storage/base", () => ({
  db: {},
  productCategories: {},
  eq: vi.fn(),
  and: vi.fn(),
}));

import { createProductImportService } from "../../product-import.service";

/** A SKU-less Shopify variant (sealed wax / graded slab listing). */
function skuLessVariant(shopifyProductId: number, variantId: number, variantTitle: string) {
  return {
    shopifyProductId,
    sku: null,
    variantId,
    productTitle: "2023 Topps Now Elly De La Cruz Call-Up RC PSA 10",
    variantTitle,
    title: `2023 Topps Now Elly De La Cruz Call-Up RC PSA 10 - ${variantTitle}`,
    description: null,
    vendor: "Cardshellz",
    productType: null,
    tags: [],
    status: "active",
    imageUrl: null,
    barcode: null,
    inventoryItemId: null,
    allImages: [],
  };
}

describe("Shopify import — SKU-less variant grouping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProductVariantBySku.mockResolvedValue(null);
    mocks.getProductBySku.mockResolvedValue(null);
    mocks.getProductById.mockResolvedValue(null);
    mocks.getProductByShopifyProductId.mockResolvedValue(null);
    mocks.createProduct.mockResolvedValue({ id: 900, sku: "SHOPIFY-88018595" });
    let nextVariantId = 1;
    mocks.createProductVariant.mockImplementation(async (input) => ({
      ...input,
      id: nextVariantId++,
    }));
    mocks.repairShopifyProductMapping.mockImplementation(async (input) => ({
      mappedVariantCount: input.importedVariantBindings.length,
      alreadyConsistent: false,
    }));
  });

  it("folds every SKU-less variant of one Shopify product into a single product", async () => {
    // Deliberately out of order: the lowest variant id must win as representative
    // so the product SKU is stable across syncs.
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      skuLessVariant(10928619356319, 88018597, "88018597"),
      skuLessVariant(10928619356319, 88018595, "88018595"),
      skuLessVariant(10928619356319, 88018596, "88018596"),
    ]);

    const result = await createProductImportService({
      mappingOwner: { repair: mocks.repairShopifyProductMapping },
    }).syncProductsWithMultiUOM();

    // One product — not three mapped to the same Shopify id, which is what the
    // shipping-group metafield push refuses to resolve.
    expect(mocks.createProduct).toHaveBeenCalledTimes(1);
    expect(mocks.createProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "SHOPIFY-88018595",
      }),
    );
    expect(mocks.createProduct.mock.calls[0][0]).not.toHaveProperty("shopifyProductId");

    // All three variants land under it.
    expect(mocks.createProductVariant).toHaveBeenCalledTimes(3);
    const createdSkus = mocks.createProductVariant.mock.calls.map((call) => call[0].sku).sort();
    expect(createdSkus).toEqual(["SHOPIFY-88018595", "SHOPIFY-88018596", "SHOPIFY-88018597"]);
    for (const call of mocks.createProductVariant.mock.calls) {
      expect(call[0].productId).toBe(900);
      expect(call[0].unitsPerVariant).toBe(1);
      expect(call[0].hierarchyLevel).toBe(1);
      expect(call[0]).not.toHaveProperty("shopifyVariantId");
      expect(call[0]).not.toHaveProperty("shopifyInventoryItemId");
    }
    expect(mocks.repairShopifyProductMapping).toHaveBeenCalledWith(expect.objectContaining({
      productId: 900,
      targetProductId: "10928619356319",
      actor: "system:shopify-product-sync",
      importedVariantBindings: [
        { variantId: 1, remoteVariantId: 88018595 },
        { variantId: 2, remoteVariantId: 88018596 },
        { variantId: 3, remoteVariantId: 88018597 },
      ],
      verifiedShopifyProduct: expect.objectContaining({
        id: "10928619356319",
        variants: expect.arrayContaining([
          expect.objectContaining({ id: "88018595" }),
          expect.objectContaining({ id: "88018596" }),
          expect.objectContaining({ id: "88018597" }),
        ]),
      }),
    }));
    expect(result.canonicalMappings).toEqual({
      eligibleProducts: 1,
      attemptedProducts: 1,
      repairedProducts: 1,
      alreadyConsistentProducts: 0,
      failedProducts: 0,
      mappedVariants: 3,
    });
    expect(result.success).toBe(true);
  });

  it("still gives distinct Shopify products their own Echelon product", async () => {
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      skuLessVariant(111, 5001, "Default Title"),
      skuLessVariant(222, 5002, "Default Title"),
    ]);

    mocks.createProduct
      .mockResolvedValueOnce({ id: 901, sku: "SHOPIFY-5001" })
      .mockResolvedValueOnce({ id: 902, sku: "SHOPIFY-5002" });

    await createProductImportService({
      mappingOwner: { repair: mocks.repairShopifyProductMapping },
    }).syncProductsWithMultiUOM();

    expect(mocks.createProduct).toHaveBeenCalledTimes(2);
    expect(mocks.createProductVariant).toHaveBeenCalledTimes(2);
    expect(mocks.repairShopifyProductMapping).toHaveBeenCalledTimes(2);
  });

  it("leaves variants that carry a real SKU on their own product", async () => {
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      // Real SKUs with no multi-UOM suffix -(P|B|C)<n>, so they take the
      // standalone path rather than being grouped as pack/box/case siblings.
      { ...skuLessVariant(333, 6001, "Each"), sku: "SHLZ-TOP-35PT-BLU" },
      { ...skuLessVariant(333, 6002, "Each"), sku: "SHLZ-MAG-STND" },
    ]);

    mocks.createProduct
      .mockResolvedValueOnce({ id: 903, sku: "SHLZ-TOP-35PT-BLU" })
      .mockResolvedValueOnce({ id: 904, sku: "SHLZ-MAG-STND" });

    const result = await createProductImportService({
      mappingOwner: { repair: mocks.repairShopifyProductMapping },
    }).syncProductsWithMultiUOM();

    // Real SKUs keep pre-existing behaviour: one product each.
    expect(mocks.createProduct).toHaveBeenCalledTimes(2);
    const skus = mocks.createProduct.mock.calls.map((call) => call[0].sku).sort();
    expect(skus).toEqual(["SHLZ-MAG-STND", "SHLZ-TOP-35PT-BLU"]);
    expect(mocks.repairShopifyProductMapping).not.toHaveBeenCalled();
    expect(result.canonicalMappings.failedProducts).toBe(1);
    expect(result.mappingConflicts).toContainEqual(expect.objectContaining({
      code: "SHOPIFY_PRODUCT_SKUS_SPLIT",
      incomingShopifyProductId: "333",
      matchedEchelonProductIds: [903, 904],
    }));
  });

  it("reports a canonical projection failure instead of claiming the import is complete", async () => {
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      skuLessVariant(444, 7001, "Default Title"),
    ]);
    mocks.repairShopifyProductMapping.mockRejectedValue(
      Object.assign(new Error("Remote inventory item is missing"), {
        code: "SHOPIFY_ACTIVE_VARIANTS_UNRESOLVED",
      }),
    );

    const result = await createProductImportService({
      mappingOwner: { repair: mocks.repairShopifyProductMapping },
    }).syncProductsWithMultiUOM();

    expect(result.canonicalMappings).toEqual(expect.objectContaining({
      attemptedProducts: 1,
      repairedProducts: 0,
      failedProducts: 1,
    }));
    expect(result.success).toBe(false);
    expect(result.mappingConflicts).toContainEqual(expect.objectContaining({
      code: "SHOPIFY_CANONICAL_MAPPING_PROJECTION_FAILED",
      failureCode: "SHOPIFY_ACTIVE_VARIANTS_UNRESOLVED",
      failureMessage: "Remote inventory item is missing",
    }));
  });

  it("blocks an entire SKU-less product when any sibling is internal-only", async () => {
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      skuLessVariant(445, 7101, "7101"),
      skuLessVariant(445, 7102, "7102"),
    ]);
    mocks.getProductVariantBySku.mockImplementation(async (sku) => (
      sku === "SHOPIFY-7102"
        ? {
            id: 71,
            productId: 907,
            sku,
            salesEligibility: "internal_only",
          }
        : null
    ));

    const result = await createProductImportService({
      mappingOwner: { repair: mocks.repairShopifyProductMapping },
    }).syncProductsWithMultiUOM();

    expect(mocks.createProduct).not.toHaveBeenCalled();
    expect(mocks.createProductVariant).not.toHaveBeenCalled();
    expect(mocks.repairShopifyProductMapping).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.mappingConflicts).toContainEqual(expect.objectContaining({
      code: "SHOPIFY_VARIANT_INTERNAL_ONLY_CONFLICT",
      echelonProductId: 907,
      echelonSku: "SHOPIFY-7102",
    }));
  });

  it("routes existing catalog identity updates through the mapping owner", async () => {
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([{
      ...skuLessVariant(555, 8001, "Case of 25"),
      sku: "QUAD-EA-C25",
      inventoryItemId: 8002,
    }]);
    mocks.getProductBySku.mockResolvedValue({
      id: 905,
      sku: "QUAD-EA",
      shopifyProductId: null,
    });
    mocks.getProductVariantBySku.mockResolvedValue({
      id: 45,
      productId: 905,
      sku: "QUAD-EA-C25",
      salesEligibility: "sellable",
    });

    await createProductImportService({
      mappingOwner: { repair: mocks.repairShopifyProductMapping },
    }).syncProductsWithMultiUOM();

    const productWrite = mocks.updateProduct.mock.calls[0][1];
    const variantWrite = mocks.updateProductVariant.mock.calls[0][1];
    expect(productWrite).not.toHaveProperty("shopifyProductId");
    expect(variantWrite).not.toHaveProperty("shopifyVariantId");
    expect(variantWrite).not.toHaveProperty("shopifyInventoryItemId");
    expect(mocks.repairShopifyProductMapping).toHaveBeenCalledWith(expect.objectContaining({
      productId: 905,
      targetProductId: "555",
      importedVariantBindings: [{ variantId: 45, remoteVariantId: 8001 }],
    }));
  });

  it("routes content-sync product adoption through the same mapping owner", async () => {
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([{
      ...skuLessVariant(666, 9001, "Default Title"),
      sku: "SHLZ-TOP-35PT-BLU",
      inventoryItemId: 9002,
      allImages: [],
    }]);
    const product = {
      id: 906,
      sku: "SHLZ-TOP-35PT-BLU",
      shopifyProductId: null,
    };
    mocks.getProductVariantBySku.mockResolvedValue({
      id: 46,
      productId: 906,
      sku: "SHLZ-TOP-35PT-BLU",
      salesEligibility: "sellable",
    });
    mocks.getProductById.mockResolvedValue(product);

    const result = await createProductImportService({
      mappingOwner: { repair: mocks.repairShopifyProductMapping },
    }).syncContentAndAssets();

    expect(mocks.updateProduct.mock.calls[0][1]).not.toHaveProperty("shopifyProductId");
    expect(mocks.repairShopifyProductMapping).toHaveBeenCalledWith(expect.objectContaining({
      productId: 906,
      targetProductId: "666",
      importedVariantBindings: [{ variantId: 46, remoteVariantId: 9001 }],
    }));
    expect(result.canonicalMappings.failedProducts).toBe(0);
  });

  it("uses one Shopify snapshot for the combined product and content command", async () => {
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      skuLessVariant(777, 9101, "Default Title"),
    ]);

    const result = await createProductImportService({
      mappingOwner: { repair: mocks.repairShopifyProductMapping },
    }).syncProductsAndContent();

    expect(mocks.fetchShopifyCatalogProducts).toHaveBeenCalledTimes(1);
    expect(mocks.repairShopifyProductMapping).toHaveBeenCalledTimes(1);
    expect(result.canonicalMappings.attemptedProducts).toBe(1);
    expect(result.contentSync).toEqual(expect.objectContaining({
      success: true,
      skuNotFound: 1,
    }));
  });

  it("keeps a SKU-less listing on the parent that already owns all remote variants", async () => {
    const remoteProductId = 9090381643935;
    const canonicalProduct = {
      id: 195,
      sku: "DIGITAL-GIFT-CARD",
      shopifyProductId: String(remoteProductId),
    };
    const fallbackShell = {
      id: 295,
      sku: "SHOPIFY-410",
      shopifyProductId: null,
    };
    const variants = [
      { id: 410, productId: 195, sku: "SHOPIFY-410", salesEligibility: "sellable" },
      { id: 411, productId: 195, sku: "SHOPIFY-411", salesEligibility: "sellable" },
    ];
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      skuLessVariant(remoteProductId, 410, "$10.00"),
      skuLessVariant(remoteProductId, 411, "$25.00"),
    ]);
    mocks.getProductVariantBySku.mockImplementation(async (sku) => (
      variants.find((variant) => variant.sku === sku) ?? null
    ));
    mocks.getProductBySku.mockResolvedValue(fallbackShell);
    mocks.getProductById.mockImplementation(async (productId) => (
      productId === canonicalProduct.id ? canonicalProduct : null
    ));

    const result = await createProductImportService({
      mappingOwner: { repair: mocks.repairShopifyProductMapping },
    }).syncProductsWithMultiUOM();

    expect(mocks.updateProduct).toHaveBeenCalledWith(195, expect.objectContaining({
      name: "2023 Topps Now Elly De La Cruz Call-Up RC PSA 10",
    }));
    expect(mocks.updateProduct).not.toHaveBeenCalledWith(295, expect.anything());
    expect(mocks.createProduct).not.toHaveBeenCalled();
    expect(mocks.createProductVariant).not.toHaveBeenCalled();
    expect(mocks.updateProductVariant).toHaveBeenCalledTimes(2);
    expect(mocks.repairShopifyProductMapping).toHaveBeenCalledWith(expect.objectContaining({
      productId: 195,
      targetProductId: String(remoteProductId),
      importedVariantBindings: [
        { variantId: 410, remoteVariantId: 410 },
        { variantId: 411, remoteVariantId: 411 },
      ],
    }));
    expect(result.success).toBe(true);
    expect(result.mappingConflicts).toEqual([]);
  });

  it("fails closed when a SKU-less fallback shell and variant owner lack canonical proof", async () => {
    const remoteProductId = 9090381643935;
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      skuLessVariant(remoteProductId, 410, "$10.00"),
    ]);
    mocks.getProductVariantBySku.mockResolvedValue({
      id: 410,
      productId: 195,
      sku: "SHOPIFY-410",
      salesEligibility: "sellable",
    });
    mocks.getProductBySku.mockResolvedValue({
      id: 295,
      sku: "SHOPIFY-410",
      shopifyProductId: null,
    });
    mocks.getProductById.mockResolvedValue({
      id: 195,
      sku: "DIGITAL-GIFT-CARD",
      shopifyProductId: null,
    });

    const result = await createProductImportService({
      mappingOwner: { repair: mocks.repairShopifyProductMapping },
    }).syncProductsWithMultiUOM();

    expect(mocks.updateProduct).not.toHaveBeenCalled();
    expect(mocks.createProduct).not.toHaveBeenCalled();
    expect(mocks.updateProductVariant).not.toHaveBeenCalled();
    expect(mocks.createProductVariant).not.toHaveBeenCalled();
    expect(mocks.repairShopifyProductMapping).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.mappingConflicts).toContainEqual(expect.objectContaining({
      code: "SHOPIFY_PRODUCT_SKUS_SPLIT",
      incomingShopifyProductId: String(remoteProductId),
      matchedEchelonProductIds: [195, 295],
    }));
  });
});

describe("Shopify import — requires_shipping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProductVariantBySku.mockResolvedValue(null);
    mocks.getProductBySku.mockResolvedValue(null);
    mocks.getProductById.mockResolvedValue(null);
    mocks.getProductByShopifyProductId.mockResolvedValue(null);
    mocks.createProduct.mockResolvedValue({ id: 901 });
    mocks.createProductVariant.mockResolvedValue({ id: 2 });
    mocks.repairShopifyProductMapping.mockResolvedValue({
      mappedVariantCount: 1,
      alreadyConsistent: false,
    });
  });

  it("stores a digital variant as non-shipping and untracked", async () => {
    // product_variants_digital_untracked_chk requires the two together.
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      { ...skuLessVariant(500, 7001, "Default Title"), sku: "CLUB-ANNUAL-US", requiresShipping: false },
    ]);

    await createProductImportService({
      mappingOwner: { repair: mocks.repairShopifyProductMapping },
    }).syncProductsWithMultiUOM();

    expect(mocks.createProductVariant).toHaveBeenCalledWith(
      expect.objectContaining({ requiresShipping: false, trackInventory: false }),
    );
  });

  it("keeps a physical variant shippable and does not force it untracked", async () => {
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      { ...skuLessVariant(501, 7002, "Default Title"), sku: "SHLZ-TOP-35PT-BLU", requiresShipping: true },
    ]);

    await createProductImportService({
      mappingOwner: { repair: mocks.repairShopifyProductMapping },
    }).syncProductsWithMultiUOM();

    const call = mocks.createProductVariant.mock.calls[0][0];
    expect(call.requiresShipping).toBe(true);
    expect(call).not.toHaveProperty("trackInventory");
  });

  it("treats an unknown flag as shippable", async () => {
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      { ...skuLessVariant(502, 7003, "Default Title"), sku: "SHLZ-MAG-STND" },
    ]);

    await createProductImportService({
      mappingOwner: { repair: mocks.repairShopifyProductMapping },
    }).syncProductsWithMultiUOM();

    expect(mocks.createProductVariant).toHaveBeenCalledWith(
      expect.objectContaining({ requiresShipping: true }),
    );
  });
});
