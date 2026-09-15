import { formatDistanceStrict } from "date-fns";

/**
 * Presentation-only conversions for the channel inventory workspace.
 *
 * Percentages are stored as integer basis points (0–10,000). Operators read and
 * type percentages, so the conversion is done with integer string arithmetic:
 * no floating point ever touches a stored share.
 */

export const MAX_SHARE_BPS = 10_000;
const BPS_PER_PERCENT = 100;
const PERCENT_PATTERN = /^(\d{1,3})(?:\.(\d{1,2}))?$/;
const WHOLE_UNITS_PATTERN = /^(0|[1-9]\d*)$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T/;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** "12.5" → 1250. Accepts up to two decimals; rejects anything outside 0–100. */
export function percentTextToBps(text: string): ParseResult<number> {
  const trimmed = text.trim();
  const match = PERCENT_PATTERN.exec(trimmed);
  if (!match) return { ok: false, message: "Enter a percentage from 0 to 100 (up to two decimals)." };
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const bps = whole * BPS_PER_PERCENT + fraction;
  if (bps > MAX_SHARE_BPS) return { ok: false, message: "A channel cannot offer more than 100%." };
  return { ok: true, value: bps };
}

/** 1250 → "12.5"; 5000 → "50"; 0 → "0". */
export function bpsToPercentText(bps: number): string {
  const whole = Math.floor(bps / BPS_PER_PERCENT);
  const fraction = bps % BPS_PER_PERCENT;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

export function formatPercent(bps: number): string {
  return `${bpsToPercentText(bps)}%`;
}

/** Whole sellable-SKU unit counts travel as decimal strings (Postgres bigint). */
export function parseWholeUnits(text: string, label: string): ParseResult<string> {
  const trimmed = text.trim();
  if (!WHOLE_UNITS_PATTERN.test(trimmed)) {
    return { ok: false, message: `${label} must be a whole number of units (0 or more).` };
  }
  return { ok: true, value: BigInt(trimmed).toString() };
}

/** Human-readable count with thousands separators; bigint-safe (string in, string out). */
export function formatUnits(units: string): string {
  return units.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Label for the exact sellable unit of a SKU. "1 unit = 5 pieces" for a
 * five-piece pack; singles say "1 unit = 1 piece" so packs and singles are
 * never confused in quantity columns.
 */
export function describePackUnit(unitsPerVariant: number): string {
  return unitsPerVariant === 1 ? "1 unit = 1 piece" : `1 unit = ${unitsPerVariant} pieces`;
}

/** "3 minutes ago" relative to an injected clock so rendering is deterministic. */
export function formatRelativeTime(iso: string, now: Date): string {
  if (!ISO_DATE_PATTERN.test(iso)) return "at an unknown time";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "at an unknown time";
  return formatDistanceStrict(then, now, { addSuffix: true });
}

export function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return date.toLocaleString();
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
