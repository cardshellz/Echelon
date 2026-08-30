import { describe, expect, it } from "vitest";

import { coerceVariantFulfillmentOnPayload } from "../../catalog.routes";

describe("catalog variant fulfillment policy", () => {
  it("accepts each supported fulfillment mode", () => {
    expect(coerceVariantFulfillmentOnPayload({
      requiresShipping: true,
      trackInventory: true,
    })).toEqual({ requiresShipping: true, trackInventory: true });
    expect(coerceVariantFulfillmentOnPayload({
      requiresShipping: true,
      trackInventory: false,
    })).toEqual({ requiresShipping: true, trackInventory: false });
    expect(coerceVariantFulfillmentOnPayload({
      requiresShipping: false,
      trackInventory: false,
    })).toEqual({ requiresShipping: false, trackInventory: false });
  });

  it("rejects a digital variant that remains inventory tracked", () => {
    expect(() => coerceVariantFulfillmentOnPayload({
      requiresShipping: false,
      trackInventory: true,
    })).toThrow("Digital variants must set trackInventory to false");
    expect(() => coerceVariantFulfillmentOnPayload(
      { requiresShipping: false },
      { requiresShipping: true, trackInventory: true },
    )).toThrow("Digital variants must set trackInventory to false");
  });

  it("rejects nullable fulfillment flags on new writes", () => {
    expect(() => coerceVariantFulfillmentOnPayload({
      trackInventory: null,
    })).toThrow("requiresShipping and trackInventory must be booleans");
  });

  it("requires shipping to be restored before tracking a digital variant", () => {
    expect(() => coerceVariantFulfillmentOnPayload(
      { trackInventory: true },
      { requiresShipping: false, trackInventory: false },
    )).toThrow("Digital variants must set trackInventory to false");
    expect(coerceVariantFulfillmentOnPayload(
      { requiresShipping: true, trackInventory: true },
      { requiresShipping: false, trackInventory: false },
    )).toEqual({ requiresShipping: true, trackInventory: true });
  });
});
