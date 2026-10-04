/**
 * The outcome of resolving a member and their current plan, and the rules that
 * turn loaded rows into it. Pure: the application layer loads every fact.
 */

import type { MemberKeyAbsenceReason } from "./member-key";

/** How the member was found. */
export type MemberMatchSource =
  | "member_id"
  | "shopify_customer_id"
  /** membership.member_shopify_customer_ids, which survives Shopify customer merges. */
  | "shopify_customer_id_alias";

export interface MemberPlan {
  planId: string;
  name: string | null;
  color: string | null;
  /** membership.plans.priority_modifier: added to the shipping base in the pick score. */
  priorityModifier: number;
}

export type MemberResolution =
  | {
    outcome: "member";
    memberId: string;
    matchedBy: MemberMatchSource;
    subscriptionId: string;
    subscriptionStatus: string;
    plan: MemberPlan;
  }
  /** A member with no current subscription (none active, pending downgrade or pending cancellation). */
  | { outcome: "member_without_plan"; memberId: string; matchedBy: MemberMatchSource }
  /** The current subscription names a plan that does not exist. */
  | { outcome: "plan_not_found"; memberId: string; matchedBy: MemberMatchSource; planId: string }
  /** The plan exists but cannot be scored (its modifier is not an integer). */
  | { outcome: "plan_invalid"; memberId: string; matchedBy: MemberMatchSource; planId: string }
  | { outcome: "no_member" }
  /** More than one member carries the id. Never guessed between. */
  | { outcome: "ambiguous_member"; memberIds: readonly string[] }
  | { outcome: "not_applicable"; reason: MemberKeyAbsenceReason };

export interface PlanRow {
  plan_id: unknown;
  name: unknown;
  primary_color: unknown;
  priority_modifier: unknown;
}

/** Null when the row cannot be scored: a missing id or a non-integer modifier. */
export function toMemberPlan(row: PlanRow): MemberPlan | null {
  const planId = typeof row.plan_id === "string" && row.plan_id.length > 0 ? row.plan_id : null;
  const priorityModifier = readIntegerModifier(row.priority_modifier);
  if (planId === null || priorityModifier === null) return null;
  return {
    planId,
    name: nonEmptyString(row.name),
    color: nonEmptyString(row.primary_color),
    priorityModifier,
  };
}

/**
 * One member, none, or ambiguous. Ids are de-duplicated first: a member found
 * under both of its stored id forms is still one member.
 */
export function decideMemberMatch(
  memberIds: readonly string[],
): { kind: "one"; memberId: string } | { kind: "none" } | { kind: "ambiguous"; memberIds: readonly string[] } {
  const distinct = [...new Set(memberIds)].sort();
  if (distinct.length === 0) return { kind: "none" };
  if (distinct.length === 1) return { kind: "one", memberId: distinct[0] };
  return { kind: "ambiguous", memberIds: distinct };
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
