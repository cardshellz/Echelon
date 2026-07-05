/**
 * ETA — pure delivery-date math, no I/O.
 *
 * Composes the checkout delivery window: warehouse cutoff → ship date, then
 * shipping.transit_matrix business days → min/max delivery calendar dates.
 * Design: docs/SHIPPING-ENGINE-DESIGN.md ("ETA").
 *
 * REUSES the cutoff/timezone/business-day conventions from
 * server/modules/orders/sort-rank.ts rather than re-deriving them:
 * `effectiveFulfillmentDate`, `parseCutoffMinutes`, `coerceTimeZone`, and
 * `DEFAULT_BUSINESS_TZ` are exported pure functions there (sort-rank imports
 * drizzle lazily inside its async functions, so importing the module has no
 * side effects). The ship date here IS sort-rank's effective fulfillment day:
 * an order that misses the pick-wave cutoff cannot ship until the next
 * business day, and the SLA clock and the customer-facing ETA must agree.
 *
 * Conventions inherited from sort-rank:
 *   - Business day = Mon-Fri. HOLIDAYS ARE OUT OF SCOPE for v1 (sort-rank has
 *     no holiday calendar either); a shipment quoted across a holiday shows a
 *     window one day tighter than reality — acceptable for starting values
 *     that the calibration loop corrects with observed transit times.
 *   - Cutoff comparison is >= : an order AT the cutoff minute rolls to the
 *     next business day (mirrors effectiveFulfillmentDate).
 *   - Timezone math uses Intl.DateTimeFormat only (no date library); a bad or
 *     missing timezone falls back to DEFAULT_BUSINESS_TZ, a malformed cutoff
 *     string behaves as "no cutoff" (ships the placed business day).
 *
 * Contract: never throws for data problems — bad tz / cutoff degrade to the
 * documented fallbacks, so the checkout callback can call this inline.
 */

import {
  coerceTimeZone,
  DEFAULT_BUSINESS_TZ,
  effectiveFulfillmentDate,
  parseCutoffMinutes,
} from "../../orders/sort-rank";

const DAY_MS = 86_400_000;

const isWeekendDow = (dow: number): boolean => dow === 0 || dow === 6;

/**
 * The day the order leaves the warehouse.
 *
 * Before the cutoff (in the warehouse's timezone) on a business day → ships
 * that same day; at/after the cutoff, or on a weekend → the next business
 * day. `cutoffLocal` is "HH:MM" 24h; null/malformed = no cutoff (weekend
 * rollover still applies).
 *
 * Returns the UTC instant at LOCAL NOON of the ship day (noon is DST-stable,
 * so downstream calendar extraction always lands on the intended local day) —
 * the same anchor sort-rank's effectiveFulfillmentDate uses.
 */
export function resolveShipDate(now: Date, cutoffLocal: string | null, timezone: string): Date {
  return effectiveFulfillmentDate(now, timezone, parseCutoffMinutes(cutoffLocal));
}

/**
 * Advance `days` business days (skip Sat/Sun) from the date's UTC calendar
 * day. Returns UTC noon of the resulting day so stepping in whole-day
 * increments can never straddle a boundary. days <= 0 → same calendar day.
 *
 * NOTE: operates on the UTC calendar. Callers holding a zone-anchored instant
 * (e.g. resolveShipDate's local-noon anchor) must first re-anchor the LOCAL
 * calendar day at UTC noon — deliveryWindow does exactly that.
 */
export function addBusinessDays(start: Date, days: number): Date {
  let ms = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 12, 0, 0);
  const target = Number.isFinite(days) ? Math.floor(days) : 0;
  let added = 0;
  while (added < target) {
    ms += DAY_MS;
    if (!isWeekendDow(new Date(ms).getUTCDay())) added += 1;
  }
  return new Date(ms);
}

export interface DeliveryWindowInput {
  now: Date;
  /** Warehouse daily cutoff "HH:MM" 24h in `timezone`; null = no cutoff. */
  cutoffLocal: string | null;
  /** IANA timezone of the warehouse; invalid/null → DEFAULT_BUSINESS_TZ. */
  timezone: string | null;
  minBusinessDays: number;
  maxBusinessDays: number;
}

export interface DeliveryWindow {
  /** Earliest delivery calendar date, ISO "yyyy-mm-dd" (warehouse-local). */
  minDate: string;
  /** Latest delivery calendar date, ISO "yyyy-mm-dd" (warehouse-local). */
  maxDate: string;
}

/**
 * Ship date + transit business days → the customer-facing delivery window.
 *
 * The ship day is resolved in the warehouse's timezone (cutoff semantics
 * above); transit days then advance on that LOCAL calendar day. The result is
 * calendar dates, not instants — Shopify's min/max_delivery_date fields.
 */
export function deliveryWindow(input: DeliveryWindowInput): DeliveryWindow {
  const tz = coerceTimeZone(input.timezone) ?? DEFAULT_BUSINESS_TZ;
  const shipInstant = resolveShipDate(input.now, input.cutoffLocal, tz);
  // Re-anchor the ship day's WAREHOUSE-LOCAL calendar date at UTC noon so the
  // pure UTC business-day ladder walks the calendar the warehouse sees.
  const anchor = utcNoonOfLocalDay(shipInstant, tz);
  return {
    minDate: isoUtcDay(addBusinessDays(anchor, input.minBusinessDays)),
    maxDate: isoUtcDay(addBusinessDays(anchor, input.maxBusinessDays)),
  };
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

/** UTC noon of the instant's calendar day as seen in `timeZone`. */
function utcNoonOfLocalDay(date: Date, timeZone: string): Date {
  // en-CA formats as "yyyy-mm-dd" — the local calendar day, zero tz-offset math.
  const localDay = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const [year, month, day] = localDay.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

/** The date's UTC calendar day as ISO "yyyy-mm-dd". */
function isoUtcDay(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
