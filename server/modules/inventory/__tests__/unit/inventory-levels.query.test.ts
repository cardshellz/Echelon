import { describe, expect, it, vi } from "vitest";

import { projectInventoryLevels } from "../../application/inventory-levels.query";

function row(input: {
  variantId: number;
  sku: string;
  unitsPerVariant: number;
  variantQty: number;
  reservedQty: number;
  inventoryStrategy: string;
  productId?: number;
  parentVariantId?: number | null;
}) {
  return {
    variant_id: input.variantId,
    variant_sku: input.sku,
    variant_name: input.sku,
    units_per_variant: input.unitsPerVariant,
    parent_variant_id: input.parentVariantId ?? null,
    hierarchy_level: 1,
    is_base_unit: input.unitsPerVariant === 1,
    product_id: input.productId ?? 10,
    base_sku: "QUAD-BOX-TOP",
    product_name: "Quad Box Toploader",
    inventory_strategy: input.inventoryStrategy,
    barcode: null,
    total_variant_qty: input.variantQty,
    total_reserved_qty: input.reservedQty,
    total_picked_qty: 0,
    location_count: input.variantQty > 0 ? 1 : 0,
    pickable_variant_qty: input.variantQty,
    bin_count: input.variantQty > 0 ? 1 : 0,
    has_replen_rule: 0,
  };
}

describe("projectInventoryLevels", () => {
  it("uses centralized recipe ATP without changing physical quantities", async () => {
    const atp = {
      getAtpPerVariant: vi.fn(async () => [
        { productVariantId: 100, atpUnits: 4_310 },
        { productVariantId: 200, atpUnits: 862 },
        { productVariantId: 300, atpUnits: 172 },
      ]),
      getAtpPerVariantByWarehouse: vi.fn(),
    };

    const result = await projectInventoryLevels({
      rows: [
        row({ variantId: 100, sku: "QUAD-BOX-TOP-EA", unitsPerVariant: 1, variantQty: 0, reservedQty: 0, inventoryStrategy: "recipe_managed" }),
        row({ variantId: 200, sku: "QUAD-BOX-TOP-P5", unitsPerVariant: 5, variantQty: 5, reservedQty: 3, inventoryStrategy: "recipe_managed" }),
        row({ variantId: 300, sku: "QUAD-BOX-TOP-C25", unitsPerVariant: 25, variantQty: 87, reservedQty: 3, inventoryStrategy: "recipe_managed" }),
      ],
      atp,
    });

    expect(result.map(({ sku, variantQty, reservedQty, available }) => ({ sku, variantQty, reservedQty, available }))).toEqual([
      { sku: "QUAD-BOX-TOP-EA", variantQty: 0, reservedQty: 0, available: 4_310 },
      { sku: "QUAD-BOX-TOP-P5", variantQty: 5, reservedQty: 3, available: 862 },
      { sku: "QUAD-BOX-TOP-C25", variantQty: 87, reservedQty: 3, available: 172 },
    ]);
    expect(atp.getAtpPerVariant).toHaveBeenCalledOnce();
    expect(atp.getAtpPerVariant).toHaveBeenCalledWith(10);
    expect(atp.getAtpPerVariantByWarehouse).not.toHaveBeenCalled();
  });

  it("uses warehouse-scoped recipe ATP when a warehouse filter is present", async () => {
    const atp = {
      getAtpPerVariant: vi.fn(),
      getAtpPerVariantByWarehouse: vi.fn(async () => [
        { productVariantId: 100, atpUnits: 900 },
      ]),
    };

    const result = await projectInventoryLevels({
      rows: [row({ variantId: 100, sku: "QUAD-BOX-TOP-EA", unitsPerVariant: 1, variantQty: 0, reservedQty: 0, inventoryStrategy: "recipe_managed" })],
      atp,
      warehouseId: 7,
    });

    expect(result[0].available).toBe(900);
    expect(atp.getAtpPerVariantByWarehouse).toHaveBeenCalledWith(10, 7);
    expect(atp.getAtpPerVariant).not.toHaveBeenCalled();
  });

  it("preserves direct availability for non-recipe products", async () => {
    const atp = {
      getAtpPerVariant: vi.fn(),
      getAtpPerVariantByWarehouse: vi.fn(),
    };

    const result = await projectInventoryLevels({
      rows: [row({ variantId: 200, sku: "LEGACY-P5", unitsPerVariant: 5, variantQty: 5, reservedQty: 3, inventoryStrategy: "physical_fungible" })],
      atp,
    });

    expect(result[0].available).toBe(2);
    expect(atp.getAtpPerVariant).not.toHaveBeenCalled();
    expect(atp.getAtpPerVariantByWarehouse).not.toHaveBeenCalled();
  });
});
