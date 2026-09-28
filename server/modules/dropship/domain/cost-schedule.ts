/**
 * The .ops cost schedule of one vendor for one variant: the cost in force and
 * any announced changes, and how a new reading of the live cost changes it.
 *
 * Why a schedule: Card Shellz can change a .ops cost at any time (plan
 * overrides, plan discounts, Shopify retail for percentage costs, a plan
 * switch). Without one, the next accepted order is charged the new cost the
 * moment it is saved (dropship-order-acceptance.repository.ts). The schedule
 * lets an increase be announced and charged only from its effective date,
 * while a decrease can apply at once.
 *
 * Model: entries (cost, effectiveAt). The cost in force at time t is the
 * latest entry with effectiveAt <= t. Entries after t are announced changes.
 *
 * Principles the rules follow:
 * - The schedule's future always ends at the live cost.
 * - An announced increase never takes effect earlier, or larger, than
 *   announced. When the live cost falls below an announced amount, the entry
 *   is lowered and keeps its date.
 * - A change the live cost no longer supports is withdrawn.
 *
 * Money is integer cents. Pure: the reading carries its time; no clock, no I/O.
 */

import { costChangeEventTypeValues, type CostChangeEventType } from "../../../../shared/dropship/cost-change-policy";

export const MILLISECONDS_PER_DAY = 86_400_000;

export interface CostScheduleEntry {
  entryId: number;
  unitCostCents: number;
  effectiveAt: Date;
}

export interface LiveCostReading {
  unitCostCents: number;
  observedAt: Date;
  /**
   * True when only the Shopify retail basis moved under a cost set as a
   * percentage of retail; the policy may apply such changes at once.
   */
  retailDriven: boolean;
}

export interface CostScheduleTiming {
  increaseNoticeDays: number;
  decreaseTiming: "immediate" | "after_notice";
  retailChangesGetNotice: boolean;
}

export type CostChangeDirection = "increase" | "decrease";

export type CostScheduleOperation =
  /** First reading: the cost in force from now. Not a change. */
  | { kind: "baseline"; unitCostCents: number; effectiveAt: Date }
  /** A new entry: in force now when effectiveAt equals the reading time, else announced. */
  | { kind: "add"; direction: CostChangeDirection; fromCents: number; unitCostCents: number; effectiveAt: Date }
  /** An announced increase lowered to the live cost, on its original date. */
  | { kind: "reduce"; entryId: number; fromCents: number; unitCostCents: number; effectiveAt: Date }
  /** An announced change the live cost no longer supports. */
  | { kind: "withdraw"; entryId: number; unitCostCents: number; effectiveAt: Date };

export interface CostScheduleReconciliation {
  operations: CostScheduleOperation[];
  /** In force at the reading time before these operations; null for a first reading. */
  inForceBeforeCents: number | null;
  /** In force at the reading time after them: what an order accepted now is charged under price protection. */
  inForceAfterCents: number;
}

export class CostScheduleError extends Error {
  constructor(readonly code: "COST_SCHEDULE_INVALID_COST" | "COST_SCHEDULE_INVALID_TIME" | "COST_SCHEDULE_INVALID_TIMING",
    message: string) {
    super(message);
    this.name = "CostScheduleError";
  }
}

/** Entries in effect order: by date, then by identity, so equal dates are stable. */
export function sortCostSchedule<T extends CostScheduleEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) =>
    left.effectiveAt.getTime() - right.effectiveAt.getTime() || left.entryId - right.entryId);
}

/**
 * The entry in force at `at`, or null for an empty schedule. Before the first
 * entry's date (a reading a few milliseconds ahead of another dyno's clock),
 * the first entry applies: it is the cost observed when the schedule began.
 */
export function entryInForce<T extends CostScheduleEntry>(entries: readonly T[], at: Date): T | null {
  assertTime(at, "at");
  const sorted = sortCostSchedule(entries);
  if (sorted.length === 0) return null;
  let inForce = sorted[0];
  for (const entry of sorted) {
    if (entry.effectiveAt.getTime() <= at.getTime()) inForce = entry;
  }
  return inForce;
}

/** The cost in force at `at`, or null for an empty schedule. */
export function costInForce(entries: readonly CostScheduleEntry[], at: Date): number | null {
  return entryInForce(entries, at)?.unitCostCents ?? null;
}

/**
 * When an announced change takes effect: `noticeDays` full days after the
 * reading, rounded up to the next midnight UTC so a vendor is told a date, not
 * a minute. Zero days means at once.
 */
export function announcedEffectiveAt(observedAt: Date, noticeDays: number): Date {
  assertTime(observedAt, "observedAt");
  if (!Number.isSafeInteger(noticeDays) || noticeDays < 0) {
    throw new CostScheduleError("COST_SCHEDULE_INVALID_TIMING", "Notice days must be a non-negative whole number.");
  }
  if (noticeDays === 0) return new Date(observedAt.getTime());
  const earliest = observedAt.getTime() + noticeDays * MILLISECONDS_PER_DAY;
  const remainder = earliest % MILLISECONDS_PER_DAY;
  return new Date(remainder === 0 ? earliest : earliest - remainder + MILLISECONDS_PER_DAY);
}

export function reconcileCostSchedule(input: {
  entries: readonly CostScheduleEntry[];
  reading: LiveCostReading;
  timing: CostScheduleTiming;
}): CostScheduleReconciliation {
  const { reading, timing } = input;
  assertCost(reading.unitCostCents, "reading.unitCostCents");
  assertTime(reading.observedAt, "reading.observedAt");
  for (const entry of input.entries) {
    assertCost(entry.unitCostCents, `entry ${entry.entryId} unitCostCents`);
    assertTime(entry.effectiveAt, `entry ${entry.entryId} effectiveAt`);
  }
  const now = reading.observedAt;
  const live = reading.unitCostCents;
  const sorted = sortCostSchedule(input.entries);

  if (sorted.length === 0) {
    return {
      operations: [{ kind: "baseline", unitCostCents: live, effectiveAt: now }],
      inForceBeforeCents: null,
      inForceAfterCents: live,
    };
  }

  const inForceEntry = entryInForce(sorted, now) as CostScheduleEntry;
  const inForce = inForceEntry.unitCostCents;
  // The entry in force is never an announced change, even when a reading a
  // moment before the schedule began (another dyno's clock) puts the first
  // entry's date just ahead of the reading.
  const future = sorted.filter((entry) => entry !== inForceEntry && entry.effectiveAt.getTime() > now.getTime());
  const operations: CostScheduleOperation[] = [];
  const withdrawAll = () => {
    for (const entry of future) operations.push(withdraw(entry));
  };

  if (live === inForce) {
    withdrawAll();
    return { operations, inForceBeforeCents: inForce, inForceAfterCents: inForce };
  }

  if (live < inForce) {
    withdrawAll();
    const effectiveAt = timing.decreaseTiming === "immediate" ? now : announcedEffectiveAt(now, timing.increaseNoticeDays);
    operations.push({ kind: "add", direction: "decrease", fromCents: inForce, unitCostCents: live, effectiveAt });
    return { operations, inForceBeforeCents: inForce, inForceAfterCents: inForceAfter(inForce, live, effectiveAt, now) };
  }

  // An increase.
  if (reading.retailDriven && !timing.retailChangesGetNotice) {
    withdrawAll();
    operations.push({ kind: "add", direction: "increase", fromCents: inForce, unitCostCents: live, effectiveAt: now });
    return { operations, inForceBeforeCents: inForce, inForceAfterCents: live };
  }

  let running = inForce;
  for (const entry of future) {
    if (entry.unitCostCents <= running) {
      // A decrease, or no change, after the running cost: the live cost is
      // higher now, so it no longer holds.
      operations.push(withdraw(entry));
      continue;
    }
    const target = Math.min(entry.unitCostCents, live);
    if (target === running) {
      operations.push(withdraw(entry));
    } else if (target < entry.unitCostCents) {
      operations.push({ kind: "reduce", entryId: entry.entryId, fromCents: entry.unitCostCents, unitCostCents: target,
        effectiveAt: entry.effectiveAt });
      running = target;
    } else {
      running = target;
    }
  }
  if (running < live) {
    const effectiveAt = announcedEffectiveAt(now, timing.increaseNoticeDays);
    operations.push({ kind: "add", direction: "increase", fromCents: running, unitCostCents: live, effectiveAt });
    return { operations, inForceBeforeCents: inForce, inForceAfterCents: inForceAfter(inForce, live, effectiveAt, now) };
  }
  return { operations, inForceBeforeCents: inForce, inForceAfterCents: inForce };
}

function inForceAfter(inForce: number, live: number, effectiveAt: Date, now: Date): number {
  return effectiveAt.getTime() <= now.getTime() ? live : inForce;
}

function withdraw(entry: CostScheduleEntry): CostScheduleOperation {
  return { kind: "withdraw", entryId: entry.entryId, unitCostCents: entry.unitCostCents, effectiveAt: entry.effectiveAt };
}

function assertCost(value: number, name: string): void {
  // A .ops cost of zero is refused upstream (resolveAcceptanceUnitCost); a
  // schedule that started at zero would make every later cost an increase.
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CostScheduleError("COST_SCHEDULE_INVALID_COST", `${name} must be a positive integer number of cents.`);
  }
}

function assertTime(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CostScheduleError("COST_SCHEDULE_INVALID_TIME", `${name} must be a valid date.`);
  }
}

// --- Where a reading came from -------------------------------------------------

/**
 * How a live cost was arrived at (application/dropship-product-cost.ts). The
 * retail basis and the discount are recorded so a later reading can tell a
 * Shopify retail move apart from a change to the plan or an override.
 */
export interface CostReadingEvidence {
  source: string;
  planId: string;
  overrideId: string | null;
  /** The Shopify retail price the cost was computed from; null when the source ignores retail. */
  retailPriceCents: number | null;
  /** The discount applied to that retail price, in basis points; null when the source ignores retail. */
  discountBps: number | null;
}

/** Cost sources computed from the Shopify retail price. A fixed-price override is not one. */
export const RETAIL_BASED_COST_SOURCES: readonly string[] = Object.freeze(["retail", "variant_percent", "plan_percent"]);

/**
 * Whether the only thing that moved between the reading behind the cost in
 * force and the live reading is the Shopify retail price: the same
 * retail-based source, plan, override and discount, and a different retail
 * price. Anything else (a plan switch, a new or changed override, a changed
 * plan percentage) is not a retail move, so it always gets the policy's notice.
 */
export function isRetailDrivenReading(inForce: CostReadingEvidence, live: CostReadingEvidence): boolean {
  return RETAIL_BASED_COST_SOURCES.includes(live.source)
    && live.source === inForce.source
    && live.planId === inForce.planId
    && live.overrideId === inForce.overrideId
    && live.discountBps !== null
    && live.discountBps === inForce.discountBps
    && live.retailPriceCents !== null
    && inForce.retailPriceCents !== null
    && live.retailPriceCents !== inForce.retailPriceCents;
}

// --- What an operation means in the change log ---------------------------------

export const costScheduleEventTypes = costChangeEventTypeValues;

export type CostScheduleEventType = CostChangeEventType;

/** The change log's name for an operation applied at `now`: announced when its date is still ahead, applied otherwise. */
export function costScheduleEventType(operation: CostScheduleOperation, now: Date): CostScheduleEventType {
  assertTime(now, "now");
  switch (operation.kind) {
    case "baseline":
      return "baseline";
    case "add": {
      const applied = operation.effectiveAt.getTime() <= now.getTime();
      if (operation.direction === "increase") return applied ? "increase_applied" : "increase_announced";
      return applied ? "decrease_applied" : "decrease_announced";
    }
    case "reduce":
      return "increase_reduced";
    case "withdraw":
      return "change_withdrawn";
  }
}

/**
 * What the change log records an operation as changing from and to. A
 * withdrawal has no "to": the announced amount is simply gone.
 */
export function costScheduleLogAmounts(operation: CostScheduleOperation): { fromCents: number | null; toCents: number | null } {
  switch (operation.kind) {
    case "baseline":
      return { fromCents: null, toCents: operation.unitCostCents };
    case "add":
    case "reduce":
      return { fromCents: operation.fromCents, toCents: operation.unitCostCents };
    case "withdraw":
      return { fromCents: operation.unitCostCents, toCents: null };
  }
}
