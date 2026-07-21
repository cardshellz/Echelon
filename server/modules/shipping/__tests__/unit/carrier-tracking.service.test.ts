import { describe, expect, it, vi } from "vitest";

import { normalizeShipStationTrackingWebhook } from "../../carrier-tracking.domain";
import type {
  CarrierTrackingRepository,
  CarrierTrackingTransaction,
} from "../../carrier-tracking.repository";
import { CarrierTrackingService, type CarrierTrackingLogger } from "../../carrier-tracking.service";
import { ShipStationTrackingEventsError } from "../../shipstation-tracking-events.client";
import { ShipStationTrackingSubscriptionError } from "../../shipstation-tracking-subscriptions.client";

const now = new Date("2026-07-20T12:00:00.000Z");

function verifiedReceipt() {
  return {
    provider: "shipstation" as const,
    receiptHash: "a".repeat(64),
    signatureAlgorithm: "RSA-SHA256" as const,
    signatureKeyId: "test-key",
    signatureTimestampRaw: now.toISOString(),
    signatureTimestampAt: new Date(now),
    rawBodyBase64: Buffer.from("{}").toString("base64"),
    rawBodyHash: "b".repeat(64),
    signatureBase64: "signed-request",
    signatureHash: "c".repeat(64),
    verifiedAt: new Date(now),
  };
}

function payload() {
  return {
    resource_type: "API_TRACK",
    resource_url: "https://api.shipstation.com/v2/tracking?tracking_number=1Z999AA10123456784",
    data: {
      tracking_number: "1Z999AA10123456784",
      status_code: "AC",
      status_detail_code: "PICKED_UP",
      carrier_code: "ups",
      events: [{
        occurred_at: "2026-07-20T11:30:00.000Z",
        status_code: "AC",
        status_detail_code: "PICKED_UP",
      }],
    },
  };
}

function logger(): CarrierTrackingLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function repositoryWithCandidates(candidates: Awaited<ReturnType<CarrierTrackingTransaction["findMatchCandidates"]>>) {
  const insertOrGetEvent = vi.fn().mockResolvedValue({ id: 101, inserted: true });
  const appendMatchAttempt = vi.fn().mockImplementation(
    async (_eventId, _resolution, shippingProviderLabelId) => ({
      id: 201,
      inserted: true,
      shippingProviderLabelId,
    }),
  );
  const tx: CarrierTrackingTransaction = {
    acquireTrackingLock: vi.fn().mockResolvedValue(undefined),
    insertOrGetEvent,
    findMatchCandidates: vi.fn().mockResolvedValue(candidates),
    appendMatchAttempt,
    markEventReconciled: vi.fn().mockResolvedValue(undefined),
  };
  const repository: CarrierTrackingRepository = {
    persistVerifiedWebhookReceipt: vi.fn().mockResolvedValue({ id: 301, inserted: true }),
    persistNormalizedWebhookEvent: vi.fn().mockResolvedValue({
      event: { id: 101, inserted: true },
      parse: { id: 401, inserted: true },
    }),
    persistRejectedWebhookPayload: vi.fn().mockResolvedValue({
      id: 402,
      inserted: true,
      hydrationPrepared: false,
    }),
    claimWebhookHydrations: vi.fn().mockResolvedValue([]),
    finalizeWebhookHydrationAttempt: vi.fn().mockResolvedValue({
      id: 403,
      inserted: true,
      eventId: null,
      eventInserted: false,
      parseAttemptId: null,
      parseAttemptInserted: false,
    }),
    observeProviderLabel: vi.fn().mockResolvedValue({
      shippingProviderLabelId: 10,
      labelInserted: true,
      eventInserted: true,
    }),
    reconcileProviderLabelLinks: vi.fn().mockResolvedValue({
      shippingProviderLabelId: 10,
      linksInserted: 1,
      totalLinks: 1,
    }),
    listProviderLabelsPendingLinkReconciliation: vi.fn().mockResolvedValue([]),
    prepareTrackingSubscriptions: vi.fn().mockResolvedValue({
      subscriptionsInserted: 0,
      labelLinksInserted: 0,
    }),
    claimTrackingSubscriptions: vi.fn().mockResolvedValue([]),
    finalizeTrackingSubscriptionAttempt: vi.fn().mockResolvedValue({ id: 501, inserted: true }),
    listEventsPendingReconciliation: vi.fn().mockResolvedValue([]),
    transaction: async (work) => work(tx),
  };
  return { repository, tx, insertOrGetEvent, appendMatchAttempt };
}

describe("CarrierTrackingService", () => {
  it("activates a prepared provider-label tracking subscription without changing fulfillment", async () => {
    const { repository } = repositoryWithCandidates([]);
    vi.mocked(repository.prepareTrackingSubscriptions).mockResolvedValue({
      subscriptionsInserted: 1,
      labelLinksInserted: 1,
    });
    vi.mocked(repository.claimTrackingSubscriptions).mockResolvedValue([{
      id: 601,
      trackingProvider: "shipstation_api",
      carrierCode: "ups",
      trackingNumber: "1Z999AA10123456784",
      normalizedTrackingNumber: "1Z999AA10123456784",
      attemptNumber: 1,
      consecutiveFailureCount: 0,
      startedAt: new Date(now),
      leaseOwner: "test-worker",
      leaseExpiresAt: new Date("2026-07-20T12:02:00.000Z"),
    }]);
    const startTracking = vi.fn().mockResolvedValue({ httpStatus: 204 });
    const service = new CarrierTrackingService({
      repository,
      clock: { now: () => new Date(now) },
      logger: logger(),
      subscriptionClient: { isConfigured: () => true, startTracking },
      subscriptionLeaseOwner: "test-worker",
    });

    const result = await service.reconcileUnresolved(25);

    expect(result).toMatchObject({
      subscriptionsPrepared: 1,
      subscriptionLabelLinksPrepared: 1,
      subscriptionsClaimed: 1,
      subscriptionsActivated: 1,
      subscriptionsRetryScheduled: 0,
      subscriptionsReviewRequired: 0,
    });
    expect(startTracking).toHaveBeenCalledWith({
      carrierCode: "ups",
      trackingNumber: "1Z999AA10123456784",
    });
    expect(repository.claimTrackingSubscriptions).toHaveBeenCalledWith(
      25,
      now,
      "test-worker",
      new Date("2026-07-20T12:10:00.000Z"),
    );
    expect(repository.finalizeTrackingSubscriptionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 601,
        outcome: "activated",
        httpStatus: 204,
        nextAttemptAt: null,
      }),
    );
  });

  it("retries transient provider failures with deterministic bounded backoff", async () => {
    const { repository } = repositoryWithCandidates([]);
    vi.mocked(repository.claimTrackingSubscriptions).mockResolvedValue([{
      id: 602,
      trackingProvider: "shipstation_api",
      carrierCode: "ups",
      trackingNumber: "1Z999AA10123456784",
      normalizedTrackingNumber: "1Z999AA10123456784",
      attemptNumber: 2,
      consecutiveFailureCount: 1,
      startedAt: new Date(now),
      leaseOwner: "test-worker",
      leaseExpiresAt: new Date("2026-07-20T12:02:00.000Z"),
    }]);
    const service = new CarrierTrackingService({
      repository,
      clock: { now: () => new Date(now) },
      logger: logger(),
      subscriptionClient: {
        isConfigured: () => true,
        startTracking: vi.fn().mockRejectedValue(new ShipStationTrackingSubscriptionError(
          "HTTP",
          "rate limited",
          { status: 429 },
        )),
      },
      subscriptionLeaseOwner: "test-worker",
    });

    const result = await service.reconcileUnresolved(25);

    expect(result.subscriptionsRetryScheduled).toBe(1);
    expect(repository.finalizeTrackingSubscriptionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 602,
        outcome: "retry_scheduled",
        errorCode: "SHIPSTATION_TRACKING_HTTP",
        nextAttemptAt: new Date("2026-07-20T12:10:00.000Z"),
      }),
    );
  });

  it("stops retrying after eight consecutive transient failures", async () => {
    const { repository } = repositoryWithCandidates([]);
    vi.mocked(repository.claimTrackingSubscriptions).mockResolvedValue([{
      id: 603,
      trackingProvider: "shipstation_api",
      carrierCode: "ups",
      trackingNumber: "1Z999AA10123456784",
      normalizedTrackingNumber: "1Z999AA10123456784",
      attemptNumber: 8,
      consecutiveFailureCount: 7,
      startedAt: new Date(now),
      leaseOwner: "test-worker",
      leaseExpiresAt: new Date("2026-07-20T12:02:00.000Z"),
    }]);
    const service = new CarrierTrackingService({
      repository,
      clock: { now: () => new Date(now) },
      logger: logger(),
      subscriptionClient: {
        isConfigured: () => true,
        startTracking: vi.fn().mockRejectedValue(new ShipStationTrackingSubscriptionError(
          "HTTP",
          "provider unavailable",
          { status: 503 },
        )),
      },
      subscriptionLeaseOwner: "test-worker",
    });

    const result = await service.reconcileUnresolved(25);

    expect(result.subscriptionsReviewRequired).toBe(1);
    expect(repository.finalizeTrackingSubscriptionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 603,
        outcome: "review_required",
        nextAttemptAt: null,
      }),
    );
  });

  it("durably records authenticated ingress and defers matching without inventing a label", async () => {
    const { repository, appendMatchAttempt } = repositoryWithCandidates([]);
    const service = new CarrierTrackingService({
      repository,
      clock: { now: () => new Date(now) },
      logger: logger(),
    });

    const result = await service.ingestShipStationWebhook(payload(), verifiedReceipt());

    expect(result).toMatchObject({
      ingestStatus: "normalized",
      eventId: 101,
      webhookReceiptId: 301,
      webhookReceiptInserted: true,
      parseAttemptId: 401,
      parseAttemptInserted: true,
      matchStatus: "pending",
      candidateCount: 0,
      shippingProviderLabelId: null,
      dispatchEvidence: "confirmed",
    });
    expect(repository.observeProviderLabel).not.toHaveBeenCalled();
    expect(repository.persistVerifiedWebhookReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ signatureKeyId: "test-key" }),
    );
    expect(repository.persistNormalizedWebhookEvent).toHaveBeenCalledWith(
      301,
      expect.objectContaining({ provider: "shipstation" }),
      expect.objectContaining({ parserVersion: "shipstation-api-track-v1" }),
    );
    expect(appendMatchAttempt).not.toHaveBeenCalled();
  });

  it("retains authenticated bytes before classifying an unexpected payload for review", async () => {
    const { repository } = repositoryWithCandidates([]);
    const service = new CarrierTrackingService({
      repository,
      clock: { now: () => new Date(now) },
      logger: logger(),
    });

    const result = await service.ingestShipStationWebhook(
      { resource_type: "API_TRACK", data: null },
      verifiedReceipt(),
    );

    expect(result).toEqual({
      ingestStatus: "rejected",
      eventId: null,
      eventInserted: false,
      webhookReceiptId: 301,
      webhookReceiptInserted: true,
      parseAttemptId: 402,
      parseAttemptInserted: true,
      reasonCode: "INVALID_CARRIER_TRACKING_PAYLOAD",
      hydrationPrepared: false,
    });
    expect(repository.persistVerifiedWebhookReceipt).toHaveBeenCalledBefore(
      vi.mocked(repository.persistRejectedWebhookPayload),
    );
    expect(repository.persistRejectedWebhookPayload).toHaveBeenCalledWith(
      301,
      expect.objectContaining({
        parserVersion: "shipstation-api-track-v1",
        reasonCode: "INVALID_CARRIER_TRACKING_PAYLOAD",
      }),
    );
    expect(repository.persistNormalizedWebhookEvent).not.toHaveBeenCalled();
  });

  it("schedules asynchronous hydration when an authenticated API_TRACK callback omits optional data", async () => {
    const { repository } = repositoryWithCandidates([]);
    vi.mocked(repository.persistRejectedWebhookPayload).mockResolvedValue({
      id: 402,
      inserted: true,
      hydrationPrepared: true,
    });
    const getTrackingSnapshot = vi.fn();
    const service = new CarrierTrackingService({
      repository,
      clock: { now: () => new Date(now) },
      logger: logger(),
      trackingEventsClient: { isConfigured: () => true, getTrackingSnapshot },
    });
    const resourceUrl = "https://api.shipstation.com/v2/tracking"
      + "?carrier_code=ups&tracking_number=1Z999AA10123456784";

    const result = await service.ingestShipStationWebhook({
      resource_type: "API_TRACK",
      resource_url: resourceUrl,
      data: null,
    }, verifiedReceipt());

    expect(result).toMatchObject({
      ingestStatus: "rejected",
      reasonCode: "SHIPSTATION_TRACKING_DATA_MISSING",
      hydrationPrepared: true,
    });
    expect(repository.persistRejectedWebhookPayload).toHaveBeenCalledWith(301, {
      parserVersion: "shipstation-api-track-v1",
      reasonCode: "SHIPSTATION_TRACKING_DATA_MISSING",
      details: expect.objectContaining({ hydrationDisposition: "scheduled" }),
      hydrationRequest: {
        resourceUrl,
        carrierCode: "ups",
        trackingNumber: "1Z999AA10123456784",
        normalizedTrackingNumber: "1Z999AA10123456784",
      },
      createdAt: now,
    });
    expect(getTrackingSnapshot).not.toHaveBeenCalled();
  });

  it("hydrates an authenticated resource URL asynchronously and appends normalized evidence", async () => {
    const { repository } = repositoryWithCandidates([]);
    const resourceUrl = "https://api.shipstation.com/v2/tracking"
      + "?carrier_code=ups&tracking_number=1Z999AA10123456784";
    vi.mocked(repository.claimWebhookHydrations).mockResolvedValue([{
      receiptId: 301,
      resourceUrl,
      carrierCode: "ups",
      trackingNumber: "1Z999AA10123456784",
      normalizedTrackingNumber: "1Z999AA10123456784",
      attemptNumber: 1,
      consecutiveFailureCount: 0,
      webhookVerifiedAt: new Date(now),
      startedAt: new Date(now),
      leaseOwner: "test-hydration-worker",
      leaseExpiresAt: new Date("2026-07-20T12:02:00.000Z"),
    }]);
    vi.mocked(repository.finalizeWebhookHydrationAttempt).mockResolvedValue({
      id: 403,
      inserted: true,
      eventId: 101,
      eventInserted: true,
      parseAttemptId: 404,
      parseAttemptInserted: true,
    });
    const getTrackingSnapshot = vi.fn().mockResolvedValue({
      httpStatus: 200,
      payload: payload().data,
    });
    const service = new CarrierTrackingService({
      repository,
      clock: { now: () => new Date(now) },
      logger: logger(),
      trackingEventsClient: { isConfigured: () => true, getTrackingSnapshot },
      hydrationLeaseOwner: "test-hydration-worker",
    });

    const result = await service.reconcileUnresolved(25);

    expect(result).toMatchObject({
      hydrationsClaimed: 1,
      hydrationsCompleted: 1,
      hydrationsRetryScheduled: 0,
      hydrationsReviewRequired: 0,
      hydrationClientConfigured: true,
      errors: 0,
    });
    expect(getTrackingSnapshot).toHaveBeenCalledWith({
      resourceUrl,
      carrierCode: "ups",
      trackingNumber: "1Z999AA10123456784",
      normalizedTrackingNumber: "1Z999AA10123456784",
    });
    expect(repository.claimWebhookHydrations).toHaveBeenCalledWith(
      25,
      now,
      "test-hydration-worker",
      new Date("2026-07-20T12:10:00.000Z"),
    );
    expect(repository.finalizeWebhookHydrationAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptId: 301,
        attemptNumber: 1,
        leaseOwner: "test-hydration-worker",
        outcome: "hydrated",
        httpStatus: 200,
        nextAttemptAt: null,
        event: expect.objectContaining({
          normalizedTrackingNumber: "1Z999AA10123456784",
          dispatchEvidence: "confirmed",
        }),
      }),
    );
  });

  it("retries transient hydration failures with deterministic bounded backoff", async () => {
    const { repository } = repositoryWithCandidates([]);
    vi.mocked(repository.claimWebhookHydrations).mockResolvedValue([{
      receiptId: 302,
      resourceUrl: "https://api.shipstation.com/v2/tracking"
        + "?carrier_code=ups&tracking_number=1Z999AA10123456784",
      carrierCode: "ups",
      trackingNumber: "1Z999AA10123456784",
      normalizedTrackingNumber: "1Z999AA10123456784",
      attemptNumber: 2,
      consecutiveFailureCount: 1,
      webhookVerifiedAt: new Date(now),
      startedAt: new Date(now),
      leaseOwner: "test-hydration-worker",
      leaseExpiresAt: new Date("2026-07-20T12:02:00.000Z"),
    }]);
    const service = new CarrierTrackingService({
      repository,
      clock: { now: () => new Date(now) },
      logger: logger(),
      trackingEventsClient: {
        isConfigured: () => true,
        getTrackingSnapshot: vi.fn().mockRejectedValue(new ShipStationTrackingEventsError(
          "HTTP",
          "rate limited",
          { status: 429 },
        )),
      },
      hydrationLeaseOwner: "test-hydration-worker",
    });

    const result = await service.reconcileUnresolved(25);

    expect(result.hydrationsRetryScheduled).toBe(1);
    expect(repository.finalizeWebhookHydrationAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptId: 302,
        outcome: "retry_scheduled",
        errorCode: "SHIPSTATION_TRACKING_HYDRATION_HTTP",
        nextAttemptAt: new Date("2026-07-20T12:10:00.000Z"),
      }),
    );
  });

  it("requires review when hydrated evidence changes the authenticated tracking identity", async () => {
    const { repository } = repositoryWithCandidates([]);
    vi.mocked(repository.claimWebhookHydrations).mockResolvedValue([{
      receiptId: 303,
      resourceUrl: "https://api.shipstation.com/v2/tracking"
        + "?carrier_code=ups&tracking_number=1Z999AA10123456784",
      carrierCode: "ups",
      trackingNumber: "1Z999AA10123456784",
      normalizedTrackingNumber: "1Z999AA10123456784",
      attemptNumber: 1,
      consecutiveFailureCount: 0,
      webhookVerifiedAt: new Date(now),
      startedAt: new Date(now),
      leaseOwner: "test-hydration-worker",
      leaseExpiresAt: new Date("2026-07-20T12:02:00.000Z"),
    }]);
    const mismatchedData = {
      ...payload().data,
      tracking_number: "1Z999AA10123456785",
    };
    const service = new CarrierTrackingService({
      repository,
      clock: { now: () => new Date(now) },
      logger: logger(),
      trackingEventsClient: {
        isConfigured: () => true,
        getTrackingSnapshot: vi.fn().mockResolvedValue({ httpStatus: 200, payload: mismatchedData }),
      },
      hydrationLeaseOwner: "test-hydration-worker",
    });

    const result = await service.reconcileUnresolved(25);

    expect(result.hydrationsReviewRequired).toBe(1);
    expect(repository.finalizeWebhookHydrationAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptId: 303,
        outcome: "review_required",
        errorCode: "SHIPSTATION_TRACKING_HYDRATION_INVALID_RESPONSE",
        nextAttemptAt: null,
        event: null,
      }),
    );
  });

  it("matches carrier evidence to one existing provider label during reconciliation", async () => {
    const { repository } = repositoryWithCandidates([{
      shippingProviderLabelId: 10,
      providerLabelId: "442000001",
      labelStatus: "active",
      linkCount: 2,
      orderNumbers: ["#60001"],
      carrier: "ups",
      serviceCode: "ups_ground",
    }]);
    const service = new CarrierTrackingService({
      repository,
      clock: { now: () => new Date(now) },
      logger: logger(),
    });

    vi.mocked(repository.listEventsPendingReconciliation).mockResolvedValue([
      normalizeShipStationTrackingWebhook(payload(), now),
    ]);

    await expect(service.reconcileUnresolved(25)).resolves.toMatchObject({
      scanned: 1,
      matched: 1,
      unresolved: 0,
    });
    expect(repository.listEventsPendingReconciliation).toHaveBeenCalledWith(25, now);
  });

  it("observes ShipStation labels through the dedicated label boundary", async () => {
    const { repository } = repositoryWithCandidates([]);
    const service = new CarrierTrackingService({
      repository,
      clock: { now: () => new Date(now) },
      logger: logger(),
    });

    await service.observeShipStationLabel({
      shipmentId: 442_000_001,
      orderId: 755_000_001,
      orderKey: "echelon-wms-shp-4814",
      trackingNumber: "1Z999AA10123456784",
    });

    expect(repository.observeProviderLabel).toHaveBeenCalledWith(expect.objectContaining({
      provider: "shipstation",
      providerLabelId: "442000001",
      labelCreatedAt: null,
    }));
  });

  it("reconciles late label links before retrying unmatched carrier events", async () => {
    const { repository } = repositoryWithCandidates([{
      shippingProviderLabelId: 10,
      providerLabelId: "442000001",
      labelStatus: "active",
      linkCount: 1,
      orderNumbers: ["#60001"],
      carrier: "ups",
      serviceCode: null,
    }]);
    vi.mocked(repository.listProviderLabelsPendingLinkReconciliation).mockResolvedValue([{
      provider: "shipstation",
      providerLabelId: "442000001",
    }]);
    vi.mocked(repository.listEventsPendingReconciliation).mockResolvedValue([
      normalizeShipStationTrackingWebhook(payload(), now),
    ]);
    const service = new CarrierTrackingService({
      repository,
      clock: { now: () => new Date(now) },
      logger: logger(),
    });

    const result = await service.reconcileUnresolved(25);

    expect(result).toEqual({
      hydrationsClaimed: 0,
      hydrationsCompleted: 0,
      hydrationsRetryScheduled: 0,
      hydrationsReviewRequired: 0,
      hydrationClientConfigured: false,
      subscriptionsPrepared: 0,
      subscriptionLabelLinksPrepared: 0,
      subscriptionsClaimed: 0,
      subscriptionsActivated: 0,
      subscriptionsRetryScheduled: 0,
      subscriptionsReviewRequired: 0,
      subscriptionClientConfigured: false,
      labelsScanned: 1,
      labelsLinked: 1,
      scanned: 1,
      matched: 1,
      unresolved: 0,
      attemptsAppended: 1,
      errors: 0,
    });
    expect(repository.reconcileProviderLabelLinks).toHaveBeenCalledWith(
      "shipstation",
      "442000001",
      new Date("2026-07-20T12:00:00.000Z"),
    );
  });
});
