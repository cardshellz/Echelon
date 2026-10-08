import { describe, expect, it } from "vitest";
import { planProductAssetScopeChange } from "../../product-asset-scope.domain";

describe("catalog photo assignment decisions", () => {
  it.each([[10, null], [null, 10], [10, 11]] as const)("changes scope %s to %s", (before, after) => {
    expect(planProductAssetScopeChange(before, { productVariantId: after, expectedProductVariantId: before })).toBe(true);
  });
  it.each([null, 10])("accepts an observed no-op %s", scope => {
    expect(planProductAssetScopeChange(scope, { productVariantId: scope, expectedProductVariantId: scope })).toBe(false);
  });
  it.each([[10, null], [null, 10]] as const)("rejects a stale snapshot even if the target now matches", (current, observed) => {
    expect(() => planProductAssetScopeChange(current, { productVariantId: current, expectedProductVariantId: observed }))
      .toThrowError(expect.objectContaining({ code: "ASSET_SCOPE_CHANGED", status: 409 }));
  });
});
