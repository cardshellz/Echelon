import { describe, expect, it, vi } from "vitest";
import {
  DropshipFinanceService,
  type DropshipFinanceLogger,
  type DropshipFinanceRepository,
  type FinanceStatementOutcome,
  type FinanceSummaryRead,
  type FinanceSummaryReadRequest,
} from "../../application/dropship-finance-service";
import { DropshipError } from "../../domain/errors";
import type { FinanceRawAggregates } from "../../domain/program-finance-raw";
import {
  FINANCE_FIXTURE_NOW,
  fixtureRaw,
  lastMonthRaw,
  ok,
  vendor12Raw,
} from "../fixtures/program-finance-raw.fixture";

const b = (value: number | string) => BigInt(value);

interface Harness {
  service: DropshipFinanceService;
  requests: FinanceSummaryReadRequest[];
  logger: { [K in keyof DropshipFinanceLogger]: ReturnType<typeof vi.fn> };
}

/** `stepMs`: how far the clock moves on each reading after the first, so a request lasts that long. */
function harness(
  read: (request: FinanceSummaryReadRequest) => FinanceSummaryRead | Promise<FinanceSummaryRead>,
  now = FINANCE_FIXTURE_NOW,
  stepMs = 0,
): Harness {
  const requests: FinanceSummaryReadRequest[] = [];
  const repository: DropshipFinanceRepository = {
    readSummary: vi.fn(async (request) => {
      requests.push(request);
      return read(request);
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let readings = 0;
  const clock = { now: () => new Date(now.getTime() + stepMs * readings++) };
  const service = new DropshipFinanceService({ repository, clock, logger });
  return { service, requests, logger };
}

const read = (raw: FinanceRawAggregates, statements: FinanceStatementOutcome[] = [], vendor: FinanceSummaryRead["vendor"] = null): FinanceSummaryRead =>
  ({ raw, vendor, statements });

const actor = { actorId: "staff-7" };

/** The §6.4 program with no comparison window (compare off, or all time). */
function withoutCompare(raw: FinanceRawAggregates): FinanceRawAggregates {
  return { ...raw, compareOrders: null, bounds: { ...raw.bounds, compareStartAt: null, compareEndAt: null } };
}

describe("DropshipFinanceService.getSummary", () => {
  it("resolves this month so far with the injected clock and builds the §6.4 summary", async () => {
    const h = harness(() => read(fixtureRaw()));
    const summary = await h.service.getSummary({}, actor);

    const [request] = h.requests;
    expect(request.now).toEqual(FINANCE_FIXTURE_NOW);
    expect(request.vendorId).toBeNull();
    expect(request.period).toMatchObject({ preset: "mtd", fromDate: "2026-10-01", toDate: "2026-10-05", endsNow: true });
    expect(request.comparePeriod).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-05", endsNow: false });
    expect(summary.generatedAt).toBe(FINANCE_FIXTURE_NOW.toISOString());
    expect(summary.answer).toMatchObject({
      state: "kept", orders: 10, billed: 18_730, keptOnOrders: 3_881, feesCharged: 760, returnCreditsPaid: 2_000,
      kept: { amount: 2_641, status: "recorded" }, marginTenths: 399, priorMarginTenths: 404, marginChangeTenths: -5,
    });
    expect(summary.tiles.cashReceived.amount).toBe(88_300);
    expect(summary.tiles.weOweNow).toMatchObject({ amount: 381_110, onTheWay: 19_000 });
    expect(summary.checks.filter((check) => check.result === "needs_a_look").map((check) => check.id)).toEqual(["D6", "K2", "N1", "N2"]);
  });

  it("logs one INFO line per summary with statuses and checks, and no money values", async () => {
    const h = harness(() => read(fixtureRaw(), [{ name: "orders", status: "ok", durationMs: 4 }]));
    await h.service.getSummary({ period: "mtd" }, actor);

    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.logger.info).toHaveBeenCalledTimes(1);
    const [action, entry] = h.logger.info.mock.calls[0];
    expect(action).toBe("dropship.finance.summary_served");
    expect(entry).toMatchObject({
      outcome: "served", actor_id: "staff-7", vendor_id: null, period_preset: "mtd", period_from: "2026-10-01", period_to: "2026-10-05",
      compare: true, generated_at: FINANCE_FIXTURE_NOW.toISOString(), checks_needing_look: ["D6", "K2", "N1", "N2"], statements: 1,
    });
    expect(entry.section_statuses).toMatchObject({ answer: "ok", sales: "ok", vendors: "ok" });
    const logged = JSON.stringify(entry);
    for (const money of ["18730", "2641", "381110", "88300"]) expect(logged).not.toContain(money);
  });

  it("passes the vendor scope down and names the vendor from its record", async () => {
    const h = harness(() => read(vendor12Raw(), [], { vendorId: 12, businessName: "Acme TCG", contactName: "Ada" }));
    const summary = await h.service.getSummary({ vendorId: "12" }, actor);

    expect(h.requests[0].vendorId).toBe(12);
    expect(summary.scope.vendor).toEqual({ vendorId: 12, name: "Acme TCG", nameSource: "business_name" });
    expect(summary.answer).toMatchObject({ billed: 11_730, keptOnOrders: 2_511 });
    expect(summary.checks.find((check) => check.id === "N2")?.result).toBe("program_wide");
  });

  it("forces the comparison off for all time, and drops it when Compare is off", async () => {
    const h = harness(() => read(withoutCompare(fixtureRaw())));
    await h.service.getSummary({ compare: "off" }, actor);
    expect(h.requests[0].comparePeriod).toBeNull();

    const all = harness((request) => read({
      ...withoutCompare(fixtureRaw()),
      bounds: { startAt: null, endAt: request.period.endAt, compareStartAt: null, compareEndAt: null },
    }));
    const summary = await all.service.getSummary({ period: "all", compare: "on" }, actor);
    expect(all.requests[0].comparePeriod).toBeNull();
    expect(all.requests[0].period.startAt).toBeNull();
    expect(summary.comparePeriod).toBeNull();
    expect(summary.tiles.billed.prior).toBeNull();
  });

  it("resolves last month as a closed window compared with the month before", async () => {
    const h = harness(() => read(lastMonthRaw()));
    const summary = await h.service.getSummary({ period: "last-month" }, actor);

    expect(h.requests[0].period).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-30", endsNow: false });
    expect(h.requests[0].comparePeriod).toMatchObject({ fromDate: "2026-08-01", toDate: "2026-08-31" });
    expect(summary.answer).toMatchObject({ billed: 4_100, keptOnOrders: 1_710, marginTenths: 417 });
    expect(summary.tiles.billed.prior?.kind).toBe("new");
  });

  it.each([
    [{ period: "custom" }, "DROPSHIP_FINANCE_INVALID_INPUT"],
    [{ vendorId: "abc" }, "DROPSHIP_FINANCE_INVALID_INPUT"],
    [{ vendorId: "0" }, "DROPSHIP_FINANCE_INVALID_INPUT"],
    [{ vendorId: ["1", "2"] }, "DROPSHIP_FINANCE_INVALID_INPUT"],
    [{ period: "week" }, "DROPSHIP_FINANCE_INVALID_INPUT"],
    [{ from: "2026-10-01" }, "DROPSHIP_FINANCE_INVALID_INPUT"],
    [{ tab: "finance" }, "DROPSHIP_FINANCE_INVALID_INPUT"],
    [{ period: "custom", from: "2026-02-30", to: "2026-03-01" }, "DROPSHIP_FINANCE_INVALID_PERIOD"],
    [{ period: "custom", from: "2026-10-03", to: "2026-10-01" }, "DROPSHIP_FINANCE_INVALID_PERIOD"],
    [{ period: "custom", from: "2026-10-01", to: "2026-10-06" }, "DROPSHIP_FINANCE_INVALID_PERIOD"],
  ])("refuses %j with %s before reading anything", async (query, code) => {
    const h = harness(() => read(fixtureRaw()));
    await expect(h.service.getSummary(query, actor)).rejects.toMatchObject({ code });
    expect(h.requests).toHaveLength(0);
  });

  it("says which field was refused, by path only", async () => {
    const h = harness(() => read(fixtureRaw()));
    const error = (await h.service.getSummary({ vendorId: "abc" }, actor).then(() => null, (caught: unknown) => caught)) as DropshipError;
    expect(error.context?.issues).toEqual([expect.objectContaining({ path: "vendorId" })]);
  });

  it("logs a section that could not be read: WARN when a retry may fix it, ERROR when a human must look", async () => {
    const raw = { ...fixtureRaw(), products: { status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT" } as const };
    const statements: FinanceStatementOutcome[] = [
      { name: "products", status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT", sqlState: "57014", durationMs: 8_000 },
      { name: "check_R2", status: "error", errorCode: "DROPSHIP_FINANCE_SCHEMA_MISMATCH", sqlState: "42703", durationMs: 3 },
    ];
    const h = harness(() => read(raw, statements));
    const summary = await h.service.getSummary({}, actor);

    expect(summary.sections.products).toMatchObject({ status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT" });
    expect(h.logger.warn).toHaveBeenCalledWith("dropship.finance.section_failed", expect.objectContaining({
      section: "products", error_code: "DROPSHIP_FINANCE_QUERY_TIMEOUT", error_class: "transient", sql_state: "57014", actor_id: "staff-7",
    }));
    expect(h.logger.error).toHaveBeenCalledWith("dropship.finance.section_failed", expect.objectContaining({
      section: "check_R2", error_code: "DROPSHIP_FINANCE_SCHEMA_MISMATCH", error_class: "fatal",
    }));
  });

  it("logs a section of bad stored data at ERROR with the class the error map gives it: permanent", async () => {
    const raw = { ...fixtureRaw(), products: { status: "error", errorCode: "DROPSHIP_FINANCE_DATA_INVALID" } as const };
    const statements: FinanceStatementOutcome[] = [
      { name: "products", status: "error", errorCode: "DROPSHIP_FINANCE_DATA_INVALID", sqlState: "22P02", durationMs: 4 },
    ];
    const h = harness(() => read(raw, statements));
    await h.service.getSummary({}, actor);

    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith("dropship.finance.section_failed", expect.objectContaining({
      section: "products", error_code: "DROPSHIP_FINANCE_DATA_INVALID", error_class: "permanent", sql_state: "22P02",
    }));
  });

  it("logs the sections the time budget skipped once, as a WARN", async () => {
    const skipped = { status: "skipped", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED" } as const;
    const raw = { ...fixtureRaw(), checks: { ...fixtureRaw().checks, K3: skipped } };
    const h = harness(() => read(raw, [{ name: "check_K3", status: "skipped", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED", durationMs: 0 }]));
    const summary = await h.service.getSummary({}, actor);

    expect(summary.checks.find((check) => check.id === "K3")).toMatchObject({ result: "could_not_check", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED" });
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith("dropship.finance.budget_exceeded", expect.objectContaining({ skipped_sections: ["check_K3"] }));
    expect(h.logger.info.mock.calls[0][1].checks_not_run).toEqual([{ id: "K3", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED" }]);
  });

  it("withholds a total that is not a safe integer, and logs it at ERROR by line key only", async () => {
    const raw = fixtureRaw();
    const ledger = raw.ledger.status === "ok" ? raw.ledger.data : null;
    const groups = (ledger?.groups ?? []).map((group) => (group.type === "return_fee" && group.vendorId === 12 ? { ...group, amountP: b("-90071992547409930") } : group));
    const h = harness(() => read({ ...raw, ledger: ok({ groups, firstFailureCode: ledger?.firstFailureCode ?? null }) }));
    const summary = await h.service.getSummary({}, actor);

    const returnFees = summary.sections.returns.lines.find((line) => line.key === "returns.fees");
    expect(returnFees).toMatchObject({ amount: null, status: "unavailable", errorCode: "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE" });
    expect(h.logger.error).toHaveBeenCalledWith("dropship.finance.amount_out_of_range", expect.objectContaining({ line_key: "returns.fees" }));
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain("90071992547409930");
  });

  it("passes a repository failure on with its code, message and context, plus the log-only correlation fields", async () => {
    const busy = new DropshipError("DROPSHIP_FINANCE_BUSY", "busy", { limit: 2, waitedMs: 2000 });
    // The read takes 2,000 ms on the injected clock.
    const h = harness(() => { throw busy; }, FINANCE_FIXTURE_NOW, 2_000);
    const error = (await h.service.getSummary({ vendorId: "12", period: "last-month" }, actor).then(() => null, (caught: unknown) => caught)) as DropshipError;

    expect(error).toBeInstanceOf(DropshipError);
    expect(error).toMatchObject({ code: "DROPSHIP_FINANCE_BUSY", message: "busy" });
    expect(error.context).toEqual({
      limit: 2,
      waitedMs: 2000,
      correlation: {
        vendor_id: 12, period_preset: "last-month", period_from: "2026-09-01", period_to: "2026-09-30", compare: true,
        generated_at: FINANCE_FIXTURE_NOW.toISOString(), duration_ms: 2_000,
      },
    });
    expect(busy.context).toEqual({ limit: 2, waitedMs: 2000 });
    expect(h.logger.info).not.toHaveBeenCalled();
  });

  it("names the days asked for when the period itself is refused", async () => {
    const h = harness(() => read(fixtureRaw()));
    const error = (await h.service.getSummary({ period: "custom", from: "2026-10-03", to: "2026-10-01", vendorId: "13" }, actor)
      .then(() => null, (caught: unknown) => caught)) as DropshipError;

    expect(error.code).toBe("DROPSHIP_FINANCE_INVALID_PERIOD");
    expect(error.context).toMatchObject({
      reason: "from_after_to",
      correlation: { vendor_id: 13, period_preset: "custom", period_from: "2026-10-03", period_to: "2026-10-01", duration_ms: 0 },
    });
    expect(h.requests).toHaveLength(0);
  });

  it("turns a failure that is not a DropshipError into INTERNAL_ERROR, keeping the original as its cause", async () => {
    const bug = new TypeError("cannot read x of undefined");
    const h = harness(() => { throw bug; });
    const error = (await h.service.getSummary({}, actor).then(() => null, (caught: unknown) => caught)) as DropshipError;

    expect(error).toMatchObject({ code: "DROPSHIP_FINANCE_INTERNAL_ERROR", message: "The finance figures could not be read." });
    expect(error.context?.cause).toBe(bug);
    expect(error.context?.correlation).toMatchObject({ vendor_id: null, period_preset: "mtd", period_from: "2026-10-01", period_to: "2026-10-05" });
  });

  it("refuses to label numbers with bounds the database worked out differently", async () => {
    const raw = fixtureRaw();
    const h = harness(() => read({ ...raw, bounds: { ...raw.bounds, startAt: new Date("2026-10-01T05:00:00.000Z") } }));
    await expect(h.service.getSummary({}, actor)).rejects.toMatchObject({ code: "DROPSHIP_FINANCE_INTERNAL_ERROR" });
  });
});
