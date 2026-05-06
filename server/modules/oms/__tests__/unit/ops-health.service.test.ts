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
});

describe("ops-health.service :: issue mapping", () => {
  it("maps stale inbox and on-hold shipment query results to the correct issue codes", async () => {
    const previousDisableSchedulers = process.env.DISABLE_SCHEDULERS;
    process.env.DISABLE_SCHEDULERS = "true";
    let callIndex = 0;
    const execute = vi.fn(async (query: any) => {
      void query;
      const index = callIndex++;
      if (index === 10) return { rows: [{ count: 1 }] };
      if (index === 11) {
        return { rows: [{ id: 11, provider: "shopify", topic: "orders/paid", attempts: 1 }] };
      }
      if (index === 14) return { rows: [{ count: 1 }] };
      if (index === 15) {
        return { rows: [{ id: 44, provider: "internal", topic: "oms_wms_sync", attempts: 2 }] };
      }
      if (index === 26) return { rows: [{ count: 1 }] };
      if (index === 27) {
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
    } finally {
      if (previousDisableSchedulers === undefined) {
        delete process.env.DISABLE_SCHEDULERS;
      } else {
        process.env.DISABLE_SCHEDULERS = previousDisableSchedulers;
      }
    }
  });
});
