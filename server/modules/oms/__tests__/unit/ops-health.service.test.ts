import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getOmsOpsHealth } from "../../ops-health.service";

const OPS_HEALTH_SRC = readFileSync(
  resolve(__dirname, "../../ops-health.service.ts"),
  "utf-8",
);
const OMS_FLOW_RECONCILIATION_SRC = readFileSync(
  resolve(__dirname, "../../oms-flow-reconciliation.service.ts"),
  "utf-8",
);
const OMS_SCHEMA_SRC = readFileSync(
  resolve(__dirname, "../../../../../shared/schema/oms.schema.ts"),
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
    expect(OPS_HEALTH_SRC).toMatch(/WHERE held = true/);
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

  it("surfaces Phase 7 OMS/WMS authority monitoring signals", () => {
    expect(OPS_HEALTH_SRC).toMatch(
      /code: "WMS_ITEM_WITHOUT_OMS_AUTHORITY"[\s\S]*severity: "critical"/,
    );
    expect(OPS_HEALTH_SRC).toMatch(
      /code: "OMS_LINE_AUTHORITY_OVER_MATERIALIZED"[\s\S]*severity: "critical"/,
    );
    expect(OPS_HEALTH_SRC).toMatch(
      /code: "WMS_RECONCILIATION_MANUAL_REVIEW"[\s\S]*severity: "warning"/,
    );
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("WMS_PARTITION_DUPLICATE_LINE_COVERAGE");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("OMS_PROVIDER_FULFILLMENT_REFERENCE_DRIFT");
    expect(OPS_HEALTH_SRC).toContain("wms.reconciliation_exceptions");
    expect(OPS_HEALTH_SRC).toContain("GROUP BY rule");
    expect(OPS_HEALTH_SRC).toContain("authority_fulfillable_quantity");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("fulfillment_partition_key");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("provider_reference_drift");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("provider_reference_rows");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("normalized_fulfillment_provider");
    expect(OMS_SCHEMA_SRC).toContain("fulfillmentProvider");
    expect(OMS_SCHEMA_SRC).toContain("providerFulfillmentOrderId");
    expect(OMS_SCHEMA_SRC).toContain("providerFulfillmentOrderLineItemId");
  });

  it("surfaces duplicate active shipment identity monitoring signals", () => {
    expect(OPS_HEALTH_SRC).toMatch(
      /code: "SHIPSTATION_ORDER_ID_DUPLICATE"[\s\S]*severity: "critical"/,
    );
    expect(OPS_HEALTH_SRC).toMatch(
      /code: "SHIPSTATION_ORDER_KEY_DUPLICATE"[\s\S]*severity: "critical"/,
    );
    expect(OPS_HEALTH_SRC).toMatch(
      /code: "SHIPPING_ENGINE_ORDER_REF_DUPLICATE"[\s\S]*severity: "critical"/,
    );
    expect(OPS_HEALTH_SRC).toContain("s.shipstation_order_key");
    expect(OPS_HEALTH_SRC).toContain("s.engine_order_ref");
    expect(OPS_HEALTH_SRC).toContain("echelon_combined_child");
    expect(OPS_HEALTH_SRC).toContain("shipstation_combined_child");
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

      if (queryText.includes("FROM wms.outbound_shipments") && queryText.includes("WHERE held = true")) {
        if (queryText.includes("COUNT(*)")) return { rows: [{ count: 1 }] };
        // A held shipment now keeps its real lifecycle status (the `on_hold`
        // shipment status was retired in Phase 1d); `held=true` is the signal.
        return { rows: [{ shipment_id: 22, order_id: 33, status: "shipped", held: true, on_hold_reason: "address review" }] };
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
        expect.objectContaining({ shipment_id: 22, held: true }),
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

  it("maps authority health query results to Phase 7 issue buckets", async () => {
    const previousDisableSchedulers = process.env.DISABLE_SCHEDULERS;
    process.env.DISABLE_SCHEDULERS = "true";
    const execute = vi.fn(async (query: any) => {
      const queryText = (query?.queryChunks ?? [])
        .flatMap((chunk: any) => chunk?.value ?? [])
        .join(" ");

      if (
        queryText.includes("LEFT JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id") &&
        queryText.includes("authority_gap")
      ) {
        return { rows: [{ wms_order_item_id: 101, authority_gap: "missing_oms_order_line_id" }] };
      }
      if (
        queryText.includes("LEFT JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id") &&
        queryText.includes("COUNT(*)")
      ) {
        return { rows: [{ count: 1 }] };
      }

      if (queryText.includes("WITH active_materialized") && queryText.includes("over_materialized_quantity")) {
        return { rows: [{ oms_order_line_id: 202, over_materialized_quantity: 1 }] };
      }
      if (
        queryText.includes("WITH active_materialized") &&
        queryText.includes("authority_fulfillable_quantity") &&
        queryText.includes("COUNT(*)")
      ) {
        return { rows: [{ count: 1 }] };
      }

      if (queryText.includes("FROM wms.reconciliation_exceptions") && queryText.includes("GROUP BY rule")) {
        return { rows: [{ rule: "picked_quantity_exceeds_oms_authority", count: 2 }] };
      }
      if (queryText.includes("FROM wms.reconciliation_exceptions") && queryText.includes("COUNT(*)")) {
        return { rows: [{ count: 2 }] };
      }

      if (queryText.includes("duplicate_line_coverage") && queryText.includes("fulfillment_partition_keys")) {
        return {
          rows: [{
            oms_order_line_id: 303,
            wms_order_count: 2,
            fulfillment_partition_keys: ["default", "west"],
          }],
        };
      }
      if (queryText.includes("duplicate_line_coverage") && queryText.includes("COUNT(*)")) {
        return { rows: [{ count: 1 }] };
      }

      if (queryText.includes("provider_reference_drift") && queryText.includes("drift_reason")) {
        return {
          rows: [{
            oms_order_line_id: 404,
            fulfillment_provider: null,
            normalized_fulfillment_provider: null,
            shopify_fulfillment_order_id: "gid://shopify/FulfillmentOrder/1",
            provider_fulfillment_order_id: null,
            drift_reason: "provider_context_missing_or_mismatched",
          }],
        };
      }
      if (queryText.includes("provider_reference_drift") && queryText.includes("COUNT(*)")) {
        return { rows: [{ count: 1 }] };
      }

      return { rows: [{ count: 0 }] };
    });

    try {
      const health = await getOmsOpsHealth({ execute });

      expect(
        health.issues.find((issue) => issue.code === "WMS_ITEM_WITHOUT_OMS_AUTHORITY")?.sample,
      ).toEqual([expect.objectContaining({ authority_gap: "missing_oms_order_line_id" })]);
      expect(
        health.issues.find((issue) => issue.code === "OMS_LINE_AUTHORITY_OVER_MATERIALIZED")?.sample,
      ).toEqual([expect.objectContaining({ over_materialized_quantity: 1 })]);
      expect(
        health.issues.find((issue) => issue.code === "WMS_RECONCILIATION_MANUAL_REVIEW")?.sample,
      ).toEqual([expect.objectContaining({ rule: "picked_quantity_exceeds_oms_authority" })]);
      expect(
        health.issues.find((issue) => issue.code === "WMS_PARTITION_DUPLICATE_LINE_COVERAGE")?.sample,
      ).toEqual([expect.objectContaining({ fulfillment_partition_keys: ["default", "west"] })]);
      expect(
        health.issues.find((issue) => issue.code === "OMS_PROVIDER_FULFILLMENT_REFERENCE_DRIFT")?.sample,
      ).toEqual([expect.objectContaining({ drift_reason: "provider_context_missing_or_mismatched" })]);
    } finally {
      if (previousDisableSchedulers === undefined) {
        delete process.env.DISABLE_SCHEDULERS;
      } else {
        process.env.DISABLE_SCHEDULERS = previousDisableSchedulers;
      }
    }
  });

  it("maps duplicate shipment identity query results to health issues", async () => {
    const previousDisableSchedulers = process.env.DISABLE_SCHEDULERS;
    process.env.DISABLE_SCHEDULERS = "true";
    const execute = vi.fn(async (query: any) => {
      const queryText = (query?.queryChunks ?? [])
        .flatMap((chunk: any) => chunk?.value ?? [])
        .join(" ");

      if (queryText.includes("s.shipstation_order_key") && queryText.includes("shipment_count")) {
        return {
          rows: [{
            shipstation_order_key: "ss-key-1",
            shipment_count: 2,
            shipment_ids: [11, 12],
          }],
        };
      }
      if (queryText.includes("s.shipstation_order_key") && queryText.includes("duplicate_identity")) {
        return { rows: [{ count: 1 }] };
      }

      return { rows: [{ count: 0 }] };
    });

    try {
      const health = await getOmsOpsHealth({ execute });

      expect(
        health.issues.find((issue) => issue.code === "SHIPSTATION_ORDER_KEY_DUPLICATE")?.sample,
      ).toEqual([
        expect.objectContaining({
          shipstation_order_key: "ss-key-1",
          shipment_count: 2,
        }),
      ]);
    } finally {
      if (previousDisableSchedulers === undefined) {
        delete process.env.DISABLE_SCHEDULERS;
      } else {
        process.env.DISABLE_SCHEDULERS = previousDisableSchedulers;
      }
    }
  });
});
