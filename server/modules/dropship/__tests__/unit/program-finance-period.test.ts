import { describe, expect, it } from "vitest";
import {
  FINANCE_EARLIEST_DATE,
  financeLocalDateOf,
  financeWallClockToInstant,
  resolveFinancePeriod,
  toFinanceWindow,
  type FinanceLocalWindow,
} from "../../domain/program-finance-period";
import type { FinancePeriodPreset } from "../../../../../shared/dropship/program-finance";

const TZ = "America/New_York";
const at = (iso: string) => new Date(iso);
const resolve = (preset: FinancePeriodPreset, now: string, from?: string, to?: string) =>
  resolveFinancePeriod(preset, from, to, at(now), TZ);
const iso = (date: Date | null) => (date === null ? null : date.toISOString());

function window(w: FinanceLocalWindow) {
  return {
    fromDate: w.fromDate,
    toDate: w.toDate,
    startLocal: w.startLocal,
    endLocal: w.endLocal,
    startAt: iso(w.startAt),
    endAt: iso(w.endAt),
    endsNow: w.endsNow,
    clampedToMonthEnd: w.clampedToMonthEnd,
  };
}

function refusal(run: () => unknown): { code: string; reason: unknown } {
  try {
    run();
  } catch (error) {
    const e = error as { code: string; context?: { reason?: unknown } };
    return { code: e.code, reason: e.context?.reason };
  }
  throw new Error("expected a refusal");
}

describe("resolveFinancePeriod: this month so far (contract §6.1)", () => {
  it("runs from the 1st to now and compares with the same span of last month", () => {
    const period = resolve("mtd", "2026-10-05T13:14:00.000Z");
    expect(period.today).toBe("2026-10-05");
    expect(window(period.current)).toEqual({
      fromDate: "2026-10-01", toDate: "2026-10-05",
      startLocal: "2026-10-01T00:00:00.000",
      // The natural end, after now: Q0 turns it into the 'infinity' bound (C6).
      endLocal: "2026-10-06T00:00:00.000",
      startAt: "2026-10-01T04:00:00.000Z", endAt: "2026-10-05T13:14:00.000Z",
      endsNow: true, clampedToMonthEnd: false,
    });
    expect(window(period.compare as FinanceLocalWindow)).toEqual({
      fromDate: "2026-09-01", toDate: "2026-09-05",
      startLocal: "2026-09-01T00:00:00.000", endLocal: "2026-09-05T09:14:00.000",
      startAt: "2026-09-01T04:00:00.000Z", endAt: "2026-09-05T13:14:00.000Z",
      endsNow: false, clampedToMonthEnd: false,
    });
  });

  it("changes month at Eastern midnight, not UTC midnight", () => {
    const september = resolve("mtd", "2026-10-01T03:59:59.000Z");
    expect(september.today).toBe("2026-09-30");
    expect([september.current.fromDate, september.current.toDate]).toEqual(["2026-09-01", "2026-09-30"]);

    const october = resolve("mtd", "2026-10-01T04:00:00.000Z");
    expect([october.current.fromDate, october.current.toDate]).toEqual(["2026-10-01", "2026-10-01"]);
    expect(iso(october.current.startAt)).toBe("2026-10-01T04:00:00.000Z");
    expect(october.compare?.endLocal).toBe("2026-09-01T00:00:00.000");
  });

  it("clamps the comparison to the end of a shorter month", () => {
    const march31 = resolve("mtd", "2026-03-31T13:00:00.000Z");
    expect(window(march31.compare as FinanceLocalWindow)).toEqual({
      fromDate: "2026-02-01", toDate: "2026-02-28",
      startLocal: "2026-02-01T00:00:00.000", endLocal: "2026-03-01T00:00:00.000",
      startAt: "2026-02-01T05:00:00.000Z", endAt: "2026-03-01T05:00:00.000Z",
      endsNow: false, clampedToMonthEnd: true,
    });

    // March 28 exists in February: no clamp, same time of day (09:00 EDT now, 09:00 EST then).
    const march28 = resolve("mtd", "2026-03-28T13:00:00.000Z");
    expect(march28.compare?.endLocal).toBe("2026-02-28T09:00:00.000");
    expect(iso(march28.compare?.endAt ?? null)).toBe("2026-02-28T14:00:00.000Z");
    expect(march28.compare?.clampedToMonthEnd).toBe(false);
  });

  it("keeps the clock's milliseconds in the comparison's end", () => {
    const period = resolve("mtd", "2026-10-05T13:14:27.123Z");
    expect(period.compare?.endLocal).toBe("2026-09-05T09:14:27.123");
    expect(iso(period.current.endAt)).toBe("2026-10-05T13:14:27.123Z");
  });
});

describe("resolveFinancePeriod: the other presets", () => {
  it("quarter so far compares with the same span of the previous quarter", () => {
    const period = resolve("qtd", "2026-10-05T13:14:00.000Z");
    expect([period.current.fromDate, period.current.toDate, period.current.endsNow]).toEqual(["2026-10-01", "2026-10-05", true]);
    expect([period.compare?.fromDate, period.compare?.toDate, period.compare?.endLocal]).toEqual(["2026-07-01", "2026-07-05", "2026-07-05T09:14:00.000"]);

    // Third month of the quarter: Dec 31 → Sep 31 does not exist, so the comparison is all of Q3.
    const december = resolve("qtd", "2026-12-31T17:00:00.000Z");
    expect([december.compare?.fromDate, december.compare?.toDate, december.compare?.endLocal, december.compare?.clampedToMonthEnd])
      .toEqual(["2026-07-01", "2026-09-30", "2026-10-01T00:00:00.000", true]);
  });

  it("year so far on Feb 29 clamps last year's comparison to Feb 28", () => {
    const period = resolve("ytd", "2028-02-29T15:00:00.000Z");
    expect([period.current.fromDate, period.current.toDate]).toEqual(["2028-01-01", "2028-02-29"]);
    expect(window(period.compare as FinanceLocalWindow)).toMatchObject({
      fromDate: "2027-01-01", toDate: "2027-02-28", endLocal: "2027-03-01T00:00:00.000", clampedToMonthEnd: true,
    });
  });

  it("last 30 days is today and the 29 before, compared with the 30 days before to the same time", () => {
    const period = resolve("last-30", "2026-10-05T13:14:00.000Z");
    expect([period.current.fromDate, period.current.toDate, period.current.startLocal]).toEqual(["2026-09-06", "2026-10-05", "2026-09-06T00:00:00.000"]);
    expect([period.compare?.fromDate, period.compare?.toDate, period.compare?.endLocal]).toEqual(["2026-08-07", "2026-09-05", "2026-09-05T09:14:00.000"]);
  });

  it("last month is the whole previous month, ending before now", () => {
    const period = resolve("last-month", "2026-10-05T13:14:00.000Z");
    expect(window(period.current)).toEqual({
      fromDate: "2026-09-01", toDate: "2026-09-30",
      startLocal: "2026-09-01T00:00:00.000", endLocal: "2026-10-01T00:00:00.000",
      startAt: "2026-09-01T04:00:00.000Z", endAt: "2026-10-01T04:00:00.000Z",
      endsNow: false, clampedToMonthEnd: false,
    });
    expect([period.compare?.fromDate, period.compare?.toDate, period.compare?.endLocal]).toEqual(["2026-08-01", "2026-08-31", "2026-09-01T00:00:00.000"]);

    const january = resolve("last-month", "2027-01-10T15:00:00.000Z");
    expect([january.current.fromDate, january.current.toDate, january.compare?.fromDate]).toEqual(["2026-12-01", "2026-12-31", "2026-11-01"]);
  });

  it("all time has no start and nothing to compare with", () => {
    const period = resolve("all", "2026-10-05T13:14:00.000Z");
    expect(window(period.current)).toEqual({
      fromDate: null, toDate: "2026-10-05", startLocal: null, endLocal: "2026-10-06T00:00:00.000",
      startAt: null, endAt: "2026-10-05T13:14:00.000Z", endsNow: true, clampedToMonthEnd: false,
    });
    expect(period.compare).toBeNull();
  });
});

describe("resolveFinancePeriod: custom", () => {
  it("compares with an equal-length window immediately before", () => {
    const period = resolve("custom", "2026-10-05T13:14:00.000Z", "2026-09-10", "2026-09-19");
    expect(window(period.current)).toMatchObject({
      fromDate: "2026-09-10", toDate: "2026-09-19", endLocal: "2026-09-20T00:00:00.000", endsNow: false,
    });
    expect(window(period.compare as FinanceLocalWindow)).toMatchObject({
      fromDate: "2026-08-31", toDate: "2026-09-09", startLocal: "2026-08-31T00:00:00.000", endLocal: "2026-09-10T00:00:00.000",
    });
  });

  it("accepts an end of today in Eastern time while UTC is already tomorrow, and compares to the same time", () => {
    const period = resolve("custom", "2026-10-06T02:00:00.000Z", "2026-10-01", "2026-10-05");
    expect(period.today).toBe("2026-10-05");
    expect([period.current.endsNow, iso(period.current.endAt)]).toEqual([true, "2026-10-06T02:00:00.000Z"]);
    expect([period.compare?.fromDate, period.compare?.toDate, period.compare?.endLocal]).toEqual(["2026-09-26", "2026-09-30", "2026-09-30T22:00:00.000"]);
  });

  it("spans 23 hours on the spring-forward day and 25 on the fall-back day", () => {
    const now = "2026-11-10T13:14:00.000Z";
    const spring = resolve("custom", now, "2026-03-08", "2026-03-08");
    expect([spring.current.startLocal, spring.current.endLocal]).toEqual(["2026-03-08T00:00:00.000", "2026-03-09T00:00:00.000"]);
    expect([iso(spring.current.startAt), iso(spring.current.endAt)]).toEqual(["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
    expect((spring.current.endAt.getTime() - (spring.current.startAt as Date).getTime()) / 3_600_000).toBe(23);

    const fall = resolve("custom", now, "2026-11-01", "2026-11-01");
    expect([iso(fall.current.startAt), iso(fall.current.endAt)]).toEqual(["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
    expect((fall.current.endAt.getTime() - (fall.current.startAt as Date).getTime()) / 3_600_000).toBe(25);
    // §6.4: orders at 11-01 04:30Z and 11-02 04:30Z are in; 11-02 05:00Z is out.
    const inWindow = (instant: string) => at(instant) >= (fall.current.startAt as Date) && at(instant) < fall.current.endAt;
    expect([inWindow("2026-11-01T04:30:00Z"), inWindow("2026-11-02T04:30:00Z"), inWindow("2026-11-02T05:00:00Z")]).toEqual([true, true, false]);
  });

  it.each([
    ["from after to", "2026-10-03", "2026-10-02", "from_after_to"],
    ["an end after today in Eastern time", "2026-10-01", "2026-10-06", "to_after_today"],
    ["a day February does not have", "2026-02-01", "2026-02-30", "not_a_date"],
    ["a thirteenth month", "2026-13-01", "2026-13-02", "not_a_date"],
    ["a malformed date", "2026-2-01", "2026-02-02", "not_a_date"],
    ["a start before the earliest day", "1999-12-31", "2000-01-02", "before_earliest_date"],
  ])("refuses %s", (_label, from, to, reason) => {
    expect(refusal(() => resolve("custom", "2026-10-06T02:00:00.000Z", from, to))).toEqual({ code: "DROPSHIP_FINANCE_INVALID_PERIOD", reason });
  });

  it("accepts the earliest day itself", () => {
    expect(resolve("custom", "2026-10-05T13:14:00.000Z", FINANCE_EARLIEST_DATE, "2000-01-31").current.fromDate).toBe(FINANCE_EARLIEST_DATE);
  });

  it("needs both dates with custom and no dates with any other preset", () => {
    expect(refusal(() => resolve("custom", "2026-10-05T13:14:00.000Z", "2026-10-01"))).toEqual({ code: "DROPSHIP_FINANCE_INVALID_PERIOD", reason: "custom_needs_dates" });
    expect(refusal(() => resolve("mtd", "2026-10-05T13:14:00.000Z", "2026-10-01", "2026-10-02"))).toEqual({ code: "DROPSHIP_FINANCE_INVALID_PERIOD", reason: "dates_only_with_custom" });
    expect(refusal(() => resolve("all", "2026-10-05T13:14:00.000Z", undefined, "2026-10-02"))).toEqual({ code: "DROPSHIP_FINANCE_INVALID_PERIOD", reason: "dates_only_with_custom" });
    expect(refusal(() => resolveFinancePeriod("this-month" as FinancePeriodPreset, undefined, undefined, at("2026-10-05T13:14:00Z"), TZ)))
      .toEqual({ code: "DROPSHIP_FINANCE_INVALID_PERIOD", reason: "unknown_preset" });
  });

  it("treats a bad clock or zone as a server bug", () => {
    expect(refusal(() => resolveFinancePeriod("mtd", undefined, undefined, new Date("nope"), TZ)).code).toBe("DROPSHIP_FINANCE_INTERNAL_ERROR");
    expect(refusal(() => resolveFinancePeriod("mtd", undefined, undefined, at("2026-10-05T13:14:00Z"), "Not/AZone")).code).toBe("DROPSHIP_FINANCE_INTERNAL_ERROR");
  });
});

describe("wall clock and instants", () => {
  it("resolves times inside a daylight-saving change the way Postgres does", () => {
    // Verified against Postgres 16 `timestamp AT TIME ZONE 'America/New_York'`.
    expect(financeWallClockToInstant("2026-11-01T01:30:00.000", TZ).toISOString()).toBe("2026-11-01T06:30:00.000Z");
    expect(financeWallClockToInstant("2026-03-08T02:30:00.000", TZ).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(financeWallClockToInstant("2026-11-01T00:00:00.000", TZ).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(financeWallClockToInstant("2026-11-02T00:00:00.000", TZ).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("gives a comparison that ends at 2:30 AM on the spring-forward day that same rule", () => {
    // 02:30 EDT on Apr 8 compares with Mar 8 02:30, a time Eastern clocks skipped.
    const period = resolve("mtd", "2026-04-08T06:30:00.000Z");
    expect(period.compare?.endLocal).toBe("2026-03-08T02:30:00.000");
    expect(iso(period.compare?.endAt ?? null)).toBe("2026-03-08T07:30:00.000Z");
  });

  it("reads the Eastern day of an instant and refuses malformed wall-clock text", () => {
    expect(financeLocalDateOf(at("2026-10-06T02:00:00Z"), TZ)).toBe("2026-10-05");
    expect(financeLocalDateOf(at("2026-10-06T04:00:00Z"), TZ)).toBe("2026-10-06");
    expect(refusal(() => financeWallClockToInstant("2026-10-06T00:00", TZ)).code).toBe("DROPSHIP_FINANCE_INTERNAL_ERROR");
    expect(refusal(() => financeWallClockToInstant("2026-02-30T00:00:00.000", TZ)).code).toBe("DROPSHIP_FINANCE_INTERNAL_ERROR");
  });
});

describe("determinism", () => {
  it("gives the same windows for the same inputs and never changes the clock it was given", () => {
    const now = at("2026-10-05T13:14:00.000Z");
    const first = resolveFinancePeriod("mtd", undefined, undefined, now, TZ);
    const second = resolveFinancePeriod("mtd", undefined, undefined, now, TZ);
    expect(second).toEqual(first);
    expect(now.toISOString()).toBe("2026-10-05T13:14:00.000Z");
    expect(first.now).not.toBe(now);
    expect(Object.isFrozen(first.current)).toBe(true);
  });

  it("maps a window to the contract's shape", () => {
    const period = resolve("mtd", "2026-10-05T13:14:00.000Z");
    expect(toFinanceWindow(period.current)).toEqual({
      preset: "mtd", fromDate: "2026-10-01", toDate: "2026-10-05",
      startAt: period.current.startAt, endAt: period.current.endAt, endsNow: true, clampedToMonthEnd: false,
    });
  });
});
