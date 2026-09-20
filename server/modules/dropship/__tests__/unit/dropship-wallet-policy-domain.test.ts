import { describe, expect, it } from "vitest";
import {
  DROPSHIP_WALLET_POLICY_ENV_KEYS,
  parsePositiveEnvInteger,
  resolveDropshipWalletPolicyLimitsFromEnv,
  walletPolicyInvariantViolations,
  type DropshipWalletPolicyLimits,
} from "../../domain/wallet-policy";

/** The values the launch environment defaults to, and what migration 0681 seeds. */
const launchDefaults: DropshipWalletPolicyLimits = {
  autoReloadMinTriggerCents: 5_000,
  autoReloadMinAmountCents: 10_000,
  manualFundingMinCents: 1_000,
  manualFundingMaxCents: 500_000,
  defaultPaymentHoldTimeoutMinutes: 2_880,
  holdExpiryWarningMinutes: 120,
};

describe("resolveDropshipWalletPolicyLimitsFromEnv", () => {
  it("serves the documented defaults on an empty environment", () => {
    expect(resolveDropshipWalletPolicyLimitsFromEnv({})).toEqual(launchDefaults);
  });

  it("honours every env override it documents", () => {
    expect(resolveDropshipWalletPolicyLimitsFromEnv({
      DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS: "7500",
      DROPSHIP_AUTO_RELOAD_MIN_AMOUNT_CENTS: "20000",
      DROPSHIP_STRIPE_MIN_WALLET_FUNDING_CENTS: "2500",
      DROPSHIP_STRIPE_MAX_WALLET_FUNDING_CENTS: "250000",
      DROPSHIP_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES: "45",
    })).toEqual({
      autoReloadMinTriggerCents: 7_500,
      autoReloadMinAmountCents: 20_000,
      manualFundingMinCents: 2_500,
      manualFundingMaxCents: 250_000,
      // No env override exists for the hold timeout; it is the schema default.
      defaultPaymentHoldTimeoutMinutes: 2_880,
      holdExpiryWarningMinutes: 45,
    });
    expect(DROPSHIP_WALLET_POLICY_ENV_KEYS.defaultPaymentHoldTimeoutMinutes).toBeNull();
  });

  it("falls back to the defaults for values that are not positive integers", () => {
    for (const bad of ["0", "-100", "abc", "12.5", "", "   "]) {
      expect(resolveDropshipWalletPolicyLimitsFromEnv({
        DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS: bad,
        DROPSHIP_AUTO_RELOAD_MIN_AMOUNT_CENTS: bad,
        DROPSHIP_STRIPE_MIN_WALLET_FUNDING_CENTS: bad,
        DROPSHIP_STRIPE_MAX_WALLET_FUNDING_CENTS: bad,
        DROPSHIP_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES: bad,
      })).toEqual(launchDefaults);
    }
  });

  it("does not read ambient process state when an environment is supplied", () => {
    process.env.DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS = "999999";
    try {
      expect(resolveDropshipWalletPolicyLimitsFromEnv({}).autoReloadMinTriggerCents).toBe(5_000);
    } finally {
      delete process.env.DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS;
    }
  });
});

describe("parsePositiveEnvInteger", () => {
  it("accepts a positive integer and rejects everything else", () => {
    expect(parsePositiveEnvInteger("42", 7)).toBe(42);
    expect(parsePositiveEnvInteger(undefined, 7)).toBe(7);
    expect(parsePositiveEnvInteger("0", 7)).toBe(7);
    expect(parsePositiveEnvInteger("-1", 7)).toBe(7);
    expect(parsePositiveEnvInteger("1.5", 7)).toBe(7);
    expect(parsePositiveEnvInteger("  ", 7)).toBe(7);
  });
});

describe("walletPolicyInvariantViolations", () => {
  it("passes the launch defaults", () => {
    expect(walletPolicyInvariantViolations(launchDefaults)).toEqual([]);
  });

  it("refuses a manual minimum above the manual maximum", () => {
    expect(walletPolicyInvariantViolations({
      ...launchDefaults,
      manualFundingMinCents: 600_000,
    })).toEqual([
      expect.objectContaining({ field: "manualFundingMaxCents" }),
    ]);
  });

  it("refuses a top-up limit that can never clear the trigger", () => {
    expect(walletPolicyInvariantViolations({
      ...launchDefaults,
      autoReloadMinTriggerCents: 20_000,
      autoReloadMinAmountCents: 10_000,
    })).toEqual([
      expect.objectContaining({ field: "autoReloadMinAmountCents" }),
    ]);
  });

  it("allows a top-up limit exactly equal to the trigger floor", () => {
    expect(walletPolicyInvariantViolations({
      ...launchDefaults,
      autoReloadMinTriggerCents: 10_000,
      autoReloadMinAmountCents: 10_000,
    })).toEqual([]);
  });

  it("refuses a warning window that is not strictly inside the hold", () => {
    for (const warning of [2_880, 5_000]) {
      expect(walletPolicyInvariantViolations({
        ...launchDefaults,
        holdExpiryWarningMinutes: warning,
      })).toEqual([
        expect.objectContaining({ field: "holdExpiryWarningMinutes" }),
      ]);
    }
    expect(walletPolicyInvariantViolations({
      ...launchDefaults,
      holdExpiryWarningMinutes: 2_879,
    })).toEqual([]);
  });

  it("reports every violation at once so staff fix one form", () => {
    const violations = walletPolicyInvariantViolations({
      autoReloadMinTriggerCents: 20_000,
      autoReloadMinAmountCents: 10_000,
      manualFundingMinCents: 9_000,
      manualFundingMaxCents: 8_000,
      defaultPaymentHoldTimeoutMinutes: 60,
      holdExpiryWarningMinutes: 60,
    });
    expect(violations.map((violation) => violation.field).sort()).toEqual([
      "autoReloadMinAmountCents",
      "holdExpiryWarningMinutes",
      "manualFundingMaxCents",
    ]);
  });
});
