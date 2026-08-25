import { describe, expect, it } from "vitest";
import { dropshipOrderIntakeHealthPolicyFromEnv } from "../../infrastructure/dropship-order-intake-health.factory";

describe("dropshipOrderIntakeHealthPolicyFromEnv", () => {
  it("uses conservative launch defaults", () => {
    expect(dropshipOrderIntakeHealthPolicyFromEnv({})).toEqual({
      degradedAfterFailures: 2,
      stoppedAfterFailures: 6,
      degradedAfterMs: 15 * 60_000,
      stoppedAfterMs: 30 * 60_000,
    });
  });

  it("accepts explicit ordered thresholds", () => {
    expect(dropshipOrderIntakeHealthPolicyFromEnv({
      DROPSHIP_ORDER_INTAKE_DEGRADED_AFTER_FAILURES: "3",
      DROPSHIP_ORDER_INTAKE_STOPPED_AFTER_FAILURES: "8",
      DROPSHIP_ORDER_INTAKE_DEGRADED_AFTER_MINUTES: "20",
      DROPSHIP_ORDER_INTAKE_STOPPED_AFTER_MINUTES: "45",
    })).toEqual({
      degradedAfterFailures: 3,
      stoppedAfterFailures: 8,
      degradedAfterMs: 20 * 60_000,
      stoppedAfterMs: 45 * 60_000,
    });
  });

  it("rejects malformed and non-increasing thresholds", () => {
    expect(() => dropshipOrderIntakeHealthPolicyFromEnv({
      DROPSHIP_ORDER_INTAKE_DEGRADED_AFTER_FAILURES: "2.5",
    })).toThrow("Invalid positive integer");
    expect(() => dropshipOrderIntakeHealthPolicyFromEnv({
      DROPSHIP_ORDER_INTAKE_DEGRADED_AFTER_FAILURES: "4",
      DROPSHIP_ORDER_INTAKE_STOPPED_AFTER_FAILURES: "4",
    })).toThrow("must exceed");
    expect(() => dropshipOrderIntakeHealthPolicyFromEnv({
      DROPSHIP_ORDER_INTAKE_DEGRADED_AFTER_MINUTES: "30",
      DROPSHIP_ORDER_INTAKE_STOPPED_AFTER_MINUTES: "20",
    })).toThrow("must exceed");
  });
});
