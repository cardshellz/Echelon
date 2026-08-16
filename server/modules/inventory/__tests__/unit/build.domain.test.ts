import { describe, expect, it } from "vitest";
import {
  allocateBuildCostLayers,
  assertBuildRunOutputUntouched,
  assertBuildVariantSnapshotsCurrent,
  BuildDomainError,
  calculateBuildQuantities,
  calculateBuildReversalProgress,
  calculateBuildRunQuantities,
  sumLayerValue,
  validateBuildRecipeDefinition,
} from "../../domain/build.domain";

describe("inventory build domain", () => {
  it("calculates generic multi-component requirements without assuming product type", () => {
    expect(calculateBuildQuantities({
      plannedBuilds: 10,
      outputQtyPerBuild: 1,
      components: [
        { componentVariantId: 11, qtyPerBuild: 5 },
        { componentVariantId: 12, qtyPerBuild: 2 },
      ],
    })).toEqual({
      outputQty: 10,
      components: [
        { componentVariantId: 11, requiredQty: 50 },
        { componentVariantId: 12, requiredQty: 20 },
      ],
    });
  });

  it("rejects duplicate components", () => {
    expect(() => calculateBuildQuantities({
      plannedBuilds: 1,
      outputQtyPerBuild: 1,
      components: [
        { componentVariantId: 11, qtyPerBuild: 2 },
        { componentVariantId: 11, qtyPerBuild: 3 },
      ],
    })).toThrowError(expect.objectContaining<Partial<BuildDomainError>>({
      code: "DUPLICATE_BUILD_COMPONENT",
    }));
  });

  it("rejects unsafe quantity multiplication", () => {
    expect(() => calculateBuildQuantities({
      plannedBuilds: Number.MAX_SAFE_INTEGER,
      outputQtyPerBuild: 2,
      components: [{ componentVariantId: 11, qtyPerBuild: 1 }],
    })).toThrowError(expect.objectContaining<Partial<BuildDomainError>>({
      code: "BUILD_QUANTITY_OVERFLOW",
    }));
  });

  it("accepts a same-product repack that conserves exact base units", () => {
    expect(validateBuildRecipeDefinition({
      recipeType: "conversion",
      output: { variantId: 20, productId: 100, unitsPerVariant: 5, qtyPerBuild: 1 },
      components: [
        { variantId: 10, productId: 100, unitsPerVariant: 1, qtyPerBuild: 5 },
      ],
    })).toEqual({
      recipeType: "conversion",
      sameProduct: true,
      inputBaseUnits: 5,
      outputBaseUnits: 5,
    });
  });

  it("accepts a case break represented as a conserved conversion recipe", () => {
    expect(validateBuildRecipeDefinition({
      recipeType: "conversion",
      output: { variantId: 20, productId: 100, unitsPerVariant: 5, qtyPerBuild: 20 },
      components: [
        { variantId: 30, productId: 100, unitsPerVariant: 100, qtyPerBuild: 1 },
      ],
    })).toMatchObject({
      inputBaseUnits: 100,
      outputBaseUnits: 100,
    });
  });

  it("rejects cross-product variants in a conversion", () => {
    expect(() => validateBuildRecipeDefinition({
      recipeType: "conversion",
      output: { variantId: 20, productId: 100, unitsPerVariant: 5, qtyPerBuild: 1 },
      components: [
        { variantId: 10, productId: 200, unitsPerVariant: 1, qtyPerBuild: 5 },
      ],
    })).toThrowError(expect.objectContaining<Partial<BuildDomainError>>({
      code: "BUILD_CONVERSION_PRODUCT_MISMATCH",
    }));
  });
  it("rejects an output variant reused as a component", () => {
    expect(() => validateBuildRecipeDefinition({
      recipeType: "conversion",
      output: { variantId: 10, productId: 4, unitsPerVariant: 5, qtyPerBuild: 1 },
      components: [
        { variantId: 10, productId: 4, unitsPerVariant: 5, qtyPerBuild: 1 },
      ],
    })).toThrowError(expect.objectContaining<Partial<BuildDomainError>>({
      code: "BUILD_OUTPUT_IS_COMPONENT",
    }));
  });

  it("rejects duplicate component variants", () => {
    expect(() => validateBuildRecipeDefinition({
      recipeType: "conversion",
      output: { variantId: 10, productId: 4, unitsPerVariant: 10, qtyPerBuild: 1 },
      components: [
        { variantId: 11, productId: 4, unitsPerVariant: 5, qtyPerBuild: 1 },
        { variantId: 11, productId: 4, unitsPerVariant: 5, qtyPerBuild: 1 },
      ],
    })).toThrowError(expect.objectContaining<Partial<BuildDomainError>>({
      code: "DUPLICATE_BUILD_COMPONENT",
    }));
  });


  it("rejects a same-product conversion that creates or destroys base units", () => {
    expect(() => validateBuildRecipeDefinition({
      recipeType: "conversion",
      output: { variantId: 20, productId: 100, unitsPerVariant: 5, qtyPerBuild: 1 },
      components: [
        { variantId: 10, productId: 100, unitsPerVariant: 1, qtyPerBuild: 4 },
      ],
    })).toThrowError(expect.objectContaining<Partial<BuildDomainError>>({
      code: "BUILD_CONVERSION_NOT_CONSERVED",
    }));
  });

  it("prevents bypassing conversion safeguards with an assembly label", () => {
    expect(() => validateBuildRecipeDefinition({
      recipeType: "assembly",
      output: { variantId: 20, productId: 100, unitsPerVariant: 5, qtyPerBuild: 1 },
      components: [
        { variantId: 10, productId: 100, unitsPerVariant: 1, qtyPerBuild: 5 },
      ],
    })).toThrowError(expect.objectContaining<Partial<BuildDomainError>>({
      code: "BUILD_ASSEMBLY_REQUIRES_CROSS_PRODUCT_COMPONENT",
    }));
  });

  it("accepts an assembly containing a component from another product", () => {
    expect(validateBuildRecipeDefinition({
      recipeType: "assembly",
      output: { variantId: 20, productId: 100, unitsPerVariant: 1, qtyPerBuild: 1 },
      components: [
        { variantId: 10, productId: 100, unitsPerVariant: 1, qtyPerBuild: 1 },
        { variantId: 11, productId: 200, unitsPerVariant: 1, qtyPerBuild: 1 },
      ],
    })).toMatchObject({
      recipeType: "assembly",
      sameProduct: false,
    });
  });

  it("blocks execution when catalog product or UOM facts drift from snapshots", () => {
    expect(() => assertBuildVariantSnapshotsCurrent({
      snapshots: [{ variantId: 10, productId: 100, unitsPerVariant: 5 }],
      currentVariants: new Map([
        [10, { variantId: 10, productId: 100, unitsPerVariant: 10 }],
      ]),
      context: { buildOrderId: 77 },
    })).toThrowError(expect.objectContaining<Partial<BuildDomainError>>({
      code: "BUILD_CATALOG_CONFIGURATION_CHANGED",
      context: expect.objectContaining({ buildOrderId: 77, variantId: 10 }),
    }));
  });
  it("preserves exact integer-mill value and breakdown across remainder layers", () => {
    const totals = {
      poMills: BigInt(1001),
      packagingMills: BigInt(103),
      landedMills: BigInt(17),
    };
    const layers = allocateBuildCostLayers(totals, 10);
    const summed = sumLayerValue(layers);

    expect(layers.length).toBeGreaterThan(1);
    expect(layers.reduce((qty, layer) => qty + layer.qty, 0)).toBe(10);
    expect(summed).toEqual({
      ...totals,
      totalMills: totals.poMills + totals.packagingMills + totals.landedMills,
    });
  });

  it("rejects negative cost instead of manufacturing a positive output value", () => {
    expect(() => allocateBuildCostLayers({
      poMills: BigInt(-1),
      packagingMills: BigInt(0),
      landedMills: BigInt(0),
    }, 1)).toThrowError(expect.objectContaining<Partial<BuildDomainError>>({
      code: "NEGATIVE_BUILD_COST",
    }));
  });

  it("calculates an exact partial run against remaining build work", () => {
    expect(calculateBuildRunQuantities({
      plannedBuilds: 10,
      completedBuilds: 4,
      requestedBuilds: 3,
      outputQtyPerBuild: 2,
      components: [{ componentVariantId: 11, qtyPerBuild: 5 }],
    })).toEqual({
      buildsCompleted: 3,
      remainingBuildsBefore: 6,
      remainingBuildsAfter: 3,
      outputQty: 6,
      components: [{ componentVariantId: 11, requiredQty: 15 }],
    });
  });

  it("rejects a partial run that exceeds remaining work", () => {
    expect(() => calculateBuildRunQuantities({
      plannedBuilds: 10,
      completedBuilds: 8,
      requestedBuilds: 3,
      outputQtyPerBuild: 1,
      components: [{ componentVariantId: 11, qtyPerBuild: 1 }],
    })).toThrowError(expect.objectContaining<Partial<BuildDomainError>>({
      code: "BUILD_RUN_EXCEEDS_REMAINING",
    }));
  });

  it("keeps a partially completed order in progress after reversing its latest run", () => {
    expect(calculateBuildReversalProgress({
      completedBuilds: 8,
      reversedBuilds: 3,
    })).toEqual({ completedBuilds: 5, status: "in_progress" });
  });

  it("returns an order to released when its only completed run is reversed", () => {
    expect(calculateBuildReversalProgress({
      completedBuilds: 3,
      reversedBuilds: 3,
    })).toEqual({ completedBuilds: 0, status: "released" });
  });

  it("rejects reversal progress that exceeds completed work", () => {
    expect(() => calculateBuildReversalProgress({
      completedBuilds: 2,
      reversedBuilds: 3,
    })).toThrowError(expect.objectContaining<Partial<BuildDomainError>>({
      code: "INVALID_BUILD_PROGRESS",
    }));
  });

  it("allows reversal only for the latest untouched output run", () => {
    expect(() => assertBuildRunOutputUntouched({
      buildRunId: 12,
      latestPostedRunId: 12,
      outputLocationId: 5,
      outputLots: [{
        lotId: 99,
        warehouseLocationId: 5,
        qtyReceived: 20,
        qtyOnHand: 20,
        qtyReserved: 0,
        qtyPicked: 0,
      }],
    })).not.toThrow();
  });

  it("blocks reversal after output inventory has changed", () => {
    expect(() => assertBuildRunOutputUntouched({
      buildRunId: 12,
      latestPostedRunId: 12,
      outputLocationId: 5,
      outputLots: [{
        lotId: 99,
        warehouseLocationId: 5,
        qtyReceived: 20,
        qtyOnHand: 19,
        qtyReserved: 0,
        qtyPicked: 0,
      }],
    })).toThrowError(expect.objectContaining<Partial<BuildDomainError>>({
      code: "BUILD_OUTPUT_ALREADY_USED",
    }));
  });

});
