import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectOmsFlowReconciliationIssues,
  remediateOmsFlowIssue,
  runOmsFlowReconciliation,
} from "../../oms-flow-reconciliation.service";

const OMS_FLOW_RECONCILIATION_SRC = readFileSync(
  resolve(__dirname, "../../oms-flow-reconciliation.service.ts"),
  "utf-8",
);

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
    expect(db.execute).toHaveBeenCalledTimes(16);
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
        .mockResolvedValueOnce(sampleRows([]))
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

  it("returns critical missing bridge issues with samples", async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(1))
        .mockResolvedValueOnce(sampleRows([{ oms_order_id: 10 }]))
        .mockResolvedValueOnce(countRows(1))
        .mockResolvedValueOnce(sampleRows([{ wms_order_id: 20 }]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([])),
    };

    const issues = await collectOmsFlowReconciliationIssues(db);

    expect(issues.map((issue) => issue.code)).toEqual([
      "OMS_PAID_WITHOUT_WMS",
      "WMS_READY_WITHOUT_SHIPMENT",
    ]);
    expect(issues.every((issue) => issue.severity === "critical")).toBe(true);
  });

  it("treats voided-only outbound shipments as missing shipment work", () => {
    expect(OMS_FLOW_RECONCILIATION_SRC).toMatch(
      /WHERE os\.order_id = wo\.id\s+AND os\.status <> 'voided'/,
    );
  });

  it("does not queue Shopify fulfillment repair for orders OMS already considers fulfilled", () => {
    const fulfillmentStatusGuards = OMS_FLOW_RECONCILIATION_SRC.match(
      /COALESCE\(oo\.fulfillment_status, 'unfulfilled'\) <> 'fulfilled'/g,
    ) ?? [];

    expect(fulfillmentStatusGuards.length).toBeGreaterThanOrEqual(2);
  });

  it("treats refunded OMS financial status as final for WMS reconciliation", () => {
    const refundedFinancialStatusGuards = OMS_FLOW_RECONCILIATION_SRC.match(
      /oo\.financial_status = 'refunded'/g,
    ) ?? [];

    expect(refundedFinancialStatusGuards.length).toBeGreaterThanOrEqual(5);
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
        .mockResolvedValueOnce(sampleRows([{ shipment_id: 30 }]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([])),
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
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
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
    expect(db.execute).toHaveBeenCalledTimes(20);
    expect(inserts).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("auto-queued 2 delayed tracking push retry"),
    );
    warn.mockRestore();
  });

  it("auto-queues ShipStation push retries when scheduled reconciliation finds unpushed shipments", async () => {
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
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(1))
        .mockResolvedValueOnce(sampleRows([{ shipment_id: 482, order_number: "#57067" }]))
        .mockResolvedValueOnce(sampleRows([])),
      insert: vi.fn(() => ({
        values: vi.fn(async (row: unknown) => {
          inserts.push(row);
          return undefined;
        }),
      })),
    };

    const issues = await runOmsFlowReconciliation(db);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION",
      severity: "critical",
    });
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as any).topic).toBe("shipstation_shipment_push");
    expect((inserts[0] as any).payload).toEqual({ shipmentId: 482 });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("auto-queued 1 ShipStation shipment push retry"),
    );
    warn.mockRestore();
  });

  it("auto-queues Shopify fulfillment retries when shipped Shopify shipments have no fulfillment id", async () => {
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
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(1))
        .mockResolvedValueOnce(sampleRows([{ shipment_id: 1441, order_number: "#57743" }]))
        .mockResolvedValueOnce(sampleRows([])),
      insert: vi.fn(() => ({
        values: vi.fn(async (row: unknown) => {
          inserts.push(row);
          return undefined;
        }),
      })),
    };

    const issues = await runOmsFlowReconciliation(db);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "SHOPIFY_SHIPMENT_FULFILLMENT_NOT_PUSHED",
      severity: "critical",
    });
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as any).topic).toBe("shopify_fulfillment_push");
    expect((inserts[0] as any).payload).toEqual({ shipmentId: 1441 });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("auto-queued 1 Shopify fulfillment push retry"),
    );
    warn.mockRestore();
  });

  it("auto-remediates missing WMS and missing shipment bridge issues through retry rows", async () => {
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
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(1))
        .mockResolvedValueOnce(sampleRows([{ oms_order_id: 10 }]))
        .mockResolvedValueOnce(countRows(1))
        .mockResolvedValueOnce(sampleRows([{ wms_order_id: 20 }]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        // OMS_PAID_WITHOUT_WMS remediation SELECT + duplicate retry check + audit event.
        .mockResolvedValueOnce(sampleRows([{ id: 10 }]))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(sampleRows([]))
        // WMS_READY_WITHOUT_SHIPMENT remediation SELECT + duplicate retry check + audit event.
        .mockResolvedValueOnce(sampleRows([{ id: 20, oms_order_id: "10" }]))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(sampleRows([])),
      insert: vi.fn(() => ({
        values: vi.fn(async (row: unknown) => {
          inserts.push(row);
          return undefined;
        }),
      })),
    };

    const issues = await runOmsFlowReconciliation(db);

    expect(issues.map((issue) => issue.code)).toEqual([
      "OMS_PAID_WITHOUT_WMS",
      "WMS_READY_WITHOUT_SHIPMENT",
    ]);
    expect(inserts).toHaveLength(2);
    expect((inserts[0] as any).topic).toBe("oms_wms_sync");
    expect((inserts[1] as any).topic).toBe("wms_shipment_create");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("auto-remediated 1 OMS_PAID_WITHOUT_WMS row"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("auto-remediated 1 WMS_READY_WITHOUT_SHIPMENT row"),
    );
    warn.mockRestore();
  });

  it("remediates OMS-final/WMS-active drift and writes an audit event", async () => {
    const tx = {
      execute: vi
        .fn()
        // 1. SELECT oms status join
        .mockResolvedValueOnce(sampleRows([{ status: "cancelled", financial_status: null }]))
        // 2. C4 transitionOrderStatus UPDATE
        .mockResolvedValueOnce(sampleRows([{ new_status: "cancelled" }]))
        // 3. UPDATE assigned_picker_id = NULL
        .mockResolvedValueOnce(sampleRows([]))
        // 4. INSERT oms_order_events
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
    expect(tx.execute).toHaveBeenCalledTimes(4);
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

  it("queues OMS-level shipped tracking push remediation through the retry queue", async () => {
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(async () => undefined),
      })),
    };

    const result = await remediateOmsFlowIssue(db, {
      code: "SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
      omsOrderId: 10,
      operator: "ops",
    });

    expect(result).toMatchObject({
      action: "queued_tracking_push",
      changed: true,
      omsOrderId: 10,
      wmsOrderId: null,
      shipmentId: null,
    });
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("queues OMS to WMS sync remediation through the retry queue", async () => {
    const inserts: unknown[] = [];
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(sampleRows([{ id: 10 }]))
        .mockResolvedValueOnce(sampleRows([])),
      insert: vi.fn(() => ({
        values: vi.fn(async (row: unknown) => {
          inserts.push(row);
          return undefined;
        }),
      })),
    };

    const result = await remediateOmsFlowIssue(db, {
      code: "OMS_PAID_WITHOUT_WMS",
      omsOrderId: 10,
      operator: "ops",
    });

    expect(result).toMatchObject({
      action: "queued_oms_wms_sync",
      changed: true,
      omsOrderId: 10,
      wmsOrderId: null,
    });
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as any).topic).toBe("oms_wms_sync");
    expect((inserts[0] as any).payload).toEqual({ omsOrderId: 10 });
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  it("queues WMS shipment creation remediation through the retry queue", async () => {
    const inserts: unknown[] = [];
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(sampleRows([{ id: 20, oms_order_id: "10" }]))
        .mockResolvedValueOnce(sampleRows([])),
      insert: vi.fn(() => ({
        values: vi.fn(async (row: unknown) => {
          inserts.push(row);
          return undefined;
        }),
      })),
    };

    const result = await remediateOmsFlowIssue(db, {
      code: "WMS_READY_WITHOUT_SHIPMENT",
      wmsOrderId: 20,
      operator: "ops",
    });

    expect(result).toMatchObject({
      action: "queued_wms_shipment_create",
      changed: true,
      omsOrderId: 10,
      wmsOrderId: 20,
    });
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as any).topic).toBe("wms_shipment_create");
    expect((inserts[0] as any).payload).toEqual({ wmsOrderId: 20 });
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  it("queues ShipStation shipment push remediation through the retry queue", async () => {
    const inserts: unknown[] = [];
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(sampleRows([{ id: 30, wms_order_id: 20, oms_order_id: "10" }]))
        .mockResolvedValueOnce(sampleRows([]))
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
      omsOrderId: 10,
      wmsOrderId: 20,
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
    expect((inserts[0] as any).payload).toEqual({ shipmentId: 30 });
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  it("rejects unsupported remediation codes", async () => {
    await expect(remediateOmsFlowIssue({ execute: vi.fn() }, {
      code: "NOPE",
      operator: "ops",
    })).rejects.toThrow(/Unsupported OMS flow remediation code/);
  });
});
