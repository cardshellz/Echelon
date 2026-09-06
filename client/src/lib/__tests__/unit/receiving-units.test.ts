import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceivingUnitControl } from "@/components/purchasing/ReceivingUnitControl";
import { parseReceivingLineMutation, receivingCompleteAllCommand, recordedReceivingFactor, receivingBaseQuantity, receivingVariantChange, receivingCountChange, receivingSelectedFactor, receivingAddQuantity } from "../../receiving-units";
import { parseShipmentReceiptResolution, requiresReceiptUnitReview, shipmentReceiveCoverageLabel } from "../../shipment-receipt-units";

const version = "a".repeat(64);
const line = { id: 7, receivingOrderId: 31, productId: 10, productVariantId: 2, expectedQty: 501, receivedQty: 401, damagedQty: 3, unitsPerVariantSnapshot: 1, unitVersion: version };
const variants = [{ id: 2, productId: 10, sku: "PIECE", name: "Piece", unitsPerVariant: 1 }, { id: 3, productId: 10, sku: "CASE50", name: "Case", unitsPerVariant: 50 }];
describe("receiving unit authority", () => {
  it("never replaces recorded pieces with carton arithmetic or rounds a unit change", () => {
    expect(receivingBaseQuantity(501, 1)).toBe("501");
    expect(receivingBaseQuantity(10, 50)).toBe("500");
    expect(receivingVariantChange(line, 3)).toEqual({ productVariantId: 3, expectedUnitVersion: version });
    expect(line).toMatchObject({ expectedQty: 501, receivedQty: 401, damagedQty: 3 });
  });
  it("does not infer missing snapshots and requires explicit legacy confirmation", () => {
    const legacy = { ...line, unitsPerVariantSnapshot: null };
    expect(recordedReceivingFactor(legacy)).toBeNull();
    expect(receivingBaseQuantity(501, null)).toBeNull();
    expect(() => receivingVariantChange(legacy, 2)).toThrow(/Confirm/);
    expect(() => receivingVariantChange(legacy, 3, true)).toThrow(/current variant/);
    expect(receivingVariantChange(legacy, 2, true, 1)).toEqual({ productVariantId: 2, expectedUnitVersion: version, confirmLegacyUnit: true, expectedUnitsPerVariant: 1 });
    expect(receivingVariantChange({ ...legacy, productVariantId: null }, 3, true, 50)).toEqual({ productVariantId: 3, expectedUnitVersion: version, confirmLegacyUnit: true, expectedUnitsPerVariant: 50 });
    expect(receivingVariantChange(line, 2, true)).not.toHaveProperty("confirmLegacyUnit");
  });
  it("preserves a positive partial received count and saved or explicit zero", () => {
    expect(receivingCountChange(line, undefined)).toEqual({ receivedQty: 401, expectedUnitVersion: version });
    expect(receivingCountChange(line, "0")).toEqual({ receivedQty: 0, expectedUnitVersion: version });
    expect(receivingCountChange({ ...line, receivedQty: 0 }, undefined).receivedQty).toBe(0);
    expect(() => receivingCountChange({ ...line, unitsPerVariantSnapshot: null }, "1")).toThrow(/Confirm/);
    expect(() => receivingCountChange({ ...line, unitVersion: undefined }, "1")).toThrow(/version/);
  });
  it.each(["", "1.5", "-1", "1e3", "2147483648", "abc"])("rejects invalid counts instead of coercing %s", (value) => {
    expect(() => receivingCountChange(line, value)).toThrow();
    expect(() => receivingAddQuantity(value)).toThrow();
  });
  it("renders recorded factors, exact base totals, and explicit review of catalog drift", () => {
    const html = renderToStaticMarkup(createElement(ReceivingUnitControl, { line: { ...line, unitsPerVariantSnapshot: 50 }, variants, mutable: true, pending: false, onChange: () => {} }));
    expect(html).toContain("25,050 pieces");
    expect(html).toContain("20,050 pieces");
    expect(html).toContain("150 pieces");
    expect(html).toContain("Review and apply current catalog factor");
    const legacy = renderToStaticMarkup(createElement(ReceivingUnitControl, { line: { ...line, unitsPerVariantSnapshot: null }, variants, mutable: true, pending: false, onChange: () => {} }));
    expect(legacy).toContain("base pieces unknown");
    expect(legacy).toContain("Confirm these counts are in");
  });
});

const resolution = () => ({ shipmentId: 42, purchaseOrderId: 17, shipmentNumber: "SHIP42", status: "arrived", poNumber: "PO17", canCreateReceipt: true, unresolvedCount: 0, lineCount: 1, issue: null, lines: [{
  shipmentLineId: 7, purchaseOrderLineId: 9, productId: 10, productName: "Partial carton", sku: "SKU", qtyShipped: 501, cartonCount: 11, unitsPerCarton: null, status: "resolved", blocking: false, issue: "Count in pieces",
  matchedVariant: { id: 2, sku: "PIECE", name: "Piece", unitsPerVariant: 1 }, activeVariants: [],
  receivePlan: { productVariantId: 2, unitsPerVariant: 1, expectedQty: 501, countsAsPieces: true, preferredVariantId: 3, preferredUnitsPerVariant: 50 },
}] });
describe("shipment receive plan preflight", () => {
  it("requires review for 501 pieces in 11 cartons and proves the plan preserves shipped pieces", () => {
    const result = parseShipmentReceiptResolution(resolution(), { shipmentId: 42, purchaseOrderId: 17 });
    expect(requiresReceiptUnitReview(result)).toBe(true);
    expect(result.lines[0].receivePlan?.expectedQty).toBe(501);
    expect(result.lines[0].unitsPerCarton).toBeNull();
  });
  it("rejects a wrong parent, missing plan and a rounded 500-piece plan", () => {
    expect(() => parseShipmentReceiptResolution(resolution(), { shipmentId: 43, purchaseOrderId: 17 })).toThrow(/different/);
    const bad = resolution(); bad.lines[0].receivePlan.expectedQty = 500;
    expect(() => parseShipmentReceiptResolution(bad, { shipmentId: 42, purchaseOrderId: 17 })).toThrow(/verified/);
    expect(() => parseShipmentReceiptResolution({ ...resolution(), lines: [{ ...resolution().lines[0], receivePlan: null }] }, { shipmentId: 42, purchaseOrderId: 17 })).toThrow(/verified/);
  });
});

describe("receipt command boundaries", () => {
  it("requires complete line versions and a confirmed basis for bulk counts", () => {
    expect(receivingCompleteAllCommand([line])).toEqual({ expectedUnitVersions: [{ lineId: 7, unitVersion: version }] });
    expect(() => receivingCompleteAllCommand([])).toThrow();
    expect(() => receivingCompleteAllCommand([{ ...line, unitsPerVariantSnapshot: null }])).toThrow(/Confirm/);
    expect(() => receivingCompleteAllCommand([{ ...line, unitVersion: "invalid" }])).toThrow(/version/);
    expect(() => receivingCompleteAllCommand([{ ...line, receivedQty: -1 }])).toThrow();
  });
  it("does not accept a malformed, wrong-parent, or mismatched saved count response", () => {
    const saved = { ...line, status: "partial", sku: "SKU", productName: "Product", putawayLocationId: 5, putawayComplete: 0, unitCost: 25, notes: null, purchaseOrderLineId: 9 };
    expect(parseReceivingLineMutation(saved, { id: 7, receivingOrderId: 31, updates: { receivedQty: 401 } })).toMatchObject(saved);
    expect(() => parseReceivingLineMutation({ ...saved, unitVersion: null }, { id: 7, receivingOrderId: 31, updates: {} })).toThrow(/may have saved/);
    expect(() => parseReceivingLineMutation(saved, { id: 7, receivingOrderId: 32, updates: {} })).toThrow(/may have saved/);
    expect(() => parseReceivingLineMutation(saved, { id: 7, receivingOrderId: 31, updates: { receivedQty: 400 } })).toThrow(/may have saved/);
    expect(() => parseReceivingLineMutation(saved, { id: 7, receivingOrderId: 31, updates: { productVariantId: 3 } })).toThrow(/may have saved/);
  });
});

describe("reviewed catalog factor", () => {
  it("requires the factor the operator saw for explicit legacy confirmation and selected-variant creation", () => {
    expect(() => receivingVariantChange({ ...line, unitsPerVariantSnapshot: null }, 2, true)).toThrow(/reselect/);
    expect(receivingSelectedFactor(50)).toBe(50);
    for (const value of [null, undefined, 0, -1, 1.5, "50", 2147483648]) expect(() => receivingSelectedFactor(value)).toThrow(/reselect/);
  });
});

describe("receipt coverage read labels", () => {
  it("keeps unknown coverage separate from zero and never hides an existing receipt behind a received badge", () => {
    expect(shipmentReceiveCoverageLabel({ action: "open_existing_receipt", receivable: false, remainingBaseQty: null, receivedBaseQty: null, qtyShipped: 501 })).toEqual({ fullyReceived: false, text: "Receipt coverage needs review" });
    expect(shipmentReceiveCoverageLabel({ action: "open_existing_receipt", receivable: false, remainingBaseQty: 0, receivedBaseQty: 501, qtyShipped: 501 }).fullyReceived).toBe(false);
    expect(shipmentReceiveCoverageLabel({ action: "blocked", receivable: false, remainingBaseQty: 0, receivedBaseQty: 501, qtyShipped: 501 }).fullyReceived).toBe(true);
    expect(shipmentReceiveCoverageLabel({ receivable: true, remainingBaseQty: 1, receivedBaseQty: 500, qtyShipped: 501 }).text).toBe("1 of 501 pieces remaining");
  });
});
