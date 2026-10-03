import { describe, expect, it } from "vitest";
import { inventoryProductBalancesSchema, totalBalanceBaseUnits } from "../../application/inventory-product-balances";

const variant = { productVariantId: 2, sku: "P5", name: "Pack", isActive: true,
  unitsPerVariant: 5, physicalQty: 2, reservedQty: 1, pickedQty: 3 };

describe("canonical summary physical facts", () => {
  it("keeps physical, reserved and picked separate without recalculating ATP", () => {
    const value = inventoryProductBalancesSchema.parse({ productId: 1, sku: "PRODUCT", name: "Product",
      inventoryStrategy: "recipe_managed", variants: [{ ...variant, physicalQty: "2", reservedQty: "1", pickedQty: "3" }] });
    expect(totalBalanceBaseUnits(value.variants, "physicalQty")).toBe(10);
    expect(totalBalanceBaseUnits(value.variants, "reservedQty")).toBe(5);
    expect(value.variants[0].pickedQty).toBe(3);
    expect(totalBalanceBaseUnits([], "physicalQty")).toBe(0);
  });

  it("rejects invalid units and unsafe integer balances instead of silently rounding", () => {
    for (const invalid of [{ unitsPerVariant: 0 }, { physicalQty: "1.5" }, { physicalQty: "9007199254740993" }]) {
      expect(() => inventoryProductBalancesSchema.parse({ productId: 1, sku: "PRODUCT", name: "Product",
        inventoryStrategy: "physical_only", variants: [{ ...variant, ...invalid }] })).toThrow();
    }
    expect(() => totalBalanceBaseUnits([{ ...variant, physicalQty: Number.MAX_SAFE_INTEGER }], "physicalQty"))
      .toThrow("exceeds safe integer range");
  });
});
