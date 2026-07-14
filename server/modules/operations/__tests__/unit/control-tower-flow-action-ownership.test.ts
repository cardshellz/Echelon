import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const OMS_ORDERS_SOURCE = readFileSync(
  resolve(__dirname, "../../../../../client/src/pages/OmsOrders.tsx"),
  "utf8",
);
const FLOW_MONITOR_SOURCE = readFileSync(
  resolve(__dirname, "../../../../../client/src/pages/FlowMonitor.tsx"),
  "utf8",
);
const OMS_ROUTES_SOURCE = readFileSync(
  resolve(__dirname, "../../../../routes/oms.routes.ts"),
  "utf8",
);
const REPLACEMENT_MIGRATION_SOURCE = readFileSync(
  resolve(__dirname, "../../../../../migrations/137_shipment_replacement_authority.sql"),
  "utf8",
);
const SHIPMENT_ROLLUP_SOURCE = readFileSync(
  resolve(__dirname, "../../../orders/shipment-rollup.ts"),
  "utf8",
);

describe("Control Tower flow action ownership", () => {
  it("keeps cross-system health off the OMS order-list request path", () => {
    expect(OMS_ORDERS_SOURCE).not.toContain('/api/oms/ops/health');
    expect(OMS_ORDERS_SOURCE).not.toContain('OMS/WMS Flow Health');
    expect(OMS_ORDERS_SOURCE).not.toContain('/api/oms/ops/webhook-inbox/');
    expect(OMS_ORDERS_SOURCE).not.toContain('/api/oms/ops/webhook-retry/');
    expect(OMS_ORDERS_SOURCE).toContain('href="/oms/flow-monitor"');
  });

  it("renders replay controls from existing Control Tower evidence", () => {
    expect(FLOW_MONITOR_SOURCE).toContain("resolveFlowReplayAction(selectedIssue, replayStatus");
    expect(FLOW_MONITOR_SOURCE).toContain("replayMutation.mutate(replayAction)");
    expect(FLOW_MONITOR_SOURCE).toContain('hasPermission("operations", "triage")');
  });

  it("shows durable replay outcomes and polls while replay work is pending", () => {
    expect(FLOW_MONITOR_SOURCE).toContain("Recent replay activity");
    expect(FLOW_MONITOR_SOURCE).toContain('item.outcome === "queued" || item.outcome === "retrying"');
    expect(FLOW_MONITOR_SOURCE).toContain("Live {bucketQuery.data?.rows.length.toLocaleString()");
    expect(FLOW_MONITOR_SOURCE).toContain("normally within five minutes");
    expect(OMS_ROUTES_SOURCE).toContain('res.setHeader("Cache-Control", "private, no-store")');
  });

  it("requires the Control Tower triage permission at every replay endpoint", () => {
    expect(OMS_ROUTES_SOURCE).toMatch(
      /webhook-inbox\/:id\/replay"[\s\S]{0,160}requirePermission\("operations", "triage"\)/,
    );
    expect(OMS_ROUTES_SOURCE).toMatch(
      /webhook-retry\/:id\/requeue"[\s\S]{0,160}requirePermission\("operations", "triage"\)/,
    );
    expect(OMS_ROUTES_SOURCE).toMatch(
      /reconciliation\/remediate"[\s\S]{0,160}requirePermission\("operations", "triage"\)/,
    );
  });

  it("offers only verified reship adoption for unmapped physical shipments", () => {
    expect(FLOW_MONITOR_SOURCE).toContain('selectedIssue.code === "UNMAPPED_ENGINE_SPLIT"');
    expect(FLOW_MONITOR_SOURCE).toContain("Adopt as reship");
    expect(FLOW_MONITOR_SOURCE).not.toContain("Match remaining fulfillment");
    expect(FLOW_MONITOR_SOURCE).not.toContain("Ignore duplicate or unused label");
    expect(FLOW_MONITOR_SOURCE).not.toContain("Keep under review");
    expect(FLOW_MONITOR_SOURCE).toContain('hasPermission("inventory", "adjust")');
  });

  it("guards physical-package mutations with triage and inventory permissions", () => {
    expect(OMS_ROUTES_SOURCE).toMatch(
      /shipstation-unmapped\/adopt-reship"[\s\S]{0,180}requirePermission\("operations", "triage"\)/,
    );
    expect(OMS_ROUTES_SOURCE).toContain('hasPermission(userId, "inventory", "adjust")');
    expect(OMS_ROUTES_SOURCE).toContain('error: "Permission denied: inventory:adjust"');
  });

  it("keeps replacement inventory lineage outside customer fulfillment authority", () => {
    expect(REPLACEMENT_MIGRATION_SOURCE).toContain("shipment_purpose");
    expect(REPLACEMENT_MIGRATION_SOURCE).toContain("replaces_shipment_id");
    expect(REPLACEMENT_MIGRATION_SOURCE).toContain("replacement_for_order_item_id");
    expect(REPLACEMENT_MIGRATION_SOURCE).toContain("ON DELETE RESTRICT");
    expect(REPLACEMENT_MIGRATION_SOURCE).toContain(
      "shipment_purpose = 'customer_fulfillment'",
    );
    expect(REPLACEMENT_MIGRATION_SOURCE).toContain(
      "CHECK (order_item_id IS NULL OR replacement_for_order_item_id IS NULL)",
    );
    expect(SHIPMENT_ROLLUP_SOURCE).toContain(
      "COALESCE(shipment_purpose, 'customer_fulfillment') = 'customer_fulfillment'",
    );
  });
});
