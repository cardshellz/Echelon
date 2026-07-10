import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../oms/ops-health.service", () => ({
  getOmsOpsHealth: vi.fn(),
}));
vi.mock("../../oms/flow-waterfall.service", () => ({
  getFlowBucketSamples: vi.fn(),
  getFlowWaterfall: vi.fn(),
}));
vi.mock("../../oms/oms-flow-reconciliation.service", () => ({
  remediateOmsFlowIssue: vi.fn(),
}));
vi.mock("../../procurement/procurement-health-summary.service", () => ({
  loadProcurementHealthSummary: vi.fn(),
}));

import { getFlowBucketSamples, getFlowWaterfall } from "../../oms/flow-waterfall.service";
import { getOmsOpsHealth } from "../../oms/ops-health.service";
import { remediateOmsFlowIssue } from "../../oms/oms-flow-reconciliation.service";
import {
  executeOperationsControlTowerAction,
  getOperationsControlTower,
  parseControlTowerFilters,
} from "../control-tower.service";

const omsHealth = {
  generatedAt: "2026-07-10T12:00:00.000Z",
  status: "critical" as const,
  workers: {},
  counts: { critical: 1, warning: 0, info: 0 },
  issues: [{
    code: "OMS_PAID_WITHOUT_WMS",
    severity: "critical" as const,
    count: 1,
    message: "Paid OMS order has no WMS order",
    sample: [{ oms_order_id: 42, order_number: "#1234" }],
  }],
  channelWriteback: {},
};

function fakeDb() {
  return { execute: vi.fn(async () => ({ rows: [] })) };
}

describe("operations control tower service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOmsOpsHealth).mockResolvedValue(omsHealth as any);
    vi.mocked(getFlowBucketSamples).mockResolvedValue({ rows: [{ oms_order_id: 42, order_number: "#1234" }] } as any);
    vi.mocked(getFlowWaterfall).mockResolvedValue({
      funnel: { entered: 1, reachedWms: 1, hasShipment: 1, shipped: 0, trackingConfirmed: 0 },
      wmsBuckets: [],
      deadLetterCauses: [],
      crossSystem: { wmsShippedOmsOpen: 0, omsNotUpdated: 0 },
      sla: { breached: 0 },
    } as any);
    vi.mocked(remediateOmsFlowIssue).mockResolvedValue({
      code: "OMS_PAID_WITHOUT_WMS",
      action: "queued_oms_wms_sync",
      changed: true,
      omsOrderId: 42,
      wmsOrderId: null,
      shipmentId: null,
    });
  });

  it("normalizes invalid query input to bounded safe defaults", () => {
    expect(parseControlTowerFilters({
      domain: "not-a-domain",
      severity: "unknown",
      status: "unknown",
      limit: "9999",
    })).toEqual({
      domain: "all",
      severity: "all",
      status: "all",
      search: "",
      limit: 250,
    });
  });

  it("orders critical work ahead of warnings and exposes domain evidence", async () => {
    const response = await getOperationsControlTower({
      db: fakeDb(),
      operationsDashboard: {
        getPickReplenHealth: vi.fn().mockResolvedValue({
          total: 1,
          items: [{
            id: "pick_bin_needs_replen-7",
            type: "pick_bin_needs_replen",
            priority: 3,
            sku: "SKU-1",
            detail: "Pick bin needs replenishment",
            action: "queue_replen",
            variantId: 10,
            locationId: 11,
          }],
        }),
      },
      replenishment: undefined,
      canViewProcurement: false,
    }, parseControlTowerFilters({ limit: 25 }));

    expect(response.status).toBe("critical");
    expect(response.workItems[0]?.domain).toBe("oms");
    expect(response.summary.byDomain.oms).toBe(1);
    expect(response.summary.byDomain.wms).toBe(1);
    expect(response.workItems.find((item) => item.domain === "wms")?.actions.some((action) => action.id === "execute" && !action.enabled)).toBe(true);
  });

  it("delegates OMS remediation only after loading the concrete live record", async () => {
    const deps = {
      db: fakeDb(),
      canViewProcurement: false,
      operationsDashboard: {
        getPickReplenHealth: vi.fn().mockResolvedValue({ total: 0, items: [] }),
      },
    };

    const result = await executeOperationsControlTowerAction({
      deps,
      id: "oms:issue:OMS_PAID_WITHOUT_WMS",
      actionId: "remediate",
      record: { oms_order_id: 42, order_number: "#1234" },
      operator: "admin@example.com",
    });

    expect(result).toMatchObject({ changed: true, omsOrderId: 42 });
    expect(remediateOmsFlowIssue).toHaveBeenCalledWith(deps.db, {
      code: "OMS_PAID_WITHOUT_WMS",
      omsOrderId: 42,
      operator: "admin@example.com",
    });
  });
});
