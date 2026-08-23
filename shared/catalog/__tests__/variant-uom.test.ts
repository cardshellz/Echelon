import { describe, expect, it } from "vitest";
import {
  getVariantUomDefinition,
  inferLegacyVariantUomType,
  isSingleUnitVariantUomType,
  isVariantUomType,
} from "../variant-uom";

describe("variant UOM definitions", () => {
  it("defines Piece as a distinct raw-component inventory unit", () => {
    expect(getVariantUomDefinition("piece")).toEqual({
      type: "piece",
      label: "Piece",
      skuPrefix: "PC",
      defaultHierarchyLevel: 1,
    });
    expect(isSingleUnitVariantUomType("piece")).toBe(true);
    expect(isSingleUnitVariantUomType("each")).toBe(true);
  });

  it("defines Each as an unsuffixed hierarchy-one inventory unit", () => {
    expect(getVariantUomDefinition("each")).toEqual({
      type: "each",
      label: "Each",
      skuPrefix: null,
      defaultHierarchyLevel: 1,
    });
  });

  it("preserves legacy hierarchy-one packs during inference", () => {
    expect(inferLegacyVariantUomType({
      hierarchyLevel: 1,
      unitsPerVariant: 5,
      isBaseUnit: false,
    })).toBe("pack");
  });

  it("does not relabel a higher-level legacy base record as Each", () => {
    expect(inferLegacyVariantUomType({
      hierarchyLevel: 2,
      unitsPerVariant: 1,
      isBaseUnit: true,
      parentVariantId: null,
    })).toBe("inner_pack");
  });
  it("infers a one-unit base variant as Each", () => {
    expect(inferLegacyVariantUomType({
      hierarchyLevel: 1,
      unitsPerVariant: 1,
      isBaseUnit: true,
    })).toBe("each");
  });

  it("accepts only supported UOM values", () => {
    expect(isVariantUomType("piece")).toBe(true);
    expect(isVariantUomType("inner_pack")).toBe(true);
    expect(isVariantUomType("carton")).toBe(false);
  });
});
