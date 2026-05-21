import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getOmsOpsHealth } from "../../ops-health.service";

const OPS_HEALTH_SRC = readFileSync(
  resolve(__dirname, "../../ops-health.service.ts"),
  "utf-8",
);

describe("ops-health.service :: fulfillment alert severity", () => {
  it("treats stuck ShipStation push and missing tracking confirmation as critical", () => {
    expect(OPS_HEALTH_SRC).toMatch(
      /code: "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION"[\s\S]*severity: "critical"/,
    );
    expect(OPS_HEALTH_SRC).toMatch(
      /code: "SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED"[\s\S]*severity: "critical"/,
    );
    expect(OPS_HEALTH_SRC).toMatch(
      /code: "WMS_PENDING_ITEM_WITHOUT_SHIPMENT"[\s\S]*severity: "critical"/,
    );
  });

  it("only reports missing shipments and ShipStation pushes for shippable work", () => {
    expect(OPS_HEALTH_SRC).toMatch(/COALESCE\(oi\.requires_shipping, 1\) <> 0/);
    expect(OPS_HEALTH_SRC).toMatch(/COALESCE\(oi\.quantity, 0\) > COALESCE\(oi\.fulfilled_quantity, 0\)/);
    expect(OPS_HEALTH_SRC).toMatch(/JOIN wms\.order_items oi ON oi\.id = osi\.order_item_id/);
    expect(OPS_HEALTH_SRC).toMatch(/oo\.financial_status = 'refunded'/);
  });

  it("treats voided-only ShipStation shipments as missing shipment work", () => {
    expect(OPS_HEALTH_SRC).toMatch(/WHERE os\.order_id = wo\.id\s+AND os\.status <> 'voided'/);
  });

  it("surfaces pending WMS items that are not attached to active shipments", () => {
    expect(OPS_HEALTH_SRC).toMatch(/WMS_PENDING_ITEM_WITHOUT_SHIPMENT/);
    expect(OPS_HEALTH_SRC).toMatch(/FROM wms\.order_items oi/);
    expect(OPS_HEALTH_SRC).toMatch(/os\.status NOT IN \('voided', 'cancelled'\)/);
  });

  it("surfaces on-hold shipments as explicit warehouse review warnings", () => {
    expect(OPS_HEALTH_SRC).toMatch(
      /code: "SHIPMENT_ON_HOLD"[\s\S]*severity: "warning"/,
    );
    expect(OPS_HEALTH_SRC).toMatch(/WHERE status = 'on_hold'/);
  });

  it("treats stale due retry rows as critical worker backlog", () => {
    expect(OPS_HEALTH_SRC).toMatch(
      /code: "WEBHOOK_RETRY_STALE_DUE"[\s\S]*severity: "critical"/,
    );
    expect(OPS_HEALTH_SRC).toMatch(/next_retry_at <= NOW\(\) - INTERVAL '15 minutes'/);
  });

  it("surfaces webhook retry worker heartbeat issues", () => {
    expect(OPS_HEALTH_SRC).toMatch(/code: "WEBHOOK_RETRY_WORKER_NOT_STARTED"/);
    expect(OPS_HEALTH_SRC).toMatch(/code: "WEBHOOK_RETRY_WORKER_STALE"/);
  });

  it("surfaces OMS scheduler heartbeat issues", () => {
    expect(OPS_HEALTH_SRC).toMatch(/code: "OMS_FLOW_RECONCILIATION_SCHEDULER_NOT_STARTED"/);
    expect(OPS_HEALTH_SRC).toMatch(/code: "OMS_FLOW_RECONCILIATION_SCHEDULER_STALE"/);
    expect(OPS_HEALTH_SRC).toMatch(/code: "OMS_OPS_ALERT_SCHEDULER_NOT_STARTED"/);
    expect(OPS_HEALTH_SRC).toMatch(/code: "OMS_OPS_ALERT_SCHEDULER_STALE"/);
  });
});

describe("ops-health.service :: issue mapping", () => {
  it("maps stale inbox and on-hold shipment query results to the correct issue codes", async () => {
    const previousDisableSchedulers = process.env.DISABLE_SCHEDULERS;
    process.env.DISABLE_SCHEDULERS = "true";
    const execute = vi.fn(async (query: any) => {
      const queryText = (query?.queryChunks ?? [])
        .flatMap((chunk: any) => chunk?.value ?? [])
        .join(" ");

      if (queryText.includes("FROM oms.webhook_inbox") && queryText.includes("status = 'processing'")) {
        if (queryText.includes("COUNT(*)")) return { rows: [{ count: 1 }] };
        return { rows: [{ id: 11, provider: "shopify", topic: "orders/paid", attempts: 1 }] };
      }

      if (
        queryText.includes("FROM oms.webhook_retry_queue") &&
        queryText.includes("next_retry_at <= NOW() - INTERVAL '15 minutes'")
      ) {
        if (queryText.includes("COUNT(*)")) return { rows: [{ count: 1 }] };
        return { rows: [{ id: 44, provider: "internal", topic: "oms_wms_sync", attempts: 2 }] };
      }

      if (queryText.includes("FROM wms.outbound_shipments") && queryText.includes("WHERE status = 'on_hold'")) {
        if (queryText.includes("COUNT(*)")) return { rows: [{ count: 1 }] };
        return { rows: [{ shipment_id: 22, order_id: 33, status: "on_hold", on_hold_reason: "address review" }] };
      }

      return { rows: [{ count: 0 }] };
    });

    try {
      const health = await getOmsOpsHealth({ execute });

      const staleProcessing = health.issues.find((issue) => issue.code === "WEBHOOK_INBOX_STALE_PROCESSING");
      const staleDueRetry = health.issues.find((issue) => issue.code === "WEBHOOK_RETRY_STALE_DUE");
      const onHold = health.issues.find((issue) => issue.code === "SHIPMENT_ON_HOLD");

      expect(staleProcessing?.sample).toEqual([
        expect.objectContaining({ id: 11, topic: "orders/paid" }),
      ]);
      expect(staleDueRetry?.sample).toEqual([
        expect.objectContaining({ id: 44, topic: "oms_wms_sync" }),
      ]);
      expect(onHold?.sample).toEqual([
        expect.objectContaining({ shipment_id: 22, status: "on_hold" }),
      ]);
      expect(health.workers.webhookRetry).toHaveProperty("startedAt");
      expect(health.workers.omsFlowReconciliation).toHaveProperty("startedAt");
      expect(health.workers.omsOpsAlert).toHaveProperty("startedAt");
    } finally {
      if (previousDisableSchedulers === undefined) {
        delete process.env.DISABLE_SCHEDULERS;
      } else {
        process.env.DISABLE_SCHEDULERS = previousDisableSchedulers;
      }
    }
  });
});
