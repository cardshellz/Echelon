import { describe, expect, it } from "vitest";
import { readSourceShipmentPostedQuantity } from "../../domain/source-shipment-quantity-evidence";

const identity = { orderId: 42, orderItemId: 101, shipmentId: 10, shipmentItemId: 501, productVariantId: 201 };
function legacy(transactionId = 1, delta = -3) {
  return { ...identity, transactionId, transactionType: "ship", referenceType: null, receipt: null, variantQtyDelta: delta };
}
function canonical() {
  return { ...legacy(), variantQtyDelta: 0, reservedQtyDelta: 0, sourceState: "picked", targetState: "shipped",
    fromLocationId: 301, referenceType: "availability_claim_dispatch",
    receipt: { ...identity, id: "1", quantity: "3", fromLocationId: 301, warehouseId: 1,
      physicalShipmentId: null, physicalShipmentItemId: null, movementQuantity: "3", invalidMovementCount: "0" } };
}

describe("existing source shipment posted quantity", () => {
  it("preserves absent and split legacy postings without inventing a source", () => {
    expect(readSourceShipmentPostedQuantity([], identity)).toEqual({ quantity: 0, source: null });
    expect(readSourceShipmentPostedQuantity([legacy(1), legacy(2, -2)], identity)).toEqual({ quantity: 5, source: "legacy_on_hand_delta" });
    expect(readSourceShipmentPostedQuantity([{ ...legacy(), shipmentItemId: null, orderId: null }], identity)).toEqual({ quantity: 3, source: "legacy_on_hand_delta" });
  });
  it("reads the exact canonical quantity without a negative on-hand delta", () => {
    const raw = [canonical()]; const before = structuredClone(raw);
    expect(readSourceShipmentPostedQuantity(raw, identity)).toEqual({ quantity: 3, source: "canonical_dispatch_receipt" });
    expect(raw).toEqual(before);
  });
  it.each([null, undefined, {}, "[]", new Array(1001).fill(legacy())])("rejects absent or oversized evidence %#", (raw) => {
    expect(() => readSourceShipmentPostedQuantity(raw, identity)).toThrowError(expect.objectContaining({ code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID" }));
  });
  it.each(["orderId", "orderItemId", "shipmentId", "shipmentItemId", "productVariantId"] as const)
    ("does not attach inventory evidence from another %s", (field) => {
      expect(() => readSourceShipmentPostedQuantity([{ ...legacy(), [field]: 999 }], identity)).toThrow("another source identity");
    });
  it("rejects duplicate or mixed canonical postings and does not count them twice", () => {
    expect(() => readSourceShipmentPostedQuantity([legacy(), legacy()], identity)).toThrow("duplicate");
    expect(() => readSourceShipmentPostedQuantity([canonical(), legacy(2)], identity)).toThrow("cannot be combined");
    expect(() => readSourceShipmentPostedQuantity([legacy(2), canonical()], identity)).toThrow("cannot be combined");
  });
  it("fails safely for inconsistent canonical markers and invalid legacy quantities", () => {
    expect(() => readSourceShipmentPostedQuantity([{ ...canonical(), receipt: null }], identity)).toThrow("must both be present");
    expect(() => readSourceShipmentPostedQuantity([legacy(1, 0)], identity)).toThrow("neither a valid legacy debit");
    expect(() => readSourceShipmentPostedQuantity([{ ...legacy(), transactionType: "pick" }], identity)).toThrow("not a shipment");
  });
  it("checks aggregate overflow and input identity before accepting a posting", () => {
    expect(() => readSourceShipmentPostedQuantity([legacy(1, -2147483647), legacy(2, -1)], identity)).toThrow("integer boundary");
    expect(() => readSourceShipmentPostedQuantity([], { ...identity, shipmentId: 0 })).toThrow("exact PostgreSQL identities");
  });
  it.each([null, undefined, {}, { ...identity, orderId: undefined }, { ...identity, shipmentItemId: undefined }])
    ("rejects missing expected identities even with no rows %#", (expected) => {
      expect(() => readSourceShipmentPostedQuantity([], expected as unknown as typeof identity)).toThrow("exact PostgreSQL identities");
    });
});
