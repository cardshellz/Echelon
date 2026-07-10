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
});
