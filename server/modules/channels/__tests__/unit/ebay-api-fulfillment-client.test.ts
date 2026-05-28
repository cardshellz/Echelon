import { afterEach, describe, expect, it, vi } from "vitest";
import { createEbayApiClient } from "../../adapters/ebay/ebay-api.client";

function makeClient() {
  return createEbayApiClient(
    {
      getAccessToken: vi.fn().mockResolvedValue("access-token"),
    } as any,
    67,
    "production",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EbayApiClient.createShippingFulfillment", () => {
  it("verifies that a 201 Created fulfillment is readable before returning success", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("", {
          status: 201,
          headers: {
            Location:
              "https://api.ebay.com/sell/fulfillment/v1/order/22-14563-95067/shipping_fulfillment/track-1",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          total: 1,
          fulfillments: [
            {
              fulfillmentId: "track-1",
              shipmentTrackingNumber: "track-1",
            },
          ],
        }),
      );

    const result = await makeClient().createShippingFulfillment(
      "22-14563-95067",
      {
        lineItems: [{ lineItemId: "line-1", quantity: 2 }],
        shippedDate: "2026-05-02T18:49:25.469Z",
        shippingCarrierCode: "USPS",
        trackingNumber: "track-1",
      },
    );

    expect(result.fulfillmentId).toBe("track-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.ebay.com/sell/fulfillment/v1/order/22-14563-95067/shipping_fulfillment",
    );
  });

  it("throws when eBay returns 201 but the fulfillment cannot be read back", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("", {
          status: 201,
          headers: {
            Location:
              "https://api.ebay.com/sell/fulfillment/v1/order/22-14563-95067/shipping_fulfillment/track-1",
          },
        }),
      )
      .mockResolvedValue(
        Response.json({
          total: 0,
          fulfillments: [],
        }),
      );

    await expect(
      makeClient().createShippingFulfillment("22-14563-95067", {
        lineItems: [{ lineItemId: "line-1", quantity: 2 }],
        shippedDate: "2026-05-02T04:00:00.000Z",
        shippingCarrierCode: "USPS",
        trackingNumber: "track-1",
      }),
    ).rejects.toThrow("returned success but fulfillment was not readable");
  });
});

describe("EbayApiClient listing lifecycle", () => {
  it("withdraws a single offer with the Inventory API withdraw endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await makeClient().withdrawOffer("offer-123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.ebay.com/sell/inventory/v1/offer/offer-123/withdraw",
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("withdraws a multi-variation listing by inventory item group", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await makeClient().withdrawOfferByInventoryItemGroup("SHLZ-SEMI-OVR-DH");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.ebay.com/sell/inventory/v1/offer/withdraw_by_inventory_item_group",
    );
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      inventoryItemGroupKey: "SHLZ-SEMI-OVR-DH",
      marketplaceId: "EBAY_US",
    });
  });
});
