import { describe, expect, it } from "vitest";
import { planConfirmedPickShipment } from "../../confirmed-pick-shipment";

const shipment = Object.freeze({ id: 75376, order_id: 208936, product_variant_id: 66,
  from_location_id: 1331, variant_qty_delta: -2, variant_qty_before: 0, variant_qty_after: 0,
  source_state: "picked", target_state: "shipped", voided: false });
const input = Object.freeze({ shipments: Object.freeze([shipment]), orderId: 208936,
  productVariantId: 66, sourceLocationId: 1331, pickedQuantity: 0,
  targetPickedQuantity: 2, confirmedPreviouslyPicked: true });

describe("confirmed missed-pick shipment evidence", () => {
  it("restores a shipment's picked balance without a second shipment deduction", () => {
    expect(planConfirmedPickShipment(input)).toEqual({ kind: "restore_picked_balance",
      shipmentTransactionIds: [75376], shippedQuantity: 2 });
    expect(input.shipments).toEqual([shipment]);
  });
  it.each([{ shipments: [] }, { shipments: [{ ...shipment, variant_qty_delta: -1 }] }])("allows ordinary progress already covered by picks: %j", ({ shipments }) => {
    expect(planConfirmedPickShipment({ ...input, pickedQuantity: 1, shipments })).toEqual({ kind: "ordinary_pick" });
  });
  it("handles multiple packages and prior partial picks cumulatively", () => {
    expect(planConfirmedPickShipment({ ...input, pickedQuantity: 1, targetPickedQuantity: 3,
      shipments: [shipment, { ...shipment, id: 75377, variant_qty_delta: -1 }] })).toEqual({
      kind: "restore_picked_balance", shipmentTransactionIds: [75376, 75377], shippedQuantity: 3 });
  });
  it("does not authorize a new physical pick after No using the historical shipment", () => {
    expect(planConfirmedPickShipment({ ...input, confirmedPreviouslyPicked: false })).toMatchObject({ kind: "review" });
  });
  it.each([
    { source_state: "on_hand", variant_qty_before: 2, variant_qty_after: 0 },
    { source_state: "on_hand", variant_qty_before: 1, variant_qty_after: 0 },
  ])("never spends on-hand twice when shipping already used it: %j", change => {
    expect(planConfirmedPickShipment({ ...input, shipments: [{ ...shipment, ...change }] }))
      .toMatchObject({ kind: "review", message: expect.stringContaining("original lot costs") });
  });
  it.each([
    { order_id: 208937 }, { product_variant_id: 67 }, { from_location_id: 1332 },
    { variant_qty_delta: -3 }, { variant_qty_delta: 0 }, { variant_qty_delta: 2 },
    { variant_qty_delta: null }, { variant_qty_delta: -1.5 }, { source_state: null },
    { target_state: "picked" }, { voided: true }, { variant_qty_before: null },
    { variant_qty_before: 1 }, { variant_qty_after: 1 },
    { source_state: "on_hand" }, { source_state: "on_hand", variant_qty_before: 3 },
  ])("keeps inconsistent, mismatched, or excess evidence in review: %j", change => {
    expect(planConfirmedPickShipment({ ...input, shipments: [{ ...shipment, ...change }] })).toMatchObject({ kind: "review" });
  });
  it("rejects a cumulative quantity beyond safe integer arithmetic", () => {
    expect(planConfirmedPickShipment({ ...input, shipments: [
      { ...shipment, variant_qty_delta: -Number.MAX_SAFE_INTEGER }, shipment,
    ] })).toMatchObject({ kind: "review" });
  });
});
