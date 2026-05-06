import { describe, expect, it, vi } from "vitest";
import { EbayFulfillmentReconciler } from "../../reconcilers/ebay.reconciler";

function makeDb(opts: {
  shipmentRows?: Array<{ shipment_id: number | string | null }>;
  pushTrackingForShipment?: any;
  pushTracking?: any;
}) {
  return {
    __fulfillmentPush: {
      pushTrackingForShipment: opts.pushTrackingForShipment,
      pushTracking: opts.pushTracking,
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
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  };
}

describe("EbayFulfillmentReconciler.repush", () => {
  it("repushes shipped WMS shipments through the shipment-scoped path", async () => {
    const pushTrackingForShipment = vi.fn().mockResolvedValue(true);
    const pushTracking = vi.fn().mockResolvedValue(true);
    const db = makeDb({
      shipmentRows: [{ shipment_id: 309 }, { shipment_id: 310 }],
      pushTrackingForShipment,
      pushTracking,
    });

    const reconciler = new EbayFulfillmentReconciler(db as any);
    const result = await reconciler.repush({ id: 161881 } as any);

    expect(result).toBe(true);
    expect(pushTrackingForShipment).toHaveBeenCalledTimes(2);
    expect(pushTrackingForShipment).toHaveBeenNthCalledWith(1, 309);
    expect(pushTrackingForShipment).toHaveBeenNthCalledWith(2, 310);
    expect(pushTracking).not.toHaveBeenCalled();
  });

  it("falls back to order-level push when no shipped WMS shipment exists", async () => {
    const pushTrackingForShipment = vi.fn().mockResolvedValue(true);
    const pushTracking = vi.fn().mockResolvedValue(true);
    const db = makeDb({
      shipmentRows: [],
      pushTrackingForShipment,
      pushTracking,
    });

    const reconciler = new EbayFulfillmentReconciler(db as any);
    const result = await reconciler.repush({ id: 161881 } as any);

    expect(result).toBe(true);
    expect(pushTrackingForShipment).not.toHaveBeenCalled();
    expect(pushTracking).toHaveBeenCalledWith(161881);
  });

  it("returns false when any shipment-scoped repush fails", async () => {
    const pushTrackingForShipment = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const pushTracking = vi.fn().mockResolvedValue(true);
    const db = makeDb({
      shipmentRows: [{ shipment_id: 309 }, { shipment_id: 310 }],
      pushTrackingForShipment,
      pushTracking,
    });

    const reconciler = new EbayFulfillmentReconciler(db as any);
    const result = await reconciler.repush({ id: 161881 } as any);

    expect(result).toBe(false);
    expect(pushTrackingForShipment).toHaveBeenCalledTimes(2);
    expect(pushTracking).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("enqueues an order-level delayed retry when fallback tracking push returns false", async () => {
    const pushTrackingForShipment = vi.fn().mockResolvedValue(true);
    const pushTracking = vi.fn().mockResolvedValue(false);
    const db = makeDb({
      shipmentRows: [],
      pushTrackingForShipment,
      pushTracking,
    });

    const reconciler = new EbayFulfillmentReconciler(db as any);
    const result = await reconciler.repush({ id: 161881 } as any);

    expect(result).toBe(false);
    expect(pushTrackingForShipment).not.toHaveBeenCalled();
    expect(pushTracking).toHaveBeenCalledWith(161881);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("returns false when no tracking push service is wired", async () => {
    const db = {
      __fulfillmentPush: null,
      execute: vi.fn(),
    };

    const reconciler = new EbayFulfillmentReconciler(db as any);
    const result = await reconciler.repush({ id: 161881 } as any);

    expect(result).toBe(false);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
