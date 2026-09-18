import { afterEach, describe, expect, it, vi } from "vitest";
import { EbayApiClient } from "../../adapters/ebay/ebay-api.client";

afterEach(() => vi.unstubAllEnvs());
const orderId = "06-15163-97392";
const lines = [{ lineItemId: "line-1", quantity: 2 }];
const request = { lineItems: lines, trackingNumber: "NEW", shippingCarrierCode: "USPS", shippedDate: "2026-09-17T12:00:00Z" };

function harness(options: { omitted?: boolean; multiple?: boolean; ambiguous?: boolean; failAfterWrite?: boolean; httpStatus?: number; wrongQuantity?: boolean } = {}) {
  vi.stubEnv("DRY_RUN", "false");
  let tracking = "OLD";
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "POST") {
      expect(path).toBe("https://api.sandbox.ebay.com/ws/api.dll");
      expect(init.body).toContain("<OrderID>06-15163-97392</OrderID>");
      expect(init.body).toContain("<ShipmentTrackingNumber>NEW</ShipmentTrackingNumber>");
      expect(init.body).not.toContain("<Paid>");
      if (options.httpStatus) return new Response("failed", { status: options.httpStatus });
      if (!options.ambiguous) tracking = "NEW";
      if (options.failAfterWrite) throw new Error("connection lost after provider accepted write");
      return new Response("<CompleteSaleResponse><Ack>Success</Ack></CompleteSaleResponse>");
    }
    if (path.endsWith("/shipping_fulfillment")) return Response.json({
      fulfillments: [{ fulfillmentId: "fulfillment-1", shipmentTrackingNumber: tracking,
        shippedDate: request.shippedDate, lineItems: options.omitted ? [{ lineItemId: "line-1" }] : lines },
      ...(options.multiple ? [{ fulfillmentId: "fulfillment-2", shipmentTrackingNumber: "OTHER", lineItems: lines }] : [])],
    });
    expect(path).toBe(`https://api.sandbox.ebay.com/sell/fulfillment/v1/order/${orderId}`);
    return Response.json({ orderId, orderFulfillmentStatus: "FULFILLED",
      cancelStatus: { cancelState: "NONE_REQUESTED", cancelRequests: [] },
      fulfillmentHrefs: [`https://api.sandbox.ebay.com/sell/fulfillment/v1/order/${orderId}/shipping_fulfillment/fulfillment-1`],
      lineItems: [{ ...lines[0], quantity: options.wrongQuantity ? 3 : 2, lineItemFulfillmentStatus: "FULFILLED" }],
    });
  });
  const client = new EbayApiClient({ getAccessToken: vi.fn().mockResolvedValue("test-token") }, 67, "sandbox", { request: fetch, strictFulfillmentReadback: true });
  return { client, fetch };
}

describe("eBay tracking replacement HTTP contract", () => {
  it.each([false, true])("replaces and verifies exact quantities (omitted=%s), then replays without POST", async omitted => {
    const { client, fetch } = harness({ omitted });
    expect(await client.replaceShippingFulfillmentTracking(orderId, request, ["OLD"])).toMatchObject({ fulfillmentId: "fulfillment-1" });
    expect(await client.replaceShippingFulfillmentTracking(orderId, request, ["OLD"])).toMatchObject({ fulfillmentId: "fulfillment-1" });
    expect(fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  });
  it("adopts a successful write after the response was lost", async () => {
    const { client, fetch } = harness({ failAfterWrite: true });
    await expect(client.replaceShippingFulfillmentTracking(orderId, request, ["OLD"])).rejects.toThrow("connection lost");
    await expect(client.replaceShippingFulfillmentTracking(orderId, request, ["OLD"])).resolves.toMatchObject({ fulfillmentId: "fulfillment-1" });
    expect(fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  });
  it.each([{ multiple: true }, { wrongQuantity: true }])("refuses a broader provider scope %j", async options => {
    const { client, fetch } = harness(options);
    await expect(client.replaceShippingFulfillmentTracking(orderId, request, ["OLD"])).rejects.toMatchObject({ failureClass: "permanent" });
    expect(fetch.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
  });
  it("refuses unrelated tracking", async () => {
    const { client, fetch } = harness();
    await expect(client.replaceShippingFulfillmentTracking(orderId, request, ["DIFFERENT"])).rejects.toMatchObject({ code: "EBAY_TRACKING_PREDECESSOR_CONFLICT" });
    expect(fetch.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
  });
  it.each([429, 503])("leaves HTTP %i retryable", async httpStatus => {
    const { client } = harness({ httpStatus });
    await expect(client.replaceShippingFulfillmentTracking(orderId, request, ["OLD"])).rejects.toMatchObject({ failureClass: "transient" });
  });
  it("does not mistake a successful acknowledgement for verified replacement", async () => {
    const { client } = harness({ ambiguous: true });
    await expect(client.replaceShippingFulfillmentTracking(orderId, request, ["OLD"])).rejects.toMatchObject({ code: "EBAY_TRACKING_AMENDMENT_UNVERIFIED" });
  });
});
