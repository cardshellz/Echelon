import { describe, expect, it, vi } from "vitest";
import {
  collectOmsFlowReconciliationIssues,
  runOmsFlowReconciliation,
} from "../../oms-flow-reconciliation.service";

function countRows(count: number) {
  return { rows: [{ count }] };
}

function sampleRows(rows: unknown[]) {
  return { rows };
}

describe("oms-flow-reconciliation.service", () => {
  it("returns no issues when every detector is clean", async () => {
    const db = {
      execute: vi.fn(async () => countRows(0)),
    };

    const issues = await collectOmsFlowReconciliationIssues(db);

    expect(issues).toEqual([]);
    expect(db.execute).toHaveBeenCalledTimes(8);
  });

  it("returns critical OMS/WMS and shipment drift issues with samples", async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(countRows(2))
        .mockResolvedValueOnce(sampleRows([{ oms_order_id: 1 }]))
        .mockResolvedValueOnce(countRows(1))
        .mockResolvedValueOnce(sampleRows([{ wms_order_id: 10 }]))
        .mockResolvedValueOnce(countRows(1))
        .mockResolvedValueOnce(sampleRows([{ shipment_id: 20 }]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([])),
    };

    const issues = await collectOmsFlowReconciliationIssues(db);

    expect(issues.map((issue) => issue.code)).toEqual([
      "OMS_FINAL_WMS_ACTIVE",
      "WMS_FINAL_OMS_OPEN",
      "SHIPMENT_SHIPPED_OMS_OPEN",
    ]);
    expect(issues.every((issue) => issue.severity === "critical")).toBe(true);
    expect(issues[0].sample).toEqual([{ oms_order_id: 1 }]);
  });

  it("logs a compact summary when scheduled reconciliation finds issues", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(3))
        .mockResolvedValueOnce(sampleRows([{ shipment_id: 30 }])),
    };

    const issues = await runOmsFlowReconciliation(db);

    expect(issues).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED=3"),
    );
    warn.mockRestore();
  });
});
