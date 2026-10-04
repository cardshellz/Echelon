import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  DropshipMarketplaceTrackingService,
  buildChannelFulfillmentTrackingIdempotencyKey,
  channelFulfillmentCommandIdFromTrackingKey,
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

  it("does not push tracking again while the same tracking push is processing", async () => {
    const repository = new FakeTrackingRepository({
      status: "already_processing",
      push: makePush({ status: "processing", attemptCount: 1 }),
    });
    const provider = new FakeTrackingProvider();
    const notificationSender = new FakeNotificationSender();
    const logs: DropshipLogEvent[] = [];
    const service = newService({
      repository,
      provider,
      notificationSender,
      logger: captureLogger(logs),
    });

    const result = await service.pushForOmsOrder(makeInput());

    expect(result.status).toBe("already_processing");
    expect(provider.requests).toHaveLength(0);
    expect(notificationSender.sent).toHaveLength(0);
    expect(repository.completeInput).toBeNull();
    expect(repository.failInput).toBeNull();
    expect(logs).toContainEqual(expect.objectContaining({
      code: "DROPSHIP_MARKETPLACE_TRACKING_PUSH_ALREADY_PROCESSING",
      context: expect.objectContaining({
        pushId: 40,
        omsOrderId: 500,
        wmsShipmentId: 55,
        attemptCount: 1,
      }),
    }));
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

describe("DropshipMarketplaceTrackingService failure notices", () => {
  const retryableError = () => new DropshipError(
    "DROPSHIP_EBAY_TRACKING_HTTP_ERROR",
    "eBay tracking push failed with HTTP 503.",
    { retryable: true },
  );

  async function failOnce(input: {
    error: Error;
    failedAttemptCount: number;
    lastAttempt?: boolean;
  }) {
    const repository = new FakeTrackingRepository({
      status: "claimed",
      push: makePush({ status: "processing", attemptCount: input.failedAttemptCount }),
      request: makeRequest(),
    }, input.failedAttemptCount);
    const notificationSender = new FakeNotificationSender();
    const service = newService({
      repository,
      provider: new FakeTrackingProvider(input.error),
      notificationSender,
    });
    await expect(service.pushForOmsOrder({
      ...makeInput(),
      ...(input.lastAttempt === undefined ? {} : { lastAttempt: input.lastAttempt }),
    })).rejects.toBe(input.error);
    return { repository, sent: notificationSender.sent };
  }

  it("tells the vendor once that a first retryable failure will be retried", async () => {
    const { repository, sent } = await failOnce({ error: retryableError(), failedAttemptCount: 1 });

    expect(repository.failInput).toMatchObject({ retryable: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      critical: false,
      title: "Dropship tracking push retrying",
      payload: { retryable: true, failureCode: "DROPSHIP_EBAY_TRACKING_HTTP_ERROR" },
    });
  });

  it("records a later retryable failure without telling the vendor again", async () => {
    const { repository, sent } = await failOnce({ error: retryableError(), failedAttemptCount: 2 });

    expect(repository.failInput).toMatchObject({
      pushId: 40,
      code: "DROPSHIP_EBAY_TRACKING_HTTP_ERROR",
      retryable: true,
    });
    expect(sent).toEqual([]);
  });

  it("tells the vendor the push failed for good on the caller's last attempt", async () => {
    const { repository, sent } = await failOnce({
      error: retryableError(),
      failedAttemptCount: 12,
      lastAttempt: true,
    });

    // The push row keeps the error's own class; only the notice is final.
    expect(repository.failInput).toMatchObject({ retryable: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      critical: true,
      title: "Dropship tracking push failed",
      idempotencyKey: "tracking-push-failed:40:12:DROPSHIP_EBAY_TRACKING_HTTP_ERROR",
      payload: { retryable: false },
    });
  });

  it("tells the vendor about a failure that can never succeed, whatever the attempt", async () => {
    const { sent } = await failOnce({
      error: new DropshipError("DROPSHIP_EBAY_TRACKING_HTTP_ERROR", "HTTP 400", { retryable: false }),
      failedAttemptCount: 4,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ critical: true, title: "Dropship tracking push failed" });
  });
});

describe("DropshipMarketplaceTrackingService shipped lines", () => {
  it("passes caller-named shipped lines to the claim unchanged", async () => {
    const repository = new FakeTrackingRepository({
      status: "already_succeeded",
      push: makePush({ status: "succeeded" }),
    });
    const service = newService({ repository });
    const lineItems = [
      { externalLineItemId: "LINE-1", quantity: 2 },
      { externalLineItemId: "LINE-2", quantity: 1 },
    ];

    await service.pushForOmsOrder({ ...makeInput(), lineItems });

    expect(repository.claimInput).toMatchObject({
      omsOrderId: 500,
      wmsShipmentId: 55,
      idempotencyKey: "tracking-key",
      lineItems,
    });
  });

  it("leaves lines to the repository when the caller names none", async () => {
    const repository = new FakeTrackingRepository({
      status: "already_succeeded",
      push: makePush({ status: "succeeded" }),
    });

    await newService({ repository }).pushForOmsOrder(makeInput());

    expect(repository.claimInput).not.toBeNull();
    expect(repository.claimInput).not.toHaveProperty("lineItems");
  });

  it("rejects malformed shipped lines before anything is claimed", async () => {
    const cases: Array<[unknown, string]> = [
      [[], "empty"],
      [[{ externalLineItemId: null, quantity: 1 }], "line_id"],
      [[{ externalLineItemId: "", quantity: 1 }], "line_id"],
      [[{ externalLineItemId: " LINE-1", quantity: 1 }], "line_id"],
      [[{ externalLineItemId: "L".repeat(101), quantity: 1 }], "line_id"],
      [[{ externalLineItemId: "LINE-1", quantity: 0 }], "quantity"],
      [[{ externalLineItemId: "LINE-1", quantity: -1 }], "quantity"],
      [[{ externalLineItemId: "LINE-1", quantity: 1.5 }], "quantity"],
      [[{ externalLineItemId: "LINE-1", quantity: Number.NaN }], "quantity"],
      [[{ externalLineItemId: "LINE-1", quantity: Number.MAX_SAFE_INTEGER + 1 }], "quantity"],
      [[
        { externalLineItemId: "LINE-1", quantity: 1 },
        { externalLineItemId: "LINE-1", quantity: 2 },
      ], "duplicate_line"],
    ];
    for (const [lineItems, reason] of cases) {
      const repository = new FakeTrackingRepository({ status: "not_dropship" });
      const error = await newService({ repository })
        .pushForOmsOrder({ ...makeInput(), lineItems: lineItems as never })
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(DropshipError);
      expect(error).toMatchObject({
        code: "DROPSHIP_TRACKING_LINE_ITEMS_INVALID",
        context: { omsOrderId: 500, reason, retryable: false },
      });
      expect(repository.claimInput).toBeNull();
    }
  });

  it("accepts a line id as long as the order line column allows", async () => {
    const repository = new FakeTrackingRepository({ status: "not_dropship" });

    await expect(newService({ repository }).pushForOmsOrder({
      ...makeInput(),
      lineItems: [{ externalLineItemId: "L".repeat(100), quantity: 1 }],
    })).resolves.toEqual({ status: "not_dropship" });
  });
});

describe("channel fulfillment tracking keys", () => {
  it("builds one key per command and reads the command back", () => {
    const key = buildChannelFulfillmentTrackingIdempotencyKey(42);
    expect(key).toBe("channel-fulfillment-command:42");
    expect(channelFulfillmentCommandIdFromTrackingKey(key)).toBe(42);
    expect(channelFulfillmentCommandIdFromTrackingKey(
      buildChannelFulfillmentTrackingIdempotencyKey(Number.MAX_SAFE_INTEGER),
    )).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a command id that is not a positive safe integer", () => {
    for (const commandId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => buildChannelFulfillmentTrackingIdempotencyKey(commandId)).toThrow(
        expect.objectContaining({ code: "DROPSHIP_TRACKING_COMMAND_ID_INVALID" }),
      );
    }
  });

  it("treats every other key as a push made outside the rails", () => {
    for (const key of [
      "dropship:tracking:500:usps:94001111",
      "dropship:oms:500:shipment:55:tracking:usps:94001111",
      "channel-fulfillment-command:",
      "channel-fulfillment-command:0",
      "channel-fulfillment-command:042",
      "channel-fulfillment-command:42a",
      "channel-fulfillment-command:-42",
      "channel-fulfillment-command:99999999999999999999",
      "CHANNEL-FULFILLMENT-COMMAND:42",
    ]) {
      expect(channelFulfillmentCommandIdFromTrackingKey(key)).toBeNull();
    }
  });
});

class FakeTrackingRepository implements DropshipMarketplaceTrackingRepository {
  claimInput: Parameters<DropshipMarketplaceTrackingRepository["claimForOmsOrder"]>[0] | null = null;
  completeInput: Parameters<DropshipMarketplaceTrackingRepository["completePush"]>[0] | null = null;
  failInput: Parameters<DropshipMarketplaceTrackingRepository["failPush"]>[0] | null = null;

  constructor(
    private readonly claim: DropshipMarketplaceTrackingClaim,
    private readonly failedAttemptCount = 1,
  ) {}

  async claimForOmsOrder(
    input: Parameters<DropshipMarketplaceTrackingRepository["claimForOmsOrder"]>[0],
  ): Promise<DropshipMarketplaceTrackingClaim> {
    this.claimInput = input;
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
    return makePush({ status: "failed", attemptCount: this.failedAttemptCount });
  }
}

class FakeTrackingProvider implements DropshipMarketplaceTrackingProvider {
  requests: DropshipMarketplaceTrackingRequest[] = [];

  constructor(private readonly error: Error | null = null) {}

  async pushTracking(request: DropshipMarketplaceTrackingRequest): Promise<DropshipMarketplaceTrackingResult> {
    this.requests.push(request);
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
