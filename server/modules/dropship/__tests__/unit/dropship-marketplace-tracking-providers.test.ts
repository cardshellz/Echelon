import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DropshipError } from "../../domain/errors";
import { EbayDropshipMarketplaceTrackingProvider } from "../../infrastructure/dropship-ebay-tracking.provider";
import { ShopifyDropshipMarketplaceTrackingProvider } from "../../infrastructure/dropship-shopify-tracking.provider";
import type {
  DropshipMarketplaceStoreAuthFailureInput,
  DropshipMarketplaceStoreAuthFailureRecord,
  DropshipMarketplaceStoreCredentials,
} from "../../infrastructure/dropship-marketplace-credentials";

const ORIGINAL_ENV = { ...process.env };

describe("EbayDropshipMarketplaceTrackingProvider", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, DROPSHIP_EBAY_CLIENT_ID: "client", DROPSHIP_EBAY_CLIENT_SECRET: "secret" };
    // The eBay client skips every call in dry-run mode.
    delete process.env.DRY_RUN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("reads the order's shipments, adds this one on the vendor's marketplace, and confirms it", async () => {
    const ebay = fakeEbayOrder({ orderPath: "ORDER!1", createdFulfillmentId: "FT-1" });
    const provider = new EbayDropshipMarketplaceTrackingProvider(
      makeCredentialRepo(makeCredential({ marketplaceId: "EBAY_GB" })),
      ebay.fetch as any,
    );

    const result = await provider.pushTracking(ebayTrackingRequest({
      externalOrderId: "ORDER!1",
      trackingNumber: "9400 1111",
    }));

    expect(result).toMatchObject({
      status: "succeeded",
      externalFulfillmentId: "FT-1",
      rawResult: { marketplaceId: "EBAY_GB", shipmentAdded: true },
    });
    expect(ebay.calls.map((call) => call.method)).toEqual(["GET", "POST", "GET"]);
    for (const call of ebay.calls) {
      expect(call.url).toBe("https://api.ebay.com/sell/fulfillment/v1/order/ORDER!1/shipping_fulfillment");
      expect(call.headers.get("Authorization")).toBe("Bearer access-token");
      expect(call.headers.get("X-EBAY-C-MARKETPLACE-ID")).toBe("EBAY_GB");
    }
    expect(ebay.posts()).toEqual([{
      lineItems: [{ lineItemId: "LINE-1", quantity: 1 }],
      shippedDate: "2026-05-02T10:00:00.000Z",
      shippingCarrierCode: "USPS",
      trackingNumber: "94001111",
    }]);
  });

  it("does not add a shipment eBay already has, such as one whose answer was lost", async () => {
    const ebay = fakeEbayOrder({
      existing: [{ fulfillmentId: "FT-EARLIER", shipmentTrackingNumber: "94001111", lineItems: [{ lineItemId: "LINE-1", quantity: 1 }] }],
    });
    const provider = new EbayDropshipMarketplaceTrackingProvider(makeCredentialRepo(makeCredential()), ebay.fetch as any);

    const result = await provider.pushTracking(ebayTrackingRequest());

    expect(result).toMatchObject({
      status: "succeeded",
      externalFulfillmentId: "FT-EARLIER",
      rawResult: { shipmentAdded: false },
    });
    expect(ebay.posts()).toEqual([]);
  });

  it("reports a lost answer on the add as retryable, and the next attempt finds the shipment instead of adding it again", async () => {
    // eBay records the shipment but the connection drops before it answers.
    const ebay = fakeEbayOrder({ createdFulfillmentId: "FT-3", dropFirstPostAnswer: true });
    const provider = new EbayDropshipMarketplaceTrackingProvider(makeCredentialRepo(makeCredential()), ebay.fetch as any);

    await expect(provider.pushTracking(ebayTrackingRequest())).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_TRACKING_NETWORK_ERROR",
      context: expect.objectContaining({ retryable: true, method: "POST" }),
    } satisfies Partial<DropshipError>);
    const retried = await provider.pushTracking(ebayTrackingRequest());

    expect(retried).toMatchObject({ externalFulfillmentId: "FT-3", rawResult: { shipmentAdded: false } });
    expect(ebay.posts()).toHaveLength(1);
  });

  it("reports an eBay server error on the add as retryable without sending it again", async () => {
    const ebay = fakeEbayOrder({ postResponse: () => new Response("temporary", { status: 500 }) });
    const provider = new EbayDropshipMarketplaceTrackingProvider(makeCredentialRepo(makeCredential()), ebay.fetch as any);

    await expect(provider.pushTracking(ebayTrackingRequest())).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_TRACKING_HTTP_ERROR",
      context: expect.objectContaining({ retryable: true, status: 500, method: "POST", body: "temporary" }),
    } satisfies Partial<DropshipError>);
    expect(ebay.posts()).toHaveLength(1);
  });

  it("adds nothing when eBay's shipment list cannot be read", async () => {
    const unavailable = fakeEbayOrder({ readResponse: () => new Response("busy", { status: 503 }) });
    const malformed = fakeEbayOrder({ readResponse: () => jsonResponse({ total: 0 }) });

    await expect(new EbayDropshipMarketplaceTrackingProvider(makeCredentialRepo(makeCredential()), unavailable.fetch as any)
      .pushTracking(ebayTrackingRequest())).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_TRACKING_HTTP_ERROR",
      context: expect.objectContaining({ retryable: true, status: 503, method: "GET" }),
    } satisfies Partial<DropshipError>);
    await expect(new EbayDropshipMarketplaceTrackingProvider(makeCredentialRepo(makeCredential()), malformed.fetch as any)
      .pushTracking(ebayTrackingRequest())).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_TRACKING_SHIPMENTS_UNREADABLE",
      context: expect.objectContaining({ retryable: true }),
    } satisfies Partial<DropshipError>);
    expect(unavailable.posts()).toEqual([]);
    expect(malformed.posts()).toEqual([]);
  });

  it("stops for a person when eBay lists this tracking for different items", async () => {
    const ebay = fakeEbayOrder({
      existing: [{ fulfillmentId: "FT-HAND", shipmentTrackingNumber: "94001111", lineItems: [{ lineItemId: "LINE-2", quantity: 1 }] }],
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const provider = new EbayDropshipMarketplaceTrackingProvider(makeCredentialRepo(makeCredential()), ebay.fetch as any);

    await expect(provider.pushTracking(ebayTrackingRequest())).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_TRACKING_SHIPMENT_CONFLICT",
      context: expect.objectContaining({ retryable: false, trackingNumber: "94001111" }),
    } satisfies Partial<DropshipError>);
    expect(ebay.posts()).toEqual([]);
  });

  it("rejects requests with no marketplace line item ids before calling eBay", async () => {
    const repo = makeCredentialRepo(makeCredential());
    const fetchImpl = vi.fn();
    const provider = new EbayDropshipMarketplaceTrackingProvider(repo, fetchImpl as any);

    await expect(provider.pushTracking(ebayTrackingRequest({
      lineItems: [{ externalLineItemId: null, quantity: 1 }],
    }))).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_TRACKING_LINE_ITEM_IDS_REQUIRED",
    } satisfies Partial<DropshipError>);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repo.loadForStoreConnection).not.toHaveBeenCalled();
  });

  it("rejects a tracking number eBay cannot take, for good, before calling eBay", async () => {
    const fetchImpl = vi.fn();
    const provider = new EbayDropshipMarketplaceTrackingProvider(makeCredentialRepo(makeCredential()), fetchImpl as any);

    await expect(provider.pushTracking(ebayTrackingRequest({ trackingNumber: "9400/1111" }))).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_TRACKING_NUMBER_INVALID",
      context: expect.objectContaining({ retryable: false }),
    } satisfies Partial<DropshipError>);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not invalidate store credentials for an ordinary eBay tracking API 400", async () => {
    const repo = makeCredentialRepo(makeCredential());
    const ebay = fakeEbayOrder({ postResponse: () => new Response("invalid tracking payload", { status: 400 }) });
    const provider = new EbayDropshipMarketplaceTrackingProvider(repo, ebay.fetch as any);

    await expect(provider.pushTracking(ebayTrackingRequest())).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_TRACKING_HTTP_ERROR",
      context: expect.objectContaining({ retryable: false, status: 400 }),
    } satisfies Partial<DropshipError>);

    expect(ebay.posts()).toHaveLength(1);
    expect(repo.recordAuthFailure).not.toHaveBeenCalled();
  });
});

interface FakeEbayShipment {
  fulfillmentId: string;
  shipmentTrackingNumber: string;
  lineItems: Array<{ lineItemId: string; quantity: number }>;
}

/**
 * One eBay order's shipment list. GET returns the full list; POST records the
 * shipment and answers 201 with its Location, as eBay does.
 */
function fakeEbayOrder(options: {
  orderPath?: string;
  existing?: FakeEbayShipment[];
  createdFulfillmentId?: string;
  readResponse?: () => Response;
  postResponse?: () => Response;
  dropFirstPostAnswer?: boolean;
} = {}) {
  const orderPath = options.orderPath ?? "ORDER-1";
  const shipments: FakeEbayShipment[] = [...(options.existing ?? [])];
  const calls: Array<{ method: string; url: string; headers: Headers; body: unknown }> = [];
  let answerDropped = false;
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, headers: new Headers(init.headers), body });
    expect(url).toBe(`https://api.ebay.com/sell/fulfillment/v1/order/${orderPath}/shipping_fulfillment`);
    if (method === "GET") {
      return options.readResponse?.() ?? jsonResponse({ total: shipments.length, fulfillments: shipments });
    }
    if (options.postResponse) return options.postResponse();
    const fulfillmentId = options.createdFulfillmentId ?? "FT-NEW";
    shipments.push({
      fulfillmentId,
      shipmentTrackingNumber: body.trackingNumber,
      lineItems: body.lineItems,
    });
    if (options.dropFirstPostAnswer && !answerDropped) {
      answerDropped = true;
      throw new TypeError("fetch failed");
    }
    return new Response("", {
      status: 201,
      headers: { Location: `https://api.ebay.com/sell/fulfillment/v1/order/${encodeURIComponent(orderPath)}/shipping_fulfillment/${fulfillmentId}` },
    });
  });
  return {
    fetch,
    calls,
    posts: () => calls.filter((call) => call.method === "POST").map((call) => call.body),
  };
}

function ebayTrackingRequest(
  overrides: Partial<Parameters<EbayDropshipMarketplaceTrackingProvider["pushTracking"]>[0]> = {},
): Parameters<EbayDropshipMarketplaceTrackingProvider["pushTracking"]>[0] {
  return {
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
    ...overrides,
  };
}

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

function makeCredential(config: Record<string, unknown> = {}): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 30,
    storeConnectionId: 40,
    platform: "ebay",
    status: "connected",
    shopDomain: null,
    externalAccountId: "seller-1",
    providerEnvironment: "production",
    externalAccountIdentityScheme: "ebay_user_id",
    externalAccountVerifiedAt: new Date("2026-05-01T00:00:00.000Z"),
    externalDisplayName: "Seller One",
    config: { environment: "production", ...config },
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
) {
  return {
    loadForStoreConnection: vi.fn(async () => credential),
    replaceTokens: vi.fn(async () => credential),
    recordAuthFailure: vi.fn(async (
      input: DropshipMarketplaceStoreAuthFailureInput,
    ): Promise<DropshipMarketplaceStoreAuthFailureRecord> => ({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: input.platform,
      previousStatus: "connected",
      status: input.status,
      transitioned: true,
    })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
