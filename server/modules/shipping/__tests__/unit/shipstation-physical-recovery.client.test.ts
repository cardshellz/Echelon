import { describe, expect, it, vi } from "vitest";
import {
  createShipStationPhysicalRecoveryClient,
  parseWmsShipmentItemIdentity,
} from "../../shipstation-physical-recovery.client";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("shipstation physical recovery client", () => {
  it.each([
    ["wms-item-9638", 9638],
    [" wms-item-9638 ", 9638],
    ["wms-item-0", null],
    ["prefix-wms-item-9638", null],
    ["9638", null],
    [null, null],
  ])("parses only exact Echelon shipment-item identities (%s)", (value, expected) => {
    expect(parseWmsShipmentItemIdentity(value)).toBe(expected);
  });

  it("finds a combined physical package by its exact WMS shipment-item identities", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/shipments") {
        expect(url.searchParams.get("shipment_number")).toBe("#59564");
        return jsonResponse({
          page: 1,
          pages: 1,
          shipments: [{
            shipment_id: "se-755791888",
            shipment_number: "#59563",
            external_shipment_id: "echelon-wms-shp-4840",
            items: [
              { external_order_item_id: "wms-item-9636" },
              { external_order_item_id: "wms-item-9638" },
              { external_order_item_id: "shopify-line-9638" },
            ],
          }],
        });
      }
      if (url.pathname === "/v2/labels") {
        expect(url.searchParams.get("shipment_id")).toBe("se-755791888");
        expect(url.searchParams.get("label_status")).toBe("completed");
        return jsonResponse({
          page: 1,
          pages: 1,
          labels: [{
            label_id: "se-442730042",
            status: "completed",
            shipment_id: "se-755791888",
            tracking_number: "9400150206217759204396",
            is_return_label: false,
            ship_date: "2026-07-01",
            carrier_code: "stamps_com",
            service_code: "usps_ground_advantage",
          }, {
            label_id: "se-442730043",
            status: "completed",
            shipment_id: "se-755791888",
            tracking_number: "RETURN-TRACKING",
            is_return_label: true,
            ship_date: "2026-07-01",
          }],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = createShipStationPhysicalRecoveryClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.shipstation.com/v2",
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.listCompletedPackagesForOrder("#59564")).resolves.toEqual([{
      providerShipmentId: "se-755791888",
      providerLabelId: "se-442730042",
      legacyShipStationShipmentId: 442730042,
      trackingNumber: "9400150206217759204396",
      shipDate: "2026-07-01",
      carrierCode: "stamps_com",
      serviceCode: "usps_ground_advantage",
      wmsShipmentItemIds: [9636, 9638],
    }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: { "API-Key": "test-api-key" },
    });
  });

  it("does not fetch labels when ShipStation returns no owned item identity", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      page: 1,
      pages: 1,
      shipments: [{
        shipment_id: "se-755791888",
        shipment_number: "#59564",
        items: [{ external_order_item_id: "external-item-9638" }],
      }],
    }));
    const client = createShipStationPhysicalRecoveryClient({
      apiKey: "test-api-key",
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.listCompletedPackagesForOrder("#59564")).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
