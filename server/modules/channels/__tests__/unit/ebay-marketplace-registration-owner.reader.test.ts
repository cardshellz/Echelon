import { describe, expect, it } from "vitest";

import {
  EbayMarketplaceRegistrationOwnerReader,
  type EbayMarketplaceRegistrationOwnerRepository,
} from "../../adapters/ebay/ebay-marketplace-registration-owner.reader";

const owner = {
  kind: "channel" as const,
  channelId: 67,
  productId: 10,
  provider: "ebay",
  marketplaceId: "EBAY_US",
};

function repository(
  variants: Awaited<
    ReturnType<EbayMarketplaceRegistrationOwnerRepository["loadAllProductVariants"]>
  >,
  provider = "ebay",
  marketplaceId = "EBAY_US",
): EbayMarketplaceRegistrationOwnerRepository {
  return {
    loadChannel: async (channelId) => ({
      id: channelId,
      provider,
      marketplaceId,
    }),
    loadProduct: async (productId) => ({ id: productId }),
    loadAllProductVariants: async () => variants,
  };
}

describe("EbayMarketplaceRegistrationOwnerReader", () => {
  it("returns every product variant including inactive and zero-quantity SKUs", async () => {
    const reader = new EbayMarketplaceRegistrationOwnerReader(
      repository([
        {
          id: 702,
          productId: 10,
          sku: "ARM-ENV-SGL-C750",
          isActive: true,
          availableQuantity: 507,
        },
        {
          id: 701,
          productId: 10,
          sku: "ARM-ENV-SGL-C700",
          isActive: false,
          availableQuantity: 0,
        },
      ]),
    );

    await expect(reader.loadRegistrationSnapshot(owner)).resolves.toEqual({
      owner,
      memberCandidates: [
        {
          productVariantId: 701,
          sku: "ARM-ENV-SGL-C700",
          isActive: false,
          availableQuantity: 0,
        },
        {
          productVariantId: 702,
          sku: "ARM-ENV-SGL-C750",
          isActive: true,
          availableQuantity: 507,
        },
      ],
    });
  });

  it("rejects a channel whose persisted provider is not eBay", async () => {
    const reader = new EbayMarketplaceRegistrationOwnerReader(
      repository([
        {
          id: 701,
          productId: 10,
          sku: "SKU",
          isActive: true,
          availableQuantity: 1,
        },
      ], "shopify"),
    );

    await expect(reader.loadRegistrationSnapshot(owner)).rejects.toMatchObject({
      code: "CHANNEL_MARKETPLACE_REGISTRATION_PROVIDER_MISMATCH",
    });
  });

  it("rejects a marketplace that differs from Channel connection configuration", async () => {
    const reader = new EbayMarketplaceRegistrationOwnerReader(
      repository([
        {
          id: 701,
          productId: 10,
          sku: "SKU",
          isActive: true,
          availableQuantity: 1,
        },
      ], "ebay", "EBAY_GB"),
    );

    await expect(reader.loadRegistrationSnapshot(owner)).rejects.toMatchObject({
      code: "CHANNEL_MARKETPLACE_REGISTRATION_MARKETPLACE_MISMATCH",
      context: {
        requestedMarketplaceId: "EBAY_US",
        configuredMarketplaceId: "EBAY_GB",
      },
    });
  });

  it("rejects a variant returned for a different product", async () => {
    const reader = new EbayMarketplaceRegistrationOwnerReader(
      repository([
        {
          id: 701,
          productId: 99,
          sku: "SKU",
          isActive: true,
          availableQuantity: 1,
        },
      ]),
    );

    await expect(reader.loadRegistrationSnapshot(owner)).rejects.toMatchObject({
      code: "CHANNEL_MARKETPLACE_REGISTRATION_PRODUCT_OWNERSHIP_MISMATCH",
    });
  });

  it("rejects duplicate and missing SKU identities", async () => {
    const duplicateReader = new EbayMarketplaceRegistrationOwnerReader(
      repository([
        {
          id: 701,
          productId: 10,
          sku: "SKU",
          isActive: true,
          availableQuantity: 1,
        },
        {
          id: 702,
          productId: 10,
          sku: " SKU ",
          isActive: false,
          availableQuantity: 0,
        },
      ]),
    );
    const missingReader = new EbayMarketplaceRegistrationOwnerReader(
      repository([
        {
          id: 701,
          productId: 10,
          sku: null,
          isActive: true,
          availableQuantity: 1,
        },
      ]),
    );

    await expect(duplicateReader.loadRegistrationSnapshot(owner)).rejects.toMatchObject({
      code: "CHANNEL_MARKETPLACE_REGISTRATION_SKU_DUPLICATE",
    });
    await expect(missingReader.loadRegistrationSnapshot(owner)).rejects.toMatchObject({
      code: "CHANNEL_MARKETPLACE_REGISTRATION_SKU_INVALID",
    });
  });
});
