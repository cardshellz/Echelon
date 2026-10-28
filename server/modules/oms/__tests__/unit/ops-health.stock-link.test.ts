import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  STOCK_LINK_HEALTH_CHECKS, STOCK_LINK_HEALTH_CHECKS_RUNNER_OFF, stockLinkHealthChecks, stockLinkHealthChecksForProcess,
} from "../../../inventory-planning/stock-link-health";
import {
  STOCK_LINK_HEALTH_ENGINE_ACTOR, STOCK_LINK_HEALTH_ESCALATION, STOCK_LINK_HEALTH_RETIRE_HOLD, STOCK_LINK_HEALTH_RETIRES_HELD_CODE,
  stockLinkRetiresHeldCountText,
} from "../../../inventory-planning/infrastructure/stock-link-health.sql";
import { STOCK_LINK_RETIRES_WITHOUT_REPLACEMENT_SQL } from "../../../inventory-planning/infrastructure/stock-link-checks.repository";
import { STOCK_LINK_ACTOR, STOCK_LINK_DECISION_CODES, STOCK_LINK_RETIRE_HOLD } from "../../../inventory-planning/domain/stock-link";
import { getOmsOpsHealth } from "../../ops-health.service";
import { evaluateOmsOpsAlert } from "../../oms-ops-alert.service";
import { getOperationsControlTower, parseControlTowerFilters } from "../../../operations/control-tower.service";

// Channels PR2 (PLAN-CH2 v4.1 §8): OMS operations health embeds inventory planning's published read-only stock-link
// checks, one count and one sample per issue. The SQL itself runs against PostgreSQL in stock-link.integration.test.ts
// (PG 16).
describe("ops-health :: stock links", () => {
  const dialect = new PgDialect();
  const render = (query: any) => JSON.stringify(dialect.sqlToQuery(query));
  const everyCheck = [...STOCK_LINK_HEALTH_CHECKS, ...STOCK_LINK_HEALTH_CHECKS_RUNNER_OFF];
  const counts = new Map(everyCheck.map((check) => [render(check.countSql), check.code]));
  const samples = new Map(everyCheck.map((check) => [render(check.sampleSql), check.code]));

  function dbWith(countsByCode: Record<string, number>) {
    return {
      execute: vi.fn(async (query: any) => {
        const rendered = render(query);
        const counted = counts.get(rendered);
        if (counted) return { rows: [{ count: countsByCode[counted] ?? 0 }] };
        const sampled = samples.get(rendered);
        if (sampled) return { rows: (countsByCode[sampled] ?? 0) > 0 ? [{ publication_target_id: 5, channel_id: 35 }] : [] };
        return { rows: [{ count: 0 }] };
      }),
    };
  }

  /** DISABLE_SCHEDULERS keeps the in-process scheduler heartbeats out; `stockLinkOff` also turns the runner's own switch on. */
  async function healthWith(countsByCode: Record<string, number>, options: { schedulersOff?: boolean; stockLinkOff?: boolean } = {}) {
    const previous = { schedulers: process.env.DISABLE_SCHEDULERS, stockLink: process.env.STOCK_LINK_AUTO_DISABLED };
    if (options.schedulersOff === false) delete process.env.DISABLE_SCHEDULERS;
    else process.env.DISABLE_SCHEDULERS = "true";
    if (options.stockLinkOff) process.env.STOCK_LINK_AUTO_DISABLED = "true";
    else delete process.env.STOCK_LINK_AUTO_DISABLED;
    const db = dbWith(countsByCode);
    try {
      return { health: await getOmsOpsHealth(db), execute: db.execute };
    } finally {
      if (previous.schedulers === undefined) delete process.env.DISABLE_SCHEDULERS;
      else process.env.DISABLE_SCHEDULERS = previous.schedulers;
      if (previous.stockLink === undefined) delete process.env.STOCK_LINK_AUTO_DISABLED;
      else process.env.STOCK_LINK_AUTO_DISABLED = previous.stockLink;
    }
  }

  it("names the plan's seven issues with their severities; only UNLINKED is info and only STALLED a warning", () => {
    expect(STOCK_LINK_HEALTH_CHECKS.map((check) => [check.code, check.severity])).toEqual([
      ["STOCK_LINK_UNLINKED", "info"],
      ["STOCK_LINK_FLAGGED", "critical"],
      ["STOCK_LINK_ERROR", "critical"],
      ["STOCK_LINK_DESTINATION_PAUSED", "critical"],
      ["STOCK_LINK_RETIRES_HELD", "critical"],
      ["STOCK_LINK_HALTED", "critical"],
      ["STOCK_LINK_STALLED", "warning"],
    ]);
    for (const check of STOCK_LINK_HEALTH_CHECKS) expect(check.message.trim().length, check.code).toBeGreaterThan(0);
  });

  it("keeps its dependency-free literals equal to the engine's constants", () => {
    expect(STOCK_LINK_HEALTH_ENGINE_ACTOR).toBe(STOCK_LINK_ACTOR);
    expect(STOCK_LINK_HEALTH_RETIRE_HOLD).toEqual(STOCK_LINK_RETIRE_HOLD);
    expect(STOCK_LINK_HEALTH_RETIRES_HELD_CODE).toBe(STOCK_LINK_DECISION_CODES.retiresHeld);
    expect(STOCK_LINK_HEALTH_ESCALATION).toEqual({ attempts: 8, transientStreakHours: 72, busyStreakHours: 24 });
  });

  it("raises held retires only while a size's retire is held, and samples the window's count with the engine's own predicate (TST-8, review LNK-3)", () => {
    const held = STOCK_LINK_HEALTH_CHECKS.find((check) => check.code === "STOCK_LINK_RETIRES_HELD")!;
    const text = dialect.sqlToQuery(held.countSql).sql;
    const heldRows = stockLinkRetiresHeldCountText({ publicationTargetId: "d.publication_target_id", now: "now()" });
    expect(text).toContain(`(${heldRows}) > 0`);
    expect(text).not.toContain(">= 25");
    expect(text).toContain("d.auto_link_enabled");
    // The engine's statement with its three parameters, as Ops Health fills the slots.
    const predicate = STOCK_LINK_RETIRES_WITHOUT_REPLACEMENT_SQL
      .replace("$1", "d.publication_target_id").replace("$2", `'${STOCK_LINK_ACTOR}'`)
      .replace("$3", "GREATEST(now() - interval '24 hours', d.retires_released_at)");
    expect(dialect.sqlToQuery(held.sampleSql).sql).toContain(`(${predicate}) AS retires_in_window`);
  });

  it("with the runner's kill switch on, leaves out what a stopped runner can never clear and says linking is off (review CMP-1)", async () => {
    expect(stockLinkHealthChecksForProcess({})).toBe(STOCK_LINK_HEALTH_CHECKS);
    expect(stockLinkHealthChecksForProcess({ STOCK_LINK_AUTO_DISABLED: "true" })).toBe(STOCK_LINK_HEALTH_CHECKS_RUNNER_OFF);
    expect(stockLinkHealthChecksForProcess({ DISABLE_SCHEDULERS: "true" })).toBe(STOCK_LINK_HEALTH_CHECKS_RUNNER_OFF);
    expect(STOCK_LINK_HEALTH_CHECKS_RUNNER_OFF.map((check) => [check.code, check.severity])).toEqual([
      ["STOCK_LINK_UNLINKED", "info"],
      ["STOCK_LINK_FLAGGED", "critical"],
      ["STOCK_LINK_ERROR", "critical"],
      ["STOCK_LINK_RETIRES_HELD", "critical"],
      ["STOCK_LINK_HALTED", "critical"],
      ["STOCK_LINK_RUNNER_OFF", "info"],
    ]);
    const error = STOCK_LINK_HEALTH_CHECKS_RUNNER_OFF.find((check) => check.code === "STOCK_LINK_ERROR")!;
    expect(dialect.sqlToQuery(error.countSql).sql).not.toMatch(/attempt_count|busy_since/);

    const { health, execute } = await healthWith({ STOCK_LINK_DESTINATION_PAUSED: 1, STOCK_LINK_STALLED: 1, STOCK_LINK_RUNNER_OFF: 2 },
      { schedulersOff: false, stockLinkOff: true });
    const rendered = new Set(execute.mock.calls.map(([query]) => render(query)));
    for (const check of STOCK_LINK_HEALTH_CHECKS_RUNNER_OFF) expect(rendered.has(render(check.countSql)), check.code).toBe(true);
    const codes = health.issues.map((entry) => entry.code);
    expect(codes).not.toContain("STOCK_LINK_DESTINATION_PAUSED");
    expect(codes).not.toContain("STOCK_LINK_STALLED");
    expect(health.issues.find((entry) => entry.code === "STOCK_LINK_RUNNER_OFF")).toMatchObject({ severity: "info", count: 2 });
    expect(evaluateOmsOpsAlert(health, Date.now()).criticalIssues.map((entry) => entry.code)).not.toContain("STOCK_LINK_RUNNER_OFF");
  });

  it("compares with the database clock by default and with an injected clock when given one", () => {
    const at = new Date("2026-10-27T12:00:00.000Z");
    const injected = stockLinkHealthChecks({ now: at });
    for (const [index, check] of injected.entries()) {
      const text = dialect.sqlToQuery(check.countSql).sql;
      const base = dialect.sqlToQuery(STOCK_LINK_HEALTH_CHECKS[index]!.countSql).sql;
      expect(text).not.toContain("now()");
      expect(text).toBe(base.replaceAll("now()", "'2026-10-27T12:00:00.000Z'::timestamptz"));
    }
    expect(() => stockLinkHealthChecks({ now: new Date(Number.NaN) })).toThrow();
  });

  it("scopes every check to live Echelon targets under canonical authority", () => {
    for (const check of STOCK_LINK_HEALTH_CHECKS) {
      for (const query of [check.countSql, check.sampleSql]) {
        const text = dialect.sqlToQuery(query).sql;
        expect(text, check.code).toContain("t.state = 'live' AND t.publication_authority = 'echelon'");
        expect(text, check.code).toContain("a.authority = 'canonical'");
      }
    }
  });

  it("runs every check; a flagged size is critical and reaches the alert, a waiting size is info and never does", async () => {
    const { health, execute } = await healthWith({ STOCK_LINK_UNLINKED: 4, STOCK_LINK_FLAGGED: 2, STOCK_LINK_STALLED: 1 },
      { schedulersOff: false });
    const rendered = new Set(execute.mock.calls.map(([query]) => render(query)));
    for (const check of STOCK_LINK_HEALTH_CHECKS) {
      expect(rendered.has(render(check.countSql)), check.code).toBe(true);
      expect(rendered.has(render(check.sampleSql)), check.code).toBe(true);
    }
    expect(health.issues.find((entry) => entry.code === "STOCK_LINK_UNLINKED")).toMatchObject({ severity: "info", count: 4,
      sample: [{ publication_target_id: 5, channel_id: 35 }] });
    expect(health.issues.find((entry) => entry.code === "STOCK_LINK_FLAGGED")).toMatchObject({ severity: "critical", count: 2 });
    expect(health.issues.find((entry) => entry.code === "STOCK_LINK_STALLED")).toMatchObject({ severity: "warning", count: 1 });
    expect(health.status).toBe("critical");
    const alerted = evaluateOmsOpsAlert(health, Date.now()).criticalIssues.map((entry) => entry.code);
    expect(alerted).toContain("STOCK_LINK_FLAGGED");
    expect(alerted).not.toContain("STOCK_LINK_UNLINKED");
    expect(alerted).not.toContain("STOCK_LINK_STALLED");
  });

  it("raises nothing when every count is zero, and only info when sizes are only waiting (status stays healthy)", async () => {
    const codes = new Set(STOCK_LINK_HEALTH_CHECKS.map((check) => check.code));
    expect((await healthWith({})).health.issues.some((entry) => codes.has(entry.code))).toBe(false);
    const waiting = (await healthWith({ STOCK_LINK_UNLINKED: 3 })).health;
    expect(waiting.issues.filter((entry) => codes.has(entry.code)).map((entry) => entry.code)).toEqual(["STOCK_LINK_UNLINKED"]);
    expect(waiting.status).toBe("healthy");
    expect(evaluateOmsOpsAlert(waiting, Date.now()).criticalIssues).toEqual([]);
  });

  it("is listed by Control Tower as an info work item that is open, never blocked (TST-13, P-18)", async () => {
    const previous = process.env.DISABLE_SCHEDULERS;
    process.env.DISABLE_SCHEDULERS = "true";
    try {
      const tower = await getOperationsControlTower({ db: dbWith({ STOCK_LINK_UNLINKED: 3, STOCK_LINK_HALTED: 1 }) as never },
        parseControlTowerFilters({}), { onlyDomain: "oms", includeOverview: false });
      const unlinked = tower.workItems.find((item) => item.code === "STOCK_LINK_UNLINKED");
      expect(unlinked).toMatchObject({ id: "oms:issue:STOCK_LINK_UNLINKED", severity: "info", status: "open", count: 3 });
      expect(tower.workItems.find((item) => item.code === "STOCK_LINK_HALTED")).toMatchObject({ severity: "critical", status: "blocked" });
    } finally {
      if (previous === undefined) delete process.env.DISABLE_SCHEDULERS;
      else process.env.DISABLE_SCHEDULERS = previous;
    }
  });
});
