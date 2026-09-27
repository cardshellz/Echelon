import { describe, expect, it } from "vitest";
import {
  CUSTOMER_RETURN_PORTAL_POLICY_DEFAULTS,
  CUSTOMER_RETURN_PORTAL_POLICY_REQUIREMENTS,
  DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS,
  matchesCustomerReturnPortalPolicy,
} from "@shared/returns/customer-return-portal-policy";
import { DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS as legacyWindowExport } from "../../domain/customer-return-eligibility";
import { labelPolicy } from "../support/label-fixtures";

function policy() {
  return {
    ...labelPolicy,
    ...CUSTOMER_RETURN_PORTAL_POLICY_DEFAULTS,
    status: "active",
    businessContext: "retail",
    channelId: 36,
    vendorId: null,
    storeConnectionId: null,
  };
}

describe("portal policy setup contract", () => {
  it("offers an explicit 365-day merchant-paid preset that the saved-policy filter accepts", () => {
    expect(CUSTOMER_RETURN_PORTAL_POLICY_DEFAULTS).toEqual({
      returnWindowDays: 365,
      returnDestination: "card_shellz",
      approvalAuthority: "card_shellz",
      labelProvider: "shipstation",
      returnShippingPayer: "card_shellz",
      customerRefundAuthority: "card_shellz",
      inspectionOwner: "card_shellz",
      vendorSettlementTrigger: "none",
      inspectionRequirement: "required",
      returnlessRefundAllowed: false,
    });
    expect(matchesCustomerReturnPortalPolicy(policy(), 36)).toBe(true);
    expect(legacyWindowExport).toBe(DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS);
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
