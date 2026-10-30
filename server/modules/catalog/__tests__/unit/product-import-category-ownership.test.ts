import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shopify-import-connection-guard", () => ({ filterConnectionOwnedShopifyProducts: async (products: unknown) => products }));

const mocks = vi.hoisted(() => ({
  getProductVariantBySku: vi.fn(),
  getProductBySku: vi.fn(),
  getProductById: vi.fn(),
  getProductByShopifyProductId: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  createProductVariant: vi.fn(),
  updateProductVariant: vi.fn(),
  importSharedPhotos: vi.fn(),
  upsertProductLocationBySku: vi.fn(),
  fetchShopifyCatalogProducts: vi.fn(),
  repairShopifyProductMapping: vi.fn(),
  selectCategory: vi.fn(),
  insertCategory: vi.fn(),
  eq: vi.fn((column: string, value: unknown) => ({ column, value })),
}));

vi.mock("../..", () => ({
  createSharedProductPhotoImporter: () => ({ append: mocks.importSharedPhotos }),
  catalogStorage: {
    getProductVariantBySku: mocks.getProductVariantBySku,
    getProductBySku: mocks.getProductBySku,
    getProductById: mocks.getProductById,
    getProductByShopifyProductId: mocks.getProductByShopifyProductId,
    createProduct: mocks.createProduct,
    updateProduct: mocks.updateProduct,
    createProductVariant: mocks.createProductVariant,
    updateProductVariant: mocks.updateProductVariant,
  },
}));

vi.mock("../../../warehouse", () => ({
  warehouseStorage: { upsertProductLocationBySku: mocks.upsertProductLocationBySku },
}));

vi.mock("../../../integrations/shopify", () => ({
  fetchShopifyCatalogProducts: mocks.fetchShopifyCatalogProducts,
}));

vi.mock("../../../../storage/base", () => ({
  db: {
    select: () => ({ from: () => ({ where: mocks.selectCategory }) }),
    insert: mocks.insertCategory,
  },
  productCategories: { slug: "slug", isActive: "isActive" },
  eq: mocks.eq,
  and: (...conditions: unknown[]) => conditions,
}));

import { createProductImportService } from "../../product-import.service";

const HIERARCHY_SKU = "QUAD-EA-C25";
const STANDALONE_SKU = "ARM-ENV-SGL-NM";

function shopifyVariant(sku: string, productType: string | null) {
  return {
    shopifyProductId: 555,
    sku,
    variantId: 8001,
    productTitle: "Armalope Envelope",
    variantTitle: "Default Title",
    title: "Armalope Envelope",
    description: null,
    vendor: "Card Shellz",
    productType,
    tags: [],
    status: "active",
    imageUrl: null,
    barcode: null,
    inventoryItemId: 8002,
    allImages: [],
  };
}

function importService() {
  return createProductImportService({ mappingOwner: { repair: mocks.repairShopifyProductMapping } });
}

describe("Shopify import — Echelon owns product categories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.importSharedPhotos.mockResolvedValue({ created: 0 });
    mocks.getProductVariantBySku.mockResolvedValue(null);
    mocks.getProductBySku.mockResolvedValue(null);
    mocks.getProductById.mockResolvedValue(null);
    mocks.getProductByShopifyProductId.mockResolvedValue(null);
    mocks.createProduct.mockResolvedValue({ id: 900, sku: "NEW" });
    mocks.createProductVariant.mockImplementation(async (input) => ({ ...input, id: 45 }));
    mocks.repairShopifyProductMapping.mockResolvedValue({ mappedVariantCount: 1, alreadyConsistent: false });
    mocks.selectCategory.mockResolvedValue([]);
  });

  describe.each([
    ["a pack-size SKU", HIERARCHY_SKU],
    ["a standalone SKU", STANDALONE_SKU],
  ])("product sync with %s", (_label, sku) => {
    it.each([
      ["a blank productType", null],
      ["an unknown productType", "Armalopes"],
    ])("keeps an existing product's category when Shopify has %s", async (_type, productType) => {
      mocks.fetchShopifyCatalogProducts.mockResolvedValue([shopifyVariant(sku, productType)]);
      mocks.getProductBySku.mockResolvedValue({ id: 34, sku, shopifyProductId: "555", categoryId: 3, category: "Armalope" });

      await importService().syncProductsWithMultiUOM();

      expect(mocks.updateProduct).toHaveBeenCalledTimes(1);
      const productWrite = mocks.updateProduct.mock.calls[0][1];
      expect(productWrite).not.toHaveProperty("categoryId");
      expect(productWrite).not.toHaveProperty("category");
      expect(mocks.selectCategory).not.toHaveBeenCalled();
      expect(mocks.insertCategory).not.toHaveBeenCalled();
    });

    it("gives a new product the matching active category", async () => {
      mocks.fetchShopifyCatalogProducts.mockResolvedValue([shopifyVariant(sku, " Armalope ")]);
      mocks.selectCategory.mockResolvedValue([{ id: 3, name: "Armalope" }]);

      await importService().syncProductsWithMultiUOM();

      expect(mocks.eq).toHaveBeenCalledWith("slug", "armalope");
      expect(mocks.eq).toHaveBeenCalledWith("isActive", true);
      expect(mocks.createProduct).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 3, category: "Armalope" }));
      expect(mocks.insertCategory).not.toHaveBeenCalled();
    });

    it("leaves a new product uncategorized instead of creating or reviving a category", async () => {
      mocks.fetchShopifyCatalogProducts.mockResolvedValue([shopifyVariant(sku, "Armalopes")]);

      await importService().syncProductsWithMultiUOM();

      expect(mocks.selectCategory).toHaveBeenCalledTimes(1);
      expect(mocks.createProduct).toHaveBeenCalledWith(expect.objectContaining({ categoryId: null, category: null }));
      expect(mocks.insertCategory).not.toHaveBeenCalled();
    });

    it("does not look up a category for a new product with a blank productType", async () => {
      mocks.fetchShopifyCatalogProducts.mockResolvedValue([shopifyVariant(sku, "   ")]);

      await importService().syncProductsWithMultiUOM();

      expect(mocks.selectCategory).not.toHaveBeenCalled();
      expect(mocks.createProduct).toHaveBeenCalledWith(expect.objectContaining({ categoryId: null, category: null }));
    });
  });

  it.each([
    ["a blank productType", null],
    ["a different productType", "Toploader"],
  ])("content sync keeps an existing product's category when Shopify has %s", async (_type, productType) => {
    mocks.fetchShopifyCatalogProducts.mockResolvedValue([shopifyVariant(STANDALONE_SKU, productType)]);
    mocks.getProductVariantBySku.mockResolvedValue({
      id: 45, productId: 34, sku: STANDALONE_SKU, salesEligibility: "sellable",
    });
    mocks.getProductById.mockResolvedValue({ id: 34, sku: STANDALONE_SKU, shopifyProductId: "555", categoryId: 3, category: "Armalope" });

    await importService().syncContentAndAssets({ projectCanonicalMappings: false });

    expect(mocks.updateProduct).toHaveBeenCalledTimes(1);
    const productWrite = mocks.updateProduct.mock.calls[0][1];
    expect(productWrite).not.toHaveProperty("categoryId");
    expect(productWrite).not.toHaveProperty("category");
    expect(mocks.selectCategory).not.toHaveBeenCalled();
    expect(mocks.insertCategory).not.toHaveBeenCalled();
  });
});
