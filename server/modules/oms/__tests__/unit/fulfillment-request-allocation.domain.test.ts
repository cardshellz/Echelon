import { describe, expect, it } from "vitest";
import {
  resolveFulfillmentRequestAllocation as resolve,
  type FulfillmentRequestAllocationTarget,
  type FulfillmentRequestAllocationSnapshot,
  type FulfillmentRequestPhysicalSnapshot,
} from "../../fulfillment-request-allocation.domain";

const target: FulfillmentRequestAllocationTarget = {
  fulfillmentPlanId: 10, fulfillmentPlanLineId: 11, wmsOrderId: 20, wmsOrderItemId: 21,
  omsOrderId: 30, omsOrderLineId: 31, warehouseId: 1, legacyWmsShipmentItemId: 52, sourceWmsShipmentItemId: 51,
  shippingProvider: "shipstation", providerPhysicalShipmentId: "package-2", quantityShipped: 1, quantityPlanned: 4,
};
const request: FulfillmentRequestAllocationSnapshot = {
  fulfillmentPlanId: 10, fulfillmentPlanLineId: 11, wmsOrderId: 20, wmsOrderItemId: 21,
  omsOrderId: 30, omsOrderLineId: 31, warehouseId: 1, legacyWmsShipmentItemId: 51,
  shipmentRequestId: 40, shipmentRequestItemId: 41, quantityRequested: 4, quantityCancelled: 0,
  requestStatus: "shipped", linkedToShippingOrder: true,
};
const physical: FulfillmentRequestPhysicalSnapshot = {
  physicalShipmentItemId: 91, allocationSourceShipmentItemId: null,
  shipmentRequestItemId: 41, fulfillmentPlanLineId: 11, legacyWmsShipmentItemId: null,
  shippingProvider: "shipstation", providerPhysicalShipmentId: "package-1", quantityShipped: 1, effectiveQuantityShipped: 1,
};

describe("physical packages allocate existing ordered units", () => {
  it("reuses four reserved units for additional packages, including allocation-ledger physical evidence", () => {
    const originals = JSON.stringify({ target, request, physical });
    expect(resolve(target, [request], [physical])).toEqual({ kind: "reuse", shipmentRequestId: 40,
      shipmentRequestItemId: 41, reason: "shipping_order_remaining_quantity" });
    expect(JSON.stringify({ target, request, physical })).toBe(originals);
  });

  it("permits a package portion smaller than its original source request", () => {
    expect(resolve({ ...target, legacyWmsShipmentItemId: 51 }, [request], [])).toMatchObject({ kind: "reuse", reason: "source_item" });
  });

  it("counts sibling replacement portions without treating them as replays of this package", () => {
    expect(resolve({ ...target, legacyWmsShipmentItemId: 51 }, [request], [
      { ...physical, labelReplacementSourceItemId: 51 },
      { ...physical, physicalShipmentItemId: 92, providerPhysicalShipmentId: 'package-3', labelReplacementSourceItemId: 51 },
    ])).toMatchObject({ kind: 'reuse', reason: 'source_item' });
  });

  it("replays only the exact replacement package and still counts its siblings against paid quantity", () => {
    const items = [physical, { ...physical, physicalShipmentItemId: 92, providerPhysicalShipmentId: target.providerPhysicalShipmentId }]
      .map(item => ({ ...item, labelReplacementSourceItemId: 51 }));
    expect(resolve({ ...target, legacyWmsShipmentItemId: 51, quantityPlanned: 2 },
      [{ ...request, quantityRequested: 2 }], items)).toMatchObject({ kind: 'reuse', reason: 'physical_replay' });
    expect(() => resolve({ ...target, legacyWmsShipmentItemId: 51, providerPhysicalShipmentId: 'new-package', quantityPlanned: 2 },
      [{ ...request, quantityRequested: 2 }], items)).toThrow('physical_quantity_exceeds_paid_authority');
  });

  it("does not allow replacement provenance to weaken immutable replay or exclusive legacy identity", () => {
    const replacement = { ...physical, labelReplacementSourceItemId: target.legacyWmsShipmentItemId,
      providerPhysicalShipmentId: target.providerPhysicalShipmentId };
    expect(() => resolve(target, [request], [{ ...replacement, quantityShipped: 2 }]))
      .toThrow('immutable_physical_allocation_changed');
    expect(() => resolve(target, [request], [{ ...replacement, legacyWmsShipmentItemId: target.legacyWmsShipmentItemId }]))
      .toThrow('ambiguous_physical_source_provenance');
    expect(() => resolve(target, [request], [replacement, replacement])).toThrow('ambiguous_physical_replay');
  });

  it("creates a request only for units that have not already been requested", () => {
    expect(resolve(target, [{ ...request, quantityRequested: 1 }], [physical])).toEqual({ kind: "create" });
    expect(resolve({ ...target, fulfillmentPlanId: null, fulfillmentPlanLineId: null }, [], [])).toEqual({ kind: "create" });
  });

  it("replays the exact immutable package without consuming its quantity again", () => {
    const replay = { ...physical, providerPhysicalShipmentId: target.providerPhysicalShipmentId,
      legacyWmsShipmentItemId: target.legacyWmsShipmentItemId };
    expect(resolve({ ...target, quantityPlanned: 1 }, [{ ...request, quantityRequested: 1 }], [replay]))
      .toMatchObject({ kind: "reuse", reason: "physical_replay" });
  });

  it.each(["warehouseId", "omsOrderId", "omsOrderLineId", "wmsOrderId", "wmsOrderItemId", "fulfillmentPlanId", "fulfillmentPlanLineId"] as const)(
    "never relinks direct source evidence across %s", field => {
      expect(() => resolve({ ...target, legacyWmsShipmentItemId: 51 }, [{ ...request, [field]: 999 }], []))
        .toThrow("request_scope_mismatch");
    });

  it("does not take another shipping order's reservation", () => {
    expect(() => resolve(target, [{ ...request, linkedToShippingOrder: false }], [physical]))
      .toThrow("no_unrequested_paid_quantity");
  });

  it.each(["cancelled", "review"] as const)("does not reuse a %s request", requestStatus => {
    expect(() => resolve({ ...target, legacyWmsShipmentItemId: 51 }, [{ ...request, requestStatus }], []))
      .toThrow("request_not_active");
  });

  it("rejects ambiguous same-line reservations instead of picking the first", () => {
    expect(() => resolve({ ...target, quantityPlanned: 8 }, [request, { ...request, shipmentRequestId: 42, shipmentRequestItemId: 43,
      legacyWmsShipmentItemId: 53 }], [physical])).toThrow("ambiguous_remaining_requests");
  });

  it("does not reuse a reservation when the persisted requests already exceed paid units", () => {
    expect(() => resolve(target, [{ ...request, quantityRequested: 5 }], [physical]))
      .toThrow("requests_exceed_paid_authority");
  });

  it("honors cancelled quantities and cannot spread a single immutable legacy row across requests", () => {
    expect(() => resolve({ ...target, quantityShipped: 2 }, [{ ...request, quantityCancelled: 2 }], [physical]))
      .toThrow("request_quantity_exhausted");
  });

  it("counts all effective physical units and rejects real overfulfillment", () => {
    expect(() => resolve(target, [request], [{ ...physical, quantityShipped: 4, effectiveQuantityShipped: 4 }]))
      .toThrow("physical_quantity_exceeds_paid_authority");
    expect(resolve(target, [request], [{ ...physical, quantityShipped: 4, effectiveQuantityShipped: 3 }]))
      .toMatchObject({ kind: "reuse" });
  });

  it("does not insert a second provenance for an already allocated physical package", () => {
    expect(() => resolve(target, [request], [{ ...physical, providerPhysicalShipmentId: target.providerPhysicalShipmentId }]))
      .toThrow("physical_package_already_allocated");
  });

  it.each([
    { providerPhysicalShipmentId: "wrong" }, { quantityShipped: 2 }, { effectiveQuantityShipped: 0 },
    { fulfillmentPlanLineId: 99 }, { shippingProvider: "other" },
  ])("rejects changed immutable replay evidence: %j", changed => {
    expect(() => resolve(target, [request], [{ ...physical, providerPhysicalShipmentId: target.providerPhysicalShipmentId,
      legacyWmsShipmentItemId: target.legacyWmsShipmentItemId, ...changed }]))
      .toThrow("immutable_physical_allocation_changed");
  });

  it.each([0, -1, 0.5, Number.NaN, 2_147_483_648])("rejects invalid package quantity %s", quantityShipped => {
    expect(() => resolve({ ...target, quantityShipped }, [request], [physical])).toThrow("Invalid request allocation evidence");
  });

  it("does integer-safe arithmetic at the database quantity limit", () => {
    const max = 2_147_483_647;
    expect(resolve({ ...target, quantityPlanned: max }, [{ ...request, quantityRequested: max }], [
      { ...physical, quantityShipped: max - 1, effectiveQuantityShipped: max - 1 },
    ])).toMatchObject({ kind: "reuse" });
  });
});


describe("label-time allocation followed by carrier split identity", () => {
  const packageTarget = { ...target, providerPhysicalShipmentId: "package-1", quantityShipped: 2, quantityPlanned: 3 };
  const allocation = { ...physical, allocationSourceShipmentItemId: 51, quantityShipped: 2, effectiveQuantityShipped: 2 };
  const originalRequest = { ...request, quantityRequested: 3 };

  it("returns the saved physical item for a compatibility child without allocating its two units again", () => {
    const evidence = structuredClone({ packageTarget, originalRequest, allocation });
    expect(resolve(packageTarget, [originalRequest], [allocation])).toEqual({ kind: "reuse",
      shipmentRequestId: 40, shipmentRequestItemId: 41, physicalShipmentItemId: 91, reason: "physical_replay" });
    expect({ packageTarget, originalRequest, allocation }).toEqual(evidence);
  });
  it("replays a parcel after the final sibling has consumed all three units", () => {
    expect(resolve(packageTarget, [originalRequest], [allocation, { ...allocation, physicalShipmentItemId: 92,
      providerPhysicalShipmentId: "package-2", quantityShipped: 1, effectiveQuantityShipped: 1 }]))
      .toMatchObject({ reason: "physical_replay", physicalShipmentItemId: 91 });
  });
  it("accepts the last one-unit parcel but rejects a genuine fourth unit", () => {
    expect(resolve({ ...packageTarget, providerPhysicalShipmentId: "package-2", quantityShipped: 1 },
      [originalRequest], [allocation])).toMatchObject({ reason: "shipping_order_remaining_quantity" });
    expect(() => resolve({ ...packageTarget, providerPhysicalShipmentId: "package-2" },
      [originalRequest], [allocation])).toThrow("physical_quantity_exceeds_paid_authority");
  });
  it.each([{ quantityShipped: 1 }, { effectiveQuantityShipped: 1 }, { fulfillmentPlanLineId: 99 }])(
    "rejects changed canonical allocation evidence %j", changed => {
      expect(() => resolve(packageTarget, [originalRequest], [{ ...allocation, ...changed }]))
        .toThrow("immutable_physical_allocation_changed");
    });
  it("does not infer allocation provenance from the provider package ID alone", () => {
    expect(() => resolve(packageTarget, [originalRequest], [{ ...allocation, allocationSourceShipmentItemId: 99 }]))
      .toThrow("physical_quantity_exceeds_paid_authority");
  });
  it("rejects ambiguous provenance and cross-warehouse request reuse", () => {
    expect(() => resolve(packageTarget, [originalRequest], [{ ...allocation, legacyWmsShipmentItemId: 52 }]))
      .toThrow("ambiguous_physical_source_provenance");
    expect(() => resolve(packageTarget, [{ ...originalRequest, warehouseId: 99 }], [allocation]))
      .toThrow("request_scope_mismatch");
  });
});
