import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProductVariantBySku: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  createProductVariant: vi.fn(),
  updateProductVariant: vi.fn(),
  fetchShopifyCatalogProducts: vi.fn(),
}));

vi.mock("../..", () => ({
  catalogStorage: {
    getProductVariantBySku: mocks.getProductVariantBySku,
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

describe("Shopify product import sales eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([{
      shopifyProductId: 9001,
      sku: "QUAD-EA-C25",
      variantId: 9002,
      productTitle: "Quad Box",
      variantTitle: "Case of 25",
      title: "Quad Box - Case of 25",
      description: null,
      vendor: "Card Shellz",
      productType: "Quad Box",
      tags: [],
      status: "active",
      imageUrl: null,
      barcode: null,
      inventoryItemId: 9003,
      allImages: [],
    }]);
    mocks.getProductVariantBySku.mockResolvedValue({
      id: 511,
      productId: 51,
      sku: "QUAD-EA-C25",
      salesEligibility: "internal_only",
    });
  });

  it("reports and skips an internal-only SKU before writing a Shopify mapping", async () => {
    const result = await createProductImportService().syncProductsWithMultiUOM();

    expect(result.mappingConflicts).toEqual([
      expect.objectContaining({
        code: "SHOPIFY_VARIANT_INTERNAL_ONLY_CONFLICT",
        echelonProductId: 51,
        echelonSku: "QUAD-EA-C25",
        incomingShopifyProductId: "9001",
      }),
    ]);
    expect(mocks.createProduct).not.toHaveBeenCalled();
    expect(mocks.updateProduct).not.toHaveBeenCalled();
    expect(mocks.createProductVariant).not.toHaveBeenCalled();
    expect(mocks.updateProductVariant).not.toHaveBeenCalled();
  });
});
