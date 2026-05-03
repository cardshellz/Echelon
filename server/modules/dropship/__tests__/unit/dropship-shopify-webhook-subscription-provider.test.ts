import { describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import { ShopifyDropshipWebhookSubscriptionProvider } from "../../infrastructure/dropship-shopify-webhook-subscription.provider";

const connectedAt = new Date("2026-05-03T16:00:00.000Z");

describe("ShopifyDropshipWebhookSubscriptionProvider", () => {
  it("does nothing for non-Shopify store connections", async () => {
    const fetchImpl = vi.fn();
    const provider = makeProvider(fetchImpl);

    await provider.afterStoreConnected({
      vendorId: 10,
      storeConnectionId: 20,
      platform: "ebay",
      shopDomain: null,
      accessToken: "ebay-token",
      connectedAt,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips Shopify webhook creation when the desired subscriptions already exist", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.variables).toMatchObject({
        topics: ["ORDERS_CREATE", "ORDERS_PAID"],
      });
      return jsonResponse({
        data: {
          webhookSubscriptions: {
            nodes: [
              {
                id: "gid://shopify/WebhookSubscription/1",
                topic: "ORDERS_CREATE",
                uri: "https://echelon.cardshellz.io/api/dropship/webhooks/shopify/orders/create",
              },
              {
                id: "gid://shopify/WebhookSubscription/2",
                topic: "ORDERS_PAID",
                uri: "https://echelon.cardshellz.io/api/dropship/webhooks/shopify/orders/paid",
              },
            ],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      });
    });
    const provider = makeProvider(fetchImpl);

    await provider.afterStoreConnected(makeShopifyConnectInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://vendor-shop.myshopify.com/admin/api/2026-04/graphql.json");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "X-Shopify-Access-Token": "shopify-token",
    });
  });

  it("creates missing Shopify order intake webhook subscriptions with uri endpoints", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        data: {
          webhookSubscriptions: {
            nodes: [
              {
                id: "gid://shopify/WebhookSubscription/1",
                topic: "ORDERS_CREATE",
                uri: "https://echelon.cardshellz.io/api/dropship/webhooks/shopify/orders/create",
              },
            ],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          webhookSubscriptionCreate: {
            webhookSubscription: {
              id: "gid://shopify/WebhookSubscription/2",
              topic: "ORDERS_PAID",
              uri: "https://echelon.cardshellz.io/api/dropship/webhooks/shopify/orders/paid",
            },
            userErrors: [],
          },
        },
      }));
    const provider = makeProvider(fetchImpl);

    await provider.afterStoreConnected(makeShopifyConnectInput());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const mutationBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(mutationBody.variables).toEqual({
      topic: "ORDERS_PAID",
      webhookSubscription: {
        uri: "https://echelon.cardshellz.io/api/dropship/webhooks/shopify/orders/paid",
      },
    });
  });

  it("rejects missing public webhook base URL before calling Shopify", async () => {
    const fetchImpl = vi.fn();
    const provider = new ShopifyDropshipWebhookSubscriptionProvider({
      apiVersion: "2026-04",
      publicBaseUrl: null,
    }, fetchImpl as any);

    await expect(provider.afterStoreConnected(makeShopifyConnectInput())).rejects.toMatchObject({
      code: "DROPSHIP_SHOPIFY_WEBHOOK_BASE_URL_REQUIRED",
    } satisfies Partial<DropshipError>);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces Shopify webhook subscription user errors without leaking tokens", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        data: {
          webhookSubscriptions: {
            nodes: [],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          webhookSubscriptionCreate: {
            webhookSubscription: null,
            userErrors: [{ field: ["webhookSubscription", "uri"], message: "URI is not reachable" }],
          },
        },
      }));
    const provider = makeProvider(fetchImpl);

    let thrown: unknown;
    try {
      await provider.afterStoreConnected(makeShopifyConnectInput());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "DROPSHIP_SHOPIFY_WEBHOOK_SUBSCRIPTION_REJECTED",
      context: expect.objectContaining({
        topic: "ORDERS_CREATE",
        retryable: false,
      }),
    } satisfies Partial<DropshipError>);
    expect(JSON.stringify(thrown)).not.toContain("shopify-token");
  });
});

function makeProvider(fetchImpl: unknown): ShopifyDropshipWebhookSubscriptionProvider {
  return new ShopifyDropshipWebhookSubscriptionProvider({
    apiVersion: "2026-04",
    publicBaseUrl: "https://echelon.cardshellz.io",
  }, fetchImpl as any);
}

function makeShopifyConnectInput() {
  return {
    vendorId: 10,
    storeConnectionId: 20,
    platform: "shopify" as const,
    shopDomain: "vendor-shop.myshopify.com",
    accessToken: "shopify-token",
    connectedAt,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
