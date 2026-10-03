/**
 * The one place Echelon answers "which Card Shellz member is this, and what
 * plan are they on". Every caller (pick priority, order screens, the saved
 * member tier, dropship access) is meant to come through here.
 *
 * Rules mirror the membership app, which owns members:
 * - member by Shopify customer id: members.shopify_customer_id first, then the
 *   alias table that survives Shopify customer merges (getMemberByShopifyId);
 * - current plan: the membership.member_current_membership view, the app's
 *   published definition (newest subscription that is active, pending
 *   downgrade or pending cancellation).
 */

import type { MemberKey } from "../domain/member-key";
import {
  decideMemberMatch,
  toMemberPlan,
  type MemberMatchSource,
  type MemberResolution,
  type PlanRow,
} from "../domain/member-resolution";
import { shopifyCustomerIdCandidates } from "../domain/shopify-customer-id";

export interface CurrentMembershipRow {
  subscriptionId: string;
  planId: string | null;
  status: string;
}

/** Read port onto the membership data; the Postgres adapter implements it. */
export interface MemberDirectory {
  findMemberIdsByShopifyCustomerIds(candidates: readonly string[]): Promise<string[]>;
  findMemberIdsByShopifyCustomerIdAliases(candidates: readonly string[]): Promise<string[]>;
  memberExists(memberId: string): Promise<boolean>;
  /** At most one row per member: the view is DISTINCT ON member_id. */
  findCurrentMemberships(memberId: string): Promise<CurrentMembershipRow[]>;
  findPlan(planId: string): Promise<PlanRow | null>;
}

export type MembershipResolverErrorCode =
  | "MEMBERSHIP_LOOKUP_FAILED"
  | "MEMBERSHIP_CURRENT_MEMBERSHIP_NOT_UNIQUE";

export class MembershipResolverError extends Error {
  constructor(
    readonly code: MembershipResolverErrorCode,
    message: string,
    readonly classification: "transient" | "permanent",
    readonly context: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "MembershipResolverError";
  }
}

export class MemberResolver {
  constructor(private readonly directory: MemberDirectory) {}

  /**
   * @throws MembershipResolverError — transient when the directory cannot be
   *   read, permanent when the membership data breaks the one-current-plan rule.
   */
  async resolve(key: MemberKey): Promise<MemberResolution> {
    if (key.kind === "none") return { outcome: "not_applicable", reason: key.reason };
    try {
      const match = key.kind === "member"
        ? await this.matchMemberId(key.memberId)
        : await this.matchShopifyCustomerId(key.shopifyCustomerId);
      if (match.kind === "none") return { outcome: "no_member" };
      if (match.kind === "ambiguous") return { outcome: "ambiguous_member", memberIds: match.memberIds };
      return await this.currentPlanFor(match.memberId, match.matchedBy);
    } catch (error) {
      if (error instanceof MembershipResolverError) throw error;
      throw new MembershipResolverError(
        "MEMBERSHIP_LOOKUP_FAILED",
        "The membership data could not be read.",
        "transient",
        { keyKind: key.kind, cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async matchMemberId(memberId: string): Promise<MatchResult> {
    return (await this.directory.memberExists(memberId))
      ? { kind: "one", memberId, matchedBy: "member_id" }
      : { kind: "none" };
  }

  private async matchShopifyCustomerId(shopifyCustomerId: string): Promise<MatchResult> {
    const candidates = shopifyCustomerIdCandidates(shopifyCustomerId);
    const direct = decideMemberMatch(await this.directory.findMemberIdsByShopifyCustomerIds(candidates));
    if (direct.kind === "one") return { ...direct, matchedBy: "shopify_customer_id" };
    if (direct.kind === "ambiguous") return direct;
    const alias = decideMemberMatch(await this.directory.findMemberIdsByShopifyCustomerIdAliases(candidates));
    if (alias.kind === "one") return { ...alias, matchedBy: "shopify_customer_id_alias" };
    return alias;
  }

  private async currentPlanFor(memberId: string, matchedBy: MemberMatchSource): Promise<MemberResolution> {
    const memberships = await this.directory.findCurrentMemberships(memberId);
    if (memberships.length > 1) {
      throw new MembershipResolverError(
        "MEMBERSHIP_CURRENT_MEMBERSHIP_NOT_UNIQUE",
        "The membership view returned more than one current membership for a member.",
        "permanent",
        { memberId, rows: memberships.length },
      );
    }
    const membership = memberships[0];
    if (!membership || membership.planId === null) {
      return { outcome: "member_without_plan", memberId, matchedBy };
    }
    const planRow = await this.directory.findPlan(membership.planId);
    if (!planRow) return { outcome: "plan_not_found", memberId, matchedBy, planId: membership.planId };
    const plan = toMemberPlan(planRow);
    if (!plan) return { outcome: "plan_invalid", memberId, matchedBy, planId: membership.planId };
    return {
      outcome: "member",
      memberId,
      matchedBy,
      subscriptionId: membership.subscriptionId,
      subscriptionStatus: membership.status,
      plan,
    };
  }
}

type MatchResult =
  | { kind: "one"; memberId: string; matchedBy: MemberMatchSource }
  | { kind: "none" }
  | { kind: "ambiguous"; memberIds: readonly string[] };
