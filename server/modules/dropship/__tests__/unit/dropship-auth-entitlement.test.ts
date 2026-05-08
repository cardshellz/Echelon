import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  evaluateSensitiveActionProof,
  evaluateDropshipMembershipEntitlement,
  normalizeCardShellzEmail,
  resolveSensitiveActionStepUp,
  type DropshipMembershipEntitlementInput,
} from "../../domain/auth";

const entitledInput: DropshipMembershipEntitlementInput = {
  memberId: "member-1",
  memberEmail: "Vendor@CardShellz.test",
  memberStatus: "active",
  subscriptionId: "subscription-1",
  subscriptionStatus: "active",
  billingStatus: "current",
  planId: "ops-plan",
  planName: ".ops",
  planIncludesDropship: true,
  planIsActive: true,
};
const now = new Date("2026-05-07T12:00:00.000Z");

describe("Card Shellz dropship identity policy", () => {
  it("normalizes the Card Shellz account email used for authorization", () => {
    expect(normalizeCardShellzEmail(" Vendor@CardShellz.TEST ")).toBe("vendor@cardshellz.test");
  });

  it("rejects invalid Card Shellz emails", () => {
    expect(() => normalizeCardShellzEmail("not-an-email")).toThrow(DropshipError);
  });

  it("uses passkey confirmation for sensitive actions when enrolled", () => {
    const method = resolveSensitiveActionStepUp(
      {
        memberId: "member-1",
        cardShellzEmail: "vendor@cardshellz.test",
        hasPasskey: true,
        authMethod: "passkey",
      },
      "add_funding_method",
    );

    expect(method).toBe("passkey");
  });

  it("uses email MFA for sensitive actions when no passkey exists", () => {
    const method = resolveSensitiveActionStepUp(
      {
        memberId: "member-1",
        cardShellzEmail: "vendor@cardshellz.test",
        hasPasskey: false,
        authMethod: "password",
      },
      "manage_catalog_selection",
    );

    expect(method).toBe("email_mfa");
  });

  it("accepts a fresh proof that matches the current sensitive-action method", () => {
    expect(evaluateSensitiveActionProof({
      principal: {
        memberId: "member-1",
        cardShellzEmail: "vendor@cardshellz.test",
        hasPasskey: false,
        authMethod: "password",
      },
      action: "add_funding_method",
      proof: {
        method: "email_mfa",
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      },
      now,
    })).toEqual({ valid: true });
  });

  it("rejects an email MFA proof when current account state requires passkey step-up", () => {
    expect(evaluateSensitiveActionProof({
      principal: {
        memberId: "member-1",
        cardShellzEmail: "vendor@cardshellz.test",
        hasPasskey: true,
        authMethod: "passkey",
      },
      action: "add_funding_method",
      proof: {
        method: "email_mfa",
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      },
      now,
    })).toEqual({
      valid: false,
      reason: "method_mismatch",
      requiredMethod: "passkey",
      proofMethod: "email_mfa",
    });
  });

  it("rejects expired or invalid sensitive-action proofs", () => {
    const principal = {
      memberId: "member-1",
      cardShellzEmail: "vendor@cardshellz.test",
      hasPasskey: false,
      authMethod: "password" as const,
    };

    expect(evaluateSensitiveActionProof({
      principal,
      action: "add_funding_method",
      proof: {
        method: "email_mfa",
        expiresAt: new Date(now.getTime() - 1),
      },
      now,
    })).toMatchObject({
      valid: false,
      reason: "missing_or_expired",
    });

    expect(evaluateSensitiveActionProof({
      principal,
      action: "add_funding_method",
      proof: {
        method: "email_mfa",
        expiresAt: "not-a-date",
      },
      now,
    })).toMatchObject({
      valid: false,
      reason: "missing_or_expired",
    });
  });
});

describe(".ops dropship entitlement evaluation", () => {
  it("grants active access only when subscription and dropship plan flag are active", () => {
    expect(evaluateDropshipMembershipEntitlement(entitledInput)).toMatchObject({
      memberId: "member-1",
      cardShellzEmail: "vendor@cardshellz.test",
      includesDropship: true,
      status: "active",
      reasonCode: "ENTITLED",
    });
  });

  it("puts past-due active subscriptions into grace", () => {
    expect(evaluateDropshipMembershipEntitlement({
      ...entitledInput,
      billingStatus: "past_due",
    })).toMatchObject({
      status: "grace",
      reasonCode: "BILLING_PAST_DUE_GRACE",
    });
  });

  it("blocks plans that are not dropship enabled", () => {
    expect(evaluateDropshipMembershipEntitlement({
      ...entitledInput,
      planIncludesDropship: false,
    })).toMatchObject({
      includesDropship: false,
      status: "not_entitled",
      reasonCode: "PLAN_NOT_DROPSHIP_ENABLED",
    });
  });

  it("suspends paused subscriptions and suspended members", () => {
    expect(evaluateDropshipMembershipEntitlement({
      ...entitledInput,
      subscriptionStatus: "paused",
      billingStatus: "paused",
    })).toMatchObject({
      status: "suspended",
      reasonCode: "SUBSCRIPTION_PAUSED",
    });

    expect(evaluateDropshipMembershipEntitlement({
      ...entitledInput,
      memberStatus: "suspended",
    })).toMatchObject({
      status: "suspended",
      reasonCode: "MEMBER_SUSPENDED",
    });
  });

  it("marks missing or inactive subscriptions as lapsed", () => {
    expect(evaluateDropshipMembershipEntitlement({
      ...entitledInput,
      subscriptionId: null,
      subscriptionStatus: null,
      billingStatus: null,
    })).toMatchObject({
      status: "lapsed",
      reasonCode: "NO_ACTIVE_SUBSCRIPTION",
    });

    expect(evaluateDropshipMembershipEntitlement({
      ...entitledInput,
      subscriptionStatus: "cancelled",
      billingStatus: "cancelled",
    })).toMatchObject({
      status: "lapsed",
      reasonCode: "SUBSCRIPTION_NOT_ACTIVE",
    });
  });
});
