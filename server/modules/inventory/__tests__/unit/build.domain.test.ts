import { describe, expect, it } from "vitest";
import {
  allocateBuildCostLayers,
  BuildDomainError,
  calculateBuildQuantities,
  sumLayerValue,
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
});
