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
