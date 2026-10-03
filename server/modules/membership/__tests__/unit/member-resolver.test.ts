import { describe, expect, it, vi } from "vitest";
import {
  MemberResolver,
  MembershipResolverError,
  type CurrentMembershipRow,
  type MemberDirectory,
} from "../../application/member-resolver";
import type { PlanRow } from "../../domain/member-resolution";

const CUSTOMER_ID = "23325275357343";
const CUSTOMER_GID = `gid://shopify/Customer/${CUSTOMER_ID}`;
const CLUB_PLAN_ID = "5f966934-9ff2-4966-9e8f-d4292ca3290e";
const CLUB_PLAN_ROW: PlanRow = { plan_id: CLUB_PLAN_ID, name: ".club", primary_color: "#2E86DE", priority_modifier: 50 };
const ACTIVE_CLUB: CurrentMembershipRow = { subscriptionId: "sub-1", planId: CLUB_PLAN_ID, status: "active" };

interface DirectoryFacts {
  direct?: string[];
  alias?: string[];
  existing?: string[];
  memberships?: CurrentMembershipRow[];
  plan?: PlanRow | null;
}

function fakeDirectory(facts: DirectoryFacts = {}) {
  const directory = {
    findMemberIdsByShopifyCustomerIds: vi.fn(async (_candidates: readonly string[]) => facts.direct ?? []),
    findMemberIdsByShopifyCustomerIdAliases: vi.fn(async (_candidates: readonly string[]) => facts.alias ?? []),
    memberExists: vi.fn(async (memberId: string) => (facts.existing ?? []).includes(memberId)),
    findCurrentMemberships: vi.fn(async (_memberId: string) => facts.memberships ?? [ACTIVE_CLUB]),
    findPlan: vi.fn(async (_planId: string) => (facts.plan === undefined ? CLUB_PLAN_ROW : facts.plan)),
  } satisfies MemberDirectory;
  return directory;
}

const shopifyKey = { kind: "shopify_customer", shopifyCustomerId: CUSTOMER_ID } as const;

async function resolutionError(promise: Promise<unknown>): Promise<MembershipResolverError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(MembershipResolverError);
  return error as MembershipResolverError;
}

describe("MemberResolver", () => {
  it("answers an order with no member key without reading anything", async () => {
    const directory = fakeDirectory();
    const resolution = await new MemberResolver(directory).resolve({ kind: "none", reason: "channel_without_membership" });

    expect(resolution).toEqual({ outcome: "not_applicable", reason: "channel_without_membership" });
    for (const read of Object.values(directory)) expect(read).not.toHaveBeenCalled();
  });

  it("finds a member by Shopify customer id in both stored forms and returns the current plan", async () => {
    const directory = fakeDirectory({ direct: ["member-1"] });

    const resolution = await new MemberResolver(directory).resolve(shopifyKey);

    expect(resolution).toEqual({
      outcome: "member",
      memberId: "member-1",
      matchedBy: "shopify_customer_id",
      subscriptionId: "sub-1",
      subscriptionStatus: "active",
      plan: { planId: CLUB_PLAN_ID, name: ".club", color: "#2E86DE", priorityModifier: 50 },
    });
    expect(directory.findMemberIdsByShopifyCustomerIds).toHaveBeenCalledWith([CUSTOMER_ID, CUSTOMER_GID]);
    expect(directory.findMemberIdsByShopifyCustomerIdAliases).not.toHaveBeenCalled();
    expect(directory.findCurrentMemberships).toHaveBeenCalledWith("member-1");
    expect(directory.findPlan).toHaveBeenCalledWith(CLUB_PLAN_ID);
  });

  it("falls back to the alias table that survives Shopify customer merges", async () => {
    const directory = fakeDirectory({ alias: ["member-merged"] });

    const resolution = await new MemberResolver(directory).resolve(shopifyKey);

    expect(resolution).toMatchObject({ outcome: "member", memberId: "member-merged", matchedBy: "shopify_customer_id_alias" });
    expect(directory.findMemberIdsByShopifyCustomerIdAliases).toHaveBeenCalledWith([CUSTOMER_ID, CUSTOMER_GID]);
  });

  it("never guesses between two members holding the id's two forms", async () => {
    const directory = fakeDirectory({ direct: ["member-b", "member-a"] });

    const resolution = await new MemberResolver(directory).resolve(shopifyKey);

    expect(resolution).toEqual({ outcome: "ambiguous_member", memberIds: ["member-a", "member-b"] });
    expect(directory.findMemberIdsByShopifyCustomerIdAliases).not.toHaveBeenCalled();
    expect(directory.findCurrentMemberships).not.toHaveBeenCalled();
  });

  it("reports an alias held by two members as ambiguous", async () => {
    const resolution = await new MemberResolver(fakeDirectory({ alias: ["member-b", "member-a"] })).resolve(shopifyKey);

    expect(resolution).toEqual({ outcome: "ambiguous_member", memberIds: ["member-a", "member-b"] });
  });

  it("finds no member when neither the id nor an alias matches", async () => {
    const directory = fakeDirectory();

    expect(await new MemberResolver(directory).resolve(shopifyKey)).toEqual({ outcome: "no_member" });
    expect(directory.findCurrentMemberships).not.toHaveBeenCalled();
  });

  it("finds a member by member id", async () => {
    const directory = fakeDirectory({ existing: ["vendor-member"] });

    const resolution = await new MemberResolver(directory).resolve({ kind: "member", memberId: "vendor-member" });

    expect(resolution).toMatchObject({ outcome: "member", memberId: "vendor-member", matchedBy: "member_id" });
    expect(directory.findMemberIdsByShopifyCustomerIds).not.toHaveBeenCalled();
  });

  it("finds no member for an unknown member id", async () => {
    expect(await new MemberResolver(fakeDirectory()).resolve({ kind: "member", memberId: "gone" }))
      .toEqual({ outcome: "no_member" });
  });

  it("reports a member with no current subscription", async () => {
    const directory = fakeDirectory({ direct: ["member-1"], memberships: [] });

    expect(await new MemberResolver(directory).resolve(shopifyKey))
      .toEqual({ outcome: "member_without_plan", memberId: "member-1", matchedBy: "shopify_customer_id" });
    expect(directory.findPlan).not.toHaveBeenCalled();
  });

  it("reports a current subscription without a plan as no plan", async () => {
    const directory = fakeDirectory({ direct: ["member-1"], memberships: [{ ...ACTIVE_CLUB, planId: null }] });

    expect(await new MemberResolver(directory).resolve(shopifyKey))
      .toEqual({ outcome: "member_without_plan", memberId: "member-1", matchedBy: "shopify_customer_id" });
  });

  it("keeps the pending statuses the membership app counts as current", async () => {
    for (const status of ["pending_downgrade", "pending_cancellation"]) {
      const directory = fakeDirectory({ direct: ["member-1"], memberships: [{ ...ACTIVE_CLUB, status }] });
      expect(await new MemberResolver(directory).resolve(shopifyKey))
        .toMatchObject({ outcome: "member", subscriptionStatus: status });
    }
  });

  it("reports a subscription whose plan no longer exists", async () => {
    const directory = fakeDirectory({ direct: ["member-1"], plan: null });

    expect(await new MemberResolver(directory).resolve(shopifyKey)).toEqual({
      outcome: "plan_not_found",
      memberId: "member-1",
      matchedBy: "shopify_customer_id",
      planId: CLUB_PLAN_ID,
    });
  });

  it("reports a plan that cannot be scored", async () => {
    const directory = fakeDirectory({ direct: ["member-1"], plan: { ...CLUB_PLAN_ROW, priority_modifier: "high" } });

    expect(await new MemberResolver(directory).resolve(shopifyKey)).toEqual({
      outcome: "plan_invalid",
      memberId: "member-1",
      matchedBy: "shopify_customer_id",
      planId: CLUB_PLAN_ID,
    });
  });

  it("refuses to pick when the view breaks its one-row-per-member rule (permanent)", async () => {
    const directory = fakeDirectory({
      direct: ["member-1"],
      memberships: [ACTIVE_CLUB, { subscriptionId: "sub-2", planId: "other", status: "active" }],
    });

    const error = await resolutionError(new MemberResolver(directory).resolve(shopifyKey));

    expect(error.code).toBe("MEMBERSHIP_CURRENT_MEMBERSHIP_NOT_UNIQUE");
    expect(error.classification).toBe("permanent");
    expect(error.context).toEqual({ memberId: "member-1", rows: 2 });
    expect(directory.findPlan).not.toHaveBeenCalled();
  });

  it("classifies an unreadable directory as transient and keeps the cause", async () => {
    const directory = fakeDirectory();
    directory.findMemberIdsByShopifyCustomerIds.mockRejectedValueOnce(new Error("connection terminated"));

    const error = await resolutionError(new MemberResolver(directory).resolve(shopifyKey));

    expect(error.code).toBe("MEMBERSHIP_LOOKUP_FAILED");
    expect(error.classification).toBe("transient");
    expect(error.context).toEqual({ keyKind: "shopify_customer", cause: "connection terminated" });
  });

  it("keeps a non-Error failure readable", async () => {
    const directory = fakeDirectory({ direct: ["member-1"] });
    directory.findPlan.mockRejectedValueOnce("plans relation missing");

    const error = await resolutionError(new MemberResolver(directory).resolve(shopifyKey));

    expect(error.context).toEqual({ keyKind: "shopify_customer", cause: "plans relation missing" });
  });
});
