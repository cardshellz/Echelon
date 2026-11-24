/**
 * Whose membership plan sets a Dropship order's pick priority.
 *
 * The pick-queue score is the shipping-speed base plus the priority modifier of
 * the Card Shellz member the order belongs to (determinePriority in
 * wms-sync.service.ts). On a retail order that member is the buyer, found by the
 * order's customer email. On a Dropship order the buyer is the vendor's
 * marketplace customer; the Card Shellz member is the vendor, whose plan
 * acceptance records on the order's acceptance stamp
 * (`raw_payload.dropship.vendorMembershipPlanId`). A Dropship order is therefore
 * never scored from the buyer's email, even when that email belongs to a member.
 * Pure: the caller loads every fact.
 */

import { isDropshipOmsOrder, type DropshipOrderIdentity } from "./dropship-order-warehouse";

/** The widest plan id acceptance can record: dropship_vendors.current_plan_id is varchar(255). */
export const DROPSHIP_VENDOR_PLAN_ID_MAX_LENGTH = 255;

/**
 * wms.orders.member_plan_name and member_plan_color are varchar(20)
 * (migration 0554). A longer value would fail the WMS order insert, so it is
 * left off the badge instead; the plan's modifier still applies.
 */
export const MEMBER_PLAN_BADGE_MAX_LENGTH = 20;

export type DropshipVendorPlanIdReading =
  | { kind: "present"; planId: string }
  /** The stamp carries no plan: an order accepted before acceptance recorded it, or a vendor without one. */
  | { kind: "absent" }
  /** The stamp carries a value that is not a plan id. */
  | { kind: "invalid" };

export type PickPriorityPlanSource =
  | { kind: "customer_membership" }
  | { kind: "dropship_vendor_plan"; planId: string }
  | { kind: "dropship_vendor_plan_unavailable"; reason: "absent" | "invalid" };

export interface PickPriorityPlan {
  modifier: number;
  /** Badge text; null when there is no plan or the name does not fit the WMS column. */
  name: string | null;
  color: string | null;
}

/** Scores exactly like an order from a non-member: shipping base only, no badge. */
export const NO_PICK_PRIORITY_PLAN: PickPriorityPlan = Object.freeze({
  modifier: 0,
  name: null,
  color: null,
});

/** Reads the vendor's plan id from the acceptance stamp without trusting the payload's shape. */
export function readDropshipVendorPlanId(rawPayload: unknown): DropshipVendorPlanIdReading {
  if (!isRecord(rawPayload)) return { kind: "absent" };
  const stamp = rawPayload.dropship;
  if (!isRecord(stamp)) return { kind: "absent" };
  const value = stamp.vendorMembershipPlanId;
  if (value === undefined || value === null) return { kind: "absent" };
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > DROPSHIP_VENDOR_PLAN_ID_MAX_LENGTH
    || value.trim() !== value
  ) {
    return { kind: "invalid" };
  }
  return { kind: "present", planId: value };
}

export function decidePickPriorityPlanSource(input: {
  identity: DropshipOrderIdentity;
  rawPayload: unknown;
}): PickPriorityPlanSource {
  if (!isDropshipOmsOrder(input.identity)) return { kind: "customer_membership" };
  const reading = readDropshipVendorPlanId(input.rawPayload);
  return reading.kind === "present"
    ? { kind: "dropship_vendor_plan", planId: reading.planId }
    : { kind: "dropship_vendor_plan_unavailable", reason: reading.kind };
}

/**
 * Maps a membership.plans row to its pick-priority effect. Null when the row's
 * modifier is not an integer: such a row cannot be scored and must not be
 * guessed at.
 */
export function toPickPriorityPlan(row: {
  priority_modifier?: unknown;
  name?: unknown;
  primary_color?: unknown;
}): PickPriorityPlan | null {
  const modifier = readIntegerModifier(row.priority_modifier);
  if (modifier === null) return null;
  return {
    modifier,
    name: badgeText(row.name),
    color: badgeText(row.primary_color),
  };
}

function readIntegerModifier(value: unknown): number | null {
  // node-postgres returns int4 as a number; a numeric string is accepted for
  // drivers that return integers as text.
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^-?\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function badgeText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MEMBER_PLAN_BADGE_MAX_LENGTH
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
