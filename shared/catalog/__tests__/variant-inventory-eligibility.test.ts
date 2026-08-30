import { describe, expect, it } from "vitest";

import { isDigitalVariant, isInventoryManagedVariant } from "../variant-inventory-eligibility";

describe("variant inventory eligibility", () => {
  it.each([
    [{ requiresShipping: true, trackInventory: true }, true],
    [{ requiresShipping: true, trackInventory: null }, true],
    [{}, true],
    [{ requiresShipping: true, trackInventory: false }, false],
    [{ requiresShipping: false, trackInventory: false }, false],
  ] as const)("classifies %j as inventoryManaged=%s", (input, expected) => {
    expect(isInventoryManagedVariant(input)).toBe(expected);
  });

  it("identifies only explicit non-shipping variants as digital", () => {
    expect(isDigitalVariant({ requiresShipping: false })).toBe(true);
    expect(isDigitalVariant({ requiresShipping: true })).toBe(false);
    expect(isDigitalVariant({})).toBe(false);
  });
});
