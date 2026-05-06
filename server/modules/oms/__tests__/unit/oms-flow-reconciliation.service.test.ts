import { describe, expect, it, vi } from "vitest";
import {
  collectOmsFlowReconciliationIssues,
  remediateOmsFlowIssue,
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
    expect(issues[0]).toMatchObject({
      code: "WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
      severity: "critical",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED=3"),
    );
    warn.mockRestore();
  });

  it("auto-queues stale tracking push retries when scheduled reconciliation finds shipped unpushed shipments", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inserts: unknown[] = [];
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(2))
        .mockResolvedValueOnce(sampleRows([
          { oms_order_id: 10, shipment_id: 30 },
          { oms_order_id: 11, shipment_id: 31 },
        ]))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(sampleRows([{ id: 99 }])),
      insert: vi.fn(() => ({
        values: vi.fn(async (row: unknown) => {
          inserts.push(row);
          return undefined;
        }),
      })),
    };

    const issues = await runOmsFlowReconciliation(db);

    expect(issues).toHaveLength(1);
    expect(db.execute).toHaveBeenCalledTimes(10);
    expect(inserts).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("auto-queued 1 delayed tracking push retry"),
    );
    warn.mockRestore();
  });

  it("remediates OMS-final/WMS-active drift and writes an audit event", async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(sampleRows([{ id: 20 }]))
        .mockResolvedValueOnce(sampleRows([])),
    };
    const db = {
      transaction: vi.fn(async (fn) => fn(tx)),
    };

    const result = await remediateOmsFlowIssue(db, {
      code: "OMS_FINAL_WMS_ACTIVE",
      omsOrderId: 10,
      wmsOrderId: 20,
      operator: "ops",
    });

    expect(result).toMatchObject({
      action: "aligned_wms_from_oms",
      changed: true,
      omsOrderId: 10,
      wmsOrderId: 20,
    });
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });

  it("remediates shipped shipment/OMS-open drift from the shipment row", async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(sampleRows([{ id: 10, wms_order_id: 20 }]))
        .mockResolvedValueOnce(sampleRows([])),
    };
    const db = {
      transaction: vi.fn(async (fn) => fn(tx)),
    };

    const result = await remediateOmsFlowIssue(db, {
      code: "SHIPMENT_SHIPPED_OMS_OPEN",
      omsOrderId: 10,
      shipmentId: 30,
      operator: "ops",
    });

    expect(result).toMatchObject({
      action: "marked_oms_shipped_from_wms_shipment",
      changed: true,
      omsOrderId: 10,
      wmsOrderId: 20,
      shipmentId: 30,
    });
  });

  it("queues tracking push remediation through the retry queue", async () => {
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(async () => undefined),
      })),
    };

    const result = await remediateOmsFlowIssue(db, {
      code: "WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
      omsOrderId: 10,
      wmsOrderId: 20,
      shipmentId: 30,
      operator: "ops",
    });

    expect(result).toMatchObject({
      action: "queued_tracking_push",
      changed: true,
      omsOrderId: 10,
      wmsOrderId: 20,
      shipmentId: 30,
    });
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("queues ShipStation shipment push remediation through the retry queue", async () => {
    const inserts: unknown[] = [];
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(sampleRows([{
          shipment_id: 30,
          wms_order_id: 20,
          oms_order_id: 10,
        }]))
        .mockResolvedValueOnce(sampleRows([])),
      insert: vi.fn(() => ({
        values: vi.fn(async (row: unknown) => {
          inserts.push(row);
          return undefined;
        }),
      })),
    };

    const result = await remediateOmsFlowIssue(db, {
      code: "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION",
      shipmentId: 30,
      operator: "ops",
    });

    expect(result).toMatchObject({
      action: "queued_shipstation_shipment_push",
      changed: true,
      omsOrderId: 10,
      wmsOrderId: 20,
      shipmentId: 30,
    });
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as any).topic).toBe("shipstation_shipment_push");
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported remediation codes", async () => {
    await expect(remediateOmsFlowIssue({ execute: vi.fn() }, {
      code: "NOPE",
      operator: "ops",
    })).rejects.toThrow(/Unsupported OMS flow remediation code/);
  });
});
