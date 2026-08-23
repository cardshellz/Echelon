import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createInventoryTreatmentDraft,
  filterPickableReturnLocations,
  validateInventoryTreatmentDraft,
} from "../ApplyReturnInventoryTreatmentDialog";
import type {
  ReturnCaseDetailItem,
  ReturnCaseInventoryTreatmentSummary,
  ReturnWarehouseLocation,
} from "../return-case-admin-api";

const items = [
  { id: 11, title: "Sellable item", sku: "SKU-SELL", externalLineItemId: "line-11" },
  { id: 12, title: "Held item", sku: "SKU-HOLD", externalLineItemId: "line-12" },
] as ReturnCaseDetailItem[];

function summary(): ReturnCaseInventoryTreatmentSummary {
  return {
    dispositionUnits: 4,
    appliedUnits: 1,
    remainingUnits: 3,
    fullyApplied: false,
    partiallyApplied: true,
    items: [
      {
        dispositionItemId: 91,
        returnCaseItemId: 11,
        treatment: "restock_sellable",
        quantity: 2,
        warehouseLocationId: null,
        inventoryTransactionId: null,
        inventoryLotId: null,
        applied: false,
      },
      {
        dispositionItemId: 92,
        returnCaseItemId: 12,
        treatment: "hold_non_sellable",
        quantity: 1,
        warehouseLocationId: null,
        inventoryTransactionId: null,
        inventoryLotId: null,
        applied: false,
      },
      {
        dispositionItemId: 93,
        returnCaseItemId: 12,
        treatment: "hold_non_sellable",
        quantity: 1,
        warehouseLocationId: null,
        inventoryTransactionId: null,
        inventoryLotId: null,
        applied: true,
      },
    ],
  };
}

describe("return inventory treatment dialog contract", () => {
  it("builds drafts only for unapplied immutable sources and never defaults a sellable location", () => {
    expect(createInventoryTreatmentDraft(items, summary())).toEqual([
      {
        dispositionItemId: 91,
        returnCaseItemId: 11,
        title: "Sellable item",
        sku: "SKU-SELL",
        treatment: "restock_sellable",
        quantity: 2,
        warehouseLocationId: "",
      },
      {
        dispositionItemId: 92,
        returnCaseItemId: 12,
        title: "Held item",
        sku: "SKU-HOLD",
        treatment: "hold_non_sellable",
        quantity: 1,
        warehouseLocationId: "",
      },
    ]);
  });

  it("requires an explicit positive location for sellable units and never sends one for held units", () => {
    const draft = createInventoryTreatmentDraft(items, summary());

    expect(validateInventoryTreatmentDraft(draft)).toMatchObject({
      success: false,
      formError: "Correct the inventory destinations before continuing.",
      fieldErrors: { 91: "Select an active, pickable inventory location." },
    });

    const valid = validateInventoryTreatmentDraft(draft.map((line) =>
      line.dispositionItemId === 91 ? { ...line, warehouseLocationId: "17" } : line));
    expect(valid).toEqual({
      success: true,
      fieldErrors: {},
      formError: null,
      lines: [
        { dispositionItemId: 91, expectedTreatment: "restock_sellable", expectedQuantity: 2, warehouseLocationId: 17 },
        { dispositionItemId: 92, expectedTreatment: "hold_non_sellable", expectedQuantity: 1, warehouseLocationId: null },
      ],
    });

    const heldWithLocation = validateInventoryTreatmentDraft(draft.map((line) =>
      line.dispositionItemId === 91
        ? { ...line, warehouseLocationId: "17" }
        : { ...line, warehouseLocationId: "18" }));
    expect(heldWithLocation.fieldErrors[92]).toBe("Held items cannot specify a sellable inventory location.");
  });

  it("offers only active, pickable, warehouse-bound, unfrozen locations in stable code order", () => {
    const locations: ReturnWarehouseLocation[] = [
      { id: 1, code: "B-02", name: null, warehouseId: 3, isActive: 1, isPickable: 1, cycleCountFreezeId: null },
      { id: 2, code: "A-01", name: "Primary", warehouseId: 3, isActive: 1, isPickable: 1, cycleCountFreezeId: null },
      { id: 3, code: "C-01", name: null, warehouseId: 3, isActive: 0, isPickable: 1, cycleCountFreezeId: null },
      { id: 4, code: "D-01", name: null, warehouseId: 3, isActive: 1, isPickable: 0, cycleCountFreezeId: null },
      { id: 5, code: "E-01", name: null, warehouseId: null, isActive: 1, isPickable: 1, cycleCountFreezeId: null },
      { id: 6, code: "F-01", name: null, warehouseId: 3, isActive: 1, isPickable: 1, cycleCountFreezeId: 99 },
    ];

    expect(filterPickableReturnLocations(locations).map((location) => location.id)).toEqual([2, 1]);
  });

  it("uses an internal operational confirmation without an acknowledgement checkbox", () => {
    const source = readFileSync(
      "client/src/components/returns/ApplyReturnInventoryTreatmentDialog.tsx",
      "utf8",
    );

    expect(source).not.toMatch(/\bCheckbox\b|I understand/);
    expect(source).toContain("This changes inventory only where explicitly shown");
    expect(source).toContain("does not issue a customer refund, settle a vendor balance, or close the return case");
  });
});
