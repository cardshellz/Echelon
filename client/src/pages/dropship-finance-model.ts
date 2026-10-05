/**
 * Dropship "Program finance" — the pure model behind the staff finance tab
 * (/dropship?tab=finance; design spec finance-spec.md §3, §5–§8, §10, §12).
 *
 * Everything the page decides lives here: what the URL means, how a number
 * is written, what a failed request means and whether to retry it, and what
 * each part of the page shows for a summary. The panel renders; it does not
 * decide.
 *
 * The server owns every figure. It resolves the period with its own clock,
 * sums in BigInt, checks the identities and sends a summary that the shared
 * contract (`shared/dropship/program-finance.ts`) validates on both ends. This
 * model never adds, subtracts or rounds money: it only formats the integers it
 * is given. Formatting is BigInt-based, so a cent is never a float, and a
 * value the contract could not have sent (a fraction, an unsafe integer)
 * reads "Unavailable", never "$0.00" (CLAUDE.md §4).
 *
 * Part 1 of the page (this file) shows the rollup. Lines already carry
 * `opensMetric` for the list sheets of part 2; nothing here renders a link
 * to a sheet that does not exist yet.
 */

import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  FINANCE_CHECK_GROUPS,
  FINANCE_PERIOD_PRESETS,
  FINANCE_SECTION_KEYS,
  FINANCE_SECTION_LINE_KEYS,
  FINANCE_INFO_LINE_KEYS,
  FINANCE_ANCHOR_KEYS,
  FINANCE_TIME_ZONE,
  FINANCE_WAITING_REASONS,
  FINANCE_NEVER_CHARGED_KINDS,
  financePeriodPresetSchema,
  financeSummarySchema,
  isFinanceLineKey,
  type FinanceAnswer,
  type FinanceCheck,
  type FinanceCheckGroup,
  type FinanceCheckId,
  type FinanceCheckResult,
  type FinanceDatedBy,
  type FinanceInfoKey,
  type FinanceLine,
  type FinanceLineKey,
  type FinanceLineStatus,
  type FinanceOperator,
  type FinancePeriodPreset,
  type FinancePrior,
  type FinanceProductRow,
  type FinanceSectionKey,
  type FinanceSummary,
  type FinanceUnit,
  type FinanceVendorAggregateRow,
  type FinanceVendorRow,
  type FinanceWindow,
  type FinanceWorkingOperand,
  type FinanceWorkingStep,
  type FinanceWorkingUnit,
} from "@shared/dropship/program-finance";
import {
  FINANCE_CHECK_DEFINITIONS,
  FINANCE_CHECK_GROUP_WORDS,
  FINANCE_CHECK_RESULT_WORDS,
  FINANCE_CHECKS_ROW,
  FINANCE_COUNTING_CHOICES,
  FINANCE_DATED_BY_DEFINITIONS,
  FINANCE_INFO_DEFINITIONS,
  FINANCE_LINE_DEFINITIONS,
  FINANCE_MONEY_PATH_STEPS,
  FINANCE_NOT_TAKEN_OFF_HEADING,
  FINANCE_NOTE_DEFINITIONS,
  FINANCE_POINTS_EXPIRY_HEADING,
  FINANCE_REASON_DEFINITIONS,
  FINANCE_SECTION_DEFINITIONS,
  FINANCE_SECTION_GROUP_CAPTIONS,
  FINANCE_SECTION_STATUS_WORDS,
  FINANCE_TWO_CLOCKS_SENTENCE,
  FINANCE_VENDOR_SCOPE_NOTE,
  financeWorkingStepWords,
  isFinanceReasonKey,
  type FinanceSectionGroup,
  type FinanceTechnicalSource,
} from "@shared/dropship/program-finance-definitions";
import { largestRemainder, toSafeNumber } from "@shared/dropship/program-finance-money";
import { DropshipApiError, buildQueryUrl, fetchJson } from "@/lib/dropship-ops-surface";
import { formatPoints } from "@/lib/dropship-wallet-guidance";

// ── endpoints, query keys, retries ────────────────────────────────────────

/** The summary route (contract §1.3). Part 2 adds rows, CSV, orders and find. */
export const DROPSHIP_FINANCE_SUMMARY_URL = "/api/dropship/admin/finance/summary";
/**
 * Every finance query key starts with this, so the page's header Refresh
 * can reach them all with one prefix (spec §5 "Required wiring").
 */
export const DROPSHIP_FINANCE_QUERY_KEY_ROOT = "dropship-finance";

/**
 * The header Refresh while the finance tab is open. Only the summary on
 * screen is fetched again, keeping its numbers up while it runs; every other
 * period or vendor cached earlier is marked stale, so it fetches fresh when it
 * is shown again. Refetching them all at once would queue the visible summary
 * behind snapshots nobody is looking at, on a server that runs two at a time
 * and turns the rest away as busy.
 */
export function refreshFinanceQueries(queryClient: Pick<QueryClient, "invalidateQueries">): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: [DROPSHIP_FINANCE_QUERY_KEY_ROOT], refetchType: "active" });
}
/** Retries after the first failure, transient errors only (spec §7). */
export const FINANCE_QUERY_MAX_RETRIES = 2;
/** Backoff base: 1s, then 2s (`retryDelay 1000·2ⁿ`, spec §7). */
export const FINANCE_QUERY_RETRY_BASE_MS = 1_000;

// ── fixed words (spec §10 copy deck) ──────────────────────────────────────

export const FINANCE_PAGE_TITLE = "Program finance";
export const FINANCE_NOT_RECORDED_TEXT = "Not recorded";
export const FINANCE_UNAVAILABLE_TEXT = "Unavailable";
/** A percent of nothing (spec §6). */
export const FINANCE_NOT_APPLICABLE_TEXT = "—";
export const FINANCE_NONE_THIS_PERIOD_TEXT = "None this period";
export const FINANCE_PARTIAL_TEXT = "Some amounts missing";
export const FINANCE_HOW_LINK_TEXT = "How this is worked out";
export const FINANCE_HOW_COUNTS_LINK_TEXT = "How this page counts";
export const FINANCE_CHECKING_TEXT = "Checking…";
export const FINANCE_REFRESHING_TEXT = "Refreshing…";
export const FINANCE_KEPT_CAVEAT = "before packaging, Stripe fees and overheads";
export const FINANCE_BAR_TITLE = "Where each $1 we billed went";
export const FINANCE_CENTS_CAPTION = "of each $1";
export const FINANCE_NOTHING_BILLED_TEXT = "Nothing billed yet this period";
export const FINANCE_NOT_READY_TEXT = "Not ready yet";
export const FINANCE_LOSS_WORD = "Loss";
export const FINANCE_PERMISSION_TEXT = "Program finance needs Dropship operations access (Administrator).";
export const FINANCE_CUSTOM_RANGE_ORDER_TEXT = "Pick an end date on or after the start date.";
export const FINANCE_CUSTOM_RANGE_FUTURE_TEXT = "Pick an end date on or before today.";
export const FINANCE_COMPARE_ALL_TIME_TEXT = "All time has nothing earlier to compare with.";
export const FINANCE_USDC_NOTE = "counted when it settles on chain, $1 per USDC";
export const FINANCE_DETAIL_TITLE = "The detail";
export const FINANCE_DEPTH_LABELS = Object.freeze({ summary: "Summary", every_line: "Every line" } as const);

/** Info texts behind the ⓘ buttons (spec §10). */
export const FINANCE_INFO_TEXT = Object.freeze({
  kept:
    "What Card Shellz kept from the orders accepted in this period after what the products, carrier labels and the insurance pool share cost us, plus fees we charged, minus return credits we paid. Packaging, Stripe's fees and overheads are not taken off because Echelon does not record them.",
  margin: "Both periods are measured on their fully costed orders only, so a half-finished month doesn't look worse.",
  points:
    "Vendors earn points on bank and USDC deposits; 1 point takes 1¢ off a future order. Points are never paid out as cash. This page doesn't take them off what we kept until you decide how to count them.",
  fullyCosted:
    "An order is fully costed when every pack has shipped, every package has its label cost and every item has its cost recorded. Only fully costed orders count toward what we kept, so nothing is guessed.",
  cash:
    "Money that reached Card Shellz from vendors' deposits, after disputes and bank returns. It is before Stripe's own fees, which Echelon does not record. USDC counts when it settles on chain, at $1.00 per USDC.",
  onTheWay: "Bank transfers and USDC that vendors sent but that haven't settled. It isn't cash yet and vendors can't spend it yet.",
  owedToUs:
    "Wallets below zero, for example after a letting-through-early fee, a return fee or a dispute. Echelon doesn't record which one caused it.",
});

const MINUS = "−";
const EN_DASH_SPACED = " – ";
const ELLIPSIS = "…";

// ── integers ──────────────────────────────────────────────────────────────

const ZERO = BigInt(0);
const TEN = BigInt(10);
const HUNDRED = BigInt(100);

/** True for an integer JSON can carry exactly (the contract's `.int().safe()`). */
export function isFinanceSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function absolute(value: bigint): bigint {
  return value < ZERO ? -value : value;
}

/** "1234567" → "1,234,567". Digits only; the sign is the caller's. */
function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function centsMagnitudeText(cents: number): string {
  const magnitude = absolute(BigInt(cents));
  const dollars = magnitude / HUNDRED;
  const remainder = magnitude % HUNDRED;
  return `$${groupDigits(dollars.toString())}.${remainder.toString().padStart(2, "0")}`;
}

// ── money, percents, points, counts (spec §6 "Numbers") ───────────────────

/**
 * Signed cents as dollars: "$1,934.10", "−$212.40" (typographic minus).
 * Null is a figure Echelon does not record ("Not recorded"); a value the
 * contract could not have sent (a fraction, an unsafe integer) is
 * "Unavailable". Neither is ever "$0.00".
 */
export function formatFinanceMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return FINANCE_NOT_RECORDED_TEXT;
  if (!isFinanceSafeInteger(cents)) return FINANCE_UNAVAILABLE_TEXT;
  return `${cents < 0 ? MINUS : ""}${centsMagnitudeText(cents)}`;
}

/**
 * Cents without a sign, for statement lines whose operator column (+ − =)
 * already carries the direction (spec §6).
 */
export function formatFinanceMagnitude(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return FINANCE_NOT_RECORDED_TEXT;
  if (!isFinanceSafeInteger(cents)) return FINANCE_UNAVAILABLE_TEXT;
  return centsMagnitudeText(cents);
}

/** A change in money, always signed: "+$161.30", "−$2,117.00", "$0.00". */
export function formatFinanceSignedMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return FINANCE_NOT_RECORDED_TEXT;
  if (!isFinanceSafeInteger(cents)) return FINANCE_UNAVAILABLE_TEXT;
  if (cents === 0) return centsMagnitudeText(0);
  return `${cents < 0 ? MINUS : "+"}${centsMagnitudeText(cents)}`;
}

function tenthsMagnitudeText(tenths: number): string {
  const magnitude = absolute(BigInt(tenths));
  return `${groupDigits((magnitude / TEN).toString())}.${(magnitude % TEN).toString()}`;
}

/**
 * Signed tenths of a percent: 250 → "25.0%", −42 → "−4.2%". Null (a share of
 * nothing) is "—". With `signed`, a positive value gets a plus ("+16.8%"),
 * for changes.
 */
export function formatFinancePercent(tenths: number | null | undefined, options: { signed?: boolean } = {}): string {
  if (tenths === null || tenths === undefined) return FINANCE_NOT_APPLICABLE_TEXT;
  if (!isFinanceSafeInteger(tenths)) return FINANCE_UNAVAILABLE_TEXT;
  const sign = tenths < 0 ? MINUS : options.signed && tenths > 0 ? "+" : "";
  return `${sign}${tenthsMagnitudeText(tenths)}%`;
}

/** A change in a percent, in points: 12 → "+1.2 pts", −5 → "−0.5 pts", 0 → "0.0 pts". */
export function formatFinancePts(tenths: number | null | undefined): string {
  if (tenths === null || tenths === undefined) return FINANCE_NOT_APPLICABLE_TEXT;
  if (!isFinanceSafeInteger(tenths)) return FINANCE_UNAVAILABLE_TEXT;
  const sign = tenths < 0 ? MINUS : tenths > 0 ? "+" : "";
  return `${sign}${tenthsMagnitudeText(tenths)} pts`;
}

/** A grouped count: 12110 → "12,110". Counts are never negative in the contract. */
export function formatFinanceCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return FINANCE_NOT_RECORDED_TEXT;
  if (!isFinanceSafeInteger(value) || value < 0) return FINANCE_UNAVAILABLE_TEXT;
  return groupDigits(String(value));
}

/** Points, through the existing wallet formatter: "12,400 points", "1 point". */
export function formatFinancePoints(points: number | null | undefined): string {
  if (points === null || points === undefined) return FINANCE_NOT_RECORDED_TEXT;
  if (!isFinanceSafeInteger(points)) return FINANCE_UNAVAILABLE_TEXT;
  return formatPoints(points);
}

/** "1 order" / "3 orders". */
export function formatFinanceCountOf(value: number, one: string, many: string): string {
  return `${formatFinanceCount(value)} ${value === 1 ? one : many}`;
}

/**
 * Cents as a screen reader says them, for aria-labels on clickable numbers
 * (spec §12): 193410 → "1,934 dollars and 10 cents", −21240 → "minus 212
 * dollars and 40 cents", 100 → "1 dollar".
 */
export function formatFinanceMoneySpoken(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "not recorded";
  if (!isFinanceSafeInteger(cents)) return "unavailable";
  const magnitude = absolute(BigInt(cents));
  const dollars = magnitude / HUNDRED;
  const remainder = magnitude % HUNDRED;
  const dollarWords = `${groupDigits(dollars.toString())} ${dollars === BigInt(1) ? "dollar" : "dollars"}`;
  const centWords = remainder === ZERO ? "" : ` and ${remainder.toString()} ${remainder === BigInt(1) ? "cent" : "cents"}`;
  return `${cents < 0 ? "minus " : ""}${dollarWords}${centWords}`;
}

// ── dates and instants (Eastern time, spec §6) ────────────────────────────

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

interface LocalDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseLocalDate(value: string): LocalDateParts | null {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** A real Eastern calendar day written YYYY-MM-DD (2026-02-30 is not one). */
export function isFinanceLocalDate(value: string): boolean {
  return parseLocalDate(value) !== null;
}

/** "2026-10-01" → "Oct 1, 2026" (or "Oct 1" without the year). */
export function formatFinanceLocalDate(value: string, options: { withYear: boolean } = { withYear: true }): string {
  const parts = parseLocalDate(value);
  if (!parts) return FINANCE_UNAVAILABLE_TEXT;
  const monthDay = `${MONTHS_SHORT[parts.month - 1]} ${parts.day}`;
  return options.withYear ? `${monthDay}, ${parts.year}` : monthDay;
}

/**
 * Two Eastern days as one span, the way the period is printed (spec §5):
 * "Oct 1 – 5, 2026", "Sep 28 – Oct 5, 2026", "Dec 28, 2025 – Jan 3, 2026",
 * "Oct 5, 2026". A span across years always shows both years.
 */
export function formatFinanceDateSpan(from: string, to: string, options: { withYear: boolean } = { withYear: true }): string {
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);
  if (!start || !end) return FINANCE_UNAVAILABLE_TEXT;
  const yearSuffix = options.withYear ? `, ${end.year}` : "";
  const startMonth = MONTHS_SHORT[start.month - 1];
  const endMonth = MONTHS_SHORT[end.month - 1];
  if (start.year !== end.year) {
    return `${startMonth} ${start.day}, ${start.year}${EN_DASH_SPACED}${endMonth} ${end.day}, ${end.year}`;
  }
  if (start.month === end.month && start.day === end.day) return `${startMonth} ${start.day}${yearSuffix}`;
  if (start.month === end.month) return `${startMonth} ${start.day}${EN_DASH_SPACED}${end.day}${yearSuffix}`;
  return `${startMonth} ${start.day}${EN_DASH_SPACED}${endMonth} ${end.day}${yearSuffix}`;
}

const EASTERN_INSTANT_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: FINANCE_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const EASTERN_DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: FINANCE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

interface EasternInstantParts {
  readonly monthDay: string;
  readonly year: string;
  readonly time: string;
}

/**
 * Built from Intl parts, not the formatted string, so the output does not
 * depend on the ICU version's spacing (newer ICU puts U+202F before "AM").
 */
function easternParts(iso: string): EasternInstantParts | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Map(EASTERN_INSTANT_FORMAT.formatToParts(instant).map((part) => [part.type, part.value]));
  const month = parts.get("month");
  const day = parts.get("day");
  const year = parts.get("year");
  const hour = parts.get("hour");
  const minute = parts.get("minute");
  const dayPeriod = parts.get("dayPeriod");
  if (!month || !day || !year || !hour || !minute || !dayPeriod) return null;
  return { monthDay: `${month} ${day}`, year, time: `${hour}:${minute} ${dayPeriod.toUpperCase()}` };
}

/** An instant in Eastern time: "Oct 4, 2026, 3:10 PM ET". */
export function formatFinanceInstant(iso: string): string {
  const parts = easternParts(iso);
  return parts ? `${parts.monthDay}, ${parts.year}, ${parts.time} ET` : FINANCE_UNAVAILABLE_TEXT;
}

/** The Eastern clock time of an instant: "9:14 AM" (callers add "ET" where the copy has it). */
export function formatFinanceClockTime(iso: string): string {
  const parts = easternParts(iso);
  return parts ? parts.time : FINANCE_UNAVAILABLE_TEXT;
}

/**
 * Today's Eastern calendar day for an injected clock, as YYYY-MM-DD. Only the
 * custom-date picker uses it, to grey out future days; the server resolves
 * every period bound itself (spec §3.0: the browser never builds bounds).
 */
export function financeTodayInEastern(now: Date): string {
  const parts = new Map(EASTERN_DAY_FORMAT.formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

/**
 * A YYYY-MM-DD day as the date picker's local-midnight Date. The picker works
 * in calendar days only; no instant or time zone is derived from it.
 */
export function financeLocalDateToCalendarDate(value: string | null): Date | undefined {
  const parts = value === null ? null : parseLocalDate(value);
  return parts ? new Date(parts.year, parts.month - 1, parts.day) : undefined;
}

/** The date picker's day back as YYYY-MM-DD (its local calendar fields, never its instant). */
export function financeCalendarDateToLocalDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// ── words with placeholders ───────────────────────────────────────────────

/**
 * Fills the copy deck's `{placeholders}` ({$}, {n}, {period}, …). A
 * placeholder with no value becomes "…" so raw braces never reach the screen.
 */
export function fillFinanceWords(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z$]+)\}/g, (_match, name: string) => values[name] ?? ELLIPSIS);
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

function withoutFinalStop(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

// ── URL state (spec §5) ───────────────────────────────────────────────────

/** The detail rows: the eight sections, then Checks. Also the `open` param's order. */
export const FINANCE_DETAIL_KEYS = [...FINANCE_SECTION_KEYS, "checks"] as const;
export type FinanceDetailKey = (typeof FINANCE_DETAIL_KEYS)[number];
const DETAIL_KEY_SET: ReadonlySet<string> = new Set<string>(FINANCE_DETAIL_KEYS);

export function isFinanceDetailKey(value: string): value is FinanceDetailKey {
  return DETAIL_KEY_SET.has(value);
}

export type FinanceDepth = "summary" | "every_line";

export const FINANCE_DEFAULT_PERIOD: FinancePeriodPreset = "mtd";
/** The value of `depth` in the URL for "Every line"; Summary is the default and is omitted. */
const DEPTH_EVERY_LINE_PARAM = "all";
/** Vendor ids are Postgres int4 (the contract's queryId cap). */
const VENDOR_ID_MAX = 2_147_483_647;
const VENDOR_ID_PATTERN = /^[1-9]\d{0,9}$/;
/** Params this page reads; anything else in the query is dropped and the URL rewritten. */
const FINANCE_URL_PARAMS: ReadonlySet<string> = new Set(["tab", "period", "from", "to", "compare", "vendor", "open", "depth", "how"]);

export const FINANCE_PERIOD_PRESET_LABELS: Readonly<Record<FinancePeriodPreset, string>> = Object.freeze({
  mtd: "This month so far",
  "last-month": "Last month",
  "last-30": "Last 30 days",
  qtd: "This quarter so far",
  ytd: "This year so far",
  all: "All time",
  custom: "Custom dates…",
});

export interface FinanceUrlState {
  readonly period: FinancePeriodPreset;
  /** Only with "custom": the first and last Eastern day, YYYY-MM-DD. */
  readonly from: string | null;
  readonly to: string | null;
  readonly compare: boolean;
  /** The vendor view (spec §4.2); null for the whole program. */
  readonly vendorId: number | null;
  /** Open detail rows; null when the URL says nothing (the remembered view then applies). */
  readonly open: readonly FinanceDetailKey[] | null;
  readonly depth: FinanceDepth | null;
  /** The "How this is worked out" drawer: a line key with workings, or `answer.kept`. */
  readonly how: FinanceLineKey | null;
}

export const FINANCE_DEFAULT_URL_STATE: FinanceUrlState = Object.freeze({
  period: FINANCE_DEFAULT_PERIOD,
  from: null,
  to: null,
  compare: true,
  vendorId: null,
  open: null,
  depth: null,
  how: null,
});

export interface FinanceUrlReadResult {
  readonly state: FinanceUrlState;
  /** Params that were invalid, repeated or unknown; non-empty means the URL is rewritten with replace. */
  readonly dropped: readonly string[];
}

/** Open rows in page order, each once. */
function canonicalOpen(keys: readonly FinanceDetailKey[]): FinanceDetailKey[] {
  const wanted = new Set(keys);
  return FINANCE_DETAIL_KEYS.filter((key) => wanted.has(key));
}

/**
 * Reads the finance tab's query string. Every invalid, repeated or unknown
 * value is dropped and named in `dropped`, so the panel can rewrite the URL
 * (replace) and never sends the server something it would refuse (spec §5).
 * Whether a custom range reaches past today is the server's period check.
 */
export function readFinanceUrlState(search: string): FinanceUrlReadResult {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const dropped = new Set<string>();
  params.forEach((_value, key) => {
    if (!FINANCE_URL_PARAMS.has(key)) dropped.add(key);
  });
  const single = (key: string): string | null => {
    const values = params.getAll(key);
    if (values.length === 0) return null;
    if (values.length > 1) {
      dropped.add(key);
      return null;
    }
    return values[0];
  };

  let period: FinancePeriodPreset = FINANCE_DEFAULT_PERIOD;
  const rawPeriod = single("period");
  if (rawPeriod !== null) {
    const parsed = financePeriodPresetSchema.safeParse(rawPeriod);
    if (parsed.success) period = parsed.data;
    else dropped.add("period");
  }

  let from: string | null = null;
  let to: string | null = null;
  const rawFrom = single("from");
  const rawTo = single("to");
  if (period === "custom") {
    if (rawFrom !== null && rawTo !== null && isFinanceLocalDate(rawFrom) && isFinanceLocalDate(rawTo) && rawFrom <= rawTo) {
      from = rawFrom;
      to = rawTo;
    } else {
      // A custom period without two valid, ordered days cannot be asked for: fall back to the default.
      period = FINANCE_DEFAULT_PERIOD;
      dropped.add("period");
      if (rawFrom !== null) dropped.add("from");
      if (rawTo !== null) dropped.add("to");
    }
  } else {
    if (rawFrom !== null) dropped.add("from");
    if (rawTo !== null) dropped.add("to");
  }

  let compare = true;
  const rawCompare = single("compare");
  if (rawCompare !== null) {
    if (rawCompare === "off") compare = false;
    else dropped.add("compare");
  }

  let vendorId: number | null = null;
  const rawVendor = single("vendor");
  if (rawVendor !== null) {
    const candidate = VENDOR_ID_PATTERN.test(rawVendor) ? Number(rawVendor) : Number.NaN;
    if (Number.isSafeInteger(candidate) && candidate <= VENDOR_ID_MAX) vendorId = candidate;
    else dropped.add("vendor");
  }

  let open: FinanceDetailKey[] | null = null;
  const rawOpen = single("open");
  if (rawOpen !== null) {
    const parts = rawOpen.split(",");
    const valid = parts.filter(isFinanceDetailKey);
    if (valid.length !== parts.length || valid.length === 0) dropped.add("open");
    const canonical = canonicalOpen(valid);
    if (canonical.length !== valid.length) dropped.add("open");
    open = canonical.length > 0 ? canonical : null;
  }

  let depth: FinanceDepth | null = null;
  const rawDepth = single("depth");
  if (rawDepth !== null) {
    if (rawDepth === DEPTH_EVERY_LINE_PARAM) depth = "every_line";
    else dropped.add("depth");
  }

  let how: FinanceLineKey | null = null;
  const rawHow = single("how");
  if (rawHow !== null) {
    if (isFinanceLineKey(rawHow)) how = rawHow;
    else dropped.add("how");
  }

  return { state: { period, from, to, compare, vendorId, open, depth, how }, dropped: [...dropped] };
}

/**
 * The finance tab's query string for a state, defaults omitted, in a fixed
 * order (tab, period, from, to, compare, vendor, open, depth, how).
 */
export function writeFinanceUrlState(state: FinanceUrlState): string {
  const parts: string[] = ["tab=finance"];
  const hasCustomRange = state.period === "custom" && state.from !== null && state.to !== null;
  if (state.period !== FINANCE_DEFAULT_PERIOD && (state.period !== "custom" || hasCustomRange)) {
    parts.push(`period=${encodeURIComponent(state.period)}`);
  }
  if (hasCustomRange) {
    parts.push(`from=${encodeURIComponent(state.from ?? "")}`, `to=${encodeURIComponent(state.to ?? "")}`);
  }
  if (!state.compare) parts.push("compare=off");
  if (state.vendorId !== null) parts.push(`vendor=${state.vendorId}`);
  const open = state.open ? canonicalOpen(state.open) : [];
  // Commas stay literal so the list reads as written; each key is plain lower-case text.
  if (open.length > 0) parts.push(`open=${open.map(encodeURIComponent).join(",")}`);
  if (state.depth === "every_line") parts.push(`depth=${DEPTH_EVERY_LINE_PARAM}`);
  if (state.how !== null) parts.push(`how=${encodeURIComponent(state.how)}`);
  return parts.join("&");
}

/** A period Select value as a preset; null for anything the contract does not list. */
export function financePeriodPresetFromSelect(value: string): FinancePeriodPreset | null {
  const parsed = financePeriodPresetSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The page link for a state: "/dropship?tab=finance&…". */
export function financeUrlHref(state: FinanceUrlState): string {
  return `/dropship?${writeFinanceUrlState(state)}`;
}

// ── remembered view (spec §5: open rows and depth, per viewer) ────────────

export const FINANCE_VIEW_STORAGE_KEY = "dropship-finance:view";

export interface FinanceViewMemory {
  readonly open: readonly FinanceDetailKey[];
  readonly depth: FinanceDepth;
}

/** The part of Storage the memory uses, so tests can pass a throwing double. */
export type FinanceViewStorage = Pick<Storage, "getItem" | "setItem">;

const viewMemorySchema = z
  .object({ open: z.array(z.string()).max(FINANCE_DETAIL_KEYS.length), depth: z.enum(["summary", "every_line"]) })
  .strict();

/**
 * The browser's localStorage, or null where it cannot be reached (private
 * windows, blocked site data, server rendering). Deliberately swallowing the
 * error: the remembered view is a convenience and the page works without it.
 */
export function financeViewStorage(): FinanceViewStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The remembered open rows and depth, or null when there is none or it cannot be read. */
export function readFinanceViewMemory(storage: FinanceViewStorage | null): FinanceViewMemory | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(FINANCE_VIEW_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = viewMemorySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return { open: canonicalOpen(parsed.data.open.filter(isFinanceDetailKey)), depth: parsed.data.depth };
  } catch {
    // Unreadable or malformed memory is the same as no memory (spec §5): the URL and the defaults still apply.
    return null;
  }
}

/** Saves the open rows and depth; false when storage refused (the page carries on). */
export function writeFinanceViewMemory(storage: FinanceViewStorage | null, memory: FinanceViewMemory): boolean {
  if (!storage) return false;
  try {
    storage.setItem(FINANCE_VIEW_STORAGE_KEY, JSON.stringify({ open: canonicalOpen(memory.open), depth: memory.depth }));
    return true;
  } catch {
    // A full or blocked store only loses the convenience; nothing on the page depends on it.
    return false;
  }
}

/** What the page shows: the URL wins, then the remembered view, then the defaults. */
export function resolveFinanceView(
  url: FinanceUrlState,
  memory: FinanceViewMemory | null,
): { open: readonly FinanceDetailKey[]; depth: FinanceDepth } {
  return {
    open: url.open ?? memory?.open ?? [],
    depth: url.depth ?? memory?.depth ?? "summary",
  };
}

// ── the summary request ───────────────────────────────────────────────────

/** What the summary depends on: a change to any of these is a new query (blank to skeletons, spec §7). */
export interface FinanceSummaryScope {
  readonly period: FinancePeriodPreset;
  readonly from: string | null;
  readonly to: string | null;
  readonly compare: boolean;
  readonly vendorId: number | null;
}

export function financeSummaryScope(state: FinanceUrlState): FinanceSummaryScope {
  return { period: state.period, from: state.from, to: state.to, compare: state.compare, vendorId: state.vendorId };
}

export function financeSummaryQueryKey(scope: FinanceSummaryScope) {
  return [
    DROPSHIP_FINANCE_QUERY_KEY_ROOT,
    "summary",
    { period: scope.period, from: scope.from, to: scope.to, compare: scope.compare, vendorId: scope.vendorId },
  ] as const;
}

/** The summary URL: only the params the strict query schema accepts, defaults left to the server. */
export function buildFinanceSummaryUrl(scope: FinanceSummaryScope): string {
  const custom = scope.period === "custom";
  return buildQueryUrl(DROPSHIP_FINANCE_SUMMARY_URL, {
    period: scope.period,
    from: custom ? scope.from : null,
    to: custom ? scope.to : null,
    compare: scope.compare ? null : "off",
    vendorId: scope.vendorId,
  });
}

/** A response the shared contract refuses: the page shows no number from it (spec §7). */
export class FinanceContractError extends Error {
  readonly code = "DROPSHIP_FINANCE_CONTRACT_VIOLATION";
  /** Where the response broke the contract (paths only, never values). */
  readonly issuePaths: readonly string[];

  constructor(issuePaths: readonly string[]) {
    super("The program finance response did not match its contract.");
    this.name = "FinanceContractError";
    this.issuePaths = Object.freeze([...issuePaths]);
  }
}

/** Validates the summary with the shared contract; throws FinanceContractError when it does not fit. */
export function parseFinanceSummary(value: unknown): FinanceSummary {
  const parsed = financeSummarySchema.safeParse(value);
  if (!parsed.success) throw new FinanceContractError(parsed.error.issues.map((issue) => issue.path.join(".")));
  return parsed.data;
}

/** Fetches and validates the summary. `fetcher` is injectable for tests. */
export async function fetchFinanceSummary(
  scope: FinanceSummaryScope,
  options: { signal?: AbortSignal; fetcher?: (url: string, init: { signal?: AbortSignal }) => Promise<unknown> } = {},
): Promise<FinanceSummary> {
  const fetcher = options.fetcher ?? ((url: string, init: { signal?: AbortSignal }) => fetchJson<unknown>(url, init));
  return parseFinanceSummary(await fetcher(buildFinanceSummaryUrl(scope), { signal: options.signal }));
}

// ── errors (spec §7, contract §5) ─────────────────────────────────────────

export type FinanceErrorClassification = "transient" | "permanent" | "fatal";
/** What the page shows for a failed request. */
export type FinanceErrorKind = "permission" | "invalid_period" | "load" | "unchecked";

export interface FinanceErrorClass {
  readonly kind: FinanceErrorKind;
  readonly classification: FinanceErrorClassification;
  readonly code: string | null;
  readonly serverMessage: string | null;
  /** Only transient failures are retried; a permanent or fatal one would fail the same way again. */
  readonly retry: boolean;
}

/** Codes whose numbers could not be checked: shown as such, never retried (spec §7). */
const UNCHECKED_CODES: ReadonlySet<string> = new Set(["DROPSHIP_FINANCE_CONTRACT_VIOLATION", "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE"]);
/** Gateway answers with no finance envelope (Heroku router, proxies): worth one more try. */
const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

function envelopeClassification(context: Readonly<Record<string, unknown>> | null): FinanceErrorClassification | null {
  const value = context?.classification;
  return value === "transient" || value === "permanent" || value === "fatal" ? value : null;
}

/**
 * Sorts a failed summary request (contract §5). The finance envelope's own
 * classification wins; without one, a 401/403 is the permission state (the
 * middleware's plain-string error, contract C15), a gateway status is
 * transient, and anything else is not retried. fetch() rejects with a
 * TypeError when the network fails, which is transient.
 */
export function classifyFinanceError(error: unknown): FinanceErrorClass {
  if (error instanceof FinanceContractError) {
    return { kind: "unchecked", classification: "fatal", code: error.code, serverMessage: null, retry: false };
  }
  if (error instanceof DropshipApiError) {
    if (error.status === 401 || error.status === 403) {
      return { kind: "permission", classification: "permanent", code: error.code, serverMessage: error.message, retry: false };
    }
    const classification =
      envelopeClassification(error.context)
      ?? (TRANSIENT_HTTP_STATUSES.has(error.status) ? "transient" : error.status >= 500 ? "fatal" : "permanent");
    if (error.code === "DROPSHIP_FINANCE_INVALID_PERIOD") {
      return { kind: "invalid_period", classification, code: error.code, serverMessage: error.message, retry: false };
    }
    if (error.code !== null && UNCHECKED_CODES.has(error.code)) {
      return { kind: "unchecked", classification: "fatal", code: error.code, serverMessage: error.message, retry: false };
    }
    return { kind: "load", classification, code: error.code, serverMessage: error.message, retry: classification === "transient" };
  }
  if (error instanceof TypeError) {
    return { kind: "load", classification: "transient", code: null, serverMessage: null, retry: true };
  }
  return { kind: "load", classification: "fatal", code: null, serverMessage: null, retry: false };
}

/** React Query `retry`: transient failures only, at most FINANCE_QUERY_MAX_RETRIES times. */
export function financeQueryRetry(failureCount: number, error: unknown): boolean {
  return failureCount < FINANCE_QUERY_MAX_RETRIES && classifyFinanceError(error).retry;
}

/** React Query `retryDelay`: 1s, 2s, … */
export function financeQueryRetryDelay(attemptIndex: number): number {
  return FINANCE_QUERY_RETRY_BASE_MS * 2 ** attemptIndex;
}

export interface FinancePageErrorView {
  readonly kind: FinanceErrorKind;
  readonly text: string;
  readonly code: string | null;
  readonly canRetry: boolean;
}

/** The period as asked for, for words shown before (or instead of) the server's resolved dates. */
export function financeRequestedPeriodText(state: FinanceUrlState): string {
  if (state.period === "custom" && state.from !== null && state.to !== null) return formatFinanceDateSpan(state.from, state.to);
  return lowerFirst(FINANCE_PERIOD_PRESET_LABELS[state.period]);
}

/** The page-level message for a request that failed as a whole (spec §7 "Errors"). */
export function buildFinancePageError(error: unknown, requestedPeriod: string): FinancePageErrorView {
  const sorted = classifyFinanceError(error);
  switch (sorted.kind) {
    case "permission":
      return { kind: "permission", text: FINANCE_PERMISSION_TEXT, code: null, canRetry: false };
    case "invalid_period": {
      const reason = sorted.serverMessage ? lowerFirst(withoutFinalStop(sorted.serverMessage.trim())) : "the period is not valid";
      return { kind: "invalid_period", text: `These dates don't work: ${reason}. Pick other dates.`, code: sorted.code, canRetry: false };
    }
    case "unchecked":
      return {
        kind: "unchecked",
        text: `These numbers could not be checked, so none are shown. (${sorted.code ?? "DROPSHIP_FINANCE_CONTRACT_VIOLATION"})`,
        code: sorted.code,
        canRetry: false,
      };
    case "load":
      return {
        kind: "load",
        text: `Couldn't load program finance for ${requestedPeriod}. Nothing is shown so older numbers can't be mistaken for current ones.${sorted.code ? ` (${sorted.code})` : ""}`,
        code: sorted.code,
        canRetry: true,
      };
  }
}

/** The custom range picker's own check before any request runs (spec §5). */
export function validateFinanceCustomRange(from: string | null, to: string | null, todayEastern: string): string | null {
  if (from === null || to === null || !isFinanceLocalDate(from) || !isFinanceLocalDate(to) || from > to) {
    return FINANCE_CUSTOM_RANGE_ORDER_TEXT;
  }
  if (to > todayEastern) return FINANCE_CUSTOM_RANGE_FUTURE_TEXT;
  return null;
}

// ── period words ──────────────────────────────────────────────────────────

/** How the page names the summary's window in its sentences. */
export interface FinancePeriodWords {
  /** "Oct 1 – 5, 2026" (bar), or "All time to Oct 5, 2026". */
  readonly label: string;
  /** "Oct 1 – 5" inside sentences, or "at any time". */
  readonly phrase: string;
  /** The first day ("Oct 1"), or "the start" for all time. */
  readonly startDay: string;
  /** The last day ("Oct 5"). */
  readonly endDay: string;
  readonly endsNow: boolean;
}

export function financePeriodWords(window: FinanceWindow): FinancePeriodWords {
  if (window.fromDate === null) {
    return {
      label: `All time to ${formatFinanceLocalDate(window.toDate)}`,
      phrase: "at any time",
      startDay: "the start",
      endDay: formatFinanceLocalDate(window.toDate, { withYear: false }),
      endsNow: window.endsNow,
    };
  }
  return {
    label: formatFinanceDateSpan(window.fromDate, window.toDate),
    phrase: formatFinanceDateSpan(window.fromDate, window.toDate, { withYear: false }),
    startDay: formatFinanceLocalDate(window.fromDate, { withYear: false }),
    endDay: formatFinanceLocalDate(window.toDate, { withYear: false }),
    endsNow: window.endsNow,
  };
}

/**
 * The comparison span as the deltas name it: "Sep 1 – 5" (spec §10 "vs {span}").
 */
export function financeCompareSpan(summary: FinanceSummary): string | null {
  const compare = summary.comparePeriod;
  if (compare === null || compare.fromDate === null) return null;
  return formatFinanceDateSpan(compare.fromDate, compare.toDate, { withYear: false });
}

/**
 * The comparison span on the Compare switch, which also says how the window
 * was cut: "(to 9:14 AM)" when this period is "so far", or "(Feb has 28
 * days)" when the month-to-date window was clamped to a shorter month
 * (spec §3.1, §7).
 */
export function financeCompareSwitchSpan(summary: FinanceSummary): string | null {
  const compare = summary.comparePeriod;
  const span = financeCompareSpan(summary);
  if (compare === null || span === null) return null;
  if (compare.clampedToMonthEnd) {
    const end = parseLocalDate(compare.toDate);
    if (end) return `${span} (${MONTHS_SHORT[end.month - 1]} has ${end.day} days)`;
  }
  if (summary.period.endsNow && !compare.endsNow) return `${span} (to ${formatFinanceClockTime(compare.endAt)})`;
  return span;
}

// ── lines ─────────────────────────────────────────────────────────────────

type LineIndex = ReadonlyMap<string, FinanceLine>;

function indexLines(lines: readonly FinanceLine[]): LineIndex {
  return new Map(lines.map((line) => [line.key, line]));
}

/** Summary depth hides "every line" lines that are zero (contract `depth`). */
function isLineShown(line: FinanceLine, depth: FinanceDepth): boolean {
  return !(depth === "summary" && line.depth === "every_line" && line.amount === 0);
}

function formatUnitAmount(amount: number, unit: FinanceUnit, signed: boolean): string {
  switch (unit) {
    case "cents":
      return signed ? formatFinanceMoney(amount) : formatFinanceMagnitude(amount);
    case "points":
      return formatFinancePoints(signed || !isFinanceSafeInteger(amount) ? amount : Math.abs(amount));
    case "count":
      return formatFinanceCount(amount);
  }
}

/**
 * The text in a line's amount cell. Lines with a + or − operator are shown
 * unsigned; results and balances keep their sign (spec §6).
 */
export function formatFinanceLineAmount(line: FinanceLine, options: { noneWhenZero?: boolean } = {}): string {
  if (line.status === "not_recorded") return FINANCE_NOT_RECORDED_TEXT;
  if (line.status === "unavailable") return FINANCE_UNAVAILABLE_TEXT;
  if (line.amount === null) return FINANCE_PARTIAL_TEXT;
  if (options.noneWhenZero && line.amount === 0) return FINANCE_NONE_THIS_PERIOD_TEXT;
  const signed = line.operator === "none" || line.operator === "equals";
  return formatUnitAmount(line.amount, line.unit, signed);
}

function reasonWords(line: FinanceLine): string | null {
  if (line.reasonKey === undefined || !isFinanceReasonKey(line.reasonKey)) return null;
  return fillFinanceWords(FINANCE_REASON_DEFINITIONS[line.reasonKey].words, {
    n: line.count !== undefined ? formatFinanceCount(line.count) : "some",
  });
}

/**
 * Why a line is not a plain recorded number, in words (spec §7): the
 * not-recorded reason, "Some amounts missing: …", or "Unavailable: … (CODE)".
 * Null for a recorded line.
 */
export function financeLineNote(line: FinanceLine): string | null {
  const reason = reasonWords(line);
  switch (line.status) {
    case "recorded":
      return null;
    case "not_recorded":
      return reason ?? "Echelon does not record this.";
    case "partial": {
      // Some reasons are written as a suffix ("(1 unknown)"); inside a sentence they lose the brackets.
      const why = reason ? lowerFirst(withoutFinalStop(reason.replace(/^\((.*)\)$/, "$1"))) : null;
      return why ? `${FINANCE_PARTIAL_TEXT}: ${why}.` : `${FINANCE_PARTIAL_TEXT}.`;
    }
    case "unavailable": {
      // A program-wide figure in a vendor's view is not a failure: say why, without a code.
      if (line.reasonKey === "program_wide" && reason) return reason;
      const why = reason ? lowerFirst(withoutFinalStop(reason)) : "this data isn't set up here";
      return `${FINANCE_UNAVAILABLE_TEXT}: ${why}${line.errorCode ? ` (${line.errorCode})` : ""}.`;
    }
  }
}

// ── check dots (spec §8: the amber dot beside a figure whose check needs a look) ──

export interface FinanceCheckDotView {
  readonly checkId: FinanceCheckId;
  /** "Check K2 needs a look: Cost-of-goods rows add up, …" */
  readonly label: string;
}

type CheckDotIndex = ReadonlyMap<string, readonly FinanceCheckDotView[]>;

function indexCheckDots(checks: readonly FinanceCheck[]): CheckDotIndex {
  const index = new Map<string, FinanceCheckDotView[]>();
  for (const check of checks) {
    if (check.result !== "needs_a_look") continue;
    const dot = { checkId: check.id, label: `Check ${check.id} needs a look: ${FINANCE_CHECK_DEFINITIONS[check.id].wording}` };
    for (const key of check.ownerLineKeys) index.set(key, [...(index.get(key) ?? []), dot]);
  }
  return index;
}

// ── statement rows (spec §3.4) ────────────────────────────────────────────

export type FinanceStatementEmphasis = "none" | "subtotal" | "result";

export interface FinanceStatementRowView {
  readonly key: FinanceLineKey;
  readonly operator: FinanceOperator;
  /** "+", "−", "=" or "" for the aria-hidden operator column. */
  readonly operatorSymbol: string;
  /** "plus", "minus", "equals" or "" for screen readers. */
  readonly operatorWords: string;
  readonly label: string;
  readonly amount: string;
  readonly status: FinanceLineStatus;
  readonly emphasis: FinanceStatementEmphasis;
  /** True when the amount is below zero and is shown signed (a loss, a negative pool). */
  readonly negative: boolean;
  /** The reason behind "Not recorded", for the ⓘ button. */
  readonly info: string | null;
  /** Muted sub-lines under the label, already worded. */
  readonly subLines: readonly string[];
  /** Server workings exist for this line: it can open "How this is worked out". */
  readonly hasWorkings: boolean;
  readonly checkDots: readonly FinanceCheckDotView[];
}

export interface FinanceStatementView {
  /** The table caption (screen readers and the visible heading of a second statement). */
  readonly caption: string;
  readonly heading: string | null;
  readonly rows: readonly FinanceStatementRowView[];
}

export type FinanceMemoIcon = "none" | "clock" | "fine" | "attention" | "info";

export interface FinanceMemoView {
  readonly key: string;
  readonly text: string;
  readonly icon: FinanceMemoIcon;
  /** Extra words for the ⓘ button, when the memo has a reason. */
  readonly info: string | null;
  readonly checkDots: readonly FinanceCheckDotView[];
}

interface CountNoun {
  readonly one: string;
  readonly many: string;
}

const ORDERS: CountNoun = { one: "order", many: "orders" };
const VENDORS: CountNoun = { one: "vendor", many: "vendors" };
const DEPOSITS: CountNoun = { one: "deposit", many: "deposits" };

/** One part of a muted sub-line ("product $133.20", "shipping $54.10 (carrier estimate …)"). */
interface FinancePartSpec {
  readonly key: FinanceLineKey;
  readonly nested?: readonly FinanceLineKey[];
  readonly countNoun?: CountNoun;
  readonly percent?: boolean;
  /** "(2,200 points)" from the answer: the points behind the billed value. */
  readonly pointsOfAnswer?: boolean;
}

/** One statement line and its sub-lines, in the section's statement order. */
interface FinanceRowSpec {
  readonly key: FinanceLineKey;
  /** " · 10 orders", or " · 1" with "plain". */
  readonly countNoun?: CountNoun | "plain";
  readonly percent?: boolean;
  readonly emphasis?: Exclude<FinanceStatementEmphasis, "none">;
  /** Adds the line's clock ("· day posted") where it differs from the row's chip. */
  readonly showDatedBy?: boolean;
  /** A true zero reads "None this period" (fees and credits, spec §3.4 A). */
  readonly noneWhenZero?: boolean;
  readonly subLines?: readonly (readonly FinancePartSpec[])[];
  /** A fixed muted sub-line from the copy deck. */
  readonly note?: string;
}

const OPERATOR_SYMBOLS: Readonly<Record<FinanceOperator, string>> = Object.freeze({ none: "", plus: "+", minus: MINUS, equals: "=" });
const OPERATOR_WORDS: Readonly<Record<FinanceOperator, string>> = Object.freeze({ none: "", plus: "plus", minus: "minus", equals: "equals" });

interface SectionContext {
  readonly summary: FinanceSummary;
  readonly lines: LineIndex;
  readonly depth: FinanceDepth;
  readonly period: FinancePeriodWords;
  readonly dots: CheckDotIndex;
}

/**
 * A line's words with its placeholders filled. Lines that are "now" in the
 * present switch to their end-of-period words for a period that ended
 * ("Held at end of Sep 30"). {date} is the first day, or the last day in
 * end-of-period words.
 */
function lineWords(ctx: SectionContext, key: FinanceLineKey, extra: Readonly<Record<string, string>> = {}): string {
  const definition = FINANCE_LINE_DEFINITIONS[key];
  const atEnd = !ctx.period.endsNow && definition.wordsAtEndOfPeriod !== undefined;
  const template = atEnd ? (definition.wordsAtEndOfPeriod ?? definition.words) : definition.words;
  return fillFinanceWords(template, {
    period: ctx.period.phrase,
    date: atEnd ? ctx.period.endDay : ctx.period.startDay,
    ...extra,
  });
}

function partText(ctx: SectionContext, part: FinancePartSpec): string | null {
  const line = ctx.lines.get(part.key);
  if (!line || !isLineShown(line, ctx.depth)) return null;
  const amount = formatFinanceLineAmount({ ...line, operator: "none" });
  const definitionWords = FINANCE_LINE_DEFINITIONS[part.key].words;
  if (line.status === "not_recorded" || line.status === "unavailable") {
    return `${lineWords(ctx, part.key)}: ${lowerFirst(amount)}`;
  }
  if (definitionWords.includes("{$}")) return lineWords(ctx, part.key, { $: amount });
  if (part.countNoun && line.count !== undefined) {
    return `${lineWords(ctx, part.key)}: ${formatFinanceCountOf(line.count, part.countNoun.one, part.countNoun.many)}, ${amount}`;
  }
  const label = lineWords(ctx, part.key);
  let text = line.unit === "count" ? `${label}: ${amount}` : `${label} ${amount}`;
  if (part.percent) text += ` (${formatFinancePercent(line.percentTenths)})`;
  if (part.pointsOfAnswer && ctx.summary.answer.status === "ok") {
    text += ` (${formatFinancePoints(ctx.summary.answer.paidWithPoints.points)})`;
  }
  if (part.nested) {
    const nested = part.nested.map((key) => partText(ctx, { key })).filter((value): value is string => value !== null);
    if (nested.length > 0) text += ` (${nested.join(" · ")})`;
  }
  if (line.status === "partial") text += ` (${lowerFirst(FINANCE_PARTIAL_TEXT)})`;
  return text;
}

function buildStatementRow(ctx: SectionContext, spec: FinanceRowSpec): FinanceStatementRowView | null {
  const line = ctx.lines.get(spec.key);
  if (!line || !isLineShown(line, ctx.depth)) return null;
  let label = lineWords(ctx, spec.key);
  if (spec.countNoun && line.count !== undefined) {
    label += spec.countNoun === "plain"
      ? ` · ${formatFinanceCount(line.count)}`
      : ` · ${formatFinanceCountOf(line.count, spec.countNoun.one, spec.countNoun.many)}`;
  }
  if (spec.percent && line.percentTenths !== undefined && line.percentTenths !== null) {
    label += ` · ${formatFinancePercent(line.percentTenths)}`;
  }
  if (spec.showDatedBy) label += ` · ${FINANCE_DATED_BY_DEFINITIONS[line.datedBy].words}`;

  const subLines: string[] = [];
  if (spec.note) subLines.push(spec.note);
  for (const group of spec.subLines ?? []) {
    const parts = group.map((part) => partText(ctx, part)).filter((value): value is string => value !== null);
    if (parts.length > 0) subLines.push(parts.join(" · "));
  }
  const note = financeLineNote(line);
  // "Not recorded" carries its reason in the ⓘ button; partial and unavailable say it on the line.
  if (note && line.status !== "not_recorded") subLines.push(note);

  const signed = line.operator === "none" || line.operator === "equals";
  return {
    key: spec.key,
    operator: line.operator,
    operatorSymbol: OPERATOR_SYMBOLS[line.operator],
    operatorWords: OPERATOR_WORDS[line.operator],
    label,
    amount: formatFinanceLineAmount(line, { noneWhenZero: spec.noneWhenZero }),
    status: line.status,
    emphasis: spec.emphasis ?? "none",
    negative: signed && line.amount !== null && line.amount < 0,
    info: line.status === "not_recorded" ? note : null,
    subLines,
    hasWorkings: (line.workings?.length ?? 0) > 0,
    checkDots: ctx.dots.get(spec.key) ?? [],
  };
}

function buildStatement(ctx: SectionContext, caption: string, heading: string | null, specs: readonly FinanceRowSpec[]): FinanceStatementView {
  return {
    caption,
    heading,
    rows: specs.map((spec) => buildStatementRow(ctx, spec)).filter((row): row is FinanceStatementRowView => row !== null),
  };
}

function memo(ctx: SectionContext, key: string, text: string, options: { icon?: FinanceMemoIcon; info?: string | null; dotsFor?: FinanceLineKey } = {}): FinanceMemoView {
  return {
    key,
    text,
    icon: options.icon ?? "none",
    info: options.info ?? null,
    checkDots: options.dotsFor ? ctx.dots.get(options.dotsFor) ?? [] : [],
  };
}

function countAndMoney(line: FinanceLine): string {
  const amount = formatFinanceLineAmount({ ...line, operator: "none" });
  return line.count !== undefined ? `${formatFinanceCount(line.count)} · ${amount}` : amount;
}

const SALES_ROWS: readonly FinanceRowSpec[] = Object.freeze([
  {
    key: "sales.billed",
    countNoun: ORDERS,
    subLines: [
      [
        { key: "sales.billed.product" },
        { key: "sales.billed.shipping", nested: ["sales.billed.carrier_estimate", "sales.billed.markup", "sales.billed.pool_share"] },
      ],
      [{ key: "sales.billed.paid_from_wallets" }, { key: "sales.billed.paid_with_points", pointsOfAnswer: true }],
    ],
  },
  {
    key: "sales.waiting",
    countNoun: ORDERS,
    subLines: [FINANCE_WAITING_REASONS.map((reason) => ({ key: `sales.waiting.${reason}` as const, countNoun: ORDERS }))],
  },
  { key: "sales.billed_fc", countNoun: ORDERS, emphasis: "subtotal" },
  { key: "sales.cogs" },
  { key: "sales.labels", subLines: [[{ key: "sales.labels.replacement" }]] },
  { key: "sales.pool_fc" },
  { key: "sales.packaging" },
  {
    key: "sales.kept_orders",
    percent: true,
    emphasis: "subtotal",
    subLines: [[{ key: "sales.kept_orders.on_products", percent: true }, { key: "sales.kept_orders.on_shipping", percent: true }]],
  },
  {
    key: "sales.fees",
    showDatedBy: true,
    noneWhenZero: true,
    subLines: [[{ key: "sales.fees.advance" }, { key: "sales.fees.card" }, { key: "sales.fees.returns" }]],
  },
  { key: "sales.return_credits_cs", showDatedBy: true, noneWhenZero: true },
  { key: "sales.kept", emphasis: "result" },
]);

const CASH_ROWS: readonly FinanceRowSpec[] = Object.freeze([
  { key: "cash.ach", countNoun: "plain" },
  { key: "cash.card", countNoun: "plain", subLines: [[{ key: "cash.card.fees" }]] },
  {
    key: "cash.usdc",
    countNoun: "plain",
    note: FINANCE_USDC_NOTE,
    subLines: [[{ key: "cash.usdc.chain_watcher" }, { key: "cash.usdc.staff_confirmed" }]],
  },
  { key: "cash.collection", countNoun: "plain" },
  { key: "cash.unknown", countNoun: "plain" },
  { key: "cash.received_deposits", emphasis: "subtotal" },
  { key: "cash.pulled_back", countNoun: "plain" },
  { key: "cash.won_back", countNoun: "plain" },
  { key: "cash.received", emphasis: "result" },
]);

const RETURNS_ROWS: readonly FinanceRowSpec[] = Object.freeze([
  {
    key: "returns.credits_cs",
    countNoun: "plain",
    subLines: [[{ key: "returns.credits_cs.inspected" }, { key: "returns.credits_cs.return_case" }]],
  },
  {
    key: "returns.credits_pool",
    countNoun: "plain",
    subLines: [[
      { key: "returns.credits_pool.no_inspection" },
      { key: "returns.credits_pool.inspection_fault" },
      { key: "returns.credits_pool.return_case_fault" },
    ]],
  },
  {
    key: "returns.fees",
    subLines: [[
      { key: "returns.fees.restocking" },
      { key: "returns.fees.processing" },
      { key: "returns.fees.return_label" },
      { key: "returns.fees.split_not_recorded" },
    ]],
  },
  { key: "returns.net", emphasis: "subtotal" },
]);

const OWED_NOW_ROWS: readonly FinanceRowSpec[] = Object.freeze([
  { key: "owed.we_owe", countNoun: VENDORS },
  { key: "owed.they_owe", countNoun: VENDORS, note: "Echelon does not record the cause." },
  { key: "owed.on_the_way", countNoun: "plain" },
]);

const OWED_WALK_ROWS: readonly FinanceRowSpec[] = Object.freeze([
  { key: "owed.walk.opening" },
  { key: "owed.walk.deposits" },
  { key: "owed.walk.staff_credits" },
  { key: "owed.walk.return_credits_cs" },
  { key: "owed.walk.return_credits_pool" },
  { key: "owed.walk.disputes_won" },
  { key: "owed.walk.orders" },
  { key: "owed.walk.advance_fees" },
  { key: "owed.walk.return_fees" },
  { key: "owed.walk.disputes_taken" },
  { key: "owed.walk.other" },
  { key: "owed.walk.unexplained" },
  {
    key: "owed.walk.closing",
    emphasis: "result",
    subLines: [[{ key: "owed.walk.we_owe" }, { key: "owed.walk.they_owe" }], [{ key: "owed.walk.on_the_way" }]],
  },
]);

const POINTS_ROWS: readonly FinanceRowSpec[] = Object.freeze([
  { key: "points.opening" },
  {
    key: "points.given",
    subLines: [[{ key: "points.given.bank" }, { key: "points.given.card" }, { key: "points.given.usdc" }, { key: "points.given.other" }]],
  },
  { key: "points.used", subLines: [[{ key: "points.used.billed_value" }]] },
  { key: "points.expired" },
  { key: "points.taken_back" },
  { key: "points.given_back" },
  { key: "points.held", emphasis: "result" },
]);

const POOL_ROWS: readonly FinanceRowSpec[] = Object.freeze([
  { key: "pool.opening" },
  { key: "pool.set_aside" },
  {
    key: "pool.paid_out",
    countNoun: "plain",
    subLines: [[{ key: "pool.paid_out.no_inspection" }, { key: "pool.paid_out.inspection_fault" }, { key: "pool.paid_out.return_case_fault" }]],
  },
  { key: "pool.topped_up" },
  { key: "pool.closing", emphasis: "result" },
]);

// ── section memos (spec §3.4 memo lines) ──────────────────────────────────

function salesMemos(ctx: SectionContext): FinanceMemoView[] {
  const memos: FinanceMemoView[] = [];
  const notTakenOff = (
    ["sales.memo.points_used", "sales.memo.staff_credits", "sales.memo.pool_credits", "sales.memo.stripe_fees", "sales.memo.overheads"] as const
  )
    .map((key) => {
      const line = ctx.lines.get(key);
      if (!line || !isLineShown(line, ctx.depth)) return null;
      const words = lineWords(ctx, key);
      if (line.status === "not_recorded") {
        // "overheads (not on this page)" already says why; the others say they are not recorded.
        return words.includes("(") ? words : `${words} (not recorded)`;
      }
      return `${words} ${formatFinanceLineAmount({ ...line, operator: "none" })}`;
    })
    .filter((part): part is string => part !== null);
  if (notTakenOff.length > 0) memos.push(memo(ctx, "not_taken_off", `${FINANCE_NOT_TAKEN_OFF_HEADING} ${notTakenOff.join(" · ")}`));

  const buyer = ctx.lines.get("sales.buyer_paid");
  if (buyer && isLineShown(buyer, ctx.depth)) {
    // `count` is the number of orders with no buyer total (contract §2.1); "(0 unknown)" is left out.
    const unknown = buyer.count ?? 0;
    const template = FINANCE_LINE_DEFINITIONS["sales.buyer_paid"].words;
    const words = fillFinanceWords(unknown > 0 ? template : template.replace(" ({n} unknown)", ""), {
      $: formatFinanceLineAmount({ ...buyer, operator: "none" }),
      n: formatFinanceCount(unknown),
    });
    memos.push(memo(ctx, "sales.buyer_paid", words, { info: FINANCE_REASON_DEFINITIONS.buyers_paid.words }));
  }

  const neverCharged = ctx.lines.get("sales.never_charged");
  if (neverCharged && isLineShown(neverCharged, ctx.depth) && neverCharged.amount !== null) {
    const kinds = FINANCE_NEVER_CHARGED_KINDS.map((kind) => {
      const line = ctx.lines.get(`sales.never_charged.${kind}`);
      return line && line.amount !== null && line.amount > 0 ? `${formatFinanceCount(line.amount)} ${lineWords(ctx, `sales.never_charged.${kind}`)}` : null;
    }).filter((part): part is string => part !== null);
    const wouldHave = ctx.lines.get("sales.never_charged.would_have_charged");
    // "{n} orders" becomes one counted noun so a single order reads "1 order".
    const template = FINANCE_LINE_DEFINITIONS["sales.never_charged"].words.replace("{n} orders", "{orders}");
    let text = `${fillFinanceWords(template, {
      period: ctx.period.phrase,
      orders: formatFinanceCountOf(neverCharged.amount, "order", "orders"),
    })}${kinds.length > 0 ? ` (${kinds.join(" · ")})` : ""}`;
    if (wouldHave && wouldHave.amount !== null && wouldHave.amount > 0) {
      text += ` · ${lineWords(ctx, "sales.never_charged.would_have_charged")} ${formatFinanceLineAmount({ ...wouldHave, operator: "none" })}`;
    }
    memos.push(memo(ctx, "sales.never_charged", text));
  }

  const coverage = ctx.lines.get("sales.label_coverage");
  if (coverage?.coverage) {
    memos.push(memo(ctx, "sales.label_coverage", fillFinanceWords(FINANCE_LINE_DEFINITIONS["sales.label_coverage"].words, {
      x: formatFinanceCount(coverage.coverage.done),
      y: formatFinanceCount(coverage.coverage.total),
      period: ctx.period.phrase,
    }), { dotsFor: "sales.labels" }));
  }
  return memos;
}

function cashMemos(ctx: SectionContext): FinanceMemoView[] {
  const memos: FinanceMemoView[] = [];
  const autoTopUps = ctx.lines.get("cash.memo.auto_top_ups");
  if (autoTopUps && isLineShown(autoTopUps, ctx.depth)) {
    const parts = (["cash.memo.auto_top_ups.minimum_balance", "cash.memo.auto_top_ups.payment_hold"] as const)
      .map((key) => partText(ctx, { key }))
      .filter((part): part is string => part !== null);
    memos.push(memo(ctx, "cash.memo.auto_top_ups",
      `${lineWords(ctx, "cash.memo.auto_top_ups")}: ${countAndMoney(autoTopUps)}${parts.length > 0 ? ` (${parts.join(" · ")})` : ""}`));
  }
  const onTheWay = ctx.lines.get("cash.memo.on_the_way");
  if (onTheWay && onTheWay.amount !== null) {
    const deposits = onTheWay.count !== undefined ? `${formatFinanceCountOf(onTheWay.count, DEPOSITS.one, DEPOSITS.many)} · ` : "";
    memos.push(memo(ctx, "cash.memo.on_the_way",
      `${lineWords(ctx, "cash.memo.on_the_way")}: ${deposits}${formatFinanceMoney(onTheWay.amount)} (not yet cash)`,
      { icon: "clock", info: FINANCE_INFO_TEXT.onTheWay, dotsFor: "cash.memo.on_the_way" }));
  }
  const stuck = ctx.lines.get("cash.memo.stuck");
  if (stuck && stuck.amount !== null) {
    memos.push(memo(ctx, "cash.memo.stuck",
      `${lineWords(ctx, "cash.memo.stuck")}: ${stuck.amount === 0 && (stuck.count ?? 0) === 0 ? "none" : countAndMoney(stuck)}`,
      { icon: stuck.amount === 0 ? "none" : "clock", dotsFor: "cash.memo.stuck" }));
  }
  const failed = ctx.lines.get("cash.memo.failed");
  if (failed && failed.amount !== null) {
    const none = failed.amount === 0 && (failed.count ?? 0) === 0;
    const code = failed.failureCode ? ` (code ${failed.failureCode})` : "";
    const text = none
      ? `Failed ${ctx.period.phrase}: none`
      : `Failed ${ctx.period.phrase}: ${countAndMoney(failed)}${code}: never counted as cash`;
    memos.push(memo(ctx, "cash.memo.failed", text, { dotsFor: "cash.memo.failed" }));
  }
  const notWonBack = ctx.lines.get("cash.memo.not_won_back");
  if (notWonBack && notWonBack.amount !== null && isLineShown(notWonBack, ctx.depth)) {
    memos.push(memo(ctx, "cash.memo.not_won_back", `${lineWords(ctx, "cash.memo.not_won_back")}: ${countAndMoney(notWonBack)}`, {
      info: FINANCE_REASON_DEFINITIONS.dispute_outcome_not_saved.words,
    }));
  }
  const staff = ctx.lines.get("cash.memo.staff_credits");
  if (staff && staff.amount !== null && isLineShown(staff, ctx.depth)) {
    memos.push(memo(ctx, "cash.memo.staff_credits", `Staff wallet credits aren't cash: ${countAndMoney(staff)}, see Returns and credits`));
  }
  const notRecorded = notRecordedMemo(ctx, "cash.not_recorded", ["cash.memo.stripe_fees", "cash.memo.usdc_moved_out"]);
  if (notRecorded) memos.push(notRecorded);
  return memos;
}

function notRecordedMemo(ctx: SectionContext, key: string, lineKeys: readonly FinanceLineKey[]): FinanceMemoView | null {
  const lines = lineKeys
    .map((lineKey) => ({ lineKey, line: ctx.lines.get(lineKey) }))
    .filter((entry): entry is { lineKey: FinanceLineKey; line: FinanceLine } => entry.line?.status === "not_recorded");
  if (lines.length === 0) return null;
  const words = lines.map((entry) => lineWords(ctx, entry.lineKey)).join(" · ");
  const reasons = lines.map((entry) => financeLineNote(entry.line)).filter((note): note is string => note !== null);
  return memo(ctx, key, `Not recorded: ${words}`, { icon: "info", info: reasons.join(" ") || null });
}

function returnsMemos(ctx: SectionContext): FinanceMemoView[] {
  const memos: FinanceMemoView[] = [];
  const staff = ctx.lines.get("returns.staff_credits");
  if (staff && staff.amount !== null && isLineShown(staff, ctx.depth)) {
    memos.push(memo(ctx, "returns.staff_credits", `${lineWords(ctx, "returns.staff_credits")} · ${countAndMoney(staff)}`));
  }
  const refunds = ctx.lines.get("returns.memo.order_refunds");
  if (refunds) {
    memos.push(memo(ctx, "returns.memo.order_refunds", lineWords(ctx, "returns.memo.order_refunds"), {
      icon: "info",
      info: financeLineNote(refunds),
    }));
  }
  const notRecorded = notRecordedMemo(ctx, "returns.not_recorded", ["returns.memo.restocked_value", "returns.memo.return_label_cost"]);
  if (notRecorded) memos.push(notRecorded);
  return memos;
}

function owedMemos(ctx: SectionContext): FinanceMemoView[] {
  const history = ctx.lines.get("owed.history_matches");
  if (!history?.coverage) return [];
  const { done, total } = history.coverage;
  if (done === total) {
    return [memo(ctx, "owed.history_matches", `${lineWords(ctx, "owed.history_matches")} (${formatFinanceCount(done)} of ${formatFinanceCount(total)})`, {
      icon: "fine",
      dotsFor: "owed.history_matches",
    })];
  }
  const differing = total - done;
  const by = history.amount !== null && history.amount !== 0 ? ` by ${formatFinanceMagnitude(history.amount)}` : "";
  return [memo(ctx, "owed.history_matches",
    `${formatFinanceCountOf(differing, "wallet differs", "wallets differ")} from its history${by} (${formatFinanceCount(done)} of ${formatFinanceCount(total)} match)`,
    { icon: "attention", dotsFor: "owed.history_matches" })];
}

function pointsMemos(ctx: SectionContext): FinanceMemoView[] {
  const memos: FinanceMemoView[] = [];
  const heldNow = ctx.lines.get("points.held_now");
  if (heldNow && heldNow.amount !== null) {
    memos.push(memo(ctx, "points.held_now", `${lineWords(ctx, "points.held_now")}: ${formatFinancePoints(heldNow.amount)}`, { dotsFor: "points.held_now" }));
  }
  const fromCash = ctx.lines.get("points.memo.from_cash");
  if (fromCash && fromCash.amount !== null && isLineShown(fromCash, ctx.depth)) {
    memos.push(memo(ctx, "points.memo.from_cash",
      `${lineWords(ctx, "points.memo.from_cash")}: ${fromCash.amount === 0 ? "none" : `${formatFinanceMoney(fromCash.amount)} (points that were already spent)`}`));
  }
  const buckets = (["points.expiry.next_30_days", "points.expiry.days_31_to_90", "points.expiry.later", "points.expiry.never"] as const)
    .map((key) => {
      const line = ctx.lines.get(key);
      // An empty bucket comes as an "every line" line: Summary leaves it out like any other.
      return line && line.amount !== null && isLineShown(line, ctx.depth) ? `${lineWords(ctx, key)} ${formatFinancePoints(line.amount)}` : null;
    })
    .filter((part): part is string => part !== null);
  if (buckets.length > 0) memos.push(memo(ctx, "points.expiry", `${FINANCE_POINTS_EXPIRY_HEADING} ${buckets.join(" · ")}`));
  return memos;
}

function poolMemos(ctx: SectionContext): FinanceMemoView[] {
  const memos: FinanceMemoView[] = [];
  const closing = ctx.lines.get("pool.closing");
  if (closing && closing.status === "recorded" && closing.amount !== null && closing.amount < 0) {
    memos.push(memo(ctx, "pool.below_zero",
      "The worked-out pool is below zero: more was paid out of it than was set aside and topped up.", { icon: "attention" }));
  }
  const claims = ctx.lines.get("pool.claims");
  if (claims && claims.amount !== null) {
    memos.push(memo(ctx, "pool.claims", fillFinanceWords(FINANCE_LINE_DEFINITIONS["pool.claims"].words, {
      n: formatFinanceCount(claims.count ?? 0),
      $: formatFinanceMoney(claims.amount),
    }), { info: FINANCE_REASON_DEFINITIONS.claims_stop_at_filing.words }));
  } else if (claims) {
    const note = financeLineNote(claims);
    if (note) memos.push(memo(ctx, "pool.claims", note, { icon: "info" }));
  }
  const record = ctx.lines.get("pool.record");
  if (record && record.amount !== null) {
    memos.push(memo(ctx, "pool.record", fillFinanceWords(FINANCE_LINE_DEFINITIONS["pool.record"].words, { $: formatFinanceMoney(record.amount) }), {
      icon: "info",
      info: FINANCE_REASON_DEFINITIONS.pool_record_incomplete.words,
    }));
  } else if (record) {
    const note = financeLineNote(record);
    if (note) memos.push(memo(ctx, "pool.record", note, { icon: "info" }));
  }
  return memos;
}

// ── the detail rows (spec §3.4) ───────────────────────────────────────────

export type FinanceRowAmountTone = "default" | "muted" | "loss" | "fine" | "attention";

export interface FinanceDetailRowView {
  readonly key: FinanceDetailKey;
  readonly title: string;
  /** The clock chip ("day accepted"). */
  readonly chip: string | null;
  readonly summary: string;
  readonly amount: string;
  readonly amountTone: FinanceRowAmountTone;
  readonly state: "ok" | "error" | "skipped";
  /** "Couldn't work out cash in: CODE." / "Took too long; try a shorter period." */
  readonly errorText: string | null;
  readonly statements: readonly FinanceStatementView[];
  readonly memos: readonly FinanceMemoView[];
}

export interface FinanceDetailGroupView {
  readonly group: FinanceSectionGroup;
  readonly caption: string;
  readonly keys: readonly FinanceDetailKey[];
}

const DETAIL_GROUP_ORDER: readonly FinanceSectionGroup[] = ["orders", "money", "balances", "program"];

/**
 * The detail rows under their group captions (spec §3.4). In a vendor's view
 * the Vendors row is left out: part 2 replaces it with the vendor's wallet
 * history.
 */
export function buildFinanceDetailGroups(period: FinancePeriodWords | null, vendorScoped: boolean): FinanceDetailGroupView[] {
  const phrase = period?.phrase ?? "in this period";
  return DETAIL_GROUP_ORDER.map((group) => ({
    group,
    caption: fillFinanceWords(FINANCE_SECTION_GROUP_CAPTIONS[group], { period: phrase }),
    keys: [
      ...FINANCE_SECTION_KEYS.filter((key) => FINANCE_SECTION_DEFINITIONS[key].group === group && !(vendorScoped && key === "vendors")),
      ...(group === "program" ? (["checks"] as const) : []),
    ],
  }));
}

/** A detail row's title, for the loading skeleton (real titles, spec §7). */
export function financeDetailTitle(key: FinanceDetailKey): string {
  return key === "checks" ? FINANCE_CHECKS_ROW.title : FINANCE_SECTION_DEFINITIONS[key].title;
}

function sectionErrorText(key: FinanceSectionKey, status: "ok" | "error" | "skipped", errorCode: string | undefined): string | null {
  if (status === "ok") return null;
  if (status === "skipped") return FINANCE_SECTION_STATUS_WORDS.skipped;
  return fillFinanceWords(FINANCE_SECTION_STATUS_WORDS.error, {
    section: lowerFirst(FINANCE_SECTION_DEFINITIONS[key].title),
    code: errorCode ?? "DROPSHIP_FINANCE_INTERNAL_ERROR",
  });
}

function amountOf(lines: LineIndex, key: FinanceLineKey): number | null {
  const line = lines.get(key);
  return line && (line.status === "recorded" || line.status === "partial") ? line.amount : null;
}

/**
 * The figure a collapsed row is built on, or the plain words for why it has
 * none (spec §7): "Unavailable" when it could not be worked out this time
 * (Try again may bring it back), "Not recorded" only for what Echelon never
 * records, and "Some amounts missing" for a partial line with no total.
 */
type HeadlineFigure = { readonly amount: number } | { readonly missing: string };

function headlineFigure(lines: LineIndex, key: FinanceLineKey): HeadlineFigure {
  const line = lines.get(key);
  if (!line || line.status === "unavailable") return { missing: FINANCE_UNAVAILABLE_TEXT };
  if (line.status === "not_recorded") return { missing: FINANCE_NOT_RECORDED_TEXT };
  if (line.amount === null) return { missing: FINANCE_PARTIAL_TEXT };
  return { amount: line.amount };
}

/** A collapsed row's amount: the copy deck's words around the figure ("$26.41 kept"), or the reason there is none, muted. */
function headlineAmount(
  figure: HeadlineFigure,
  words: (amount: number) => string,
): { amount: string; tone: FinanceRowAmountTone } {
  return "missing" in figure ? { amount: figure.missing, tone: "muted" } : { amount: words(figure.amount), tone: "default" };
}

function countText(value: number | null, noun: CountNoun): string {
  return value === null ? FINANCE_NOT_RECORDED_TEXT : formatFinanceCountOf(value, noun.one, noun.many);
}

const CASH_RAIL_WORDS: readonly (readonly [FinanceLineKey, string])[] = [
  ["cash.ach", "bank"],
  ["cash.card", "card"],
  ["cash.usdc", "USDC"],
  ["cash.collection", "weekly collection"],
  ["cash.unknown", "way paid not recorded"],
];

function collapsedSummary(key: FinanceSectionKey, ctx: SectionContext): { summary: string; amount: string; tone: FinanceRowAmountTone } {
  const definition = FINANCE_SECTION_DEFINITIONS[key];
  const lines = ctx.lines;
  const money = (lineKey: FinanceLineKey) =>
    headlineAmount(headlineFigure(lines, lineKey), (amount) => fillFinanceWords(definition.amount, { $: formatFinanceMoney(amount) }));
  switch (key) {
    case "sales": {
      const orders = lines.get("sales.billed")?.count ?? ctx.summary.answer.orders;
      const waiting = lines.get("sales.waiting")?.count ?? 0;
      const kept = headlineFigure(lines, "sales.kept");
      const headline = money("sales.kept");
      return {
        summary: `${formatFinanceCountOf(orders, "order", "orders")} · ${formatFinanceCount(waiting)} waiting on costs`,
        amount: headline.amount,
        tone: "amount" in kept && kept.amount < 0 ? "loss" : headline.tone,
      };
    }
    case "products": {
      const pieces = lines.get("products.pieces");
      return {
        summary: fillFinanceWords(definition.summary, {
          packs: formatFinanceCount(amountOf(lines, "products.packs")),
          pieces: pieces && pieces.amount !== null ? formatFinanceCount(pieces.amount) : FINANCE_NOT_RECORDED_TEXT.toLowerCase(),
          n: formatFinanceCount(amountOf(lines, "products.count")),
        }),
        ...money("products.billed"),
      };
    }
    case "cash": {
      const rails = CASH_RAIL_WORDS.filter(([lineKey]) => (amountOf(lines, lineKey) ?? 0) !== 0).map(([, words]) => words);
      // The server counts the settled deposits itself (contract: cash.received_deposits.count); the page never adds them up.
      const deposits = lines.get("cash.received_deposits")?.count;
      const parts = [...(deposits !== undefined ? [formatFinanceCountOf(deposits, DEPOSITS.one, DEPOSITS.many)] : []), ...(rails.length > 0 ? [rails.join(", ")] : [])];
      return { summary: parts.join(" · "), ...money("cash.received") };
    }
    case "returns": {
      const credited = lines.get("returns.credited");
      return {
        summary: `${countText(credited?.count ?? null, { one: "credit", many: "credits" })} · ${formatFinanceMoney(amountOf(lines, "returns.fees"))} in return fees`,
        ...money("returns.credited"),
      };
    }
    case "owed":
      return {
        summary: fillFinanceWords(definition.summary, { n: formatFinanceCount(amountOf(lines, "owed.wallets")) }),
        ...money("owed.we_owe"),
      };
    case "points":
      return {
        summary: definition.summary,
        ...headlineAmount(headlineFigure(lines, "points.held"), (held) => `${formatFinancePoints(held)} held`),
      };
    case "pool": {
      // In a vendor's view the pool is not split by vendor: that is not a failure, so it says why instead of "Unavailable".
      if (lines.get("pool.closing")?.reasonKey === "program_wide") {
        return { summary: definition.summary, amount: "Program-wide", tone: "muted" };
      }
      return { summary: definition.summary, ...money("pool.closing") };
    }
    case "vendors": {
      const vendors = ctx.summary.sections.vendors;
      const top = vendors.top[0];
      return {
        summary: fillFinanceWords(definition.summary, { n: formatFinanceCount(vendors.vendorsOrdered), m: formatFinanceCount(vendors.wallets) }),
        amount: top && top.kept > 0 ? fillFinanceWords(definition.amount, { name: top.name }) : FINANCE_NONE_THIS_PERIOD_TEXT,
        tone: top && top.kept > 0 ? "default" : "muted",
      };
    }
  }
}

function sectionContext(summary: FinanceSummary, key: FinanceSectionKey, depth: FinanceDepth): SectionContext {
  return {
    summary,
    lines: indexLines(summary.sections[key].lines),
    depth,
    period: financePeriodWords(summary.period),
    dots: indexCheckDots(summary.checks),
  };
}

function sectionStatements(key: FinanceSectionKey, ctx: SectionContext, title: string): FinanceStatementView[] {
  const caption = `${title}, ${ctx.period.phrase}`;
  switch (key) {
    case "sales":
      return [buildStatement(ctx, caption, null, SALES_ROWS)];
    case "cash":
      return [buildStatement(ctx, caption, null, CASH_ROWS)];
    case "returns":
      return [buildStatement(ctx, caption, null, RETURNS_ROWS)];
    case "owed": {
      const walkHeading = ctx.summary.period.fromDate === null ? "How this changed" : `How this changed since ${ctx.period.startDay}`;
      return [
        buildStatement(ctx, `${title}, right now`, null, OWED_NOW_ROWS),
        buildStatement(ctx, walkHeading, walkHeading, OWED_WALK_ROWS),
      ];
    }
    case "points":
      return [buildStatement(ctx, caption, null, POINTS_ROWS)];
    case "pool":
      return [buildStatement(ctx, caption, null, POOL_ROWS)];
    case "products":
    case "vendors":
      // Their content is the top-5 table (buildFinanceProductsTable / buildFinanceVendorsTable).
      return [];
  }
}

function sectionMemos(key: FinanceSectionKey, ctx: SectionContext): FinanceMemoView[] {
  switch (key) {
    case "sales":
      return salesMemos(ctx);
    case "cash":
      return cashMemos(ctx);
    case "returns":
      return returnsMemos(ctx);
    case "owed":
      return owedMemos(ctx);
    case "points":
      return pointsMemos(ctx);
    case "pool":
      return poolMemos(ctx);
    case "products":
    case "vendors":
      return [];
  }
}

/** One of the eight section rows: collapsed summary and amount, and what opens under it. */
export function buildFinanceSectionRow(summary: FinanceSummary, key: FinanceSectionKey, depth: FinanceDepth): FinanceDetailRowView {
  const definition = FINANCE_SECTION_DEFINITIONS[key];
  const section = summary.sections[key];
  const errorText = sectionErrorText(key, section.status, section.errorCode);
  if (section.status !== "ok") {
    return {
      key,
      title: definition.title,
      chip: definition.chip,
      summary: definition.summary.includes("{") ? "" : definition.summary,
      amount: section.status === "skipped" ? "Took too long" : "Couldn't work out",
      amountTone: "muted",
      state: section.status,
      errorText,
      statements: [],
      memos: [],
    };
  }
  const ctx = sectionContext(summary, key, depth);
  const collapsed = collapsedSummary(key, ctx);
  return {
    key,
    title: definition.title,
    chip: definition.chip,
    summary: collapsed.summary,
    amount: collapsed.amount,
    amountTone: collapsed.tone,
    state: "ok",
    errorText: null,
    statements: sectionStatements(key, ctx, definition.title),
    memos: sectionMemos(key, ctx),
  };
}

// ── products and vendors tables (spec §3.4 B, H) ──────────────────────────

export interface FinanceProductRowView {
  readonly key: string;
  readonly product: string;
  readonly detail: string | null;
  readonly packs: string;
  readonly billed: string;
  readonly billedFullyCosted: string;
  readonly costOfGoods: string;
  readonly kept: string;
  readonly keptNegative: boolean;
}

export interface FinanceProductsTableView {
  readonly caption: string;
  readonly rows: readonly FinanceProductRowView[];
  readonly others: FinanceProductRowView | null;
  /** "Cost not linked to an order line", so the column adds up to the Sales cost of goods. */
  readonly unlinked: { readonly label: string; readonly costOfGoods: string } | null;
  readonly rounding: { readonly costOfGoods: string; readonly kept: string } | null;
  readonly total: FinanceProductRowView | null;
  readonly footer: readonly string[];
}

export const FINANCE_ROUNDING_LABEL = "Rounding";
export const FINANCE_ROUNDING_NOTE = "Rows are rounded to the cent; the total is exact.";
const NOT_LINKED_PRODUCT = "Not linked to a catalog item";

function productRowView(row: FinanceProductRow, product: string, detail: string | null): FinanceProductRowView {
  return {
    key: row.groupKey,
    product,
    detail,
    packs: formatFinanceCount(row.packs),
    billed: formatFinanceMoney(row.billedForProduct),
    billedFullyCosted: formatFinanceMoney(row.billedOnFullyCosted),
    costOfGoods: formatFinanceMoney(row.costOfGoods),
    kept: formatFinanceMoney(row.keptOnProduct),
    keptNegative: row.keptOnProduct < 0,
  };
}

function productNames(row: FinanceProductRow): { product: string; detail: string | null } {
  if (row.productVariantId === null) return { product: NOT_LINKED_PRODUCT, detail: row.sku };
  const detail = [row.sizeName, row.sku].filter((part): part is string => part !== null && part.trim() !== "").join(" · ");
  return { product: row.productName ?? row.sku ?? `Size #${row.productVariantId}`, detail: detail || null };
}

export function buildFinanceProductsTable(summary: FinanceSummary): FinanceProductsTableView | null {
  const section = summary.sections.products;
  if (section.status !== "ok") return null;
  const lines = indexLines(section.lines);
  const period = financePeriodWords(summary.period);
  const productCount = amountOf(lines, "products.count");
  const othersCount = productCount !== null ? productCount - section.top.length : null;
  const unlinked = lines.get("products.cogs_unlinked");
  const footer: string[] = [];
  const fullyCosted = lines.get("products.packs_fully_costed");
  if (fullyCosted?.coverage) {
    footer.push(fillFinanceWords(FINANCE_LINE_DEFINITIONS["products.packs_fully_costed"].words, {
      x: formatFinanceCount(fullyCosted.coverage.done),
      y: formatFinanceCount(fullyCosted.coverage.total),
    }));
  }
  const shipped = lines.get("products.packs_shipped");
  if (shipped?.coverage) {
    footer.push(fillFinanceWords(FINANCE_LINE_DEFINITIONS["products.packs_shipped"].words, {
      x: formatFinanceCount(shipped.coverage.done),
      y: formatFinanceCount(shipped.coverage.total),
    }));
  }
  const withoutPieces = amountOf(lines, "products.lines_without_pieces");
  if (withoutPieces !== null && withoutPieces > 0) {
    footer.push(`pieces not recorded on ${formatFinanceCountOf(withoutPieces, "line", "lines")}`);
  }
  const rounding = section.roundingCents;
  return {
    caption: `Products sold, orders accepted ${period.phrase}`,
    rows: section.top.map((row) => {
      const names = productNames(row);
      return productRowView(row, names.product, names.detail);
    }),
    others: section.others
      ? productRowView(section.others, othersCount !== null && othersCount > 0 ? `All other products (${formatFinanceCount(othersCount)})` : "All other products", null)
      : null,
    unlinked: unlinked && unlinked.amount !== null && unlinked.amount !== 0
      ? { label: lineWordsPlain("products.cogs_unlinked"), costOfGoods: formatFinanceMoney(unlinked.amount) }
      : null,
    rounding: rounding.costOfGoods !== 0 || rounding.keptOnProduct !== 0
      ? { costOfGoods: formatFinanceSignedMoney(rounding.costOfGoods), kept: formatFinanceSignedMoney(rounding.keptOnProduct) }
      : null,
    total: section.total ? productRowView(section.total, "Total", null) : null,
    footer,
  };
}

function lineWordsPlain(key: FinanceLineKey): string {
  return fillFinanceWords(FINANCE_LINE_DEFINITIONS[key].words, {});
}

export interface FinanceVendorRowView {
  readonly vendorId: number;
  readonly name: string;
  readonly orders: string;
  readonly billed: string;
  readonly kept: string;
  readonly keptNegative: boolean;
  readonly weOwe: string;
  readonly theyOwe: string;
}

export interface FinanceVendorAggregateView {
  readonly label: string;
  readonly orders: string;
  readonly billed: string;
  readonly kept: string;
  readonly weOwe: string;
  readonly theyOwe: string;
}

export interface FinanceVendorsTableView {
  readonly caption: string;
  readonly rows: readonly FinanceVendorRowView[];
  readonly others: FinanceVendorAggregateView | null;
  readonly rounding: { readonly kept: string } | null;
  readonly total: FinanceVendorAggregateView | null;
}

function vendorAggregateView(row: FinanceVendorAggregateRow, label: string, keptOverride: number | null): FinanceVendorAggregateView {
  return {
    label,
    orders: formatFinanceCount(row.orders),
    billed: formatFinanceMoney(row.billed),
    kept: formatFinanceMoney(keptOverride ?? row.kept),
    weOwe: formatFinanceMoney(row.weOweNow),
    theyOwe: formatFinanceMoney(row.theyOweNow),
  };
}

/**
 * The Vendors row's table. Each vendor's kept is rounded on its own orders,
 * so the rows can miss the page's kept by a cent; the server sends that as
 * `roundingCents.kept` (page − Σ rows, contract §2.11). The totals row shows
 * the page's own exact kept (the answer card's figure), so "the totals row
 * equals the page" (spec §3.4 H) and rows + rounding = total, as in the
 * products table. No money is added up here.
 */
export function buildFinanceVendorsTable(summary: FinanceSummary): FinanceVendorsTableView | null {
  const section = summary.sections.vendors;
  if (section.status !== "ok") return null;
  const period = financePeriodWords(summary.period);
  const pageKept = summary.answer.status === "ok" && summary.answer.kept.status === "recorded" ? summary.answer.kept.amount : null;
  return {
    caption: `Vendors, orders accepted and money moved ${period.phrase}, balances right now`,
    rows: section.top.map((row: FinanceVendorRow) => ({
      vendorId: row.vendorId,
      name: row.name,
      orders: formatFinanceCount(row.orders),
      billed: formatFinanceMoney(row.billed),
      kept: formatFinanceMoney(row.kept),
      keptNegative: row.kept < 0,
      weOwe: formatFinanceMoney(row.weOweNow),
      theyOwe: formatFinanceMoney(row.theyOweNow),
    })),
    others: section.others
      ? vendorAggregateView(section.others, `All other vendors (${formatFinanceCount(section.others.vendors)})`, null)
      : null,
    rounding: section.roundingCents.kept !== 0 ? { kept: formatFinanceSignedMoney(section.roundingCents.kept) } : null,
    total: section.total
      ? vendorAggregateView(section.total, `Total · ${formatFinanceCountOf(section.total.vendors, "vendor", "vendors")}`, pageKept)
      : null,
  };
}

// ── checks (spec §8) ──────────────────────────────────────────────────────

export type FinanceCheckTone = "fine" | "attention" | "unknown" | "program";

export interface FinanceCheckLineView {
  readonly id: FinanceCheckId;
  readonly tone: FinanceCheckTone;
  /** "Fine" / "Needs a look" / "Couldn't check" / "Program-wide: see all vendors". */
  readonly word: string;
  readonly wording: string;
  readonly detail: string;
}

export interface FinanceCheckGroupView {
  readonly group: FinanceCheckGroup;
  readonly title: string;
  readonly countText: string;
  /** Groups that need a look start open (spec §8). */
  readonly defaultOpen: boolean;
  readonly checks: readonly FinanceCheckLineView[];
}

export interface FinanceInfoLineView {
  readonly key: FinanceInfoKey;
  readonly text: string;
  readonly note: string | null;
}

export interface FinanceChecksView {
  /** "23 of 27 fine". */
  readonly summary: string;
  /** "✓ All fine" / "⚠ 4 need a look" words, without the glyph (the panel draws the icon). */
  readonly amount: string;
  readonly tone: FinanceCheckTone;
  /** The bar's checks chip: "All 27 checks fine" / "4 need a look". */
  readonly chip: string;
  readonly groups: readonly FinanceCheckGroupView[];
  readonly info: readonly FinanceInfoLineView[];
  readonly scopeNote: string | null;
}

const CHECK_TONES: Readonly<Record<FinanceCheckResult, FinanceCheckTone>> = Object.freeze({
  fine: "fine",
  needs_a_look: "attention",
  could_not_check: "unknown",
  program_wide: "program",
});

function checkDetail(check: FinanceCheck): string {
  switch (check.result) {
    case "fine":
      return check.examined === 0 ? "nothing to check" : `all ${formatFinanceCount(check.examined)} fine`;
    case "needs_a_look": {
      const verb = check.exceptions === 1 ? "needs" : "need";
      const total = check.difference !== null && check.difference !== 0 ? `, ${formatFinanceMagnitude(check.difference)} in total` : "";
      return `${formatFinanceCount(check.exceptions)} of ${formatFinanceCount(check.examined)} ${verb} a look${total}`;
    }
    case "could_not_check":
      return check.errorCode ? `(${check.errorCode})` : "";
    case "program_wide":
      return "";
  }
}

function checkLine(check: FinanceCheck): FinanceCheckLineView {
  return {
    id: check.id,
    tone: CHECK_TONES[check.result],
    word: FINANCE_CHECK_RESULT_WORDS[check.result],
    wording: FINANCE_CHECK_DEFINITIONS[check.id].wording,
    detail: checkDetail(check),
  };
}

function infoLineText(key: FinanceInfoKey, lines: LineIndex): FinanceInfoLineView {
  const money = (lineKey: FinanceLineKey) => {
    const line = lines.get(lineKey);
    return line ? formatFinanceLineAmount({ ...line, operator: "none" }) : FINANCE_NOT_RECORDED_TEXT;
  };
  switch (key) {
    case "overview_bridge": {
      const parts = (["info.overview_bridge.leftover_pending", "info.overview_bridge.cancelled_in_oms", "info.overview_bridge.date_basis"] as const)
        .filter((lineKey) => lines.has(lineKey))
        .map((lineKey) => `${lineWordsPlain(lineKey)} ${money(lineKey)}`);
      return {
        key,
        text: `${FINANCE_INFO_DEFINITIONS.overview_bridge.words}: its 'Dropship OMS' row ${money("info.overview_bridge.oms_row")} ${MINUS} billed here ${money("info.overview_bridge.billed")} = ${parts.join(" + ")}`,
        note: FINANCE_INFO_DEFINITIONS.overview_bridge.definition,
      };
    }
    case "pool_record": {
      // The template has two {$}: the recorded ledger, then the worked-out balance.
      const amounts = [money("info.pool_record.recorded"), money("info.pool_record.worked_out")];
      let index = 0;
      const text = FINANCE_INFO_DEFINITIONS.pool_record.words.replace(/\{\$\}/g, () => amounts[index++] ?? ELLIPSIS);
      return { key, text, note: FINANCE_INFO_DEFINITIONS.pool_record.definition };
    }
    case "won_disputes": {
      const amounts = [money("info.won_disputes.cash_returned"), money("info.won_disputes.wallet_restored")];
      let index = 0;
      const head = FINANCE_INFO_DEFINITIONS.won_disputes.words.replace(/\{\$\}/g, () => amounts[index++] ?? ELLIPSIS);
      const parts = (["info.won_disputes.card_fee_part", "info.won_disputes.points_from_cash"] as const)
        .filter((lineKey) => lines.has(lineKey))
        .map((lineKey) => `${lineWordsPlain(lineKey)} ${money(lineKey)}`);
      return { key, text: parts.length > 0 ? `${head}; the difference is ${parts.join(" · ")}` : head, note: FINANCE_INFO_DEFINITIONS.won_disputes.definition };
    }
  }
}

/** The chip, the Checks row and its groups (spec §3.1, §3.4 I, §8). */
export function buildFinanceChecksView(summary: FinanceSummary): FinanceChecksView {
  const counted = summary.checks.filter((check) => check.result !== "program_wide");
  const fine = counted.filter((check) => check.result === "fine").length;
  const needALook = counted.filter((check) => check.result === "needs_a_look").length;
  const couldNotCheck = counted.filter((check) => check.result === "could_not_check").length;
  const vendor = summary.scope.vendor;
  const forVendor = vendor ? ` for ${vendor.name}` : "";

  let amount: string;
  let tone: FinanceCheckTone;
  let chip: string;
  if (needALook > 0) {
    // The copy deck's "{n} need a look" reads "1 needs a look" for one check.
    amount = needALook === 1
      ? "1 needs a look"
      : fillFinanceWords(FINANCE_CHECKS_ROW.needALook, { n: formatFinanceCount(needALook) });
    tone = "attention";
    chip = `${amount}${forVendor}`;
  } else if (couldNotCheck > 0) {
    amount = `${formatFinanceCount(couldNotCheck)} couldn't check`;
    tone = "unknown";
    chip = `${formatFinanceCount(fine)} of ${formatFinanceCount(counted.length)} checks fine${forVendor}`;
  } else {
    amount = FINANCE_CHECKS_ROW.allFine;
    tone = "fine";
    chip = `All ${formatFinanceCount(counted.length)} checks fine${forVendor}`;
  }

  const groups = FINANCE_CHECK_GROUPS.map((group) => {
    const checks = summary.checks.filter((check) => check.group === group);
    const groupCounted = checks.filter((check) => check.result !== "program_wide");
    const groupFine = groupCounted.filter((check) => check.result === "fine").length;
    return {
      group,
      title: FINANCE_CHECK_GROUP_WORDS[group],
      countText: `${formatFinanceCount(groupFine)} of ${formatFinanceCount(groupCounted.length)} fine`,
      defaultOpen: checks.some((check) => check.result === "needs_a_look"),
      checks: checks.map(checkLine),
    };
  }).filter((group) => group.checks.length > 0);

  const info = summary.info.map((entry) => infoLineText(entry.key, indexLines(entry.lines)));

  return {
    summary: fillFinanceWords(FINANCE_CHECKS_ROW.summary, { x: formatFinanceCount(fine), y: formatFinanceCount(counted.length) }),
    amount,
    tone,
    chip,
    groups,
    info,
    scopeNote: vendor ? `Checks for ${vendor.name}. Checks that cover the whole program read "Program-wide: see all vendors".` : null,
  };
}

export function buildFinanceChecksRow(summary: FinanceSummary): FinanceDetailRowView {
  const view = buildFinanceChecksView(summary);
  return {
    key: "checks",
    title: FINANCE_CHECKS_ROW.title,
    chip: null,
    summary: view.summary,
    amount: view.amount,
    amountTone: view.tone === "attention" ? "attention" : view.tone === "fine" ? "fine" : "muted",
    state: "ok",
    errorText: null,
    statements: [],
    memos: [],
  };
}

// ── the answer card (spec §3.2) ───────────────────────────────────────────

export type FinanceHeroSize = "xl" | "lg" | "md";

/** Never compact money: the font steps down instead (> 12 characters, > 16 characters; spec §6). */
export function financeHeroSize(text: string): FinanceHeroSize {
  if (text.length > 16) return "md";
  if (text.length > 12) return "lg";
  return "xl";
}

export type FinanceBarSegmentKey = "kept" | "cogs" | "labels" | "pool" | "waiting";

export interface FinanceBarSegmentView {
  readonly key: FinanceBarSegmentKey;
  /** Layout weight in basis points of the bar (flex-grow); never shown as a number. */
  readonly weight: number;
}

export interface FinanceLegendRowView {
  readonly key: FinanceBarSegmentKey;
  /** The swatch to draw; null when the bar has no such segment (kept, in the loss layout). */
  readonly swatch: FinanceBarSegmentKey | null;
  readonly label: string;
  /** "40¢", "·" for the waiting row, or null when the split is not shown. */
  readonly cents: string | null;
  readonly amount: string;
}

export interface FinanceBarView {
  readonly title: string;
  readonly header: string;
  readonly layout: "split" | "loss" | "empty";
  readonly segments: readonly FinanceBarSegmentView[];
  /** Loss layout: where "what we billed" sits, in basis points of the bar. */
  readonly billedTickWeight: number | null;
  readonly brackets: readonly { readonly label: string; readonly weight: number }[];
  readonly ariaLabel: string;
  readonly emptyLabel: string | null;
  readonly lossLabel: string | null;
  readonly centsCaption: string | null;
  readonly legend: readonly FinanceLegendRowView[];
}

export interface FinanceAnswerView {
  readonly state: FinanceAnswer["state"];
  readonly title: string;
  /** The hero figure; null when the card shows a sentence instead (no orders, not ready, failed). */
  readonly hero: { readonly text: string; readonly size: FinanceHeroSize; readonly loss: boolean; readonly spoken: string } | null;
  /** "No orders accepted Oct 1 – 5" / "Not ready yet". */
  readonly headline: string | null;
  readonly headlineDetail: string | null;
  readonly caveat: string;
  readonly partialNote: string | null;
  readonly errorText: string | null;
  readonly margin: {
    readonly text: string;
    readonly change: { readonly text: string; readonly direction: "up" | "down" | "flat" } | null;
  } | null;
  readonly coverage: {
    readonly done: number;
    readonly total: number;
    /** Orders still waiting: the meter's empty part. */
    readonly remaining: number;
    readonly text: string;
    readonly valueText: string;
    readonly waitingText: string | null;
  };
  readonly pointsLine: string | null;
  readonly bar: FinanceBarView;
  readonly bridge: string | null;
  readonly hasWorkings: boolean;
  readonly checkDots: readonly FinanceCheckDotView[];
}

const SEGMENT_LABELS: Readonly<Record<Exclude<FinanceBarSegmentKey, "waiting">, string>> = Object.freeze({
  kept: "Kept on orders",
  cogs: "Cost of goods",
  labels: "Carrier labels",
  pool: "Insurance pool share (set aside)",
});
const SEGMENT_SPOKEN: Readonly<Record<Exclude<FinanceBarSegmentKey, "waiting">, string>> = Object.freeze({
  kept: "kept",
  cogs: "cost of goods",
  labels: "carrier labels",
  pool: "insurance pool share",
});

function centsWord(value: number): string {
  return `${value} ${value === 1 ? "cent" : "cents"}`;
}

/**
 * The loss layout (spec §7): the bar's scale is everything we spent plus the
 * waiting orders, the kept segment is absent and a tick marks what we billed.
 * Widths come from the shared largest-remainder rule in BigInt; they are
 * layout weights only, never shown.
 */
function lossBar(answer: FinanceAnswer): { segments: FinanceBarSegmentView[]; tick: number } | null {
  const parts = [answer.costOfGoods, answer.carrierLabels, answer.poolShare, answer.waiting.billed];
  if (parts.some((part) => part === null || part < 0)) return null;
  const big = parts.map((part) => BigInt(part ?? 0));
  const scale = big.reduce((sum, part) => sum + part, ZERO);
  const weights = largestRemainder(big, scale, BigInt(10_000));
  if (!weights) return null;
  const tick = toSafeNumber((BigInt(answer.billed) * BigInt(10_000)) / scale);
  const keys: FinanceBarSegmentKey[] = ["cogs", "labels", "pool", "waiting"];
  return {
    segments: keys.map((key, index) => ({ key, weight: Number(weights[index]) })),
    tick: tick ?? 0,
  };
}

/** A bar with no segments: nothing billed, or the answer could not be worked out. */
function emptyBar(ariaLabel: string, emptyLabel: string | null): FinanceBarView {
  return {
    title: FINANCE_BAR_TITLE, header: "", layout: "empty", segments: [], billedTickWeight: null, brackets: [],
    ariaLabel, emptyLabel, lossLabel: null, centsCaption: null, legend: [],
  };
}

function buildBar(summary: FinanceSummary, period: FinancePeriodWords): FinanceBarView {
  const answer = summary.answer;
  const header = `${formatFinanceCountOf(answer.orders, "order", "orders")} · ${formatFinanceMoney(answer.billed)} billed`;
  const waitingLabel = `Not yet fully costed · ${formatFinanceCountOf(answer.waiting.orders, "order", "orders")}`;
  const cents = answer.centsOfEachDollar;
  const legend: FinanceLegendRowView[] = [
    { key: "kept", swatch: "kept", label: SEGMENT_LABELS.kept, cents: cents ? `${cents.kept}¢` : null, amount: formatFinanceMoney(answer.keptOnOrders) },
    { key: "cogs", swatch: "cogs", label: SEGMENT_LABELS.cogs, cents: cents ? `${cents.costOfGoods}¢` : null, amount: formatFinanceMoney(answer.costOfGoods) },
    { key: "labels", swatch: "labels", label: SEGMENT_LABELS.labels, cents: cents ? `${cents.carrierLabels}¢` : null, amount: formatFinanceMoney(answer.carrierLabels) },
    { key: "pool", swatch: "pool", label: SEGMENT_LABELS.pool, cents: cents ? `${cents.poolShare}¢` : null, amount: formatFinanceMoney(answer.poolShare) },
    { key: "waiting", swatch: "waiting", label: waitingLabel, cents: cents ? "·" : null, amount: formatFinanceMoney(answer.waiting.billed) },
  ];
  const waitingSpoken = `${formatFinanceCountOf(answer.waiting.orders, "order", "orders")}, ${formatFinanceMoneySpoken(answer.waiting.billed)}, not yet fully costed`;

  if (answer.orders === 0) {
    return { ...emptyBar(`${FINANCE_NOTHING_BILLED_TEXT} (${period.phrase})`, FINANCE_NOTHING_BILLED_TEXT), header };
  }

  // Not ready yet (spec §3.2 "FC empty, E non-empty"): the bar is all track
  // and its one part is what is waiting. Kept, cost and label rows would read
  // $0.00 for costs that are simply not recorded yet, so they are left out.
  if (answer.fullyCosted.orders === 0) {
    return {
      title: FINANCE_BAR_TITLE,
      header,
      layout: "split",
      segments: [{ key: "waiting", weight: 1 }],
      billedTickWeight: null,
      brackets: [],
      ariaLabel: waitingSpoken,
      emptyLabel: null,
      lossLabel: null,
      centsCaption: null,
      legend: legend.filter((row) => row.key === "waiting").map((row) => ({ ...row, cents: null })),
    };
  }

  if (answer.barBps) {
    const bar = answer.barBps;
    const segments: FinanceBarSegmentView[] = [
      { key: "kept", weight: bar.kept },
      { key: "cogs", weight: bar.costOfGoods },
      { key: "labels", weight: bar.carrierLabels },
      { key: "pool", weight: bar.poolShare },
      { key: "waiting", weight: bar.waiting },
    ];
    const costedWeight = bar.kept + bar.costOfGoods + bar.carrierLabels + bar.poolShare;
    const brackets = [
      ...(costedWeight > 0
        ? [{ label: `${formatFinanceCount(answer.fullyCosted.orders)} fully costed · ${formatFinanceMoney(answer.fullyCosted.billed)}`, weight: costedWeight }]
        : []),
      ...(bar.waiting > 0 ? [{ label: formatFinanceCount(answer.waiting.orders), weight: bar.waiting }] : []),
    ];
    const split = cents
      ? `Of each dollar billed on ${formatFinanceCountOf(answer.fullyCosted.orders, "fully costed order", "fully costed orders")}: ${centsWord(cents.kept)} ${SEGMENT_SPOKEN.kept}, ${centsWord(cents.costOfGoods)} ${SEGMENT_SPOKEN.cogs}, ${centsWord(cents.carrierLabels)} ${SEGMENT_SPOKEN.labels}, ${centsWord(cents.poolShare)} ${SEGMENT_SPOKEN.pool}`
      : `Billed on ${formatFinanceCountOf(answer.fullyCosted.orders, "fully costed order", "fully costed orders")}: ${formatFinanceMoneySpoken(answer.fullyCosted.billed)}`;
    return {
      title: FINANCE_BAR_TITLE,
      header,
      layout: "split",
      segments,
      billedTickWeight: null,
      brackets,
      ariaLabel: answer.waiting.orders > 0 ? `${split}; ${waitingSpoken}` : split,
      emptyLabel: null,
      lossLabel: null,
      centsCaption: cents ? FINANCE_CENTS_CAPTION : null,
      legend,
    };
  }

  const loss = answer.keptOnOrders !== null && answer.keptOnOrders < 0 ? lossBar(answer) : null;
  const lossLabel = answer.keptOnOrders !== null && answer.keptOnOrders < 0
    ? `Costs ran ${formatFinanceMagnitude(answer.keptOnOrders)} over what we billed`
    : null;
  return {
    title: FINANCE_BAR_TITLE,
    header,
    layout: loss ? "loss" : "split",
    segments: loss ? loss.segments : [{ key: "waiting", weight: 1 }],
    billedTickWeight: loss ? loss.tick : null,
    brackets: [],
    ariaLabel: lossLabel
      ? `${lossLabel} on ${formatFinanceCountOf(answer.fullyCosted.orders, "fully costed order", "fully costed orders")}; ${waitingSpoken}`
      : waitingSpoken,
    emptyLabel: null,
    lossLabel,
    centsCaption: null,
    // The kept segment is absent in the loss layout, so its row has no swatch to match.
    legend: legend.map((row) => ({ ...row, cents: null, swatch: loss && row.key === "kept" ? null : row.swatch })),
  };
}

function bridgeText(answer: FinanceAnswer): string | null {
  const { keptOnOrders, feesCharged, returnCreditsPaid } = answer;
  const kept = answer.kept.status === "recorded" || answer.kept.status === "partial" ? answer.kept.amount : null;
  if (keptOnOrders === null || feesCharged === null || returnCreditsPaid === null || kept === null) return null;
  // The operator carries the sign, so each part is shown unsigned (a negative fee total flips to −).
  const fees = `${feesCharged < 0 ? MINUS : "+"} ${formatFinanceMagnitude(feesCharged)} fees we charged`;
  const credits = `${returnCreditsPaid < 0 ? "+" : MINUS} ${formatFinanceMagnitude(returnCreditsPaid)} return credits we paid`;
  return `${formatFinanceMoney(keptOnOrders)} kept on orders ${fees} ${credits} = ${formatFinanceMoney(kept)} kept`;
}

function priorDirection(value: number): "up" | "down" | "flat" {
  return value > 0 ? "up" : value < 0 ? "down" : "flat";
}

/** The answer card (spec §3.2, §7 empty, not-ready and loss states). */
export function buildFinanceAnswerView(summary: FinanceSummary): FinanceAnswerView {
  const answer = summary.answer;
  const period = financePeriodWords(summary.period);
  const vendor = summary.scope.vendor;
  const title = vendor ? `What we kept from ${vendor.name}` : "What we kept";
  const compareSpan = financeCompareSpan(summary);
  const dots = indexCheckDots(summary.checks);
  const coverageText = fillFinanceWords(FINANCE_LINE_DEFINITIONS["answer.coverage"].words, {
    x: formatFinanceCount(answer.coverage.done),
    y: formatFinanceCount(answer.coverage.total),
  });
  const coverage = {
    done: answer.coverage.done,
    total: answer.coverage.total,
    remaining: answer.coverage.total - answer.coverage.done,
    text: coverageText,
    valueText: `${formatFinanceCount(answer.coverage.done)} of ${formatFinanceCountOf(answer.coverage.total, "order", "orders")}`,
    waitingText: answer.waiting.orders > 0
      ? answer.waiting.orders === 1
        ? `1 order (${formatFinanceMoney(answer.waiting.billed)}) counts once its costs are recorded`
        : `${formatFinanceCount(answer.waiting.orders)} orders (${formatFinanceMoney(answer.waiting.billed)}) count once their costs are recorded`
      : null,
  };
  const base = {
    state: answer.state,
    title,
    caveat: FINANCE_KEPT_CAVEAT,
    coverage,
    hasWorkings: answer.workings.length > 0,
    checkDots: dots.get("answer.kept") ?? [],
  };

  if (answer.status !== "ok") {
    const errorText = answer.status === "skipped"
      ? FINANCE_SECTION_STATUS_WORDS.skipped
      : fillFinanceWords(FINANCE_SECTION_STATUS_WORDS.error, { section: "what we kept", code: answer.errorCode ?? "DROPSHIP_FINANCE_INTERNAL_ERROR" });
    return {
      ...base, hero: null, headline: null, headlineDetail: null, partialNote: null, errorText, margin: null, pointsLine: null,
      bar: emptyBar(errorText, null), bridge: null, hasWorkings: false,
    };
  }

  const keptAmount = answer.kept.status === "recorded" || answer.kept.status === "partial" ? answer.kept.amount : null;
  const heroText = answer.kept.status === "unavailable" ? FINANCE_UNAVAILABLE_TEXT : formatFinanceMoney(keptAmount);
  let hero: FinanceAnswerView["hero"] = null;
  let headline: string | null = null;
  let headlineDetail: string | null = null;
  if (answer.state === "no_orders") {
    headline = `No orders accepted ${period.phrase}`;
  } else if (answer.state === "not_ready") {
    headline = FINANCE_NOT_READY_TEXT;
    headlineDetail = `Costs are recorded when items are picked and labels are bought. ${formatFinanceCount(answer.coverage.done)} of ${formatFinanceCountOf(answer.coverage.total, "order", "orders")} so far.`;
  } else {
    hero = {
      text: heroText,
      size: financeHeroSize(heroText),
      loss: answer.state === "loss",
      // Screen readers hear what the screen shows: "unavailable", never "not recorded", for a kept that could not be worked out.
      spoken: `${title}, ${answer.kept.status === "unavailable" ? FINANCE_UNAVAILABLE_TEXT.toLowerCase() : formatFinanceMoneySpoken(keptAmount)}, ${FINANCE_KEPT_CAVEAT}`,
    };
  }

  const margin = answer.marginTenths !== null && answer.state !== "no_orders" && answer.state !== "not_ready"
    ? {
      text: `${formatFinancePercent(answer.marginTenths)} of what we billed on fully costed orders`,
      change: answer.marginChangeTenths !== null && compareSpan !== null
        ? { text: `${formatFinancePts(answer.marginChangeTenths)} vs ${compareSpan}`, direction: priorDirection(answer.marginChangeTenths) }
        : null,
    }
    : null;

  return {
    ...base,
    hero,
    headline,
    headlineDetail,
    partialNote: answer.kept.status === "partial" ? `${FINANCE_PARTIAL_TEXT}.` : null,
    errorText: answer.kept.status === "unavailable" && answer.kept.errorCode ? `${FINANCE_UNAVAILABLE_TEXT} (${answer.kept.errorCode})` : null,
    margin,
    pointsLine: answer.paidWithPoints.billed > 0
      ? `${formatFinanceMoney(answer.paidWithPoints.billed)} of what we billed was paid with points: no cash came in for it`
      : null,
    bar: buildBar(summary, period),
    // The bridge explains the hero; with no hero (no orders, or none fully costed yet) it would
    // put a "kept" total on the card that the headline deliberately does not give.
    bridge: answer.state === "no_orders" || answer.state === "not_ready" ? null : bridgeText(answer),
  };
}

// ── tiles (spec §3.3) ─────────────────────────────────────────────────────

export type FinanceTileKey = "billed" | "cash_received" | "we_owe_now" | "owed_to_us_now";

export interface FinanceTileView {
  readonly key: FinanceTileKey;
  readonly label: string;
  readonly value: string;
  readonly negative: boolean;
  readonly delta: { readonly text: string; readonly direction: "up" | "down" | "flat" | "none" } | null;
  readonly subLines: readonly { readonly text: string; readonly icon: "none" | "clock" }[];
  readonly info: string | null;
  readonly checkDots: readonly FinanceCheckDotView[];
}

type TileFigure = { amount: number | null; status: FinanceLineStatus; errorCode?: string };
type TileSubLine = FinanceTileView["subLines"][number];

function figureText(figure: TileFigure): string {
  if (figure.status === "unavailable") return FINANCE_UNAVAILABLE_TEXT;
  return formatFinanceMoney(figure.amount);
}

/**
 * A tile's sub-lines. A figure that could not be worked out comes with
 * zeroed counts (the server has nothing to count), so its only sub-line says
 * it couldn't be worked out; "No orders" or "0 vendors" under "Unavailable"
 * would state a fact the page does not know.
 */
function tileSubLines(figure: TileFigure, lines: () => readonly TileSubLine[]): readonly TileSubLine[] {
  if (figure.status !== "unavailable") return lines();
  return [{ text: `Couldn't work this out${figure.errorCode ? ` (${figure.errorCode})` : ""}`, icon: "none" }];
}

/**
 * "No deposits" only when nothing came in and nothing was pulled back or won
 * back. The tile is the net of the three, so a deposit disputed in full nets
 * to $0.00 and still reads "after disputes · before Stripe's fees" (spec §3.3).
 */
function cashReceivedNote(summary: FinanceSummary): string {
  const cash = summary.sections.cash;
  const lines = cash.status === "ok" ? indexLines(cash.lines) : null;
  const zero = (key: FinanceLineKey) => {
    const line = lines?.get(key);
    return line !== undefined && line.status === "recorded" && line.amount === 0;
  };
  return zero("cash.received_deposits") && zero("cash.pulled_back") && zero("cash.won_back")
    ? "No deposits"
    : "after disputes · before Stripe's fees";
}

/**
 * A tile's change against the comparison window (spec §3.3 "Delta rules"):
 * null when compare is off or for all time; "New this period" when the prior
 * was zero; "No change" when both are zero.
 */
export function formatFinanceDelta(prior: FinancePrior | null, compareSpan: string | null): FinanceTileView["delta"] {
  if (prior === null || compareSpan === null) return null;
  switch (prior.kind) {
    case "new":
      return { text: "New this period", direction: "none" };
    case "no_change":
      return { text: "No change", direction: "flat" };
    case "unavailable":
      return { text: "Comparison unavailable", direction: "none" };
    case "change": {
      if (prior.change === null) return { text: "Comparison unavailable", direction: "none" };
      const percent = prior.changeTenths !== null ? ` (${formatFinancePercent(prior.changeTenths, { signed: true })})` : "";
      return { text: `${formatFinanceSignedMoney(prior.change)}${percent} vs ${compareSpan}`, direction: priorDirection(prior.change) };
    }
  }
}

/** The four tiles (spec §3.3), with vendor-view labels (spec §4.2). */
export function buildFinanceTilesView(summary: FinanceSummary): FinanceTileView[] {
  const tiles = summary.tiles;
  const vendor = summary.scope.vendor;
  const period = financePeriodWords(summary.period);
  const compareSpan = summary.comparePeriod ? financeCompareSpan(summary) : null;
  const dots = indexCheckDots(summary.checks);
  const pastPeriod = !summary.period.endsNow;
  const now = pastPeriod ? "right now" : "now";
  const atEnd = (amount: number | null) =>
    pastPeriod && amount !== null ? [{ text: `At end of ${period.endDay}: ${formatFinanceMoney(amount)}`, icon: "none" as const }] : [];

  return [
    {
      key: "billed",
      label: vendor ? `Billed to ${vendor.name}` : "Billed to vendors",
      value: figureText(tiles.billed),
      negative: false,
      delta: formatFinanceDelta(tiles.billed.prior, compareSpan),
      subLines: tileSubLines(tiles.billed, () => [
        { text: tiles.billed.orders === 0 ? "No orders" : formatFinanceCountOf(tiles.billed.orders, "order", "orders"), icon: "none" },
      ]),
      info: null,
      checkDots: dots.get("tiles.billed") ?? [],
    },
    {
      key: "cash_received",
      label: vendor ? `Cash ${vendor.name} paid in` : "Cash received",
      value: figureText(tiles.cashReceived),
      negative: tiles.cashReceived.amount !== null && tiles.cashReceived.amount < 0,
      delta: formatFinanceDelta(tiles.cashReceived.prior, compareSpan),
      subLines: tileSubLines(tiles.cashReceived, () => [{ text: cashReceivedNote(summary), icon: "none" }]),
      info: FINANCE_INFO_TEXT.cash,
      checkDots: dots.get("tiles.cash_received") ?? [],
    },
    {
      key: "we_owe_now",
      label: vendor ? `We owe ${vendor.name} · ${now}` : `We owe vendors · ${now}`,
      value: figureText(tiles.weOweNow),
      negative: false,
      delta: null,
      subLines: tileSubLines(tiles.weOweNow, () => [
        { text: formatFinanceCountOf(tiles.weOweNow.vendors, "vendor", "vendors"), icon: "none" },
        ...(tiles.weOweNow.onTheWay !== null && tiles.weOweNow.onTheWay !== 0
          ? [{ text: `${formatFinanceMoney(tiles.weOweNow.onTheWay)} on the way, not yet cash`, icon: "clock" as const }]
          : []),
        ...atEnd(tiles.weOweNow.atEndOfPeriod),
      ]),
      info: tiles.weOweNow.status !== "unavailable" && tiles.weOweNow.onTheWay !== null && tiles.weOweNow.onTheWay !== 0 ? FINANCE_INFO_TEXT.onTheWay : null,
      checkDots: dots.get("tiles.we_owe_now") ?? [],
    },
    {
      key: "owed_to_us_now",
      label: vendor ? `${vendor.name} owes us · ${now}` : `Vendors owe us · ${now}`,
      value: figureText(tiles.owedToUsNow),
      negative: false,
      delta: null,
      subLines: tileSubLines(tiles.owedToUsNow, () => [
        { text: `${formatFinanceCountOf(tiles.owedToUsNow.vendors, "vendor", "vendors")} below zero`, icon: "none" },
        ...atEnd(tiles.owedToUsNow.atEndOfPeriod),
      ]),
      info: FINANCE_INFO_TEXT.owedToUs,
      checkDots: dots.get("tiles.owed_to_us_now") ?? [],
    },
  ];
}

// ── the period bar (spec §3.1) ────────────────────────────────────────────

export interface FinancePeriodBarView {
  readonly presetLabel: string;
  /** The exact dates; null until the server has resolved a preset. */
  readonly dateText: string | null;
  readonly compareLabel: string;
  readonly compareDisabled: boolean;
  readonly compareHint: string | null;
  /** "Numbers as of 9:14 AM ET", "Refreshing…", or null while loading. */
  readonly asOf: string | null;
  readonly vendorChip: { readonly label: string; readonly vendorId: number } | null;
  /** Null while the first load runs ("Checking…"). */
  readonly checksChip: { readonly text: string; readonly tone: FinanceCheckTone } | null;
  readonly notes: readonly string[];
}

/**
 * The sticky bar. It renders before the summary arrives (spec §7): the
 * preset, the custom dates if any, and "Checking…" for the chip.
 */
export function buildFinancePeriodBarView(
  state: FinanceUrlState,
  summary: FinanceSummary | null,
  options: { refreshing: boolean },
): FinancePeriodBarView {
  const compareDisabled = state.period === "all";
  const compareSpan = summary ? financeCompareSwitchSpan(summary) : null;
  const vendor = summary?.scope.vendor ?? null;
  let dateText: string | null = null;
  if (summary) dateText = financePeriodWords(summary.period).label;
  else if (state.period === "custom" && state.from !== null && state.to !== null) dateText = formatFinanceDateSpan(state.from, state.to);
  const checks = summary ? buildFinanceChecksView(summary) : null;
  return {
    presetLabel: FINANCE_PERIOD_PRESET_LABELS[state.period],
    dateText,
    compareLabel: compareSpan ? `Compare with ${compareSpan}` : "Compare with the period before",
    compareDisabled,
    compareHint: compareDisabled ? FINANCE_COMPARE_ALL_TIME_TEXT : null,
    asOf: options.refreshing ? FINANCE_REFRESHING_TEXT : summary ? `Numbers as of ${formatFinanceClockTime(summary.generatedAt)} ET` : null,
    vendorChip: state.vendorId !== null ? { vendorId: state.vendorId, label: `Vendor: ${vendor?.name ?? `Vendor #${state.vendorId}`}` } : null,
    checksChip: checks ? { text: checks.chip, tone: checks.tone } : null,
    notes: summary ? summary.notes.map((note) => FINANCE_NOTE_DEFINITIONS[note].words) : [],
  };
}

/** The polite announcement when new numbers replace the old (spec §7). */
export function financeUpdatedAnnouncement(summary: FinanceSummary): string {
  return `Numbers updated for ${financePeriodWords(summary.period).phrase}.`;
}

export const FINANCE_TWO_CLOCKS_TEXT = FINANCE_TWO_CLOCKS_SENTENCE;

// ── "How this is worked out" (spec §3.6 How drawer) ───────────────────────

export interface FinanceWorkingOperandView {
  readonly operatorSymbol: string;
  readonly operatorWords: string;
  readonly label: string;
  readonly amount: string;
}

export interface FinanceWorkingStepView {
  readonly step: number;
  readonly title: string;
  readonly operands: readonly FinanceWorkingOperandView[];
  readonly result: string | null;
}

export interface FinanceHowView {
  readonly key: FinanceLineKey;
  readonly title: string;
  readonly amount: string;
  readonly chip: string | null;
  readonly definition: string;
  readonly steps: readonly FinanceWorkingStepView[];
  readonly technicalSource: FinanceTechnicalSource;
}

function findWorkings(summary: FinanceSummary, key: FinanceLineKey): { steps: readonly FinanceWorkingStep[]; line: FinanceLine | null } | null {
  if (key === "answer.kept") return summary.answer.workings.length > 0 ? { steps: summary.answer.workings, line: null } : null;
  const allLines = [
    ...FINANCE_SECTION_KEYS.flatMap((section) => summary.sections[section].lines),
    ...summary.info.flatMap((info) => info.lines),
  ];
  const line = allLines.find((candidate) => candidate.key === key);
  return line && line.workings && line.workings.length > 0 ? { steps: line.workings, line } : null;
}

/** Every key whose drawer the summary can fill, for validating the `how` param once data arrives. */
export function financeWorkingsKeys(summary: FinanceSummary): FinanceLineKey[] {
  const keys: FinanceLineKey[] = summary.answer.workings.length > 0 ? ["answer.kept"] : [];
  for (const section of FINANCE_SECTION_KEYS) {
    for (const line of summary.sections[section].lines) {
      if ((line.workings?.length ?? 0) > 0 && isFinanceLineKey(line.key)) keys.push(line.key);
    }
  }
  return keys;
}

function stepTitle(textKey: string, values: Readonly<Record<string, string>>): string {
  const words = financeWorkingStepWords(textKey);
  return words === null ? "Step" : fillFinanceWords(words, values);
}

/** The two working units that are shares rather than amounts (contract FINANCE_WORKING_UNITS). */
function isShareUnit(unit: FinanceWorkingUnit): boolean {
  return unit === "share_tenths" || unit === "share_change_tenths";
}

/**
 * A working figure in the unit the server says it is in: cents as money,
 * points, a count, a share as "39.9%" and a change of a share as "−0.5 pts".
 * A share of nothing reads "—"; any other missing figure "Not recorded".
 */
export function formatFinanceWorkingFigure(value: number | null, unit: FinanceWorkingUnit): string {
  switch (unit) {
    case "cents":
      return formatFinanceMoney(value);
    case "points":
      return formatFinancePoints(value);
    case "count":
      return formatFinanceCount(value);
    case "share_tenths":
      return formatFinancePercent(value);
    case "share_change_tenths":
      return formatFinancePts(value);
  }
}

/**
 * An operand's label: its line's words, "as a share" when the figure is a
 * share, and the dates it covers when the step puts this period beside the
 * comparison period ("Kept on orders (Sep 1 – 5)").
 */
function operandLabel(operand: FinanceWorkingOperand, period: FinancePeriodWords, spans: { current: string; compare: string } | null): string {
  if (!isFinanceLineKey(operand.lineKey)) return FINANCE_UNAVAILABLE_TEXT;
  const words = fillFinanceWords(FINANCE_LINE_DEFINITIONS[operand.lineKey].words, { period: period.phrase, date: period.startDay });
  const label = isShareUnit(operand.unit) ? `${words} as a share` : words;
  if (spans === null) return label;
  return `${label} (${operand.period === "compare" ? spans.compare : spans.current})`;
}

/**
 * The drawer renders the server's working steps and never recomputes them
 * (spec §3.6): each step's words, its operands with their operators, and the
 * result the server sent, each written in the unit the server gives it.
 */
export function buildFinanceHowView(summary: FinanceSummary, key: FinanceLineKey): FinanceHowView | null {
  const found = findWorkings(summary, key);
  if (!found) return null;
  const period = financePeriodWords(summary.period);
  const compareSpan = financeCompareSpan(summary) ?? "the comparison period";
  const definition = FINANCE_LINE_DEFINITIONS[key];
  const amount = key === "answer.kept"
    ? (summary.answer.kept.status === "unavailable" ? FINANCE_UNAVAILABLE_TEXT : formatFinanceMoney(summary.answer.kept.amount))
    : found.line
      ? formatFinanceLineAmount({ ...found.line, operator: "none" })
      : FINANCE_UNAVAILABLE_TEXT;
  const chip = key === "answer.kept" ? FINANCE_SECTION_DEFINITIONS.sales.chip : found.line ? FINANCE_DATED_BY_DEFINITIONS[found.line.datedBy].words : null;
  const titleWords = key === "answer.kept" && summary.scope.vendor ? `What we kept from ${summary.scope.vendor.name}` : definition.words;
  return {
    key,
    title: fillFinanceWords(titleWords, { period: period.phrase, date: period.startDay, $: amount }),
    amount,
    chip,
    definition: definition.definition,
    steps: found.steps.map((step) => {
      // A step that puts the comparison period beside this one names both periods' dates on its figures.
      const spans = step.operands.some((operand) => operand.period === "compare") ? { current: period.phrase, compare: compareSpan } : null;
      return {
        step: step.step,
        // Only a money result can fill a "{$}" in the step's words.
        title: stepTitle(step.textKey, {
          period: period.phrase,
          date: period.startDay,
          $: step.result !== null && step.resultUnit === "cents" ? formatFinanceMoney(step.result) : ELLIPSIS,
        }),
        operands: step.operands.map((operand) => ({
          operatorSymbol: OPERATOR_SYMBOLS[operand.operator],
          operatorWords: OPERATOR_WORDS[operand.operator],
          label: operandLabel(operand, period, spans),
          amount: formatFinanceWorkingFigure(operand.amount, operand.unit),
        })),
        // Words-only steps have no figure. A share of nothing still shows its "—", so the step does not look unfinished.
        result: step.result !== null || (isShareUnit(step.resultUnit) && step.operands.length > 0)
          ? formatFinanceWorkingFigure(step.result, step.resultUnit)
          : null,
      };
    }),
    technicalSource: definition.technicalSource,
  };
}

// ── "How this page counts" (spec §3.1, the definitions registry) ──────────

export interface FinanceCountingEntryView {
  readonly key: string;
  readonly words: string;
  readonly definition: string;
  readonly technicalSource: FinanceTechnicalSource | null;
}

export interface FinanceCountingGroupView {
  readonly key: string;
  readonly title: string;
  readonly entries: readonly FinanceCountingEntryView[];
}

export interface FinanceCountingView {
  readonly twoClocks: string;
  readonly groups: readonly FinanceCountingGroupView[];
  readonly moneyPath: readonly string[];
  readonly choices: readonly { readonly key: string; readonly words: string; readonly technical: string; readonly needsSignOff: boolean }[];
  readonly basisNotes: readonly FinanceCountingEntryView[];
  readonly eraNotes: readonly FinanceCountingEntryView[];
  readonly vendorScopeNote: string;
}

/** Copy-deck words with their placeholders written as plain words, for the registry list. */
export function financeTemplateLabel(words: string): string {
  return fillFinanceWords(words, { period: "in the period", date: "a date", $: ELLIPSIS, n: ELLIPSIS, x: ELLIPSIS, y: ELLIPSIS, p: ELLIPSIS });
}

function lineEntries(keys: readonly FinanceLineKey[]): FinanceCountingEntryView[] {
  return keys.map((key) => {
    const definition = FINANCE_LINE_DEFINITIONS[key];
    return { key, words: financeTemplateLabel(definition.words), definition: definition.definition, technicalSource: definition.technicalSource };
  });
}

/**
 * Every number's plain definition, then its technical source, the money
 * path, the counting choices and the basis notes — all from the one
 * registry in shared/dropship/program-finance-definitions.ts (spec §3.1).
 */
export function buildFinanceCountingView(): FinanceCountingView {
  const sectionGroups = FINANCE_SECTION_KEYS.map((section) => ({
    key: section,
    title: FINANCE_SECTION_DEFINITIONS[section].title,
    entries: lineEntries(FINANCE_SECTION_LINE_KEYS[section]),
  }));
  const anchors = { key: "answer", title: "The answer and the tiles", entries: lineEntries(FINANCE_ANCHOR_KEYS) };
  const info = {
    key: "info",
    title: "Information lines under Checks",
    entries: lineEntries([...FINANCE_INFO_LINE_KEYS.overview_bridge, ...FINANCE_INFO_LINE_KEYS.pool_record, ...FINANCE_INFO_LINE_KEYS.won_disputes]),
  };
  const checks = {
    key: "checks",
    title: FINANCE_CHECKS_ROW.title,
    entries: (Object.keys(FINANCE_CHECK_DEFINITIONS) as FinanceCheckId[]).map((id) => ({
      key: id,
      words: FINANCE_CHECK_DEFINITIONS[id].wording,
      definition: FINANCE_CHECK_DEFINITIONS[id].definition,
      technicalSource: FINANCE_CHECK_DEFINITIONS[id].technicalSource,
    })),
  };
  const clocks = {
    key: "clocks",
    title: "The clocks",
    entries: (Object.keys(FINANCE_DATED_BY_DEFINITIONS) as FinanceDatedBy[]).map((key) => ({
      key,
      words: FINANCE_DATED_BY_DEFINITIONS[key].words,
      definition: FINANCE_DATED_BY_DEFINITIONS[key].definition,
      technicalSource: FINANCE_DATED_BY_DEFINITIONS[key].technicalSource,
    })),
  };
  const reasons = Object.entries(FINANCE_REASON_DEFINITIONS);
  return {
    twoClocks: FINANCE_TWO_CLOCKS_SENTENCE,
    groups: [anchors, ...sectionGroups, checks, info, clocks],
    moneyPath: FINANCE_MONEY_PATH_STEPS,
    choices: FINANCE_COUNTING_CHOICES,
    basisNotes: reasons
      .filter(([, reason]) => reason.kind === "basis")
      .map(([key, reason]) => ({ key, words: reason.words, definition: reason.definition, technicalSource: reason.technicalSource })),
    eraNotes: (Object.keys(FINANCE_NOTE_DEFINITIONS) as (keyof typeof FINANCE_NOTE_DEFINITIONS)[]).map((key) => ({
      key,
      words: FINANCE_NOTE_DEFINITIONS[key].words,
      definition: FINANCE_NOTE_DEFINITIONS[key].definition,
      technicalSource: FINANCE_NOTE_DEFINITIONS[key].technicalSource,
    })),
    vendorScopeNote: FINANCE_VENDOR_SCOPE_NOTE,
  };
}

/** All presets in the Select's order. */
export const FINANCE_PERIOD_PRESET_OPTIONS: readonly FinancePeriodPreset[] = FINANCE_PERIOD_PRESETS;
