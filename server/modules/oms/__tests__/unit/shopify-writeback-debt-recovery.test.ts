import { describe, expect, it, vi } from "vitest";

import { recoverShopifyWritebackDebt } from "../../fulfillment-sweeper.scheduler";
import type { ShopifyFulfillmentSnapshot } from "../../shopify-fulfillment-snapshot";

function candidate(id: number, orderNumber: string) {
  return {
    id,
    external_order_id: String(id + 10_000),
    external_order_number: orderNumber,
    channel_id: 36,
    provider: "shopify",
    dead_retry_count: 1,
    first_failed_at: new Date("2026-07-20T12:00:00.000Z"),
  } as const;
}

function snapshot(
  order: ReturnType<typeof candidate>,
  complete = true,
): ShopifyFulfillmentSnapshot {
  return {
    sourceOrderId: order.external_order_id,
    observedAt: new Date("2026-07-27T12:00:00.000Z"),
    complete,
    packages: complete ? [{
      sourceFulfillmentId: `fulfillment-${order.id}`,
      trackingNumbers: [],
      items: [{
        sourceFulfillmentLineId: `fulfillment-line-${order.id}`,
        channelOrderLineId: `order-line-${order.id}`,
        quantity: 1,
      }],
    }] : [],
    incompleteReasons: complete ? [] : ["shopify_fulfillment_snapshot_truncated_or_count_missing"],
  };
}

function resolvedResult(omsOrderId: number) {
  return {
    omsOrderId,
    candidateShipmentCount: 1,
    resolvedShipmentIds: [omsOrderId + 100],
    resolvedRetryIds: [omsOrderId + 200],
    resolvedSourceInboxIds: [],
    unresolved: [],
    retryRowsResolved: 1,
    inboxRowsResolved: 0,
    reviewMarkersCleared: 1,
    eventRecorded: true,
  };
}

describe("recoverShopifyWritebackDebt", () => {
  it("reads provider evidence before resolving and leaves incomplete snapshots visible", async () => {
    const orders = [candidate(5001, "#5001"), candidate(5002, "#5002")];
    const db = {
      execute: vi.fn(async () => ({
        rows: orders.map((order) => ({
          ...order,
          first_failed_at: order.first_failed_at.toISOString(),
        })),
      })),
    };
    const fetchSnapshot = vi.fn(async (order: typeof orders[number]) =>
      snapshot(order, order.id === 5001));
    const resolveOrder = vi.fn(async (order: typeof orders[number]) =>
      resolvedResult(order.id));
    const deferOrder = vi.fn(async () => 1);

    const result = await recoverShopifyWritebackDebt(db, {
      fetchSnapshot: fetchSnapshot as any,
      resolveOrder: resolveOrder as any,
      deferOrder,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });

    expect(result).toEqual({
      candidates: 2,
      providerSnapshotsComplete: 1,
      ordersResolved: 1,
      retryRowsResolved: 1,
      reviewRequired: 1,
      failed: 0,
    });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(resolveOrder).toHaveBeenCalledTimes(1);
    expect(deferOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 5002 }),
      new Date("2026-07-27T18:00:00.000Z"),
    );
    expect(resolveOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 5001 }),
      expect.objectContaining({ complete: true }),
    );
  });

  it("counts proof-resolution failures without stopping later candidates", async () => {
    const orders = [candidate(5001, "#5001"), candidate(5002, "#5002")];
    const db = {
      execute: vi.fn(async () => ({
        rows: orders.map((order) => ({
          ...order,
          first_failed_at: order.first_failed_at.toISOString(),
        })),
      })),
    };
    const resolveOrder = vi.fn(async (order: typeof orders[number]) => {
      if (order.id === 5001) {
        throw Object.assign(new Error("database timeout"), { code: "57014" });
      }
      return resolvedResult(order.id);
    });

    const deferOrder = vi.fn(async () => 1);
    const result = await recoverShopifyWritebackDebt(db, {
      fetchSnapshot: vi.fn(async (order) => snapshot(order as any)) as any,
      resolveOrder: resolveOrder as any,
      deferOrder,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });

    expect(result.failed).toBe(1);
    expect(result.ordersResolved).toBe(1);
    expect(result.retryRowsResolved).toBe(1);
    expect(resolveOrder).toHaveBeenCalledTimes(2);
    expect(deferOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 5001 }),
      new Date("2026-07-27T18:00:00.000Z"),
    );
  });
});
