import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { RecipeCapacityService } from "../../recipe-capacity.service";

describe("recipe-derived ATP invalidation", () => {
  it("returns every affected recipe-managed output product for a changed component", async () => {
    const execute = vi.fn(async () => ({
      rows: [{ product_id: 200 }, { product_id: 201 }],
    }));
    const service = new RecipeCapacityService({ execute });

    await expect(service.getAffectedOutputProductIds(100)).resolves.toEqual([200, 201]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("wires component inventory changes to affected output product sync", () => {
    const source = readFileSync(
      new URL("../../../../services/index.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("recipeCapacity.getAffectedOutputProductIds(productVariantId)");
    expect(source).toContain("queueProductInventorySync(productId, triggeredBy)");
  });
});
