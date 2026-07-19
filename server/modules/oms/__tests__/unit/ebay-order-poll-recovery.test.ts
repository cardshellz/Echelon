import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pollEbayOrders,
  setWmsSyncService,
} from "../../ebay-order-ingestion";
import {
  getEbayOrderPollHeartbeat,
  resetEbayOrderPollHeartbeatForTests,
} from "../../ebay-order-poll-heartbeat";

function queryText(query: any): string {
  return (query?.queryChunks ?? [])
    .flatMap((chunk: any) => chunk?.value ?? [])
    .join(" ");
}

function ebayOrder(orderId = "24-14885-40737"): any {
  return {
    orderId,
    creationDate: "2026-07-14T05:22:32.000Z",
    lastModifiedDate: "2026-07-14T05:25:23.000Z",
    orderPaymentStatus: "PAID",
    orderFulfillmentStatus: "NOT_STARTED",
    cancelStatus: { cancelState: "NONE_REQUESTED" },
    buyer: { username: "test-buyer" },
    fulfillmentStartInstructions: [],
    pricingSummary: {
      priceSubtotal: { value: "10.00" },
      deliveryCost: { value: "0.00" },
      priceDiscount: { value: "0.00" },
      total: { value: "10.00", currency: "USD" },
    },
    lineItems: [{
      lineItemId: "line-1",
      legacyItemId: "listing-1",
      sku: "TEST-SKU",
      title: "Test item",
      quantity: 1,
      lineItemCost: { value: "10.00" },
    }],
  };
}

function databaseWithCheckpoint(checkpoint: Record<string, unknown> | null) {
  const statements: string[] = [];
  const execute = vi.fn(async (query: any) => {
    const text = queryText(query);
    statements.push(text);
    if (text.includes("SELECT last_window_end, last_deep_scan_at")) {
      return { rows: checkpoint ? [checkpoint] : [] };
    }
    if (text.includes("oms.record_channel_order_intake")) {
      return { rows: [{ id: 1 }] };
    }
    return { rows: [] };
  });
  return { database: { execute }, execute, statements };
}

describe("eBay order poll recovery", () => {
  beforeEach(() => {
    resetEbayOrderPollHeartbeatForTests();
  });

  it("runs a 30-day deep scan when no durable checkpoint exists", async () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const { database, statements } = databaseWithCheckpoint(null);
    const syncOmsOrderToWms = vi.fn(async () => 205570);
    setWmsSyncService({ syncOmsOrderToWms } as any);

    const ingestOrder = vi.fn(async () => ({
      id: 269119,
      createdAt: new Date().toISOString(),
      warehouseId: 1,
    }));
    const omsService = {
      ingestOrder,
      getOrderById: vi.fn(),
      reserveInventory: vi.fn(),
      assignWarehouse: vi.fn(),
    } as any;
    const getOrders = vi.fn(async () => ({
      orders: [ebayOrder()],
      total: 1,
    }));

    const ingested = await pollEbayOrders(
      omsService,
      { getOrders } as any,
      { database, now },
    );

    expect(ingested).toBe(1);
    expect(ingestOrder).toHaveBeenCalledOnce();
    expect(syncOmsOrderToWms).toHaveBeenCalledTimes(2);
    expect(getOrders).toHaveBeenCalledTimes(2);
    expect(getOrders.mock.calls[0][0].filter).toContain(
      "creationdate:[2026-06-16T12:00:00.000Z..2026-07-16T12:00:00.000Z]",
    );
    expect(statements.some((text) => (
      text.includes("last_deep_scan_at = CASE")
      && text.includes("last_window_end")
    ))).toBe(true);
    expect(getEbayOrderPollHeartbeat()).toMatchObject({
      lastOrdersSeen: 1,
      lastOrdersIngested: 1,
      lastError: null,
      lastDeepScanAt: "2026-07-16T12:00:00.000Z",
    });
  });

  it("overlaps a recent checkpoint by 24 hours between deep scans", async () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const { database } = databaseWithCheckpoint({
      last_window_end: "2026-07-16T11:00:00.000Z",
      last_deep_scan_at: "2026-07-16T11:30:00.000Z",
    });
    const getOrders = vi.fn(async () => ({ orders: [], total: 0 }));

    await pollEbayOrders(
      {
        ingestOrder: vi.fn(),
        getOrderById: vi.fn(),
        reserveInventory: vi.fn(),
        assignWarehouse: vi.fn(),
      } as any,
      { getOrders } as any,
      { database, now },
    );

    expect(getOrders.mock.calls[0][0].filter).toContain(
      "creationdate:[2026-07-15T11:00:00.000Z..2026-07-16T12:00:00.000Z]",
    );
    expect(getEbayOrderPollHeartbeat().lastDeepScanAt).toBeNull();
  });

  it("queues a durable retry and does not advance the checkpoint when an order fails", async () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const { database, statements } = databaseWithCheckpoint(null);
    const ingestOrder = vi.fn(async () => {
      throw new Error("catalog variant missing");
    });
    const getOrders = vi.fn(async () => ({
      orders: [ebayOrder("15-14885-86879")],
      total: 1,
    }));

    await expect(pollEbayOrders(
      {
        ingestOrder,
        getOrderById: vi.fn(),
        reserveInventory: vi.fn(),
        assignWarehouse: vi.fn(),
      } as any,
      { getOrders } as any,
      { database, now },
    )).rejects.toThrow("15-14885-86879");

    expect(ingestOrder).toHaveBeenCalledOnce();
    expect(statements.some((text) => (
      text.includes("INSERT INTO oms.webhook_retry_queue")
      && text.includes("EBAY_ORDER_INGEST_RECOVERY")
    ))).toBe(true);
    expect(statements.some((text) => text.includes("consecutive_failures = consecutive_failures + 1"))).toBe(true);
    expect(statements.some((text) => text.includes("last_success_at = NOW()"))).toBe(false);
    expect(getEbayOrderPollHeartbeat().lastError).toContain(
      "15-14885-86879",
    );
  });
});
