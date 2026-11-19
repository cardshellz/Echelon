import { describe, expect, it } from "vitest";
import { shipmentEditorApprovalSchema, shipmentEditorRequestSchema } from "@shared/procurement/shipment-editor";
import { poQuantityPreviewRequestSchema } from "@shared/procurement/po-quantity-amendment";
import { shipmentEditorBlockedReason, sumShipmentCents } from "../../shipment-editor.policy";
import { shipmentLinePackingSchema } from "@shared/procurement/shipment-line-command";

const version = "a".repeat(64), clientKey = "8e6c61fe-bd54-4a16-b547-f8d8c7ed6124";
const shipment = { sourceVersion: version, reason: "Verified supplier packing list", changes: [], removals: [5], additions: [] };
const addition = { clientKey, purchaseOrderId: 2, purchaseOrderLineId: 3, quantityPieces: 10,
  unitSelection: { productVariantId: 4, unitsPerVariant: 1, quantity: 10 } };

describe("full purchasing line editor boundaries", () => {
  it("accepts remove-only and add-only edits but rejects empty or conflicting requests", () => {
    expect(shipmentEditorRequestSchema.safeParse(shipment).success).toBe(true);
    expect(shipmentEditorRequestSchema.safeParse({ ...shipment, removals: [], additions: [addition] }).success).toBe(true);
    for (const patch of [
      { removals: [] }, { removals: [5, 5] }, { changes: [{ lineId: 5, fields: { qtyShipped: 12 } }] },
      { changes: [{ lineId: 6, fields: {} }] }, { additions: [addition, addition] },
      { additions: [addition, { ...addition, clientKey: "3324561b-6455-43fc-a725-cb8a59538438" }] },
    ]) expect(shipmentEditorRequestSchema.safeParse({ ...shipment, ...patch }).success).toBe(false);
  });
  it.each([0, -1, 1.5, 2147483648, "10"])("rejects unsupported piece count %s", value => {
    expect(shipmentEditorRequestSchema.safeParse({ ...shipment, additions: [{ ...addition, quantityPieces: value }] }).success).toBe(false);
  });
  it("requires explicit approval and rejects unowned fields", () => {
    expect(shipmentEditorApprovalSchema.safeParse({ ...shipment, previewVersion: version, approvalConfirmed: true }).success).toBe(true);
    expect(shipmentEditorApprovalSchema.safeParse({ ...shipment, previewVersion: version, approvalConfirmed: false }).success).toBe(false);
    expect(shipmentEditorRequestSchema.safeParse({ ...shipment, changes: [{ lineId: 6, fields: { receivedQty: 12 } }] }).success).toBe(false);
    expect(shipmentEditorRequestSchema.safeParse({ ...shipment, actualCostCents: 100 }).success).toBe(false);
  });
  it("requires a real PO operation and keeps received quantities outside the command", () => {
    const po = { sourceVersion: version, reason: "Supplier removed an unused product", changes: [] };
    expect(poQuantityPreviewRequestSchema.safeParse(po).success).toBe(false);
    expect(poQuantityPreviewRequestSchema.safeParse({ ...po, removals: [5] }).success).toBe(true);
    expect(poQuantityPreviewRequestSchema.safeParse({ ...po, removals: [5, 5] }).success).toBe(false);
    expect(poQuantityPreviewRequestSchema.safeParse({ ...po, removals: [5], receivedQty: 0 }).success).toBe(false);
  });
  it("retains exact signed cents and rejects overflow or fractional amounts", () => {
    expect(sumShipmentCents([9007199254740000, 991, -999])).toBe(9007199254739992);
    expect(sumShipmentCents([100, -75, -25])).toBe(0);
    expect(() => sumShipmentCents([Number.MAX_SAFE_INTEGER, 1])).toThrow();
    expect(() => sumShipmentCents([0.1])).toThrow();
  });
  it("requires a physical measurement basis and carton count for new shipment packing", () => {
    expect(shipmentLinePackingSchema.safeParse({ dimensionBasis: "carton", cartonCount: 5, weightKg: "1.250", lengthCm: "25.00" }).success).toBe(true);
    expect(shipmentLinePackingSchema.safeParse({ dimensionBasis: "piece", weightKg: "0.001" }).success).toBe(true);
    for (const invalid of [{ weightKg: "1.250" }, { dimensionBasis: "carton" }, { dimensionBasis: null },
      { dimensionBasis: "piece", weightKg: "0.0001" }, { qtyShipped: 10 }]) {
      expect(shipmentLinePackingSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it("keeps receiving and posted-cost history protected and never sums unsupported currency into USD shares", () => {
    const facts = { status: "booked", hasReceipts: false, hasPostedCosts: false, chargeCurrencies: ["USD"] };
    expect(shipmentEditorBlockedReason(facts)).toBeNull();
    for (const patch of [{ status: "closed" }, { hasReceipts: true }, { hasPostedCosts: true }]) {
      expect(shipmentEditorBlockedReason({ ...facts, ...patch })).toContain("Receipt and quantity corrections");
    }
    expect(shipmentEditorBlockedReason({ ...facts, status: "cancelled" })).toContain("cancelled");
    expect(shipmentEditorBlockedReason({ ...facts, chargeCurrencies: ["USD", "CAD"] })).toContain("currency");
    expect(shipmentEditorBlockedReason({ ...facts, chargeCurrencies: [null] })).toContain("currency");
  });
});
