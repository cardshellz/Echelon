/**
 * The windows of the Dropship "Program finance" page (design spec §5,
 * contract §2.0 and §6.1): which Eastern-time days a period preset covers,
 * the comparison window that goes with it, and the exact instants of both.
 *
 * Pure: the clock is a parameter and nothing reads system time. Calendar
 * arithmetic is integer day counting; only the wall-clock reading of an
 * instant uses Intl (the IANA zone database), so "today in Eastern time"
 * and every midnight follow daylight saving exactly as Postgres does.
 *
 * Each window carries two forms of its bounds:
 * - `startLocal` / `endLocal`: Eastern wall-clock text, the SQL parameters
 *   (`$n::timestamp AT TIME ZONE 'America/New_York'`, contract Q0). When a
 *   window ends now, `endLocal` is its natural end (the midnight after
 *   today), which lies after `now`, so Q0 turns the upper bound into
 *   'infinity' (contract C6) and the snapshot decides what counts.
 * - `startAt` / `endAt`: the same bounds as instants, worked out here with
 *   Postgres's rules for times that fall in a daylight-saving change, so the
 *   page can label and the service can cross-check Q0's bounds.
 */

import { DropshipError } from "./errors";
import { FINANCE_INTERNAL_ERROR_CODE } from "./program-finance-lines";
import {
  FINANCE_PERIOD_PRESETS,
  type FinancePeriodPreset,
  type FinanceSummaryInput,
} from "../../../../shared/dropship/program-finance";

export const FINANCE_INVALID_PERIOD_CODE = "DROPSHIP_FINANCE_INVALID_PERIOD";

/**
 * The earliest custom day accepted. The program has no data before 2026;
 * the bound keeps every date inside the modern part of the zone database
 * (whole-minute offsets, four-digit years) where Intl and Postgres agree.
 */
export const FINANCE_EARLIEST_DATE = "2000-01-01";
/** "Last 30 days" is today and the 29 days before it. */
export const FINANCE_LAST_DAYS = 30;
const MONTHS_PER_QUARTER = 3;
const MONTHS_PER_YEAR = 12;

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

/** Why a period was refused; the page words each one (spec §5, §7 "Bad period"). */
export type FinancePeriodRefusal =
  | "unknown_preset"
  | "custom_needs_dates"
  | "dates_only_with_custom"
  | "not_a_date"
  | "before_earliest_date"
  | "from_after_to"
  | "to_after_today";

const REFUSAL_MESSAGES: Readonly<Record<FinancePeriodRefusal, string>> = Object.freeze({
  unknown_preset: "That period isn't one the page offers.",
  custom_needs_dates: "A custom period needs a start date and an end date.",
  dates_only_with_custom: "Start and end dates go with a custom period only.",
  not_a_date: "One of the dates isn't a real calendar day.",
  before_earliest_date: `Pick a start date on or after ${FINANCE_EARLIEST_DATE}.`,
  from_after_to: "Pick an end date on or after the start date.",
  to_after_today: "Pick an end date on or before today (Eastern time).",
});

/** One window of the page, in Eastern days, wall-clock bounds and instants. */
export interface FinanceLocalWindow {
  readonly preset: FinancePeriodPreset;
  /** The first Eastern day; null for all time. */
  readonly fromDate: string | null;
  /** The last Eastern day shown. */
  readonly toDate: string;
  /** Inclusive start, Eastern wall clock "YYYY-MM-DDTHH:MM:SS.mmm"; null for all time. */
  readonly startLocal: string | null;
  /** Exclusive end, Eastern wall clock; the natural end (after now) when the window ends now. */
  readonly endLocal: string;
  readonly startAt: Date | null;
  /** `now` when the window ends now, else the instant of `endLocal`. */
  readonly endAt: Date;
  readonly endsNow: boolean;
  /** Compare window only: the earlier month was shorter, so the window runs to its end. */
  readonly clampedToMonthEnd: boolean;
}

export interface ResolvedFinancePeriod {
  readonly timeZone: string;
  readonly now: Date;
  /** The Eastern day `now` falls on. */
  readonly today: string;
  readonly current: FinanceLocalWindow;
  /**
   * The comparison the preset defines; null for all time, which has nothing
   * earlier. The service drops it when the viewer turns Compare off.
   */
  readonly compare: FinanceLocalWindow | null;
}

// ── civil calendar (proleptic Gregorian, integer day numbers) ───────────

interface CivilDate {
  readonly year: number;
  /** 1–12 */
  readonly month: number;
  readonly day: number;
}

interface YearMonth {
  readonly year: number;
  readonly month: number;
}

/** Days since 1970-01-01 (Howard Hinnant's days_from_civil; exact for every Gregorian date). */
function daysFromCivil({ year, month, day }: CivilDate): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const monthIndex = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * monthIndex + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The inverse of daysFromCivil. */
function civilFromDays(days: number): CivilDate {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth({ year, month }: YearMonth): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function addDays(date: CivilDate, days: number): CivilDate {
  return civilFromDays(daysFromCivil(date) + days);
}

function addMonths({ year, month }: YearMonth, months: number): YearMonth {
  const index = year * MONTHS_PER_YEAR + (month - 1) + months;
  return { year: Math.floor(index / MONTHS_PER_YEAR), month: (index % MONTHS_PER_YEAR + MONTHS_PER_YEAR) % MONTHS_PER_YEAR + 1 };
}

function firstOf(yearMonth: YearMonth): CivilDate {
  return { year: yearMonth.year, month: yearMonth.month, day: 1 };
}

function compareDates(a: CivilDate, b: CivilDate): number {
  return daysFromCivil(a) - daysFromCivil(b);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function formatDate({ year, month, day }: CivilDate): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** A YYYY-MM-DD text that names a real day, or null. */
function parseLocalDate(text: string): CivilDate | null {
  const match = LOCAL_DATE_PATTERN.exec(text);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (date.month < 1 || date.month > MONTHS_PER_YEAR) return null;
  if (date.day < 1 || date.day > daysInMonth(date)) return null;
  return date;
}

// ── wall clock ↔ instant ────────────────────────────────────────────────

/** A moment on the zone's wall clock: a day and the milliseconds since its midnight. */
interface WallClock {
  readonly date: CivilDate;
  readonly msOfDay: number;
}

function midnight(date: CivilDate): WallClock {
  return { date, msOfDay: 0 };
}

function formatWallClock({ date, msOfDay }: WallClock): string {
  const hours = Math.floor(msOfDay / MS_PER_HOUR);
  const minutes = Math.floor((msOfDay % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((msOfDay % MS_PER_MINUTE) / MS_PER_SECOND);
  const millis = msOfDay % MS_PER_SECOND;
  return `${formatDate(date)}T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

/** The wall clock read as if it were UTC, in ms: the arithmetic base for offsets. */
function wallClockAsUtcMs({ date, msOfDay }: WallClock): number {
  return daysFromCivil(date) * MS_PER_DAY + msOfDay;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  // en-CA gives numeric fields; h23 keeps midnight as 00, never 24.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * The zone's wall clock at an instant. Seconds and milliseconds are taken
 * from the instant itself: every offset in the supported range is whole
 * minutes, so they never differ between UTC and the zone.
 */
function wallClockAt(instantMs: number, timeZone: string): WallClock {
  const fields: Record<string, number> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  const millis = ((instantMs % MS_PER_SECOND) + MS_PER_SECOND) % MS_PER_SECOND;
  return {
    date: { year: fields.year, month: fields.month, day: fields.day },
    msOfDay: fields.hour * MS_PER_HOUR + fields.minute * MS_PER_MINUTE + fields.second * MS_PER_SECOND + millis,
  };
}

/** Wall clock minus UTC at an instant, in ms (−4 h for EDT). */
function offsetAt(instantMs: number, timeZone: string): number {
  return wallClockAsUtcMs(wallClockAt(instantMs, timeZone)) - instantMs;
}

/**
 * The instant of a wall-clock time, resolved the way Postgres resolves
 * `timestamp AT TIME ZONE` (DetermineTimeZoneOffset): a time that occurs
 * twice (clocks fall back) takes the offset in force after the change, and
 * a time that never occurs (clocks spring forward) takes the offset in
 * force before it. Midnight is never affected in America/New_York; only a
 * comparison window that ends at 1–3 AM on a change day can be.
 */
function wallClockToInstantMs(wallClock: WallClock, timeZone: string): number {
  const asUtc = wallClockAsUtcMs(wallClock);
  // A zone changes its offset at most once within a day either side.
  const offsetBefore = offsetAt(asUtc - MS_PER_DAY, timeZone);
  const offsetAfter = offsetAt(asUtc + MS_PER_DAY, timeZone);
  const usingBefore = asUtc - offsetBefore;
  if (offsetBefore === offsetAfter) return usingBefore;
  const usingAfter = asUtc - offsetAfter;
  // Real under the later offset: after the change, or the second of two
  // occurrences (Postgres prefers it). Otherwise the time is before the
  // change, or in the gap, and both read it with the earlier offset.
  const afterIsReal = wallClockAsUtcMs(wallClockAt(usingAfter, timeZone)) === asUtc;
  return afterIsReal ? usingAfter : usingBefore;
}

function parseWallClock(text: string): WallClock | null {
  const match = LOCAL_DATE_TIME_PATTERN.exec(text);
  if (!match) return null;
  const date = parseLocalDate(`${match[1]}-${match[2]}-${match[3]}`);
  const [hours, minutes, seconds, millis] = [match[4], match[5], match[6], match[7]].map(Number);
  if (!date || hours > 23 || minutes > 59 || seconds > 59) return null;
  return { date, msOfDay: hours * MS_PER_HOUR + minutes * MS_PER_MINUTE + seconds * MS_PER_SECOND + millis };
}

/** The instant of an Eastern wall-clock text this module produced ("YYYY-MM-DDTHH:MM:SS.mmm"). */
export function financeWallClockToInstant(localDateTime: string, timeZone: string): Date {
  assertTimeZone(timeZone);
  const wallClock = parseWallClock(localDateTime);
  if (!wallClock) {
    throw new DropshipError(FINANCE_INTERNAL_ERROR_CODE, "A finance wall-clock time is malformed.", { localDateTime });
  }
  return new Date(wallClockToInstantMs(wallClock, timeZone));
}

/** The day an instant falls on in the zone, as YYYY-MM-DD. */
export function financeLocalDateOf(instant: Date, timeZone: string): string {
  assertInstant(instant, "instant");
  assertTimeZone(timeZone);
  return formatDate(wallClockAt(instant.getTime(), timeZone).date);
}

// ── validation ──────────────────────────────────────────────────────────

function refuse(reason: FinancePeriodRefusal, context: Record<string, unknown>): DropshipError {
  return new DropshipError(FINANCE_INVALID_PERIOD_CODE, REFUSAL_MESSAGES[reason], { reason, ...context });
}

function assertInstant(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DropshipError(FINANCE_INTERNAL_ERROR_CODE, `The finance ${name} is not a valid instant.`, { name });
  }
}

function assertTimeZone(timeZone: string): void {
  try {
    zoneFormatter(timeZone);
  } catch (error) {
    throw new DropshipError(FINANCE_INTERNAL_ERROR_CODE, "The finance time zone is not a known IANA zone.", {
      timeZone,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function isPreset(value: string): value is FinancePeriodPreset {
  return (FINANCE_PERIOD_PRESETS as readonly string[]).includes(value);
}

const EARLIEST = parseLocalDate(FINANCE_EARLIEST_DATE) as CivilDate;

function parseCustomDates(from: string, to: string, today: CivilDate): { from: CivilDate; to: CivilDate } {
  const fromDate = parseLocalDate(from);
  const toDate = parseLocalDate(to);
  if (!fromDate || !toDate) throw refuse("not_a_date", { from, to });
  if (compareDates(fromDate, EARLIEST) < 0) throw refuse("before_earliest_date", { from, to });
  if (compareDates(fromDate, toDate) > 0) throw refuse("from_after_to", { from, to });
  if (compareDates(toDate, today) > 0) throw refuse("to_after_today", { from, to, today: formatDate(today) });
  return { from: fromDate, to: toDate };
}

// ── windows ─────────────────────────────────────────────────────────────

interface WindowShape {
  readonly from: CivilDate | null;
  readonly to: CivilDate;
  readonly start: WallClock | null;
  readonly end: WallClock;
  readonly clampedToMonthEnd: boolean;
}

interface Clock {
  readonly now: Date;
  readonly timeZone: string;
}

function materialize(preset: FinancePeriodPreset, shape: WindowShape, clock: Clock): FinanceLocalWindow {
  const endInstantMs = wallClockToInstantMs(shape.end, clock.timeZone);
  const endsNow = endInstantMs > clock.now.getTime();
  return Object.freeze({
    preset,
    fromDate: shape.from ? formatDate(shape.from) : null,
    toDate: formatDate(shape.to),
    startLocal: shape.start ? formatWallClock(shape.start) : null,
    endLocal: formatWallClock(shape.end),
    startAt: shape.start ? new Date(wallClockToInstantMs(shape.start, clock.timeZone)) : null,
    endAt: new Date(endsNow ? clock.now.getTime() : endInstantMs),
    endsNow,
    clampedToMonthEnd: shape.clampedToMonthEnd,
  });
}

/** From a day to now: the current window of every "so far" preset. */
function soFar(from: CivilDate | null, today: CivilDate): WindowShape {
  return { from, to: today, start: from ? midnight(from) : null, end: midnight(addDays(today, 1)), clampedToMonthEnd: false };
}

/**
 * The same span of an earlier period (spec §5): from the first of
 * `earlierStart`, to the same day number and time of day `monthOffset`
 * months into it. A day the earlier month does not have clamps the window
 * to that month's end ("Feb has 28 days").
 */
function sameSpanEarlier(earlierStart: YearMonth, monthOffset: number, today: CivilDate, nowMsOfDay: number): WindowShape {
  const endMonth = addMonths(earlierStart, monthOffset);
  const lastDay = daysInMonth(endMonth);
  const from = firstOf(earlierStart);
  if (today.day > lastDay) {
    return {
      from,
      to: { ...endMonth, day: lastDay },
      start: midnight(from),
      end: midnight(firstOf(addMonths(endMonth, 1))),
      clampedToMonthEnd: true,
    };
  }
  const endDay = { ...endMonth, day: today.day };
  return { from, to: endDay, start: midnight(from), end: { date: endDay, msOfDay: nowMsOfDay }, clampedToMonthEnd: false };
}

function wholeMonth(yearMonth: YearMonth): WindowShape {
  const from = firstOf(yearMonth);
  return {
    from,
    to: { ...yearMonth, day: daysInMonth(yearMonth) },
    start: midnight(from),
    end: midnight(firstOf(addMonths(yearMonth, 1))),
    clampedToMonthEnd: false,
  };
}

/** A window moved back by whole calendar days, wall clock kept (custom and last-30 comparisons). */
function shiftBackDays(shape: WindowShape, days: number): WindowShape {
  return {
    from: shape.from ? addDays(shape.from, -days) : null,
    to: addDays(shape.to, -days),
    start: shape.start ? { date: addDays(shape.start.date, -days), msOfDay: shape.start.msOfDay } : null,
    end: { date: addDays(shape.end.date, -days), msOfDay: shape.end.msOfDay },
    clampedToMonthEnd: false,
  };
}

/** The current window capped at now, as a wall-clock end, so a shift keeps "to the same time". */
function cappedAtNow(shape: WindowShape, clock: Clock, nowWallClock: WallClock): WindowShape {
  const endsNow = wallClockToInstantMs(shape.end, clock.timeZone) > clock.now.getTime();
  return endsNow ? { ...shape, end: nowWallClock } : shape;
}

function shapesFor(
  preset: FinancePeriodPreset,
  custom: { from: CivilDate; to: CivilDate } | null,
  clock: Clock,
  nowWallClock: WallClock,
): { current: WindowShape; compare: WindowShape | null } {
  const today = nowWallClock.date;
  const thisMonth: YearMonth = { year: today.year, month: today.month };
  switch (preset) {
    case "mtd":
      return {
        current: soFar(firstOf(thisMonth), today),
        compare: sameSpanEarlier(addMonths(thisMonth, -1), 0, today, nowWallClock.msOfDay),
      };
    case "last-month": {
      const lastMonth = addMonths(thisMonth, -1);
      return { current: wholeMonth(lastMonth), compare: wholeMonth(addMonths(lastMonth, -1)) };
    }
    case "last-30": {
      const current = soFar(addDays(today, -(FINANCE_LAST_DAYS - 1)), today);
      return { current, compare: shiftBackDays(cappedAtNow(current, clock, nowWallClock), FINANCE_LAST_DAYS) };
    }
    case "qtd": {
      const quarterStart: YearMonth = { year: today.year, month: today.month - ((today.month - 1) % MONTHS_PER_QUARTER) };
      return {
        current: soFar(firstOf(quarterStart), today),
        compare: sameSpanEarlier(addMonths(quarterStart, -MONTHS_PER_QUARTER), today.month - quarterStart.month, today, nowWallClock.msOfDay),
      };
    }
    case "ytd": {
      const yearStart: YearMonth = { year: today.year, month: 1 };
      return {
        current: soFar(firstOf(yearStart), today),
        compare: sameSpanEarlier(addMonths(yearStart, -MONTHS_PER_YEAR), today.month - 1, today, nowWallClock.msOfDay),
      };
    }
    case "all":
      return { current: soFar(null, today), compare: null };
    case "custom": {
      if (!custom) throw refuse("custom_needs_dates", {});
      const current: WindowShape = {
        from: custom.from,
        to: custom.to,
        start: midnight(custom.from),
        end: midnight(addDays(custom.to, 1)),
        clampedToMonthEnd: false,
      };
      // An equal-length window immediately before; one that ends now is
      // compared to the same time of day (contract §6.1 "equal-length shift").
      const lengthInDays = daysFromCivil(custom.to) - daysFromCivil(custom.from) + 1;
      return { current, compare: shiftBackDays(cappedAtNow(current, clock, nowWallClock), lengthInDays) };
    }
  }
}

/**
 * Resolves a period preset into its current and comparison windows, in the
 * given zone, at `now` (spec §5, contract §6.1).
 *
 * Refuses (DROPSHIP_FINANCE_INVALID_PERIOD, permanent) an unknown preset,
 * custom without both dates, dates with any other preset, a day that does
 * not exist, a start before FINANCE_EARLIEST_DATE, a start after the end,
 * and an end after today in the zone. A bad clock or zone is the server's
 * own bug, never the viewer's input (DROPSHIP_FINANCE_INTERNAL_ERROR).
 */
export function resolveFinancePeriod(
  preset: FinancePeriodPreset,
  from: string | null | undefined,
  to: string | null | undefined,
  now: Date,
  timeZone: string,
): ResolvedFinancePeriod {
  assertInstant(now, "clock");
  assertTimeZone(timeZone);
  if (typeof preset !== "string" || !isPreset(preset)) throw refuse("unknown_preset", { preset });

  const clock: Clock = { now: new Date(now.getTime()), timeZone };
  const nowWallClock = wallClockAt(clock.now.getTime(), timeZone);
  let custom: { from: CivilDate; to: CivilDate } | null = null;
  if (preset === "custom") {
    if (from === undefined || from === null || to === undefined || to === null) {
      throw refuse("custom_needs_dates", { from: from ?? null, to: to ?? null });
    }
    custom = parseCustomDates(from, to, nowWallClock.date);
  } else if ((from !== undefined && from !== null) || (to !== undefined && to !== null)) {
    throw refuse("dates_only_with_custom", { preset, from: from ?? null, to: to ?? null });
  }

  const shapes = shapesFor(preset, custom, clock, nowWallClock);
  return Object.freeze({
    timeZone,
    now: clock.now,
    today: formatDate(nowWallClock.date),
    current: materialize(preset, shapes.current, clock),
    compare: shapes.compare ? materialize(preset, shapes.compare, clock) : null,
  });
}

/** A resolved window as the summary carries it (instants as Dates; the schema turns them into ISO text). */
export function toFinanceWindow(window: FinanceLocalWindow): FinanceSummaryInput["period"] {
  return {
    preset: window.preset,
    fromDate: window.fromDate,
    toDate: window.toDate,
    startAt: window.startAt,
    endAt: window.endAt,
    endsNow: window.endsNow,
    clampedToMonthEnd: window.clampedToMonthEnd,
  };
}
