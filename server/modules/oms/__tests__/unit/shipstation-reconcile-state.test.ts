import { describe, expect, it } from "vitest";
import {
  deriveShipStationShipmentReconcileEvent,
  filterShipmentsForShipStationOrder,
  selectActionableShipStationShipments,
  type ShipStationReconcileShipment,
} from "../../shipstation-reconcile-state";

describe("ShipStation shipment reconcile state", () => {
  it("does not void the current WMS shipment from a sibling split shipment void", () => {
    const shipments: ShipStationReconcileShipment[] = [
      {
        shipmentId: 434606785,
        orderId: 742390209,
        trackingNumber: "1Z-SIBLING",
        shipDate: "2026-05-27T13:00:00Z",
        voidDate: "2026-05-27T14:00:00Z",
      },
    ];

    const currentOrderShipments = filterShipmentsForShipStationOrder(
      shipments,
      742389528,
    );

    const event = deriveShipStationShipmentReconcileEvent({
      ssOrderStatus: "shipped",
      currentWmsShipmentStatus: "shipped",
      shipments: currentOrderShipments,
    });

    expect(currentOrderShipments).toEqual([]);
    expect(event).toBeNull();
  });

  it("treats an active replacement label as shipped instead of voided", () => {
    const shipments: ShipStationReconcileShipment[] = [
      {
        shipmentId: 434603717,
        orderId: 742389528,
        trackingNumber: "9400-OLD",
        carrierCode: "stamps_com",
        shipDate: "2026-05-27T12:00:00Z",
        voidDate: "2026-05-27T13:00:00Z",
      },
      {
        shipmentId: 434605282,
        orderId: 742389528,
        trackingNumber: "1Z-NEW",
        carrierCode: "ups",
        shipDate: "2026-05-27T15:00:00Z",
        voidDate: null,
      },
    ];

    const event = deriveShipStationShipmentReconcileEvent({
      ssOrderStatus: "shipped",
      currentWmsShipmentStatus: "queued",
      shipments,
    });

    expect(event).toMatchObject({
      kind: "shipped",
      trackingNumber: "1Z-NEW",
      carrier: "ups",
    });
  });

  it("voids only when all visible labels for the current ShipStation order are voided", () => {
    const event = deriveShipStationShipmentReconcileEvent({
      ssOrderStatus: "awaiting_shipment",
      currentWmsShipmentStatus: "queued",
      shipments: [
        {
          shipmentId: 434603717,
          orderId: 742389528,
          trackingNumber: "9400-OLD",
          carrierCode: "stamps_com",
          shipDate: "2026-05-27T12:00:00Z",
          voidDate: "2026-05-27T13:00:00Z",
        },
      ],
    });

    expect(event).toEqual({ kind: "voided", reason: "ss_label_void" });
  });

  it("selects active labels per ShipStation order and ignores stale voids when an active label exists", () => {
    const selected = selectActionableShipStationShipments([
      {
        shipmentId: 1,
        orderId: 100,
        trackingNumber: "VOIDED-OLD",
        shipDate: "2026-05-27T12:00:00Z",
        voidDate: "2026-05-27T13:00:00Z",
      },
      {
        shipmentId: 2,
        orderId: 100,
        trackingNumber: "ACTIVE-NEW",
        shipDate: "2026-05-27T15:00:00Z",
        voidDate: null,
      },
      {
        shipmentId: 3,
        orderId: 101,
        trackingNumber: "VOIDED-SPLIT",
        shipDate: "2026-05-27T16:00:00Z",
        voidDate: "2026-05-27T17:00:00Z",
      },
    ]);

    expect(selected.map((shipment) => shipment.shipmentId)).toEqual([2, 3]);
  });
});
