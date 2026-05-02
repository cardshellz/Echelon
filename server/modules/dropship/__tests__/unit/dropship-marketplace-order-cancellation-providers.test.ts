import { describe, expect, it } from "vitest";
import type {
  DropshipMarketplaceOrderCancellationRequest,
} from "../../application/dropship-marketplace-order-cancellation-provider";
import { EbayDropshipOrderCancellationProvider } from "../../infrastructure/dropship-ebay-order-cancellation.provider";
import { ShopifyDropshipOrderCancellationProvider } from "../../infrastructure/dropship-shopify-order-cancellation.provider";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "../../infrastructure/dropship-marketplace-credentials";

describe("dropship marketplace order cancellation providers", () => {
  it("cancels Shopify orders through GraphQL orderCancel with refund and notification defaults", async () => {
    const credentials = new FakeCredentialRepository(shopifyCredential());
    const fetcher = new FakeFetch([
      jsonResponse({
        data: {
          orderCancel: {
            job: { id: "gid://shopify/Job/cancel-1", done: false },
            orderCancelUserErrors: [],
            userErrors: [],
          },
        },
      }),
    ]);
    const provider = new ShopifyDropshipOrderCancellationProvider(credentials, fetcher.fetch);

    const result = await provider.cancelOrder(makeRequest({ platform: "shopify" }));

    expect(result).toMatchObject({
      status: "cancelled",
      externalCancellationId: "gid://shopify/Job/cancel-1",
    });
    expect(fetcher.calls[0]?.url).toBe("https://vendor-shop.myshopify.com/admin/api/2026-04/graphql.json");
    const body = JSON.parse(String(fetcher.calls[0]?.init.body));
    expect(body.variables).toMatchObject({
      orderId: "gid://shopify/Order/1234567890",
      notifyCustomer: true,
      refundMethod: { originalPaymentMethodsRefund: true },
      restock: true,
      reason: "OTHER",
    });
  });

  it("cancels eBay orders with connection-level cancellation configuration", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential({
      config: {
        environment: "sandbox",
        cancellation: {
          cancelReason: "BuyerCancelOrder",
          buyerPaid: true,
        },
      },
    }));
    const fetcher = new FakeFetch([
      jsonResponse({ cancelId: "cancel-1" }),
    ]);
    const provider = new EbayDropshipOrderCancellationProvider(
      credentials,
      fetcher.fetch,
      { now: () => new Date("2026-05-02T18:00:00.000Z") },
    );

    const result = await provider.cancelOrder(makeRequest({
      platform: "ebay",
      externalOrderId: "EBAY-ORDER-1",
      sourceOrderId: "LEGACY-ORDER-1",
    }));

    expect(result).toMatchObject({
      status: "cancelled",
      externalCancellationId: "cancel-1",
    });
    expect(fetcher.calls[0]?.url).toBe("https://api.sandbox.ebay.com/post-order/v2/cancellation");
    const body = JSON.parse(String(fetcher.calls[0]?.init.body));
    expect(body).toEqual({
      legacyOrderId: "LEGACY-ORDER-1",
      cancelReason: "BuyerCancelOrder",
      buyerPaid: true,
      buyerPaidDate: "2026-05-02T17:55:00.000Z",
    });
  });

  it("requires explicit eBay cancellation reason configuration", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([]);
    const provider = new EbayDropshipOrderCancellationProvider(credentials, fetcher.fetch);

    await expect(provider.cancelOrder(makeRequest({
      platform: "ebay",
      externalOrderId: "EBAY-ORDER-1",
    }))).rejects.toMatchObject({ code: "DROPSHIP_EBAY_ORDER_CANCELLATION_CONFIG_REQUIRED" });
    expect(fetcher.calls).toHaveLength(0);
  });
});

class FakeCredentialRepository implements DropshipMarketplaceCredentialRepository {
  constructor(private credential: DropshipMarketplaceStoreCredentials) {}

  async loadForStoreConnection(): Promise<DropshipMarketplaceStoreCredentials> {
    return this.credential;
  }

  async replaceTokens(
    input: Parameters<DropshipMarketplaceCredentialRepository["replaceTokens"]>[0],
  ): Promise<DropshipMarketplaceStoreCredentials> {
    this.credential = {
      ...this.credential,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken ?? this.credential.refreshToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
    };
    return this.credential;
  }
}

class FakeFetch {
  calls: Array<{ url: string; init: RequestInit }> = [];

  constructor(private responses: Response[]) {}

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.calls.push({ url: String(url), init: init ?? {} });
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`No fake response for ${String(url)}`);
    }
    return response;
  };
}

function makeRequest(input: {
  platform: "shopify" | "ebay";
  externalOrderId?: string;
  sourceOrderId?: string | null;
}): DropshipMarketplaceOrderCancellationRequest {
  return {
    intakeId: 1,
    vendorId: 10,
    storeConnectionId: 22,
    platform: input.platform,
    externalOrderId: input.externalOrderId ?? "1234567890",
    externalOrderNumber: "1001",
    sourceOrderId: input.sourceOrderId ?? null,
    orderedAt: "2026-05-02T17:55:00.000Z",
    reason: "payment_hold_expired",
    idempotencyKey: "order:1:cancel:abc",
  };
}

function shopifyCredential(): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 10,
    storeConnectionId: 22,
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

function ebayCredential(
  overrides: Partial<DropshipMarketplaceStoreCredentials> = {},
): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 10,
    storeConnectionId: 22,
    platform: "ebay",
    status: "connected",
    shopDomain: null,
    externalAccountId: "seller-1",
    externalDisplayName: "seller-1",
    config: {},
    accessToken: "ebay-token",
    accessTokenRef: "access-ref",
    accessTokenExpiresAt: new Date("2099-05-01T21:00:00.000Z"),
    refreshToken: "refresh-token",
    refreshTokenRef: "refresh-ref",
    refreshTokenExpiresAt: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
