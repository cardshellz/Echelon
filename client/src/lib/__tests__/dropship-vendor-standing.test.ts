import { describe, expect, it } from "vitest";
import { describeVendorStanding, isPausedForFunding } from "../dropship-vendor-standing";

describe("describeVendorStanding", () => {
  it("says nothing for a vendor who is not paused", () => {
    expect(describeVendorStanding({ status: "active", standingReason: null, pausedAt: null })).toBeNull();
    expect(describeVendorStanding({ status: "onboarding", standingReason: null, pausedAt: null })).toBeNull();
    expect(describeVendorStanding({ status: "lapsed", standingReason: null, pausedAt: null })).toBeNull();
  });

  it("tells a vendor whose card was declined to fund the wallet, and that selling resumes on its own", () => {
    const notice = describeVendorStanding({ status: "paused", standingReason: "card_declined", pausedAt: "2026-09-17T12:00:00.000Z" });
    expect(notice).toMatchObject({ title: "Selling is paused", needsFunds: true });
    expect(notice?.reason).toBe("Your saved card was declined when we tried to top up your wallet.");
    expect(notice?.action).toContain("Orders are not being accepted and your listings show nothing for sale.");
    expect(notice?.action).toContain("selling resumes on its own once your balance is back to the minimum");
    expect(notice?.since).toMatch(/^Paused since .+\.$/);
  });

  it("names a returned bank transfer as the reason", () => {
    const notice = describeVendorStanding({ status: "paused", standingReason: "funding_returned", pausedAt: null });
    expect(notice?.reason).toBe("A bank transfer to your wallet was returned by your bank.");
    expect(notice?.needsFunds).toBe(true);
    expect(notice?.since).toBeNull();
  });

  it("sends an operator pause, or an unknown reason, to support instead of the wallet", () => {
    const operator = describeVendorStanding({ status: "paused", standingReason: "operator", pausedAt: "2026-09-17T12:00:00.000Z" });
    expect(operator).toMatchObject({ needsFunds: false, reason: "Card Shellz paused your account." });
    expect(operator?.action).toContain("Contact Card Shellz support to resume.");
    const unknown = describeVendorStanding({ status: "paused", standingReason: null, pausedAt: null });
    expect(unknown).toMatchObject({ needsFunds: false, reason: "Your account is paused." });
  });

  it("only counts the two funding reasons as something the wallet can fix", () => {
    expect(isPausedForFunding({ status: "paused", standingReason: "card_declined", pausedAt: null })).toBe(true);
    expect(isPausedForFunding({ status: "paused", standingReason: "funding_returned", pausedAt: null })).toBe(true);
    expect(isPausedForFunding({ status: "paused", standingReason: "operator", pausedAt: null })).toBe(false);
    expect(isPausedForFunding({ status: "active", standingReason: null, pausedAt: null })).toBe(false);
  });
});
