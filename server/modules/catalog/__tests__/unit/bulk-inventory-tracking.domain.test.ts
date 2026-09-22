import { describe, expect, it } from "vitest";
import { buildBulkInventoryTrackingPreview, type BulkInventoryTrackingSelection } from "../../bulk-inventory-tracking.domain";

function selection(): BulkInventoryTrackingSelection {
  return [{ productId: 1, snapshot: { product: { name: "Product", sku: "PRODUCT", inventoryTrackingDefault: true, updatedAt: new Date("2026-09-21T12:00:00Z") },
    transitions: [null, true, false].map((override, index) => ({ variant: { id: index + 1, name: "Variant", sku: `V-${index}`,
      requiresShipping: true, inventoryTrackingOverride: override, trackInventory: override !== false, updatedAt: new Date("2026-09-21T12:00:00Z") },
      effective: override ?? false, blockers: [] })) } }];
}

describe("bulk inventory policy review", () => {
  it("reports only inherited effective changes and preserves both explicit overrides without mutating evidence", () => {
    const input = selection(); const before = structuredClone(input);
    expect(buildBulkInventoryTrackingPreview(input, false).products).toMatchObject([{ status: "change", changingVariantCount: 1,
      variantCount: 3, trackedOverrideCount: 1, untrackedOverrideCount: 1, blockers: [] }]);
    expect(input).toEqual(before);
  });
  it("fingerprints deterministically and invalidates review when an explicit choice, identity, date, or dependency changes", () => {
    const input = selection(); const original = buildBulkInventoryTrackingPreview(input, false);
    expect(buildBulkInventoryTrackingPreview(structuredClone(input), false)).toEqual(original);
    for (const mutate of [
      (value: BulkInventoryTrackingSelection) => { value[0].snapshot!.transitions[1].variant.inventoryTrackingOverride = null; },
      (value: BulkInventoryTrackingSelection) => { value[0].snapshot!.product.name = "Renamed"; },
      (value: BulkInventoryTrackingSelection) => { value[0].snapshot!.product.updatedAt = new Date("2026-09-22T12:00:00Z"); },
      (value: BulkInventoryTrackingSelection) => { value[0].snapshot!.transitions[0].blockers.push("stock"); },
    ]) {
      const changed = structuredClone(input); mutate(changed);
      expect(buildBulkInventoryTrackingPreview(changed, false).previewHash).not.toBe(original.previewHash);
    }
    expect(buildBulkInventoryTrackingPreview(input, true).previewHash).not.toBe(original.previewHash);
  });
  it("returns actionable blocker identities and retains unknown blocker codes", () => {
    const input = selection(); input[0].snapshot!.transitions[0].blockers = ["stock", "future_dependency"];
    expect(buildBulkInventoryTrackingPreview(input, false).products[0]).toMatchObject({ status: "blocked", blockers: [
      { variantId: 1, code: "stock", message: "V-0: stock or warehouse quantities" },
      { variantId: 1, code: "future_dependency", message: "V-0: future_dependency" },
    ] });
  });
  it("identifies already-set and missing products without silently dropping the selection", () => {
    const input = selection(); input[0].snapshot!.product.inventoryTrackingDefault = false;
    input.push({ productId: 2, snapshot: null });
    expect(buildBulkInventoryTrackingPreview(input, false).products.map(p => [p.productId, p.status])).toEqual([[1, "unchanged"], [2, "blocked"]]);
  });
});
