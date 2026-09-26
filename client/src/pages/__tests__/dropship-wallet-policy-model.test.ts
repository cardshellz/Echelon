import { describe, expect, it } from "vitest";

import {
  DROPSHIP_WALLET_POLICY_ADMIN_URL,
  DROPSHIP_WALLET_POLICY_LIMIT_DESCRIPTORS,
  DROPSHIP_WALLET_POLICY_MAX_ADVANCE_FEE_BPS,
  DROPSHIP_WALLET_POLICY_MAX_HOLD_TIMEOUT_MINUTES,
  DROPSHIP_WALLET_POLICY_MAX_TIER_CHANGE_GRACE_DAYS,
  basisPointsToPercentInput,
  buildDropshipWalletPolicyOverviewUrl,
  buildDropshipWalletPolicyVersionRequest,
  centsToDollarInput,
  describeDropshipWalletPolicyTierEnforcement,
  dropshipWalletPolicyEnvLabel,
  dropshipWalletPolicyFormFromLimits,
  dropshipWalletPolicyInvariantViolations,
  dropshipWalletPolicyLimitsKey,
  dropshipWalletPolicyOverviewSchema,
  dropshipWalletPolicyProposedMinimums,
  dropshipWalletPolicySaveErrorMessage,
  dropshipWalletPolicySourceLabel,
  formatDropshipBasisPoints,
  isDropshipWalletPolicyFormDirty,
  parseDollarsToCents,
  parseDropshipWalletPolicyForm,
  parseDropshipWalletPolicyMutation,
  parseDropshipWalletPolicyOverview,
  parsePercentToBasisPoints,
  parseExpiryDays,
  parseWholeDays,
  type DropshipWalletPolicyForm,
  type DropshipWalletPolicyLimitsView,
} from "../dropship-wallet-policy-model";

/** The launch values migration 0683 publishes as version 2. */
const LIMITS: DropshipWalletPolicyLimitsView = {
  autoReloadMinTriggerCents: 10_000,
  caseTierMinimumCents: 50_000,
  autoReloadMinAmountCents: 10_000,
  manualFundingMinCents: 1_000,
  manualFundingMaxCents: 500_000,
  defaultPaymentHoldTimeoutMinutes: 1_440,
  holdExpiryWarningMinutes: 120,
  advanceFeeBps: 100,
  advanceCapCents: 50_000,
  tierChangeGraceDays: 14,
  cardFundingFeeBps: 0,
  cardFundingMinCents: 10_000,
  rewardsRateBankBps: 100,
  rewardsRateUsdcBps: 100,
  rewardsRateCardBps: 0,
  // Migration 0705: points never expire at launch.
  rewardsExpiryDays: null,
};

function baselineForm(patch: Partial<DropshipWalletPolicyForm> = {}): DropshipWalletPolicyForm {
  return { ...dropshipWalletPolicyFormFromLimits(LIMITS), ...patch };
}

describe("describeDropshipWalletPolicyTierEnforcement", () => {
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const date = (iso: string) => iso.slice(0, 10);

  it("names the minimum enforced now and, during grace, the raise and the date it lands", () => {
    expect(describeDropshipWalletPolicyTierEnforcement(
      { tier: "pack", minimumCents: 10_000, version: 2, upcoming: null }, money, date,
    )).toBe("Pack tier: $100.00 enforced now (version 2)");
    expect(describeDropshipWalletPolicyTierEnforcement(
      { tier: "case", minimumCents: 50_000, version: 2, upcoming: { minimumCents: 75_000, version: 3, enforcesAt: "2026-10-04T15:00:00.000Z" } }, money, date,
    )).toBe("Case tier: $500.00 enforced now (version 2); rises to $750.00 on 2026-10-04 (version 3, grace running)");
  });

  it("accepts an overview with or without the enforcement block", () => {
    const envKeys = Object.fromEntries(Object.keys(LIMITS).map((key) => [key, null]));
    const base = {
      policy: null, limitsSource: "environment", limits: LIMITS, envLimits: LIMITS,
      envKeys,
      impact: { proposedAutoReloadMinTriggerCents: 1, proposedAutoReloadMinAmountCents: 1, vendorsBelowMinimumFloor: 0, vendorsBelowMinimumSingleTopUpLimit: 0, activeVendorsWithAutoReloadSettings: 0, evaluatedAt: "2026-09-20T00:00:00.000Z" },
      generatedAt: "2026-09-20T00:00:00.000Z",
    };
    expect(dropshipWalletPolicyOverviewSchema.safeParse(base).success).toBe(true);
    expect(dropshipWalletPolicyOverviewSchema.safeParse({
      ...base,
      listingTierEnforcement: {
        pack: { tier: "pack", minimumCents: 10_000, version: 2, upcoming: null },
        case: { tier: "case", minimumCents: 50_000, version: 2, upcoming: { minimumCents: 75_000, version: 3, enforcesAt: "2026-10-04T15:00:00.000Z" } },
      },
    }).success).toBe(true);
    expect(dropshipWalletPolicyOverviewSchema.safeParse({
      ...base,
      listingTierEnforcement: { pack: { tier: "pack", minimumCents: -1, version: 2, upcoming: null } },
    }).success).toBe(false);
  });
});

describe("dropship wallet policy form model", () => {
  it("renders the limits in force as dollar, percent and whole-number inputs and never carries the old note forward", () => {
    expect(dropshipWalletPolicyFormFromLimits(LIMITS)).toEqual({
      autoReloadMinTriggerDollars: "100.00",
      caseTierMinimumDollars: "500.00",
      autoReloadMinAmountDollars: "100.00",
      manualFundingMinDollars: "10.00",
      manualFundingMaxDollars: "5000.00",
      defaultPaymentHoldTimeoutMinutes: "1440",
      holdExpiryWarningMinutes: "120",
      advanceFeePercent: "1.00",
      advanceCapDollars: "500.00",
      tierChangeGraceDays: "14",
      cardFundingFeePercent: "0.00",
      cardFundingMinDollars: "100.00",
      rewardsRateBankPercent: "1.00",
      rewardsRateUsdcPercent: "1.00",
      rewardsRateCardPercent: "0.00",
      // Blank is never.
      rewardsExpiryDays: "",
      changeNote: "",
    });
    expect(dropshipWalletPolicyFormFromLimits({ ...LIMITS, rewardsExpiryDays: 365 }).rewardsExpiryDays).toBe("365");
    expect(centsToDollarInput(1)).toBe("0.01");
    expect(centsToDollarInput(0)).toBe("0.00");
    expect(centsToDollarInput(123_456)).toBe("1234.56");
    expect(basisPointsToPercentInput(150)).toBe("1.50");
    expect(basisPointsToPercentInput(0)).toBe("0.00");
  });

  it("lists the sixteen limits in display order, each mapped to its own form field", () => {
    expect(DROPSHIP_WALLET_POLICY_LIMIT_DESCRIPTORS.map((descriptor) => descriptor.limitField)).toEqual([
      "autoReloadMinTriggerCents",
      "caseTierMinimumCents",
      "autoReloadMinAmountCents",
      "manualFundingMinCents",
      "manualFundingMaxCents",
      "defaultPaymentHoldTimeoutMinutes",
      "holdExpiryWarningMinutes",
      "advanceFeeBps",
      "advanceCapCents",
      "tierChangeGraceDays",
      "cardFundingFeeBps",
      "cardFundingMinCents",
      "rewardsRateBankBps",
      "rewardsRateUsdcBps",
      "rewardsRateCardBps",
      "rewardsExpiryDays",
    ]);
    expect(new Set(DROPSHIP_WALLET_POLICY_LIMIT_DESCRIPTORS.map((descriptor) => descriptor.formField)).size).toBe(16);
    expect(DROPSHIP_WALLET_POLICY_LIMIT_DESCRIPTORS.at(-1)).toMatchObject({ label: "Rewards points expiry", unit: "days_or_never" });
    // Only the advance fee, the advance cap, the grace, the card fee and the rewards rates may be zero.
    expect(DROPSHIP_WALLET_POLICY_LIMIT_DESCRIPTORS.filter((descriptor) => descriptor.allowZero).map((descriptor) => descriptor.limitField))
      .toEqual(["advanceFeeBps", "advanceCapCents", "tierChangeGraceDays", "cardFundingFeeBps", "rewardsRateBankBps", "rewardsRateUsdcBps", "rewardsRateCardBps"]);
  });

  it("reads the points expiry box: blank is never, whole days from 1 to 3,650, anything else refused", () => {
    expect(parseExpiryDays("")).toEqual({ ok: true, days: null });
    expect(parseExpiryDays("   ")).toEqual({ ok: true, days: null });
    expect(parseExpiryDays("365")).toEqual({ ok: true, days: 365 });
    expect(parseExpiryDays(" 1 ")).toEqual({ ok: true, days: 1 });
    expect(parseExpiryDays("3650")).toEqual({ ok: true, days: 3_650 });
    expect(parseExpiryDays("3651")).toEqual({ ok: false, reason: "range" });
    expect(parseExpiryDays("0")).toEqual({ ok: false, reason: "format" });
    expect(parseExpiryDays("-5")).toEqual({ ok: false, reason: "format" });
    expect(parseExpiryDays("30.5")).toEqual({ ok: false, reason: "format" });
    expect(parseExpiryDays("never")).toEqual({ ok: false, reason: "format" });

    const never = parseDropshipWalletPolicyForm(baselineForm({ rewardsExpiryDays: "" }));
    expect(never.success && never.limits.rewardsExpiryDays).toBeNull();
    const days = parseDropshipWalletPolicyForm(baselineForm({ rewardsExpiryDays: "180" }));
    expect(days.success && days.limits.rewardsExpiryDays).toBe(180);
    // Setting an expiry where there was none is a change worth publishing.
    expect(isDropshipWalletPolicyFormDirty(baselineForm({ rewardsExpiryDays: "180" }), LIMITS)).toBe(true);
    expect(isDropshipWalletPolicyFormDirty(baselineForm(), LIMITS)).toBe(false);
  });

  it("parses dollars and percents into integers without floating-point arithmetic", () => {
    const parsed = parseDropshipWalletPolicyForm(baselineForm({
      // 69.29 * 100 is 6928.999999999999 in binary floating point; the model
      // concatenates the digits instead, so the cent is never lost.
      autoReloadMinTriggerDollars: "69.29",
      caseTierMinimumDollars: "69.29",
      autoReloadMinAmountDollars: "1234.5",
      manualFundingMinDollars: "0.07",
      manualFundingMaxDollars: "  5000  ",
      advanceFeePercent: "1.15",
      advanceCapDollars: "0",
      tierChangeGraceDays: "0",
    }));
    expect(parsed).toMatchObject({
      success: true,
      limits: {
        autoReloadMinTriggerCents: 6_929,
        caseTierMinimumCents: 6_929,
        autoReloadMinAmountCents: 123_450,
        manualFundingMinCents: 7,
        manualFundingMaxCents: 500_000,
        advanceFeeBps: 115,
        advanceCapCents: 0,
        tierChangeGraceDays: 0,
      },
    });
    expect(parsePercentToBasisPoints("100")).toEqual({ ok: true, bps: 10_000 });
    expect(parsePercentToBasisPoints("100.01")).toEqual({ ok: false, reason: "range" });
    expect(parsePercentToBasisPoints("1.5%")).toEqual({ ok: false, reason: "format" });
    expect(parseDollarsToCents("0", { allowZero: true })).toEqual({ ok: true, cents: 0 });
    expect(parseDollarsToCents("0")).toEqual({ ok: false, reason: "format" });
    expect(parseWholeDays("365", 365)).toEqual({ ok: true, days: 365 });
    expect(parseWholeDays("366", 365)).toEqual({ ok: false, reason: "range" });
    expect(parseWholeDays("1.5", 365)).toEqual({ ok: false, reason: "format" });
  });

  it("rejects malformed, zero, negative and over-precise amounts with a per-field message", () => {
    const parsed = parseDropshipWalletPolicyForm({
      autoReloadMinTriggerDollars: "",
      caseTierMinimumDollars: "0",
      autoReloadMinAmountDollars: "abc",
      manualFundingMinDollars: "-5",
      manualFundingMaxDollars: "1.234",
      defaultPaymentHoldTimeoutMinutes: "0",
      holdExpiryWarningMinutes: "12.5",
      advanceFeePercent: "-1",
      advanceCapDollars: "abc",
      tierChangeGraceDays: "-1",
      cardFundingFeePercent: "abc",
      cardFundingMinDollars: "0",
      rewardsRateBankPercent: "11",
      rewardsRateUsdcPercent: "-1",
      rewardsRateCardPercent: "1",
      rewardsExpiryDays: "0",
      changeNote: "",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected a rejection");
    expect(parsed.errors.autoReloadMinTriggerDollars).toContain("greater than zero");
    expect(parsed.errors.caseTierMinimumDollars).toContain("greater than zero");
    expect(parsed.errors.autoReloadMinAmountDollars).toContain("at most two decimal places");
    expect(parsed.errors.rewardsRateBankPercent).toBe("Rewards on bank transfers cannot exceed 10%.");
    expect(parsed.errors.rewardsRateUsdcPercent).toContain("percentage of zero or more");
    expect(parsed.errors.rewardsRateCardPercent).toBeUndefined();
    expect(parsed.errors.rewardsExpiryDays).toBe("Rewards points expiry must be blank (never) or a whole number of days from 1 to 3,650.");
    expect(parsed.errors.manualFundingMinDollars).toContain("greater than zero");
    expect(parsed.errors.manualFundingMaxDollars).toContain("at most two decimal places");
    expect(parsed.errors.defaultPaymentHoldTimeoutMinutes).toBe(
      "Payment hold timeout must be a whole number of minutes greater than zero.",
    );
    expect(parsed.errors.holdExpiryWarningMinutes).toBe(
      "Hold expiry warning must be a whole number of minutes greater than zero.",
    );
    expect(parsed.errors.advanceFeePercent).toBe(
      "Advance fee must be a percentage of zero or more, with at most two decimal places.",
    );
    expect(parsed.errors.advanceCapDollars).toBe(
      "Advance cap must be a dollar amount of zero or more, with at most two decimal places.",
    );
    expect(parsed.errors.tierChangeGraceDays).toBe(
      "Tier change grace must be a whole number of days, zero or more.",
    );
    expect(parsed.errors.cardFundingFeePercent).toBe(
      "Card funding fee must be a percentage of zero or more, with at most two decimal places.",
    );
    expect(parsed.errors.cardFundingMinDollars).toContain("greater than zero");
  });

  it("rejects an amount larger than the system can record as a range problem", () => {
    const parsed = parseDropshipWalletPolicyForm(baselineForm({
      manualFundingMaxDollars: "999999999999999999",
    }));
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected a rejection");
    expect(parsed.errors.manualFundingMaxDollars).toBe(
      "Manual top-up maximum is larger than this system can record.",
    );
  });

  it("holds the payment hold timeout, the advance fee and the grace to the ceilings the database enforces", () => {
    expect(DROPSHIP_WALLET_POLICY_MAX_HOLD_TIMEOUT_MINUTES).toBe(43_200);
    expect(DROPSHIP_WALLET_POLICY_MAX_ADVANCE_FEE_BPS).toBe(10_000);
    expect(DROPSHIP_WALLET_POLICY_MAX_TIER_CHANGE_GRACE_DAYS).toBe(365);
    expect(parseDropshipWalletPolicyForm(baselineForm({
      defaultPaymentHoldTimeoutMinutes: "43200",
    })).success).toBe(true);
    const parsed = parseDropshipWalletPolicyForm(baselineForm({
      defaultPaymentHoldTimeoutMinutes: "43201",
      advanceFeePercent: "100.5",
      tierChangeGraceDays: "366",
    }));
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected a rejection");
    expect(parsed.errors.defaultPaymentHoldTimeoutMinutes).toBe(
      "Payment hold timeout cannot exceed 43,200 minutes (30 days).",
    );
    expect(parsed.errors.advanceFeePercent).toBe("Advance fee cannot exceed 100%.");
    expect(parsed.errors.tierChangeGraceDays).toBe("Tier change grace cannot exceed 365 days.");
  });

  it("states the manual range rule in the server's own words, on the maximum field", () => {
    expect(dropshipWalletPolicyInvariantViolations({
      ...LIMITS,
      manualFundingMinCents: 600_000,
    })).toEqual([{
      field: "manualFundingMaxCents",
      message: "Manual top-up maximum must be at least the manual top-up minimum.",
    }]);

    const parsed = parseDropshipWalletPolicyForm(baselineForm({
      manualFundingMinDollars: "6000.00",
    }));
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected a rejection");
    expect(parsed.errors.manualFundingMaxDollars).toBe(
      "Manual top-up maximum must be at least the manual top-up minimum.",
    );
  });

  it("states the top-up-clears-the-trigger rule in the server's own words", () => {
    const message =
      "Minimum single top-up limit must be at least the Pack tier reserve, otherwise a top-up can never clear the trigger.";
    expect(dropshipWalletPolicyInvariantViolations({
      ...LIMITS,
      autoReloadMinAmountCents: 9_999,
    })).toEqual([{ field: "autoReloadMinAmountCents", message }]);

    const parsed = parseDropshipWalletPolicyForm(baselineForm({
      autoReloadMinAmountDollars: "99.99",
    }));
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected a rejection");
    expect(parsed.errors.autoReloadMinAmountDollars).toBe(message);
  });

  it("states the case-tier-covers-pack-tier rule in the server's own words", () => {
    const message = "Case tier reserve must be at least the Pack tier reserve.";
    expect(dropshipWalletPolicyInvariantViolations({
      ...LIMITS,
      caseTierMinimumCents: 9_999,
    })).toEqual([{ field: "caseTierMinimumCents", message }]);
    expect(dropshipWalletPolicyInvariantViolations({
      ...LIMITS,
      caseTierMinimumCents: 10_000,
    })).toEqual([]);

    const parsed = parseDropshipWalletPolicyForm(baselineForm({
      caseTierMinimumDollars: "99.99",
    }));
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected a rejection");
    expect(parsed.errors.caseTierMinimumDollars).toBe(message);
  });

  it("states the warning-inside-the-hold rule in the server's own words", () => {
    const message = "Hold expiry warning window must be shorter than the payment hold timeout.";
    expect(dropshipWalletPolicyInvariantViolations({
      ...LIMITS,
      holdExpiryWarningMinutes: LIMITS.defaultPaymentHoldTimeoutMinutes,
    })).toEqual([{ field: "holdExpiryWarningMinutes", message }]);

    const parsed = parseDropshipWalletPolicyForm(baselineForm({
      holdExpiryWarningMinutes: "1440",
    }));
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected a rejection");
    expect(parsed.errors.holdExpiryWarningMinutes).toBe(message);
  });

  it("reports every cross-field violation at once instead of the first", () => {
    expect(dropshipWalletPolicyInvariantViolations({
      autoReloadMinTriggerCents: 10_000,
      caseTierMinimumCents: 9_000,
      autoReloadMinAmountCents: 5_000,
      manualFundingMinCents: 900_000,
      manualFundingMaxCents: 1_000,
      defaultPaymentHoldTimeoutMinutes: 60,
      holdExpiryWarningMinutes: 60,
      advanceFeeBps: 100,
      advanceCapCents: 50_000,
      tierChangeGraceDays: 14,
      cardFundingFeeBps: 0,
      cardFundingMinCents: 10_000,
      rewardsRateBankBps: 100,
      rewardsRateUsdcBps: 100,
      rewardsRateCardBps: 0,
      rewardsExpiryDays: null,
    }).map((violation) => violation.field)).toEqual([
      "manualFundingMaxCents",
      "autoReloadMinAmountCents",
      "caseTierMinimumCents",
      "cardFundingMinCents",
      "holdExpiryWarningMinutes",
    ]);
  });

  it("keeps the more specific range message when a field also breaks a relationship", () => {
    const parsed = parseDropshipWalletPolicyForm(baselineForm({
      holdExpiryWarningMinutes: "0",
    }));
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected a rejection");
    expect(parsed.errors.holdExpiryWarningMinutes).toContain("whole number of minutes");
  });

  it("treats a changed limit as dirty and a re-typed or annotated one as clean", () => {
    expect(isDropshipWalletPolicyFormDirty(baselineForm(), LIMITS)).toBe(false);
    expect(isDropshipWalletPolicyFormDirty(
      baselineForm({ autoReloadMinTriggerDollars: "100" }),
      LIMITS,
    )).toBe(false);
    expect(isDropshipWalletPolicyFormDirty(
      baselineForm({ advanceFeePercent: "1" }),
      LIMITS,
    )).toBe(false);
    expect(isDropshipWalletPolicyFormDirty(
      baselineForm({ changeNote: "Raising the floor next week." }),
      LIMITS,
    )).toBe(false);
    expect(isDropshipWalletPolicyFormDirty(
      baselineForm({ autoReloadMinTriggerDollars: "100.01" }),
      LIMITS,
    )).toBe(true);
    expect(isDropshipWalletPolicyFormDirty(
      baselineForm({ advanceCapDollars: "0" }),
      LIMITS,
    )).toBe(true);
    expect(isDropshipWalletPolicyFormDirty(
      baselineForm({ tierChangeGraceDays: "15" }),
      LIMITS,
    )).toBe(true);
    expect(isDropshipWalletPolicyFormDirty(
      baselineForm({ manualFundingMinDollars: "" }),
      LIMITS,
    )).toBe(true);
  });

  it("identifies a set of limits so a version published elsewhere resets the form", () => {
    expect(dropshipWalletPolicyLimitsKey(LIMITS)).toBe(
      "autoReloadMinTriggerCents=10000|caseTierMinimumCents=50000|autoReloadMinAmountCents=10000"
      + "|manualFundingMinCents=1000|manualFundingMaxCents=500000"
      + "|defaultPaymentHoldTimeoutMinutes=1440|holdExpiryWarningMinutes=120"
      + "|advanceFeeBps=100|advanceCapCents=50000|tierChangeGraceDays=14"
      + "|cardFundingFeeBps=0|cardFundingMinCents=10000"
      + "|rewardsRateBankBps=100|rewardsRateUsdcBps=100|rewardsRateCardBps=0"
      + "|rewardsExpiryDays=null",
    );
    expect(dropshipWalletPolicyLimitsKey({ ...LIMITS, rewardsExpiryDays: 365 }))
      .not.toBe(dropshipWalletPolicyLimitsKey(LIMITS));
    expect(dropshipWalletPolicyLimitsKey({ ...LIMITS, advanceCapCents: 50_001 }))
      .not.toBe(dropshipWalletPolicyLimitsKey(LIMITS));
  });

  it("only proposes minimums when a minimum actually moved", () => {
    expect(dropshipWalletPolicyProposedMinimums(baselineForm(), LIMITS)).toBeNull();
    expect(dropshipWalletPolicyProposedMinimums(
      baselineForm({ manualFundingMaxDollars: "9000.00", caseTierMinimumDollars: "900.00" }),
      LIMITS,
    )).toBeNull();
    expect(dropshipWalletPolicyProposedMinimums(
      baselineForm({ autoReloadMinTriggerDollars: "75.00" }),
      LIMITS,
    )).toEqual({ autoReloadMinTriggerCents: 7_500, autoReloadMinAmountCents: 10_000 });
    // A half-typed box falls back to the value in force rather than blocking
    // the count for the box that is complete.
    expect(dropshipWalletPolicyProposedMinimums(
      baselineForm({ autoReloadMinTriggerDollars: "75.", autoReloadMinAmountDollars: "250" }),
      LIMITS,
    )).toEqual({ autoReloadMinTriggerCents: 10_000, autoReloadMinAmountCents: 25_000 });
  });

  it("builds the overview URL with only the proposed reserves the server accepts", () => {
    expect(buildDropshipWalletPolicyOverviewUrl()).toBe("/api/dropship/admin/wallet/policy");
    expect(buildDropshipWalletPolicyOverviewUrl(null)).toBe(DROPSHIP_WALLET_POLICY_ADMIN_URL);
    expect(buildDropshipWalletPolicyOverviewUrl({
      autoReloadMinTriggerCents: 7_500,
      autoReloadMinAmountCents: 25_000,
    })).toBe(
      "/api/dropship/admin/wallet/policy"
      + "?proposedAutoReloadMinTriggerCents=7500&proposedAutoReloadMinAmountCents=25000",
    );
  });

  it("builds exactly the request body the strict server schema accepts", () => {
    const request = buildDropshipWalletPolicyVersionRequest({
      limits: LIMITS,
      changeNote: "  Raised the floor for Q4.  ",
      idempotencyKey: " dropship-wallet-policy:0d9f  ",
    });
    expect(Object.keys(request).sort()).toEqual([
      "advanceCapCents",
      "advanceFeeBps",
      "autoReloadMinAmountCents",
      "autoReloadMinTriggerCents",
      "cardFundingFeeBps",
      "cardFundingMinCents",
      "caseTierMinimumCents",
      "changeNote",
      "defaultPaymentHoldTimeoutMinutes",
      "holdExpiryWarningMinutes",
      "idempotencyKey",
      "manualFundingMaxCents",
      "manualFundingMinCents",
      "rewardsExpiryDays",
      "rewardsRateBankBps",
      "rewardsRateCardBps",
      "rewardsRateUsdcBps",
      "tierChangeGraceDays",
    ]);
    // Never is sent as null, never left out: the server requires the key on every version.
    expect(request.rewardsExpiryDays).toBeNull();
    expect(buildDropshipWalletPolicyVersionRequest({
      limits: { ...LIMITS, rewardsExpiryDays: 180 }, changeNote: null, idempotencyKey: "dropship-wallet-policy:0d9f",
    }).rewardsExpiryDays).toBe(180);
    expect(request).toMatchObject({
      ...LIMITS,
      changeNote: "Raised the floor for Q4.",
      idempotencyKey: "dropship-wallet-policy:0d9f",
    });
    expect(buildDropshipWalletPolicyVersionRequest({
      limits: LIMITS,
      changeNote: "   ",
      idempotencyKey: "dropship-wallet-policy:0d9f",
    }).changeNote).toBeNull();
  });

  it("refuses to build a body that breaks an invariant or carries an unusable key", () => {
    expect(() => buildDropshipWalletPolicyVersionRequest({
      limits: { ...LIMITS, autoReloadMinAmountCents: 1 },
      changeNote: null,
      idempotencyKey: "dropship-wallet-policy:0d9f",
    })).toThrow(/can never clear the trigger/);
    expect(() => buildDropshipWalletPolicyVersionRequest({
      limits: { ...LIMITS, caseTierMinimumCents: 1 },
      changeNote: null,
      idempotencyKey: "dropship-wallet-policy:0d9f",
    })).toThrow(/at least the Pack tier reserve/);
    expect(() => buildDropshipWalletPolicyVersionRequest({
      limits: LIMITS,
      changeNote: null,
      idempotencyKey: "short",
    })).toThrow(/Idempotency key/);
    expect(() => buildDropshipWalletPolicyVersionRequest({
      limits: LIMITS,
      changeNote: "x".repeat(1_001),
      idempotencyKey: "dropship-wallet-policy:0d9f",
    })).toThrow(/1,000 characters/);
  });

  it("tells staff to reload when the policy moved underneath them, and echoes anything else", () => {
    expect(dropshipWalletPolicySaveErrorMessage(
      "DROPSHIP_WALLET_POLICY_CONFLICT",
      "Another wallet policy version was published concurrently; retry the request.",
    )).toBe(
      "Another wallet policy version was published while this form was open, so nothing was saved. "
      + "Reload the policy and re-apply the change on top of the new version.",
    );
    expect(dropshipWalletPolicySaveErrorMessage("DROPSHIP_WALLET_POLICY_IDEMPOTENCY_CONFLICT", "x"))
      .toContain("Reload the policy");
    expect(dropshipWalletPolicySaveErrorMessage("DROPSHIP_WALLET_POLICY_COMMAND_INCOMPLETE", "x"))
      .toContain("earlier save did not finish");
    expect(dropshipWalletPolicySaveErrorMessage("DROPSHIP_WALLET_POLICY_TABLE_MISSING", "x"))
      .toContain("still come from the environment");
    expect(dropshipWalletPolicySaveErrorMessage(
      "DROPSHIP_WALLET_POLICY_INVALID_INPUT",
      "Dropship wallet policy input failed validation.",
    )).toBe("Dropship wallet policy input failed validation.");
    expect(dropshipWalletPolicySaveErrorMessage(null, "Network request failed."))
      .toBe("Network request failed.");
  });

  it("names the source of each value, including the limits with no environment variable", () => {
    expect(dropshipWalletPolicySourceLabel("policy", "DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS"))
      .toBe("Published policy version");
    expect(dropshipWalletPolicySourceLabel("environment", "DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS"))
      .toBe("Environment variable DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS");
    expect(dropshipWalletPolicySourceLabel("environment", null))
      .toBe("Built-in default (no environment variable exists)");
    expect(dropshipWalletPolicyEnvLabel(null)).toBe("Built-in default (no environment variable exists)");
    expect(dropshipWalletPolicyEnvLabel("DROPSHIP_CARD_FUNDING_FEE_BPS"))
      .toBe("DROPSHIP_CARD_FUNDING_FEE_BPS");
  });

  it("formats basis points with integer math", () => {
    expect(formatDropshipBasisPoints(290)).toBe("2.90%");
    expect(formatDropshipBasisPoints(5)).toBe("0.05%");
    expect(formatDropshipBasisPoints(10_000)).toBe("100.00%");
    expect(formatDropshipBasisPoints(0)).toBe("0.00%");
  });

  it("refuses a response it cannot verify instead of rendering a guess", () => {
    const overview = {
      policy: null,
      limits: LIMITS,
      limitsSource: "environment",
      envLimits: LIMITS,
      envKeys: {
        autoReloadMinTriggerCents: "DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS",
        caseTierMinimumCents: null,
        autoReloadMinAmountCents: "DROPSHIP_AUTO_RELOAD_MIN_AMOUNT_CENTS",
        manualFundingMinCents: "DROPSHIP_STRIPE_MIN_WALLET_FUNDING_CENTS",
        manualFundingMaxCents: "DROPSHIP_STRIPE_MAX_WALLET_FUNDING_CENTS",
        defaultPaymentHoldTimeoutMinutes: null,
        holdExpiryWarningMinutes: "DROPSHIP_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES",
        advanceFeeBps: null,
        advanceCapCents: null,
        tierChangeGraceDays: null,
        cardFundingFeeBps: "DROPSHIP_CARD_FUNDING_FEE_BPS",
        cardFundingMinCents: null,
        rewardsRateBankBps: null,
        rewardsRateUsdcBps: null,
        rewardsRateCardBps: null,
        rewardsExpiryDays: null,
      },
      impact: {
        proposedAutoReloadMinTriggerCents: 10_000,
        proposedAutoReloadMinAmountCents: 10_000,
        vendorsBelowMinimumFloor: 0,
        vendorsBelowMinimumSingleTopUpLimit: 0,
        activeVendorsWithAutoReloadSettings: 0,
        evaluatedAt: "2026-09-20T10:00:00.000Z",
      },
      generatedAt: "2026-09-20T10:00:00.000Z",
    };
    expect(parseDropshipWalletPolicyOverview(overview).limitsSource).toBe("environment");
    expect(() => parseDropshipWalletPolicyOverview({ ...overview, impact: null }))
      .toThrow(/wallet policy response was not in the expected shape at impact/);
    // A server that has not learned the new limits is a shape the page cannot trust.
    const { advanceCapCents: _omitted, ...withoutCap } = LIMITS;
    expect(() => parseDropshipWalletPolicyOverview({ ...overview, limits: withoutCap }))
      .toThrow(/wallet policy response was not in the expected shape at limits.advanceCapCents/);
    expect(() => parseDropshipWalletPolicyMutation({ idempotentReplay: true }))
      .toThrow(/wallet policy save response was not in the expected shape/);
  });
});

describe("the card fee and the card minimum deposit (funding design phase 7)", () => {
  it("accepts a zero card fee, refuses one above the 10% guard, and holds the card minimum to the manual maximum", () => {
    const zero = parseDropshipWalletPolicyForm(baselineForm({ cardFundingFeePercent: "0" }));
    expect(zero.success && zero.limits.cardFundingFeeBps).toBe(0);

    const tooHigh = parseDropshipWalletPolicyForm(baselineForm({ cardFundingFeePercent: "10.01" }));
    if (tooHigh.success) throw new Error("expected a rejection");
    expect(tooHigh.errors.cardFundingFeePercent).toBe("Card funding fee cannot exceed 10%.");

    const atGuard = parseDropshipWalletPolicyForm(baselineForm({ cardFundingFeePercent: "10" }));
    expect(atGuard.success && atGuard.limits.cardFundingFeeBps).toBe(1_000);

    const aboveMax = parseDropshipWalletPolicyForm(baselineForm({ cardFundingMinDollars: "5000.01" }));
    if (aboveMax.success) throw new Error("expected a rejection");
    expect(aboveMax.errors.cardFundingMinDollars).toBe("Card minimum deposit must be at most the manual top-up maximum.");

    const zeroMin = parseDropshipWalletPolicyForm(baselineForm({ cardFundingMinDollars: "0" }));
    if (zeroMin.success) throw new Error("expected a rejection");
    expect(zeroMin.errors.cardFundingMinDollars).toBe("Card minimum deposit must be a dollar amount greater than zero, with at most two decimal places.");
  });

  it("round-trips both values through the form without floating point", () => {
    const form = dropshipWalletPolicyFormFromLimits({ ...LIMITS, cardFundingFeeBps: 275, cardFundingMinCents: 12_345 });
    expect(form.cardFundingFeePercent).toBe("2.75");
    expect(form.cardFundingMinDollars).toBe("123.45");
    const parsed = parseDropshipWalletPolicyForm(form);
    expect(parsed.success && parsed.limits).toMatchObject({ cardFundingFeeBps: 275, cardFundingMinCents: 12_345 });
  });
});
