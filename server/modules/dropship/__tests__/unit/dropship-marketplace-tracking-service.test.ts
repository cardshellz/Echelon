import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  DropshipMarketplaceTrackingService,
  type DropshipLogEvent,
  type DropshipMarketplaceTrackingClaim,
  type DropshipMarketplaceTrackingProvider,
  type DropshipMarketplaceTrackingPushRecord,
  type DropshipMarketplaceTrackingRepository,
  type DropshipMarketplaceTrackingRequest,
  type DropshipMarketplaceTrackingResult,
  type DropshipNotificationSenderInput,
} from "../../application";

const now = new Date("2026-05-06T12:00:00.000Z");
const shippedAt = new Date("2026-05-06T10:30:00.000Z");

describe("DropshipMarketplaceTrackingService", () => {
  it("sends a vendor notification after marketplace tracking succeeds", async () => {
    const repository = new FakeTrackingRepository({
      status: "claimed",
      push: makePush({ status: "processing", attemptCount: 1 }),
      request: makeRequest(),
    });
    const notificationSender = new FakeNotificationSender();
    const service = newService({
      repository,
      notificationSender,
    });

    const result = await service.pushForOmsOrder(makeInput());

    expect(result).toMatchObject({
      status: "succeeded",
      push: {
        pushId: 40,
        status: "succeeded",
        externalFulfillmentId: "fulfillment-1",
      },
    });
    expect(notificationSender.sent).toHaveLength(1);
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 20,
      eventType: "dropship_tracking_pushed",
      critical: false,
      channels: ["email", "in_app"],
      title: "Dropship tracking pushed",
      idempotencyKey: "tracking-pushed:40",
      payload: {
        pushId: 40,
        intakeId: 10,
        omsOrderId: 500,
        wmsShipmentId: 55,
        storeConnectionId: 30,
        platform: "ebay",
        status: "succeeded",
        externalOrderId: "ORDER-1",
        trackingNumber: "94001111",
        carrier: "USPS",
        attemptCount: 1,
        externalFulfillmentId: "fulfillment-1",
      },
    });
  });

  it("does not resend vendor notifications for already succeeded pushes", async () => {
    const repository = new FakeTrackingRepository({
      status: "already_succeeded",
      push: makePush({ status: "succeeded", externalFulfillmentId: "fulfillment-1" }),
    });
    const notificationSender = new FakeNotificationSender();
    const service = newService({
      repository,
      notificationSender,
    });

    const result = await service.pushForOmsOrder(makeInput());

    expect(result.status).toBe("already_succeeded");
    expect(notificationSender.sent).toHaveLength(0);
    expect(repository.completeInput).toBeNull();
    expect(repository.failInput).toBeNull();
  });

  it("records failure notification context before rethrowing marketplace errors", async () => {
    const providerError = new DropshipError(
      "DROPSHIP_EBAY_TRACKING_LINE_ITEM_IDS_REQUIRED",
      "eBay line item ids are required.",
      { retryable: false },
    );
    const repository = new FakeTrackingRepository({
      status: "claimed",
      push: makePush({ status: "processing", attemptCount: 1 }),
      request: makeRequest(),
    });
    const notificationSender = new FakeNotificationSender();
    const service = newService({
      repository,
      provider: new FakeTrackingProvider(providerError),
      notificationSender,
    });

    await expect(service.pushForOmsOrder(makeInput())).rejects.toBe(providerError);

    expect(repository.failInput).toMatchObject({
      pushId: 40,
      code: "DROPSHIP_EBAY_TRACKING_LINE_ITEM_IDS_REQUIRED",
      message: "eBay line item ids are required.",
      retryable: false,
    });
    expect(notificationSender.sent).toHaveLength(1);
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 20,
      eventType: "dropship_tracking_push_failed",
      critical: true,
      title: "Dropship tracking push failed",
      idempotencyKey: "tracking-push-failed:40:1:DROPSHIP_EBAY_TRACKING_LINE_ITEM_IDS_REQUIRED",
      payload: {
        pushId: 40,
        status: "failed",
        failureCode: "DROPSHIP_EBAY_TRACKING_LINE_ITEM_IDS_REQUIRED",
        failureMessage: "eBay line item ids are required.",
        retryable: false,
      },
    });
  });

  it("does not fail successful tracking pushes when notification delivery fails", async () => {
    const repository = new FakeTrackingRepository({
      status: "claimed",
      push: makePush({ status: "processing", attemptCount: 1 }),
      request: makeRequest(),
    });
    const notificationSender = new FakeNotificationSender(new Error("email unavailable"));
    const logs: DropshipLogEvent[] = [];
    const service = newService({
      repository,
      notificationSender,
      logger: captureLogger(logs),
    });

    const result = await service.pushForOmsOrder(makeInput());

    expect(result.status).toBe("succeeded");
    expect(logs).toContainEqual(expect.objectContaining({
      code: "DROPSHIP_TRACKING_PUSH_NOTIFICATION_FAILED",
      context: expect.objectContaining({
        pushId: 40,
        error: "email unavailable",
      }),
    }));
  });
});

class FakeTrackingRepository implements DropshipMarketplaceTrackingRepository {
  completeInput: Parameters<DropshipMarketplaceTrackingRepository["completePush"]>[0] | null = null;
  failInput: Parameters<DropshipMarketplaceTrackingRepository["failPush"]>[0] | null = null;

  constructor(private readonly claim: DropshipMarketplaceTrackingClaim) {}

  async claimForOmsOrder(): Promise<DropshipMarketplaceTrackingClaim> {
    return this.claim;
  }

  async completePush(
    input: Parameters<DropshipMarketplaceTrackingRepository["completePush"]>[0],
  ): Promise<DropshipMarketplaceTrackingPushRecord> {
    this.completeInput = input;
    return makePush({
      status: "succeeded",
      externalFulfillmentId: input.result.externalFulfillmentId,
    });
  }

  async failPush(
    input: Parameters<DropshipMarketplaceTrackingRepository["failPush"]>[0],
  ): Promise<DropshipMarketplaceTrackingPushRecord> {
    this.failInput = input;
    return makePush({ status: "failed", attemptCount: 1 });
  }
}

class FakeTrackingProvider implements DropshipMarketplaceTrackingProvider {
  constructor(private readonly error: Error | null = null) {}

  async pushTracking(): Promise<DropshipMarketplaceTrackingResult> {
    if (this.error) {
      throw this.error;
    }
    return {
      status: "succeeded",
      externalFulfillmentId: "fulfillment-1",
      rawResult: { provider: "fake" },
    };
  }
}

class FakeNotificationSender {
  sent: DropshipNotificationSenderInput[] = [];

  constructor(private readonly error: Error | null = null) {}

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    this.sent.push(input);
    if (this.error) {
      throw this.error;
    }
  }
}

function newService(input: {
  repository: DropshipMarketplaceTrackingRepository;
  provider?: DropshipMarketplaceTrackingProvider;
  notificationSender?: FakeNotificationSender;
  logger?: ReturnType<typeof captureLogger>;
}): DropshipMarketplaceTrackingService {
  return new DropshipMarketplaceTrackingService({
    repository: input.repository,
    provider: input.provider ?? new FakeTrackingProvider(),
    notificationSender: input.notificationSender,
    clock: { now: () => now },
    logger: input.logger ?? noopLogger,
  });
}

function makeInput() {
  return {
    omsOrderId: 500,
    wmsShipmentId: 55,
    carrier: "USPS",
    trackingNumber: "94001111",
    shippedAt,
    idempotencyKey: "tracking-key",
  };
}

function makeRequest(
  overrides: Partial<DropshipMarketplaceTrackingRequest> = {},
): DropshipMarketplaceTrackingRequest {
  return {
    intakeId: 10,
    omsOrderId: 500,
    wmsShipmentId: 55,
    vendorId: 20,
    storeConnectionId: 30,
    platform: "ebay",
    externalOrderId: "ORDER-1",
    externalOrderNumber: "1001",
    sourceOrderId: "SRC-1",
    carrier: "USPS",
    trackingNumber: "94001111",
    shippedAt,
    lineItems: [{ externalLineItemId: "LINE-1", quantity: 1 }],
    idempotencyKey: "tracking-key",
    ...overrides,
  };
}

function makePush(
  overrides: Partial<DropshipMarketplaceTrackingPushRecord> = {},
): DropshipMarketplaceTrackingPushRecord {
  return {
    pushId: 40,
    intakeId: 10,
    omsOrderId: 500,
    wmsShipmentId: 55,
    vendorId: 20,
    storeConnectionId: 30,
    platform: "ebay",
    status: "queued",
    externalOrderId: "ORDER-1",
    trackingNumber: "94001111",
    carrier: "USPS",
    attemptCount: 1,
    externalFulfillmentId: null,
    ...overrides,
  };
}

function captureLogger(logs: DropshipLogEvent[]) {
  return {
    info: (event: DropshipLogEvent) => logs.push(event),
    warn: (event: DropshipLogEvent) => logs.push(event),
    error: (event: DropshipLogEvent) => logs.push(event),
  };
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
