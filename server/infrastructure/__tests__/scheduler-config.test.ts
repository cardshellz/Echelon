import { describe, expect, it } from "vitest";
import {
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

  it("requires exact true for boolean flags", () => {
    expect(envFlagEnabled("FLAG", { FLAG: "true" })).toBe(true);
    expect(envFlagEnabled("FLAG", { FLAG: "TRUE" })).toBe(false);
  });
});
