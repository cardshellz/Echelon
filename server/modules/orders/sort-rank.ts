/**
 * Sort rank — flattens the pick queue's multi-field sort order into a
 * single lexicographically-sortable string, so downstream systems
 * (ShipStation customField1) that can only sort by one field produce
 * the same order Echelon's picker sees.
 *
 * Format: H-B-PPPP-SSSSSS-AAAAAAAAAA  (22 chars total)
 *   H          1 char   "0" if NOT on hold, "1" if held
 *   B          1 char   "0" if priority >= 9999 (bumped), "1" otherwise
 *   PPPP       4 chars  9999 - priority, zero-padded (lower = higher pri)
 *   SSSSSS     6 chars  SLA deadline: days_since_epoch(sla_due_at)
 *                       lower = earlier deadline = more urgent
 *   AAAAAAAAAA 10 chars age: unix_seconds(placed_at)
 *                       lower = older order = ships first (FIFO)
 *
 * Sort ASC on this string = correct priority ordering. ShipStation sorts
 * customField1 ASC by default; pick queue ORDER BY sort_rank ASC matches.
 */

const HOLD_BIT_NOT_HELD = "0";
const HOLD_BIT_HELD = "1";
const BUMP_BIT_BUMPED = "0";
const BUMP_BIT_NORMAL = "1";
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
  const P = pad(PRIORITY_MAX - priority, 4);

  // SLA component: earlier deadline = fewer days from epoch = lower value
  // = sorts first in ASC. Orders sharing the same deadline get identical S
  // values; the age component (A) breaks ties by FIFO.
  let slaComponent = SLA_MAX;
  if (input.slaDueAt) {
    const slaDate = input.slaDueAt instanceof Date ? input.slaDueAt : new Date(input.slaDueAt);
    if (!isNaN(slaDate.getTime())) {
      const daysSinceEpoch = Math.floor((slaDate.getTime() - SLA_EPOCH_MS) / 86400000);
      slaComponent = Math.max(0, daysSinceEpoch);
    }
  }
  const S = pad(Math.min(SLA_MAX, slaComponent), SLA_WIDTH);

  // Age component: older = lower unix timestamp = lower value = sorts first
  // in ASC (FIFO). Orders with no placed date get AGE_MAX (sort last).
  let ageComponent = AGE_MAX;
  if (input.orderPlacedAt) {
    const placed = input.orderPlacedAt instanceof Date ? input.orderPlacedAt : new Date(input.orderPlacedAt);
    if (!isNaN(placed.getTime())) {
      ageComponent = Math.floor(placed.getTime() / 1000);
    }
  }
  const A = pad(Math.min(AGE_MAX, ageComponent), AGE_WIDTH);

  return `${H}-${B}-${P}-${S}-${A}`;
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

interface PickPrioritySettingsCache {
  shippingBase: Record<ShippingServiceLevel, number>;
  slaDefaultDays: number;
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
 * Add business days (Mon-Fri) and normalize to 5 PM.
 */
export function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    if (result.getDay() !== 0 && result.getDay() !== 6) added++;
  }
  result.setHours(17, 0, 0, 0);
  return result;
}

export interface ResolveSlaDueAtInput {
  channelId?: number | null;
  channelShipByDate?: Date | string | null;
  explicitSlaDueAt?: Date | string | null;
  orderPlacedAt?: Date | string | null;
  createdAt?: Date | string | null;
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

  return addBusinessDays(baseDate, slaDays);
}

async function loadSettings(dbHandle: PickPrioritySettingsDb): Promise<PickPrioritySettingsCache> {
  const now = Date.now();
  if (settingsCache && settingsCache.expiresAt > now) {
    return settingsCache;
  }

  const shippingBase: Record<ShippingServiceLevel, number> = { ...DEFAULT_SHIPPING_BASE };
  let slaDefaultDays = DEFAULT_SLA_DAYS;

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
        'priority.sla_default_days'
      )
    `);
    for (const raw of result.rows as SettingsRow[]) {
      const row = raw;
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
