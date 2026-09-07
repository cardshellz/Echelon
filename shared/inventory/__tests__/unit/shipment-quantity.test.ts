import { describe, expect, it } from "vitest";
import { interpretInventoryShipmentQuantity, inventoryShipmentQuantityEvidenceSchema } from "../../shipment-quantity";

function evidence() {
  return {
    transactionId: 301, transactionType: "ship", variantQtyDelta: 0, reservedQtyDelta: 0,
    referenceType: "availability_claim_dispatch", sourceState: "picked", targetState: "shipped",
    orderId: 70, orderItemId: 71, shipmentId: 90, shipmentItemId: 101, productVariantId: 105, fromLocationId: 50,
    receipt: { id: "1", quantity: "3", orderId: 70, orderItemId: 71, shipmentId: 90, shipmentItemId: 101,
      productVariantId: 105, fromLocationId: 50, warehouseId: 1, physicalShipmentId: null as string | null,
      physicalShipmentItemId: null as string | null, movementQuantity: "3", invalidMovementCount: "0" },
  };
}

describe("inventory shipment quantity evidence", () => {
  it("reports shipped units without inventing another on-hand debit", () => {
    const raw = evidence();
    const before = structuredClone(raw);
    expect(interpretInventoryShipmentQuantity(raw)).toEqual({
      status: "verified", quantity: 3, source: "canonical_dispatch_receipt", receiptId: "1",
    });
    expect(raw).toEqual(before);
    expect(raw.variantQtyDelta).toBe(0);
  });
  it("retains exact legacy shipment quantity", () => {
    expect(interpretInventoryShipmentQuantity({ ...evidence(), referenceType: null, receipt: null, variantQtyDelta: -3 }))
      .toEqual({ status: "verified", quantity: 3, source: "legacy_on_hand_delta", receiptId: null });
  });
  it("retains a voided historical record's original quantity without inferring carrier receipt", () => {
    expect(interpretInventoryShipmentQuantity({ ...evidence(), voidedAt: "2026-09-07T00:00:00Z" }))
      .toMatchObject({ status: "verified", quantity: 3 });
  });
  it.each([0, 1, -1.5, -2_147_483_648, null, true, "", "-3junk", " -3", Number.NaN, Number.MAX_SAFE_INTEGER])
    ("does not manufacture legacy shipped quantity from %s", (variantQtyDelta) => {
      expect(interpretInventoryShipmentQuantity({ ...evidence(), referenceType: null, receipt: null, variantQtyDelta }))
        .toMatchObject({ status: "invalid" });
    });
  it("accepts exact PostgreSQL integer boundaries and numeric strings", () => {
    expect(interpretInventoryShipmentQuantity({ ...evidence(), referenceType: null, receipt: null, variantQtyDelta: "-2147483647" }))
      .toMatchObject({ status: "verified", quantity: 2_147_483_647 });
    const raw = evidence();
    raw.receipt.quantity = raw.receipt.movementQuantity = "2147483647";
    expect(interpretInventoryShipmentQuantity(raw)).toMatchObject({ status: "verified", quantity: 2_147_483_647 });
  });
  it.each([null, undefined, [], {}, { transactionType: "ship" }])("rejects absent/malformed evidence %#", (raw) => {
    expect(interpretInventoryShipmentQuantity(raw)).toMatchObject({ status: "invalid" });
  });
  it("keeps non-shipment deltas outside the shipment contract", () => {
    expect(interpretInventoryShipmentQuantity({ transactionType: "pick", receipt: null, referenceType: null }))
      .toEqual({ status: "not_shipment" });
    expect(interpretInventoryShipmentQuantity({ ...evidence(), transactionType: "pick" })).toMatchObject({ status: "invalid" });
  });
  it.each(["orderId", "orderItemId", "shipmentId", "shipmentItemId", "productVariantId", "fromLocationId"] as const)
    ("rejects a receipt for a different %s", (field) => {
      const raw = evidence(); raw.receipt[field] += 1;
      expect(interpretInventoryShipmentQuantity(raw)).toMatchObject({ status: "invalid" });
    });
  it.each([
    { receipt: null }, { referenceType: null }, { variantQtyDelta: -3 }, { reservedQtyDelta: -3 },
    { sourceState: "available" }, { targetState: "picked" }, { transactionId: 0 },
  ])("never falls back to a legacy debit for contradictory canonical evidence %#", (patch) => {
    expect(interpretInventoryShipmentQuantity({ ...evidence(), ...patch })).toMatchObject({ status: "invalid" });
  });
  it.each([
    { id: "invalid" }, { id: "9223372036854775808" }, { id: "9".repeat(1000) },
    { quantity: "2147483648" }, { quantity: "0" }, { quantity: true }, { quantity: "3.0" },
    { quantity: "03" }, { warehouseId: null }, { physicalShipmentId: "1", physicalShipmentItemId: null },
    { physicalShipmentId: null, physicalShipmentItemId: "1" },
    { movementQuantity: null }, { movementQuantity: "2" }, { invalidMovementCount: "1" },
  ])("classifies malformed receipt/journal evidence without throwing %#", (patch) => {
    const raw = evidence();
    expect(interpretInventoryShipmentQuantity({ ...raw, receipt: { ...raw.receipt, ...patch } }))
      .toMatchObject({ status: "invalid", code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID" });
  });
  it("validates the additive browser DTO, not raw on-hand deltas", () => {
    expect(inventoryShipmentQuantityEvidenceSchema.safeParse(interpretInventoryShipmentQuantity(evidence())).success).toBe(true);
    expect(inventoryShipmentQuantityEvidenceSchema.safeParse({ status: "verified", quantity: 3, source: "canonical_dispatch_receipt", receiptId: null }).success).toBe(false);
    expect(inventoryShipmentQuantityEvidenceSchema.safeParse({ status: "verified", quantity: 3, source: "legacy_on_hand_delta", receiptId: "1" }).success).toBe(false);
    expect(inventoryShipmentQuantityEvidenceSchema.safeParse({ status: "verified", quantity: 3, source: "canonical_dispatch_receipt", receiptId: "x" }).success).toBe(false);
    expect(inventoryShipmentQuantityEvidenceSchema.safeParse({ status: "verified", quantity: 0, source: "legacy_on_hand_delta", receiptId: null }).success).toBe(false);
  });
});
