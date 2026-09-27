import { describe, expect, it } from "vitest";
import {
  CUSTOMER_RETURN_PORTAL_POLICY_REQUIREMENTS,
  DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS,
  matchesCustomerReturnPortalPolicy,
} from "@shared/returns/customer-return-portal-policy";
import { DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS as legacyWindowExport } from "../../domain/customer-return-eligibility";
import { labelPolicy, labelActivePolicy } from "../support/label-fixtures";
import { resolveCustomerReturnPortalPolicy } from "../../application/customer-return-policy";

function policy() {
  return {
    ...labelPolicy,
    status: "active",
    businessContext: "retail",
    channelId: 36,
    vendorId: null,
    storeConnectionId: null,
  };
}

describe("portal policy setup contract", () => {
  it("resolves the channel winner before checking support, without falling back past an incompatible winner", () => {
    const global = labelActivePolicy({
      id: 2,
      scopeKind: "global",
      scopeKey: "global",
      businessContext: null,
    });
    const channel = labelActivePolicy({
      id: 3,
      scopeKind: "channel_context",
      scopeKey: "context:retail:channel:36",
      channelId: 36,
      returnShippingPayer: "customer",
      returnWindowDays: 30,
    });
    const result = resolveCustomerReturnPortalPolicy(
      [global, labelActivePolicy(), channel],
      36,
    );
    expect(result.resolvedPolicy).toEqual({
      id: 3,
      name: channel.name,
      version: 1,
      scopeKind: "channel_context",
      returnWindowDays: 30,
    });
    expect(result.policyIssue?.code).toBe("RETURN_PORTAL_POLICY_UNSUPPORTED");
    expect(result.policyIssue?.message).toBe(
      "This policy uses customer-paid return shipping; the portal requires Card Shellz-paid shipping.",
    );
  });
  it("reports no match, equal-rank ambiguity and malformed scopes explicitly", () => {
    expect(resolveCustomerReturnPortalPolicy([], 36).policyIssue?.code).toBe(
      "RETURN_PORTAL_POLICY_MISSING",
    );
    expect(
      resolveCustomerReturnPortalPolicy(
        [labelActivePolicy(), labelActivePolicy({ id: 2 })],
        36,
      ).policyIssue?.code,
    ).toBe("RETURN_PORTAL_POLICY_AMBIGUOUS");
    expect(
      resolveCustomerReturnPortalPolicy(
        [labelActivePolicy({ scopeKey: "wrong" })],
        36,
      ).policyIssue?.code,
    ).toBe("RETURN_PORTAL_POLICY_INVALID");
  });
  it("blocks a zero-day winner without silently substituting a default window", () => {
    const result = resolveCustomerReturnPortalPolicy(
      [labelActivePolicy({ returnWindowDays: 0 })],
      36,
    );
    expect(result.resolvedPolicy?.returnWindowDays).toBe(0);
    expect(result.policyIssue?.code).toBe("RETURN_PORTAL_POLICY_UNSUPPORTED");
  });

  it("keeps many concrete incompatibilities deterministic and within the public message bound", () => {
    const candidate = labelActivePolicy({
      returnDestination: "vendor",
      approvalAuthority: "vendor",
      labelProvider: "vendor",
      returnShippingPayer: "customer",
      customerRefundAuthority: "vendor",
      inspectionOwner: "vendor",
      vendorSettlementTrigger: "customer_refunded",
    });
    const first = resolveCustomerReturnPortalPolicy([candidate], 36);
    expect(first.policyIssue?.code).toBe("RETURN_PORTAL_POLICY_UNSUPPORTED");
    expect(first.policyIssue!.message.length).toBeLessThanOrEqual(500);
    expect(first.policyIssue!.message).toContain("other policy settings");
    expect(resolveCustomerReturnPortalPolicy([candidate], 36)).toEqual(first);
  });
  it("keeps fictional defaults separate from live supported windows", () => {
    expect(legacyWindowExport).toBe(DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS);
    expect(CUSTOMER_RETURN_PORTAL_POLICY_REQUIREMENTS).not.toHaveProperty(
      "returnWindowDays",
    );
    for (const days of [1, 30, 365, 3650])
      expect(
        matchesCustomerReturnPortalPolicy(
          { ...policy(), returnWindowDays: days },
          36,
        ),
      ).toBe(true);
    for (const days of [0, -1, 3651, 1.5, NaN])
      expect(
        matchesCustomerReturnPortalPolicy(
          { ...policy(), returnWindowDays: days },
          36,
        ),
      ).toBe(false);
  });

  it.each(["none", "conditional", "required"])(
    "preserves existing compatibility for %s inspection and returnless refunds",
    (inspectionRequirement) => {
      const existing = {
        ...policy(),
        inspectionRequirement,
        returnlessRefundAllowed: true,
      };
      expect(matchesCustomerReturnPortalPolicy(existing, 36)).toBe(true);
      expect(CUSTOMER_RETURN_PORTAL_POLICY_REQUIREMENTS).not.toHaveProperty(
        "inspectionRequirement",
      );
      expect(CUSTOMER_RETURN_PORTAL_POLICY_REQUIREMENTS).not.toHaveProperty(
        "returnlessRefundAllowed",
      );
    },
  );

  it("preserves global and same-shop matching without accepting a foreign shop", () => {
    expect(
      matchesCustomerReturnPortalPolicy(
        { ...policy(), businessContext: null, channelId: null },
        36,
      ),
    ).toBe(true);
    expect(matchesCustomerReturnPortalPolicy(policy(), 37)).toBe(false);
    expect(
      matchesCustomerReturnPortalPolicy(
        { ...policy(), businessContext: "dropship" },
        36,
      ),
    ).toBe(false);
  });
});
