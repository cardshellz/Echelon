import { describe, it, expect } from "vitest";
import { getFlowTrace } from "../../flow-trace.service";

// Pure unit test: a fake db whose .transaction runs the callback with a fake tx
// that returns queued results positionally (mirrors flow-waterfall.service.test.ts).
// getFlowTrace's query order inside the tx is fixed and sequential:
//   1. SET TRANSACTION READ ONLY        2. SET LOCAL statement_timeout
//   3. oms_orders lookup                4. wms.orders
//   5. outbound_shipments (iff WMS hit) 6. oms_order_events
//   7. webhook_inbox                    8. webhook_retry_queue
function fakeDb(results: Array<{ rows: any[] }>) {
  const queue = [{ rows: [] }, { rows: [] }, ...results]; // two SET statements first
  const execute = async () => {
    const next = queue.shift();
    if (!next) throw new Error("fakeDb: query queue exhausted — test enqueued too few results");
    return next;
  };
  return { transaction: async (fn: (tx: any) => any) => fn({ execute }) };
}

const OMS_ROW = {
  id: 209451,
  external_order_number: "#58780",
  external_order_id: "12111531245727",
  status: "confirmed",
  financial_status: "paid",
  tracking_number: null,
  tracking_carrier: null,
  created_at: "2026-06-11T06:17:02.174Z",
  shipped_at: null,
  provider: "shopify",
};
const WMS_ROW = { id: 203821, warehouse_status: "ready", created_at: "2026-06-11T06:17:22.340Z", link_via: "oms_fulfillment_order_id" };
const SHIPMENT_ROW = {
  id: 3319, order_id: 203821, status: "queued", engine_order_ref: "748559877", shipstation_order_id: 748559877,
  requires_review: false, review_reason: null, on_hold_reason: null, created_at: "2026-06-11T06:17:22.340Z",
};
const CREATED_EVENT = { event_type: "created", details: {}, created_at: "2026-06-11T06:17:02.174Z" };

function inboxRow(overrides: Record<string, any>) {
  return {
    id: 1, provider: "shopify", topic: "orders/paid", status: "succeeded", attempts: 1,
    last_error: null, first_received_at: null, last_attempt_at: null, processed_at: null, updated_at: null,
    ...overrides,
  };
}

describe("getFlowTrace :: ingestion stage vs recovered webhook failures", () => {
  it("does NOT fail the ingestion stage when a failed delivery was superseded by a later success of the same topic", async () => {
    const inbox = [
      // earlier deliveries failed on a transient pool timeout…
      inboxRow({ id: 40684, topic: "orders/paid", status: "failed", last_error: "timeout exceeded when trying to connect", last_attempt_at: "2026-06-11T02:16:52.106Z" }),
      inboxRow({ id: 40685, topic: "orders/updated", status: "failed", last_error: "timeout exceeded when trying to connect", last_attempt_at: "2026-06-11T02:17:02.144Z" }),
      // …and later deliveries of the SAME topics succeeded.
      inboxRow({ id: 40691, topic: "orders/paid", status: "succeeded", processed_at: "2026-06-11T02:17:22.961Z" }),
      inboxRow({ id: 40690, topic: "orders/updated", status: "succeeded", processed_at: "2026-06-11T02:17:22.701Z" }),
    ];
    const trace = await getFlowTrace(
      fakeDb([
        { rows: [OMS_ROW] },
        { rows: [WMS_ROW] },
        { rows: [SHIPMENT_ROW] },
        { rows: [CREATED_EVENT] },
        { rows: inbox },
        { rows: [] }, // retry queue
      ]),
      "#58780",
    );

    expect(trace.found).toBe(true);
    const ingested = trace.stages.find((s) => s.key === "ingested");
    expect(ingested?.status).toBe("done");
    expect(ingested?.detail).toMatch(/2 webhook failures recovered/);
    expect(trace.diverged).toBeNull();
  });

  it("fails the ingestion stage when a failed delivery was never superseded by a success of the same topic", async () => {
    const inbox = [
      inboxRow({ id: 1, topic: "orders/cancelled", status: "failed", last_attempt_at: "2026-06-11T02:17:02.144Z" }),
      // a success on a DIFFERENT topic does not recover the failure
      inboxRow({ id: 2, topic: "orders/paid", status: "succeeded", processed_at: "2026-06-11T02:17:22.961Z" }),
    ];
    const trace = await getFlowTrace(
      fakeDb([
        { rows: [OMS_ROW] },
        { rows: [WMS_ROW] },
        { rows: [SHIPMENT_ROW] },
        { rows: [CREATED_EVENT] },
        { rows: inbox },
        { rows: [] },
      ]),
      "#58780",
    );

    const ingested = trace.stages.find((s) => s.key === "ingested");
    expect(ingested?.status).toBe("failed");
    expect(trace.diverged?.stage).toBe("Ingested → OMS");
  });

  it("fails the ingestion stage when the success predates the failure (same topic)", async () => {
    const inbox = [
      inboxRow({ id: 1, topic: "orders/updated", status: "succeeded", processed_at: "2026-06-11T02:00:00.000Z" }),
      inboxRow({ id: 2, topic: "orders/updated", status: "failed", last_attempt_at: "2026-06-11T02:17:02.144Z" }),
    ];
    const trace = await getFlowTrace(
      fakeDb([
        { rows: [OMS_ROW] },
        { rows: [WMS_ROW] },
        { rows: [SHIPMENT_ROW] },
        { rows: [CREATED_EVENT] },
        { rows: inbox },
        { rows: [] },
      ]),
      "#58780",
    );

    expect(trace.stages.find((s) => s.key === "ingested")?.status).toBe("failed");
  });

  it("keeps a clean 'done' (no detail) when nothing failed", async () => {
    const trace = await getFlowTrace(
      fakeDb([
        { rows: [OMS_ROW] },
        { rows: [WMS_ROW] },
        { rows: [SHIPMENT_ROW] },
        { rows: [CREATED_EVENT] },
        { rows: [inboxRow({ id: 1, status: "succeeded", processed_at: "2026-06-11T02:17:22.961Z" })] },
        { rows: [] },
      ]),
      "#58780",
    );

    const ingested = trace.stages.find((s) => s.key === "ingested");
    expect(ingested?.status).toBe("done");
    expect(ingested?.detail).toBeUndefined();
  });

  it("does not let one successful split shipment hide another missing writeback", async () => {
    const trace = await getFlowTrace(
      fakeDb([
        { rows: [{ ...OMS_ROW, status: "partially_shipped" }] },
        { rows: [WMS_ROW] },
        {
          rows: [
            {
              ...SHIPMENT_ROW,
              id: 4001,
              status: "shipped",
              tracking_number: "1ZGOOD",
              shopify_fulfillment_id: "gid://shopify/Fulfillment/1",
              has_shippable_items: true,
            },
            {
              ...SHIPMENT_ROW,
              id: 4002,
              status: "shipped",
              tracking_number: "1ZMISS",
              shopify_fulfillment_id: null,
              has_shippable_items: true,
            },
          ],
        },
        {
          rows: [
            CREATED_EVENT,
            {
              event_type: "shopify_fulfillment_pushed",
              details: { wmsShipmentId: 4001, shopifyFulfillmentId: "gid://shopify/Fulfillment/1" },
              created_at: "2026-06-11T06:18:00.000Z",
            },
          ],
        },
        { rows: [inboxRow({ id: 1, status: "succeeded" })] },
        { rows: [] },
      ]),
      "#58780",
    );

    const writeback = trace.stages.find((stage) => stage.key === "writeback");
    expect(writeback?.status).toBe("failed");
    expect(writeback?.detail).toContain("1/2 shipped shipments confirmed");
    expect(trace.diverged?.stage).toBe("Written back to channel");
  });
});
