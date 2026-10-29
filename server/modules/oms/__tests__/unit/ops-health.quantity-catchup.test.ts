import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { QUANTITY_CATCHUP_HEALTH_CHECKS, quantityCatchupHealthChecks } from "../../../inventory-planning/quantity-catchup-health";
import { getOmsOpsHealth } from "../../ops-health.service";
import { evaluateOmsOpsAlert } from "../../oms-ops-alert.service";

// Channels PR5 (PLAN-CH-v3 section 6 Ops Health): OMS embeds inventory planning's published catch-up checks. The SQL
// runs against PostgreSQL in quantity-publication-catchup-parking.integration.test.ts.
describe("ops-health :: quantity catch-up parking", () => {
  const dialect = new PgDialect();
  const render = (query: any) => JSON.stringify(dialect.sqlToQuery(query));

  it("names the two issues: parked over an hour is a warning, review required is critical", () => {
    expect(QUANTITY_CATCHUP_HEALTH_CHECKS.map(check => [check.code, check.severity])).toEqual([
      ["QUANTITY_CATCHUP_PARKED", "warning"], ["QUANTITY_CATCHUP_REVIEW_REQUIRED", "critical"]]);
    const [parked, review] = QUANTITY_CATCHUP_HEALTH_CHECKS.map(check => dialect.sqlToQuery(check.countSql).sql);
    expect(parked).toContain("c.failure_class = 'parked' AND c.parked_at < now() - interval '1 hours'");
    expect(review).toContain("c.requires_review_at IS NOT NULL");
    for (const text of [parked, review]) expect(text).toContain("c.completed_revision < c.revision");
    const injected = dialect.sqlToQuery(quantityCatchupHealthChecks({ now: new Date("2026-10-29T12:00:00.000Z") })[0].countSql).sql;
    expect(injected).toBe(parked.replaceAll("now()", "'2026-10-29T12:00:00.000Z'::timestamptz"));
    expect(() => quantityCatchupHealthChecks({ now: new Date(Number.NaN) })).toThrow();
  });

  it("runs both checks; review required reaches the alert, parked does not", async () => {
    const counts = new Map(QUANTITY_CATCHUP_HEALTH_CHECKS.map(check => [render(check.countSql), check.code]));
    const byCode: Record<string, number> = { QUANTITY_CATCHUP_PARKED: 3, QUANTITY_CATCHUP_REVIEW_REQUIRED: 1 };
    const db = { execute: vi.fn(async (query: any) => {
      const code = counts.get(render(query));
      return code ? { rows: [{ count: byCode[code] }] } : { rows: [{ count: 0 }] };
    }) };
    const previous = process.env.DISABLE_SCHEDULERS;
    process.env.DISABLE_SCHEDULERS = "true";
    try {
      const health = await getOmsOpsHealth(db);
      expect(health.issues.find(entry => entry.code === "QUANTITY_CATCHUP_PARKED")).toMatchObject({ severity: "warning", count: 3 });
      expect(health.issues.find(entry => entry.code === "QUANTITY_CATCHUP_REVIEW_REQUIRED")).toMatchObject({ severity: "critical", count: 1 });
      const alerted = evaluateOmsOpsAlert(health, Date.now()).criticalIssues.map(entry => entry.code);
      expect(alerted).toContain("QUANTITY_CATCHUP_REVIEW_REQUIRED");
      expect(alerted).not.toContain("QUANTITY_CATCHUP_PARKED");
    } finally {
      if (previous === undefined) delete process.env.DISABLE_SCHEDULERS; else process.env.DISABLE_SCHEDULERS = previous;
    }
  });
});
