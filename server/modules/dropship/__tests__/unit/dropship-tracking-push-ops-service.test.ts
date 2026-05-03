import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import type {
  DropshipTrackingPushOpsListResult,
  DropshipTrackingPushOpsRepository,
  DropshipTrackingPushRetryRequest,
} from "../../application/dropship-tracking-push-ops-service";
import { DropshipTrackingPushOpsService } from "../../application/dropship-tracking-push-ops-service";

describe("DropshipTrackingPushOpsService", () => {
  it("lists attention pushes by default", async () => {
    const repository = new FakeTrackingPushOpsRepository();
    const service = makeService(repository);

    const result = await service.listPushes({ page: 1, limit: 25 });

    expect(result.statuses).toEqual(["failed", "processing", "queued"]);
    expect(repository.inputs[0]).toMatchObject({
      statuses: ["failed", "processing", "queued"],
      page: 1,
      limit: 25,
    });
  });

  it("preserves explicit filters for ops search", async () => {
    const repository = new FakeTrackingPushOpsRepository();
    const service = makeService(repository);

    await service.listPushes({
      statuses: ["succeeded"],
      vendorId: 12,
      storeConnectionId: 34,
      platform: "shopify",
      search: "9400",
      page: 2,
      limit: 10,
    });

    expect(repository.inputs[0]).toEqual({
      statuses: ["succeeded"],
      vendorId: 12,
      storeConnectionId: 34,
      platform: "shopify",
      search: "9400",
      page: 2,
      limit: 10,
    });
  });

  it("rejects invalid statuses before the repository is called", async () => {
    const repository = new FakeTrackingPushOpsRepository();
    const service = makeService(repository);

    await expect(service.listPushes({ statuses: ["completed"] })).rejects.toMatchObject({
      code: "DROPSHIP_TRACKING_PUSH_OPS_LIST_INVALID_INPUT",
    });
    expect(repository.inputs).toHaveLength(0);
  });

  it("retries failed pushes through the marketplace tracking service", async () => {
    const repository = new FakeTrackingPushOpsRepository();
    const marketplaceTracking = new FakeMarketplaceTrackingService();
    const service = makeService(repository, marketplaceTracking);

    const result = await service.retryPush({
      pushId: 42,
      idempotencyKey: "admin-retry-42",
      reason: "temporary marketplace outage",
      actor: { actorType: "admin", actorId: "ops-user" },
    });

    expect(repository.retryInputs[0]).toMatchObject({
      pushId: 42,
      idempotencyKey: "admin-retry-42",
      reason: "temporary marketplace outage",
      actor: { actorType: "admin", actorId: "ops-user" },
      now: new Date("2026-05-03T12:00:00.000Z"),
    });
    expect(marketplaceTracking.inputs[0]).toEqual({
      omsOrderId: 500,
      wmsShipmentId: 700,
      carrier: "USPS",
      trackingNumber: "94001111",
      shippedAt: new Date("2026-05-02T10:00:00.000Z"),
      idempotencyKey: "tracking-existing-key",
    });
    expect(result).toMatchObject({
      pushId: 42,
      previousStatus: "failed",
      status: "succeeded",
      idempotentReplay: false,
    });
  });

  it("rejects invalid retry input before changing repository state", async () => {
    const repository = new FakeTrackingPushOpsRepository();
    const marketplaceTracking = new FakeMarketplaceTrackingService();
    const service = makeService(repository, marketplaceTracking);

    await expect(service.retryPush({
      pushId: 42,
      idempotencyKey: "short",
      actor: { actorType: "admin" },
    })).rejects.toMatchObject({
      code: "DROPSHIP_TRACKING_PUSH_OPS_RETRY_INVALID_INPUT",
    });
    expect(repository.retryInputs).toHaveLength(0);
    expect(marketplaceTracking.inputs).toHaveLength(0);
  });

  it("marks a prepared retry failed when the marketplace claim rejects", async () => {
    const repository = new FakeTrackingPushOpsRepository();
    const marketplaceTracking = new FakeMarketplaceTrackingService();
    marketplaceTracking.error = new DropshipError(
      "DROPSHIP_TRACKING_IDEMPOTENCY_CONFLICT",
      "Request changed.",
      { retryable: false },
    );
    const service = makeService(repository, marketplaceTracking);

    await expect(service.retryPush({
      pushId: 42,
      idempotencyKey: "admin-retry-42",
      actor: { actorType: "admin", actorId: "ops-user" },
    })).rejects.toMatchObject({
      code: "DROPSHIP_TRACKING_IDEMPOTENCY_CONFLICT",
    });

    expect(repository.preparedRetryFailures[0]).toMatchObject({
      pushId: 42,
      code: "DROPSHIP_TRACKING_IDEMPOTENCY_CONFLICT",
      message: "Request changed.",
      retryable: false,
      now: new Date("2026-05-03T12:00:00.000Z"),
    });
  });
});

function makeService(
  repository: DropshipTrackingPushOpsRepository,
  marketplaceTracking = new FakeMarketplaceTrackingService(),
): DropshipTrackingPushOpsService {
  return new DropshipTrackingPushOpsService({
    repository,
    marketplaceTracking,
    clock: { now: () => new Date("2026-05-03T12:00:00.000Z") },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
}

class FakeTrackingPushOpsRepository implements DropshipTrackingPushOpsRepository {
  inputs: Parameters<DropshipTrackingPushOpsRepository["listPushes"]>[0][] = [];
  retryInputs: Parameters<DropshipTrackingPushOpsRepository["prepareRetry"]>[0][] = [];
  preparedRetryFailures: Parameters<DropshipTrackingPushOpsRepository["markPreparedRetryFailed"]>[0][] = [];

  async listPushes(
    input: Parameters<DropshipTrackingPushOpsRepository["listPushes"]>[0],
  ): Promise<DropshipTrackingPushOpsListResult> {
    this.inputs.push(input);
    return {
      items: [],
      total: 0,
      page: input.page,
      limit: input.limit,
      statuses: input.statuses,
      summary: [],
    };
  }

  async prepareRetry(
    input: Parameters<DropshipTrackingPushOpsRepository["prepareRetry"]>[0],
  ): Promise<DropshipTrackingPushRetryRequest> {
    this.retryInputs.push(input);
    return {
      pushId: input.pushId,
      omsOrderId: 500,
      wmsShipmentId: 700,
      carrier: "USPS",
      trackingNumber: "94001111",
      shippedAt: new Date("2026-05-02T10:00:00.000Z"),
      idempotencyKey: "tracking-existing-key",
      previousAttemptCount: 2,
    };
  }

  async markPreparedRetryFailed(
    input: Parameters<DropshipTrackingPushOpsRepository["markPreparedRetryFailed"]>[0],
  ): Promise<void> {
    this.preparedRetryFailures.push(input);
  }
}

class FakeMarketplaceTrackingService {
  inputs: Array<{
    omsOrderId: number;
    wmsShipmentId?: number | null;
    carrier: string;
    trackingNumber: string;
    shippedAt: Date;
    idempotencyKey?: string;
  }> = [];
  error: Error | null = null;

  async pushForOmsOrder(input: {
    omsOrderId: number;
    wmsShipmentId?: number | null;
    carrier: string;
    trackingNumber: string;
    shippedAt: Date;
    idempotencyKey?: string;
  }) {
    if (this.error) {
      throw this.error;
    }
    this.inputs.push(input);
    return {
      status: "succeeded" as const,
      push: {
        pushId: 42,
        intakeId: 10,
        omsOrderId: input.omsOrderId,
        wmsShipmentId: input.wmsShipmentId ?? null,
        vendorId: 20,
        storeConnectionId: 30,
        platform: "ebay" as const,
        status: "succeeded",
        externalOrderId: "ORDER-1",
        trackingNumber: input.trackingNumber,
        carrier: input.carrier,
        attemptCount: 3,
        externalFulfillmentId: "FULFILLMENT-1",
      },
    };
  }
}
