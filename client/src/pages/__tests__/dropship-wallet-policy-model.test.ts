import { describe, expect, it } from "vitest";

import {
  DROPSHIP_WALLET_POLICY_ADMIN_URL,
  DROPSHIP_WALLET_POLICY_MAX_HOLD_TIMEOUT_MINUTES,
  buildDropshipWalletPolicyOverviewUrl,
  buildDropshipWalletPolicyVersionRequest,
  centsToDollarInput,
  dropshipWalletPolicyEnvLabel,
  dropshipWalletPolicyFormFromLimits,
  dropshipWalletPolicyInvariantViolations,
  dropshipWalletPolicyLimitsKey,
  dropshipWalletPolicyProposedMinimums,
  dropshipWalletPolicySaveErrorMessage,
  dropshipWalletPolicySourceLabel,
  formatDropshipBasisPoints,
  isDropshipWalletPolicyFormDirty,
  parseDropshipWalletPolicyForm,
  parseDropshipWalletPolicyMutation,
  parseDropshipWalletPolicyOverview,
  type DropshipWalletPolicyForm,
  type DropshipWalletPolicyLimitsView,
} from "../dropship-wallet-policy-model";

const LIMITS: DropshipWalletPolicyLimitsView = {
  autoReloadMinTriggerCents: 5_000,
  autoReloadMinAmountCents: 10_000,
  manualFundingMinCents: 1_000,
  manualFundingMaxCents: 500_000,
  defaultPaymentHoldTimeoutMinutes: 2_880,
  holdExpiryWarningMinutes: 120,
};

function baselineForm(patch: Partial<DropshipWalletPolicyForm> = {}): DropshipWalletPolicyForm {
  return { ...dropshipWalletPolicyFormFromLimits(LIMITS), ...patch };
}

describe("dropship wallet policy form model", () => {
  it("renders the limits in force as dollar inputs and never carries the old note forward", () => {
    expect(dropshipWalletPolicyFormFromLimits(LIMITS)).toEqual({
      autoReloadMinTriggerDollars: "50.00",
      autoReloadMinAmountDollars: "100.00",
      manualFundingMinDollars: "10.00",
      manualFundingMaxDollars: "5000.00",
      defaultPaymentHoldTimeoutMinutes: "2880",
      holdExpiryWarningMinutes: "120",
      changeNote: "",
    });
    expect(centsToDollarInput(1)).toBe("0.01");
    expect(centsToDollarInput(0)).toBe("0.00");
    expect(centsToDollarInput(123_456)).toBe("1234.56");
  });

  it("parses dollars into integer cents without floating-point arithmetic", () => {
    const parsed = parseDropshipWalletPolicyForm(baselineForm({
      // 69.29 * 100 is 6928.999999999999 in binary floating point; the model
      // concatenates the digits instead, so the cent is never lost.
      autoReloadMinTriggerDollars: "69.29",
      autoReloadMinAmountDollars: "1234.5",
      manualFundingMinDollars: "0.07",
      manualFundingMaxDollars: "  5000  ",
    }));
    expect(parsed).toMatchObject({
      success: true,
      limits: {
        autoReloadMinTriggerCents: 6_929,
        autoReloadMinAmountCents: 123_450,
        manualFundingMinCents: 7,
        manualFundingMaxCents: 500_000,
      },
    });
  });

  it("rejects malformed, zero, negative and over-precise amounts with a per-field message", () => {
    const parsed = parseDropshipWalletPolicyForm({
      autoReloadMinTriggerDollars: "",
      autoReloadMinAmountDollars: "abc",
      manualFundingMinDollars: "-5",
      manualFundingMaxDollars: "1.234",
      defaultPaymentHoldTimeoutMinutes: "0",
      holdExpiryWarningMinutes: "12.5",
      changeNote: "",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected a rejection");
    expect(parsed.errors.autoReloadMinTriggerDollars).toContain("greater than zero");
    expect(parsed.errors.autoReloadMinAmountDollars).toContain("at most two decimal places");
    expect(parsed.errors.manualFundingMinDollars).toContain("greater than zero");
    expect(parsed.errors.manualFundingMaxDollars).toContain("at most two decimal places");
    expect(parsed.errors.defaultPaymentHoldTimeoutMinutes).toBe(
      "Payment hold timeout must be a whole number of minutes greater than zero.",
    );
    expect(parsed.errors.holdExpiryWarningMinutes).toBe(
      "Hold expiry warning must be a whole number of minutes greater than zero.",
    );
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

  it("holds the payment hold timeout to the 30-day ceiling the database enforces", () => {
    expect(DROPSHIP_WALLET_POLICY_MAX_HOLD_TIMEOUT_MINUTES).toBe(43_200);
    expect(parseDropshipWalletPolicyForm(baselineForm({
      defaultPaymentHoldTimeoutMinutes: "43200",
    })).success).toBe(true);
    const parsed = parseDropshipWalletPolicyForm(baselineForm({
      defaultPaymentHoldTimeoutMinutes: "43201",
    }));
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected a rejection");
    expect(parsed.errors.defaultPaymentHoldTimeoutMinutes).toBe(
      "Payment hold timeout cannot exceed 43,200 minutes (30 days).",
    );
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
      "Minimum single top-up limit must be at least the minimum floor, otherwise a top-up can never clear the trigger.";
    expect(dropshipWalletPolicyInvariantViolations({
      ...LIMITS,
      autoReloadMinAmountCents: 4_999,
    })).toEqual([{ field: "autoReloadMinAmountCents", message }]);

    const parsed = parseDropshipWalletPolicyForm(baselineForm({
      autoReloadMinAmountDollars: "49.99",
    }));
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected a rejection");
    expect(parsed.errors.autoReloadMinAmountDollars).toBe(message);
  });

  it("states the warning-inside-the-hold rule in the server's own words", () => {
    const message = "Hold expiry warning window must be shorter than the payment hold timeout.";
    expect(dropshipWalletPolicyInvariantViolations({
      ...LIMITS,
      holdExpiryWarningMinutes: LIMITS.defaultPaymentHoldTimeoutMinutes,
    })).toEqual([{ field: "holdExpiryWarningMinutes", message }]);

    const parsed = parseDropshipWalletPolicyForm(baselineForm({
      holdExpiryWarningMinutes: "2880",
    }));
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected a rejection");
    expect(parsed.errors.holdExpiryWarningMinutes).toBe(message);
  });

  it("reports every cross-field violation at once instead of the first", () => {
    expect(dropshipWalletPolicyInvariantViolations({
      autoReloadMinTriggerCents: 10_000,
      autoReloadMinAmountCents: 5_000,
      manualFundingMinCents: 900_000,
      manualFundingMaxCents: 1_000,
      defaultPaymentHoldTimeoutMinutes: 60,
      holdExpiryWarningMinutes: 60,
    }).map((violation) => violation.field)).toEqual([
      "manualFundingMaxCents",
      "autoReloadMinAmountCents",
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
      baselineForm({ autoReloadMinTriggerDollars: "50" }),
      LIMITS,
    )).toBe(false);
    expect(isDropshipWalletPolicyFormDirty(
      baselineForm({ changeNote: "Raising the floor next week." }),
      LIMITS,
    )).toBe(false);
    expect(isDropshipWalletPolicyFormDirty(
      baselineForm({ autoReloadMinTriggerDollars: "50.01" }),
      LIMITS,
    )).toBe(true);
    expect(isDropshipWalletPolicyFormDirty(
      baselineForm({ holdExpiryWarningMinutes: "121" }),
      LIMITS,
    )).toBe(true);
    expect(isDropshipWalletPolicyFormDirty(
      baselineForm({ manualFundingMinDollars: "" }),
      LIMITS,
    )).toBe(true);
  });

  it("identifies a set of limits so a version published elsewhere resets the form", () => {
    expect(dropshipWalletPolicyLimitsKey(LIMITS)).toBe(
      "autoReloadMinTriggerCents=5000|autoReloadMinAmountCents=10000"
      + "|manualFundingMinCents=1000|manualFundingMaxCents=500000"
      + "|defaultPaymentHoldTimeoutMinutes=2880|holdExpiryWarningMinutes=120",
    );
    expect(dropshipWalletPolicyLimitsKey({ ...LIMITS, holdExpiryWarningMinutes: 121 }))
      .not.toBe(dropshipWalletPolicyLimitsKey(LIMITS));
  });

  it("only proposes minimums when a minimum actually moved", () => {
    expect(dropshipWalletPolicyProposedMinimums(baselineForm(), LIMITS)).toBeNull();
    expect(dropshipWalletPolicyProposedMinimums(
      baselineForm({ manualFundingMaxDollars: "9000.00" }),
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
    )).toEqual({ autoReloadMinTriggerCents: 5_000, autoReloadMinAmountCents: 25_000 });
  });

  it("builds the overview URL with only the proposed minimums the server accepts", () => {
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
      "autoReloadMinAmountCents",
      "autoReloadMinTriggerCents",
      "changeNote",
      "defaultPaymentHoldTimeoutMinutes",
      "holdExpiryWarningMinutes",
      "idempotencyKey",
      "manualFundingMaxCents",
      "manualFundingMinCents",
    ]);
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

  it("names the source of each value, including the hold timeout with no environment variable", () => {
    expect(dropshipWalletPolicySourceLabel("policy", "DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS"))
      .toBe("Published policy version");
    expect(dropshipWalletPolicySourceLabel("environment", "DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS"))
      .toBe("Environment variable DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS");
    expect(dropshipWalletPolicySourceLabel("environment", null))
      .toBe("Schema default (no environment variable exists)");
    expect(dropshipWalletPolicyEnvLabel(null)).toBe("Schema default (no environment variable exists)");
    expect(dropshipWalletPolicyEnvLabel("DROPSHIP_CARD_FUNDING_FEE_BPS"))
      .toBe("DROPSHIP_CARD_FUNDING_FEE_BPS");
  });

  it("formats the read-only card fee rate with integer math", () => {
    expect(formatDropshipBasisPoints(290)).toBe("2.90%");
    expect(formatDropshipBasisPoints(5)).toBe("0.05%");
    expect(formatDropshipBasisPoints(10_000)).toBe("100.00%");
  });

  it("refuses a response it cannot verify instead of rendering a guess", () => {
    const overview = {
      policy: null,
      limits: LIMITS,
      limitsSource: "environment",
      envLimits: LIMITS,
      envKeys: {
        autoReloadMinTriggerCents: "DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS",
        autoReloadMinAmountCents: "DROPSHIP_AUTO_RELOAD_MIN_AMOUNT_CENTS",
        manualFundingMinCents: "DROPSHIP_STRIPE_MIN_WALLET_FUNDING_CENTS",
        manualFundingMaxCents: "DROPSHIP_STRIPE_MAX_WALLET_FUNDING_CENTS",
        defaultPaymentHoldTimeoutMinutes: null,
        holdExpiryWarningMinutes: "DROPSHIP_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES",
      },
      cardFundingFee: {
        bps: 290,
        envKey: "DROPSHIP_CARD_FUNDING_FEE_BPS",
        editable: false,
        readOnlyReason: "Vendors agreed to the live rate.",
      },
      impact: {
        proposedAutoReloadMinTriggerCents: 5_000,
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
    expect(() => parseDropshipWalletPolicyMutation({ idempotentReplay: true }))
      .toThrow(/wallet policy save response was not in the expected shape/);
  });
});
