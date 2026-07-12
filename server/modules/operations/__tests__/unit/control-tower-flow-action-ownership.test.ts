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

describe("Control Tower flow action ownership", () => {
  it("keeps cross-system health off the OMS order-list request path", () => {
    expect(OMS_ORDERS_SOURCE).not.toContain('/api/oms/ops/health');
    expect(OMS_ORDERS_SOURCE).not.toContain('OMS/WMS Flow Health');
    expect(OMS_ORDERS_SOURCE).not.toContain('/api/oms/ops/webhook-inbox/');
    expect(OMS_ORDERS_SOURCE).not.toContain('/api/oms/ops/webhook-retry/');
    expect(OMS_ORDERS_SOURCE).toContain('href="/oms/flow-monitor"');
  });

  it("renders replay controls from existing Control Tower evidence", () => {
    expect(FLOW_MONITOR_SOURCE).toContain("resolveFlowReplayAction(selectedIssue, row)");
    expect(FLOW_MONITOR_SOURCE).toContain("replayMutation.mutate(replayAction)");
    expect(FLOW_MONITOR_SOURCE).toContain('hasPermission("operations", "triage")');
  });

  it("requires the Control Tower triage permission at both replay endpoints", () => {
    expect(OMS_ROUTES_SOURCE).toMatch(
      /webhook-inbox\/:id\/replay"[\s\S]{0,160}requirePermission\("operations", "triage"\)/,
    );
    expect(OMS_ROUTES_SOURCE).toMatch(
      /webhook-retry\/:id\/requeue"[\s\S]{0,160}requirePermission\("operations", "triage"\)/,
    );
  });
});
