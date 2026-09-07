import { describe, expect, it } from "vitest";
import type { PurchaseApprovalActor } from "../../../identity/domain/purchase-approval-authority";
import {
  assertUniqueHighestApprovalTier,
  buildPurchaseApprovalSnapshot,
  purchaseApprovalSnapshotCovers,
} from "../../purchase-order-approval.policy";

const actor = (overrides: Partial<PurchaseApprovalActor> = {}): PurchaseApprovalActor => ({
  userId: "approver", active: true, roles: [{ id: 3, name: "Team Lead", isSystem: true }],
  approvalGrantIds: [7], hasScopedApprovalGrant: false, ...overrides,
});
const tier = { id: 2, thresholdCents: 10000, approverRole: "lead" };
const approve = (user = actor(), changes: Record<string, unknown> = {}) => buildPurchaseApprovalSnapshot({
  actor: user, requireApproval: true, tier, totalCents: 20000, ...changes,
});

describe("purchase approval authority policy", () => {
  it("freezes exact trusted role, permission, amount and policy evidence without mutating inputs", () => {
    const user = actor();
    const before = structuredClone(user);
    const snapshot = approve(user);
    expect(snapshot).toEqual({ contractVersion: 1, requireApproval: true, tier, totalCents: 20000, actor: before, matchedRoleId: 3 });
    user.roles[0].name = "Changed later";
    user.approvalGrantIds.push(9);
    expect(snapshot.actor).toEqual(before);
    expect(tier).toEqual({ id: 2, thresholdCents: 10000, approverRole: "lead" });
  });

  it.each([
    [actor({ active: false }), "PO_APPROVAL_ACTOR_INACTIVE"],
    [actor({ approvalGrantIds: [] }), "PO_APPROVAL_PERMISSION_REQUIRED"],
    [actor({ approvalGrantIds: [], hasScopedApprovalGrant: true }), "PO_APPROVAL_SCOPE_UNSUPPORTED"],
    [actor({ roles: [] }), "PO_APPROVAL_ROLE_REQUIRED"],
    [actor({ roles: [{ id: 1, name: "Administrator", isSystem: true }] }), "PO_APPROVAL_ROLE_REQUIRED"],
    [actor({ roles: [{ id: 3, name: "Team Lead", isSystem: false }] }), "PO_APPROVAL_ROLE_REQUIRED"],
  ])("rejects authority that cannot satisfy the configured role and grant", (user, code) => {
    expect(() => approve(user)).toThrow(expect.objectContaining({ statusCode: 403, details: expect.objectContaining({ code }) }));
  });

  it("permits an explicit unrestricted grant alongside a restricted one", () => {
    expect(approve(actor({ hasScopedApprovalGrant: true })).matchedRoleId).toBe(3);
  });

  it("supports an exact named custom role without inventing a hierarchy or case folding", () => {
    const user = actor({ roles: [{ id: 12, name: "Purchasing Director", isSystem: false }] });
    expect(approve(user, { tier: { ...tier, approverRole: "Purchasing Director" } }).matchedRoleId).toBe(12);
    expect(() => approve(user, { tier: { ...tier, approverRole: "purchasing director" } })).toThrow(/approver role/);
  });

  it("keeps manual approval permission but ignores tier roles when approval controls are off", () => {
    expect(approve(actor({ roles: [] }), { requireApproval: false })).toMatchObject({ tier: null, matchedRoleId: null, requireApproval: false });
    expect(() => approve(actor({ approvalGrantIds: [] }), { requireApproval: false })).toThrow(/permission/);
  });

  it.each([0, Number.MAX_SAFE_INTEGER])("retains exact integer cents at %s", (totalCents) => {
    expect(approve(actor(), { totalCents }).totalCents).toBe(totalCents);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])("classifies invalid amounts %s", (totalCents) => {
    expect(() => approve(actor(), { totalCents })).toThrow(expect.objectContaining({ statusCode: 409, details: { code: "PO_APPROVAL_POLICY_INVALID" } }));
  });

  it("classifies malformed tier or actor evidence", () => {
    expect(() => approve(actor(), { tier: { ...tier, approverRole: "" } })).toThrow(expect.objectContaining({ details: { code: "PO_APPROVAL_POLICY_INVALID" } }));
    expect(() => approve(actor({ roles: [{ id: 0, name: "Team Lead", isSystem: true }] }))).toThrow(expect.objectContaining({ details: { code: "PO_APPROVAL_AUTHORITY_INVALID" } }));
  });

  it("rejects equal highest thresholds even if the roles match and permits distinct thresholds", () => {
    for (const approverRole of ["admin", "lead"]) {
      expect(() => assertUniqueHighestApprovalTier([tier, { ...tier, id: 3, approverRole }]))
        .toThrow(expect.objectContaining({ statusCode: 409, details: { code: "PO_APPROVAL_TIER_AMBIGUOUS", tierIds: [2, 3], thresholdCents: 10000 } }));
    }
    expect(() => assertUniqueHighestApprovalTier([tier, { ...tier, id: 3, thresholdCents: 9999 }])).not.toThrow();
    expect(() => assertUniqueHighestApprovalTier([tier, { ...tier, id: -1 }])).toThrow(expect.objectContaining({ details: { code: "PO_APPROVAL_POLICY_INVALID" } }));
  });

  it("accepts only a matching frozen approval for sending", () => {
    const snapshot = approve();
    expect(purchaseApprovalSnapshotCovers({ snapshot, tier, totalCents: 20000, approvedBy: "approver" })).toBe(true);
    for (const changes of [
      { snapshot: null }, { approvedBy: null }, { approvedBy: "someone-else" }, { totalCents: 20001 },
      { tier: { ...tier, approverRole: "admin" } }, { tier: { ...tier, thresholdCents: 9999 } }, { tier: { ...tier, id: 99 } },
      { snapshot: { ...snapshot, matchedRoleId: 99 } }, { snapshot: { ...snapshot, requireApproval: false } },
      { snapshot: { ...snapshot, actor: { ...snapshot.actor, active: false } } },
      { snapshot: { ...snapshot, actor: { ...snapshot.actor, approvalGrantIds: [] } } },
    ]) {
      expect(purchaseApprovalSnapshotCovers({ snapshot, tier, totalCents: 20000, approvedBy: "approver", ...changes })).toBe(false);
    }
  });
});