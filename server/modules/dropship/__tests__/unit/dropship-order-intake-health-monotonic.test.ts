import { describe, expect, it } from "vitest";
import {
  deriveDropshipOrderIntakePollFailed,
  deriveDropshipOrderIntakePollStale,
  type DropshipOrderIntakeHealthPolicy,
  type DropshipOrderIntakeHealthRecord,
} from "../../domain/dropship-order-intake-health";

const now = new Date("2026-08-25T14:00:00.000Z");
const policy: DropshipOrderIntakeHealthPolicy = {
  degradedAfterFailures: 2,
  stoppedAfterFailures: 6,
  degradedAfterMs: 15 * 60_000,
  stoppedAfterMs: 30 * 60_000,
};

describe("dropship order-intake outage severity", () => {
  it("does not downgrade a stopped stale heartbeat when the next retry also fails", () => {
    const stopped = makeHealth({
      status: "stopped",
      consecutiveFailures: 0,
      lastAttemptAt: new Date(now.getTime() - 31 * 60_000),
      lastFailureAt: new Date(now.getTime() - 60_000),
      lastFailureCode: "DROPSHIP_ORDER_INTAKE_STALE",
      lastFailureMessage: "No heartbeat for 31 minutes.",
    });

    const retried = deriveDropshipOrderIntakePollFailed({
      current: stopped,
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      mode: "poll",
      failureCode: "EBAY_UNAVAILABLE",
      failureMessage: "provider unavailable",
      now,
      policy,
    });

    expect(retried).toMatchObject({
      previousStatus: "stopped",
      transitioned: false,
      current: {
        status: "stopped",
        consecutiveFailures: 1,
        lastFailureCode: "EBAY_UNAVAILABLE",
      },
    });
    expect(retried.current.statusChangedAt).toEqual(stopped.statusChangedAt);
  });

  it("does not let a shorter stale threshold downgrade an already stopped store", () => {
    const stopped = makeHealth({
      status: "stopped",
      lastAttemptAt: new Date(now.getTime() - 16 * 60_000),
      lastFailureAt: new Date(now.getTime() - 60_000),
      lastFailureCode: "EBAY_UNAVAILABLE",
      lastFailureMessage: "provider unavailable",
    });

    expect(deriveDropshipOrderIntakePollStale({
      current: stopped,
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      mode: "poll",
      observedSince: new Date(now.getTime() - 60 * 60_000),
      now,
      policy,
    })).toBeNull();
  });
});

function makeHealth(overrides: Partial<DropshipOrderIntakeHealthRecord>): DropshipOrderIntakeHealthRecord {
  return {
    vendorId: 10,
    storeConnectionId: 22,
    platform: "ebay",
    mode: "poll",
    status: "healthy",
    consecutiveFailures: 0,
    lastAttemptAt: now,
    lastSuccessAt: now,
    lastFailureAt: null,
    lastFailureCode: null,
    lastFailureMessage: null,
    statusChangedAt: new Date(now.getTime() - 60_000),
    createdAt: new Date(now.getTime() - 60 * 60_000),
    updatedAt: new Date(now.getTime() - 60_000),
    ...overrides,
  };
}
