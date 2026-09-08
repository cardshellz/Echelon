import { afterEach, describe, expect, it, vi } from "vitest";
import { createEbayApiClient } from "../../adapters/ebay/ebay-api.client";

// This HTTP contract suite supplies an explicit admitted legacy-quantity owner.
// Production factory routing is still exercised; no process-global database or
// provider account lookup is allowed to leak into a request-shape unit test.
const admission = vi.hoisted(() => {
  const owner = {
    item: vi.fn(async (_sku: string, work: (quantity: number | null) => Promise<unknown>) => work(null)),
    group: vi.fn(async (_key: string, _skus: readonly string[], work: (quantities: ReadonlyMap<string, number> | null) => Promise<unknown>) => work(null)),
    reducing: vi.fn(async (_identity: string, work: () => Promise<unknown>) => work()),
  };
  return { owner, createChannelEbayQuantityRequestAdmission: vi.fn(async () => owner) };
});
vi.mock("../../../inventory-planning/infrastructure/quantity-publication-runtime", () => ({
  createChannelEbayQuantityRequestAdmission: admission.createChannelEbayQuantityRequestAdmission,
}));

function makeClient() {
  return createEbayApiClient(
    {
      getAccessToken: vi.fn().mockResolvedValue("access-token"),
      getVerifiedProviderAccount: vi.fn().mockResolvedValue({ externalAccountId: "verified-account-67" }),
    } as any,
    67,
    "production",
  );
}

function getFetchHeaders(fetchMock: any, callIndex: number): Record<string, string> {
  return (fetchMock.mock.calls[callIndex][1] as RequestInit).headers as Record<string, string>;
}

afterEach(() => {
  vi.restoreAllMocks();
  admission.createChannelEbayQuantityRequestAdmission.mockClear();
  admission.owner.item.mockClear();
  admission.owner.group.mockClear();
  admission.owner.reducing.mockClear();
});

function expectQuantityAdmission(externalInventoryItemId: string, kind: "item" | "reducing" = "item", memberSkus?: string[]) {
  expect(admission.createChannelEbayQuantityRequestAdmission).toHaveBeenCalledExactlyOnceWith({ channelId: 67, externalAccountId: "verified-account-67" });
  expect(admission.owner[kind]).toHaveBeenCalledExactlyOnceWith(externalInventoryItemId, expect.any(Function), ...(memberSkus ? [memberSkus] : []));
  expect(admission.owner[kind === "item" ? "reducing" : "item"]).not.toHaveBeenCalled();
  expect(admission.owner.group).not.toHaveBeenCalled();
}

describe("EbayApiClient.createShippingFulfillment", () => {
  it("verifies that a 201 Created fulfillment is readable before returning success", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          total: 0,
          fulfillments: [],
        }),
      )
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
              lineItems: [{ lineItemId: "line-1", quantity: 2 }],
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getFetchHeaders(fetchMock, 0)["Accept-Language"]).toBe("en-US");
    expect(getFetchHeaders(fetchMock, 1)["Accept-Language"]).toBe("en-US");
    expect(getFetchHeaders(fetchMock, 2)["Accept-Language"]).toBe("en-US");
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://api.ebay.com/sell/fulfillment/v1/order/22-14563-95067/shipping_fulfillment",
    );
  });

  it("returns the existing fulfillment without POSTing when tracking is already present", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        total: 1,
        fulfillments: [
          {
            fulfillmentId: "existing-fulfillment",
            shipmentTrackingNumber: "track-1",
            lineItems: [{ lineItemId: "line-1", quantity: 2 }],
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

    expect(result).toEqual({ fulfillmentId: "existing-fulfillment" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("refuses to treat matching tracking with different line allocations as idempotent", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        total: 1,
        fulfillments: [
          {
            fulfillmentId: "conflicting-fulfillment",
            shipmentTrackingNumber: "track-1",
            lineItems: [{ lineItemId: "line-1", quantity: 1 }],
          },
        ],
      }),
    );

    await expect(
      makeClient().createShippingFulfillment("22-14563-95067", {
        lineItems: [{ lineItemId: "line-1", quantity: 2 }],
        shippedDate: "2026-05-02T18:49:25.469Z",
        shippingCarrierCode: "USPS",
        trackingNumber: "track-1",
      }),
    ).rejects.toMatchObject({
      code: "ebay_fulfillment_idempotency_conflict",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("does not POST when the idempotency preflight cannot read eBay fulfillments", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("upstream unavailable", { status: 503 }),
    );

    await expect(
      makeClient().createShippingFulfillment("22-14563-95067", {
        lineItems: [{ lineItemId: "line-1", quantity: 2 }],
        shippedDate: "2026-05-02T18:49:25.469Z",
        shippingCarrierCode: "USPS",
        trackingNumber: "track-1",
      }),
    ).rejects.toThrow("refusing fulfillment POST without idempotency read");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("does not repeat an ambiguous POST inside the same attempt", async () => {
    const ambiguousNetworkError = Object.assign(new Error("fetch failed"), {
      code: "ECONNRESET",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          total: 0,
          fulfillments: [],
        }),
      )
      .mockRejectedValueOnce(ambiguousNetworkError);

    await expect(
      makeClient().createShippingFulfillment("22-14563-95067", {
        lineItems: [{ lineItemId: "line-1", quantity: 2 }],
        shippedDate: "2026-05-02T18:49:25.469Z",
        shippingCarrierCode: "USPS",
        trackingNumber: "track-1",
      }),
    ).rejects.toThrow("fetch failed");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("POST");
  });

  it("throws when eBay returns 201 but the fulfillment cannot be read back", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          total: 0,
          fulfillments: [],
        }),
      )
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
      .mockResolvedValueOnce(Response.json({ offerId: "offer-123", sku: "ARM-ENV-SGL-C700" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await makeClient().withdrawOffer("offer-123");
    expectQuantityAdmission("ARM-ENV-SGL-C700", "reducing");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.ebay.com/sell/inventory/v1/offer/offer-123",
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET");
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.ebay.com/sell/inventory/v1/offer/offer-123/withdraw",
    );
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("POST");
    expect(getFetchHeaders(fetchMock, 1)["Accept-Language"]).toBe("en-US");
  });

  it("withdraws a multi-variation listing by inventory item group", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ inventoryItemGroupKey: "SHLZ-SEMI-OVR-DH", variantSKUs: ["SKU-1", "SKU-2"] }))
      .mockResolvedValueOnce(Response.json({ inventoryItemGroupKey: "SHLZ-SEMI-OVR-DH", variantSKUs: ["SKU-1", "SKU-2"] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await makeClient().withdrawOfferByInventoryItemGroup("SHLZ-SEMI-OVR-DH");
    expectQuantityAdmission("group:SHLZ-SEMI-OVR-DH", "reducing", ["SKU-1", "SKU-2"]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.slice(0, 2).map(([url, options]) => ({ url, method: (options as RequestInit).method }))).toEqual([
      { url: "https://api.ebay.com/sell/inventory/v1/inventory_item_group/SHLZ-SEMI-OVR-DH", method: "GET" },
      { url: "https://api.ebay.com/sell/inventory/v1/inventory_item_group/SHLZ-SEMI-OVR-DH", method: "GET" },
    ]);
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://api.ebay.com/sell/inventory/v1/offer/withdraw_by_inventory_item_group",
    );
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toEqual({
      inventoryItemGroupKey: "SHLZ-SEMI-OVR-DH",
      marketplaceId: "EBAY_US",
    });
    expect(getFetchHeaders(fetchMock, 2)["Accept-Language"]).toBe("en-US");
  });

  it("sets a concrete eBay locale header on inventory offer reads", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ offers: [] }));

    await makeClient().getOffers("ARM-ENV-SGL-C700");
    expect(admission.createChannelEbayQuantityRequestAdmission).not.toHaveBeenCalled();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.ebay.com/sell/inventory/v1/offer?sku=ARM-ENV-SGL-C700&marketplace_id=EBAY_US",
    );
    expect(getFetchHeaders(fetchMock, 0)["Accept-Language"]).toBe("en-US");
  });

  it("sets a concrete eBay locale header on bulk inventory updates", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ responses: [{ sku: "ARM-ENV-SGL-C700", offerId: "136412217011", statusCode: 200 }] }));

    await makeClient().bulkUpdatePriceQuantity({
      requests: [
        {
          sku: "ARM-ENV-SGL-C700",
          shipToLocationAvailability: { quantity: 0 },
          offers: [{ offerId: "136412217011", availableQuantity: 0 }],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.ebay.com/sell/inventory/v1/bulk_update_price_quantity",
    );
    expectQuantityAdmission("ARM-ENV-SGL-C700", "reducing");
    expect(getFetchHeaders(fetchMock, 0)["Accept-Language"]).toBe("en-US");
  });

  // eBay Sell Inventory API rejects writes that omit Content-Language with
  // [25709] "Invalid value for header Content-Language" — every write call
  // must carry it, not just the two inventory-item PUTs.
  it("sends Content-Language on bulk inventory updates (POST)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ responses: [{ sku: "ARM-ENV-SGL-C700", offerId: "136412217011", statusCode: 200 }] }));

    await makeClient().bulkUpdatePriceQuantity({
      requests: [
        {
          sku: "ARM-ENV-SGL-C700",
          shipToLocationAvailability: { quantity: 0 },
          offers: [{ offerId: "136412217011", availableQuantity: 0 }],
        },
      ],
    });

    expect(getFetchHeaders(fetchMock, 0)["Content-Language"]).toBe("en-US");
    expectQuantityAdmission("ARM-ENV-SGL-C700", "reducing");
  });

  it("sends Content-Language on offer updates (PUT)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await makeClient().updateOffer("offer-123", {
      sku: "ARM-ENV-SGL-C700",
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
    } as any);

    expectQuantityAdmission("ARM-ENV-SGL-C700");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT");
    expect(getFetchHeaders(fetchMock, 0)["Content-Language"]).toBe("en-US");
  });

  it("does not send Content-Language on reads (GET has no body to describe)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ offers: [] }));

    await makeClient().getOffers("ARM-ENV-SGL-C700");

    expect(getFetchHeaders(fetchMock, 0)["Content-Language"]).toBeUndefined();
  });
});
