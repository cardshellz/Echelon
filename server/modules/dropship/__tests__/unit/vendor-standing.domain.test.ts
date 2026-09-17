import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  DROPSHIP_FUNDING_DECLINED_ERROR_CODE,
  fundingShortfallCents,
  isDropshipFundingDeclineError,
  isFundingStandingReason,
  listingHoldIdempotencyKeyFor,
  listingHoldStateFor,
  standingReasonForFailedFunding,
  vendorOrderAdmissionFor,
  vendorStandingNotificationKeyFor,
} from "../../domain/vendor-standing";

describe("vendor standing rules", () => {
  it("admits orders for active vendors, holds them for a funding pause, and refuses everyone else", () => {
    expect(vendorOrderAdmissionFor({ status: "active", standingReason: null })).toBe("accept");
    expect(vendorOrderAdmissionFor({ status: "paused", standingReason: "card_declined" })).toBe("hold");
    expect(vendorOrderAdmissionFor({ status: "paused", standingReason: "funding_returned" })).toBe("hold");
    expect(vendorOrderAdmissionFor({ status: "paused", standingReason: "operator" })).toBe("reject");
    expect(vendorOrderAdmissionFor({ status: "paused", standingReason: null })).toBe("reject");
    for (const status of ["onboarding", "lapsed", "suspended", "closed", "mystery"]) {
      expect(vendorOrderAdmissionFor({ status, standingReason: "card_declined" })).toBe("reject");
    }
  });

  it("counts only the bank's decline as a decline", () => {
    expect(isDropshipFundingDeclineError(new DropshipError(DROPSHIP_FUNDING_DECLINED_ERROR_CODE, "Declined.", {}))).toBe(true);
    expect(isDropshipFundingDeclineError(new DropshipError("DROPSHIP_STRIPE_IDEMPOTENCY_CONFLICT", "Conflict.", {}))).toBe(false);
    expect(isDropshipFundingDeclineError(new Error("DROPSHIP_STRIPE_CARD_DECLINED"))).toBe(false);
    expect(isDropshipFundingDeclineError(null)).toBe(false);
  });

  it("names a failed card credit a decline and anything else a returned transfer", () => {
    expect(standingReasonForFailedFunding("stripe_card")).toBe("card_declined");
    expect(standingReasonForFailedFunding("stripe_ach")).toBe("funding_returned");
    expect(standingReasonForFailedFunding(null)).toBe("funding_returned");
    expect(isFundingStandingReason("card_declined")).toBe(true);
    expect(isFundingStandingReason("operator")).toBe(false);
    expect(isFundingStandingReason(null)).toBe(false);
  });

  it("measures the shortfall against the minimum, and never calls an empty wallet funded", () => {
    expect(fundingShortfallCents({ availableBalanceCents: 4999, minimumBalanceCents: 5000, currency: "USD" })).toBe(1);
    expect(fundingShortfallCents({ availableBalanceCents: 5000, minimumBalanceCents: 5000, currency: "USD" })).toBe(0);
    expect(fundingShortfallCents({ availableBalanceCents: 12_000, minimumBalanceCents: 5000, currency: "USD" })).toBe(0);
    expect(fundingShortfallCents({ availableBalanceCents: 0, minimumBalanceCents: null, currency: "USD" })).toBe(1);
    expect(fundingShortfallCents({ availableBalanceCents: 1, minimumBalanceCents: null, currency: "USD" })).toBe(0);
    expect(fundingShortfallCents({ availableBalanceCents: -2500, minimumBalanceCents: 0, currency: "USD" })).toBe(2501);
  });

  it("keys holds, releases and notices by the standing revision", () => {
    expect(listingHoldStateFor("paused")).toBe("held");
    expect(listingHoldStateFor("active")).toBe("released");
    expect(listingHoldStateFor("lapsed")).toBe("released");
    expect(listingHoldIdempotencyKeyFor({ vendorId: 10, standingRevision: 3, state: "held", storeConnectionId: 77 }))
      .toBe("dropship-vendor-standing:10:3:held:77");
    expect(vendorStandingNotificationKeyFor({ vendorId: 10, standingRevision: 3, event: "resumed" }))
      .toBe("dropship-vendor-standing:10:3:resumed");
  });
});
