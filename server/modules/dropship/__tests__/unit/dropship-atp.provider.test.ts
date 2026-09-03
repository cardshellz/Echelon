import { describe, expect, it, vi } from "vitest";

import { InventoryServiceDropshipAtpProvider } from "../../infrastructure/dropship-atp.provider";

describe("InventoryServiceDropshipAtpProvider", () => {
  it("returns exact authoritative SKU ATP without product-base division", async () => {
    const inventoryAtp = {
      getAtpPerVariant: vi.fn(async (productId: number) => productId === 10
        ? [
            { productVariantId: 101, atpUnits: 25 },
            { productVariantId: 102, atpUnits: 7 },
          ]
        : [{ productVariantId: 201, atpUnits: 3 }]),
    };
    const provider = new InventoryServiceDropshipAtpProvider(inventoryAtp);

    await expect(provider.getVariantAtp([
      { productId: 20, productVariantId: 201 },
      { productId: 10, productVariantId: 102 },
      { productId: 10, productVariantId: 999 },
    ])).resolves.toEqual(new Map([
      [201, 3],
      [102, 7],
      [999, 0],
    ]));
    expect(inventoryAtp.getAtpPerVariant).toHaveBeenCalledTimes(2);
    expect(inventoryAtp.getAtpPerVariant).toHaveBeenNthCalledWith(1, 10);
    expect(inventoryAtp.getAtpPerVariant).toHaveBeenNthCalledWith(2, 20);
  });

  it("rejects conflicting target ownership and invalid authoritative quantities", async () => {
    const inventoryAtp = {
      getAtpPerVariant: vi.fn(async () => [{ productVariantId: 101, atpUnits: -1 }]),
    };
    const provider = new InventoryServiceDropshipAtpProvider(inventoryAtp);

    await expect(provider.getVariantAtp([
      { productId: 10, productVariantId: 101 },
      { productId: 20, productVariantId: 101 },
    ])).rejects.toMatchObject({ code: "DROPSHIP_ATP_TARGET_CONFLICT" });
    await expect(provider.getVariantAtp([
      { productId: 10, productVariantId: 101 },
    ])).rejects.toMatchObject({ code: "DROPSHIP_ATP_QUANTITY_INVALID" });
  });
});
