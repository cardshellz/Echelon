import { describe, expect, it } from "vitest";
import { allowedCaseBreakSources } from "../allowed-case-breaks";
import type { AllowedInventoryConversion } from "@shared/types/inventory-conversions";

const variant = (variantId: number, allowedConversions: AllowedInventoryConversion[] = []) => ({
  variantId, productId: 10, locationCount: 1, variantQty: 1, allowedConversions,
});
const path = (sourceVariantId: number, destinationVariantId: number): AllowedInventoryConversion => ({
  sourceVariantId, destinationVariantId, operationType: "break_pack", inputQty: 1, outputQty: 5,
});

describe("allowed manual case breaks", () => {
  it("offers the direct saved direction without consulting a parent or unit ratio", () => {
    const target = { ...variant(1, [path(2, 1)]), parentVariantId: 999 };
    const source = { ...variant(2), parentVariantId: null };
    expect(allowedCaseBreakSources(target, [target, source])).toEqual([{ source, conversion: path(2, 1) }]);
  });
  it("does not infer any path for physical-only stock from old parent metadata", () => {
    const target = { ...variant(1), parentVariantId: null };
    const source = { ...variant(2), parentVariantId: 1 };
    expect(allowedCaseBreakSources(target, [target, source])).toEqual([]);
  });
  it("does not collapse a multilevel chain into an unauthorized shortcut", () => {
    const each = variant(1, [path(2, 1)]);
    const pack = variant(2, [path(3, 2)]);
    const box = variant(3);
    expect(allowedCaseBreakSources(each, [each, pack, box]).map(entry => entry.source.variantId)).toEqual([2]);
  });
  it("does not expose recipes, reverse directions, malformed or foreign-product paths as case breaks", () => {
    const target = variant(1, [
      { ...path(2, 1), operationType: "directed_conversion" },
      { ...path(2, 1), operationType: "assemble_pack" },
      path(1, 2), { ...path(2, 1), inputQty: 0 }, path(3, 1),
    ]);
    expect(allowedCaseBreakSources(target, [target, variant(2), { ...variant(3), productId: 99 }])).toEqual([]);
  });
});
