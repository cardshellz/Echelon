import type {
  PackageHistoryNative,
  PackageHistoryScope,
  RetainedPackageHistoryShipment,
} from "../../package-history.domain";
const instant = new Date("2026-09-23T12:00:00Z");
export function historyFixture() {
  const scope: PackageHistoryScope = {
    omsOrderId: 100,
    channelId: 36,
    connectionId: 4,
    externalOrderId: "1001",
    externalCustomerId: null,
    orderReference: "#12",
    shopDomain: "fixture.myshopify.com",
    displayName: "Fixture",
    lines: [
      {
        omsOrderLineId: 101,
        externalLineId: "501",
        sku: "PRODUCT",
        quantity: 1,
        requiresShipping: true,
        aliases: ["wms-item-301"],
      },
      {
        omsOrderLineId: 102,
        externalLineId: "502",
        sku: "CLUB",
        quantity: 1,
        requiresShipping: false,
        aliases: [],
      },
    ],
  };
  const native: PackageHistoryNative = {
    orderId: "1001",
    reference: "#12",
    customerId: null,
    lines: scope.lines.map((line) => ({
      id: line.externalLineId,
      sku: line.sku,
      quantity: line.quantity,
      requiresShipping: line.requiresShipping,
    })),
    fulfillments: [
      {
        id: "701",
        status: "SUCCESS",
        updatedAt: instant.toISOString(),
        tracking: ["TRACK601"],
        lines: [{ lineItemId: "501", quantity: 1 }],
      },
      {
        id: "702",
        status: "SUCCESS",
        updatedAt: instant.toISOString(),
        tracking: [],
        lines: [{ lineItemId: "502", quantity: 1 }],
      },
    ],
  };
  const observations: RetainedPackageHistoryShipment[] = [
    {
      observationHash: "a".repeat(64),
      shipment: {
        shipmentId: 601,
        orderNumber: "12",
        trackingNumber: "TRACK601",
        isReturnLabel: false,
        voided: false,
        voidDate: null,
        dimensions: { units: "inches", length: 10, width: 8, height: 4 },
        shipmentItems: [{ lineItemKey: "501", sku: "PRODUCT", quantity: 1 }],
      },
    },
  ];
  return { scope, native, observations };
}
