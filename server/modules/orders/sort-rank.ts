/**
 * Sort rank — flattens the pick queue's multi-field sort order into a
 * single lexicographically-sortable string, so downstream systems
 * (ShipStation) that can only sort by one field produce the same order
 * Echelon's picker sees.
 *
 * Format: H-B-PPPP-SSSSSS-AAAAAAAAAA  (22 chars total)
 *   H          1 char   "1" if NOT on hold, "0" if held
 *   B          1 char   "1" if priority >= 9999 (bumped), "0" otherwise
 *   PPPP       4 chars  priority 0000-9999, zero-padded
 *   SSSSSS     6 chars  SLA urgency: 999999 - minutes_until_sla (capped >=0)
 *                       higher = closer to SLA breach
 *   AAAAAAAAAA 10 chars age component: 9999999999 - unix_seconds(placed_at)
 *                       higher = older order
 *
 * Sort DESC on this string = same ranking as the picker queue's SQL order.
 *
 * Safety: all fields are zero-padded to fixed width. Lexical string sort
 * equals numeric sort. No floating-point, no overflow concerns within
 * any realistic lifetime.
 */

const HOLD_BIT_NOT_HELD = "1";
const HOLD_BIT_HELD = "0";
const BUMP_BIT_BUMPED = "1";
const BUMP_BIT_NORMAL = "0";
const BUMP_THRESHOLD = 9999;

const SLA_WIDTH = 6;
const SLA_MAX = 999999;

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
  const now = input.now ?? new Date();
  const priority = Math.max(0, Math.min(BUMP_THRESHOLD, Math.floor(input.priority ?? 0)));
  const isHeld = input.onHold === true || input.onHold === 1;
  const isBumped = priority >= BUMP_THRESHOLD;

  const H = isHeld ? HOLD_BIT_HELD : HOLD_BIT_NOT_HELD;
  const B = isBumped ? BUMP_BIT_BUMPED : BUMP_BIT_NORMAL;
  const P = pad(priority, 4);

  // SLA component: smaller minutes_until_sla = more urgent = larger S component
  let slaComponent = 0;
  if (input.slaDueAt) {
    const slaDate = input.slaDueAt instanceof Date ? input.slaDueAt : new Date(input.slaDueAt);
    if (!isNaN(slaDate.getTime())) {
      const minutesUntilSla = Math.round((slaDate.getTime() - now.getTime()) / 60000);
      slaComponent = Math.max(0, SLA_MAX - Math.max(0, minutesUntilSla));
    }
  }
  const S = pad(Math.min(SLA_MAX, slaComponent), SLA_WIDTH);

  // Age component: older = higher. Stored once at sync, never recomputed.
  let ageComponent = AGE_MAX;
  if (input.orderPlacedAt) {
    const placed = input.orderPlacedAt instanceof Date ? input.orderPlacedAt : new Date(input.orderPlacedAt);
    if (!isNaN(placed.getTime())) {
      const unixSeconds = Math.floor(placed.getTime() / 1000);
      ageComponent = Math.max(0, AGE_MAX - unixSeconds);
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
