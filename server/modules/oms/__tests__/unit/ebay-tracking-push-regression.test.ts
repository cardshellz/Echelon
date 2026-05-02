/**
 * Regression test for eBay tracking push.
 *
 * Root cause: `pushToEbay` accessed `result.fulfillmentId` where `result`
 * was `undefined`.  eBay's `createShippingFulfillment` endpoint returns
 * HTTP 201 with an empty body — the `request` method in `ebay-api.client.ts`
 * returned `undefined` for empty bodies, so every call to
 * `result.fulfillmentId` threw:
 *
 *   Cannot read properties of undefined (reading 'fulfillmentId')
 *
 * Fix: `createShippingFulfillment` now makes its own HTTP call and extracts
 * the `fulfillmentId` from the `Location` response header (per eBay's API
 * contract).  `pushToEbay` also uses optional chaining defensively.
 *
 * Coverage:
 *   1. createShippingFulfillment returns undefined → pushToEbay does NOT throw
 *      (regression — original failure mode)
 *   2. createShippingFulfillment returns { fulfillmentId } → records
 *      tracking_pushed with the id (unchanged happy path)
 *   3. createShippingFulfillment throws (network error) → records
 *      tracking_push_failed
 *   4. ebayApiClient is null → clean failure, no throw
 *   5. Correct payload passed to createShippingFulfillment
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFulfillmentPushService } from "../../fulfillment-push.service";

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Build a mock DB that handles the Drizzle-style chains used by pushTracking:
 *
 *   db.select().from(omsOrders).where(...).limit(1)   → order[]
 *   db.select().from(channels).where(...).limit(1)    → channel[]
 *   db.select().from(omsOrderLines).where(...)         → lines[]
 *   db.insert(omsOrderEvents).values({...})            → void
 */
function makeMockDb(opts: {
  order?: any;
  channel?: any;
  lines?: any[];
}) {
  const insertedEvents: any[] = [];

  // Helper: creates a thenable (array that is also awaitable) to mimic
  // Drizzle's "awaitable chain" pattern.
  function thenableArray(arr: any[]) {
    const obj = {
      ...arr,
      then: (resolve: any, reject: any) => Promise.resolve(arr).then(resolve, reject),
      // Drizzle chains: .where().limit() — we return self for chaining
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(async () => arr),
    };
    return obj;
  }

  // select() returns a builder with from()
  const selectBuilder = {
    from: vi.fn().mockImplementation((table: any) => {
      const tableName = table?.tableName ?? table?.name ?? table?._ ?? "";

      if (tableName === "oms_orders" || tableName === "omsOrders") {
        return thenableArray(opts.order ? [opts.order] : []);
      }
      if (tableName === "channels") {
        return thenableArray(opts.channel ? [opts.channel] : []);
      }
      if (tableName === "oms_order_lines" || tableName === "omsOrderLines") {
        return thenableArray(opts.lines ?? []);
      }

      return thenableArray([]);
    }),
  };

  const db = {
    select: vi.fn().mockReturnValue(selectBuilder),
    insert: vi.fn().mockImplementation((_table: any) => ({
      values: vi.fn().mockImplementation((row: any) => {
        insertedEvents.push(row);
        return Promise.resolve();
      }),
    })),
  };

  return { db, insertedEvents };
}

// Schema table stubs — these just need a `tableName` or `_` property
// to match against in the mock.
function tableStub(name: string) {
  return { tableName: name, _: name };
}

// ─── Fixtures ────────────────────────────────────────────────────────

const ORDER_ID = 38757;
const EBAY_ORDER_ID = "13-14532-27211";
const TRACKING = "9400150106151192529627";
const CHANNEL_ID = 67;

const mockOrder = {
  id: ORDER_ID,
  channelId: CHANNEL_ID,
  externalOrderId: EBAY_ORDER_ID,
  trackingNumber: TRACKING,
  trackingCarrier: "usps",
  shippedAt: new Date("2026-04-14T12:00:00Z"),
  vendorId: null,
};

const mockChannel = {
  id: CHANNEL_ID,
  provider: "ebay",
};

const mockLines = [
  { externalLineItemId: "12345", quantity: 1 },
];

// Patch the schema imports — we need to provide table stubs that the mock
// can match.  Since `pushTracking` imports from @shared/schema, we mock
// the module.
vi.mock("@shared/schema", () => ({
  omsOrders: { tableName: "oms_orders" },
  omsOrderLines: { tableName: "oms_order_lines" },
  omsOrderEvents: { tableName: "oms_order_events" },
  channels: { tableName: "channels" },
}));

// ─── Tests ───────────────────────────────────────────────────────────

describe("eBay tracking push regression (2026-04-14)", () => {
  let mockEbayClient: any;

  beforeEach(() => {
    mockEbayClient = {
      createShippingFulfillment: vi.fn(),
    };
  });

  it("does NOT throw when createShippingFulfillment returns undefined (original failure mode)", async () => {
    mockEbayClient.createShippingFulfillment.mockResolvedValue(undefined);

    const { db, insertedEvents } = makeMockDb({
      order: mockOrder,
      channel: mockChannel,
      lines: mockLines,
    });

    const svc = createFulfillmentPushService(db as any, mockEbayClient);
    const result = await svc.pushTracking(ORDER_ID);

    expect(result).toBe(true);

    const pushedEvent = insertedEvents.find(
      (e: any) => e.eventType === "tracking_pushed",
    );
    expect(pushedEvent).toBeTruthy();
    expect(pushedEvent.details.provider).toBe("ebay");
    expect(pushedEvent.details.fulfillmentId).toBeNull();

    const failedEvent = insertedEvents.find(
      (e: any) => e.eventType === "tracking_push_failed",
    );
    expect(failedEvent).toBeUndefined();
  });

  it("records tracking_pushed with fulfillmentId when createShippingFulfillment returns a normal object", async () => {
    const fulfillmentId = "ft_abc123";
    mockEbayClient.createShippingFulfillment.mockResolvedValue({ fulfillmentId });

    const { db, insertedEvents } = makeMockDb({
      order: mockOrder,
      channel: mockChannel,
      lines: mockLines,
    });

    const svc = createFulfillmentPushService(db as any, mockEbayClient);
    const result = await svc.pushTracking(ORDER_ID);

    expect(result).toBe(true);

    const pushedEvent = insertedEvents.find(
      (e: any) => e.eventType === "tracking_pushed",
    );
    expect(pushedEvent).toBeTruthy();
    expect(pushedEvent.details.fulfillmentId).toBe(fulfillmentId);
  });

  it("records tracking_push_failed when createShippingFulfillment throws (network error)", async () => {
    mockEbayClient.createShippingFulfillment.mockRejectedValue(
      new Error("eBay API POST .../shipping_fulfillment failed (500): Internal Server Error"),
    );

    const { db, insertedEvents } = makeMockDb({
      order: mockOrder,
      channel: mockChannel,
      lines: mockLines,
    });

    const svc = createFulfillmentPushService(db as any, mockEbayClient);
    const result = await svc.pushTracking(ORDER_ID);

    expect(result).toBe(false);

    const failedEvent = insertedEvents.find(
      (e: any) => e.eventType === "tracking_push_failed",
    );
    expect(failedEvent).toBeTruthy();
    expect(failedEvent.details.provider).toBe("ebay");
    expect(failedEvent.details.error).toContain("eBay API");
  });

  it("returns false without throw when ebayApiClient is null", async () => {
    const { db, insertedEvents } = makeMockDb({
      order: mockOrder,
      channel: mockChannel,
      lines: mockLines,
    });

    const svc = createFulfillmentPushService(db as any, null);
    const result = await svc.pushTracking(ORDER_ID);

    expect(result).toBe(false);
    expect(insertedEvents).toHaveLength(0);
  });

  it("passes correct payload to createShippingFulfillment", async () => {
    mockEbayClient.createShippingFulfillment.mockResolvedValue({ fulfillmentId: "ft_1" });

    const { db } = makeMockDb({
      order: mockOrder,
      channel: mockChannel,
      lines: mockLines,
    });

    const svc = createFulfillmentPushService(db as any, mockEbayClient);
    await svc.pushTracking(ORDER_ID);

    expect(mockEbayClient.createShippingFulfillment).toHaveBeenCalledWith(
      EBAY_ORDER_ID,
      expect.objectContaining({
        lineItems: [{ lineItemId: "12345", quantity: 1 }],
        shippingCarrierCode: "USPS",
        trackingNumber: TRACKING,
      }),
    );
  });

  it("routes dropship OMS orders to the dropship marketplace tracking service", async () => {
    const dropshipTracking = {
      pushForOmsOrder: vi.fn(async () => ({ status: "succeeded" })),
    };
    const { db } = makeMockDb({
      order: {
        ...mockOrder,
        rawPayload: { dropship: { intakeId: 12, storeConnectionId: 40 } },
      },
      channel: { id: CHANNEL_ID, provider: "manual" },
      lines: mockLines,
    });
    const svc = createFulfillmentPushService(db as any, mockEbayClient);
    svc.setDropshipMarketplaceTrackingService(dropshipTracking);

    const result = await svc.pushTracking(ORDER_ID);

    expect(result).toBe(true);
    expect(dropshipTracking.pushForOmsOrder).toHaveBeenCalledWith(expect.objectContaining({
      omsOrderId: ORDER_ID,
      carrier: "usps",
      trackingNumber: TRACKING,
      shippedAt: mockOrder.shippedAt,
    }));
    expect(mockEbayClient.createShippingFulfillment).not.toHaveBeenCalled();
  });

  it("does not invent shippedAt for dropship marketplace tracking", async () => {
    const dropshipTracking = {
      pushForOmsOrder: vi.fn(async () => ({ status: "succeeded" })),
    };
    const { db, insertedEvents } = makeMockDb({
      order: {
        ...mockOrder,
        shippedAt: null,
        rawPayload: { dropship: { intakeId: 12, storeConnectionId: 40 } },
      },
      channel: { id: CHANNEL_ID, provider: "manual" },
      lines: mockLines,
    });
    const svc = createFulfillmentPushService(db as any, mockEbayClient);
    svc.setDropshipMarketplaceTrackingService(dropshipTracking);

    const result = await svc.pushTracking(ORDER_ID);

    expect(result).toBe(false);
    expect(dropshipTracking.pushForOmsOrder).not.toHaveBeenCalled();
    expect(insertedEvents).toContainEqual(expect.objectContaining({
      orderId: ORDER_ID,
      eventType: "tracking_push_failed",
      details: expect.objectContaining({
        error: expect.stringContaining("requires shipped_at"),
      }),
    }));
  });
});
