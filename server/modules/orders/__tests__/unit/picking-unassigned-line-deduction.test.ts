/**
 * Deduction behaviour for an order line that reached the gun with no bin
 * (location UNASSIGNED) — the 2026-09 SHLZ-MAG-STND-P5 incident.
 *
 * Invariants protected:
 *   1. An unassigned line still only picks through the full-quantity fallback;
 *      partial stock never auto-resolves without a bin confirmation.
 *   2. When the fallback finds nothing, the failure reports the real shelf
 *      state (best stocked pickable bin and its quantity) instead of "no stock"
 *      with systemQty 0, and nothing is deducted.
 *   3. Zero stock anywhere keeps the original wording.
 */
import { describe, expect, it, vi } from "vitest";
import { PickingUseCases } from "../../picking.use-cases";

type Level = { warehouseLocationId: number; variantQty: number };

const PICK_FACE = { isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick", warehouseId: 1 };
const LOCATIONS = [
  { id: 1, code: "E-12", ...PICK_FACE },
  { id: 2, code: "F-03", ...PICK_FACE },
  { id: 9, code: "RESERVE-1", ...PICK_FACE, isPickable: 0, locationType: "reserve" },
];

function makeService(levels: Level[]) {
  const storage = {
    getProductVariantBySku: vi.fn(async (sku: string) => ({ id: 100, sku, productId: 10, unitsPerVariant: 1 })),
    getInventoryLevelsByProductVariantId: vi.fn(async () => levels.map((level) => ({ ...level }))),
    getAllWarehouseLocations: vi.fn(async () => LOCATIONS),
    getOrderById: vi.fn(async () => ({ id: 900, orderNumber: "#900", warehouseId: 1, assignedPickerId: "picker-1" })),
    getPendingReplenTasksForLocation: vi.fn(async () => []),
    updateReplenTask: vi.fn(async () => ({})),
  };
  const inventoryCore = {
    adjustInventory: vi.fn(async () => ({})),
    pickItem: vi.fn(async (params: { warehouseLocationId: number; qty: number }) => {
      const level = levels.find((l) => l.warehouseLocationId === params.warehouseLocationId);
      if (!level || level.variantQty < params.qty) return false;
      level.variantQty -= params.qty;
      return true;
    }),
    getLevel: vi.fn(async (_variantId: number, warehouseLocationId: number) => {
      const level = levels.find((l) => l.warehouseLocationId === warehouseLocationId);
      return level ? { ...level, productVariantId: 100 } : null;
    }),
    logTransaction: vi.fn(async () => ({})),
  };
  const replenishment = {
    checkReplenNeeded: vi.fn(async () => ({
      needed: false, stockout: false, sourceLocationCode: null, sourceVariantSku: null,
      sourceVariantName: null, qtyTargetUnits: 0, replenMethod: "full_case", executionMode: "queue",
    })),
    createAndExecuteReplen: vi.fn(async () => null),
  };
  const service = new PickingUseCases({} as any, inventoryCore as any, replenishment as any, storage as any);
  return { service, storage, inventoryCore };
}

function unassignedLine(quantity: number) {
  return {
    id: 500, orderId: 900, sku: "SHLZ-MAG-STND-P5", name: "Mag Stand P5",
    quantity, pickedQuantity: quantity, location: "UNASSIGNED", zone: "U", status: "completed", shortReason: null,
  } as any;
}

async function deduct(service: PickingUseCases, item: any) {
  return (service as any)._deductInventory(item, item, { warehouseId: 1, pickMethod: "pick_all" });
}

describe("PickingUseCases._deductInventory :: line with no assigned bin", () => {
  it("reports the best stocked bin and its quantity when no single bin covers the line", async () => {
    const { service, inventoryCore } = makeService([
      { warehouseLocationId: 1, variantQty: 2 },
      { warehouseLocationId: 9, variantQty: 40 }, // reserve stock is not pickable
    ]);

    const result = await deduct(service, unassignedLine(4));

    expect(result).toMatchObject({
      success: false,
      error: "no_inventory",
      locationId: 1,
      locationCode: "E-12",
      systemQty: 2,
      pickerBlocking: false,
      shipmentBlocking: true,
    });
    expect(result.message).toContain("no assigned pick bin");
    expect(result.message).toContain("no single pickable bin holds 4");
    expect(result.message).toContain("E-12 with 2");
    expect(result.message).toContain("Confirm the bin");
    expect(inventoryCore.pickItem).not.toHaveBeenCalled();
    expect(inventoryCore.adjustInventory).not.toHaveBeenCalled();
  });

  it("names the bin with the most stock when several pickable bins fall short", async () => {
    const { service } = makeService([
      { warehouseLocationId: 1, variantQty: 2 },
      { warehouseLocationId: 2, variantQty: 3 },
    ]);

    const result = await deduct(service, unassignedLine(4));

    expect(result).toMatchObject({ success: false, error: "no_inventory", locationCode: "F-03", systemQty: 3 });
    expect(result.message).toContain("F-03 with 3");
  });

  it("keeps the original wording and no bin context when nothing pickable has stock", async () => {
    const { service } = makeService([
      { warehouseLocationId: 1, variantQty: 0 },
      { warehouseLocationId: 9, variantQty: 12 },
    ]);

    const result = await deduct(service, unassignedLine(1));

    expect(result).toMatchObject({
      success: false,
      error: "no_inventory",
      message: "No pickable location has any stock for SHLZ-MAG-STND-P5",
      locationId: null,
      locationCode: null,
      systemQty: 0,
    });
  });

  it("still deducts through the full-quantity fallback when one pickable bin covers the line", async () => {
    const { service, inventoryCore } = makeService([{ warehouseLocationId: 1, variantQty: 5 }]);

    const result = await deduct(service, unassignedLine(4));

    expect(result).toMatchObject({ success: true, locationId: 1, locationCode: "E-12" });
    expect(inventoryCore.pickItem).toHaveBeenCalledWith(expect.objectContaining({ warehouseLocationId: 1, qty: 4 }));
  });
});
