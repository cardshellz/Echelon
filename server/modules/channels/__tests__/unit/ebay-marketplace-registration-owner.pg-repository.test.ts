import { describe, expect, it, vi } from "vitest";

import { PgEbayMarketplaceRegistrationOwnerRepository } from "../../adapters/ebay/ebay-marketplace-registration-owner.pg-repository";

function limitedRows(rows: readonly unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  };
}

function orderedRows(rows: readonly unknown[]) {
  return {
    from: () => ({
      where: () => ({
        orderBy: async () => rows,
      }),
    }),
  };
}

function orderedLimitedRows(rows: readonly unknown[]) {
  return {
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: async () => rows,
        }),
      }),
    }),
  };
}

describe("PgEbayMarketplaceRegistrationOwnerRepository", () => {
  it("loads the authoritative owner and every customer-sellable variant using exact-SKU ATP", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(limitedRows([{ id: 67, provider: "ebay" }]))
        .mockReturnValueOnce(orderedLimitedRows([{
          id: 9,
          metadata: { marketplaceId: "EBAY_US" },
        }]))
        .mockReturnValueOnce(limitedRows([{ id: 501 }]))
        .mockReturnValueOnce(orderedRows([
          {
            id: 700,
            productId: 501,
            sku: "ARM-ENV-SGL-C700",
            isActive: false,
            unitsPerVariant: 700,
          },
          {
            id: 750,
            productId: 501,
            sku: "ARM-ENV-SGL-C750",
            isActive: true,
            unitsPerVariant: 750,
          },
          {
            id: 50,
            productId: 501,
            sku: "ARM-ENV-SGL-P50",
            isActive: true,
            unitsPerVariant: 50,
            requiresShipping: false,
            trackInventory: false,
          },
        ])),
    };
    const atp = { getAtpPerVariant: vi.fn().mockResolvedValue([
      { productVariantId: 700, atpUnits: 1 },
      { productVariantId: 750, atpUnits: 2 },
    ]) };
    const repository = new PgEbayMarketplaceRegistrationOwnerRepository(
      db as any,
      atp,
    );

    await expect(repository.loadChannel(67)).resolves.toEqual({
      id: 67,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    });
    await expect(repository.loadProduct(501)).resolves.toEqual({ id: 501 });
    await expect(repository.loadAllProductVariants(501)).resolves.toEqual([
      {
        id: 700,
        productId: 501,
        sku: "ARM-ENV-SGL-C700",
        isActive: false,
        availableQuantity: 1,
      },
      {
        id: 750,
        productId: 501,
        sku: "ARM-ENV-SGL-C750",
        isActive: true,
        availableQuantity: 2,
      },
      {
        id: 50,
        productId: 501,
        sku: "ARM-ENV-SGL-P50",
        isActive: true,
        availableQuantity: 0,
      },
    ]);
    expect(atp.getAtpPerVariant).toHaveBeenCalledWith(501);
  });

  it("uses the connector default marketplace only when metadata omits it", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(limitedRows([{ id: 67, provider: "ebay" }]))
        .mockReturnValueOnce(orderedLimitedRows([{ id: 9, metadata: {} }])),
    };
    const repository = new PgEbayMarketplaceRegistrationOwnerRepository(
      db as any,
      { getAtpPerVariant: vi.fn() },
    );

    await expect(repository.loadChannel(67)).resolves.toMatchObject({
      marketplaceId: "EBAY_US",
    });
  });

  it("rejects ambiguous Channel connection configuration", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(limitedRows([{ id: 67, provider: "ebay" }]))
        .mockReturnValueOnce(orderedLimitedRows([
          { id: 9, metadata: { marketplaceId: "EBAY_US" } },
          { id: 10, metadata: { marketplaceId: "EBAY_GB" } },
        ])),
    };
    const repository = new PgEbayMarketplaceRegistrationOwnerRepository(
      db as any,
      { getAtpPerVariant: vi.fn() },
    );

    await expect(repository.loadChannel(67)).rejects.toMatchObject({
      code: "CHANNEL_MARKETPLACE_REGISTRATION_CONNECTION_AMBIGUOUS",
    });
  });

  it("retains inactive variants when authoritative ATP is zero", async () => {
    const db = {
      select: vi.fn().mockReturnValueOnce(orderedRows([{
        id: 700,
        productId: 501,
        sku: "ARM-ENV-SGL-C700",
        isActive: false,
        unitsPerVariant: 700,
      }])),
    };
    const repository = new PgEbayMarketplaceRegistrationOwnerRepository(
      db as any,
      { getAtpPerVariant: vi.fn().mockResolvedValue([]) },
    );

    await expect(repository.loadAllProductVariants(501)).resolves.toEqual([{
      id: 700,
      productId: 501,
      sku: "ARM-ENV-SGL-C700",
      isActive: false,
      availableQuantity: 0,
    }]);
  });

  it("rejects an invalid authoritative variant ATP quantity", async () => {
    const db = {
      select: vi.fn().mockReturnValueOnce(orderedRows([{
        id: 700,
        productId: 501,
        sku: "ARM-ENV-SGL-C700",
        isActive: false,
        unitsPerVariant: 700,
      }])),
    };
    const repository = new PgEbayMarketplaceRegistrationOwnerRepository(
      db as any,
      { getAtpPerVariant: vi.fn().mockResolvedValue([
        { productVariantId: 700, atpUnits: Number.NaN },
      ]) },
    );

    await expect(repository.loadAllProductVariants(501)).rejects.toMatchObject({
      code: "CHANNEL_MARKETPLACE_REGISTRATION_ATP_INVALID",
    });
  });
});
