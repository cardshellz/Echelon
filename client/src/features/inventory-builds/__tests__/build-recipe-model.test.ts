import { describe, expect, it } from "vitest";
import { calculateRecipeEvidence, type BuildVariantResult } from "../build-recipe-model";

function variant(input: Partial<BuildVariantResult> & Pick<BuildVariantResult, "productVariantId" | "productId">): BuildVariantResult {
  return {
    unitsPerVariant: 1,
    sku: `SKU-${input.productVariantId}`,
    name: `Variant ${input.productVariantId}`,
    ...input,
  };
}

describe("calculateRecipeEvidence", () => {
  it("accepts a cross-product assembly without requiring base-unit conservation", () => {
    const result = calculateRecipeEvidence({
      recipeType: "assembly",
      outputVariant: variant({ productVariantId: 10, productId: 100 }),
      outputQty: "1",
      components: [
        { key: 1, variant: variant({ productVariantId: 20, productId: 200 }), qtyPerBuild: "1" },
        { key: 2, variant: variant({ productVariantId: 30, productId: 300 }), qtyPerBuild: "2" },
      ],
    });

    expect(result).toEqual({
      valid: true,
      inputBaseUnits: BigInt(3),
      outputBaseUnits: BigInt(1),
      message: "Cross-product assembly.",
    });
  });

  it("accepts a same-product conversion only when base units are conserved", () => {
    const output = variant({ productVariantId: 11, productId: 100, unitsPerVariant: 5 });
    const each = variant({ productVariantId: 12, productId: 100, unitsPerVariant: 1 });

    expect(calculateRecipeEvidence({
      recipeType: "conversion",
      outputVariant: output,
      outputQty: "1",
      components: [{ key: 1, variant: each, qtyPerBuild: "5" }],
    })?.valid).toBe(true);
    expect(calculateRecipeEvidence({
      recipeType: "conversion",
      outputVariant: output,
      outputQty: "1",
      components: [{ key: 1, variant: each, qtyPerBuild: "4" }],
    })).toMatchObject({ valid: false, message: "Input and output base units must match exactly." });
  });

  it("rejects duplicate components and output self-consumption", () => {
    const output = variant({ productVariantId: 10, productId: 100 });
    const component = variant({ productVariantId: 20, productId: 200 });

    expect(calculateRecipeEvidence({
      recipeType: "assembly",
      outputVariant: output,
      outputQty: "1",
      components: [
        { key: 1, variant: component, qtyPerBuild: "1" },
        { key: 2, variant: component, qtyPerBuild: "1" },
      ],
    })).toMatchObject({ valid: false, message: "Each component variant can only be added once." });
    expect(calculateRecipeEvidence({
      recipeType: "assembly",
      outputVariant: output,
      outputQty: "1",
      components: [{ key: 1, variant: output, qtyPerBuild: "1" }],
    })).toMatchObject({ valid: false, message: "The output variant cannot also be a component." });
  });
});
