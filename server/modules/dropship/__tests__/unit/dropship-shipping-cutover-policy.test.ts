import { describe, expect, it } from "vitest";
import {
  readDropshipShippingCutoverConfig,
  resolveDropshipShippingCutover,
} from "../../application/dropship-shipping-cutover-policy";

describe("dropship shipping cutover policy", () => {
  it("defaults to legacy pricing", () => {
    const config = readDropshipShippingCutoverConfig({});

    expect(config).toMatchObject({
      policy: { mode: "legacy" },
      configurationError: null,
    });
    expect(resolveDropshipShippingCutover(config.policy, 22)).toEqual({
      source: "legacy",
      mode: "legacy",
      reasonCode: "LEGACY_MODE",
    });
  });

  it("fails back to legacy when mode or store IDs are invalid", () => {
    const invalidMode = readDropshipShippingCutoverConfig({
      DROPSHIP_SHARED_SHIPPING_CUTOVER_MODE: "enabled",
    });
    const invalidIds = readDropshipShippingCutoverConfig({
      DROPSHIP_SHARED_SHIPPING_CUTOVER_MODE: "test",
      DROPSHIP_SHARED_SHIPPING_CUTOVER_STORE_CONNECTION_IDS: "22,nope",
    });

    expect(invalidMode.policy.mode).toBe("legacy");
    expect(invalidMode.configurationError).toContain(
      "must be legacy, test, or live",
    );
    expect(invalidIds.policy.mode).toBe("legacy");
    expect(invalidIds.configurationError).toContain(
      "positive integer IDs",
    );
  });

  it("requires and normalizes an explicit test-store allowlist", () => {
    const missing = readDropshipShippingCutoverConfig({
      DROPSHIP_SHARED_SHIPPING_CUTOVER_MODE: "test",
    });
    const configured = readDropshipShippingCutoverConfig({
      DROPSHIP_SHARED_SHIPPING_CUTOVER_MODE: " TEST ",
      DROPSHIP_SHARED_SHIPPING_CUTOVER_STORE_CONNECTION_IDS: "22, 23,22",
    });

    expect(missing.policy.mode).toBe("legacy");
    expect(missing.configurationError).toContain(
      "requires at least one store connection ID",
    );
    expect(Array.from(configured.policy.storeConnectionIds)).toEqual([22, 23]);
    expect(resolveDropshipShippingCutover(configured.policy, 22)).toEqual({
      source: "shared",
      mode: "test",
      reasonCode: "TEST_STORE_ALLOWED",
    });
    expect(resolveDropshipShippingCutover(configured.policy, 24)).toEqual({
      source: "legacy",
      mode: "test",
      reasonCode: "TEST_STORE_NOT_ALLOWED",
    });
  });

  it("routes every store to shared pricing only in live mode", () => {
    const config = readDropshipShippingCutoverConfig({
      DROPSHIP_SHARED_SHIPPING_CUTOVER_MODE: "live",
    });

    expect(resolveDropshipShippingCutover(config.policy, 999)).toEqual({
      source: "shared",
      mode: "live",
      reasonCode: "LIVE_ENABLED",
    });
  });
});
