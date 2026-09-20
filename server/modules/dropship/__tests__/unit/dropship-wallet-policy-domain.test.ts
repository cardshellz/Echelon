import { describe, expect, it } from "vitest";
import {
  DROPSHIP_WALLET_POLICY_ENV_KEYS,
  parsePositiveEnvInteger,
  resolveDropshipWalletPolicyLimitsFromEnv,
  walletPolicyInvariantViolations,
  type DropshipWalletPolicyLimits,
} from "../../domain/wallet-policy";

/**
 * The documented fallback: what an environment with no overrides resolves to,
 * and what migration 0683 publishes as version 2 (owner decision, 2026-09-20).
 */
const launchDefaults: DropshipWalletPolicyLimits = {
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
      ...launchDefaults,
      autoReloadMinTriggerCents: 7_500,
      autoReloadMinAmountCents: 20_000,
      manualFundingMinCents: 2_500,
      manualFundingMaxCents: 250_000,
      holdExpiryWarningMinutes: 45,
    });
    // The hold timeout, the case tier, the advance and the grace have no
    // environment override: the policy row is the only way to move them.
    expect(DROPSHIP_WALLET_POLICY_ENV_KEYS.defaultPaymentHoldTimeoutMinutes).toBeNull();
    expect(DROPSHIP_WALLET_POLICY_ENV_KEYS.caseTierMinimumCents).toBeNull();
    expect(DROPSHIP_WALLET_POLICY_ENV_KEYS.advanceFeeBps).toBeNull();
    expect(DROPSHIP_WALLET_POLICY_ENV_KEYS.advanceCapCents).toBeNull();
    expect(DROPSHIP_WALLET_POLICY_ENV_KEYS.tierChangeGraceDays).toBeNull();
  });

  it("raises the case tier with an environment pack floor above it, so the fallback never breaks its own invariant", () => {
    const limits = resolveDropshipWalletPolicyLimitsFromEnv({
      DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS: "75000",
    });
    expect(limits.autoReloadMinTriggerCents).toBe(75_000);
    expect(limits.caseTierMinimumCents).toBe(75_000);
    expect(walletPolicyInvariantViolations(limits)).toEqual([
      // The top-up limit rule still fires: the env did not raise it.
      expect.objectContaining({ field: "autoReloadMinAmountCents" }),
    ]);
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
      expect(resolveDropshipWalletPolicyLimitsFromEnv({}).autoReloadMinTriggerCents).toBe(10_000);
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

  it("refuses a case tier below the pack tier and allows one equal to it", () => {
    expect(walletPolicyInvariantViolations({
      ...launchDefaults,
      caseTierMinimumCents: 9_999,
    })).toEqual([{
      field: "caseTierMinimumCents",
      message: "Case tier minimum must be at least the pack tier minimum.",
    }]);
    expect(walletPolicyInvariantViolations({
      ...launchDefaults,
      caseTierMinimumCents: 10_000,
    })).toEqual([]);
  });

  it("refuses a warning window that is not strictly inside the hold", () => {
    for (const warning of [1_440, 5_000]) {
      expect(walletPolicyInvariantViolations({
        ...launchDefaults,
        holdExpiryWarningMinutes: warning,
      })).toEqual([
        expect.objectContaining({ field: "holdExpiryWarningMinutes" }),
      ]);
    }
    expect(walletPolicyInvariantViolations({
      ...launchDefaults,
      holdExpiryWarningMinutes: 1_439,
    })).toEqual([]);
  });

  it("places no cross-field rule on the advance or the grace: zero is a policy, not an error", () => {
    expect(walletPolicyInvariantViolations({
      ...launchDefaults,
      advanceFeeBps: 0,
      advanceCapCents: 0,
      tierChangeGraceDays: 0,
    })).toEqual([]);
  });

  it("reports every violation at once so staff fix one form", () => {
    const violations = walletPolicyInvariantViolations({
      autoReloadMinTriggerCents: 20_000,
      caseTierMinimumCents: 15_000,
      autoReloadMinAmountCents: 10_000,
      manualFundingMinCents: 9_000,
      manualFundingMaxCents: 8_000,
      defaultPaymentHoldTimeoutMinutes: 60,
      holdExpiryWarningMinutes: 60,
      advanceFeeBps: 100,
      advanceCapCents: 50_000,
      tierChangeGraceDays: 14,
    });
    expect(violations.map((violation) => violation.field).sort()).toEqual([
      "autoReloadMinAmountCents",
      "caseTierMinimumCents",
      "holdExpiryWarningMinutes",
      "manualFundingMaxCents",
    ]);
  });
});
