import { describe, expect, it, vi } from "vitest";
import { createShipStationLabelReconciliationClient, shipStationQueryDate } from "../../shipstation-label-reconciliation.client";
import type { ShipStationApiRequester } from "../../shipstation-api-request";

const label = { shipmentId: 460595426, orderId: 790960007, orderKey: "echelon-wms-shp-17763", orderNumber: "63261 / 63300",
  carrierCode: "fedex", serviceCode: "fedex_ground", trackingNumber: "877510065050", shipmentCost: 0,
  isReturnLabel: false, shipDate: "2026-09-21", voided: true, voidDate: "2026-09-21T10:23:21.9930000",
  shipmentItems: [{ lineItemKey: "wms-item-23321", sku: null, quantity: 12 }] };
const page = { shipments: [label], page: 1, pages: 1, total: 1 };
function fixture(value: unknown = page) {
  const request = vi.fn(async () => value);
  const client = createShipStationLabelReconciliationClient(request as ShipStationApiRequester, () => true);
  return { request, client };
}
const window = { start: new Date("2026-09-20T20:00:00Z"), end: new Date("2026-09-21T19:58:00Z"), page: 1 };

describe("ShipStation void discovery HTTP boundary", () => {
  it("requests void dates, not creation dates, with exact contents and bounded HTTP work", async () => {
    const f = fixture(); expect((await f.client.listVoids(window)).shipments[0].shipmentId).toBe(460595426);
    const args = (f.request.mock.calls as unknown as unknown[][])[0];
    const url = new URL(String(args[1]), "https://ssapi.shipstation.com");
    expect(url.searchParams.get("voidDateStart")).toBe("2026-09-20T13:00:00");
    expect(url.searchParams.get("voidDateEnd")).toBe("2026-09-21T12:58:00");
    expect(url.searchParams.get("createDateStart")).toBeNull();
    expect(url.searchParams.get("includeShipmentItems")).toBe("true");
    expect(url.searchParams.get("pageSize")).toBe("10");
    expect(args[3]).toEqual({ retries: 0, timeoutMs: 10000 });
  });
  it.each([["2026-01-21T20:00:00Z", "2026-01-21T12:00:00"], ["2026-09-21T20:00:00Z", "2026-09-21T13:00:00"]])(
    "formats V1 query time independently of host timezone: %s", (input, expected) => expect(shipStationQueryDate(new Date(input))).toBe(expected));
  it("accepts a complete V1 single page reporting pages zero", async () => {
    expect((await fixture({ ...page, pages: 0 }).client.listVoids(window)).pages).toBe(1);
  });
  it("accepts an explicit complete empty page", async () => {
    expect((await fixture({ shipments: [], page: 1, pages: 0, total: 0 }).client.listVoids(window)).shipments).toEqual([]);
  });
  it("retains missing/malformed optional contents for the owning evidence validator, without requiring SKU, cost or address", async () => {
    const raw = { shipmentId: label.shipmentId, orderId: label.orderId, trackingNumber: label.trackingNumber,
      voidDate: label.voidDate, shipmentItems: null };
    const result = await fixture({ ...page, shipments: [raw] }).client.listVoids(window);
    expect(result.shipments[0]).toEqual(raw);
  });
  it("admits a standalone void with no order ID", async () => {
    expect((await fixture({ ...page, shipments: [{ ...label, orderId: null }] }).client.listVoids(window)).shipments[0].orderId).toBeNull();
  });
  it("rejects a provider response ignoring the requested void window", async () => {
    await expect(fixture({ ...page, shipments: [{ ...label, voidDate: '2026-08-01T10:00:00' }] }).client.listVoids(window))
      .rejects.toMatchObject({ code: 'SHIPSTATION_VOID_OUTSIDE_WINDOW' });
  });
  it.each([
    {}, { ...page, total: 11 }, { ...page, pages: 2 }, { ...page, page: 2 },
    { ...page, shipments: [] }, { ...page, shipments: [label, label], total: 2 },
    { ...page, shipments: [{ ...label, shipmentId: "460595426" }] },
  ])("rejects invalid/incomplete page metadata without assuming success", async response => {
    await expect(fixture(response).client.listVoids(window)).rejects.toThrow();
  });
  it.each([{ voidDate: null }, { voided: false }, { voidDate: "2026-09-21" }, { voidDate: "bad-date" }])(
    "requires actual void evidence: %j", async override => {
      await expect(fixture({ ...page, shipments: [{ ...label, ...override }] }).client.listVoids(window)).rejects.toThrow();
    });
  it("does not accept another order's labels as the requested related order", async () => {
    await expect(fixture().client.listOrderLabels(123, 1)).rejects.toMatchObject({ code: "SHIPSTATION_LABEL_PAGE_INCOMPLETE" });
  });
  it("does not filter by order status or number when refreshing labels", async () => {
    const f = fixture(); await f.client.listOrderLabels(790960007, 1);
    const args = (f.request.mock.calls as unknown as unknown[][])[0];
    const url = new URL(String(args[1]), "https://ssapi.shipstation.com");
    expect(url.searchParams.get("orderId")).toBe("790960007");
    expect(url.searchParams.has("orderStatus")).toBe(false); expect(url.searchParams.has("orderNumber")).toBe(false);
  });
});
