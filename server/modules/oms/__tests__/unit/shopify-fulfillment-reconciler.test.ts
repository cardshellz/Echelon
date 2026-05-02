import { describe, expect, it, vi } from "vitest";
import { ShopifyFulfillmentReconciler } from "../../reconcilers/shopify.reconciler";

function makeClient(response: any) {
  return {
    request: vi.fn().mockResolvedValue(response),
  };
}

function makeDb(opts: {
  shipmentRows?: Array<{ shipment_id: number | string | null }>;
  pushShopifyFulfillment?: any;
} = {}) {
  return {
    __fulfillmentPush:
      opts.pushShopifyFulfillment === undefined
        ? undefined
        : { pushShopifyFulfillment: opts.pushShopifyFulfillment },
    execute: vi.fn().mockResolvedValue({ rows: opts.shipmentRows ?? [] }),
  };
}

describe("ShopifyFulfillmentReconciler.checkStatus", () => {
  it("returns fulfilled when Shopify displayFulfillmentStatus is fulfilled", async () => {
    const client = makeClient({
      order: {
        id: "gid://shopify/Order/12054356492447",
        displayFulfillmentStatus: "FULFILLED",
        fulfillmentOrders: { nodes: [] },
      },
    });
    const reconciler = new ShopifyFulfillmentReconciler({} as any, client);

    const status = await reconciler.checkStatus({
      id: 161177,
      external_order_id: "12054356492447",
    } as any);

    expect(status).toBe("fulfilled");
  });

  it("returns unfulfilled when Shopify has remaining fulfillment-order quantity", async () => {
    const client = makeClient({
      order: {
        id: "gid://shopify/Order/12054356492447",
        displayFulfillmentStatus: "UNFULFILLED",
        fulfillmentOrders: {
          nodes: [
            {
              id: "gid://shopify/FulfillmentOrder/1",
              lineItems: {
                nodes: [{ totalQuantity: 1, remainingQuantity: 1 }],
              },
            },
          ],
        },
      },
    });
    const reconciler = new ShopifyFulfillmentReconciler({} as any, client);

    const status = await reconciler.checkStatus({
      id: 161177,
      external_order_id: "12054356492447",
    } as any);

    expect(status).toBe("unfulfilled");
  });

  it("returns unknown when the OMS order has no resolvable Shopify order id", async () => {
    const client = makeClient({});
    const reconciler = new ShopifyFulfillmentReconciler({} as any, client);

    const status = await reconciler.checkStatus({
      id: 161177,
      external_order_id: "#56856",
    } as any);

    expect(status).toBe("unknown");
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe("ShopifyFulfillmentReconciler.repush", () => {
  it("repushes every shipped WMS shipment for the OMS order", async () => {
    const pushShopifyFulfillment = vi.fn().mockResolvedValue({
      shopifyFulfillmentId: "gid://shopify/Fulfillment/1",
      alreadyPushed: false,
    });
    const db = makeDb({
      shipmentRows: [{ shipment_id: 257 }, { shipment_id: "258" }],
      pushShopifyFulfillment,
    });
    const reconciler = new ShopifyFulfillmentReconciler(db as any, makeClient({}));

    const success = await reconciler.repush({ id: 161177 } as any);

    expect(success).toBe(true);
    expect(pushShopifyFulfillment).toHaveBeenCalledTimes(2);
    expect(pushShopifyFulfillment).toHaveBeenNthCalledWith(1, 257);
    expect(pushShopifyFulfillment).toHaveBeenNthCalledWith(2, 258);
  });

  it("returns false when any shipment repush throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pushShopifyFulfillment = vi
      .fn()
      .mockResolvedValueOnce({
        shopifyFulfillmentId: "gid://shopify/Fulfillment/1",
        alreadyPushed: false,
      })
      .mockRejectedValueOnce(new Error("Shopify rejected fulfillment"));
    const db = makeDb({
      shipmentRows: [{ shipment_id: 257 }, { shipment_id: 258 }],
      pushShopifyFulfillment,
    });
    const reconciler = new ShopifyFulfillmentReconciler(db as any, makeClient({}));

    const success = await reconciler.repush({ id: 161177 } as any);

    expect(success).toBe(false);
    vi.restoreAllMocks();
  });
});
