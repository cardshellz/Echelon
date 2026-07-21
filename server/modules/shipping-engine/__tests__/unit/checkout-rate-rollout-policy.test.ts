import { describe, expect, it } from "vitest";
import {
  parseCheckoutRateRolloutPolicy,
  resolveCheckoutRateRollout,
} from "../../domain/checkout-rate-rollout-policy";

describe("parseCheckoutRateRolloutPolicy", () => {
  it("defaults to off when no mode is configured", () => {
    const policy = parseCheckoutRateRolloutPolicy({});

    expect(policy.mode).toBe("off");
    expect(policy.invalidConfiguredMode).toBe(false);
    expect(Array.from(policy.testSkus)).toEqual([]);
  });

  it("fails closed when the configured mode is invalid", () => {
    const policy = parseCheckoutRateRolloutPolicy({ mode: "enabled" });

    expect(policy.mode).toBe("off");
    expect(policy.invalidConfiguredMode).toBe(true);
    expect(resolveCheckoutRateRollout(policy, ["SKU-1"])).toMatchObject({
      shouldQuote: false,
      mode: "off",
      reasonCode: "INVALID_MODE_FAIL_CLOSED",
    });
  });

  it("normalizes mode text and trims and deduplicates configured test SKUs", () => {
    const policy = parseCheckoutRateRolloutPolicy({
      mode: " TEST ",
      testSkus: " SKU-1,SKU-2, SKU-1, ,",
    });

    expect(policy.mode).toBe("test");
    expect(policy.invalidConfiguredMode).toBe(false);
    expect(Array.from(policy.testSkus)).toEqual(["SKU-1", "SKU-2"]);
  });
});

describe("resolveCheckoutRateRollout", () => {
  it("blocks every cart while rollout mode is off", () => {
    const decision = resolveCheckoutRateRollout(
      parseCheckoutRateRolloutPolicy({ mode: "off", testSkus: "SKU-1" }),
      ["SKU-1"],
    );

    expect(decision).toMatchObject({
      shouldQuote: false,
      mode: "off",
      reasonCode: "ROLLOUT_DISABLED",
    });
  });

  it("blocks test mode when the allowlist is empty", () => {
    const decision = resolveCheckoutRateRollout(
      parseCheckoutRateRolloutPolicy({ mode: "test" }),
      ["SKU-1"],
    );

    expect(decision).toMatchObject({
      shouldQuote: false,
      mode: "test",
      reasonCode: "TEST_ALLOWLIST_EMPTY",
    });
  });

  it("blocks test mode when any cart line lacks a SKU", () => {
    const decision = resolveCheckoutRateRollout(
      parseCheckoutRateRolloutPolicy({ mode: "test", testSkus: "SKU-1" }),
      ["SKU-1", null],
    );

    expect(decision).toMatchObject({
      shouldQuote: false,
      mode: "test",
      reasonCode: "TEST_CART_SKU_MISSING",
    });
  });

  it("blocks the entire test cart when any SKU is not allowlisted", () => {
    const decision = resolveCheckoutRateRollout(
      parseCheckoutRateRolloutPolicy({ mode: "test", testSkus: "SKU-1" }),
      ["SKU-2", "SKU-1", "SKU-2"],
    );

    expect(decision).toMatchObject({
      shouldQuote: false,
      mode: "test",
      reasonCode: "TEST_CART_SKU_NOT_ALLOWED",
      deniedSkus: ["SKU-2"],
    });
  });

  it("allows test mode only when every cart SKU is exactly allowlisted", () => {
    const decision = resolveCheckoutRateRollout(
      parseCheckoutRateRolloutPolicy({ mode: "test", testSkus: "SKU-1,SKU-2" }),
      ["SKU-1", "SKU-2"],
    );

    expect(decision).toMatchObject({
      shouldQuote: true,
      mode: "test",
      reasonCode: "TEST_CART_ALLOWED",
    });
  });

  it("allows live mode without applying the test SKU allowlist", () => {
    const decision = resolveCheckoutRateRollout(
      parseCheckoutRateRolloutPolicy({ mode: "live" }),
      [null, "CUSTOMER-SKU"],
    );

    expect(decision).toMatchObject({
      shouldQuote: true,
      mode: "live",
      reasonCode: "LIVE_ENABLED",
    });
  });
});
