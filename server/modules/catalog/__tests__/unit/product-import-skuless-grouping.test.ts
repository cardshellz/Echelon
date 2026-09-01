import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProductVariantBySku: vi.fn(),
  getProductBySku: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  createProductVariant: vi.fn(),
  updateProductVariant: vi.fn(),
  fetchShopifyCatalogProducts: vi.fn(),
}));

vi.mock("../..", () => ({
  catalogStorage: {
    getProductVariantBySku: mocks.getProductVariantBySku,
    getProductBySku: mocks.getProductBySku,
    createProduct: mocks.createProduct,
    updateProduct: mocks.updateProduct,
    createProductVariant: mocks.createProductVariant,
    updateProductVariant: mocks.updateProductVariant,
  },
}));

vi.mock("../../../warehouse", () => ({ warehouseStorage: {} }));

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
    mocks.createProduct.mockResolvedValue({ id: 900, sku: "SHOPIFY-88018595" });
    mocks.createProductVariant.mockResolvedValue({ id: 1 });
  });

  it("folds every SKU-less variant of one Shopify product into a single product", async () => {
    // Deliberately out of order: the lowest variant id must win as representative
    // so the product SKU is stable across syncs.
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      skuLessVariant(10928619356319, 88018597, "88018597"),
      skuLessVariant(10928619356319, 88018595, "88018595"),
      skuLessVariant(10928619356319, 88018596, "88018596"),
    ]);

    await createProductImportService().syncProductsWithMultiUOM();

    // One product — not three mapped to the same Shopify id, which is what the
    // shipping-group metafield push refuses to resolve.
    expect(mocks.createProduct).toHaveBeenCalledTimes(1);
    expect(mocks.createProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "SHOPIFY-88018595",
        shopifyProductId: "10928619356319",
      }),
    );

    // All three variants land under it.
    expect(mocks.createProductVariant).toHaveBeenCalledTimes(3);
    const createdSkus = mocks.createProductVariant.mock.calls.map((call) => call[0].sku).sort();
    expect(createdSkus).toEqual(["SHOPIFY-88018595", "SHOPIFY-88018596", "SHOPIFY-88018597"]);
    for (const call of mocks.createProductVariant.mock.calls) {
      expect(call[0].productId).toBe(900);
      expect(call[0].unitsPerVariant).toBe(1);
      expect(call[0].hierarchyLevel).toBe(1);
    }
  });

  it("still gives distinct Shopify products their own Echelon product", async () => {
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      skuLessVariant(111, 5001, "Default Title"),
      skuLessVariant(222, 5002, "Default Title"),
    ]);

    await createProductImportService().syncProductsWithMultiUOM();

    expect(mocks.createProduct).toHaveBeenCalledTimes(2);
    expect(mocks.createProductVariant).toHaveBeenCalledTimes(2);
  });

  it("leaves variants that carry a real SKU on their own product", async () => {
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([
      // Real SKUs with no multi-UOM suffix -(P|B|C)<n>, so they take the
      // standalone path rather than being grouped as pack/box/case siblings.
      { ...skuLessVariant(333, 6001, "Each"), sku: "SHLZ-TOP-35PT-BLU" },
      { ...skuLessVariant(333, 6002, "Each"), sku: "SHLZ-MAG-STND" },
    ]);

    await createProductImportService().syncProductsWithMultiUOM();

    // Real SKUs keep pre-existing behaviour: one product each.
    expect(mocks.createProduct).toHaveBeenCalledTimes(2);
    const skus = mocks.createProduct.mock.calls.map((call) => call[0].sku).sort();
    expect(skus).toEqual(["SHLZ-MAG-STND", "SHLZ-TOP-35PT-BLU"]);
  });
});
