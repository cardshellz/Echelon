import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getFlowWaterfall } from "../../flow-waterfall.service";

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

  it("keeps stale tracking detection shipment-scoped", () => {
    const staleBlock = FLOW_WATERFALL_SRC.slice(
      FLOW_WATERFALL_SRC.indexOf('code: "CHANNEL_TRACKING_STALE"'),
      FLOW_WATERFALL_SRC.indexOf("\n  },", FLOW_WATERFALL_SRC.indexOf('code: "CHANNEL_TRACKING_STALE"')),
    );

    expect(staleBlock).toContain("wmsShipmentId");
    expect(staleBlock).toContain("latest_push");
    expect(staleBlock).not.toContain("DISTINCT ON (e.order_id)");
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
