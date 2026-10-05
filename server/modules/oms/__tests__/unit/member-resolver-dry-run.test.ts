import { describe, expect, it } from "vitest";
import {
  buildMemberResolverDryRunRecord,
  legacyMatchSource,
  MEMBER_RESOLVER_DRY_RUN_VERSION,
  type DryRunResolverResult,
  type LegacyMemberMatch,
} from "../../member-resolver-dry-run";
import type { MemberKey, MemberResolution } from "../../../membership";

const CLUB_PLAN_ID = "5f966934-9ff2-4966-9e8f-d4292ca3290e";
const OPS_PLAN_ID = "14d8698f-09d8-4dea-8089-fa9a1ec0fb28";
const SHOPIFY_CUSTOMER_ID = "23325275357343";
const SHOPIFY_KEY: MemberKey = { kind: "shopify_customer", shopifyCustomerId: SHOPIFY_CUSTOMER_ID };
const EBAY_KEY: MemberKey = { kind: "none", reason: "channel_without_membership" };

const LEGACY_CLUB: LegacyMemberMatch = {
  outcome: "member",
  memberId: "member-1",
  planId: CLUB_PLAN_ID,
  modifier: 50,
  matchedBy: "email",
};

function resolved(resolution: MemberResolution): DryRunResolverResult {
  return { kind: "resolved", resolution };
}

const RESOLVED_CLUB = resolved({
  outcome: "member",
  memberId: "member-1",
  matchedBy: "shopify_customer_id",
  subscriptionId: "sub-1",
  subscriptionStatus: "active",
  plan: { planId: CLUB_PLAN_ID, name: ".club", color: "#2E86DE", priorityModifier: 50 },
});

function record(input: { key?: MemberKey; legacy: LegacyMemberMatch; resolver: DryRunResolverResult; provider?: string | null }) {
  return buildMemberResolverDryRunRecord({
    channelId: 36,
    channelProvider: input.provider === undefined ? "shopify" : input.provider,
    key: input.key ?? SHOPIFY_KEY,
    legacy: input.legacy,
    resolver: input.resolver,
  });
}

describe("legacyMatchSource", () => {
  it("names which of today's two conditions matched", () => {
    expect(legacyMatchSource({ matchedByEmail: true, matchedByShopifyCustomerId: true })).toBe("email_and_shopify_customer_id");
    expect(legacyMatchSource({ matchedByEmail: true, matchedByShopifyCustomerId: false })).toBe("email");
    expect(legacyMatchSource({ matchedByEmail: false, matchedByShopifyCustomerId: true })).toBe("shopify_customer_id");
    expect(legacyMatchSource({ matchedByEmail: false, matchedByShopifyCustomerId: false })).toBe("unknown");
  });
});

describe("buildMemberResolverDryRunRecord", () => {
  it("records agreement when both lookups land on the same plan", () => {
    expect(record({ legacy: LEGACY_CLUB, resolver: RESOLVED_CLUB })).toEqual({
      version: MEMBER_RESOLVER_DRY_RUN_VERSION,
      channelId: 36,
      channelProvider: "shopify",
      key: { kind: "shopify_customer", reason: null },
      legacy: { outcome: "member", memberId: "member-1", planId: CLUB_PLAN_ID, modifier: 50, matchedBy: "email" },
      resolver: {
        outcome: "member",
        memberId: "member-1",
        planId: CLUB_PLAN_ID,
        modifier: 50,
        matchedBy: "shopify_customer_id",
        errorCode: null,
      },
      agrees: true,
      modifierDelta: 0,
    });
  });

  it("records the eBay buyer whose email matches a member: today scores the plan, the resolver does not", () => {
    const result = record({
      key: EBAY_KEY,
      provider: "ebay",
      legacy: LEGACY_CLUB,
      resolver: resolved({ outcome: "not_applicable", reason: "channel_without_membership" }),
    });

    expect(result).toMatchObject({
      channelProvider: "ebay",
      key: { kind: "none", reason: "channel_without_membership" },
      resolver: { outcome: "not_applicable", planId: null, modifier: 0, memberId: null },
      agrees: false,
      modifierDelta: -50,
    });
  });

  it("records a member today misses, and how far the score would move", () => {
    const result = record({
      legacy: { outcome: "no_member" },
      resolver: resolved({
        outcome: "member",
        memberId: "member-ops",
        matchedBy: "shopify_customer_id_alias",
        subscriptionId: "sub-ops",
        subscriptionStatus: "active",
        plan: { planId: OPS_PLAN_ID, name: ".ops", color: null, priorityModifier: 100 },
      }),
    });

    expect(result).toMatchObject({
      legacy: { outcome: "no_member", modifier: 0, planId: null },
      resolver: { outcome: "member", planId: OPS_PLAN_ID, modifier: 100, matchedBy: "shopify_customer_id_alias" },
      agrees: false,
      modifierDelta: 100,
    });
  });

  it("counts two answers of no plan as agreement", () => {
    expect(record({ legacy: { outcome: "no_member" }, resolver: resolved({ outcome: "no_member" }) }))
      .toMatchObject({ agrees: true, modifierDelta: 0 });
  });

  it("compares nothing when today's lookup failed", () => {
    expect(record({ legacy: { outcome: "lookup_failed" }, resolver: RESOLVED_CLUB })).toMatchObject({
      legacy: { outcome: "lookup_failed", modifier: null, planId: null },
      agrees: null,
      modifierDelta: null,
    });
  });

  it("compares nothing when the resolver failed, and keeps its error code", () => {
    expect(record({ legacy: LEGACY_CLUB, resolver: { kind: "failed", errorCode: "MEMBERSHIP_LOOKUP_FAILED" } })).toMatchObject({
      resolver: {
        outcome: "resolver_failed",
        memberId: null,
        planId: null,
        modifier: null,
        matchedBy: null,
        errorCode: "MEMBERSHIP_LOOKUP_FAILED",
      },
      agrees: null,
      modifierDelta: null,
    });
  });

  it("keeps the member found when it has no scorable plan", () => {
    const outcomes: MemberResolution[] = [
      { outcome: "member_without_plan", memberId: "member-1", matchedBy: "shopify_customer_id" },
      { outcome: "plan_not_found", memberId: "member-1", matchedBy: "shopify_customer_id", planId: "gone" },
      { outcome: "plan_invalid", memberId: "member-1", matchedBy: "shopify_customer_id", planId: "bad" },
    ];
    for (const resolution of outcomes) {
      expect(record({ legacy: LEGACY_CLUB, resolver: resolved(resolution) })).toMatchObject({
        resolver: { outcome: resolution.outcome, memberId: "member-1", planId: null, modifier: 0, matchedBy: "shopify_customer_id" },
        agrees: false,
        modifierDelta: -50,
      });
    }
  });

  it("records an ambiguous match without picking a member", () => {
    expect(record({
      legacy: { outcome: "no_member" },
      resolver: resolved({ outcome: "ambiguous_member", memberIds: ["member-a", "member-b"] }),
    })).toMatchObject({
      resolver: { outcome: "ambiguous_member", memberId: null, planId: null, modifier: 0 },
      agrees: true,
    });
  });

  it("records the order's no-customer-id reason", () => {
    expect(record({
      key: { kind: "none", reason: "no_customer_id" },
      legacy: LEGACY_CLUB,
      resolver: resolved({ outcome: "not_applicable", reason: "no_customer_id" }),
    }).key).toEqual({ kind: "none", reason: "no_customer_id" });
  });

  it("fits a JSON column unchanged and never stores the customer's id or email", () => {
    const result = record({ legacy: LEGACY_CLUB, resolver: RESOLVED_CLUB });
    const json = JSON.stringify(result);

    expect(JSON.parse(json)).toEqual(result);
    expect(json).not.toContain(SHOPIFY_CUSTOMER_ID);
    expect(json).not.toContain("@");
  });
});
