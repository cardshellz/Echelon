import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  FINANCE_SECTION_KEYS,
  FINANCE_SECTION_LINE_KEYS,
  financeSummarySchema,
  type FinanceSummaryInput,
} from "@shared/dropship/program-finance";
import { FINANCE_LINE_DEFINITIONS } from "@shared/dropship/program-finance-definitions";
import { DropshipApiError } from "@/lib/dropship-ops-surface";
import {
  DROPSHIP_FINANCE_QUERY_KEY_ROOT,
  DROPSHIP_FINANCE_SUMMARY_URL,
  FINANCE_DEFAULT_URL_STATE,
  FINANCE_NOT_RECORDED_TEXT,
  FINANCE_QUERY_MAX_RETRIES,
  FINANCE_UNAVAILABLE_TEXT,
  FINANCE_VIEW_STORAGE_KEY,
  FinanceContractError,
  buildFinanceAnswerView,
  buildFinanceChecksView,
  buildFinanceCountingView,
  buildFinanceDetailGroups,
  buildFinanceHowView,
  buildFinancePageError,
  buildFinancePeriodBarView,
  buildFinanceProductsTable,
  buildFinanceSectionRow,
  buildFinanceSummaryUrl,
  buildFinanceTilesView,
  buildFinanceVendorsTable,
  classifyFinanceError,
  fetchFinanceSummary,
  fillFinanceWords,
  financeCalendarDateToLocalDate,
  financeCompareSwitchSpan,
  financeHeroSize,
  financeLineNote,
  financeLocalDateToCalendarDate,
  financePeriodWords,
  financeQueryRetry,
  financeQueryRetryDelay,
  financeSummaryQueryKey,
  financeSummaryScope,
  financeTodayInEastern,
  financeUpdatedAnnouncement,
  financeUrlHref,
  financeWorkingsKeys,
  formatFinanceClockTime,
  formatFinanceCount,
  formatFinanceDateSpan,
  formatFinanceDelta,
  formatFinanceInstant,
  formatFinanceLineAmount,
  formatFinanceLocalDate,
  formatFinanceMagnitude,
  formatFinanceMoney,
  formatFinanceMoneySpoken,
  formatFinancePercent,
  formatFinancePoints,
  formatFinancePts,
  formatFinanceSignedMoney,
  formatFinanceWorkingFigure,
  isFinanceLocalDate,
  parseFinanceSummary,
  readFinanceUrlState,
  refreshFinanceQueries,
  readFinanceViewMemory,
  resolveFinanceView,
  validateFinanceCustomRange,
  writeFinanceUrlState,
  writeFinanceViewMemory,
  type FinanceUrlState,
  type FinanceViewStorage,
} from "../dropship-finance-model";
import {
  FINANCE_FIXTURE_CHECKS_NEEDING_A_LOOK,
  financeFixtureCheck,
  financeFixtureLine,
  financeSummaryFixture,
  financeSummaryFixtureInput,
  parseFinanceFixture,
} from "./fixtures/dropship-finance-summary.fixture";

const MINUS = "−";

function salesLines(input: FinanceSummaryInput) {
  return input.sections.sales.lines;
}

function row(input: FinanceSummaryInput, key: (typeof FINANCE_SECTION_KEYS)[number], depth: "summary" | "every_line" = "summary") {
  return buildFinanceSectionRow(parseFinanceFixture(input), key, depth);
}

function statementLabels(view: ReturnType<typeof buildFinanceSectionRow>, index = 0) {
  return view.statements[index]?.rows.map((line) => `${line.operatorSymbol}|${line.label}|${line.amount}`) ?? [];
}

const QUERY_TIMEOUT = "DROPSHIP_FINANCE_QUERY_TIMEOUT";

/**
 * Marks lines the way the server's unavailableLine does when their source
 * failed or is missing: no amount, no count, the cause's code or reason.
 */
function markUnavailable(
  lines: FinanceSummaryInput["sections"]["sales"]["lines"],
  keys: readonly string[],
  cause: { errorCode?: string; reasonKey?: string },
) {
  for (const line of lines) {
    if (!keys.includes(line.key)) continue;
    const { count: _count, coverage: _coverage, percentTenths: _tenths, percentBps: _bps, workings: _workings, prior: _prior, ...rest } = line;
    Object.keys(line).forEach((field) => delete (line as Record<string, unknown>)[field]);
    Object.assign(line, rest, { amount: null, status: "unavailable", depth: "summary" }, cause);
  }
}

function setLine(input: FinanceSummaryInput, section: "cash", key: string, patch: Record<string, unknown>) {
  const target = input.sections[section];
  if (target.status !== "ok") throw new Error(`the golden's ${section} section is ok`);
  const line = target.lines.find((candidate) => candidate.key === key);
  if (!line) throw new Error(`the golden has no ${key}`);
  Object.assign(line, patch);
}

// ── formatters ────────────────────────────────────────────────────────────

describe("money formatters", () => {
  it("writes signed cents as dollars with a typographic minus", () => {
    expect(formatFinanceMoney(193_410)).toBe("$1,934.10");
    expect(formatFinanceMoney(-21_240)).toBe(`${MINUS}$212.40`);
    expect(formatFinanceMoney(0)).toBe("$0.00");
    expect(formatFinanceMoney(5)).toBe("$0.05");
    expect(formatFinanceMoney(-1)).toBe(`${MINUS}$0.01`);
    expect(formatFinanceMoney(100_000_000_00)).toBe("$100,000,000.00");
  });

  it("is exact up to the largest safe integer, with no float rounding", () => {
    expect(formatFinanceMoney(Number.MAX_SAFE_INTEGER)).toBe("$90,071,992,547,409.91");
    expect(formatFinanceMoney(Number.MIN_SAFE_INTEGER)).toBe(`${MINUS}$90,071,992,547,409.91`);
  });

  it("never shows a missing or impossible value as $0.00", () => {
    expect(formatFinanceMoney(null)).toBe(FINANCE_NOT_RECORDED_TEXT);
    expect(formatFinanceMoney(undefined)).toBe(FINANCE_NOT_RECORDED_TEXT);
    expect(formatFinanceMoney(1.5)).toBe(FINANCE_UNAVAILABLE_TEXT);
    expect(formatFinanceMoney(Number.MAX_SAFE_INTEGER + 1)).toBe(FINANCE_UNAVAILABLE_TEXT);
    expect(formatFinanceMoney(Number.NaN)).toBe(FINANCE_UNAVAILABLE_TEXT);
    expect(formatFinanceMoney(Number.POSITIVE_INFINITY)).toBe(FINANCE_UNAVAILABLE_TEXT);
  });

  it("drops the sign on operator lines and keeps it on changes", () => {
    expect(formatFinanceMagnitude(-8_500)).toBe("$85.00");
    expect(formatFinanceMagnitude(8_500)).toBe("$85.00");
    expect(formatFinanceMagnitude(null)).toBe(FINANCE_NOT_RECORDED_TEXT);
    expect(formatFinanceMagnitude(0.1)).toBe(FINANCE_UNAVAILABLE_TEXT);
    expect(formatFinanceSignedMoney(16_130)).toBe("+$161.30");
    expect(formatFinanceSignedMoney(-211_700)).toBe(`${MINUS}$2,117.00`);
    expect(formatFinanceSignedMoney(0)).toBe("$0.00");
  });

  it("says money aloud for screen readers", () => {
    expect(formatFinanceMoneySpoken(193_410)).toBe("1,934 dollars and 10 cents");
    expect(formatFinanceMoneySpoken(-21_240)).toBe("minus 212 dollars and 40 cents");
    expect(formatFinanceMoneySpoken(100)).toBe("1 dollar");
    expect(formatFinanceMoneySpoken(101)).toBe("1 dollar and 1 cent");
    expect(formatFinanceMoneySpoken(null)).toBe("not recorded");
    expect(formatFinanceMoneySpoken(2.5)).toBe("unavailable");
  });
});

describe("percent, points and count formatters", () => {
  it("writes signed tenths of a percent", () => {
    expect(formatFinancePercent(250)).toBe("25.0%");
    expect(formatFinancePercent(399)).toBe("39.9%");
    expect(formatFinancePercent(-42)).toBe(`${MINUS}4.2%`);
    expect(formatFinancePercent(5)).toBe("0.5%");
    expect(formatFinancePercent(0)).toBe("0.0%");
    expect(formatFinancePercent(6_204, { signed: true })).toBe("+620.4%");
    expect(formatFinancePercent(-706, { signed: true })).toBe(`${MINUS}70.6%`);
    expect(formatFinancePercent(123_456)).toBe("12,345.6%");
  });

  it("writes a share of nothing as a dash and an impossible value as unavailable", () => {
    expect(formatFinancePercent(null)).toBe("—");
    expect(formatFinancePercent(2.5)).toBe(FINANCE_UNAVAILABLE_TEXT);
  });

  it("writes a margin change in signed points", () => {
    expect(formatFinancePts(12)).toBe("+1.2 pts");
    expect(formatFinancePts(-5)).toBe(`${MINUS}0.5 pts`);
    expect(formatFinancePts(0)).toBe("0.0 pts");
    expect(formatFinancePts(null)).toBe("—");
  });

  it("writes points with the wallet formatter and counts grouped", () => {
    expect(formatFinancePoints(12_400)).toBe("12,400 points");
    expect(formatFinancePoints(1)).toBe("1 point");
    expect(formatFinancePoints(null)).toBe(FINANCE_NOT_RECORDED_TEXT);
    expect(formatFinancePoints(0.5)).toBe(FINANCE_UNAVAILABLE_TEXT);
    expect(formatFinanceCount(12_110)).toBe("12,110");
    expect(formatFinanceCount(-1)).toBe(FINANCE_UNAVAILABLE_TEXT);
    expect(formatFinanceCount(null)).toBe(FINANCE_NOT_RECORDED_TEXT);
  });
});

describe("dates and instants in Eastern time", () => {
  it("prints exact day spans the way the period bar does", () => {
    expect(formatFinanceDateSpan("2026-10-01", "2026-10-05")).toBe("Oct 1 – 5, 2026");
    expect(formatFinanceDateSpan("2026-10-01", "2026-10-05", { withYear: false })).toBe("Oct 1 – 5");
    expect(formatFinanceDateSpan("2026-09-28", "2026-10-05")).toBe("Sep 28 – Oct 5, 2026");
    expect(formatFinanceDateSpan("2025-12-28", "2026-01-03", { withYear: false })).toBe("Dec 28, 2025 – Jan 3, 2026");
    expect(formatFinanceDateSpan("2026-10-05", "2026-10-05")).toBe("Oct 5, 2026");
    expect(formatFinanceDateSpan("2026-02-30", "2026-03-01")).toBe(FINANCE_UNAVAILABLE_TEXT);
    expect(formatFinanceLocalDate("2026-10-01")).toBe("Oct 1, 2026");
    expect(formatFinanceLocalDate("2026-10-01", { withYear: false })).toBe("Oct 1");
  });

  it("knows which calendar days exist", () => {
    expect(isFinanceLocalDate("2028-02-29")).toBe(true);
    expect(isFinanceLocalDate("2026-02-29")).toBe(false);
    expect(isFinanceLocalDate("2026-13-01")).toBe(false);
    expect(isFinanceLocalDate("2026-10-1")).toBe(false);
  });

  it("writes instants in Eastern time across daylight saving", () => {
    expect(formatFinanceInstant("2026-10-04T19:10:00.000Z")).toBe("Oct 4, 2026, 3:10 PM ET");
    expect(formatFinanceInstant("2026-11-01T04:30:00.000Z")).toBe("Nov 1, 2026, 12:30 AM ET");
    // The hour that repeats when daylight saving ends: 1:30 AM EDT, then 1:30 AM EST.
    expect(formatFinanceInstant("2026-11-01T05:30:00.000Z")).toBe("Nov 1, 2026, 1:30 AM ET");
    expect(formatFinanceInstant("2026-11-01T06:30:00.000Z")).toBe("Nov 1, 2026, 1:30 AM ET");
    expect(formatFinanceInstant("2026-03-08T07:30:00.000Z")).toBe("Mar 8, 2026, 3:30 AM ET");
    expect(formatFinanceClockTime("2026-10-05T13:14:00.000Z")).toBe("9:14 AM");
    expect(formatFinanceInstant("not a date")).toBe(FINANCE_UNAVAILABLE_TEXT);
  });

  it("finds today in Eastern time for an injected clock", () => {
    expect(financeTodayInEastern(new Date("2026-10-06T02:00:00.000Z"))).toBe("2026-10-05");
    expect(financeTodayInEastern(new Date("2026-10-06T04:00:00.000Z"))).toBe("2026-10-06");
  });

  it("moves picker days to and from YYYY-MM-DD by their calendar fields", () => {
    const date = financeLocalDateToCalendarDate("2026-03-08");
    expect(date && financeCalendarDateToLocalDate(date)).toBe("2026-03-08");
    expect(financeLocalDateToCalendarDate(null)).toBeUndefined();
    expect(financeLocalDateToCalendarDate("2026-02-30")).toBeUndefined();
  });

  it("fills placeholders and never leaves a brace on screen", () => {
    expect(fillFinanceWords("{n} orders · {$}", { n: "3", $: "$1.00" })).toBe("3 orders · $1.00");
    expect(fillFinanceWords("Owed on {date}", {})).toBe("Owed on …");
  });
});

// ── URL state ─────────────────────────────────────────────────────────────

describe("URL state", () => {
  it("defaults to this month so far, compared, all vendors, nothing open", () => {
    const { state, dropped } = readFinanceUrlState("tab=finance");
    expect(state).toEqual(FINANCE_DEFAULT_URL_STATE);
    expect(dropped).toEqual([]);
    expect(writeFinanceUrlState(state)).toBe("tab=finance");
    expect(financeUrlHref(state)).toBe("/dropship?tab=finance");
  });

  it("round-trips every value it accepts, defaults omitted, in a fixed order", () => {
    const state: FinanceUrlState = {
      period: "custom",
      from: "2026-11-01",
      to: "2026-11-01",
      compare: false,
      vendorId: 12,
      open: ["checks", "sales", "cash"],
      depth: "every_line",
      how: "answer.kept",
    };
    const written = writeFinanceUrlState(state);
    expect(written).toBe("tab=finance&period=custom&from=2026-11-01&to=2026-11-01&compare=off&vendor=12&open=sales,cash,checks&depth=all&how=answer.kept");
    const read = readFinanceUrlState(`?${written}`);
    expect(read.dropped).toEqual([]);
    expect(read.state).toEqual({ ...state, open: ["sales", "cash", "checks"] });
  });

  it("keeps a preset without dates and drops dates that came with one", () => {
    expect(readFinanceUrlState("tab=finance&period=last-month").state.period).toBe("last-month");
    const read = readFinanceUrlState("tab=finance&period=ytd&from=2026-01-01&to=2026-01-02");
    expect(read.state).toMatchObject({ period: "ytd", from: null, to: null });
    expect(read.dropped).toEqual(expect.arrayContaining(["from", "to"]));
  });

  it("falls back to the default when a custom range is missing, impossible or backwards", () => {
    for (const search of [
      "period=custom",
      "period=custom&from=2026-10-05",
      "period=custom&from=2026-02-30&to=2026-03-01",
      "period=custom&from=2026-10-05&to=2026-10-01",
    ]) {
      const read = readFinanceUrlState(search);
      expect(read.state).toMatchObject({ period: "mtd", from: null, to: null });
      expect(read.dropped).toContain("period");
    }
  });

  it("drops unknown presets, bad compare, bad vendor ids, unknown rows, bad depth and unknown drawers", () => {
    const read = readFinanceUrlState(
      "tab=finance&period=this-month&compare=maybe&vendor=0&open=sales,bogus&depth=deep&how=sales.bogus&sheet=sales.cogs",
    );
    expect(read.state).toEqual({ ...FINANCE_DEFAULT_URL_STATE, open: ["sales"] });
    expect(read.dropped).toEqual(expect.arrayContaining(["period", "compare", "vendor", "open", "depth", "how", "sheet"]));
  });

  it.each(["abc", "0", "012", "-1", "1.5", "2147483648", "12345678901"])("refuses vendor %j", (vendor) => {
    const read = readFinanceUrlState(`vendor=${vendor}`);
    expect(read.state.vendorId).toBeNull();
    expect(read.dropped).toContain("vendor");
  });

  it("accepts the largest int4 vendor id", () => {
    expect(readFinanceUrlState("vendor=2147483647").state.vendorId).toBe(2_147_483_647);
  });

  it("drops a repeated parameter instead of guessing which one was meant", () => {
    const read = readFinanceUrlState("period=mtd&period=ytd&vendor=12&vendor=13");
    expect(read.state).toMatchObject({ period: "mtd", vendorId: null });
    expect(read.dropped).toEqual(expect.arrayContaining(["period", "vendor"]));
  });

  it("rewrites open rows that came out of order or twice", () => {
    const read = readFinanceUrlState("open=checks,sales,sales");
    expect(read.state.open).toEqual(["sales", "checks"]);
    expect(read.dropped).toContain("open");
    expect(readFinanceUrlState("open=").dropped).toContain("open");
  });

  it("does not write a custom period it could not read back", () => {
    expect(writeFinanceUrlState({ ...FINANCE_DEFAULT_URL_STATE, period: "custom" })).toBe("tab=finance");
  });
});

describe("remembered view", () => {
  function memoryStorage(initial: Record<string, string> = {}): FinanceViewStorage & { values: Record<string, string> } {
    const values = { ...initial };
    return {
      values,
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => {
        values[key] = value;
      },
    };
  }

  const throwing: FinanceViewStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };

  it("writes and reads the open rows and depth", () => {
    const storage = memoryStorage();
    expect(writeFinanceViewMemory(storage, { open: ["checks", "sales"], depth: "every_line" })).toBe(true);
    expect(JSON.parse(storage.values[FINANCE_VIEW_STORAGE_KEY])).toEqual({ open: ["sales", "checks"], depth: "every_line" });
    expect(readFinanceViewMemory(storage)).toEqual({ open: ["sales", "checks"], depth: "every_line" });
  });

  it("treats blocked, missing or malformed storage as no memory, and never throws", () => {
    expect(readFinanceViewMemory(null)).toBeNull();
    expect(readFinanceViewMemory(throwing)).toBeNull();
    expect(writeFinanceViewMemory(throwing, { open: [], depth: "summary" })).toBe(false);
    expect(readFinanceViewMemory(memoryStorage({ [FINANCE_VIEW_STORAGE_KEY]: "{not json" }))).toBeNull();
    expect(readFinanceViewMemory(memoryStorage({ [FINANCE_VIEW_STORAGE_KEY]: JSON.stringify({ open: "sales", depth: "summary" }) }))).toBeNull();
    expect(readFinanceViewMemory(memoryStorage({ [FINANCE_VIEW_STORAGE_KEY]: JSON.stringify({ open: ["bogus", "pool"], depth: "summary" }) })))
      .toEqual({ open: ["pool"], depth: "summary" });
  });

  it("lets the URL win, then the memory, then the defaults", () => {
    const memory = { open: ["pool"] as const, depth: "every_line" as const };
    expect(resolveFinanceView(FINANCE_DEFAULT_URL_STATE, null)).toEqual({ open: [], depth: "summary" });
    expect(resolveFinanceView(FINANCE_DEFAULT_URL_STATE, memory)).toEqual({ open: ["pool"], depth: "every_line" });
    expect(resolveFinanceView({ ...FINANCE_DEFAULT_URL_STATE, open: ["sales"], depth: "summary" }, memory)).toEqual({ open: ["sales"], depth: "summary" });
  });
});

// ── the request ───────────────────────────────────────────────────────────

describe("summary request", () => {
  it("refreshes only the summary on screen and marks the other cached periods stale", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const fetches: string[] = [];
    const queryFor = (period: "mtd" | "last-month") => ({
      queryKey: financeSummaryQueryKey(financeSummaryScope({ ...FINANCE_DEFAULT_URL_STATE, period })),
      queryFn: async () => {
        fetches.push(period);
        return period;
      },
    });
    // Both periods were looked at earlier; only this month is on screen now.
    await client.fetchQuery(queryFor("mtd"));
    await client.fetchQuery(queryFor("last-month"));
    const onScreen = new QueryObserver(client, queryFor("mtd"));
    const unsubscribe = onScreen.subscribe(() => undefined);
    fetches.length = 0;

    await refreshFinanceQueries(client);
    expect(fetches).toEqual(["mtd"]);
    expect(client.getQueryState(queryFor("last-month").queryKey)?.isInvalidated).toBe(true);

    // Going back to last month later fetches it fresh, though staleTime is Infinity app-wide.
    const later = new QueryObserver(client, queryFor("last-month"));
    const unsubscribeLater = later.subscribe(() => undefined);
    await vi.waitFor(() => expect(fetches).toEqual(["mtd", "last-month"]));
    unsubscribe();
    unsubscribeLater();
    client.clear();
  });

  it("keys every finance query under one root so Refresh can refetch them all", () => {
    const scope = financeSummaryScope({ ...FINANCE_DEFAULT_URL_STATE, vendorId: 12, open: ["sales"], how: "answer.kept" });
    expect(financeSummaryQueryKey(scope)).toEqual([
      DROPSHIP_FINANCE_QUERY_KEY_ROOT,
      "summary",
      { period: "mtd", from: null, to: null, compare: true, vendorId: 12 },
    ]);
    // Opening a row or a drawer is not a new query.
    expect(financeSummaryQueryKey(scope)).toEqual(financeSummaryQueryKey(financeSummaryScope({ ...FINANCE_DEFAULT_URL_STATE, vendorId: 12 })));
  });

  it("sends only what the strict query schema accepts", () => {
    expect(buildFinanceSummaryUrl(financeSummaryScope(FINANCE_DEFAULT_URL_STATE))).toBe(`${DROPSHIP_FINANCE_SUMMARY_URL}?period=mtd`);
    expect(buildFinanceSummaryUrl({ period: "custom", from: "2026-11-01", to: "2026-11-02", compare: false, vendorId: 12 }))
      .toBe(`${DROPSHIP_FINANCE_SUMMARY_URL}?period=custom&from=2026-11-01&to=2026-11-02&compare=off&vendorId=12`);
    expect(buildFinanceSummaryUrl({ period: "ytd", from: "2026-11-01", to: "2026-11-02", compare: true, vendorId: null }))
      .toBe(`${DROPSHIP_FINANCE_SUMMARY_URL}?period=ytd`);
  });

  it("fetches and validates the summary with the shared contract", async () => {
    const urls: string[] = [];
    const summary = await fetchFinanceSummary(financeSummaryScope(FINANCE_DEFAULT_URL_STATE), {
      fetcher: async (url) => {
        urls.push(url);
        return JSON.parse(JSON.stringify(financeSummaryFixture()));
      },
    });
    expect(urls).toEqual([`${DROPSHIP_FINANCE_SUMMARY_URL}?period=mtd`]);
    expect(summary.answer.kept.amount).toBe(2_641);
  });

  it("refuses a response that breaks the contract, naming paths only", () => {
    const input = financeSummaryFixtureInput();
    input.answer.billed = 1.5;
    let caught: unknown;
    try {
      parseFinanceSummary(JSON.parse(JSON.stringify(input)));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FinanceContractError);
    expect((caught as FinanceContractError).issuePaths).toContain("answer.billed");
    expect((caught as FinanceContractError).message).not.toContain("1.5");
  });
});

describe("error classification and retries", () => {
  const apiError = (status: number, code: string | null, classification?: string, message = "Request failed") =>
    new DropshipApiError({ status, code, message, context: classification ? { classification } : null });

  it("retries transient failures only, at most twice, with backoff", () => {
    const transient = apiError(503, "DROPSHIP_FINANCE_QUERY_TIMEOUT", "transient");
    expect(classifyFinanceError(transient)).toMatchObject({ kind: "load", classification: "transient", retry: true });
    expect(financeQueryRetry(0, transient)).toBe(true);
    expect(financeQueryRetry(1, transient)).toBe(true);
    expect(financeQueryRetry(FINANCE_QUERY_MAX_RETRIES, transient)).toBe(false);
    expect(financeQueryRetryDelay(0)).toBe(1_000);
    expect(financeQueryRetryDelay(1)).toBe(2_000);
    expect(financeQueryRetry(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(financeQueryRetry(0, apiError(502, null))).toBe(true);
  });

  it("never retries a permanent or fatal failure", () => {
    expect(financeQueryRetry(0, apiError(400, "DROPSHIP_FINANCE_INVALID_PERIOD", "permanent"))).toBe(false);
    expect(financeQueryRetry(0, apiError(500, "DROPSHIP_FINANCE_CONTRACT_VIOLATION", "fatal"))).toBe(false);
    expect(financeQueryRetry(0, apiError(500, null))).toBe(false);
    expect(financeQueryRetry(0, apiError(403, null))).toBe(false);
    expect(financeQueryRetry(0, new FinanceContractError(["answer.billed"]))).toBe(false);
    expect(financeQueryRetry(0, new Error("boom"))).toBe(false);
  });

  it("says what each failure means on the page", () => {
    expect(buildFinancePageError(apiError(403, null, undefined, "Permission denied: dropship:manage_operations"), "this month so far").text)
      .toBe("Program finance needs Dropship operations access (Administrator).");
    expect(buildFinancePageError(apiError(400, "DROPSHIP_FINANCE_INVALID_PERIOD", "permanent", "The end date is after today."), "Oct 1 – 9, 2026"))
      .toMatchObject({ kind: "invalid_period", text: "These dates don't work: the end date is after today. Pick other dates.", canRetry: false });
    expect(buildFinancePageError(apiError(503, "DROPSHIP_FINANCE_DB_UNAVAILABLE", "transient"), "this month so far"))
      .toMatchObject({
        kind: "load",
        text: "Couldn't load program finance for this month so far. Nothing is shown so older numbers can't be mistaken for current ones. (DROPSHIP_FINANCE_DB_UNAVAILABLE)",
        canRetry: true,
      });
    expect(buildFinancePageError(apiError(500, "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE", "fatal"), "x").text)
      .toBe("These numbers could not be checked, so none are shown. (DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE)");
    expect(buildFinancePageError(new FinanceContractError([]), "x").text)
      .toBe("These numbers could not be checked, so none are shown. (DROPSHIP_FINANCE_CONTRACT_VIOLATION)");
  });

  it("checks a custom range before any request runs", () => {
    expect(validateFinanceCustomRange("2026-10-01", "2026-10-05", "2026-10-05")).toBeNull();
    expect(validateFinanceCustomRange("2026-10-05", "2026-10-01", "2026-10-05")).toBe("Pick an end date on or after the start date.");
    expect(validateFinanceCustomRange(null, "2026-10-01", "2026-10-05")).toBe("Pick an end date on or after the start date.");
    expect(validateFinanceCustomRange("2026-10-01", "2026-10-06", "2026-10-05")).toBe("Pick an end date on or before today.");
  });
});

// ── view models against the §6.4 summary ─────────────────────────────────

describe("the §6.4 fixture", () => {
  it("is valid against the shared contract", () => {
    expect(financeSummarySchema.safeParse(financeSummaryFixtureInput()).success).toBe(true);
    expect(financeSummaryFixture().checks.filter((check) => check.result === "needs_a_look").map((check) => check.id))
      .toEqual([...FINANCE_FIXTURE_CHECKS_NEEDING_A_LOOK]);
  });
});

describe("period bar", () => {
  it("prints the resolved dates, the comparison, the as-of time and the checks chip", () => {
    const view = buildFinancePeriodBarView(FINANCE_DEFAULT_URL_STATE, financeSummaryFixture(), { refreshing: false });
    expect(view).toMatchObject({
      presetLabel: "This month so far",
      dateText: "Oct 1 – 5, 2026",
      compareLabel: "Compare with Sep 1 – 5 (to 9:14 AM)",
      compareDisabled: false,
      asOf: "Numbers as of 9:14 AM ET",
      vendorChip: null,
      checksChip: { text: "4 need a look", tone: "attention" },
      notes: [],
    });
  });

  it("renders before the summary arrives, with custom dates from the URL and no chip yet", () => {
    const view = buildFinancePeriodBarView({ ...FINANCE_DEFAULT_URL_STATE, period: "custom", from: "2026-11-01", to: "2026-11-02", vendorId: 12 }, null, { refreshing: false });
    expect(view).toMatchObject({ dateText: "Nov 1 – 2, 2026", asOf: null, checksChip: null, vendorChip: { vendorId: 12, label: "Vendor: Vendor #12" } });
    expect(buildFinancePeriodBarView(FINANCE_DEFAULT_URL_STATE, null, { refreshing: false }).dateText).toBeNull();
  });

  it("says Refreshing… while the same period refetches, and disables Compare for all time", () => {
    expect(buildFinancePeriodBarView(FINANCE_DEFAULT_URL_STATE, financeSummaryFixture(), { refreshing: true }).asOf).toBe("Refreshing…");
    const allTime = buildFinancePeriodBarView({ ...FINANCE_DEFAULT_URL_STATE, period: "all" }, null, { refreshing: false });
    expect(allTime).toMatchObject({ compareDisabled: true, compareHint: "All time has nothing earlier to compare with." });
  });

  it("names a clamped month and shows the policy-era notes", () => {
    const input = financeSummaryFixtureInput();
    input.period = { ...input.period, fromDate: "2026-03-01", toDate: "2026-03-31", endsNow: false, endAt: "2026-04-01T04:00:00.000Z" };
    input.comparePeriod = { ...input.comparePeriod!, fromDate: "2026-02-01", toDate: "2026-02-28", clampedToMonthEnd: true };
    input.notes = ["card_fee_era", "weekly_collection_era"];
    const summary = parseFinanceFixture(input);
    expect(financeCompareSwitchSpan(summary)).toBe("Feb 1 – 28 (Feb has 28 days)");
    expect(buildFinancePeriodBarView(FINANCE_DEFAULT_URL_STATE, summary, { refreshing: false }).notes).toEqual([
      "Card top-ups carried a 3% fee from Sep 16 to Sep 24, 2026.",
      "The weekly collection ran from Aug 5 to Sep 17, 2026 (retired).",
    ]);
  });

  it("announces new numbers politely", () => {
    expect(financeUpdatedAnnouncement(financeSummaryFixture())).toBe("Numbers updated for Oct 1 – 5.");
  });
});

describe("answer card", () => {
  it("shows what we kept with its caveat, margin, change, coverage and points", () => {
    const view = buildFinanceAnswerView(financeSummaryFixture());
    expect(view.hero).toEqual({
      text: "$26.41",
      size: "xl",
      loss: false,
      spoken: "What we kept, 26 dollars and 41 cents, before packaging, Stripe fees and overheads",
    });
    expect(view.caveat).toBe("before packaging, Stripe fees and overheads");
    expect(view.margin).toEqual({
      text: "39.9% of what we billed on fully costed orders",
      change: { text: `${MINUS}0.5 pts vs Sep 1 – 5`, direction: "down" },
    });
    expect(view.coverage).toEqual({
      done: 3, total: 10, remaining: 7,
      text: "Costs complete on 3 of 10 orders",
      valueText: "3 of 10 orders",
      waitingText: "7 orders ($90.00) count once their costs are recorded",
    });
    expect(view.pointsLine).toBe("$22.00 of what we billed was paid with points: no cash came in for it");
    expect(view.hasWorkings).toBe(true);
  });

  it("draws the bar from the server's widths and lists every exact amount", () => {
    const { bar, bridge } = buildFinanceAnswerView(financeSummaryFixture());
    expect(bar.header).toBe("10 orders · $187.30 billed");
    expect(bar.segments.map((segment) => [segment.key, segment.weight])).toEqual([
      ["kept", 2_072], ["cogs", 2_010], ["labels", 1_033], ["pool", 80], ["waiting", 4_805],
    ]);
    expect(bar.brackets).toEqual([{ label: "3 fully costed · $97.30", weight: 5_195 }, { label: "7", weight: 4_805 }]);
    expect(bar.legend.map((entry) => [entry.label, entry.cents, entry.amount])).toEqual([
      ["Kept on orders", "40¢", "$38.81"],
      ["Cost of goods", "39¢", "$37.64"],
      ["Carrier labels", "20¢", "$19.35"],
      ["Insurance pool share (set aside)", "1¢", "$1.50"],
      ["Not yet fully costed · 7 orders", "·", "$90.00"],
    ]);
    expect(bar.ariaLabel).toBe(
      "Of each dollar billed on 3 fully costed orders: 40 cents kept, 39 cents cost of goods, 20 cents carrier labels, 1 cent insurance pool share; 7 orders, 90 dollars, not yet fully costed",
    );
    expect(bridge).toBe(`$38.81 kept on orders + $7.60 fees we charged ${MINUS} $20.00 return credits we paid = $26.41 kept`);
  });

  it("reads 'No orders accepted …' with an empty track when nothing was accepted", () => {
    const input = financeSummaryFixtureInput();
    Object.assign(input.answer, {
      state: "no_orders", kept: { amount: -1_240, status: "recorded" }, keptOnOrders: 0, orders: 0, billed: 0,
      fullyCosted: { orders: 0, billed: 0 }, waiting: { orders: 0, billed: 0 }, costOfGoods: 0, carrierLabels: 0, poolShare: 0,
      marginTenths: null, marginBps: null, priorMarginTenths: null, marginChangeTenths: null, centsOfEachDollar: null, barBps: null,
      paidWithPoints: { billed: 0, points: 0 }, coverage: { done: 0, total: 0 },
    });
    const view = buildFinanceAnswerView(parseFinanceFixture(input));
    expect(view.hero).toBeNull();
    expect(view.headline).toBe("No orders accepted Oct 1 – 5");
    expect(view.bar).toMatchObject({ layout: "empty", emptyLabel: "Nothing billed yet this period", legend: [] });
    expect(view.margin).toBeNull();
    expect(view.bridge).toBeNull();
  });

  it("reads 'Not ready yet' with an all-track bar when no order is fully costed", () => {
    const input = financeSummaryFixtureInput();
    Object.assign(input.answer, {
      state: "not_ready", kept: { amount: -1_240, status: "recorded" }, keptOnOrders: 0, orders: 6, billed: 9_000,
      fullyCosted: { orders: 0, billed: 0 }, waiting: { orders: 6, billed: 9_000 }, costOfGoods: 0, carrierLabels: 0, poolShare: 0,
      marginTenths: null, marginBps: null, marginChangeTenths: null, centsOfEachDollar: null,
      barBps: { kept: 0, costOfGoods: 0, carrierLabels: 0, poolShare: 0, waiting: 10_000 }, coverage: { done: 0, total: 6 },
    });
    const view = buildFinanceAnswerView(parseFinanceFixture(input));
    expect(view.headline).toBe("Not ready yet");
    expect(view.headlineDetail).toBe("Costs are recorded when items are picked and labels are bought. 0 of 6 orders so far.");
    expect(view.bar.segments.filter((segment) => segment.weight > 0).map((segment) => segment.key)).toEqual(["waiting"]);
    expect(view.bar.legend.at(-1)).toMatchObject({ label: "Not yet fully costed · 6 orders", amount: "$90.00" });
  });

  it("shows a loss in words, with no cents of each dollar and the billed tick on the cost bar", () => {
    const input = financeSummaryFixtureInput();
    // Costs on fully costed orders ran $2.12 over what we billed on them.
    Object.assign(input.answer, {
      state: "loss", kept: { amount: -21_240, status: "recorded" }, keptOnOrders: -212, feesCharged: 0, returnCreditsPaid: 21_028,
      orders: 2, billed: 2_000, fullyCosted: { orders: 1, billed: 1_000 }, waiting: { orders: 1, billed: 1_000 },
      costOfGoods: 900, carrierLabels: 262, poolShare: 50, marginTenths: -212, marginBps: -2_120, marginChangeTenths: null,
      centsOfEachDollar: null, barBps: null, paidWithPoints: { billed: 0, points: 0 }, coverage: { done: 1, total: 2 },
    });
    const view = buildFinanceAnswerView(parseFinanceFixture(input));
    expect(view.hero).toMatchObject({ text: `${MINUS}$212.40`, loss: true });
    expect(view.margin?.text).toBe(`${MINUS}21.2% of what we billed on fully costed orders`);
    expect(view.bar.layout).toBe("loss");
    expect(view.bar.lossLabel).toBe("Costs ran $2.12 over what we billed");
    expect(view.bar.segments.map((segment) => segment.key)).toEqual(["cogs", "labels", "pool", "waiting"]);
    expect(view.bar.segments.reduce((total, segment) => total + segment.weight, 0)).toBe(10_000);
    // Billed $20.00 on a scale of $22.12 → the tick sits at 9041 bps.
    expect(view.bar.billedTickWeight).toBe(9_041);
    expect(view.bar.legend.every((entry) => entry.cents === null)).toBe(true);
    expect(view.bar.legend.map((entry) => entry.swatch)).toEqual([null, "cogs", "labels", "pool", "waiting"]);
  });

  it("names a failed answer section and offers no numbers", () => {
    const input = financeSummaryFixtureInput();
    Object.assign(input.answer, { state: "unavailable", status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT" });
    const view = buildFinanceAnswerView(parseFinanceFixture(input));
    expect(view.hero).toBeNull();
    expect(view.errorText).toBe("Couldn't work out what we kept: DROPSHIP_FINANCE_QUERY_TIMEOUT.");
    expect(view.bar.segments).toEqual([]);
    expect(view.hasWorkings).toBe(false);
  });

  it("keeps the split of each dollar when return credits, not orders, make it a loss", () => {
    const input = financeSummaryFixtureInput();
    // The server's §6.4 answer with $30.00 more return credits (program-finance-statement.test.ts):
    // kept on orders stays $38.81, what we kept goes to −$3.59, and the split and bar widths stay.
    Object.assign(input.answer, { state: "loss", kept: { amount: -359, status: "recorded" }, returnCreditsPaid: 5_000 });
    const view = buildFinanceAnswerView(parseFinanceFixture(input));
    expect(view.hero).toMatchObject({ text: `${MINUS}$3.59`, loss: true });
    expect(view.bar.layout).toBe("split");
    expect(view.bar.segments.map((segment) => segment.key)).toEqual(["kept", "cogs", "labels", "pool", "waiting"]);
    expect(view.bar.centsCaption).toBe("of each $1");
    expect(view.bar.legend.map((entry) => entry.cents)).toEqual(["40¢", "39¢", "20¢", "1¢", "·"]);
    expect(view.bar.lossLabel).toBeNull();
    expect(view.bridge).toBe(`$38.81 kept on orders + $7.60 fees we charged ${MINUS} $50.00 return credits we paid = ${MINUS}$3.59 kept`);
  });

  it("says unavailable aloud when what we kept could not be worked out", () => {
    const input = financeSummaryFixtureInput();
    input.answer.kept = { amount: null, status: "unavailable", errorCode: "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE" };
    const view = buildFinanceAnswerView(parseFinanceFixture(input));
    expect(view.hero?.text).toBe(FINANCE_UNAVAILABLE_TEXT);
    expect(view.hero?.spoken).toBe("What we kept, unavailable, before packaging, Stripe fees and overheads");
  });

  it("steps the hero font down for long figures instead of compacting money", () => {
    expect(financeHeroSize("$1,934.10")).toBe("xl");
    expect(financeHeroSize("$1,234,567.89")).toBe("lg");
    expect(financeHeroSize("$12,345,678,901.23")).toBe("md");
  });

  it("titles the card for a vendor in the vendor view", () => {
    const input = financeSummaryFixtureInput();
    input.scope = { vendor: { vendorId: 12, name: "Acme TCG", nameSource: "business_name" } };
    expect(buildFinanceAnswerView(parseFinanceFixture(input)).title).toBe("What we kept from Acme TCG");
  });
});

describe("tiles", () => {
  it("shows the four totals with their deltas and sub-lines", () => {
    const tiles = buildFinanceTilesView(financeSummaryFixture());
    expect(tiles.map((tile) => [tile.label, tile.value, tile.delta?.text ?? null, tile.subLines.map((line) => line.text)])).toEqual([
      ["Billed to vendors", "$187.30", "+$161.30 (+620.4%) vs Sep 1 – 5", ["10 orders"]],
      ["Cash received", "$883.00", `${MINUS}$2,117.00 (${MINUS}70.6%) vs Sep 1 – 5`, ["after disputes · before Stripe's fees"]],
      ["We owe vendors · now", "$3,811.10", null, ["2 vendors", "$190.00 on the way, not yet cash"]],
      ["Vendors owe us · now", "$12.50", null, ["1 vendor below zero"]],
    ]);
    expect(tiles[1].delta?.direction).toBe("down");
    expect(tiles[2].subLines[1].icon).toBe("clock");
  });

  it("drops deltas when compare is off and says 'right now' with the end-of-period balance for a past period", () => {
    const input = financeSummaryFixtureInput();
    input.comparePeriod = null;
    input.period = { ...input.period, endsNow: false, toDate: "2026-09-30", fromDate: "2026-09-01", endAt: "2026-10-01T04:00:00.000Z" };
    input.tiles.weOweNow.atEndOfPeriod = 303_900;
    input.tiles.owedToUsNow.atEndOfPeriod = 1_250;
    const tiles = buildFinanceTilesView(parseFinanceFixture(input));
    expect(tiles.every((tile) => tile.delta === null)).toBe(true);
    expect(tiles[2].label).toBe("We owe vendors · right now");
    expect(tiles[2].subLines.at(-1)?.text).toBe("At end of Sep 30: $3,039.00");
    expect(tiles[3].subLines.at(-1)?.text).toBe("At end of Sep 30: $12.50");
  });

  it("words the delta kinds", () => {
    expect(formatFinanceDelta({ amount: 0, change: 100, changeTenths: null, changeBps: null, kind: "new" }, "Sep 1 – 5")?.text).toBe("New this period");
    expect(formatFinanceDelta({ amount: 0, change: 0, changeTenths: null, changeBps: null, kind: "no_change" }, "Sep 1 – 5")?.text).toBe("No change");
    expect(formatFinanceDelta({ amount: null, change: null, changeTenths: null, changeBps: null, kind: "unavailable" }, "Sep 1 – 5")?.text).toBe("Comparison unavailable");
    expect(formatFinanceDelta({ amount: -50, change: 150, changeTenths: null, changeBps: null, kind: "change" }, "Sep 1 – 5")?.text).toBe("+$1.50 vs Sep 1 – 5");
    expect(formatFinanceDelta(null, "Sep 1 – 5")).toBeNull();
  });

  it("says a failed tile couldn't be worked out instead of claiming no orders or 0 vendors", () => {
    const input = financeSummaryFixtureInput();
    // What the server sends when the orders or wallets query fails: no figure, zeroed counts (tilesOf).
    input.tiles.billed = { amount: null, status: "unavailable", errorCode: QUERY_TIMEOUT, orders: 0, prior: null };
    input.tiles.weOweNow = { amount: null, status: "unavailable", errorCode: QUERY_TIMEOUT, vendors: 0, onTheWay: null, atEndOfPeriod: null };
    input.tiles.owedToUsNow = { amount: null, status: "unavailable", errorCode: QUERY_TIMEOUT, vendors: 0, atEndOfPeriod: null };
    input.tiles.cashReceived = { amount: null, status: "unavailable", errorCode: QUERY_TIMEOUT, prior: null };
    const tiles = buildFinanceTilesView(parseFinanceFixture(input));
    for (const tile of tiles) {
      expect(tile.value, tile.key).toBe(FINANCE_UNAVAILABLE_TEXT);
      expect(tile.subLines.map((line) => line.text), tile.key).toEqual([`Couldn't work this out (${QUERY_TIMEOUT})`]);
      expect(tile.delta, tile.key).toBeNull();
    }
    expect(tiles[2].info).toBeNull();
  });

  it("says No deposits only when nothing came in, not when disputes took a deposit back in full", () => {
    // A $300.00 card deposit settles and the same $300.00 is pulled back by a dispute: the tile nets to $0.00.
    const disputed = financeSummaryFixtureInput();
    disputed.tiles.cashReceived = { amount: 0, status: "recorded", prior: null };
    setLine(disputed, "cash", "cash.received_deposits", { amount: 30_000, count: 1 });
    setLine(disputed, "cash", "cash.pulled_back", { amount: 30_000, count: 1 });
    setLine(disputed, "cash", "cash.won_back", { amount: 0, count: 0 });
    setLine(disputed, "cash", "cash.received", { amount: 0 });
    const cashTile = (input: FinanceSummaryInput) => buildFinanceTilesView(parseFinanceFixture(input))[1];
    expect(cashTile(disputed)).toMatchObject({ value: "$0.00", subLines: [{ text: "after disputes · before Stripe's fees", icon: "none" }] });

    const nothing = financeSummaryFixtureInput();
    nothing.tiles.cashReceived = { amount: 0, status: "recorded", prior: null };
    for (const key of ["cash.received_deposits", "cash.pulled_back", "cash.won_back", "cash.received"]) setLine(nothing, "cash", key, { amount: 0, count: 0 });
    expect(cashTile(nothing).subLines.map((line) => line.text)).toEqual(["No deposits"]);
  });

  it("names the vendor on every tile in the vendor view", () => {
    const input = financeSummaryFixtureInput();
    input.scope = { vendor: { vendorId: 12, name: "Acme TCG", nameSource: "business_name" } };
    expect(buildFinanceTilesView(parseFinanceFixture(input)).map((tile) => tile.label)).toEqual([
      "Billed to Acme TCG", "Cash Acme TCG paid in", "We owe Acme TCG · now", "Acme TCG owes us · now",
    ]);
  });
});

describe("detail rows", () => {
  it("groups the rows under the clocks' captions and hides Vendors in a vendor's view", () => {
    const period = financePeriodWords(financeSummaryFixture().period);
    expect(buildFinanceDetailGroups(period, false).map((group) => [group.caption, group.keys])).toEqual([
      ["Orders accepted Oct 1 – 5", ["sales", "products"]],
      ["Money that moved Oct 1 – 5", ["cash", "returns"]],
      ["Balances", ["owed", "points", "pool"]],
      ["Across the program", ["vendors", "checks"]],
    ]);
    expect(buildFinanceDetailGroups(period, true).at(-1)?.keys).toEqual(["checks"]);
    expect(buildFinanceDetailGroups(null, false)[0].caption).toBe("Orders accepted in this period");
  });

  it("collapses every section to one summary and one amount", () => {
    const summary = financeSummaryFixture();
    expect(FINANCE_SECTION_KEYS.map((key) => {
      const view = buildFinanceSectionRow(summary, key, "summary");
      return [view.title, view.summary, view.amount];
    })).toEqual([
      ["Sales and what we kept", "10 orders · 7 waiting on costs", "$26.41 kept"],
      ["Products sold", "21 packs · 950 pieces · 3 products", "$133.20 billed for product"],
      ["Cash in", "4 deposits · bank, card, USDC, weekly collection", "$883.00 received"],
      ["Returns and credits", "4 credits · $4.50 in return fees", "$37.00 credited"],
      ["What we owe and are owed", "right now · 3 wallets", "$3,811.10 we owe"],
      ["Points (rewards)", "1 point = 1¢ off orders · never paid out", "1,530 points held"],
      ["Insurance pool", "set aside for lost parcels, not profit", `${MINUS}$9.10 in the pool`],
      ["Vendors", "2 vendors ordered · 3 wallets", "Acme TCG kept most"],
    ]);
  });

  it("opens Sales into the statement, with the operator column carrying the direction", () => {
    const view = buildFinanceSectionRow(financeSummaryFixture(), "sales", "summary");
    expect(statementLabels(view)).toEqual([
      "|Billed to vendors · 10 orders|$187.30",
      `${MINUS}|Not yet fully costed · 7 orders|$90.00`,
      "=|Billed on fully costed orders · 3 orders|$97.30",
      `${MINUS}|Cost of goods (what the products cost us)|$37.64`,
      `${MINUS}|Carrier labels|$19.35`,
      `${MINUS}|Insurance pool share (set aside, not ours to keep)|$1.50`,
      "|Packaging|Not recorded",
      "=|Kept on orders · 39.9%|$38.81",
      "+|Fees we charged · day posted|$7.60",
      `${MINUS}|Return credits we paid (not from the pool) · day posted|$20.00`,
      "=|What we kept|$26.41",
    ]);
    const lines = view.statements[0].rows;
    expect(lines[0].subLines).toEqual([
      "product $133.20 · shipping $54.10 (carrier estimate $40.80 · our markup $9.30 · insurance pool share $4.00)",
      "paid from wallets $165.30 · paid with points $22.00 (2,200 points)",
    ]);
    expect(lines[1].subLines[0]).toContain("Shares one label with another order: 2 orders, $33.00");
    expect(lines[4].subLines).toEqual(["of which replacement packages $2.50"]);
    expect(lines[6].info).toBe("Box and mailer costs are not saved per package.");
    expect(lines[7].subLines).toEqual(["on products $37.56 (49.9%) · on shipping $1.25 (6.1%)"]);
    expect(lines.map((line) => line.emphasis)).toEqual(["none", "none", "subtotal", "none", "none", "none", "none", "subtotal", "none", "none", "result"]);
    expect(lines[3].operatorWords).toBe("minus");
    // K2 needs a look and owns the cost of goods; N1 owns billed.
    expect(lines[3].checkDots.map((dot) => dot.checkId)).toEqual(["K2"]);
    expect(lines[0].checkDots.map((dot) => dot.checkId)).toEqual(["N1"]);
  });

  it("hides 'every line' lines that are zero in Summary and shows them in Every line", () => {
    const input = financeSummaryFixtureInput();
    // A zero on these two lines comes from the server marked "every_line" (its everyLineWhenZero).
    for (const line of salesLines(input)) {
      if (line.key === "sales.fees.card" || line.key === "sales.labels.replacement") Object.assign(line, { amount: 0, depth: "every_line" });
    }
    const summaryDepth = row(input, "sales", "summary").statements[0].rows;
    expect(summaryDepth.find((line) => line.key === "sales.fees")?.subLines).toEqual(["advance fees $0.10 · return fees $4.50"]);
    expect(summaryDepth.find((line) => line.key === "sales.labels")?.subLines).toEqual([]);
    const everyLine = row(input, "sales", "every_line").statements[0].rows;
    expect(everyLine.find((line) => line.key === "sales.fees")?.subLines).toEqual(["advance fees $0.10 · card fees $0.00 · return fees $4.50"]);
    expect(everyLine.find((line) => line.key === "sales.labels")?.subLines).toEqual(["of which replacement packages $0.00"]);
  });

  it("lists the Sales memos in plain words", () => {
    const view = buildFinanceSectionRow(financeSummaryFixture(), "sales", "summary");
    expect(view.memos.map((memo) => memo.text)).toEqual([
      "Not taken off what we kept: paid with points $22.00 · staff wallet credits $25.00 · pool-paid credits (the pool covers them) $17.00 · Stripe fees (not recorded) · overheads (not on this page)",
      "For context, not our money: buyers paid $239.93 on eBay and Shopify (1 unknown)",
      "Received Oct 1 – 5 and never charged: 3 orders (1 waiting for payment · 1 payment time ran out · 1 rejected) · would have charged $25.00",
      "Label cost recorded on 7 of 8 packages shipped for orders accepted Oct 1 – 5",
    ]);
  });

  it("reads 'None this period' for fees and credits that are a true zero", () => {
    const input = financeSummaryFixtureInput();
    for (const line of salesLines(input)) {
      if (line.key === "sales.fees" || line.key === "sales.return_credits_cs") line.amount = 0;
    }
    const lines = row(input, "sales").statements[0].rows;
    expect(lines.find((line) => line.key === "sales.fees")?.amount).toBe("None this period");
    expect(lines.find((line) => line.key === "sales.return_credits_cs")?.amount).toBe("None this period");
  });

  it("opens Cash in, Returns, Owed, Points and Pool into their statements", () => {
    const summary = financeSummaryFixture();
    expect(statementLabels(buildFinanceSectionRow(summary, "cash", "summary"))).toEqual([
      "|Bank transfer (ACH) · 1|$500.00",
      "|Card · 1|$103.00",
      "|USDC (digital dollars) · 1|$250.00",
      "|Weekly collection (retired) · 1|$50.00",
      "=|Deposits received|$903.00",
      `${MINUS}|Pulled back by disputes and bank returns · 2|$123.00`,
      "+|Returned to us after disputes we won · 1|$103.00",
      "=|Cash received · before Stripe's fees|$883.00",
    ]);
    expect(statementLabels(buildFinanceSectionRow(summary, "returns", "summary"))).toEqual([
      "|Credited by Card Shellz · 2|$20.00",
      "|Credited from the insurance pool · 2|$17.00",
      `${MINUS}|Return fees charged to vendors|$4.50`,
      "=|Net credited to vendors|$32.50",
    ]);
    const owed = buildFinanceSectionRow(summary, "owed", "summary");
    expect(statementLabels(owed, 0)).toEqual([
      "|We owe vendors (money in their wallets) · 2 vendors|$3,811.10",
      "|Vendors owe us (wallets below zero) · 1 vendor|$12.50",
      "|On the way (sent, not settled, not spendable) · 2|$190.00",
    ]);
    expect(owed.statements[1].heading).toBe("How this changed since Oct 1");
    expect(statementLabels(owed, 1)[0]).toBe("|Owed on Oct 1|$3,026.50");
    expect(statementLabels(owed, 1).at(-1)).toBe("=|Owed now|$3,798.60");
    expect(owed.statements[1].rows.at(-1)?.subLines).toEqual(["we owe $3,811.10 · are owed $12.50"]);
    expect(owed.memos.map((memo) => memo.text)).toEqual(["Each wallet matches its history (3 of 3)"]);
    expect(statementLabels(buildFinanceSectionRow(summary, "points", "summary"))).toEqual([
      "|Held on Oct 1|3,080 points",
      "+|Given on bank and USDC deposits|750 points",
      `${MINUS}|Used to pay for orders|2,200 points`,
      `${MINUS}|Expired|80 points`,
      `${MINUS}|Taken back after disputes|20 points`,
      "+|Given back after disputes we won|0 points",
      "=|Held now|1,530 points",
    ]);
    const pool = buildFinanceSectionRow(summary, "pool", "summary");
    expect(statementLabels(pool).at(-1)).toBe(`=|In the pool now (worked out)|${MINUS}$9.10`);
    expect(pool.statements[0].rows.at(-1)?.negative).toBe(true);
    expect(pool.memos.map((memo) => memo.text)).toEqual([
      "The worked-out pool is below zero: more was paid out of it than was set aside and topped up.",
      "Carrier claims filed: 1 · $9.00 asked · none approved or paid yet",
      `The pool's own record shows ${MINUS}$8.00`,
    ]);
  });

  it("leaves the empty points expiry buckets and automatic top-ups out of Summary, and shows them in Every line", () => {
    const summary = financeSummaryFixture();
    const expiry = (depth: "summary" | "every_line") =>
      buildFinanceSectionRow(summary, "points", depth).memos.find((memo) => memo.key === "points.expiry")?.text;
    expect(expiry("summary")).toBe("Expiring: 31–90 days 250 points · never 1,280 points");
    expect(expiry("every_line")).toBe("Expiring: next 30 days 0 points · 31–90 days 250 points · later 0 points · never 1,280 points");
    const autoTopUps = (depth: "summary" | "every_line") =>
      buildFinanceSectionRow(summary, "cash", depth).memos.find((memo) => memo.key === "cash.memo.auto_top_ups")?.text;
    expect(autoTopUps("summary")).toBeUndefined();
    expect(autoTopUps("every_line")).toBe("Of which automatic top-ups: 0 · $0.00");
  });

  it("lists the Cash in memos, including the failure code as stored", () => {
    const view = buildFinanceSectionRow(financeSummaryFixture(), "cash", "summary");
    expect(view.memos.map((memo) => memo.text)).toEqual([
      "On the way right now: 2 deposits · $190.00 (not yet cash)",
      "Waiting more than 7 days: 1 · $40.00",
      "Failed Oct 1 – 5: 1 · $70.00 (code R01): never counted as cash",
      "Disputes not won back (still open or lost): 1 · $20.00",
      "Staff wallet credits aren't cash: 1 · $25.00, see Returns and credits",
      "Not recorded: Stripe's fees · USDC moved out of deposit addresses",
    ]);
    expect(view.memos[1].checkDots.map((dot) => dot.checkId)).toEqual(["D6"]);
  });

  it("switches a past period's balances to their end-of-period words", () => {
    const input = financeSummaryFixtureInput();
    input.period = { ...input.period, preset: "last-month", fromDate: "2026-09-01", toDate: "2026-09-30", endsNow: false, endAt: "2026-10-01T04:00:00.000Z" };
    const summary = parseFinanceFixture(input);
    expect(statementLabels(buildFinanceSectionRow(summary, "points", "summary")).at(-1)).toBe("=|Held at end of Sep 30|1,530 points");
    expect(statementLabels(buildFinanceSectionRow(summary, "owed", "summary"), 1).at(-1)).toBe("=|Owed on Sep 30|$3,798.60");
    expect(statementLabels(buildFinanceSectionRow(summary, "pool", "summary")).at(-1)).toBe(`=|In the pool at end of Sep 30 (worked out)|${MINUS}$9.10`);
  });

  it("says why a line is not a plain number", () => {
    expect(financeLineNote(parseFinanceFixture(financeSummaryFixtureInput()).sections.sales.lines.find((line) => line.key === "sales.buyer_paid")!))
      .toBe("Some amounts missing: 1 unknown.");
    const unavailable = { ...financeSummaryFixture().sections.sales.lines[0], status: "unavailable" as const, amount: null, errorCode: "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE", reasonKey: "amount_out_of_range" };
    expect(financeLineNote(unavailable)).toBe("Unavailable: this amount is too large to show exactly, so it isn't shown (DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE).");
    expect(formatFinanceLineAmount(unavailable)).toBe("Unavailable");
    const programWide = { ...unavailable, errorCode: undefined, reasonKey: "program_wide" };
    expect(financeLineNote(programWide)).toBe("The pool balance is for the whole program; it isn't split by vendor.");
  });

  it("shows a failed or skipped section as words and a retry, with no numbers", () => {
    const input = financeSummaryFixtureInput();
    input.sections.cash = { status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT", lines: [] };
    input.sections.points = { status: "skipped", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED", lines: [] };
    const summary = parseFinanceFixture(input);
    expect(buildFinanceSectionRow(summary, "cash", "summary")).toMatchObject({
      state: "error", amount: "Couldn't work out", errorText: "Couldn't work out cash in: DROPSHIP_FINANCE_QUERY_TIMEOUT.", statements: [], memos: [],
    });
    expect(buildFinanceSectionRow(summary, "points", "summary")).toMatchObject({ state: "skipped", errorText: "Took too long; try a shorter period." });
    // The other sections still render.
    expect(buildFinanceSectionRow(summary, "sales", "summary").state).toBe("ok");
  });
});

describe("collapsed rows when a source fails or is not split by vendor", () => {
  it("says Unavailable, not Not recorded, when the wallet ledger could not be read", () => {
    const input = financeSummaryFixtureInput();
    // The server's sales section stays ok, with its six ledger lines unavailable (addSalesLedgerLines).
    markUnavailable(salesLines(input), ["sales.fees", "sales.fees.advance", "sales.fees.card", "sales.fees.returns", "sales.return_credits_cs", "sales.kept"], { errorCode: QUERY_TIMEOUT });
    const sales = row(input, "sales");
    expect(sales).toMatchObject({ state: "ok", amount: FINANCE_UNAVAILABLE_TEXT, amountTone: "muted" });
    expect(sales.statements[0].rows.find((line) => line.key === "sales.kept")?.amount).toBe(FINANCE_UNAVAILABLE_TEXT);
  });

  it("says Unavailable for every row whose headline figure failed", () => {
    const input = financeSummaryFixtureInput();
    const cash = input.sections.cash;
    const owed = input.sections.owed;
    const points = input.sections.points;
    const returns = input.sections.returns;
    const products = input.sections.products;
    if (cash.status !== "ok" || owed.status !== "ok" || points.status !== "ok" || returns.status !== "ok" || products.status !== "ok") throw new Error("ok in the golden");
    markUnavailable(cash.lines, ["cash.won_back", "cash.received"], { errorCode: QUERY_TIMEOUT });
    markUnavailable(owed.lines, ["owed.we_owe"], { errorCode: QUERY_TIMEOUT });
    markUnavailable(points.lines, ["points.held"], { errorCode: QUERY_TIMEOUT });
    markUnavailable(returns.lines, ["returns.credited"], { errorCode: QUERY_TIMEOUT });
    markUnavailable(products.lines, ["products.billed"], { errorCode: QUERY_TIMEOUT });
    for (const key of ["cash", "owed", "points", "returns", "products"] as const) {
      expect(row(input, key), key).toMatchObject({ amount: FINANCE_UNAVAILABLE_TEXT, amountTone: "muted" });
    }
  });

  it("keeps Not recorded for a figure Echelon never records", () => {
    const input = financeSummaryFixtureInput();
    for (const line of salesLines(input)) {
      if (line.key === "sales.kept") Object.assign(line, { amount: null, status: "not_recorded", reasonKey: "packaging_not_saved" });
    }
    expect(row(input, "sales")).toMatchObject({ amount: FINANCE_NOT_RECORDED_TEXT, amountTone: "muted" });
  });

  it("says Program-wide for the pool only in a vendor's view, and Unavailable when its record is missing", () => {
    const vendorView = financeSummaryFixtureInput();
    vendorView.scope = { vendor: { vendorId: 12, name: "Acme TCG", nameSource: "business_name" } };
    const vendorPool = vendorView.sections.pool;
    if (vendorPool.status !== "ok") throw new Error("ok in the golden");
    // poolLedgerUnavailable: the vendor view's pool balance is the whole program's.
    markUnavailable(vendorPool.lines, ["pool.opening", "pool.closing", "pool.topped_up", "pool.record"], { reasonKey: "program_wide" });
    expect(row(vendorView, "pool")).toMatchObject({ amount: "Program-wide", amountTone: "muted" });

    const missingTable = financeSummaryFixtureInput();
    const pool = missingTable.sections.pool;
    if (pool.status !== "ok") throw new Error("ok in the golden");
    // The pool's own ledger table is missing in the whole-program view (TABLE_MISSING).
    markUnavailable(pool.lines, ["pool.opening", "pool.closing", "pool.topped_up", "pool.record"], { errorCode: "DROPSHIP_FINANCE_TABLE_MISSING", reasonKey: "table_missing" });
    expect(row(missingTable, "pool")).toMatchObject({ amount: FINANCE_UNAVAILABLE_TEXT, amountTone: "muted" });
  });

  it("counts deposits with the server's own count, never by adding the ways paid", () => {
    expect(row(financeSummaryFixtureInput(), "cash").summary).toBe("4 deposits · bank, card, USDC, weekly collection");
    const input = financeSummaryFixtureInput();
    // The rails still say 1 each; the page shows what the server counted.
    setLine(input, "cash", "cash.received_deposits", { count: 7 });
    expect(row(input, "cash").summary).toBe("7 deposits · bank, card, USDC, weekly collection");
    setLine(input, "cash", "cash.received_deposits", { count: undefined });
    expect(row(input, "cash").summary).toBe("bank, card, USDC, weekly collection");
  });
});

describe("products and vendors tables", () => {
  it("lists the top products, the rounding row and the exact total", () => {
    const table = buildFinanceProductsTable(financeSummaryFixture());
    expect(table?.rows.map((entry) => [entry.product, entry.detail, entry.packs, entry.billed, entry.billedFullyCosted, entry.costOfGoods, entry.kept])).toEqual([
      ["Toploaders", "3x4 · 25 · TL-35-25", "14", "$84.20", "$55.20", "$31.43", "$23.77"],
      ["Penny sleeves", "100 · PS-100", "6", "$44.00", "$20.00", "$6.22", "$13.78"],
      ["Not linked to a catalog item", "MYSTERY-1", "1", "$5.00", "$0.00", "$0.00", "$0.00"],
    ]);
    expect(table?.rounding).toEqual({ costOfGoods: `${MINUS}$0.01`, kept: "+$0.01" });
    expect(table?.total).toMatchObject({ packs: "21", billed: "$133.20", costOfGoods: "$37.64", kept: "$37.56" });
    expect(table?.footer).toEqual([
      "Cost and kept cover packs on fully costed orders (11 of 21 packs)",
      "18 of 21 packs shipped",
      "pieces not recorded on 1 line",
    ]);
  });

  it("counts the products folded into 'All other products'", () => {
    const input = financeSummaryFixtureInput();
    const products = input.sections.products;
    products.others = { ...products.top[2], groupKey: "others" };
    products.lines = products.lines.map((line) => (line.key === "products.count" ? { ...line, amount: 37 } : line));
    expect(buildFinanceProductsTable(parseFinanceFixture(input))?.others?.product).toBe("All other products (34)");
  });

  it("lists the vendors and a totals row that equals the page", () => {
    const table = buildFinanceVendorsTable(financeSummaryFixture());
    expect(table?.rows.map((entry) => [entry.vendorId, entry.name, entry.orders, entry.billed, entry.kept, entry.weOwe, entry.theyOwe])).toEqual([
      [12, "Acme TCG", "5", "$117.30", "$19.21", "$3,568.60", "$0.00"],
      [13, "PackRat", "5", "$70.00", "$7.19", "$242.50", "$0.00"],
      [14, "Vendor #14", "0", "$0.00", "$0.00", "$0.00", "$12.50"],
    ]);
    expect(table?.rounding).toEqual({ kept: "+$0.01" });
    // Rows ($26.40) + rounding (+$0.01) = the page's kept ($26.41).
    expect(table?.total).toEqual({ label: "Total · 3 vendors", orders: "10", billed: "$187.30", kept: "$26.41", weOwe: "$3,811.10", theyOwe: "$12.50" });
  });

  it("shows no table for a failed section", () => {
    const input = financeSummaryFixtureInput();
    input.sections.products = { ...input.sections.products, status: "error", errorCode: "DROPSHIP_FINANCE_SCHEMA_MISMATCH", lines: [], top: [], others: null, total: null };
    expect(buildFinanceProductsTable(parseFinanceFixture(input))).toBeNull();
  });
});

describe("checks", () => {
  it("counts the checks, opens the groups that need a look and words each result", () => {
    const view = buildFinanceChecksView(financeSummaryFixture());
    expect(view).toMatchObject({ summary: "23 of 27 fine", amount: "4 need a look", tone: "attention", chip: "4 need a look", scopeNote: null });
    expect(view.groups.map((group) => [group.title, group.countText, group.defaultOpen])).toEqual([
      ["Wallets", "4 of 4 fine", false],
      ["Orders", "6 of 6 fine", false],
      ["Deposits", "6 of 7 fine", true],
      ["Costs", "2 of 3 fine", true],
      ["Returns and pool", "2 of 2 fine", false],
      ["Should never happen", "1 of 3 fine", true],
      ["Page", "2 of 2 fine", false],
    ]);
    const k2 = view.groups[3].checks.find((check) => check.id === "K2");
    expect(k2).toEqual({
      id: "K2", tone: "attention", word: "Needs a look",
      wording: "Cost-of-goods rows add up, and every picked or shipped line has a cost",
      detail: "1 of 10 needs a look",
    });
  });

  it("reads 'All 27 checks fine' when every check passes, and counts a couldn't-check apart", () => {
    const input = financeSummaryFixtureInput();
    input.checks = input.checks.map((check) => ({ ...check, result: "fine" as const, exceptions: 0 }));
    expect(buildFinanceChecksView(parseFinanceFixture(input))).toMatchObject({ amount: "All fine", chip: "All 27 checks fine", tone: "fine" });
    input.checks[3] = financeFixtureCheck("W4", { result: "could_not_check", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED", exceptions: 0 });
    const view = buildFinanceChecksView(parseFinanceFixture(input));
    expect(view).toMatchObject({ amount: "1 couldn't check", chip: "26 of 27 checks fine", tone: "unknown" });
    expect(view.groups[0].checks[3]).toMatchObject({ word: "Couldn't check", detail: "(DROPSHIP_FINANCE_BUDGET_EXCEEDED)" });
  });

  it("leaves program-wide checks out of a vendor's count and says why", () => {
    const input = financeSummaryFixtureInput();
    input.scope = { vendor: { vendorId: 12, name: "Acme TCG", nameSource: "business_name" } };
    input.checks = input.checks.map((check) => {
      if (check.id === "N2" || check.id === "P2") return financeFixtureCheck(check.id, { result: "program_wide", exceptions: 0 });
      if (check.id === "K2") return financeFixtureCheck("K2");
      return financeFixtureCheck(check.id, { result: "fine", exceptions: 0 });
    });
    const view = buildFinanceChecksView(parseFinanceFixture(input));
    expect(view).toMatchObject({ summary: "24 of 25 fine", amount: "1 needs a look", chip: "1 needs a look for Acme TCG" });
    expect(view.groups.find((group) => group.group === "never")?.checks.find((check) => check.id === "N2"))
      .toMatchObject({ tone: "program", word: "Program-wide: see all vendors" });
    expect(view.scopeNote).toContain("Acme TCG");
  });

  it("words the information lines with their amounts", () => {
    const view = buildFinanceChecksView(financeSummaryFixture());
    expect(view.info.map((line) => line.text)).toEqual([
      `Why the Overview dashboard shows a different Dropship total: its 'Dropship OMS' row $189.30 ${MINUS} billed here $187.30 = leftover pending orders $10.00 + orders cancelled in OMS ${MINUS}$8.00 + order date vs accepted date difference $0.00`,
      `The pool's own record shows ${MINUS}$8.00; the worked-out balance is ${MINUS}$9.10 because order contributions and carrier-fault payouts are never written to it`,
      "Cash returned (disputed amounts) $103.00 vs wallet restored $100.00; the difference is card fee part (dispute above the credit) $3.00 · points recovered from cash $0.00",
    ]);
  });

  it("words the Overview bridge in three parts", () => {
    const input = financeSummaryFixtureInput();
    const bridge = input.info.find((entry) => entry.key === "overview_bridge");
    if (!bridge) throw new Error("the golden has an Overview bridge");
    bridge.lines = [
      financeFixtureLine("info.overview_bridge.oms_row", 20_530),
      financeFixtureLine("info.overview_bridge.billed", 18_730),
      financeFixtureLine("info.overview_bridge.leftover_pending", 2_500),
      financeFixtureLine("info.overview_bridge.cancelled_in_oms", -800),
      financeFixtureLine("info.overview_bridge.date_basis", 100),
    ];
    expect(buildFinanceChecksView(parseFinanceFixture(input)).info.find((line) => line.key === "overview_bridge")?.text).toBe(
      `Why the Overview dashboard shows a different Dropship total: its 'Dropship OMS' row $205.30 ${MINUS} billed here $187.30 = leftover pending orders $25.00 + orders cancelled in OMS ${MINUS}$8.00 + order date vs accepted date difference $1.00`,
    );
  });
});

describe("How this is worked out", () => {
  it("renders the server's steps for what we kept, never recomputing them", () => {
    const summary = financeSummaryFixture();
    expect(financeWorkingsKeys(summary)).toEqual([
      "answer.kept", "sales.billed_fc", "sales.kept_orders", "sales.kept", "cash.received", "returns.net", "points.held", "pool.closing",
    ]);
    const view = buildFinanceHowView(summary, "answer.kept");
    expect(view).toMatchObject({ title: "What we kept", amount: "$26.41", chip: "day accepted" });
    expect(view?.steps.map((step) => [step.step, step.title, step.result])).toEqual([
      [1, "Orders count on the day we accepted them. Money counts on the day it moved. Eastern time.", null],
      [2, "Billed on fully costed orders", "$97.30"],
      [3, "Kept on orders", "$38.81"],
      [4, "Cost of goods is today's cost of the stock each order used, oldest stock first.", null],
      [5, "What we kept", "$26.41"],
      [6, "Kept on orders as a share of what we billed on fully costed orders", "39.9%"],
      [7, "The same share for the comparison period, measured as of now", "40.4%"],
      [8, "Change in that share, in points", `${MINUS}0.5 pts`],
      [9, "Not included: packaging, Stripe's fees and overheads, which Echelon does not record. Points used are shown beside what we kept, not taken off.", null],
    ]);
    const operands = (index: number) => view?.steps[index].operands.map((operand) => `${operand.operatorSymbol}${operand.label} ${operand.amount}`);
    expect(operands(1)).toEqual(["Billed to vendors $187.30", `${MINUS}Not yet fully costed $90.00`]);
    expect(operands(4)).toEqual(["Kept on orders $38.81", "+Fees we charged $7.60", `${MINUS}Return credits we paid (not from the pool) $20.00`]);
    expect(operands(2)).toEqual([
      "Billed on fully costed orders $97.30",
      `${MINUS}Cost of goods (what the products cost us) $37.64`,
      `${MINUS}Carrier labels $19.35`,
      `${MINUS}Insurance pool share (set aside, not ours to keep) $1.50`,
    ]);
    expect(view?.technicalSource.tables.length).toBeGreaterThan(0);
  });

  it("shows the margin, the comparison share and the change in the units the server sends, with each period's dates", () => {
    const summary = financeSummaryFixture();
    const steps = buildFinanceHowView(summary, "answer.kept")?.steps ?? [];
    const labelled = (step: number) => steps[step - 1].operands.map((operand) => `${operand.operatorSymbol}${operand.label} ${operand.amount}`);
    // This period's figures alone carry no dates; next to the comparison period's, both say which days they cover.
    expect(labelled(6)).toEqual(["Kept on orders $38.81", "Billed on fully costed orders $97.30"]);
    expect(labelled(7)).toEqual(["Kept on orders (Sep 1 – 5) $10.50", "Billed on fully costed orders (Sep 1 – 5) $26.00"]);
    expect(labelled(8)).toEqual(["Kept on orders as a share (Oct 1 – 5) 39.9%", `${MINUS}Kept on orders as a share (Sep 1 – 5) 40.4%`]);
    // The drawer shows the card's own figures: nothing is worked out again in the browser.
    const answer = buildFinanceAnswerView(summary);
    expect(answer.margin?.text.startsWith(steps[5].result ?? "")).toBe(true);
    expect(answer.margin?.change?.text.startsWith(steps[7].result ?? "")).toBe(true);
  });

  it("shows a share of nothing as a dash when the comparison period had no fully costed orders", () => {
    const input = financeSummaryFixtureInput();
    // What the server sends then: a null comparison share, so a null change and a null second operand.
    input.answer.priorMarginTenths = null;
    input.answer.marginChangeTenths = null;
    input.answer.workings = input.answer.workings.map((step) => {
      if (step.textKey === "working.margin_prior") {
        return { ...step, result: null, operands: step.operands.map((operand) => ({ ...operand, amount: 0 })) };
      }
      if (step.textKey === "working.margin_change") {
        return { ...step, result: null, operands: step.operands.map((operand) => (operand.period === "compare" ? { ...operand, amount: null } : operand)) };
      }
      return step;
    });
    const steps = buildFinanceHowView(parseFinanceFixture(input), "answer.kept")?.steps ?? [];
    expect(steps[6]).toMatchObject({ title: "The same share for the comparison period, measured as of now", result: "—" });
    expect(steps[7].result).toBe("—");
    expect(steps[7].operands.map((operand) => operand.amount)).toEqual(["39.9%", "—"]);
  });

  it("writes a points working in points, not money", () => {
    const view = buildFinanceHowView(financeSummaryFixture(), "points.held");
    expect(view).toMatchObject({ title: "Held now", amount: "1,530 points" });
    expect(view?.steps.map((step) => step.result)).toEqual(["1,530 points"]);
    expect(view?.steps[0].operands.map((operand) => `${operand.operatorSymbol}${operand.amount}`)).toEqual([
      "3,080 points", "+750 points", `${MINUS}2,200 points`, `${MINUS}80 points`, `${MINUS}20 points`, "+0 points",
    ]);
  });

  it("formats every working unit the contract has", () => {
    expect(formatFinanceWorkingFigure(193_410, "cents")).toBe("$1,934.10");
    expect(formatFinanceWorkingFigure(1_530, "points")).toBe("1,530 points");
    expect(formatFinanceWorkingFigure(12_110, "count")).toBe("12,110");
    expect(formatFinanceWorkingFigure(399, "share_tenths")).toBe("39.9%");
    expect(formatFinanceWorkingFigure(-5, "share_change_tenths")).toBe(`${MINUS}0.5 pts`);
    expect(formatFinanceWorkingFigure(null, "share_tenths")).toBe("—");
    expect(formatFinanceWorkingFigure(null, "cents")).toBe(FINANCE_NOT_RECORDED_TEXT);
  });

  it("renders a line's own workings and has no drawer for a line without them", () => {
    const summary = financeSummaryFixture();
    const cash = buildFinanceHowView(summary, "cash.received");
    expect(cash).toMatchObject({ title: "Cash received · before Stripe's fees", amount: "$883.00", chip: "day it settled" });
    expect(cash?.steps.map((step) => [step.title, step.result])).toEqual([["Cash received · before Stripe's fees", "$883.00"]]);
    expect(buildFinanceHowView(summary, "sales.cogs")).toBeNull();
  });
});

describe("How this page counts", () => {
  it("lists every line key's plain definition and technical source, with no braces left", () => {
    const view = buildFinanceCountingView();
    const keys = view.groups.flatMap((group) => group.entries.map((entry) => entry.key));
    for (const key of FINANCE_SECTION_KEYS.flatMap((section) => FINANCE_SECTION_LINE_KEYS[section])) expect(keys).toContain(key);
    for (const entry of view.groups.flatMap((group) => group.entries)) {
      expect(entry.words).not.toMatch(/[{}]/);
      expect(entry.definition.length).toBeGreaterThan(0);
    }
    expect(view.moneyPath[0]).toBe("Vendors pay in");
    expect(view.choices.filter((choice) => choice.needsSignOff).map((choice) => choice.key)).toEqual(["dispute_cash"]);
    expect(view.basisNotes.map((note) => note.key)).toEqual(expect.arrayContaining(["current_cost", "buyers_paid", "advance", "pool_record_incomplete"]));
    expect(view.eraNotes).toHaveLength(3);
    expect(FINANCE_LINE_DEFINITIONS["sales.kept"].words).toBe("What we kept");
  });
});
