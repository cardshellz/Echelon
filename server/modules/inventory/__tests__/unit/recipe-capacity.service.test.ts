import { describe, expect, it, vi } from "vitest";

import { RecipeCapacityService } from "../../recipe-capacity.service";

function rows(rows: Record<string, unknown>[]) {
  return { rows };
}

describe("RecipeCapacityService", () => {
  it("adds signed finished-package inventory to independently buildable capacity", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(rows([
        {
          recipe_id: 10,
          output_variant_id: 100,
          output_product_id: 1_000,
          output_qty: 1,
          component_variant_id: 1,
          component_product_id: 1_001,
          qty: 1,
        },
        {
          recipe_id: 10,
          output_variant_id: 100,
          output_product_id: 1_000,
          output_qty: 1,
          component_variant_id: 2,
          component_product_id: 1_002,
          qty: 1,
        },
        {
          recipe_id: 10,
          output_variant_id: 100,
          output_product_id: 1_000,
          output_qty: 1,
          component_variant_id: 3,
          component_product_id: 1_003,
          qty: 1,
        },
        {
          recipe_id: 20,
          output_variant_id: 200,
          output_product_id: 1_000,
          output_qty: 1,
          component_variant_id: 100,
          component_product_id: 1_000,
          qty: 5,
        },
      ]))
      .mockResolvedValueOnce(rows([{ id: 200, product_id: 1_000 }]))
      .mockResolvedValueOnce(rows([
        { id: 100, product_id: 1_000, units_per_variant: 1 },
        { id: 200, product_id: 1_000, units_per_variant: 5 },
        { id: 300, product_id: 1_000, units_per_variant: 25 },
      ]))
      .mockResolvedValueOnce(rows([
        { product_variant_id: 1, warehouse_id: 1, warehouse_location_id: 11, available_qty: "2200" },
        { product_variant_id: 2, warehouse_id: 1, warehouse_location_id: 12, available_qty: "2200" },
        { product_variant_id: 3, warehouse_id: 1, warehouse_location_id: 13, available_qty: "2200" },
        { product_variant_id: 200, warehouse_id: 1, warehouse_location_id: 21, available_qty: "2" },
        { product_variant_id: 300, warehouse_id: 1, warehouse_location_id: 22, available_qty: "84" },
      ]))
      .mockResolvedValueOnce(rows([
        { product_variant_id: 100, warehouse_id: 1, warehouse_location_id: 20 },
        { product_variant_id: 200, warehouse_id: 1, warehouse_location_id: 21 },
      ]));
    const service = new RecipeCapacityService({ execute });

    await expect(service.getVariantCapacity(200, 1)).resolves.toBe(862);
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it("nets signed package reservations before adding build capacity", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(rows([
        {
          recipe_id: 20,
          output_variant_id: 200,
          output_product_id: 1_000,
          output_qty: 1,
          component_variant_id: 100,
          component_product_id: 1_000,
          qty: 5,
        },
      ]))
      .mockResolvedValueOnce(rows([{ id: 200, product_id: 1_000 }]))
      .mockResolvedValueOnce(rows([
        { id: 100, product_id: 1_000, units_per_variant: 1 },
        { id: 200, product_id: 1_000, units_per_variant: 5 },
        { id: 300, product_id: 1_000, units_per_variant: 25 },
      ]))
      .mockResolvedValueOnce(rows([
        { product_variant_id: 200, warehouse_id: 1, warehouse_location_id: 21, available_qty: "-10" },
        { product_variant_id: 300, warehouse_id: 1, warehouse_location_id: 22, available_qty: "2" },
      ]))
      .mockResolvedValueOnce(rows([
        { product_variant_id: 100, warehouse_id: 1, warehouse_location_id: 20 },
        { product_variant_id: 200, warehouse_id: 1, warehouse_location_id: 21 },
      ]));
    const service = new RecipeCapacityService({ execute });

    await expect(service.getVariantCapacity(200, 1)).resolves.toBe(0);
  });
});
