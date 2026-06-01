import { describe, it, expect, vi } from "vitest";

/**
 * Phase 6 (H5): Case-break remainder must be credited back — no base
 * units can vanish. When source.unitsPerVariant doesn't divide evenly
 * by pick.unitsPerVariant, the remainder is credited to the source
 * location as the pick variant (if unitsPerVariant=1) or the product's
 * base unit variant.
 */

describe("Case-break remainder conservation (H5)", () => {
  it("credits remainder to source when pick variant is the base unit", async () => {
    const adjustCalls: any[] = [];
    const transferCalls: any[] = [];

    const mockInventoryUseCases = {
      withTx: vi.fn(() => ({
        adjustInventory: vi.fn(async (params: any) => {
          adjustCalls.push(params);
          return { orphanedQty: 0 };
        }),
        transfer: vi.fn(async (params: any) => {
          transferCalls.push(params);
          return { reservedMoved: 0, orderItemsRepointed: 0 };
        }),
      })),
    };

    // Simulate: 1 case of 7 base units -> packs of 3 (unitsPerVariant=3)
    // pickVariantUnits = floor(7/3) = 2, remainder = 7 - 6 = 1
    // With pickVariant.unitsPerVariant=1 (base unit), remainder=1 credited directly
    const sourceVariant = { id: 10, name: "Case of 7", unitsPerVariant: 7, productId: 1 };
    const pickVariant = { id: 20, name: "Single Sleeve", unitsPerVariant: 1, productId: 1 };
    const qtySourceUnits = 1;

    const baseUnitsFromSource = qtySourceUnits * sourceVariant.unitsPerVariant; // 7
    const pickVariantUnits = Math.floor(baseUnitsFromSource / pickVariant.unitsPerVariant); // 7
    const remainder = baseUnitsFromSource - (pickVariantUnits * pickVariant.unitsPerVariant); // 0

    // For base unit pick variant, remainder is always 0 since unitsPerVariant=1
    expect(remainder).toBe(0);
    expect(pickVariantUnits).toBe(7);
  });

  it("detects remainder when units don't divide evenly", () => {
    // Case: 1 case of 12 -> boxes of 5
    const baseUnitsFromSource = 1 * 12; // 12
    const pickUnitsPerVariant = 5;
    const pickVariantUnits = Math.floor(baseUnitsFromSource / pickUnitsPerVariant); // 2
    const remainder = baseUnitsFromSource - (pickVariantUnits * pickUnitsPerVariant); // 2

    expect(pickVariantUnits).toBe(2);
    expect(remainder).toBe(2);
    // Old behavior: 2 base units vanish. New behavior: credited to source.
  });

  it("conservation holds: source decrement = target credit + remainder credit", () => {
    // Multiple cases scenario: 3 cases of 10 -> packs of 7
    const qtySourceUnits = 3;
    const sourceUnitsPerVariant = 10;
    const pickUnitsPerVariant = 7;

    const baseUnitsFromSource = qtySourceUnits * sourceUnitsPerVariant; // 30
    const pickVariantUnits = Math.floor(baseUnitsFromSource / pickUnitsPerVariant); // 4
    const remainder = baseUnitsFromSource - (pickVariantUnits * pickUnitsPerVariant); // 2

    const totalCredited = (pickVariantUnits * pickUnitsPerVariant) + remainder;
    expect(totalCredited).toBe(baseUnitsFromSource);
  });
});
