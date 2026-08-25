import { describe, expect, it, vi } from "vitest";
import {
  DropshipOrderIntakeHealthService,
  type DropshipOrderIntakeHealthRepository,
  type DropshipOrderIntakeHealthRepositoryResult,
} from "../../application/dropship-order-intake-health-service";
import {
  deriveDropshipOrderIntakePollFailed,
  deriveDropshipOrderIntakePollStale,
  deriveDropshipOrderIntakePollSucceeded,
  type DropshipOrderIntakeHealthPolicy,
  type DropshipOrderIntakeHealthRecord,
} from "../../domain/dropship-order-intake-health";
import { DROPSHIP_NOTIFICATION_EVENTS } from "../../application/dropship-notification-events";

const policy: DropshipOrderIntakeHealthPolicy = {
  degradedAfterFailures: 2,
  stoppedAfterFailures: 6,
  degradedAfterMs: 15 * 60_000,
  stoppedAfterMs: 30 * 60_000,
};
const now = new Date("2026-08-25T14:00:00.000Z");

describe("dropship order-intake health domain", () => {
  it("moves one failure to warning, repeated failures to degraded, and sustained failures to stopped", () => {
    let current: DropshipOrderIntakeHealthRecord | null = makeHealthy();
    const statuses: string[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const transition = deriveDropshipOrderIntakePollFailed({
        current,
        vendorId: 10,
        storeConnectionId: 22,
        platform: "ebay",
        mode: "poll",
        failureCode: "EBAY_UNAVAILABLE",
        failureMessage: "provider unavailable",
        now: new Date(now.getTime() + attempt * 60_000),
        policy,
      });
      current = transition.current;
      statuses.push(transition.current.status);
    }

    expect(statuses).toEqual(["warning", "degraded", "degraded", "degraded", "degraded", "stopped"]);
    expect(current).toMatchObject({
      consecutiveFailures: 6,
      lastFailureCode: "EBAY_UNAVAILABLE",
    });
  });

  it("resets failure evidence and records a recovery transition on success", () => {
    const failed = deriveDropshipOrderIntakePollFailed({
      current: makeHealthy(),
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      mode: "poll",
      failureCode: "ONE",
      failureMessage: "one",
      now,
      policy: { ...policy, degradedAfterFailures: 1 },
    });
    const recovered = deriveDropshipOrderIntakePollSucceeded({
      current: failed.current,
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      mode: "poll",
      now: new Date(now.getTime() + 60_000),
    });

    expect(recovered).toMatchObject({ previousStatus: "degraded", transitioned: true });
    expect(recovered.current).toMatchObject({
      status: "healthy",
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastFailureCode: null,
      lastFailureMessage: null,
    });
  });

  it("detects a missing heartbeat without treating a successful zero-order poll as stale", () => {
    const fresh = deriveDropshipOrderIntakePollStale({
      current: makeHealthy(),
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      mode: "poll",
      observedSince: new Date(now.getTime() - 60 * 60_000),
      now,
      policy,
    });
    const stopped = deriveDropshipOrderIntakePollStale({
      current: { ...makeHealthy(), lastAttemptAt: new Date(now.getTime() - 31 * 60_000) },
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      mode: "poll",
      observedSince: new Date(now.getTime() - 60 * 60_000),
      now,
      policy,
    });

    expect(fresh).toBeNull();
    expect(stopped).toMatchObject({
      previousStatus: "healthy",
      transitioned: true,
      reason: "poll_stale",
      current: { status: "stopped", lastFailureCode: "DROPSHIP_ORDER_INTAKE_STALE" },
    });
  });
});

describe("DropshipOrderIntakeHealthService notifications", () => {
  it("emails and records an in-app critical alert only when intake becomes degraded", async () => {
    const result = makeResult("degraded", "warning", true);
    const repository = fakeRepository({ failed: result });
    const notificationSender = { send: vi.fn(async () => ({})) };
    const service = new DropshipOrderIntakeHealthService({
      repository,
      notificationSender,
      clock: { now: () => now },
      logger: nullLogger(),
      policy,
    });

    await service.recordPollFailed({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      failureCode: "EBAY_UNAVAILABLE",
      failureMessage: "provider unavailable",
    });

    expect(notificationSender.send).toHaveBeenCalledWith(expect.objectContaining({
      eventType: DROPSHIP_NOTIFICATION_EVENTS.ORDER_INTAKE_DEGRADED,
      critical: true,
      channels: ["email", "in_app"],
      idempotencyKey: `order-intake-health:22:degraded:${now.toISOString()}`,
    }));
  });

  it("does not email on the first warning or on repeated calls within the same state", async () => {
    const notificationSender = { send: vi.fn(async () => ({})) };
    const service = new DropshipOrderIntakeHealthService({
      repository: fakeRepository({ failed: makeResult("warning", "healthy", true) }),
      notificationSender,
      clock: { now: () => now },
      logger: nullLogger(),
      policy,
    });

    await service.recordPollFailed({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      failureCode: "ONE",
      failureMessage: "one",
    });

    expect(notificationSender.send).not.toHaveBeenCalled();
  });

  it("emails a recovery notice after a degraded or stopped intake returns to healthy", async () => {
    const notificationSender = { send: vi.fn(async () => ({})) };
    const service = new DropshipOrderIntakeHealthService({
      repository: fakeRepository({ succeeded: makeResult("healthy", "stopped", true) }),
      notificationSender,
      clock: { now: () => now },
      logger: nullLogger(),
      policy,
    });

    await service.recordPollSucceeded({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      syncedThrough: now,
    });

    expect(notificationSender.send).toHaveBeenCalledWith(expect.objectContaining({
      eventType: DROPSHIP_NOTIFICATION_EVENTS.ORDER_INTAKE_RECOVERED,
      critical: false,
      channels: ["email", "in_app"],
    }));
  });
});

function makeHealthy(): DropshipOrderIntakeHealthRecord {
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
    statusChangedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function makeResult(
  status: DropshipOrderIntakeHealthRecord["status"],
  previousStatus: DropshipOrderIntakeHealthRecord["status"] | null,
  transitioned: boolean,
): DropshipOrderIntakeHealthRepositoryResult {
  return {
    connection: {
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      externalDisplayName: "marz_cards",
      shopDomain: null,
    },
    transition: {
      previousStatus,
      transitioned,
      reason: status === "healthy" ? "poll_succeeded" : "poll_failed",
      current: {
        ...makeHealthy(),
        status,
        consecutiveFailures: status === "healthy" ? 0 : 2,
        lastFailureAt: status === "healthy" ? null : now,
        lastFailureCode: status === "healthy" ? null : "EBAY_UNAVAILABLE",
        lastFailureMessage: status === "healthy" ? null : "provider unavailable",
      },
    },
  };
}

function fakeRepository(results: {
  succeeded?: DropshipOrderIntakeHealthRepositoryResult;
  failed?: DropshipOrderIntakeHealthRepositoryResult;
}): DropshipOrderIntakeHealthRepository {
  return {
    recordPollSucceeded: vi.fn(async () => results.succeeded ?? makeResult("healthy", null, true)),
    recordPollFailed: vi.fn(async () => results.failed ?? makeResult("warning", "healthy", true)),
    recordStalePolls: vi.fn(async () => []),
  };
}

function nullLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
