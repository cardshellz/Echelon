import { describe, expect, it } from "vitest";
import { parseInventoryTrackingWrite, resolveInventoryTrackingPolicy } from "@shared/catalog/inventory-tracking-policy";

describe("product inventory default and variant override", () => {
  for (const productDefault of [true, false]) {
    for (const override of [null, true, false]) {
      it(`product ${productDefault}, override ${override}: resolves physical and digital eligibility`, () => {
        const policy = Object.freeze({ inventoryTrackingDefault: productDefault, inventoryTrackingOverride: override, requiresShipping: true });
        expect(resolveInventoryTrackingPolicy(policy)).toBe(override ?? productDefault);
        expect(resolveInventoryTrackingPolicy({ ...policy, requiresShipping: false })).toBe(false);
      });
    }
  }
  it("preserves omission, explicit inheritance, and both legacy boolean choices", () => {
    expect(parseInventoryTrackingWrite({})).toEqual({});
    expect(parseInventoryTrackingWrite({ inventoryTrackingOverride: null })).toEqual({ inventoryTrackingOverride: null });
    for (const choice of [true, false]) {
      expect(parseInventoryTrackingWrite({ trackInventory: choice })).toEqual({ inventoryTrackingOverride: choice });
    }
  });
  it("rejects ambiguous and malformed writes", () => {
    expect(() => parseInventoryTrackingWrite({ trackInventory: false, inventoryTrackingOverride: null })).toThrow();
    for (const invalid of [0, 1, "false", [], {}]) {
      expect(() => parseInventoryTrackingWrite({ inventoryTrackingOverride: invalid })).toThrow();
      expect(() => resolveInventoryTrackingPolicy({ inventoryTrackingDefault: invalid, inventoryTrackingOverride: null, requiresShipping: true } as never)).toThrow();
    }
  });
});
