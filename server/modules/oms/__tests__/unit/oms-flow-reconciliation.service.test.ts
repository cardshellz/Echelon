import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  autoCloseResolvedDeadFulfillmentRetries,
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

function canonicalAuthority(ensureLegacyShipment: any) {
  return {
    ensureLegacyShipment,
    recordPhysicalPackage: vi.fn(),
    projectPhysicalPackage: vi.fn(),
    runDueBatch: vi.fn(),
  };
}

function flowDependencies(
  fulfillmentAuthority: any = canonicalAuthority(vi.fn()),
  reservation: any = null,
) {
  return { fulfillmentAuthority, reservation };
}

function completedCanonicalHandoff() {
  return {
    materialized: {
      physicalShipmentId: 90001,
      shippingEngineOrderId: 80001,
      channelCommands: [{ id: 70001, pushStatus: "success" }],
      customerFulfillmentItemCount: 1,
      nonCustomerItemCount: 0,
    },
    dispatch: {
      claimed: 0,
      succeeded: 0,
      ignored: 0,
      retryScheduled: 0,
      reviewRequired: 0,
      deadLettered: 0,
    },
  };
}

describe("oms-flow-reconciliation.service", () => {
  it("returns no issues when every detector is clean", async () => {
    const db = {
      execute: vi.fn(async () => countRows(0)),
    };

    const issues = await collectOmsFlowReconciliationIssues(db);

    expect(issues).toEqual([]);
    expect(db.execute).toHaveBeenCalledTimes(22);
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

  it("uses canonical package evidence rather than the legacy Shopify id as repair authority", () => {
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("getChannelWritebackHealth");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("findChannelWritebackCandidates");
    expect(OMS_FLOW_RECONCILIATION_SRC).not.toContain("NULLIF(os.shopify_fulfillment_id, '') IS NULL");
    expect(OMS_FLOW_RECONCILIATION_SRC).not.toContain(
      "COALESCE(oo.fulfillment_status, 'unfulfilled') <> 'fulfilled'",
    );
  });

  it("surfaces inbound fulfillment receipts that exceed automatic recovery", () => {
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain(
      "CHANNEL_FULFILLMENT_RECEIPT_STALLED",
    );
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain(
      "FROM oms.channel_fulfillment_receipts receipt",
    );
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain(
      "receipt.lease_expires_at < NOW() - INTERVAL '1 hour'",
    );
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("receipt.attempt_count >= 10");
  });

  it("flags active fulfillment partitions that cover the same OMS line", () => {
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("WMS_PARTITION_DUPLICATE_LINE_COVERAGE");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("duplicate_line_coverage");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("wo.fulfillment_partition_key");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("COUNT(DISTINCT wo.id) > 1");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("fulfillment_partition_keys");
  });

  it("flags Shopify fulfillment reference drift from provider-neutral OMS line columns", () => {
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("OMS_PROVIDER_FULFILLMENT_REFERENCE_DRIFT");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("provider_reference_drift");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("provider_reference_rows");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("ol.fulfillment_provider");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("ol.provider_fulfillment_order_id");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("ol.shopify_fulfillment_order_id");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("normalized_fulfillment_provider");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("LOWER(NULLIF(BTRIM(ol.fulfillment_provider), ''))");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("NULLIF(BTRIM(ol.provider_fulfillment_order_id), '')");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("IS DISTINCT FROM");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("provider_context_missing_or_mismatched");
  });

  it("REGRESSION 9dec90c4: the drift sample CTE keeps its FROM clause", () => {
    // The substring assertions above passed even when the sample query's
    // second CTE lost its `FROM provider_reference_rows` (the token still
    // appeared in the WITH definition) — the broken SQL then threw
    // 'column "oms_order_id" does not exist' on EVERY 15-min run and silently
    // killed all auto-remediation for 9+ days (2026-06-28 → 2026-07-07).
    // This asserts the ORDER: every `END AS drift_reason` must be followed by
    // `FROM provider_reference_rows` before its WHERE.
    const driftSelects = OMS_FLOW_RECONCILIATION_SRC.match(
      /END AS drift_reason[\s\S]{0,400}?(FROM provider_reference_rows|WHERE)/g,
    ) ?? [];
    expect(driftSelects.length).toBeGreaterThanOrEqual(1);
    for (const block of driftSelects) {
      expect(block).toContain("FROM provider_reference_rows");
    }
  });

  it("per-step isolation: a throwing detector no longer aborts the remaining steps", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // Every query throws — the pre-2026-07-07 behavior was a rejected promise
    // from the first collect query, which meant autoClose/remediation never ran.
    const db = {
      execute: vi.fn(async () => {
        throw new Error('column "oms_order_id" does not exist');
      }),
    };

    const issues = await runOmsFlowReconciliation(db, flowDependencies());

    // Resolves (not rejects) with no issues…
    expect(issues).toEqual([]);
    // …and execution CONTINUED past the failed collect into later steps
    // (auto-close + reservation remediation each issue their own queries).
    expect(db.execute.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("step 'collect' failed (continuing)"),
    );
    consoleError.mockRestore();
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

    const issues = await runOmsFlowReconciliation(db, flowDependencies());

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

  it("auto-closes dead fulfillment retry rows after later scoped success evidence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = {
      execute: vi.fn(async () => sampleRows([{ id: 108147 }])),
    };

    const closed = await autoCloseResolvedDeadFulfillmentRetries(db);

    expect(closed).toBe(1);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("q.status = 'dead'");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain(
      "q.topic IN ('delayed_tracking_push', 'shopify_fulfillment_push')",
    );
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain(
      "e.created_at >= COALESCE(c.dead_at, c.created_at)",
    );
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("e.details->>'wmsShipmentId'");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("e.details->>'trackingNumber'");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("e.details->>'shopifyFulfillmentId'");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain(
      "last_error = 'auto-closed: later OMS fulfillment/tracking event confirmed success'",
    );
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("SET status = 'success'");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("auto-closed 1 resolved fulfillment/tracking retry"),
    );
    warn.mockRestore();
  });

  it("hands stale eBay writebacks to canonical authority", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inserts: unknown[] = [];
    const ensureLegacyShipment = vi.fn(async () => ({}));
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
    const queuedExecute = db.execute;
    db.execute = vi.fn(async (query: any) => {
      const queryText = (query?.queryChunks ?? [])
        .flatMap((chunk: any) => chunk?.value ?? [])
        .join(" ");
      if (queryText.includes("FROM shipped_channel_shipments")) {
        return {
          rows: [
            { oms_order_id: 10, shipment_id: 30, provider: "ebay", pending_retry: false, dead_retry: false },
            { oms_order_id: 11, shipment_id: 31, provider: "ebay", pending_retry: false, dead_retry: false },
          ],
        };
      }
      return queuedExecute(query);
    });

    const issues = await runOmsFlowReconciliation(
      db,
      flowDependencies(canonicalAuthority(ensureLegacyShipment)),
    );

    expect(issues).toHaveLength(1);
    expect(db.execute).toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(ensureLegacyShipment).toHaveBeenNthCalledWith(1, 30, {
      executeImmediately: false,
      source: "oms_flow_stale_ebay_writeback",
    });
    expect(ensureLegacyShipment).toHaveBeenNthCalledWith(2, 31, {
      executeImmediately: false,
      source: "oms_flow_stale_ebay_writeback",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("handed off 2 stale eBay writeback"),
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
    const issues = await runOmsFlowReconciliation(db, flowDependencies());

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

  it("hands missing Shopify fulfillment writebacks to canonical authority", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inserts: unknown[] = [];
    const ensureLegacyShipment = vi.fn(async () => ({}));
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
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(sampleRows([])),
      insert: vi.fn(() => ({
        values: vi.fn(async (row: unknown) => {
          inserts.push(row);
          return undefined;
        }),
        })),
    };
    const queuedExecute = db.execute;
    db.execute = vi.fn(async (query: any) => {
      const queryText = (query?.queryChunks ?? [])
        .flatMap((chunk: any) => chunk?.value ?? [])
        .join(" ");
      if (queryText.includes("FROM shipped_channel_shipments")) {
        if (queryText.includes("GROUP BY provider")) {
          return {
            rows: [{
              provider: "shopify",
              shipped: 1,
              complete: 0,
              missing: 1,
              masked: 0,
              partial_orders: 0,
              retrying: 0,
              dead: 0,
            }],
          };
        }
        return {
          rows: [
            {
              oms_order_id: 10,
              shipment_id: 1441,
              provider: "shopify",
              pending_retry: false,
              dead_retry: false,
            },
          ],
        };
      }
      return queuedExecute(query);
    });

    const issues = await runOmsFlowReconciliation(
      db,
      flowDependencies(canonicalAuthority(ensureLegacyShipment)),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "SHOPIFY_SHIPMENT_FULFILLMENT_NOT_PUSHED",
      severity: "critical",
    });
    expect(inserts).toHaveLength(0);
    expect(ensureLegacyShipment).toHaveBeenCalledWith(1441, {
      executeImmediately: false,
      source: "oms_flow_missing_shopify_writeback",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("handed off 1 missing Shopify writeback"),
    );
    warn.mockRestore();
  });

  it("leaves replay-after-fix orders for operators while auto-remediating missing shipments", async () => {
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
        // WMS_PARTITION_DUPLICATE_LINE_COVERAGE detector count + sample.
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        // OMS_PROVIDER_FULFILLMENT_REFERENCE_DRIFT detector count + sample.
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        // CHANNEL_FULFILLMENT_RECEIPT_STALLED detector count + sample.
        .mockResolvedValueOnce(countRows(0))
        .mockResolvedValueOnce(sampleRows([]))
        // Auto-close cleanup finds no resolved dead fulfillment/tracking retries.
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

    const issues = await runOmsFlowReconciliation(db, flowDependencies());

    expect(issues.map((issue) => issue.code)).toEqual([
      "OMS_PAID_WITHOUT_WMS",
      "WMS_READY_WITHOUT_SHIPMENT",
    ]);
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as any).topic).toBe("wms_shipment_create");
    expect(warn).not.toHaveBeenCalledWith(
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
    }, flowDependencies());

    expect(result).toMatchObject({
      action: "aligned_wms_from_oms",
      changed: true,
      omsOrderId: 10,
      wmsOrderId: 20,
    });
    expect(tx.execute).toHaveBeenCalledTimes(4);
  });

  it("remediates shipped shipment/OMS-open drift from the shipment row", async () => {
    const ensureLegacyShipment = vi.fn(async () => completedCanonicalHandoff());
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(sampleRows([{ wms_order_id: 20, oms_status: "confirmed" }]))
        .mockResolvedValueOnce(sampleRows([])),
    };
    const authority = canonicalAuthority(ensureLegacyShipment);

    const result = await remediateOmsFlowIssue(db, {
      code: "SHIPMENT_SHIPPED_OMS_OPEN",
      omsOrderId: 10,
      shipmentId: 30,
      operator: "ops",
    }, flowDependencies(authority));

    expect(result).toMatchObject({
      action: "handed_off_canonical_shipment",
      changed: true,
      omsOrderId: 10,
      wmsOrderId: 20,
      shipmentId: 30,
    });
    expect(ensureLegacyShipment).toHaveBeenCalledWith(30, {
      executeImmediately: true,
      source: "oms_flow_reconcile_shipped_package",
    });
  });

  it("hands shipment-scoped tracking remediation to canonical authority", async () => {
    const ensureLegacyShipment = vi.fn(async () => ({}));
    const db = {};
    const authority = canonicalAuthority(ensureLegacyShipment);

    const result = await remediateOmsFlowIssue(db, {
      code: "WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
      omsOrderId: 10,
      wmsOrderId: 20,
      shipmentId: 30,
      operator: "ops",
    }, flowDependencies(authority));

    expect(result).toMatchObject({
      action: "handed_off_channel_fulfillment",
      changed: true,
      omsOrderId: 10,
      wmsOrderId: 20,
      shipmentId: 30,
    });
    expect(ensureLegacyShipment).toHaveBeenCalledWith(30, {
      executeImmediately: false,
      source: "oms_flow_operator_remediation:WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
    });
  });

  it("expands OMS-level tracking remediation into exact shipped packages", async () => {
    const ensureLegacyShipment = vi.fn(async () => completedCanonicalHandoff());
    const db = {
      execute: vi.fn(async () => ({ rows: [{ shipment_id: 30 }] })),
    };
    const authority = canonicalAuthority(ensureLegacyShipment);

    const result = await remediateOmsFlowIssue(db, {
      code: "SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
      omsOrderId: 10,
      operator: "ops",
    }, flowDependencies(authority));

    expect(result).toMatchObject({
      action: "handed_off_channel_fulfillment",
      changed: true,
      omsOrderId: 10,
      wmsOrderId: null,
      shipmentId: null,
    });
    expect(ensureLegacyShipment).toHaveBeenCalledWith(30, {
      executeImmediately: false,
      source: "oms_flow_operator_remediation:SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
    });
  });

  it("queues the canonical succeeded orders/paid event instead of a no-op WMS sync", async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(sampleRows([{ id: 10, paid_inbox_id: 79377 }]))
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(sampleRows([{ id: 901 }]))
        .mockResolvedValueOnce(sampleRows([])),
    };
    const db = {
      transaction: vi.fn(async (fn: (inner: any) => Promise<unknown>) => fn(tx)),
    };

    const result = await remediateOmsFlowIssue(db, {
      code: "OMS_PAID_WITHOUT_WMS",
      omsOrderId: 10,
      operator: "ops",
    }, flowDependencies());

    expect(result).toMatchObject({
      action: "queued_orders_paid_replay",
      changed: true,
      omsOrderId: 10,
      wmsOrderId: null,
      retryQueueId: 901,
      sourceInboxId: 79377,
      provider: "shopify",
      topic: "orders/paid",
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(5);
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("hashtext('oms_paid_without_wms_replay')");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("wi.topic = 'orders/paid'");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("SELECT wi.provider");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("wi.payload");
    expect(OMS_FLOW_RECONCILIATION_SRC).toContain("source_inbox_id");
    expect(OMS_FLOW_RECONCILIATION_SRC).not.toContain("enqueueOmsWmsSyncRetry");
    expect(OMS_FLOW_RECONCILIATION_SRC).not.toContain("queued_oms_wms_sync");
  });

  it("returns the existing pending paid replay instead of enqueuing a duplicate", async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(sampleRows([{ id: 10, paid_inbox_id: 79377 }]))
        .mockResolvedValueOnce(sampleRows([{ id: 901 }])),
    };
    const db = {
      transaction: vi.fn(async (fn: (inner: any) => Promise<unknown>) => fn(tx)),
    };

    const result = await remediateOmsFlowIssue(db, {
      code: "OMS_PAID_WITHOUT_WMS",
      omsOrderId: 10,
      operator: "ops",
    }, flowDependencies());

    expect(result).toMatchObject({
      action: "orders_paid_replay_already_pending",
      changed: false,
      retryQueueId: 901,
      sourceInboxId: 79377,
    });
    expect(tx.execute).toHaveBeenCalledTimes(3);
  });

  it("rejects paid replay when no canonical succeeded paid event exists", async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(sampleRows([]))
        .mockResolvedValueOnce(sampleRows([{ id: 10, paid_inbox_id: null }])),
    };
    const db = {
      transaction: vi.fn(async (fn: (inner: any) => Promise<unknown>) => fn(tx)),
    };

    await expect(remediateOmsFlowIssue(db, {
      code: "OMS_PAID_WITHOUT_WMS",
      omsOrderId: 10,
      operator: "ops",
    }, flowDependencies())).rejects.toThrow(/No succeeded Shopify orders\/paid inbox event/);
    expect(tx.execute).toHaveBeenCalledTimes(2);
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
    }, flowDependencies());

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
        // Remediation SELECT + duplicate retry check + requires_review guard + audit event.
        .mockResolvedValueOnce(sampleRows([{ id: 30, wms_order_id: 20, oms_order_id: "10" }]))
        .mockResolvedValueOnce(sampleRows([]))
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
    }, flowDependencies());

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
    expect(db.execute).toHaveBeenCalledTimes(4);
  });

  it("rejects unsupported remediation codes", async () => {
    await expect(remediateOmsFlowIssue({ execute: vi.fn() }, {
      code: "NOPE",
      operator: "ops",
    }, flowDependencies())).rejects.toThrow(/Unsupported OMS flow remediation code/);
  });
});
