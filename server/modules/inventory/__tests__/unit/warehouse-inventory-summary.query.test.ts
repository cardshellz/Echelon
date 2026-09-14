import { describe, expect, it, vi } from "vitest";

import { projectWarehouseInventorySummary } from "../../application/warehouse-inventory-summary.query";

const products = [
  { id: 10, sku: "CARD", name: "Card", inventoryStrategy: "physical_fungible" as const },
];
const variants = [
  { id: 100, productId: 10, sku: "CARD-EA", name: "Each", unitsPerVariant: 1 },
  { id: 200, productId: 10, sku: "CARD-P5", name: "Pack of 5", unitsPerVariant: 5 },
];
const levels = [
  { productVariantId: 100, variantQty: 10, reservedQty: 2, pickedQty: 7 },
  { productVariantId: 200, variantQty: 4, reservedQty: 1, pickedQty: 3 },
];

describe("projectWarehouseInventorySummary", () => {
  it("uses authority ATP without deducting picked workflow counters from physical stock", async () => {
    const atp = {
      getAtpPerVariantByWarehouse: vi.fn(async () => [
        { productVariantId: 100, atpUnits: 63, atpBase: 63 },
        { productVariantId: 200, atpUnits: 12, atpBase: 63 },
      ]),
    };

    const result = await projectWarehouseInventorySummary({
      warehouseId: 7,
      authority: "canonical",
      levels,
      variants,
      products,
      atp,
    });

    expect(atp.getAtpPerVariantByWarehouse).toHaveBeenCalledWith(10, 7);
    expect(result).toEqual([{
      productId: 10,
      baseSku: "CARD",
      name: "Card",
      totalOnHandPieces: 30,
      totalReservedPieces: 7,
      totalAtpPieces: 63,
      variants: [
        { variantId: 100, sku: "CARD-EA", name: "Each", unitsPerVariant: 1, available: 63, atpUnits: 63,
          variantQty: 10, reservedQty: 2, pickedQty: 7, atpPieces: 63 },
        { variantId: 200, sku: "CARD-P5", name: "Pack of 5", unitsPerVariant: 5, available: 12, atpUnits: 12,
          variantQty: 4, reservedQty: 1, pickedQty: 3, atpPieces: 63 },
      ],
    }]);
  });

  it("preserves legacy non-fungible aggregate semantics while using the ATP reader", async () => {
    const atp = {
      getAtpPerVariantByWarehouse: vi.fn(async () => [
        { productVariantId: 100, atpUnits: 8, atpBase: 8 },
        { productVariantId: 200, atpUnits: 3, atpBase: 15 },
      ]),
    };

    const [summary] = await projectWarehouseInventorySummary({
      warehouseId: 7,
      authority: "legacy",
      levels,
      variants,
      products: [{ ...products[0], inventoryStrategy: "physical_only" }],
      atp,
    });

    expect(summary.totalAtpPieces).toBe(23);
    expect(summary.variants.map((variant) => variant.atpUnits)).toEqual([8, 3]);
  });

  it("projects missing ATP evidence as zero instead of inventing availability", async () => {
    const atp = { getAtpPerVariantByWarehouse: vi.fn(async () => []) };
    const [summary] = await projectWarehouseInventorySummary({
      warehouseId: 7,
      authority: "canonical",
      levels: [levels[0]],
      variants,
      products,
      atp,
    });

    expect(summary.variants[0]).toMatchObject({ atpUnits: 0, available: 0, variantQty: 10, pickedQty: 7 });
    expect(summary.totalAtpPieces).toBe(0);
  });
});
