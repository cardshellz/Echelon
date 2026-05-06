import { describe, expect, it } from "vitest";
import {
  syncDropshipAcceptedOrderToWmsSafely,
  type DropshipLogEvent,
  type DropshipOmsFulfillmentSync,
  type DropshipOmsFulfillmentSyncRetryQueue,
} from "../../application";

describe("syncDropshipAcceptedOrderToWmsSafely", () => {
  it("enqueues an OMS/WMS sync retry when the WMS sync service is unavailable", async () => {
    const retryQueue = new FakeRetryQueue();
    const logs: DropshipLogEvent[] = [];

    await syncDropshipAcceptedOrderToWmsSafely({
      fulfillmentSyncRetryQueue: retryQueue,
      logger: captureLogger(logs),
    }, {
      acceptance: makeAcceptedOrder(),
      source: "order_processing",
    });

    expect(retryQueue.enqueued).toEqual([
      { omsOrderId: 9001, cause: "WMS sync service unavailable" },
    ]);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_ACCEPTED_ORDER_WMS_SYNC_UNAVAILABLE",
        context: expect.objectContaining({ omsOrderId: 9001 }),
      }),
    ]));
  });

  it("enqueues an OMS/WMS sync retry when immediate sync returns no WMS order", async () => {
    const retryQueue = new FakeRetryQueue();
    const logs: DropshipLogEvent[] = [];

    await syncDropshipAcceptedOrderToWmsSafely({
      fulfillmentSync: new FakeFulfillmentSync(null),
      fulfillmentSyncRetryQueue: retryQueue,
      logger: captureLogger(logs),
    }, {
      acceptance: makeAcceptedOrder(),
      source: "vendor_acceptance",
    });

    expect(retryQueue.enqueued).toEqual([
      { omsOrderId: 9001, cause: "WMS sync did not return a WMS order id" },
    ]);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_ACCEPTED_ORDER_WMS_SYNC_UNRESOLVED",
        context: expect.objectContaining({ source: "vendor_acceptance" }),
      }),
    ]));
  });

  it("enqueues an OMS/WMS sync retry when immediate sync throws", async () => {
    const error = new Error("database timeout");
    const retryQueue = new FakeRetryQueue();
    const logs: DropshipLogEvent[] = [];

    await syncDropshipAcceptedOrderToWmsSafely({
      fulfillmentSync: new FakeFulfillmentSync(null, error),
      fulfillmentSyncRetryQueue: retryQueue,
      logger: captureLogger(logs),
    }, {
      acceptance: makeAcceptedOrder(),
      source: "order_processing",
    });

    expect(retryQueue.enqueued).toEqual([
      { omsOrderId: 9001, cause: error },
    ]);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_ACCEPTED_ORDER_WMS_SYNC_FAILED",
        context: expect.objectContaining({ error: "database timeout" }),
      }),
    ]));
  });

  it("logs retry enqueue failures without failing accepted order processing", async () => {
    const retryQueue = new FakeRetryQueue(new Error("retry queue unavailable"));
    const logs: DropshipLogEvent[] = [];

    await syncDropshipAcceptedOrderToWmsSafely({
      fulfillmentSync: new FakeFulfillmentSync(null),
      fulfillmentSyncRetryQueue: retryQueue,
      logger: captureLogger(logs),
    }, {
      acceptance: makeAcceptedOrder(),
      source: "order_processing",
    });

    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_ACCEPTED_ORDER_WMS_SYNC_RETRY_ENQUEUE_FAILED",
        context: expect.objectContaining({
          omsOrderId: 9001,
          error: "retry queue unavailable",
        }),
      }),
    ]));
  });
});

class FakeFulfillmentSync implements DropshipOmsFulfillmentSync {
  constructor(
    private readonly result: number | null,
    private readonly error: Error | null = null,
  ) {}

  async syncOmsOrderToWms(): Promise<number | null> {
    if (this.error) throw this.error;
    return this.result;
  }
}

class FakeRetryQueue implements DropshipOmsFulfillmentSyncRetryQueue {
  enqueued: Array<{ omsOrderId: number; cause?: unknown }> = [];

  constructor(private readonly error: Error | null = null) {}

  async enqueueOmsWmsSyncRetry(input: { omsOrderId: number; cause?: unknown }): Promise<void> {
    this.enqueued.push(input);
    if (this.error) throw this.error;
  }
}

function makeAcceptedOrder() {
  return {
    outcome: "accepted" as const,
    intakeId: 7,
    vendorId: 10,
    storeConnectionId: 22,
    omsOrderId: 9001,
    idempotentReplay: false,
  };
}

function captureLogger(events: DropshipLogEvent[]) {
  return {
    info: (event: DropshipLogEvent) => events.push(event),
    warn: (event: DropshipLogEvent) => events.push(event),
    error: (event: DropshipLogEvent) => events.push(event),
  };
}
