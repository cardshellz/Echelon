/**
 * Shared member resolver, plan step 2: a dry run beside the pick score.
 *
 * For each new WMS order scored from the customer's membership, the shared
 * resolver (server/modules/membership) runs next to today's lookup (email or
 * Shopify id, then the plan-name tier saved on the order). Its answer changes
 * nothing: the pick score still comes from today's lookup. The comparison is
 * kept on the new WMS order as metadata.memberResolverDryRun, so the owner can
 * query how often the two agree before the score switches over (plan step 3).
 * Pure.
 */

import type { MemberKey, MemberResolution } from "../membership";

export const MEMBER_RESOLVER_DRY_RUN_METADATA_KEY = "memberResolverDryRun";
export const MEMBER_RESOLVER_DRY_RUN_VERSION = 1;

export type LegacyMemberMatchSource =
  | "email"
  | "shopify_customer_id"
  | "email_and_shopify_customer_id"
  /** Found no member; matched the plan by the name saved in oms_orders.member_tier. */
  | "member_tier"
  /** A row matched but neither flag was set; should not happen, kept visible rather than guessed. */
  | "unknown";

export type LegacyMemberMatch =
  | {
    outcome: "member";
    memberId: string | null;
    planId: string | null;
    modifier: number;
    matchedBy: LegacyMemberMatchSource;
  }
  | { outcome: "no_member" }
  | { outcome: "lookup_failed" };

export type DryRunResolverResult =
  | { kind: "resolved"; resolution: MemberResolution }
  | { kind: "failed"; errorCode: string };

/** A type alias, not an interface: it must fit the WMS order's JSON metadata column. */
export type MemberResolverDryRunRecord = {
  version: typeof MEMBER_RESOLVER_DRY_RUN_VERSION;
  channelId: number | null;
  channelProvider: string | null;
  key: { kind: MemberKey["kind"]; reason: string | null };
  legacy: {
    outcome: LegacyMemberMatch["outcome"];
    memberId: string | null;
    planId: string | null;
    modifier: number | null;
    matchedBy: LegacyMemberMatchSource | null;
  };
  resolver: {
    outcome: MemberResolution["outcome"] | "resolver_failed";
    memberId: string | null;
    planId: string | null;
    modifier: number | null;
    matchedBy: string | null;
    errorCode: string | null;
  };
  /** Same plan (or both none). Null when either side failed and nothing can be compared. */
  agrees: boolean | null;
  /** Resolver modifier minus today's modifier: how the score would move. Null when either side failed. */
  modifierDelta: number | null;
};

export function legacyMatchSource(flags: {
  matchedByEmail: boolean;
  matchedByShopifyCustomerId: boolean;
}): LegacyMemberMatchSource {
  if (flags.matchedByEmail && flags.matchedByShopifyCustomerId) return "email_and_shopify_customer_id";
  if (flags.matchedByEmail) return "email";
  if (flags.matchedByShopifyCustomerId) return "shopify_customer_id";
  return "unknown";
}

export function buildMemberResolverDryRunRecord(input: {
  channelId: number | null;
  channelProvider: string | null;
  key: MemberKey;
  legacy: LegacyMemberMatch;
  resolver: DryRunResolverResult;
}): MemberResolverDryRunRecord {
  const legacy = summarizeLegacy(input.legacy);
  const resolver = summarizeResolver(input.resolver);
  const comparable = input.legacy.outcome !== "lookup_failed" && input.resolver.kind === "resolved";
  return {
    version: MEMBER_RESOLVER_DRY_RUN_VERSION,
    channelId: input.channelId,
    channelProvider: input.channelProvider,
    key: { kind: input.key.kind, reason: input.key.kind === "none" ? input.key.reason : null },
    legacy,
    resolver,
    agrees: comparable ? legacy.planId === resolver.planId : null,
    modifierDelta: comparable ? (resolver.modifier ?? 0) - (legacy.modifier ?? 0) : null,
  };
}

function summarizeLegacy(legacy: LegacyMemberMatch): MemberResolverDryRunRecord["legacy"] {
  if (legacy.outcome === "member") {
    return {
      outcome: "member",
      memberId: legacy.memberId,
      planId: legacy.planId,
      modifier: legacy.modifier,
      matchedBy: legacy.matchedBy,
    };
  }
  return {
    outcome: legacy.outcome,
    memberId: null,
    planId: null,
    // No member scores as modifier 0 today; a failed lookup has no comparable value.
    modifier: legacy.outcome === "no_member" ? 0 : null,
    matchedBy: null,
  };
}

function summarizeResolver(result: DryRunResolverResult): MemberResolverDryRunRecord["resolver"] {
  if (result.kind === "failed") {
    return {
      outcome: "resolver_failed",
      memberId: null,
      planId: null,
      modifier: null,
      matchedBy: null,
      errorCode: result.errorCode,
    };
  }
  const resolution = result.resolution;
  switch (resolution.outcome) {
    case "member":
      return {
        outcome: "member",
        memberId: resolution.memberId,
        planId: resolution.plan.planId,
        modifier: resolution.plan.priorityModifier,
        matchedBy: resolution.matchedBy,
        errorCode: null,
      };
    case "member_without_plan":
    case "plan_not_found":
    case "plan_invalid":
      return {
        outcome: resolution.outcome,
        memberId: resolution.memberId,
        planId: null,
        modifier: 0,
        matchedBy: resolution.matchedBy,
        errorCode: null,
      };
    default:
      return {
        outcome: resolution.outcome,
        memberId: null,
        planId: null,
        modifier: 0,
        matchedBy: null,
        errorCode: null,
      };
  }
}
