import { describe, expect, it, vi } from "vitest";
import { ShopifyFulfillmentReconciler } from "../../reconcilers/shopify.reconciler";

function makeClient(response: any) {
  return {
    request: vi.fn().mockResolvedValue(response),
  };
}

function makeAuthority(ensureLegacyShipment: any = vi.fn()) {
  return {
    ensureLegacyShipment,
    recordPhysicalPackage: vi.fn(),
    projectPhysicalPackage: vi.fn(),
    runDueBatch: vi.fn(),
  } as any;
}

function makeDb(opts: {
  shipmentRows?: Array<{ shipment_id: number | string | null }>;
  ensureLegacyShipment?: any;
} = {}) {
  const ensureLegacyShipment = opts.ensureLegacyShipment ?? vi.fn(async () => ({
    materialized: {
      physicalShipmentId: 90001,
      shippingEngineOrderId: 80001,
      channelCommands: [{ id: 70001, pushStatus: "pending" }],
      customerFulfillmentItemCount: 1,
      nonCustomerItemCount: 0,
    },
    dispatch: {
      claimed: 1,
      succeeded: 1,
      ignored: 0,
      retryScheduled: 0,
      reviewRequired: 0,
      deadLettered: 0,
    },
  }));
  return {
    execute: vi.fn(async (query: any) => {
      const queryText = (query?.queryChunks ?? [])
        .flatMap((chunk: any) => chunk?.value ?? [])
        .join(" ");
      if (queryText.includes("FROM oms.webhook_retry_queue")) {
        return { rows: [] };
      }
      // enqueueShopifyFulfillmentRetry's requires_review chokepoint probe —
      // these shipments are not flagged, so the enqueue proceeds.
      if (queryText.includes("requires_review = true")) {
        return { rows: [] };
      }
      return { rows: opts.shipmentRows ?? [] };
    }),
    fulfillmentAuthority: makeAuthority(ensureLegacyShipment),
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
    const reconciler = new ShopifyFulfillmentReconciler(
      {} as any,
      makeAuthority(),
      client,
    );

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
    const reconciler = new ShopifyFulfillmentReconciler(
      {} as any,
      makeAuthority(),
      client,
    );

    const status = await reconciler.checkStatus({
      id: 161177,
      external_order_id: "12054356492447",
    } as any);

    expect(status).toBe("unfulfilled");
  });

  it("returns unknown when the OMS order has no resolvable Shopify order id", async () => {
    const client = makeClient({});
    const reconciler = new ShopifyFulfillmentReconciler(
      {} as any,
      makeAuthority(),
      client,
    );

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
    const ensureLegacyShipment = vi.fn(async () => ({
      materialized: {
        physicalShipmentId: 90001,
        shippingEngineOrderId: 80001,
        channelCommands: [{ id: 70001, pushStatus: "pending" }],
        customerFulfillmentItemCount: 1,
        nonCustomerItemCount: 0,
      },
      dispatch: {
        claimed: 1,
        succeeded: 1,
        ignored: 0,
        retryScheduled: 0,
        reviewRequired: 0,
        deadLettered: 0,
      },
    }));
    const db = makeDb({
      shipmentRows: [{ shipment_id: 257 }, { shipment_id: "258" }],
      ensureLegacyShipment,
    });
    const reconciler = new ShopifyFulfillmentReconciler(
      db as any,
      db.fulfillmentAuthority,
      makeClient({}),
    );

    const success = await reconciler.repush({ id: 161177 } as any);

    expect(success).toBe(true);
    expect(ensureLegacyShipment).toHaveBeenCalledTimes(2);
    expect(ensureLegacyShipment).toHaveBeenNthCalledWith(1, 257, {
      executeImmediately: true,
      source: "shopify_fulfillment_reconciler",
    });
    expect(ensureLegacyShipment).toHaveBeenNthCalledWith(2, 258, {
      executeImmediately: true,
      source: "shopify_fulfillment_reconciler",
    });
  });

  it("returns false when any canonical command remains retryable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ensureLegacyShipment = vi
      .fn()
      .mockResolvedValueOnce({
        materialized: {
          physicalShipmentId: 90001,
          shippingEngineOrderId: 80001,
          channelCommands: [{ id: 70001, pushStatus: "pending" }],
          customerFulfillmentItemCount: 1,
          nonCustomerItemCount: 0,
        },
        dispatch: { claimed: 1, succeeded: 1, ignored: 0, retryScheduled: 0, reviewRequired: 0, deadLettered: 0 },
      })
      .mockResolvedValueOnce({
        materialized: {
          physicalShipmentId: 90002,
          shippingEngineOrderId: 80002,
          channelCommands: [{ id: 70002, pushStatus: "pending" }],
          customerFulfillmentItemCount: 1,
          nonCustomerItemCount: 0,
        },
        dispatch: { claimed: 1, succeeded: 0, ignored: 0, retryScheduled: 1, reviewRequired: 0, deadLettered: 0 },
      });
    const db = makeDb({
      shipmentRows: [{ shipment_id: 257 }, { shipment_id: 258 }],
      ensureLegacyShipment,
    });
    const reconciler = new ShopifyFulfillmentReconciler(
      db as any,
      db.fulfillmentAuthority,
      makeClient({}),
    );

    const success = await reconciler.repush({ id: 161177 } as any);

    expect(success).toBe(false);
    expect(ensureLegacyShipment).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});
