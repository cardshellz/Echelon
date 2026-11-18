import { describe, expect, it } from "vitest";
import {
  isManagedMemberPricingDescription,
  ORDER_EDIT_MEMBER_PRICING_DESCRIPTION,
  presentOrderDiscountLabel,
} from "../../order-edit-member-pricing";

describe("customer-facing member pricing descriptions", () => {
  it("writes the customer brand and recognizes historical receipts", () => {
    expect(ORDER_EDIT_MEMBER_PRICING_DESCRIPTION).toBe("Shellz Club pricing");
    expect(isManagedMemberPricingDescription("Shellz Club pricing")).toBe(true);
    expect(isManagedMemberPricingDescription("Echelon member pricing")).toBe(true);
  });

  it.each([null, undefined, "Member discount", "SAVE10", "Echelon member pricing extra"])(
    "does not classify unrelated descriptions as managed: %s", value => {
      expect(isManagedMemberPricingDescription(value)).toBe(false);
    },
  );

  it("normalizes legacy presentation without relabeling coupons", () => {
    expect(presentOrderDiscountLabel("Echelon member pricing")).toBe("Shellz Club pricing");
    for (const value of ["SAVE10", "Member discount", "Shellz Club pricing"])
      expect(presentOrderDiscountLabel(value)).toBe(value);
  });
});
