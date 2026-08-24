import { describe, expect, it } from "vitest";

import { calculateLegacyFungibleAvailability } from "../inventory-availability";

describe("calculateLegacyFungibleAvailability", () => {
  it("retains legacy case-break availability for physical fungible products", () => {
    const availability = calculateLegacyFungibleAvailability([
      { variantId: 200, parentVariantId: null, unitsPerVariant: 5, available: 2, inventoryStrategy: "physical_fungible" },
      { variantId: 300, parentVariantId: 200, unitsPerVariant: 25, available: 84, inventoryStrategy: "physical_fungible" },
    ]);

    expect(availability.get(200)).toBe(422);
  });

  it("does not overwrite server-projected recipe ATP with legacy hierarchy math", () => {
    const availability = calculateLegacyFungibleAvailability([
      { variantId: 100, parentVariantId: null, unitsPerVariant: 1, available: 2_200, inventoryStrategy: "recipe_managed" },
      { variantId: 200, parentVariantId: null, unitsPerVariant: 5, available: 440, inventoryStrategy: "recipe_managed" },
      { variantId: 300, parentVariantId: 200, unitsPerVariant: 25, available: 88, inventoryStrategy: "recipe_managed" },
    ]);

    expect(availability.has(100)).toBe(false);
    expect(availability.has(200)).toBe(false);
    expect(availability.has(300)).toBe(false);
  });
});
