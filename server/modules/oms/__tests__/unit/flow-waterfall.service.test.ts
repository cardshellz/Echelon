import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getFlowBucketSamples, getFlowWaterfall } from "../../flow-waterfall.service";

const FLOW_WATERFALL_SRC = readFileSync(
  resolve(__dirname, "../../flow-waterfall.service.ts"),
  "utf-8",
);

// Pure unit test: a fake db whose .transaction runs the callback with a fake tx
// whose every query returns count 0 — so no database is required (mirrors
// ops-health.service.test.ts). getFlowWaterfall runs entirely inside ONE
// read-only db.transaction, so the fake must provide .transaction, not .execute.
function fakeDb() {
  const execute = async () => ({ rows: [{ count: 0 }] });
  return { transaction: async (fn: (tx: any) => any) => fn({ execute }) };
}

describe("getFlowWaterfall", () => {
  it("composes a read-only funnel view and tags each issue with a funnel stage", async () => {
    const result = await getFlowWaterfall(fakeDb(), { windowDays: 14 });

    expect(result.windowDays).toBe(14);
    expect(typeof result.funnel.entered).toBe("number");
    expect(typeof result.funnel.shipped).toBe("number");
    expect(typeof result.funnel.trackingConfirmed).toBe("number");
    expect(result.channelWriteback).toBeDefined();
    expect(typeof result.channelWriteback.missing).toBe("number");
    expect(Array.isArray(result.issues)).toBe(true);
    expect(result.health).toBeDefined();
    expect(typeof result.health.status).toBe("string");

    // Intake model documents the asymmetry: eBay poll-primary, Shopify webhook-primary.
    const byProvider = Object.fromEntries(result.intakeModel.map((m) => [m.provider, m]));
    expect(byProvider.ebay?.model).toBe("poll-primary");
    expect(byProvider.shopify?.model).toBe("webhook-primary");

    // Every surfaced exception is tagged with the funnel stage it drops out of.
    for (const issue of result.issues) {
      expect(typeof issue.stage).toBe("string");
    }
  });

  it("defaults to a 30-day window when none is provided", async () => {
    const result = await getFlowWaterfall(fakeDb());
    expect(result.windowDays).toBe(30);
  });

  it("keeps ship-by performance outside the technical exception registry", () => {
    expect(FLOW_WATERFALL_SRC).not.toContain('code: "SLA_BREACHED"');
    expect(FLOW_WATERFALL_SRC).toContain("const slaBreached = num");
    expect(FLOW_WATERFALL_SRC).toContain("sla: { breached: slaBreached, sample: [] }");
  });

  it("surfaces paid physical Shopify orders that reached raw intake but not OMS", () => {
    const start = FLOW_WATERFALL_SRC.indexOf('code: "SHOPIFY_RAW_WITHOUT_OMS"');
    const end = FLOW_WATERFALL_SRC.indexOf("\n  },", start);
    const issueBlock = FLOW_WATERFALL_SRC.slice(start, end);

    expect(issueBlock).toContain("shopify_order_bridge_checkpoints");
    expect(issueBlock).toContain("so.created_at < NOW() - INTERVAL '10 minutes'");
    expect(issueBlock).toContain("soi.requires_shipping::text");
    expect(issueBlock).toContain("COALESCE(soi.quantity, 0) > 0");
    expect(issueBlock).toContain("oo.external_order_id IN (so.id, split_part(so.id, '/', -1))");
  });

  it("reports a stale or failed Shopify recovery sweep independently of order gaps", () => {
    const start = FLOW_WATERFALL_SRC.indexOf('code: "SHOPIFY_RECOVERY_UNHEALTHY"');
    const end = FLOW_WATERFALL_SRC.indexOf("\n  },", start);
    const issueBlock = FLOW_WATERFALL_SRC.slice(start, end);

    expect(issueBlock).toContain("last_run_at < NOW() - INTERVAL '30 minutes'");
    expect(issueBlock).toContain("checkpoint.last_error IS NOT NULL");
    expect(issueBlock).toContain("checkpoint.consecutive_failures > 0");
  });

  it("alerts when the Shopify source-to-raw reconciliation checkpoint is stale", () => {
    const start = FLOW_WATERFALL_SRC.indexOf('code: "SHOPIFY_SOURCE_RECONCILIATION_UNHEALTHY"');
    const end = FLOW_WATERFALL_SRC.indexOf("\n  },", start);
    const issueBlock = FLOW_WATERFALL_SRC.slice(start, end);

    expect(issueBlock).toContain("warehouse.echelon_settings");
    expect(issueBlock).toContain("shopify_reconciliation_last_check");
    expect(issueBlock).toContain("MAX(updated_at) < NOW() - INTERVAL '30 minutes'");
  });

  it("does not claim the Shopify recovery sweep is active when disabled", async () => {
    const previous = process.env.SYNC_RECOVERY_SCHEDULER_DISABLED;
    process.env.SYNC_RECOVERY_SCHEDULER_DISABLED = "true";
    try {
      const result = await getFlowWaterfall(fakeDb());
      const shopify = result.intakeModel.find((entry) => entry.provider === "shopify");
      expect(shopify?.note).toContain("recovery sweep is disabled");
    } finally {
      if (previous === undefined) delete process.env.SYNC_RECOVERY_SCHEDULER_DISABLED;
      else process.env.SYNC_RECOVERY_SCHEDULER_DISABLED = previous;
    }
  });

  it("exposes a canonical paid replay source for paid orders missing WMS", () => {
    const start = FLOW_WATERFALL_SRC.indexOf('code: "OMS_PAID_WITHOUT_WMS"');
    const end = FLOW_WATERFALL_SRC.indexOf('\n  },', start);
    const issueBlock = FLOW_WATERFALL_SRC.slice(start, end);

    expect(issueBlock).toContain("oo.id AS oms_order_id");
    expect(issueBlock).toContain("paid_inbox.id AS _replay_source_inbox_id");
    expect(issueBlock).toContain("wi.topic = 'orders/paid'");
    expect(issueBlock).toContain("wi.status = 'succeeded'");
  });

  it("returns durable paid replay activity with the current exception rows", async () => {
    const replay = {
      oms_order_id: "255347",
      order_number: "#60237",
      retry_id: 116708,
      queue_status: "success",
      outcome: "succeeded",
      attempts: 0,
      wms_order_id: 205426,
      warehouse_status: "ready",
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ oms_order_id: "255999" }] })
      .mockResolvedValueOnce({ rows: [replay] });
    const db = { transaction: async (fn: (tx: any) => any) => fn({ execute }) };

    const result = await getFlowBucketSamples(db, "OMS_PAID_WITHOUT_WMS");

    expect(result.rows).toEqual([{ oms_order_id: "255999" }]);
    expect(result.replayActivity).toEqual([replay]);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("derives paid replay outcomes from the audit, queue, and WMS records", () => {
    const activityBlock = FLOW_WATERFALL_SRC.slice(
      FLOW_WATERFALL_SRC.indexOf("async function getPaidReplayActivity"),
      FLOW_WATERFALL_SRC.indexOf("export async function getFlowWaterfall"),
    );

    expect(activityBlock).toContain("flow_reconciliation_remediated");
    expect(activityBlock).toContain("e.details->>'retryQueueId'");
    expect(activityBlock).toContain("q.status = 'pending' AND q.attempts = 0 THEN 'queued'");
    expect(activityBlock).toContain("q.status = 'success' AND wo.id IS NOT NULL THEN 'succeeded'");
    expect(activityBlock).toContain("q.status = 'success' THEN 'unresolved'");
  });

  it("keeps stale tracking detection shipment-scoped", () => {
    const staleBlock = FLOW_WATERFALL_SRC.slice(
      FLOW_WATERFALL_SRC.indexOf('code: "CHANNEL_TRACKING_STALE"'),
      FLOW_WATERFALL_SRC.indexOf("\n  },", FLOW_WATERFALL_SRC.indexOf('code: "CHANNEL_TRACKING_STALE"')),
    );

    expect(staleBlock).toContain("wmsShipmentId");
    expect(staleBlock).toContain("latest_push");
    expect(staleBlock).not.toContain("DISTINCT ON (e.order_id)");
  });

  it("counts only unresolved unmapped physical shipments and deduplicates legacy flags", () => {
    const start = FLOW_WATERFALL_SRC.indexOf('code: "UNMAPPED_ENGINE_SPLIT"');
    const end = FLOW_WATERFALL_SRC.indexOf("\n  },", start);
    const issueBlock = FLOW_WATERFALL_SRC.slice(start, end);

    expect(issueBlock).toContain("COALESCE(os.requires_review, false) = true");
    expect(issueBlock).toContain("SHIPSTATION_LEGACY_UNMAPPED_SPLIT_REASON");
    expect(issueBlock).toContain("SHIPSTATION_UNMAPPED_PHYSICAL_RULE");
    expect(issueBlock).toContain("exception.status IN ('open', 'acknowledged')");
    expect(issueBlock).toContain("exception.classification <> 'historical_ignore'");
    expect(issueBlock).toContain("UNION");
    expect(issueBlock).toContain("PARTITION BY unresolved.entity_key");
    expect(issueBlock).not.toContain("review_reason LIKE '%split_items_unmapped%'");
  });

  it("classifies known production dead-letter signatures without depending on legacy topic names", () => {
    const taxonomyBlock = FLOW_WATERFALL_SRC.slice(
      FLOW_WATERFALL_SRC.indexOf("const DEAD_LETTER_REASON_CODE"),
      FLOW_WATERFALL_SRC.indexOf("const DEAD_LETTER_LABELS"),
    );

    expect(taxonomyBlock).toContain("rq.last_error LIKE '%no items with positive quantity%' THEN 'SHOPIFY_PUSH_NO_POSITIVE_QTY'");
    expect(taxonomyBlock).toContain("rq.last_error LIKE '%no fulfillment-order line item%' THEN 'SHOPIFY_PUSH_SKU_NOT_ON_FO'");
    expect(taxonomyBlock).toContain("rq.last_error LIKE '%fulfillment push returned false%' THEN 'CHANNEL_PUSH_RETURNED_FALSE'");
    expect(taxonomyBlock).toContain("rq.last_error LIKE '%status ''cancelled'' is not pushable%' THEN 'SHIPMENT_NOT_PUSHABLE_CANCELLED'");
    expect(taxonomyBlock).not.toContain("rq.topic = 'shopify_fulfillment_push' AND rq.last_error LIKE '%no items with positive quantity%'");
    expect(taxonomyBlock).not.toContain("rq.topic = 'shopify_fulfillment_push' AND rq.last_error LIKE '%no fulfillment-order line item%'");
  });

  it("counts dead-letter monitor matches as scoped work items inside the selected window", () => {
    const deadLetterBlock = FLOW_WATERFALL_SRC.slice(
      FLOW_WATERFALL_SRC.indexOf("const deadLetterCount"),
      FLOW_WATERFALL_SRC.indexOf("export const FLOW_ISSUES"),
    );
    const groupedPassBlock = FLOW_WATERFALL_SRC.slice(
      FLOW_WATERFALL_SRC.indexOf("const dlRows"),
      FLOW_WATERFALL_SRC.indexOf("const dlMap"),
    );

    expect(deadLetterBlock).toContain("DEAD_LETTER_SCOPE_KEY");
    expect(deadLetterBlock).toContain("DEAD_LETTER_OBSERVED_AT");
    expect(deadLetterBlock).toContain("AND ${DEAD_LETTER_OBSERVED_AT} > ${win}");
    expect(deadLetterBlock).toContain("COUNT(*)::int AS retry_row_count");
    expect(deadLetterBlock).toContain("retry_ids");
    expect(groupedPassBlock).toContain("dead_retry_scopes");
    expect(groupedPassBlock).toContain("GROUP BY 1, 2");
    expect(groupedPassBlock).toContain("FROM dead_retry_scopes");
  });
});
