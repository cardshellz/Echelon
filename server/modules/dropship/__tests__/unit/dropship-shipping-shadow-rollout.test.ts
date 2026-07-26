import { describe, expect, it } from "vitest";
import {
  readDropshipShippingShadowRolloutConfig,
  shouldShadowDropshipShippingQuote,
} from "../../application/dropship-shipping-shadow-rollout";

describe("dropship shared shipping shadow rollout", () => {
  it("defaults off", () => {
    const config = readDropshipShippingShadowRolloutConfig({});

    expect(config.configurationError).toBeNull();
    expect(config.policy.mode).toBe("off");
    expect(shouldShadowDropshipShippingQuote(config.policy, 22)).toBe(false);
  });

  it("limits test mode to configured store connections", () => {
    const config = readDropshipShippingShadowRolloutConfig({
      DROPSHIP_SHARED_SHIPPING_SHADOW_MODE: "test",
      DROPSHIP_SHARED_SHIPPING_SHADOW_STORE_CONNECTION_IDS: "22, 23,22",
    });

    expect(config.configurationError).toBeNull();
    expect(shouldShadowDropshipShippingQuote(config.policy, 22)).toBe(true);
    expect(shouldShadowDropshipShippingQuote(config.policy, 24)).toBe(false);
    expect(shouldShadowDropshipShippingQuote(config.policy, null)).toBe(false);
  });

  it("fails closed on invalid or empty test configuration", () => {
    const invalidMode = readDropshipShippingShadowRolloutConfig({
      DROPSHIP_SHARED_SHIPPING_SHADOW_MODE: "maybe",
    });
    const emptyTest = readDropshipShippingShadowRolloutConfig({
      DROPSHIP_SHARED_SHIPPING_SHADOW_MODE: "test",
    });
    const invalidIds = readDropshipShippingShadowRolloutConfig({
      DROPSHIP_SHARED_SHIPPING_SHADOW_MODE: "test",
      DROPSHIP_SHARED_SHIPPING_SHADOW_STORE_CONNECTION_IDS: "22,nope",
    });

    expect(invalidMode.policy.mode).toBe("off");
    expect(emptyTest.policy.mode).toBe("off");
    expect(invalidIds.policy.mode).toBe("off");
    expect(invalidMode.configurationError).toContain("must be off, test, or all");
    expect(emptyTest.configurationError).toContain("requires at least one");
    expect(invalidIds.configurationError).toContain("positive integer");
  });

  it("allows every valid store in all mode", () => {
    const config = readDropshipShippingShadowRolloutConfig({
      DROPSHIP_SHARED_SHIPPING_SHADOW_MODE: "ALL",
    });

    expect(shouldShadowDropshipShippingQuote(config.policy, 1)).toBe(true);
  });
});
