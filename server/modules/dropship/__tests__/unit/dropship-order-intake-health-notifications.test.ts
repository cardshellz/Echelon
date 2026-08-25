import { describe, expect, it, vi } from "vitest";
import {
  DropshipOrderIntakeHealthService,
  type DropshipOrderIntakeHealthRepository,
  type DropshipOrderIntakeHealthRepositoryResult,
} from "../../application/dropship-order-intake-health-service";
import { DROPSHIP_NOTIFICATION_EVENTS } from "../../application/dropship-notification-events";
import type {
  DropshipOrderIntakeHealthPolicy,
  DropshipOrderIntakeHealthStatus,
} from "../../domain/dropship-order-intake-health";

const now = new Date("2026-08-25T14:00:00.000Z");
const policy: DropshipOrderIntakeHealthPolicy = {
  degradedAfterFailures: 2,
  stoppedAfterFailures: 6,
  degradedAfterMs: 15 * 60_000,
  stoppedAfterMs: 30 * 60_000,
};

describe("DropshipOrderIntakeHealthService outage notifications", () => {
  it("sends mandatory email and in-app alerts when intake stops", async () => {
    const stopped = makeResult("stopped", "degraded", "poll_failed");
    const notificationSender = { send: vi.fn(async () => ({})) };
    const service = makeService({
      repository: fakeRepository({ failed: stopped }),
      notificationSender,
    });

    await service.recordPollFailed({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      failureCode: "EBAY_UNAVAILABLE",
      failureMessage: "provider unavailable",
    });

    expect(notificationSender.send).toHaveBeenCalledWith(expect.objectContaining({
      eventType: DROPSHIP_NOTIFICATION_EVENTS.ORDER_INTAKE_STOPPED,
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship order intake has stopped",
    }));
  });

  it("alerts on stale-heartbeat degradation and preserves heartbeat evidence in the payload", async () => {
    const stale = makeResult("degraded", "healthy", "poll_stale");
    stale.transition.current.consecutiveFailures = 0;
    stale.transition.current.lastFailureCode = "DROPSHIP_ORDER_INTAKE_STALE";
    stale.transition.current.lastFailureMessage = "No heartbeat for 16 minutes.";
    const notificationSender = { send: vi.fn(async () => ({})) };
    const service = makeService({
      repository: fakeRepository({ stale: [stale] }),
      notificationSender,
    });

    const result = await service.monitorStalePolls({ platform: "ebay", limit: 100 });

    expect(result.storesTransitioned).toBe(1);
    expect(notificationSender.send).toHaveBeenCalledWith(expect.objectContaining({
      eventType: DROPSHIP_NOTIFICATION_EVENTS.ORDER_INTAKE_DEGRADED,
      critical: true,
      payload: expect.objectContaining({
        consecutiveFailures: 0,
        failureCode: "DROPSHIP_ORDER_INTAKE_STALE",
      }),
    }));
  });
});

function makeService(input: {
  repository: DropshipOrderIntakeHealthRepository;
  notificationSender: { send: ReturnType<typeof vi.fn> };
}) {
  return new DropshipOrderIntakeHealthService({
    ...input,
    clock: { now: () => now },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    policy,
  });
}

function fakeRepository(input: {
  failed?: DropshipOrderIntakeHealthRepositoryResult;
  stale?: DropshipOrderIntakeHealthRepositoryResult[];
}): DropshipOrderIntakeHealthRepository {
  return {
    recordPollSucceeded: vi.fn(async () => makeResult("healthy", "degraded", "poll_succeeded")),
    recordPollFailed: vi.fn(async () => input.failed ?? makeResult("warning", "healthy", "poll_failed")),
    recordStalePolls: vi.fn(async () => input.stale ?? []),
  };
}

function makeResult(
  status: DropshipOrderIntakeHealthStatus,
  previousStatus: DropshipOrderIntakeHealthStatus | null,
  reason: "poll_succeeded" | "poll_failed" | "poll_stale",
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
      transitioned: true,
      reason,
      current: {
        vendorId: 10,
        storeConnectionId: 22,
        platform: "ebay",
        mode: "poll",
        status,
        consecutiveFailures: status === "stopped" ? 6 : status === "healthy" ? 0 : 2,
        lastAttemptAt: now,
        lastSuccessAt: status === "healthy" ? now : new Date(now.getTime() - 60_000),
        lastFailureAt: status === "healthy" ? null : now,
        lastFailureCode: status === "healthy" ? null : "EBAY_UNAVAILABLE",
        lastFailureMessage: status === "healthy" ? null : "provider unavailable",
        statusChangedAt: now,
        createdAt: new Date(now.getTime() - 60_000),
        updatedAt: now,
      },
    },
  };
}
