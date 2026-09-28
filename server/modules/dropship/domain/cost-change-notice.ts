import {
  costChangeMeetsNoticeMinimum,
  type CostChangeEventType,
  type DropshipCostChangePolicySettings,
} from "../../../../shared/dropship/cost-change-policy";

/**
 * Whether, and how, a recorded .ops cost change is announced to the vendor
 * (docs/DROPSHIP-COST-CHANGE-CONTROLS.md, C4). Pure rules over one change
 * log row and the policy in force; the notice pass applies them and records
 * the decision either way. Money is integer cents.
 */

export const costChangeNoticeDecisions = [
  "sent",
  "skipped_baseline",
  "skipped_decrease",
  "skipped_below_minimum",
  "skipped_channels_off",
  "skipped_unannounced",
] as const;
export type CostChangeNoticeDecision = (typeof costChangeNoticeDecisions)[number];

/** What the vendor is told: a change with a date ahead, one applied at once, or an update to one announced earlier. */
export const costChangeNoticeKinds = ["announced", "applied", "updated"] as const;
export type CostChangeNoticeKind = (typeof costChangeNoticeKinds)[number];

export type CostChangeNoticeChannel = "email" | "in_app";

export interface CostChangeNoticeVerdict {
  decision: CostChangeNoticeDecision;
  kind: CostChangeNoticeKind | null;
}

/** The channels the policy sends notices on; empty means the policy sends none. */
export function costChangeNoticeChannels(
  settings: Pick<DropshipCostChangePolicySettings, "notifyByEmail" | "notifyInPortal">,
): CostChangeNoticeChannel[] {
  const channels: CostChangeNoticeChannel[] = [];
  if (settings.notifyByEmail) channels.push("email");
  if (settings.notifyInPortal) channels.push("in_app");
  return channels;
}

/**
 * Decide one change log row.
 * - A schedule start is not a change.
 * - A decrease is announced only when the policy says so.
 * - A change under the policy's minimums is recorded and scheduled but not announced.
 * - A lowered or withdrawn change is announced only if its original announcement was sent.
 * - Nothing is sent when the policy sends on no channel.
 */
export function decideCostChangeNotice(input: {
  eventType: CostChangeEventType;
  fromCents: number | null;
  toCents: number | null;
  /** True when a notice was sent for the same schedule entry before (its announcement). */
  previouslySent: boolean;
  settings: Pick<DropshipCostChangePolicySettings, "notifyByEmail" | "notifyInPortal" | "notifyOnDecrease" | "noticeMinimumChangeCents" | "noticeMinimumChangeBps">;
}): CostChangeNoticeVerdict {
  const channelsOn = costChangeNoticeChannels(input.settings).length > 0;
  switch (input.eventType) {
    case "baseline":
      return { decision: "skipped_baseline", kind: null };
    case "increase_announced":
    case "decrease_announced":
    case "increase_applied":
    case "decrease_applied": {
      if (input.fromCents === null || input.toCents === null) {
        throw new RangeError(`A ${input.eventType} row must carry both amounts.`);
      }
      const decrease = input.eventType.startsWith("decrease");
      if (decrease && !input.settings.notifyOnDecrease) return { decision: "skipped_decrease", kind: null };
      if (!costChangeMeetsNoticeMinimum(input.settings, input.fromCents, input.toCents)) {
        return { decision: "skipped_below_minimum", kind: null };
      }
      if (!channelsOn) return { decision: "skipped_channels_off", kind: null };
      return { decision: "sent", kind: input.eventType.endsWith("_applied") ? "applied" : "announced" };
    }
    case "increase_reduced":
    case "change_withdrawn":
      if (!input.previouslySent) return { decision: "skipped_unannounced", kind: null };
      if (!channelsOn) return { decision: "skipped_channels_off", kind: null };
      return { decision: "sent", kind: "updated" };
  }
}

/**
 * One notification per vendor, reading and kind: a plan switch that changes
 * hundreds of costs in one reading is one message, not hundreds. The key
 * carries the vendor id because the notification store's idempotency index is
 * shared across vendors.
 */
export function costChangeNoticeIdempotencyKey(input: {
  vendorId: number;
  kind: CostChangeNoticeKind;
  recordedBy: string;
  observedAt: Date;
}): string {
  if (!Number.isSafeInteger(input.vendorId) || input.vendorId <= 0) throw new RangeError("vendorId must be a positive integer.");
  if (!Number.isFinite(input.observedAt.getTime())) throw new RangeError("observedAt must be a valid date.");
  return `dropship-cost-change:${input.vendorId}:${input.kind}:${input.recordedBy}:${input.observedAt.toISOString()}`;
}
