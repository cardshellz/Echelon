import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DropshipError } from "../../domain/errors";
import { EbayDropshipMarketplaceTrackingProvider } from "../../infrastructure/dropship-ebay-tracking.provider";
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

function makeCredentialRepo(
  credential: DropshipMarketplaceStoreCredentials,
): DropshipMarketplaceCredentialRepository {
  return {
    loadForStoreConnection: vi.fn(async () => credential),
    replaceTokens: vi.fn(async () => credential),
  };
}
