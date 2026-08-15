import { describe, expect, it, vi } from "vitest";
import { BuildQueryRepository } from "../../infrastructure/build-query.repository";

describe("BuildQueryRepository product relationships", () => {
  it("groups output and component recipes by the catalog variant", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { id: 10, sku: "BOX-EA", name: "Storage Box Each", is_active: 1 },
          { id: 20, sku: "BOX-P5", name: "Storage Box Pack of 5", is_active: 1 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            relationship_kind: "used_in",
            subject_variant_id: 10,
            quantity_per_build: 5,
            recipe_id: 1,
            recipe_code: "BOX-P5",
            recipe_name: "Build pack of five",
            recipe_version: 1,
            recipe_status: "active",
            output_variant_id: 20,
            output_sku: "BOX-P5",
            output_name: "Storage Box Pack of 5",
            output_qty: 1,
          },
          {
            relationship_kind: "produced_by",
            subject_variant_id: 20,
            quantity_per_build: 1,
            recipe_id: 1,
            recipe_code: "BOX-P5",
            recipe_name: "Build pack of five",
            recipe_version: 1,
            recipe_status: "active",
            output_variant_id: 20,
            output_sku: "BOX-P5",
            output_name: "Storage Box Pack of 5",
            output_qty: 1,
          },
        ],
      });
    const repository = new BuildQueryRepository({ execute } as any);

    const result = await repository.listProductRelationships(99);

    expect(result).toEqual([
      expect.objectContaining({
        variantId: 10,
        usedIn: [expect.objectContaining({ recipeId: 1, quantityPerBuild: 5 })],
        producedBy: [],
      }),
      expect.objectContaining({
        variantId: 20,
        producedBy: [expect.objectContaining({ recipeId: 1, quantityPerBuild: 1 })],
        usedIn: [],
      }),
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not query recipes when the product has no variants", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [] });
    const repository = new BuildQueryRepository({ execute } as any);

    await expect(repository.listProductRelationships(99)).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});