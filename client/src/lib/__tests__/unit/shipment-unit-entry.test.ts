import { describe, expect, it } from "vitest";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { ShipmentUnits } from "@shared/procurement/shipment-unit-selection";
import { shipmentQuantityDraft, selectShipmentQuantityUnit, shipmentQuantityPayload, shipmentQuantityPreview, shipmentRecordedUnitSummary, shipmentDimensionBasisLabel } from "../../shipment-unit-entry";
import { shipmentLineEditorFromRecord, updateShipmentLinePayload, refreshShipmentLineDraftVersion } from "../../shipment-line-command";
import { mapPackingListRows, packingListUnitOptionRows, packingListQuantityDraft, updatePackingListQuantity } from "../../shipment-packing-list";

const units: ShipmentUnits = { productId: 100, selectedVariantId: 2, unitsPerVariantSnapshot: 1000, issue: null,
  variants: [{ id: 1, sku: "EACH", name: "Piece", unitsPerVariant: 1 }, { id: 2, sku: "CASE1000", name: "Case of 1000", unitsPerVariant: 1000 }] };
const line = { id: 7, inboundShipmentId: 42, version: "a".repeat(64), qtyShipped: 525000, cartonCount: 11,
  weightKg: "2.000", lengthCm: "10.00", widthCm: "20.00", heightCm: "30.00", notes: null,
  purchaseOrderId: 17, purchaseOrderLineId: 9, productVariantId: 2, sku: "CASE1000", shipmentUnits: units, dimensionBasis: null };

describe("shared configured shipment count entry", () => {
  it("shows retained 525-case evidence and returns exact 525000 pieces", () => {
    const draft = shipmentQuantityDraft(525000, units);
    expect(draft).toEqual({ variantId: 2, unitsPerVariant: 1000, quantity: "525" });
    expect(shipmentQuantityPayload(draft, units)).toEqual({ qtyShipped: 525000, unitSelection: { productVariantId: 2, unitsPerVariant: 1000, quantity: 525 } });
    expect(shipmentRecordedUnitSummary(line)).toBe("525 × 1,000 pieces per receive unit");
  });
  it("never infers a legacy receive unit from a live factor", () => {
    const legacy = { ...units, unitsPerVariantSnapshot: null };
    expect(shipmentQuantityDraft(525000, legacy)).toEqual({ variantId: null, unitsPerVariant: 1, quantity: "525000" });
    expect(shipmentRecordedUnitSummary({ ...line, shipmentUnits: legacy })).toBe("Receive unit not recorded");
  });
  it("preserves pieces when changing between configured packs and pieces", () => {
    const initial = shipmentQuantityDraft(525000, null);
    const packed = selectShipmentQuantityUnit(initial, 2, units);
    expect(packed.quantity).toBe("525");
    expect(selectShipmentQuantityUnit(packed, null, units)).toEqual({ ...initial, variantId: 1 });
  });
  it("requires an explicit new count instead of rounding a partial pack", () => {
    const initial = shipmentQuantityDraft(501, null);
    const packed = selectShipmentQuantityUnit(initial, 2, units);
    expect(packed.quantity).toBe("");
    expect(shipmentQuantityPreview(packed, units).pieces).toBeNull();
    expect(shipmentQuantityPayload({ ...packed, quantity: "2" }, units).qtyShipped).toBe(2000);
    expect(initial.quantity).toBe("501");
  });
  it.each(["0","-1","1.2","1e3","","2147483648"])("rejects invalid count %s", (quantity) => {
    expect(() => shipmentQuantityPayload({ variantId: 2, unitsPerVariant: 1000, quantity }, units)).toThrow();
  });
  it("rejects converted overflow and capacity before dispatch", () => {
    expect(() => shipmentQuantityPayload({ variantId: 2, unitsPerVariant: 1000, quantity: "2147484" }, units)).toThrow(/range/);
    expect(() => shipmentQuantityPayload({ variantId: 2, unitsPerVariant: 1000, quantity: "526" }, units, 525000)).toThrow(/only 525,000/);
  });
  it("binds the selected factor against refreshed catalog drift", () => {
    const draft = shipmentQuantityDraft(525000, units);
    const changed = { ...units, variants: units.variants.map((variant) => variant.id === 2 ? { ...variant, unitsPerVariant: 500 } : variant) };
    expect(() => shipmentQuantityPayload(draft, changed)).toThrow(/changed/);
    expect(() => selectShipmentQuantityUnit(draft, 99, units)).toThrow(/Refresh/);
  });
  it("saves unit evidence without converting physical carton count or measurements", () => {
    const original = canonicalJson(line);
    const editor = shipmentLineEditorFromRecord(line, 42);
    editor.quantity = { ...editor.quantity, quantity: "500" };
    expect(updateShipmentLinePayload(editor)).toEqual({ expectedVersion: line.version, qtyShipped: 500000,
      unitSelection: { productVariantId: 2, unitsPerVariant: 1000, quantity: 500 } });
    expect(editor.form.cartonCount).toBe("11");
    expect(canonicalJson(line)).toBe(original);
  });
  it("permits dimension-only changes without restamping historical units", () => {
    const editor = shipmentLineEditorFromRecord(line, 42);
    editor.form.dimensionBasis = "carton";
    editor.form.lengthCm = "12.00";
    expect(updateShipmentLinePayload(editor)).toEqual({ expectedVersion: line.version, dimensionBasis: "carton", lengthCm: "12.00" });
  });
  it("does not silently rebase a draft when receive evidence changes", () => {
    const editor = shipmentLineEditorFromRecord(line, 42);
    const refreshed = shipmentLineEditorFromRecord({ ...line, version: "b".repeat(64), shipmentUnits: { ...units, unitsPerVariantSnapshot: 500 } }, 42);
    expect(() => refreshShipmentLineDraftVersion(editor, refreshed)).toThrow(/source/);
  });
  it("labels explicit and retained measurement bases without consulting receive units", () => {
    expect(shipmentDimensionBasisLabel({ dimensionBasis: "piece", cartonCount: 11 })).toBe("piece");
    expect(shipmentDimensionBasisLabel({ dimensionBasis: null, cartonCount: 11 })).toBe("carton");
    expect(shipmentDimensionBasisLabel({ dimensionBasis: null, cartonCount: null })).toBe("piece");
  });
});

describe("packing CSV configured quantity evidence", () => {

  it("maps explicit unit columns and derives pieces using exact shared arithmetic", () => {
    const [row] = mapPackingListRows([{ sku: "CASE1000", count: "525", factor: "1000", variant: "2" }],
      { sku: "sku", receiveUnitQuantity: "count", receiveUnitsPerVariant: "factor", receiveVariantId: "variant" });
    expect(row).toEqual({ sku: "CASE1000", qtyShipped: 525000, unitSelection: { productVariantId: 2, quantity: 525, unitsPerVariant: 1000 } });
    expect(packingListQuantityDraft(row)).toEqual({ variantId: 2, unitsPerVariant: 1000, quantity: "525" });
  });
  it("preserves inconsistent piece mirrors and invalid unit evidence for explicit review", () => {
    const [row] = mapPackingListRows([{ count: "2", factor: "1000", variant: "2", pieces: "1" }],
      { receiveUnitQuantity: "count", receiveUnitsPerVariant: "factor", receiveVariantId: "variant", qtyShipped: "pieces" });
    expect(row.qtyShipped).toBe(1);
    expect(row.unitSelection).toEqual({ productVariantId: 2, quantity: 2, unitsPerVariant: 1000 });
    expect(mapPackingListRows([{ count: "1.5" }], { receiveUnitQuantity: "count" })[0]).toEqual({ unitSelection: { quantity: "1.5" } });
  });
  it("sends only row identity for a bounded authoritative unit lookup", () => {
    expect(packingListUnitOptionRows([{ sku: "EACH", qtyShipped: 500, purchaseOrderLineId: 99, notes: "private note", unitSelection: { productVariantId: 2, unitsPerVariant: 1000, quantity: 2 } }]))
      .toEqual([{ sku: "EACH", purchaseOrderLineId: 99, selectedVariantId: 2 }]);
  });
  it("updates visible SKU and exact count while preserving source and physical packing", () => {
    const row = { sku: "EACH", qtyShipped: 525000, cartonCount: 11, purchaseOrderLineId: 99, weightKg: "2.000" };
    const selected = updatePackingListQuantity(row, { variantId: 2, unitsPerVariant: 1000, quantity: "525" }, units);
    expect(selected).toEqual({ ...row, sku: "CASE1000", unitSelection: { productVariantId: 2, unitsPerVariant: 1000, quantity: 525 } });
    expect(row.sku).toBe("EACH");
  });
});

it("freezes historical carton measurement basis and requires an explicit change before clearing cartons", () => {
  const editor = shipmentLineEditorFromRecord(line, 42);
  editor.form.cartonCount = "";
  expect(() => updateShipmentLinePayload(editor)).toThrow(/explicitly choose/);
  editor.form.dimensionBasis = "piece";
  expect(updateShipmentLinePayload(editor)).toEqual({ expectedVersion: line.version, cartonCount: null, dimensionBasis: "piece" });
});
it("does not let a new carton count silently change historical piece measurements", () => {
  const editor = shipmentLineEditorFromRecord({ ...line, cartonCount: null }, 42);
  editor.form.cartonCount = "25";
  expect(updateShipmentLinePayload(editor)).toEqual({ expectedVersion: line.version, cartonCount: 25, dimensionBasis: "piece" });
});
