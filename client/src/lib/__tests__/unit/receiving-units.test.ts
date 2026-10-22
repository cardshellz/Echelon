import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceivingUnitControl } from "@/components/purchasing/ReceivingUnitControl";
import { hasReceivingUnitVersion, ReceivingUnitVersionError, parseReceivingUnitRefresh, parseReceivingLineMutation, receivingCompleteAllCommand, recordedReceivingFactor, receivingBaseQuantity, receivingVariantChange, receivingCountChange, receivingSelectedFactor, receivingAddQuantity } from "../../receiving-units";
import { parsePoDirectReceiveOption, parseShipmentReceiptResolution, requiresReceiptUnitReview, shipmentReceiveCoverageLabel, shipmentCustodyReceiptIds } from "../../shipment-receipt-units";

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
  it("retains validated source excess in the pack-resolution contract", () => {
    expect(parseShipmentReceiptResolution({ ...resolution(), excessBaseQty: 10 }, { shipmentId: 42, purchaseOrderId: 17 }).excessBaseQty).toBe(10);
    for (const excessBaseQty of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseShipmentReceiptResolution({ ...resolution(), excessBaseQty }, { shipmentId: 42, purchaseOrderId: 17 })).toThrow(/incomplete/);
    }
  });
});

describe("receipt command boundaries", () => {
  it.each([undefined, "", "invalid", "A".repeat(64), "a".repeat(63)])("requires a source refresh for missing or invalid version %s", (unitVersion) => {
    const incomplete = { ...line, unitVersion };
    expect(hasReceivingUnitVersion(incomplete)).toBe(false);
    try {
      receivingCountChange(incomplete, "525");
      expect.fail("An unversioned line must never produce a count command");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ReceivingUnitVersionError);
      expect(cause).toMatchObject({ code: "RECEIVING_UNIT_VERSION_MISSING", needsRefresh: true });
    }
  });

  it("verifies refreshed line versions and identity before discarding a draft", () => {
    const saved = { ...line, status: "partial", sku: "SKU", productName: "Product", putawayLocationId: 5,
      putawayComplete: 0, unitCost: 25, notes: null, purchaseOrderLineId: 9 };
    const receipt = { id: 31, receiptNumber: "TEST-31", status: "open", lines: [saved], sourceType: "shipment",
      poNumber: "TEST-PO", asnNumber: null, vendorId: null, warehouseId: 1, receivingLocationId: 5,
      purchaseOrderId: 9, inboundShipmentId: 17, expectedDate: null, receivedDate: null, closedDate: null,
      expectedLineCount: 1, receivedLineCount: 0, expectedTotalUnits: 501, receivedTotalUnits: 401,
      notes: null, createdBy: "fixture-user", createdAt: "2026-10-04T12:00:00.000Z", vendor: null };
    const before = structuredClone(receipt);
    expect(hasReceivingUnitVersion(saved)).toBe(true);
    expect(parseReceivingUnitRefresh(receipt, { receiptId: 31, lineId: 7 })).toEqual(receipt);
    expect(receipt).toEqual(before);
    for (const invalid of [null, { ...receipt, id: 32 }, { ...receipt, lines: [] },
      { ...receipt, lines: [saved, saved] }, { ...receipt, lines: [{ ...saved, id: 8 }] },
      { ...receipt, lines: [{ ...saved, receivingOrderId: 32 }] },
      { ...receipt, lines: [{ ...saved, unitVersion: undefined }] },
      { ...receipt, lines: [saved, { ...saved, id: 8, unitVersion: "invalid" }] },
      { ...receipt, warehouseId: "1" }, { ...receipt, sourceType: undefined },
      { ...receipt, createdAt: "invalid" }, { ...receipt, vendor: { name: "Incomplete" } }]) {
      expect(() => parseReceivingUnitRefresh(invalid, { receiptId: 31, lineId: 7 })).toThrow(/draft is still preserved/);
    }
  });

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
  it("preserves direct-receipt exclusions and custody links while refusing incomplete eligibility", () => {
    const option = { allowed: true, warning: "Use the original receipt for excluded lines.", reason: null,
      blockedPurchaseOrderLineIds: [7], custodyReceiptIds: [31] };
    expect(parsePoDirectReceiveOption(option)).toEqual(option);
    expect(parsePoDirectReceiveOption({ allowed: false, warning: "Receipt blocked." })).toEqual({ allowed: false, warning: "Receipt blocked." });
    for (const invalid of [undefined, null, {}, { ...option, allowed: "true" },
      { ...option, blockedPurchaseOrderLineIds: [-1] }, { ...option, custodyReceiptIds: ["31"] }]) {
      expect(parsePoDirectReceiveOption(invalid)).toEqual({ allowed: false,
        warning: "Receiving options could not be verified. Refresh before creating a receipt." });
    }
  });
  it("keeps unknown coverage separate from zero and never hides an existing receipt behind a received badge", () => {
    expect(shipmentReceiveCoverageLabel({ action: "open_existing_receipt", receivable: false, remainingBaseQty: null, receivedBaseQty: null, qtyShipped: 501 })).toEqual({ fullyReceived: false, text: "Receipt coverage needs review" });
    expect(shipmentReceiveCoverageLabel({ action: "open_existing_receipt", receivable: false, remainingBaseQty: 0, receivedBaseQty: 501, qtyShipped: 501 }).fullyReceived).toBe(false);
    expect(shipmentReceiveCoverageLabel({ action: "blocked", receivable: false, remainingBaseQty: 0, receivedBaseQty: 501, qtyShipped: 501 }).fullyReceived).toBe(true);
    expect(shipmentReceiveCoverageLabel({ receivable: true, remainingBaseQty: 1, receivedBaseQty: 500, qtyShipped: 501 }).text).toBe("1 of 501 pieces remaining");
  });
  it.each([
    [0, 100, 0, 0, "0 pieces received into inventory · 100 held in quarantine · 0 pieces remaining to receive"],
    [60, 40, 0, 0, "60 pieces received into inventory · 40 held in quarantine · 0 pieces remaining to receive"],
    [0, 0, 100, 0, "0 pieces received into inventory · 100 returned to supplier · 0 pieces remaining to receive"],
    [20, 30, 10, 40, "20 pieces received into inventory · 30 held in quarantine · 10 returned to supplier · 40 pieces remaining to receive"],
  ] as const)("separates posted %i, held %i, returned %i and fresh remainder %i", (received, held, returned, remaining, text) => {
    expect(shipmentReceiveCoverageLabel({ action: remaining ? "create_receipt" : "blocked", receivable: remaining > 0,
      qtyShipped: 100, receivedBaseQty: received, custodyBaseQty: held + returned,
      heldBaseQty: held, returnedBaseQty: returned, remainingBaseQty: remaining }))
      .toEqual({ fullyReceived: false, text });
  });
  it("fails closed on incomplete or inconsistent custody instead of treating zero remainder as receipt proof", () => {
    const complete = { action: "blocked", receivable: false, qtyShipped: 100, receivedBaseQty: 60,
      custodyBaseQty: 40, heldBaseQty: 40, returnedBaseQty: 0, remainingBaseQty: 0 };
    for (const invalid of [{ ...complete, custodyBaseQty: null }, { ...complete, heldBaseQty: undefined },
      { ...complete, returnedBaseQty: 1 }, { ...complete, receivedBaseQty: 59 },
      { ...complete, remainingBaseQty: 1 }, { ...complete, receivedBaseQty: 61, remainingBaseQty: 1 }]) {
      expect(shipmentReceiveCoverageLabel(invalid)).toEqual({ fullyReceived: false, text: "Receipt coverage needs review" });
    }
    expect(shipmentReceiveCoverageLabel({ ...complete, receivedBaseQty: 100, custodyBaseQty: 0, heldBaseQty: 0 }))
      .toEqual({ fullyReceived: true, text: "100 shipped pieces" });
  });
  it.each([
    [0, 110, 0, "0 pieces received into inventory · 110 held in quarantine · 0 pieces remaining to receive · 10 pieces above shipped quantity"],
    [60, 30, 20, "60 pieces received into inventory · 30 held in quarantine · 20 returned to supplier · 0 pieces remaining to receive · 10 pieces above shipped quantity"],
    [0, 0, 110, "0 pieces received into inventory · 110 returned to supplier · 0 pieces remaining to receive · 10 pieces above shipped quantity"],
    [110, 0, 0, "110 pieces received into inventory · 0 pieces remaining to receive · 10 pieces above shipped quantity"],
  ] as const)("preserves over-observed counts of posted %i, held %i and returned %i without calling the shipment fully received", (received, held, returned, text) => {
    expect(shipmentReceiveCoverageLabel({ action: "blocked", receivable: false, qtyShipped: 100,
      receivedBaseQty: received, custodyBaseQty: held + returned, heldBaseQty: held, returnedBaseQty: returned,
      remainingBaseQty: 0 })).toEqual({ fullyReceived: false, text });
  });
  it.each([
    [60, 30, 20, 100, 10],
    [160, 70, 20, 50, 100],
  ] as const)("retains owner-proven mixed-line excess alongside a fresh remainder: received %i, held %i, returned %i, remaining %i, excess %i", (received, held, returned, remaining, excess) => {
    const coverage = { action: "create_receipt", receivable: true, qtyShipped: 200,
      receivedBaseQty: received, custodyBaseQty: held + returned, heldBaseQty: held, returnedBaseQty: returned,
      remainingBaseQty: remaining, excessBaseQty: excess };
    expect(shipmentReceiveCoverageLabel(coverage)).toEqual({ fullyReceived: false,
      text: `${received} pieces received into inventory · ${held} held in quarantine · ${returned} returned to supplier · ${remaining} pieces remaining to receive · ${excess} pieces above shipped quantity` });
    // The aggregate cannot recover per-line excess: older evidence must remain explicitly unresolved.
    expect(shipmentReceiveCoverageLabel({ ...coverage, excessBaseQty: undefined }))
      .toEqual({ fullyReceived: false, text: "Receipt coverage needs review" });
  });
  it("requires explicit excess to be complete and agree with coverage instead of silently falling back", () => {
    const coverage = { action: "create_receipt", receivable: true, qtyShipped: 200,
      receivedBaseQty: 60, custodyBaseQty: 50, heldBaseQty: 30, returnedBaseQty: 20,
      remainingBaseQty: 100, excessBaseQty: 10 };
    for (const excessBaseQty of [null, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, 0, 9, 11]) {
      expect(shipmentReceiveCoverageLabel({ ...coverage, excessBaseQty }))
        .toEqual({ fullyReceived: false, text: "Receipt coverage needs review" });
    }
    expect(shipmentReceiveCoverageLabel({ ...coverage, receivedBaseQty: 200, custodyBaseQty: 0,
      heldBaseQty: 0, returnedBaseQty: 0, remainingBaseQty: 0, excessBaseQty: 0, receivable: false }))
      .toEqual({ fullyReceived: true, text: "200 shipped pieces" });
  });
  it("retains only validated exact custody receipt identities without guessing a PO receipt", () => {
    expect(shipmentCustodyReceiptIds({ custodyReceiptIds: [32, 31, 32] })).toEqual([31, 32]);
    expect(shipmentCustodyReceiptIds({})).toEqual([]);
    expect(shipmentCustodyReceiptIds({ custodyReceiptIds: [31, -1] })).toEqual([]);
  });
});
