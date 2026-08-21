import { describe, expect, it } from "vitest";

import {
  parsePositiveWmsShipmentItemsFromShipStation,
  type ShipStationShipment,
} from "../../shipstation.service";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

function shipmentWithItems(shipmentItems: unknown): ShipStationShipment {
  return {
    shipmentId: 4_427_300_420,
    orderId: 7_558_026_730,
    orderKey: "provider-order-key",
    orderNumber: "#59564",
    trackingNumber: "TRACKING",
    carrierCode: "stamps_com",
    serviceCode: "usps_ground_advantage",
    shipDate: "2026-06-28T14:10:00.000Z",
    voidDate: null,
    shipmentCost: 0,
    shipmentItems,
  } as ShipStationShipment;
}

describe("ShipStation mutation item authority", () => {
  it("accepts exact unique PostgreSQL-integer identities and quantities", () => {
    expect(parsePositiveWmsShipmentItemsFromShipStation(shipmentWithItems([
      {
        lineItemKey: `wms-item-${POSTGRES_INTEGER_MAX}`,
        quantity: POSTGRES_INTEGER_MAX,
      },
      { lineItemKey: "wms-item-1", quantity: 1 },
    ]))).toEqual([
      { sourceShipmentItemId: 1, qty: 1 },
      {
        sourceShipmentItemId: POSTGRES_INTEGER_MAX,
        qty: POSTGRES_INTEGER_MAX,
      },
    ]);
  });

  it.each([
    ["missing quantity", [{ lineItemKey: "wms-item-1" }]],
    ["string quantity", [{ lineItemKey: "wms-item-1", quantity: "1" }]],
    ["trimmed key", [{ lineItemKey: " wms-item-1 ", quantity: 1 }]],
    [
      "out-of-range item id",
      [{ lineItemKey: `wms-item-${POSTGRES_INTEGER_MAX + 1}`, quantity: 1 }],
    ],
    [
      "out-of-range quantity",
      [{ lineItemKey: "wms-item-1", quantity: POSTGRES_INTEGER_MAX + 1 }],
    ],
    [
      "duplicate item key",
      [
        { lineItemKey: "wms-item-1", quantity: 1 },
        { lineItemKey: "wms-item-1", quantity: 1 },
      ],
    ],
    [
      "duplicate overflow",
      [
        { lineItemKey: "wms-item-1", quantity: POSTGRES_INTEGER_MAX },
        { lineItemKey: "wms-item-1", quantity: 1 },
      ],
    ],
  ])("rejects non-authoritative %s evidence", (_case, shipmentItems) => {
    expect(
      parsePositiveWmsShipmentItemsFromShipStation(
        shipmentWithItems(shipmentItems),
      ),
    ).toBeNull();
  });
});
