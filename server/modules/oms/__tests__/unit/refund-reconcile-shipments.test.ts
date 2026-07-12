import { describe, expect, it } from "vitest";
import {
  allocateActiveShipmentItems,
  deriveRefundAuthority,
  extractRefundLineAdjustments,
  RefundsCreateBadPayloadError,
} from "../../refund-line-disposition";

describe("Shopify refund line disposition", () => {
  describe("extractRefundLineAdjustments", () => {
    it("treats a missing line collection as a money-only refund", () => {
      expect(extractRefundLineAdjustments(undefined)).toEqual([]);
      expect(extractRefundLineAdjustments(null)).toEqual([]);
    });

    it("preserves Shopify line identity, quantity, and restock policy", () => {
      expect(extractRefundLineAdjustments([
        { line_item_id: 11, quantity: 2, restock_type: "no_restock" },
        { line_item: { id: 12 }, quantity: 1, restock_type: "return" },
        { line_item_id: 13, quantity: 3, restock: true },
        { line_item_id: 14, quantity: 4, restock_type: "cancel" },
      ])).toMatchObject([
        { externalLineItemId: "11", quantity: 2, restockPolicy: "no_restock" },
        { externalLineItemId: "12", quantity: 1, restockPolicy: "return" },
        { externalLineItemId: "13", quantity: 3, restockPolicy: "restock" },
        { externalLineItemId: "14", quantity: 4, restockPolicy: "cancel" },
      ]);
    });

    it.each([
      ["non-array", {}],
      ["non-object line", [null]],
      ["missing line id", [{ quantity: 1 }]],
      ["non-positive quantity", [{ line_item_id: 1, quantity: 0 }]],
      ["duplicate line id", [
        { line_item_id: 1, quantity: 1 },
        { line_item_id: 1, quantity: 1 },
      ]],
    ])("rejects %s instead of silently dropping warehouse authority", (_label, value) => {
      expect(() => extractRefundLineAdjustments(value)).toThrow(RefundsCreateBadPayloadError);
    });
  });

  describe("deriveRefundAuthority", () => {
    it("removes a no-restock refund from fulfillment authority", () => {
      expect(deriveRefundAuthority({
        paidQuantity: 25,
        previousAuthorityFulfillableQuantity: 25,
        cancelledQuantity: 0,
        refundCancelQuantity: 0,
        refundOtherQuantity: 25,
      })).toEqual({
        authorityFulfillableQuantity: 0,
        refundedQuantity: 25,
        authorizationStatus: "refunded",
        overDispositionQuantity: 0,
      });
    });

    it("does not subtract Shopify cancel-policy refunds twice", () => {
      expect(deriveRefundAuthority({
        paidQuantity: 10,
        previousAuthorityFulfillableQuantity: 6,
        cancelledQuantity: 4,
        refundCancelQuantity: 4,
        refundOtherQuantity: 0,
      })).toEqual({
        authorityFulfillableQuantity: 6,
        refundedQuantity: 4,
        authorizationStatus: "partially_refunded",
        overDispositionQuantity: 0,
      });
    });

    it("reduces authority for a partial refund without increasing prior authority", () => {
      expect(deriveRefundAuthority({
        paidQuantity: 10,
        previousAuthorityFulfillableQuantity: 7,
        cancelledQuantity: 0,
        refundCancelQuantity: 0,
        refundOtherQuantity: 2,
      })).toMatchObject({
        authorityFulfillableQuantity: 7,
        refundedQuantity: 2,
        authorizationStatus: "partially_refunded",
      });
    });

    it("fails closed to review when cumulative dispositions exceed paid quantity", () => {
      expect(deriveRefundAuthority({
        paidQuantity: 3,
        previousAuthorityFulfillableQuantity: 3,
        cancelledQuantity: 2,
        refundCancelQuantity: 0,
        refundOtherQuantity: 2,
      })).toMatchObject({
        authorityFulfillableQuantity: 0,
        refundedQuantity: 2,
        authorizationStatus: "review",
        overDispositionQuantity: 1,
      });
    });
  });

  describe("allocateActiveShipmentItems", () => {
    it("deletes all active shipment demand after a full refund", () => {
      expect(allocateActiveShipmentItems([
        { shipmentItemId: 1, shipmentId: 10, orderItemId: 100, currentQuantity: 2, remainingDemand: 0 },
        { shipmentItemId: 2, shipmentId: 11, orderItemId: 100, currentQuantity: 2, remainingDemand: 0 },
      ])).toMatchObject([
        { shipmentItemId: 1, nextQuantity: 0, changed: true },
        { shipmentItemId: 2, nextQuantity: 0, changed: true },
      ]);
    });

    it("allocates partial remaining demand once across split shipments", () => {
      expect(allocateActiveShipmentItems([
        { shipmentItemId: 2, shipmentId: 11, orderItemId: 100, currentQuantity: 2, remainingDemand: 3 },
        { shipmentItemId: 1, shipmentId: 10, orderItemId: 100, currentQuantity: 2, remainingDemand: 3 },
      ])).toMatchObject([
        { shipmentItemId: 1, nextQuantity: 2, changed: false },
        { shipmentItemId: 2, nextQuantity: 1, changed: true },
      ]);
    });

    it("keeps allocation independent for each WMS order item", () => {
      expect(allocateActiveShipmentItems([
        { shipmentItemId: 1, shipmentId: 10, orderItemId: 100, currentQuantity: 2, remainingDemand: 1 },
        { shipmentItemId: 2, shipmentId: 10, orderItemId: 101, currentQuantity: 4, remainingDemand: 3 },
      ])).toMatchObject([
        { shipmentItemId: 1, nextQuantity: 1 },
        { shipmentItemId: 2, nextQuantity: 3 },
      ]);
    });

    it("never emits a negative shipment quantity", () => {
      const allocations = allocateActiveShipmentItems([
        { shipmentItemId: 1, shipmentId: 10, orderItemId: 100, currentQuantity: 1, remainingDemand: 0 },
      ]);
      expect(allocations.every((row) => row.nextQuantity >= 0)).toBe(true);
    });
  });
});
