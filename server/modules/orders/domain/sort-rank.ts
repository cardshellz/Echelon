/**
 * Sort rank — flattens the pick queue's multi-field sort order into a
 * single lexicographically-sortable string, so downstream systems
 * (ShipStation customField1) that can only sort by one field produce
 * the same order Echelon's picker sees.
 *
 * Format: H-B-SSSSSS-PPPP-AAAAAAAAAA
 *   H          1 char   "1" if NOT on hold, "0" if held
 *   B          1 char   "1" if priority >= 9999 (bumped), "0" otherwise
 *   SSSSSS     6 chars  SLA deadline: 999999 - days_since_epoch(sla_due_at)
 *                       higher = earlier deadline = more urgent
 *   PPPP       4 chars  priority 0000-9999, zero-padded
 *   AAAAAAAAAA 10 chars age: 9999999999 - unix_seconds(placed_at)
 *                       higher = older order = ships first (FIFO)
 *
 * Sort DESC on this string = correct priority ordering.
 */

const HOLD_BIT_NOT_HELD = "1";
const HOLD_BIT_HELD = "0";
const BUMP_BIT_BUMPED = "1";
const BUMP_BIT_NORMAL = "0";
const BUMP_THRESHOLD = 9999;

const PRIORITY_MAX = 9999;

const SLA_WIDTH = 6;
const SLA_MAX = 999999;
// Fixed reference epoch for absolute SLA encoding. Days from this date
// fit comfortably in 6 digits for decades.
const SLA_EPOCH_MS = Date.UTC(2024, 0, 1);

const AGE_WIDTH = 10;
const AGE_MAX = 9999999999;

function pad(value: number, width: number): string {
  const s = String(Math.max(0, Math.floor(value)));
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

export interface SortRankInput {
  priority: number;
  onHold: boolean | number;
  slaDueAt?: Date | string | null;
  orderPlacedAt?: Date | string | null;
  now?: Date; // injectable for tests
}

export function computeSortRank(input: SortRankInput): string {
  const priority = Math.max(0, Math.min(PRIORITY_MAX, Math.floor(input.priority ?? 0)));
  const isHeld = input.onHold === true || input.onHold === 1;
  const isBumped = priority >= BUMP_THRESHOLD;

  const H = isHeld ? HOLD_BIT_HELD : HOLD_BIT_NOT_HELD;
  const B = isBumped ? BUMP_BIT_BUMPED : BUMP_BIT_NORMAL;
  const P = pad(priority, 4);

  // SLA component: earlier deadline = fewer days from epoch = higher
  // inverted value = sorts first in DESC. Orders sharing the same deadline get identical S
  // values; the age component (A) breaks ties by FIFO.
  let slaComponent = 0;
  if (input.slaDueAt) {
    const slaDate = input.slaDueAt instanceof Date ? input.slaDueAt : new Date(input.slaDueAt);
    if (!isNaN(slaDate.getTime())) {
      const daysSinceEpoch = Math.floor((slaDate.getTime() - SLA_EPOCH_MS) / 86400000);
      slaComponent = Math.max(0, SLA_MAX - Math.max(0, daysSinceEpoch));
    }
  }
  const S = pad(Math.min(SLA_MAX, slaComponent), SLA_WIDTH);

  // Age component: older = lower unix timestamp = higher inverted value =
  // sorts first in DESC (FIFO). Orders with no placed date get 0 (sort last).
  let ageComponent = 0;
  if (input.orderPlacedAt) {
    const placed = input.orderPlacedAt instanceof Date ? input.orderPlacedAt : new Date(input.orderPlacedAt);
    if (!isNaN(placed.getTime())) {
      const unixSeconds = Math.floor(placed.getTime() / 1000);
      ageComponent = Math.max(0, AGE_MAX - unixSeconds);
    }
  }
  const A = pad(Math.min(AGE_MAX, ageComponent), AGE_WIDTH);

  return `${H}-${B}-${S}-${P}-${A}`;
}

// ---------------------------------------------------------------------------
// Pick-priority settings (echelon_settings) — shipping base + SLA fallback.
// Cached 30s in-memory so the WMS sync hot path doesn't hit the DB on every
// order. Admins rarely change these; 30s staleness is fine.
// ---------------------------------------------------------------------------

export type ShippingServiceLevel = "standard" | "expedited" | "overnight";

export const DEFAULT_SHIPPING_BASE: Record<ShippingServiceLevel, number> = {
  standard: 100,
  expedited: 300,
  overnight: 500,
};

export const DEFAULT_SLA_DAYS = 3;

// Hardcoded last-resort business timezone. Used only when neither the order's
// warehouse nor the global default_timezone setting supplies one. The Leonberg
// warehouse + the dyno both run Eastern, so this matches historical behavior.
export const DEFAULT_BUSINESS_TZ = "America/New_York";

interface PickPrioritySettingsCache {
  shippingBase: Record<ShippingServiceLevel, number>;
  slaDefaultDays: number;
  defaultTimezone: string | null;
  expiresAt: number;
}

const SETTINGS_CACHE_TTL_MS = 30_000;
let settingsCache: PickPrioritySettingsCache | null = null;

interface SettingsRow { key: string; value: string | null }

// We accept any Drizzle-like db with an `execute` method. Kept loose to avoid
// tight coupling to a specific Drizzle driver (NodePg vs NeonHttp) and to keep
// sort-rank.ts easy to unit-test with a stub.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PickPrioritySettingsDb = { execute: (query: any) => Promise<{ rows: any[] }> };

function coerceValidDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function coerceSlaDays(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

/**
 * Validate that a string is a real IANA timezone. Returns it if so, else null.
 * A bad tz must never silently poison SLA math — callers fall back when null.
 */
export function coerceTimeZone(tz: string | null | undefined): string | null {
  if (!tz || typeof tz !== "string") return null;
  try {
    // Throws RangeError for an unknown zone.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/**
 * Parse an "HH:MM" 24h cutoff into minutes-since-midnight, or null if unset /
 * malformed (null = no cutoff = legacy behavior, SLA from the raw placed day).
 */
export function parseCutoffMinutes(cutoff: string | null | undefined): number | null {
  if (!cutoff || typeof cutoff !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(cutoff.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// ---------------------------------------------------------------------------
// Timezone-aware date math. We deliberately avoid a date library: Intl gives us
// everything needed to (a) read an instant's wall-clock parts in a given zone
// and (b) convert a wall-clock back to a UTC instant, DST included. All calendar
// arithmetic (advance days, skip weekends) runs on a pure proleptic UTC ladder
// so it's independent of any ambient/server timezone.
// ---------------------------------------------------------------------------

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Read an instant's wall-clock Y/M/D/H/M + weekday in the given timezone. */
function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // some engines emit "24" at midnight under h23
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    weekday: WEEKDAY_INDEX[map.weekday] ?? 0,
  };
}

/** Offset (ms) such that wallclock = utc + offset, for `timeZone` at `date`. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second));
  return asUTC - date.getTime();
}

/** The UTC instant whose wall-clock in `timeZone` is the given Y/M/D H:M. */
function utcFromZonedWall(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const naiveUTC = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Two-pass solve: the offset depends on the instant, which depends on the
  // offset. One refinement resolves all but the rare DST-gap/overlap hour,
  // which our 12:00/17:00 anchors never land on.
  const off1 = tzOffsetMs(new Date(naiveUTC), timeZone);
  let utc = naiveUTC - off1;
  const off2 = tzOffsetMs(new Date(utc), timeZone);
  if (off2 !== off1) utc = naiveUTC - off2;
  return new Date(utc);
}

const DAY_MS = 86_400_000;
const isWeekendDow = (dow: number) => dow === 0 || dow === 6;

/** Next Mon–Fri strictly after the given calendar date (pure, UTC ladder). */
function nextBusinessDayCal(year: number, month: number, day: number): { year: number; month: number; day: number } {
  let ms = Date.UTC(year, month - 1, day) + DAY_MS;
  while (isWeekendDow(new Date(ms).getUTCDay())) ms += DAY_MS;
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Advance `days` business days from a calendar date (pure, UTC ladder). */
function addBusinessDaysCal(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  let ms = Date.UTC(year, month - 1, day);
  let added = 0;
  while (added < days) {
    ms += DAY_MS;
    if (!isWeekendDow(new Date(ms).getUTCDay())) added += 1;
  }
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Add business days (Mon–Fri) and normalize to 5 PM in `timeZone`. The day-of
 * arithmetic is anchored to the order's calendar day *in that timezone*, so the
 * result no longer depends on the server's ambient timezone.
 */
export function addBusinessDays(date: Date, days: number, timeZone: string = DEFAULT_BUSINESS_TZ): Date {
  const tz = coerceTimeZone(timeZone) ?? DEFAULT_BUSINESS_TZ;
  const p = getZonedParts(date, tz);
  const due = addBusinessDaysCal(p.year, p.month, p.day, days);
  return utcFromZonedWall(due.year, due.month, due.day, 17, 0, tz);
}

/**
 * The fulfillment day an order's SLA clock starts from — the pick wave it makes.
 * If the order was placed after the daily cutoff (or on a weekend), it can't
 * make today's truck, so it rolls to the next business day. This replaces the
 * implicit midnight boundary (which silently depended on the server's timezone)
 * with a deliberate, configurable threshold evaluated in the warehouse's zone.
 *
 * Returns a UTC instant at local noon of the effective day (noon is DST-stable,
 * so downstream date extraction always lands on the intended calendar day).
 */
export function effectiveFulfillmentDate(placedAt: Date, timeZone: string, cutoffMinutes: number | null): Date {
  const tz = coerceTimeZone(timeZone) ?? DEFAULT_BUSINESS_TZ;
  const p = getZonedParts(placedAt, tz);
  let { year, month, day } = p;
  const minutesOfDay = p.hour * 60 + p.minute;
  const rolls = isWeekendDow(p.weekday) || (cutoffMinutes != null && minutesOfDay >= cutoffMinutes);
  if (rolls) {
    const next = nextBusinessDayCal(year, month, day);
    year = next.year; month = next.month; day = next.day;
  }
  return utcFromZonedWall(year, month, day, 12, 0, tz);
}

export interface ResolveSlaDueAtInput {
  channelId?: number | null;
  channelShipByDate?: Date | string | null;
  explicitSlaDueAt?: Date | string | null;
  orderPlacedAt?: Date | string | null;
  createdAt?: Date | string | null;
  /**
   * The fulfilling warehouse's local timezone (from warehouse_settings).
   * Falls back to the global default_timezone, then DEFAULT_BUSINESS_TZ.
   */
  timezone?: string | null;
  /**
   * The fulfilling warehouse's daily order cutoff ("HH:MM" 24h, from
   * warehouse_settings). null/absent → no cutoff (SLA from the raw placed day).
   */
  cutoffLocal?: string | null;
}

/**
 * Resolve the SLA due date used by WMS ranking.
 *
 * Order:
 * 1. Platform ship-by date, when supplied by the channel.
 * 2. Explicit SLA due date already carried by the caller.
 * 3. channels.channels.sla_days, for any channel type.
 * 4. channels.partner_profiles.sla_days, for legacy partner channels.
 * 5. warehouse.echelon_settings priority.sla_default_days.
 */
export async function resolveSlaDueAt(
  input: ResolveSlaDueAtInput,
  dbHandle: PickPrioritySettingsDb,
): Promise<Date | null> {
  const channelShipBy = coerceValidDate(input.channelShipByDate);
  if (channelShipBy) return channelShipBy;

  const explicit = coerceValidDate(input.explicitSlaDueAt);
  if (explicit) return explicit;

  const baseDate = coerceValidDate(input.orderPlacedAt) ?? coerceValidDate(input.createdAt);
  if (!baseDate) return null;

  let slaDays = coerceSlaDays(await getSlaDefaultDays(dbHandle).catch(() => DEFAULT_SLA_DAYS)) ?? DEFAULT_SLA_DAYS;
  const channelId = Number(input.channelId);
  if (Number.isInteger(channelId) && channelId > 0) {
    try {
      const { sql } = await import("drizzle-orm");
      const result = await dbHandle.execute(sql`
        SELECT
          c.sla_days AS channel_sla_days,
          pp.sla_days AS partner_sla_days
        FROM channels.channels c
        LEFT JOIN channels.partner_profiles pp ON pp.channel_id = c.id
        WHERE c.id = ${channelId}
        LIMIT 1
      `);
      const row = result.rows?.[0];
      const channelSlaDays = coerceSlaDays(row?.channel_sla_days);
      const partnerSlaDays = coerceSlaDays(row?.partner_sla_days);
      slaDays = channelSlaDays ?? partnerSlaDays ?? slaDays;
    } catch (err) {
      // Keep the global fallback if channel lookup fails.
      // eslint-disable-next-line no-console
      console.warn("[sort-rank] Failed to resolve channel SLA days, using default:", (err as Error).message);
    }
  }

  // Resolve the business timezone + daily cutoff. Timezone precedence:
  // order's warehouse → global default_timezone → hardcoded Eastern. The cutoff
  // is opt-in: when unset, behavior is the legacy "SLA from the placed day",
  // just made timezone-explicit (no longer riding the server's ambient zone).
  const settings = await loadSettings(dbHandle).catch(() => null);
  const timeZone =
    coerceTimeZone(input.timezone) ??
    coerceTimeZone(settings?.defaultTimezone) ??
    DEFAULT_BUSINESS_TZ;
  const cutoffMinutes = parseCutoffMinutes(input.cutoffLocal);
  const fulfillmentBase =
    cutoffMinutes == null ? baseDate : effectiveFulfillmentDate(baseDate, timeZone, cutoffMinutes);

  return addBusinessDays(fulfillmentBase, slaDays, timeZone);
}

async function loadSettings(dbHandle: PickPrioritySettingsDb): Promise<PickPrioritySettingsCache> {
  const now = Date.now();
  if (settingsCache && settingsCache.expiresAt > now) {
    return settingsCache;
  }

  const shippingBase: Record<ShippingServiceLevel, number> = { ...DEFAULT_SHIPPING_BASE };
  let slaDefaultDays = DEFAULT_SLA_DAYS;
  let defaultTimezone: string | null = null;

  try {
    // Lazy import to avoid circular imports / allow callers to pass their own db.
    const { sql } = await import("drizzle-orm");
    const result = await dbHandle.execute(sql`
      SELECT key, value
      FROM warehouse.echelon_settings
      WHERE key IN (
        'priority.shipping_base.standard',
        'priority.shipping_base.expedited',
        'priority.shipping_base.overnight',
        'priority.sla_default_days',
        'default_timezone'
      )
    `);
    for (const raw of result.rows as SettingsRow[]) {
      const row = raw;
      // default_timezone is a string, not numeric — handle before coercion.
      if (row.key === "default_timezone") {
        defaultTimezone = coerceTimeZone(row.value);
        continue;
      }
      const n = row.value == null ? NaN : Number(row.value);
      if (!Number.isFinite(n)) continue;
      switch (row.key) {
        case "priority.shipping_base.standard": shippingBase.standard = n; break;
        case "priority.shipping_base.expedited": shippingBase.expedited = n; break;
        case "priority.shipping_base.overnight": shippingBase.overnight = n; break;
        case "priority.sla_default_days": slaDefaultDays = n; break;
      }
    }
  } catch (err) {
    // Swallow — we always have the hardcoded fallback.
    // eslint-disable-next-line no-console
    console.warn("[sort-rank] Failed to load pick-priority settings, using defaults:", (err as Error).message);
  }

  settingsCache = {
    shippingBase,
    slaDefaultDays,
    defaultTimezone,
    expiresAt: now + SETTINGS_CACHE_TTL_MS,
  };
  return settingsCache;
}

/** Invalidate the in-memory settings cache. Call after an admin update. */
export function invalidatePickPrioritySettingsCache(): void {
  settingsCache = null;
}

/**
 * Look up the shipping-service-level base priority score from echelon_settings.
 * Falls back to DEFAULT_SHIPPING_BASE on miss or DB error so sort_rank computation
 * stays resilient.
 */
export async function getShippingBase(
  level: ShippingServiceLevel | string | null | undefined,
  dbHandle: PickPrioritySettingsDb,
): Promise<number> {
  const key = (level as ShippingServiceLevel) || "standard";
  const cached = await loadSettings(dbHandle).catch(() => null);
  const table = cached?.shippingBase ?? DEFAULT_SHIPPING_BASE;
  return table[key as ShippingServiceLevel] ?? table.standard ?? DEFAULT_SHIPPING_BASE.standard;
}

/**
 * Look up the default SLA fallback (business days) from echelon_settings.
 * Falls back to DEFAULT_SLA_DAYS on miss or DB error.
 */
export async function getSlaDefaultDays(dbHandle: PickPrioritySettingsDb): Promise<number> {
  const cached = await loadSettings(dbHandle).catch(() => null);
  return cached?.slaDefaultDays ?? DEFAULT_SLA_DAYS;
}
