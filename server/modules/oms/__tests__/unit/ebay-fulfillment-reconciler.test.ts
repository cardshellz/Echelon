import { describe, expect, it, vi } from "vitest";
import { EbayFulfillmentReconciler } from "../../reconcilers/ebay.reconciler";

function makeDb(opts: {
  shipmentRows?: Array<{ shipment_id: number | string | null }>;
  ensureLegacyShipment?: any;
}) {
  const ensureLegacyShipment = opts.ensureLegacyShipment ?? vi.fn(async () => ({
    materialized: {
      physicalShipmentId: 90001,
      shippingEngineOrderId: 80001,
      channelCommands: [{ id: 70001, pushStatus: "pending" }],
      customerFulfillmentItemCount: 1,
      nonCustomerItemCount: 0,
    },
    dispatch: { claimed: 1, succeeded: 1, ignored: 0, retryScheduled: 0, reviewRequired: 0, deadLettered: 0 },
  }));
  return {
    fulfillmentAuthority: {
      ensureLegacyShipment,
      recordPhysicalPackage: vi.fn(),
      projectPhysicalPackage: vi.fn(),
      runDueBatch: vi.fn(),
    },
    execute: vi.fn(async (query: any) => {
      const queryText = (query?.queryChunks ?? [])
        .flatMap((chunk: any) => chunk?.value ?? [])
        .join(" ");
      if (queryText.includes("FROM oms.webhook_retry_queue")) {
        return { rows: [] };
      }
      return { rows: opts.shipmentRows ?? [] };
    }),
  };
}

describe("EbayFulfillmentReconciler.repush", () => {
  it("repushes shipped WMS shipments through the shipment-scoped path", async () => {
    const ensureLegacyShipment = vi.fn(async () => ({
      materialized: {
        physicalShipmentId: 90001,
        shippingEngineOrderId: 80001,
        channelCommands: [{ id: 70001, pushStatus: "pending" }],
        customerFulfillmentItemCount: 1,
        nonCustomerItemCount: 0,
      },
      dispatch: { claimed: 1, succeeded: 1, ignored: 0, retryScheduled: 0, reviewRequired: 0, deadLettered: 0 },
    }));
    const db = makeDb({
      shipmentRows: [{ shipment_id: 309 }, { shipment_id: 310 }],
      ensureLegacyShipment,
    });

    const reconciler = new EbayFulfillmentReconciler(db as any, db.fulfillmentAuthority as any);
    const result = await reconciler.repush({ id: 161881 } as any);

    expect(result).toBe(true);
    expect(ensureLegacyShipment).toHaveBeenCalledTimes(2);
    expect(ensureLegacyShipment).toHaveBeenNthCalledWith(1, 309, {
      executeImmediately: true,
      source: "ebay_fulfillment_reconciler",
    });
    expect(ensureLegacyShipment).toHaveBeenNthCalledWith(2, 310, {
      executeImmediately: true,
      source: "ebay_fulfillment_reconciler",
    });
  });

  it("fails closed when no shipped WMS package exists", async () => {
    const ensureLegacyShipment = vi.fn();
    const db = makeDb({
      shipmentRows: [],
      ensureLegacyShipment,
    });

    const reconciler = new EbayFulfillmentReconciler(db as any, db.fulfillmentAuthority as any);
    const result = await reconciler.repush({ id: 161881 } as any);

    expect(result).toBe(false);
    expect(ensureLegacyShipment).not.toHaveBeenCalled();
  });

  it("returns false when any package command remains retryable", async () => {
    const ensureLegacyShipment = vi
      .fn()
      .mockResolvedValueOnce({
        materialized: { physicalShipmentId: 90001, shippingEngineOrderId: 80001, channelCommands: [{ id: 70001, pushStatus: "pending" }], customerFulfillmentItemCount: 1, nonCustomerItemCount: 0 },
        dispatch: { claimed: 1, succeeded: 1, ignored: 0, retryScheduled: 0, reviewRequired: 0, deadLettered: 0 },
      })
      .mockResolvedValueOnce({
        materialized: { physicalShipmentId: 90002, shippingEngineOrderId: 80002, channelCommands: [{ id: 70002, pushStatus: "pending" }], customerFulfillmentItemCount: 1, nonCustomerItemCount: 0 },
        dispatch: { claimed: 1, succeeded: 0, ignored: 0, retryScheduled: 1, reviewRequired: 0, deadLettered: 0 },
      });
    const db = makeDb({
      shipmentRows: [{ shipment_id: 309 }, { shipment_id: 310 }],
      ensureLegacyShipment,
    });

    const reconciler = new EbayFulfillmentReconciler(db as any, db.fulfillmentAuthority as any);
    const result = await reconciler.repush({ id: 161881 } as any);

    expect(result).toBe(false);
    expect(ensureLegacyShipment).toHaveBeenCalledTimes(2);
  });

  it("does not synthesize an order-level retry when package evidence is absent", async () => {
    const ensureLegacyShipment = vi.fn();
    const db = makeDb({
      shipmentRows: [],
      ensureLegacyShipment,
    });

    const reconciler = new EbayFulfillmentReconciler(db as any, db.fulfillmentAuthority as any);
    const result = await reconciler.repush({ id: 161881 } as any);

    expect(result).toBe(false);
    expect(ensureLegacyShipment).not.toHaveBeenCalled();
  });

  it("fails closed when canonical authority rejects the handoff", async () => {
    const db = {
      execute: vi.fn(async () => ({ rows: [{ shipment_id: 309 }] })),
    };

    const fulfillmentAuthority = {
      ensureLegacyShipment: vi.fn(async () => {
        throw Object.assign(new Error("authority unavailable"), {
          code: "CHANNEL_FULFILLMENT_AUTHORITY_UNAVAILABLE",
        });
      }),
    } as any;

    const reconciler = new EbayFulfillmentReconciler(db as any, fulfillmentAuthority);
    const result = await reconciler.repush({ id: 161881 } as any);

    expect(result).toBe(false);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(fulfillmentAuthority.ensureLegacyShipment).toHaveBeenCalledTimes(1);
  });
});
