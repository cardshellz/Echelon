import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DropshipError } from "../../domain/errors";
import { EbayDropshipMarketplaceTrackingProvider } from "../../infrastructure/dropship-ebay-tracking.provider";
import { ShopifyDropshipMarketplaceTrackingProvider } from "../../infrastructure/dropship-shopify-tracking.provider";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "../../infrastructure/dropship-marketplace-credentials";

const ORIGINAL_ENV = { ...process.env };

describe("EbayDropshipMarketplaceTrackingProvider", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, DROPSHIP_EBAY_CLIENT_ID: "client", DROPSHIP_EBAY_CLIENT_SECRET: "secret" };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("posts eBay fulfillment tracking with store-connection credentials", async () => {
    const credential = makeCredential();
    const repo = makeCredentialRepo(credential);
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.ebay.com/sell/fulfillment/v1/order/ORDER!1/shipping_fulfillment");
      expect(init.headers).toMatchObject({ Authorization: "Bearer access-token" });
      expect(JSON.parse(String(init.body))).toEqual({
        lineItems: [{ lineItemId: "LINE-1", quantity: 1 }],
        shippedDate: "2026-05-02T10:00:00.000Z",
        shippingCarrierCode: "USPS",
        trackingNumber: "94001111",
      });
      return new Response("", {
        status: 201,
        headers: { Location: "https://api.ebay.com/sell/fulfillment/v1/order/ORDER%211/shipping_fulfillment/FT-1" },
      });
    });
    const provider = new EbayDropshipMarketplaceTrackingProvider(repo, fetchImpl as any);

    const result = await provider.pushTracking({
      intakeId: 10,
      omsOrderId: 20,
      wmsShipmentId: null,
      vendorId: 30,
      storeConnectionId: 40,
      platform: "ebay",
      externalOrderId: "ORDER!1",
      externalOrderNumber: null,
      sourceOrderId: null,
      carrier: "USPS",
      trackingNumber: "9400 1111",
      shippedAt: new Date("2026-05-02T10:00:00.000Z"),
      lineItems: [{ externalLineItemId: "LINE-1", quantity: 1 }],
      idempotencyKey: "tracking-key",
    });

    expect(result).toMatchObject({
      status: "succeeded",
      externalFulfillmentId: "FT-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects requests with no marketplace line item ids before calling eBay", async () => {
    const repo = makeCredentialRepo(makeCredential());
    const fetchImpl = vi.fn();
    const provider = new EbayDropshipMarketplaceTrackingProvider(repo, fetchImpl as any);

    await expect(provider.pushTracking({
      intakeId: 10,
      omsOrderId: 20,
      wmsShipmentId: null,
      vendorId: 30,
      storeConnectionId: 40,
      platform: "ebay",
      externalOrderId: "ORDER-1",
      externalOrderNumber: null,
      sourceOrderId: null,
      carrier: "USPS",
      trackingNumber: "94001111",
      shippedAt: new Date("2026-05-02T10:00:00.000Z"),
      lineItems: [{ externalLineItemId: null, quantity: 1 }],
      idempotencyKey: "tracking-key",
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_TRACKING_LINE_ITEM_IDS_REQUIRED",
    } satisfies Partial<DropshipError>);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries transient eBay tracking failures", async () => {
    const repo = makeCredentialRepo(makeCredential());
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 500 }))
      .mockResolvedValueOnce(new Response("", {
        status: 201,
        headers: { Location: "https://api.ebay.com/sell/fulfillment/v1/order/ORDER-1/shipping_fulfillment/FT-2" },
      }));
    const provider = new EbayDropshipMarketplaceTrackingProvider(repo, fetchImpl as any);

    const result = await provider.pushTracking({
      intakeId: 10,
      omsOrderId: 20,
      wmsShipmentId: null,
      vendorId: 30,
      storeConnectionId: 40,
      platform: "ebay",
      externalOrderId: "ORDER-1",
      externalOrderNumber: null,
      sourceOrderId: null,
      carrier: "USPS",
      trackingNumber: "94001111",
      shippedAt: new Date("2026-05-02T10:00:00.000Z"),
      lineItems: [{ externalLineItemId: "LINE-1", quantity: 1 }],
      idempotencyKey: "tracking-key",
    });

    expect(result.externalFulfillmentId).toBe("FT-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries transient eBay network failures", async () => {
    const repo = makeCredentialRepo(makeCredential());
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(new Response("", {
        status: 201,
        headers: { Location: "https://api.ebay.com/sell/fulfillment/v1/order/ORDER-1/shipping_fulfillment/FT-3" },
      }));
    const provider = new EbayDropshipMarketplaceTrackingProvider(repo, fetchImpl as any);

    const result = await provider.pushTracking({
      intakeId: 10,
      omsOrderId: 20,
      wmsShipmentId: null,
      vendorId: 30,
      storeConnectionId: 40,
      platform: "ebay",
      externalOrderId: "ORDER-1",
      externalOrderNumber: null,
      sourceOrderId: null,
      carrier: "USPS",
      trackingNumber: "94001111",
      shippedAt: new Date("2026-05-02T10:00:00.000Z"),
      lineItems: [{ externalLineItemId: "LINE-1", quantity: 1 }],
      idempotencyKey: "tracking-key",
    });

    expect(result.externalFulfillmentId).toBe("FT-3");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("ShopifyDropshipMarketplaceTrackingProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts Shopify fulfillment tracking with fulfillment-order line item quantities", async () => {
    const repo = makeCredentialRepo(makeShopifyCredential());
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        data: {
          order: {
            id: "gid://shopify/Order/1234567890",
            fulfillments: [],
            fulfillmentOrders: {
              nodes: [
                {
                  id: "gid://shopify/FulfillmentOrder/700",
                  lineItems: {
                    nodes: [
                      {
                        id: "gid://shopify/FulfillmentOrderLineItem/800",
                        remainingQuantity: 2,
                        lineItem: { id: "gid://shopify/LineItem/111" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          fulfillmentCreate: {
            fulfillment: { id: "gid://shopify/Fulfillment/900" },
            userErrors: [],
          },
        },
      }));
    const provider = new ShopifyDropshipMarketplaceTrackingProvider(repo, fetchImpl as any);

    const result = await provider.pushTracking({
      intakeId: 10,
      omsOrderId: 20,
      wmsShipmentId: 30,
      vendorId: 30,
      storeConnectionId: 40,
      platform: "shopify",
      externalOrderId: "1234567890",
      externalOrderNumber: "#1001",
      sourceOrderId: null,
      carrier: "UPS",
      trackingNumber: "1Z999",
      shippedAt: new Date("2026-05-02T10:00:00.000Z"),
      lineItems: [{ externalLineItemId: "111", quantity: 1 }],
      idempotencyKey: "tracking-key",
    });

    expect(result).toMatchObject({
      status: "succeeded",
      externalFulfillmentId: "gid://shopify/Fulfillment/900",
      rawResult: {
        provider: "shopify",
        apiVersion: "2026-04",
        fulfillmentOrderCount: 1,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://vendor-shop.myshopify.com/admin/api/2026-04/graphql.json");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "X-Shopify-Access-Token": "shopify-token",
    });
    const lookupBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(lookupBody.variables).toEqual({ orderId: "gid://shopify/Order/1234567890" });
    const mutationBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(mutationBody.variables).toMatchObject({
      fulfillment: {
        notifyCustomer: true,
        trackingInfo: {
          company: "UPS",
          number: "1Z999",
        },
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId: "gid://shopify/FulfillmentOrder/700",
            fulfillmentOrderLineItems: [
              {
                id: "gid://shopify/FulfillmentOrderLineItem/800",
                quantity: 1,
              },
            ],
          },
        ],
      },
      message: null,
    });
  });

  it("does not create a duplicate Shopify fulfillment when the tracking number already exists", async () => {
    const repo = makeCredentialRepo(makeShopifyCredential());
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({
      data: {
        order: {
          id: "gid://shopify/Order/1234567890",
          fulfillments: [
            {
              id: "gid://shopify/Fulfillment/existing",
              trackingInfo: [{ number: "1Z 999", company: "UPS", url: null }],
            },
          ],
          fulfillmentOrders: { nodes: [] },
        },
      },
    }));
    const provider = new ShopifyDropshipMarketplaceTrackingProvider(repo, fetchImpl as any);

    const result = await provider.pushTracking({
      intakeId: 10,
      omsOrderId: 20,
      wmsShipmentId: 30,
      vendorId: 30,
      storeConnectionId: 40,
      platform: "shopify",
      externalOrderId: "gid://shopify/Order/1234567890",
      externalOrderNumber: "#1001",
      sourceOrderId: null,
      carrier: "UPS",
      trackingNumber: "1Z999",
      shippedAt: new Date("2026-05-02T10:00:00.000Z"),
      lineItems: [{ externalLineItemId: "gid://shopify/LineItem/111", quantity: 1 }],
      idempotencyKey: "tracking-key",
    });

    expect(result).toMatchObject({
      status: "succeeded",
      externalFulfillmentId: "gid://shopify/Fulfillment/existing",
      rawResult: { dedupedByTrackingNumber: true },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects Shopify tracking requests with no marketplace line item ids before calling Shopify", async () => {
    const repo = makeCredentialRepo(makeShopifyCredential());
    const fetchImpl = vi.fn();
    const provider = new ShopifyDropshipMarketplaceTrackingProvider(repo, fetchImpl as any);

    await expect(provider.pushTracking({
      intakeId: 10,
      omsOrderId: 20,
      wmsShipmentId: 30,
      vendorId: 30,
      storeConnectionId: 40,
      platform: "shopify",
      externalOrderId: "1234567890",
      externalOrderNumber: "#1001",
      sourceOrderId: null,
      carrier: "UPS",
      trackingNumber: "1Z999",
      shippedAt: new Date("2026-05-02T10:00:00.000Z"),
      lineItems: [{ externalLineItemId: null, quantity: 1 }],
      idempotencyKey: "tracking-key",
    })).rejects.toMatchObject({
      code: "DROPSHIP_SHOPIFY_TRACKING_LINE_ITEM_IDS_REQUIRED",
    } satisfies Partial<DropshipError>);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces Shopify fulfillment user errors as non-retryable tracking failures", async () => {
    const repo = makeCredentialRepo(makeShopifyCredential());
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        data: {
          order: {
            id: "gid://shopify/Order/1234567890",
            fulfillments: [],
            fulfillmentOrders: {
              nodes: [
                {
                  id: "gid://shopify/FulfillmentOrder/700",
                  lineItems: {
                    nodes: [
                      {
                        id: "gid://shopify/FulfillmentOrderLineItem/800",
                        remainingQuantity: 1,
                        lineItem: { id: "gid://shopify/LineItem/111" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          fulfillmentCreate: {
            fulfillment: null,
            userErrors: [{ field: ["fulfillment"], message: "Location mismatch" }],
          },
        },
      }));
    const provider = new ShopifyDropshipMarketplaceTrackingProvider(repo, fetchImpl as any);

    await expect(provider.pushTracking({
      intakeId: 10,
      omsOrderId: 20,
      wmsShipmentId: 30,
      vendorId: 30,
      storeConnectionId: 40,
      platform: "shopify",
      externalOrderId: "1234567890",
      externalOrderNumber: "#1001",
      sourceOrderId: null,
      carrier: "UPS",
      trackingNumber: "1Z999",
      shippedAt: new Date("2026-05-02T10:00:00.000Z"),
      lineItems: [{ externalLineItemId: "111", quantity: 1 }],
      idempotencyKey: "tracking-key",
    })).rejects.toMatchObject({
      code: "DROPSHIP_SHOPIFY_TRACKING_REJECTED",
      context: expect.objectContaining({ retryable: false }),
    } satisfies Partial<DropshipError>);
  });
});

function makeCredential(): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 30,
    storeConnectionId: 40,
    platform: "ebay",
    status: "connected",
    shopDomain: null,
    externalAccountId: "seller-1",
    externalDisplayName: "Seller One",
    config: { environment: "production" },
    accessToken: "access-token",
    accessTokenRef: "access-ref",
    accessTokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    refreshToken: "refresh-token",
    refreshTokenRef: "refresh-ref",
    refreshTokenExpiresAt: null,
  };
}

function makeShopifyCredential(): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 30,
    storeConnectionId: 40,
    platform: "shopify",
    status: "connected",
    shopDomain: "vendor-shop.myshopify.com",
    externalAccountId: "vendor-shop.myshopify.com",
    externalDisplayName: "Vendor Shop",
    config: {},
    accessToken: "shopify-token",
    accessTokenRef: "access-ref",
    accessTokenExpiresAt: null,
    refreshToken: null,
    refreshTokenRef: null,
    refreshTokenExpiresAt: null,
  };
}

function makeCredentialRepo(
  credential: DropshipMarketplaceStoreCredentials,
): DropshipMarketplaceCredentialRepository {
  return {
    loadForStoreConnection: vi.fn(async () => credential),
    replaceTokens: vi.fn(async () => credential),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
