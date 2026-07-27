import { describe, expect, it } from "vitest";
import {
  selectLateOrderShipmentTarget,
  type LateOrderShipmentCandidate,
} from "../../late-order-shipment-selection";

function shipment(
  overrides: Partial<LateOrderShipmentCandidate> = {},
): LateOrderShipmentCandidate {
  return {
    id: 101,
    status: "queued",
    source: "echelon_sync",
    shipmentPurpose: "customer_fulfillment",
    replacesShipmentId: null,
    shippingEngine: "shipstation",
    engineOrderRef: "123",
    shipstationOrderId: 123,
    requiresReview: false,
    ...overrides,
  };
}

describe("selectLateOrderShipmentTarget", () => {
  it("selects the single primary provider order for an in-place amendment", () => {
    expect(selectLateOrderShipmentTarget([shipment()])).toEqual({
      state: "target",
      shipment: shipment(),
    });
  });

  it("prefers one open late-edit residual so repeated edits coalesce", () => {
    const primary = shipment();
    const residual = shipment({
      id: 202,
      status: "planned",
      source: "late_order_edit",
      shippingEngine: null,
      engineOrderRef: null,
      shipstationOrderId: null,
    });

    expect(selectLateOrderShipmentTarget([primary, residual])).toEqual({
      state: "target",
      shipment: residual,
    });
  });

  it("returns ambiguity instead of guessing between multiple primaries", () => {
    expect(
      selectLateOrderShipmentTarget([
        shipment({ id: 303 }),
        shipment({ id: 101 }),
      ]),
    ).toEqual({
      state: "ambiguous",
      shipmentIds: [101, 303],
    });
  });

  it("does not reuse a labeled late-edit residual", () => {
    const primary = shipment();
    const labeledResidual = shipment({
      id: 202,
      status: "labeled",
      source: "late_order_edit",
    });

    expect(
      selectLateOrderShipmentTarget([primary, labeledResidual]),
    ).toEqual({
      state: "target",
      shipment: primary,
    });
  });

  it("ignores synthetic split and replacement packages", () => {
    expect(
      selectLateOrderShipmentTarget([
        shipment({ id: 1, source: "shipstation_split" }),
        shipment({ id: 2, replacesShipmentId: 1 }),
      ]),
    ).toEqual({ state: "none" });
  });
});
