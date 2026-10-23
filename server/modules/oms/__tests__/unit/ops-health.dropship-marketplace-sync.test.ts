import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS } from "../../../dropship/marketplace-sync-health";
import { getOmsOpsHealth } from "../../ops-health.service";
import { evaluateOmsOpsAlert } from "../../oms-ops-alert.service";

// Dropship eBay sync-back (plan v4 §10): OMS operations health embeds dropship's published read-only
// checks, one count and one sample per issue. The SQL itself runs against PostgreSQL in
// dropship-ebay-sync-back-sweep.integration.test.ts.
describe("ops-health :: Dropship eBay sync-back", () => {
  const dialect = new PgDialect();
  const render = (query: any) => JSON.stringify(dialect.sqlToQuery(query));
  const counts = new Map(DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.map((check) => [render(check.countSql), check.code]));
  const samples = new Map(DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.map((check) => [render(check.sampleSql), check.code]));

  async function healthWith(countsByCode: Record<string, number>) {
    const previous = process.env.DISABLE_SCHEDULERS;
    process.env.DISABLE_SCHEDULERS = "true";
    const execute = vi.fn(async (query: any) => {
      const rendered = render(query);
      const counted = counts.get(rendered);
      if (counted) return { rows: [{ count: countsByCode[counted] ?? 0 }] };
      const sampled = samples.get(rendered);
      if (sampled) return { rows: (countsByCode[sampled] ?? 0) > 0 ? [{ listing_id: 9, store_connection_id: 44 }] : [] };
      return { rows: [{ count: 0 }] };
    });
    try {
      return { health: await getOmsOpsHealth({ execute }), execute };
    } finally {
      if (previous === undefined) delete process.env.DISABLE_SCHEDULERS;
      else process.env.DISABLE_SCHEDULERS = previous;
    }
  }

  it("names the plan's issues, critical for a listing that needs review, a dead-lettered notice and an order a person must decide", () => {
    expect(DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.map((check) => [check.code, check.severity])).toEqual([
      ["DROPSHIP_MARKETPLACE_LISTING_NEEDS_REVIEW", "critical"],
      ["DROPSHIP_LISTING_POLICY_INCOMPATIBLE", "warning"],
      ["DROPSHIP_LISTING_ENDED_OUT_OF_STOCK", "warning"],
      ["DROPSHIP_MARKETPLACE_SYNC_QUANTITY_PENDING", "warning"],
      ["DROPSHIP_LISTING_QUANTITY_RESTORE_BLOCKED", "warning"],
      ["DROPSHIP_MARKETPLACE_SYNC_NOTICE_DEAD_LETTER", "critical"],
      ["DROPSHIP_MARKETPLACE_SYNC_CORRECTION_RATE", "warning"],
      ["DROPSHIP_ORDER_PROCESSING_RETRIES_EXHAUSTED", "critical"],
      ["DROPSHIP_ORDER_MARKETPLACE_CANCEL_REVIEW", "critical"],
      ["DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE", "critical"],
      ["DROPSHIP_ORDER_UNMATCHED_LISTING", "warning"],
    ]);
  });

  it("runs every check, raises a listing that needs review as critical, which reaches the alert, and a warning as a warning", async () => {
    const { health, execute } = await healthWith({ DROPSHIP_MARKETPLACE_LISTING_NEEDS_REVIEW: 2, DROPSHIP_LISTING_QUANTITY_RESTORE_BLOCKED: 5 });
    const rendered = new Set(execute.mock.calls.map(([query]) => render(query)));
    for (const check of DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS) {
      expect(rendered.has(render(check.countSql)), check.code).toBe(true);
      expect(rendered.has(render(check.sampleSql)), check.code).toBe(true);
    }
    expect(health.issues.find((entry) => entry.code === "DROPSHIP_MARKETPLACE_LISTING_NEEDS_REVIEW")).toMatchObject({
      severity: "critical", count: 2, sample: [{ listing_id: 9, store_connection_id: 44 }] });
    expect(health.issues.find((entry) => entry.code === "DROPSHIP_LISTING_QUANTITY_RESTORE_BLOCKED")).toMatchObject({ severity: "warning", count: 5 });
    expect(health.status).toBe("critical");
    expect(evaluateOmsOpsAlert(health, Date.now()).criticalIssues.map((entry) => entry.code)).toContain("DROPSHIP_MARKETPLACE_LISTING_NEEDS_REVIEW");
  });

  it("raises nothing when every count is zero", async () => {
    const { health } = await healthWith({});
    const codes = new Set(DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.map((check) => check.code));
    expect(health.issues.some((entry) => codes.has(entry.code))).toBe(false);
  });
});
