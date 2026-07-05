import { describe, expect, it } from "vitest";
import { addBusinessDays, deliveryWindow, resolveShipDate } from "../../domain/eta";

/**
 * Calendar anchors (July 2026, America/New_York = EDT = UTC-4):
 *   Wed 2026-07-08 | Thu 07-09 | Fri 07-10 | Sat 07-11 | Sun 07-12 | Mon 07-13
 * The LEON warehouse convention: cutoff 12:00 America/New_York.
 */
const NY = "America/New_York";
const CUTOFF_NOON = "12:00";

/** The instant's calendar day in `tz`, as "yyyy-mm-dd" (en-CA formats ISO). */
function localDay(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

// ---------------------------------------------------------------------------
// resolveShipDate — cutoff + weekend semantics in the warehouse's timezone
// ---------------------------------------------------------------------------

describe("resolveShipDate", () => {
  it("ships same day at 11:59 local, next business day at 12:01 local", () => {
    // 15:59Z = 11:59 EDT Wednesday — before cutoff.
    const before = resolveShipDate(new Date("2026-07-08T15:59:00Z"), CUTOFF_NOON, NY);
    expect(localDay(before, NY)).toBe("2026-07-08");

    // 16:01Z = 12:01 EDT Wednesday — after cutoff → Thursday.
    const after = resolveShipDate(new Date("2026-07-08T16:01:00Z"), CUTOFF_NOON, NY);
    expect(localDay(after, NY)).toBe("2026-07-09");
  });

  it("rolls AT the cutoff minute (>= semantics, mirrors sort-rank)", () => {
    // 16:00Z = 12:00 EDT exactly.
    const atCutoff = resolveShipDate(new Date("2026-07-08T16:00:00Z"), CUTOFF_NOON, NY);
    expect(localDay(atCutoff, NY)).toBe("2026-07-09");
  });

  it("evaluates the cutoff in LOCAL time, not UTC (the UTC-vs-local trap)", () => {
    // 14:30Z is past 12:00 UTC but only 10:30 EDT — still before the local
    // cutoff; a UTC-clock implementation would wrongly roll to Thursday.
    const trap = resolveShipDate(new Date("2026-07-08T14:30:00Z"), CUTOFF_NOON, NY);
    expect(localDay(trap, NY)).toBe("2026-07-08");
  });

  it("uses the LOCAL calendar day when UTC has already flipped to tomorrow", () => {
    // 2026-07-09T02:00Z = Wednesday 22:00 EDT. No cutoff → ships Wednesday,
    // even though the UTC calendar already reads Thursday.
    const lateNight = resolveShipDate(new Date("2026-07-09T02:00:00Z"), null, NY);
    expect(localDay(lateNight, NY)).toBe("2026-07-08");
  });

  it("Friday after cutoff rolls over the weekend to Monday", () => {
    // 17:00Z = 13:00 EDT Friday.
    const friday = resolveShipDate(new Date("2026-07-10T17:00:00Z"), CUTOFF_NOON, NY);
    expect(localDay(friday, NY)).toBe("2026-07-13");
  });

  it("weekend orders ship Monday regardless of cutoff", () => {
    const saturday = resolveShipDate(new Date("2026-07-11T13:00:00Z"), CUTOFF_NOON, NY);
    expect(localDay(saturday, NY)).toBe("2026-07-13");
    const sundayNoCutoff = resolveShipDate(new Date("2026-07-12T13:00:00Z"), null, NY);
    expect(localDay(sundayNoCutoff, NY)).toBe("2026-07-13");
  });

  it("null or malformed cutoff behaves as no cutoff (ships the placed business day)", () => {
    for (const cutoff of [null, "25:99", "noon", ""]) {
      const shipped = resolveShipDate(new Date("2026-07-08T22:00:00Z"), cutoff, NY);
      expect(localDay(shipped, NY)).toBe("2026-07-08");
    }
  });
});

// ---------------------------------------------------------------------------
// addBusinessDays — weekend-skipping calendar ladder
// ---------------------------------------------------------------------------

describe("addBusinessDays", () => {
  const wednesday = new Date(Date.UTC(2026, 6, 8, 12)); // Wed 2026-07-08

  const utcDay = (d: Date) => d.toISOString().slice(0, 10);

  it("adds within the same week", () => {
    expect(utcDay(addBusinessDays(wednesday, 2))).toBe("2026-07-10"); // Friday
  });

  it("skips weekends", () => {
    expect(utcDay(addBusinessDays(wednesday, 3))).toBe("2026-07-13"); // Monday
    const friday = new Date(Date.UTC(2026, 6, 10, 12));
    expect(utcDay(addBusinessDays(friday, 1))).toBe("2026-07-13"); // Monday
    expect(utcDay(addBusinessDays(friday, 5))).toBe("2026-07-17"); // next Friday
  });

  it("crosses multiple weekends", () => {
    expect(utcDay(addBusinessDays(wednesday, 10))).toBe("2026-07-22");
  });

  it("counts only business days when starting on a weekend", () => {
    const saturday = new Date(Date.UTC(2026, 6, 11, 12));
    expect(utcDay(addBusinessDays(saturday, 1))).toBe("2026-07-13"); // Monday
  });

  it("zero / negative / non-finite days return the same calendar day", () => {
    expect(utcDay(addBusinessDays(wednesday, 0))).toBe("2026-07-08");
    expect(utcDay(addBusinessDays(wednesday, -3))).toBe("2026-07-08");
    expect(utcDay(addBusinessDays(wednesday, Number.NaN))).toBe("2026-07-08");
  });
});

// ---------------------------------------------------------------------------
// deliveryWindow — ship date + transit composition
// ---------------------------------------------------------------------------

describe("deliveryWindow", () => {
  it("before cutoff: ships same day, window offsets from today", () => {
    // 15:00Z = 11:00 EDT Wednesday → ships Wed 07-08; +2 = Fri, +5 = next Wed.
    const win = deliveryWindow({
      now: new Date("2026-07-08T15:00:00Z"),
      cutoffLocal: CUTOFF_NOON, timezone: NY,
      minBusinessDays: 2, maxBusinessDays: 5,
    });
    expect(win).toEqual({ minDate: "2026-07-10", maxDate: "2026-07-15" });
  });

  it("after cutoff: ships next business day, window shifts accordingly", () => {
    // 17:00Z = 13:00 EDT Wednesday → ships Thu 07-09; +2 = Mon, +5 = Thu.
    const win = deliveryWindow({
      now: new Date("2026-07-08T17:00:00Z"),
      cutoffLocal: CUTOFF_NOON, timezone: NY,
      minBusinessDays: 2, maxBusinessDays: 5,
    });
    expect(win).toEqual({ minDate: "2026-07-13", maxDate: "2026-07-16" });
  });

  it("Friday after cutoff: Monday ship anchors the window", () => {
    const win = deliveryWindow({
      now: new Date("2026-07-10T17:00:00Z"), // 13:00 EDT Friday
      cutoffLocal: CUTOFF_NOON, timezone: NY,
      minBusinessDays: 1, maxBusinessDays: 3,
    });
    expect(win).toEqual({ minDate: "2026-07-14", maxDate: "2026-07-16" });
  });

  it("uses the warehouse-local calendar even when UTC has flipped (trap case)", () => {
    // Wed 22:00 EDT = Thu 02:00Z. Zero transit days pins the delivery date to
    // the ship day itself: LOCAL Wednesday, not UTC Thursday.
    const win = deliveryWindow({
      now: new Date("2026-07-09T02:00:00Z"),
      cutoffLocal: null, timezone: NY,
      minBusinessDays: 0, maxBusinessDays: 0,
    });
    expect(win).toEqual({ minDate: "2026-07-08", maxDate: "2026-07-08" });
  });

  it("falls back to the default business timezone for null/invalid timezones", () => {
    for (const timezone of [null, "Not/AZone"]) {
      const win = deliveryWindow({
        now: new Date("2026-07-08T15:00:00Z"),
        cutoffLocal: CUTOFF_NOON, timezone,
        minBusinessDays: 2, maxBusinessDays: 5,
      });
      // DEFAULT_BUSINESS_TZ is America/New_York — same window as the NY case.
      expect(win).toEqual({ minDate: "2026-07-10", maxDate: "2026-07-15" });
    }
  });
});
