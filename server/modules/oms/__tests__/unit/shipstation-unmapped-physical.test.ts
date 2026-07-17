import { describe, expect, it, vi } from "vitest";

import {
  SHIPSTATION_UNMAPPED_PHYSICAL_RULE,
  buildShipStationUnmappedPhysicalIdempotencyKey,
  buildShipStationUnmappedPhysicalSummary,
  recordShipStationUnmappedPhysicalException,
  shipStationShipmentRefFromExternalFulfillmentId,
} from "../../shipstation-unmapped-physical";

function sqlText(query: any): string {
  return (query?.queryChunks ?? [])
    .map((chunk: any) => {
      if (typeof chunk === "string") return chunk;
      if (Array.isArray(chunk?.value)) return chunk.value.join("");
      return "";
    })
    .join("");
}

describe("ShipStation unmapped physical shipment evidence", () => {
  it("uses the provider physical shipment as the durable exception identity", () => {
    expect(buildShipStationUnmappedPhysicalIdempotencyKey({
      shipmentId: 443121354,
      orderId: 123,
      orderKey: "echelon-wms-shp-6061",
      trackingNumber: "9400",
    })).toBe(
      `shipstation_notify:${SHIPSTATION_UNMAPPED_PHYSICAL_RULE}:shipment:443121354`,
    );
    expect(shipStationShipmentRefFromExternalFulfillmentId(
      "shipstation_shipment:443121354",
    )).toBe("443121354");
    expect(shipStationShipmentRefFromExternalFulfillmentId("gid://shopify/1")).toBeNull();
  });

  it("explains the blocked decision in operational English", () => {
    expect(buildShipStationUnmappedPhysicalSummary({
      shipmentId: 446104678,
      orderNumber: "EB-24-14838-80207",
      trackingNumber: "1Z8X330WYN43653055",
    })).toBe(
      "ShipStation reported another package for order EB-24-14838-80207 " +
      "with tracking 1Z8X330WYN43653055. Echelon did not change fulfillment " +
      "or inventory because it could not determine whether the package was " +
      "an intentional replacement or a duplicate.",
    );
  });

  it("records blocked fulfillment and inventory evidence as one open review exception", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));

    await recordShipStationUnmappedPhysicalException({ execute }, {
      shipment: {
        shipmentId: 443121354,
        orderId: 99,
        orderKey: "echelon-wms-shp-6061",
        orderNumber: "#59030",
        trackingNumber: "9400",
        shipmentItems: [{ lineItemKey: null, sku: "SKU-A", quantity: 1 }],
      },
      wmsOrderId: 1234,
      wmsShipmentId: 6061,
      blockedReason: "test_block",
    });

    expect(execute).toHaveBeenCalledOnce();
    const statement = sqlText(execute.mock.calls[0][0]);
    expect(statement).toContain("INSERT INTO wms.reconciliation_exceptions");
    expect(statement).toContain("existing.status IN ('resolved', 'ignored')");
    expect(statement).toContain("ON CONFLICT (idempotency_key)");
    expect(statement).toContain("occurrence_count = wms.reconciliation_exceptions.occurrence_count + 1");
    expect(statement).toContain("summary = EXCLUDED.summary");
  });
});
