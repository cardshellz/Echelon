import { z } from "zod";

/**
 * The staff-set policy for .ops cost changes: how much notice a vendor gets
 * before an increase is charged, whether orders keep the current cost until
 * then, who is told, and what happens to listings when the new cost takes
 * effect.
 *
 * One definition for the server, which validates and enforces it, and the
 * admin settings module, which edits it. Each setting's range lives here once.
 * Pure: no clock, no I/O.
 */

/** Ninety days of notice is the most a policy may give; longer is a typo, not a policy. */
export const MAX_INCREASE_NOTICE_DAYS = 90;
/** $1,000 per unit: any larger "minimum change" would silence every notice. */
export const MAX_NOTICE_MINIMUM_CHANGE_CENTS = 100_000;
/** Basis points in a whole: 10,000 bps = 100%. */
export const BASIS_POINTS_PER_WHOLE = 10_000;
/** Detection runs at most every 15 minutes and at least once a day. */
export const MIN_DETECTION_INTERVAL_MINUTES = 15;
export const MAX_DETECTION_INTERVAL_MINUTES = 1_440;

/**
 * What the cost change log can record for one vendor and variant, named once
 * for the server (domain/cost-schedule.ts) and the admin module. "Announced"
 * events take effect on a later date; "applied" ones took effect at once.
 */
export const costChangeEventTypeValues = [
  "baseline",
  "increase_announced",
  "increase_applied",
  "decrease_announced",
  "decrease_applied",
  "increase_reduced",
  "change_withdrawn",
] as const;
export type CostChangeEventType = (typeof costChangeEventTypeValues)[number];

/** Where a .ops cost comes from (server/modules/dropship/application/dropship-product-cost.ts). */
export const costSourceValues = ["variant_fixed_price", "variant_percent", "plan_percent", "retail"] as const;
export type CostSource = (typeof costSourceValues)[number];

export const costDecreaseTimingValues = ["immediate", "after_notice"] as const;
export const rulePricedListingActionValues = ["reprice_automatically", "wait_for_review"] as const;
export const belowCostListingActionValues = ["no_action", "warn", "pause_listing"] as const;

export type CostDecreaseTiming = (typeof costDecreaseTimingValues)[number];
export type RulePricedListingAction = (typeof rulePricedListingActionValues)[number];
export type BelowCostListingAction = (typeof belowCostListingActionValues)[number];

export const dropshipCostChangePolicySettingsSchema = z.object({
  /** Days from the notice of an increase to the day orders are charged the new cost. */
  increaseNoticeDays: z.number().int().min(0).max(MAX_INCREASE_NOTICE_DAYS),
  /** Whether a decrease is charged at once or after the same notice. */
  decreaseTiming: z.enum(costDecreaseTimingValues),
  /** Orders keep the current cost until an announced increase takes effect. */
  priceProtection: z.boolean(),
  /**
   * Whether a change caused only by a Shopify retail price move, on a cost set
   * as a percentage of retail, gets the same notice. Off applies it at once.
   */
  retailChangesGetNotice: z.boolean(),
  notifyByEmail: z.boolean(),
  notifyInPortal: z.boolean(),
  notifyOnDecrease: z.boolean(),
  /**
   * Notices are skipped for a change under this many cents per unit, or under
   * the percentage below. The change is still recorded, scheduled and
   * protected either way. Zero means no minimum.
   */
  noticeMinimumChangeCents: z.number().int().min(0).max(MAX_NOTICE_MINIMUM_CHANGE_CENTS),
  noticeMinimumChangeBps: z.number().int().min(0).max(BASIS_POINTS_PER_WHOLE),
  /** When an increase takes effect, listings priced by pricing rules. */
  rulePricedListings: z.enum(rulePricedListingActionValues),
  /** When an increase takes effect, fixed-price listings the new cost puts under water. */
  belowCostFixedListings: z.enum(belowCostListingActionValues),
  /** How often live .ops costs are compared with the cost book. */
  detectionIntervalMinutes: z.number().int().min(MIN_DETECTION_INTERVAL_MINUTES).max(MAX_DETECTION_INTERVAL_MINUTES),
}).strict();

export type DropshipCostChangePolicySettings = z.infer<typeof dropshipCostChangePolicySettingsSchema>;

/**
 * What applies before staff save a first version. ASSUMPTION (owner to
 * confirm in the settings module): two weeks' notice, decreases at once,
 * protection on, every change announced by email and in the portal,
 * rule-priced listings repriced and under-water fixed prices flagged.
 */
export const DEFAULT_DROPSHIP_COST_CHANGE_POLICY: Readonly<DropshipCostChangePolicySettings> = Object.freeze({
  increaseNoticeDays: 14,
  decreaseTiming: "immediate",
  priceProtection: true,
  retailChangesGetNotice: true,
  notifyByEmail: true,
  notifyInPortal: true,
  notifyOnDecrease: true,
  noticeMinimumChangeCents: 0,
  noticeMinimumChangeBps: 0,
  rulePricedListings: "reprice_automatically",
  belowCostFixedListings: "warn",
  detectionIntervalMinutes: 60,
});

/**
 * Whether a change of `fromCents` to `toCents` is large enough to announce.
 * Both minimums must be met; zero disables a minimum. Integer arithmetic only.
 */
export function costChangeMeetsNoticeMinimum(
  settings: Pick<DropshipCostChangePolicySettings, "noticeMinimumChangeCents" | "noticeMinimumChangeBps">,
  fromCents: number,
  toCents: number,
): boolean {
  assertCents(fromCents, "fromCents");
  assertCents(toCents, "toCents");
  const deltaCents = Math.abs(toCents - fromCents);
  if (deltaCents === 0) return false;
  if (deltaCents < settings.noticeMinimumChangeCents) return false;
  if (settings.noticeMinimumChangeBps === 0) return true;
  // A cost starting at zero changes by an unbounded percentage.
  if (fromCents === 0) return true;
  // deltaCents / fromCents >= bps / 10,000, without division.
  return deltaCents * BASIS_POINTS_PER_WHOLE >= settings.noticeMinimumChangeBps * fromCents;
}

function assertCents(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of cents.`);
  }
}
