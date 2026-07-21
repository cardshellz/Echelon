import { describe, expect, it } from "vitest";
import {
  envBoundedPositiveInteger,
  envFlagEnabled,
  envPositiveInteger,
  getSchedulerDisableReason,
  schedulerIsDisabled,
} from "../scheduler-config";

describe("scheduler-config", () => {
  it("treats DISABLE_SCHEDULERS as the global emergency brake", () => {
    const env = { DISABLE_SCHEDULERS: "true" };

    expect(schedulerIsDisabled("SHOPIFY_BRIDGE_LISTENER_DISABLED", env)).toBe(true);
    expect(getSchedulerDisableReason("SHOPIFY_BRIDGE_LISTENER_DISABLED", env)).toBe("DISABLE_SCHEDULERS=true");
  });

  it("supports individual scheduler disable flags", () => {
    const env = { BILLING_SCHEDULER_DISABLED: "true" };

    expect(schedulerIsDisabled("BILLING_SCHEDULER_DISABLED", env)).toBe(true);
    expect(schedulerIsDisabled("SHOPIFY_BRIDGE_LISTENER_DISABLED", env)).toBe(false);
  });

  it("parses positive integer config with a safe fallback", () => {
    expect(envPositiveInteger("LIMIT", 25, { LIMIT: "50" })).toBe(50);
    expect(envPositiveInteger("LIMIT", 25, { LIMIT: "0" })).toBe(25);
    expect(envPositiveInteger("LIMIT", 25, { LIMIT: "abc" })).toBe(25);
  });

  it("parses bounded positive integer config with a safe fallback", () => {
    expect(envBoundedPositiveInteger("LIMIT", 100, 500, { LIMIT: "250" })).toBe(250);
    expect(envBoundedPositiveInteger("LIMIT", 100, 500, { LIMIT: "501" })).toBe(100);
    expect(envBoundedPositiveInteger("LIMIT", 100, 500, { LIMIT: "0" })).toBe(100);
    expect(envBoundedPositiveInteger("LIMIT", 100, 500, { LIMIT: "abc" })).toBe(100);
  });

  it("rejects invalid bounded integer defaults", () => {
    expect(() => envBoundedPositiveInteger("LIMIT", 501, 500, {})).toThrow(
      "Fallback for LIMIT must be an integer between 1 and 500",
    );
  });

  it("requires exact true for boolean flags", () => {
    expect(envFlagEnabled("FLAG", { FLAG: "true" })).toBe(true);
    expect(envFlagEnabled("FLAG", { FLAG: "TRUE" })).toBe(false);
  });
});
