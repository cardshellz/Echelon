import { describe, expect, it } from "vitest";
import { validateVariantUomWrite } from "../../variant-uom";

describe("validateVariantUomWrite", () => {
  it("accepts a complete Each definition", () => {
    expect(validateVariantUomWrite({
      uomType: "each",
      unitsPerVariant: 1,
      hierarchyLevel: 1,
      parentVariantId: null,
      isBaseUnit: true,
    })).toEqual({ uomType: "each" });
  });

  it.each([
    [{ unitsPerVariant: 2 }, "exactly 1 unit"],
    [{ hierarchyLevel: 2 }, "hierarchy level 1"],
    [{ parentVariantId: 9 }, "cannot break into"],
    [{ isBaseUnit: false }, "base inventory unit"],
  ])("rejects an invalid Each invariant", (override, message) => {
    expect(() => validateVariantUomWrite({
      uomType: "each",
      unitsPerVariant: 1,
      hierarchyLevel: 1,
      parentVariantId: null,
      isBaseUnit: true,
      ...override,
    })).toThrow(message);
  });

  it("validates partial updates against the stored Each state", () => {
    expect(() => validateVariantUomWrite(
      { unitsPerVariant: 5 },
      {
        uomType: "each",
        unitsPerVariant: 1,
        hierarchyLevel: 1,
        parentVariantId: null,
        isBaseUnit: true,
      },
    )).toThrow("exactly 1 unit");
  });

  it("rejects unknown UOM values", () => {
    expect(() => validateVariantUomWrite({ uomType: "carton" })).toThrow(
      "uomType must be one of",
    );
  });
});
