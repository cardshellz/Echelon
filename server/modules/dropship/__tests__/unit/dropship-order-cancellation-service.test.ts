import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  DropshipOrderCancellationService,
  buildCancellationRequest,
  deriveOrderCancellationIdempotencyKey,
  type DropshipLogEvent,
  type DropshipMarketplaceOrderCancellationProvider,
  type DropshipMarketplaceOrderCancellationRequest,
  type DropshipMarketplaceOrderCancellationResult,
  type DropshipOrderCancellationCandidate,
  type DropshipOrderCancellationRepository,
} from "../../application";

const now = new Date("2026-05-02T18:00:00.000Z");

describe("DropshipOrderCancellationService", () => {
  it("cancels claimed marketplace orders with deterministic idempotency", async () => {
    const candidate = makeCandidate();
    const repository = new FakeOrderCancellationRepository([candidate]);
    const marketplaceCancellation = new FakeMarketplaceCancellationProvider({
      status: "cancelled",
      externalCancellationId: "cancel-1",
      rawResult: { provider: "shopify" },
    });
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderCancellationService({
      repository,
      marketplaceCancellation,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.processPendingCancellations({
      workerId: "worker-1",
      limit: 25,
    });

    expect(result).toEqual({
      claimed: 1,
      attempted: 1,
      succeeded: 1,
      retrying: 0,
      failed: 0,
    });
    expect(repository.lastClaimInput).toEqual({ now, limit: 25, workerId: "worker-1" });
    expect(marketplaceCancellation.lastInput).toMatchObject({
      intakeId: 1,
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
      externalOrderId: "1234567890",
      reason: "payment_hold_expired",
      idempotencyKey: deriveOrderCancellationIdempotencyKey(candidate),
    });
    expect(repository.successes[0]).toMatchObject({
      candidate,
      workerId: "worker-1",
      result: { externalCancellationId: "cancel-1" },
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_MARKETPLACE_ORDER_CANCELLATION_SUCCEEDED",
      context: {
        intakeId: 1,
        externalCancellationId: "cancel-1",
      },
    });
  });

  it("records retryable provider failures without marking ops exception", async () => {
    const repository = new FakeOrderCancellationRepository([makeCandidate()]);
    const marketplaceCancellation = new FakeMarketplaceCancellationProvider(new DropshipError(
      "DROPSHIP_SHOPIFY_ORDER_CANCELLATION_HTTP_ERROR",
      "Shopify order cancellation failed with HTTP 500.",
      { retryable: true },
    ));
    const service = new DropshipOrderCancellationService({
      repository,
      marketplaceCancellation,
      clock: { now: () => now },
      logger: noopLogger,
    });

    const result = await service.processPendingCancellations({ workerId: "worker-1" });

    expect(result).toMatchObject({ attempted: 1, succeeded: 0, retrying: 1, failed: 0 });
    expect(repository.failures[0]).toMatchObject({
      errorCode: "DROPSHIP_SHOPIFY_ORDER_CANCELLATION_HTTP_ERROR",
      retryable: true,
    });
  });

  it("cancels rejected marketplace intake with the rejected-intake reason", async () => {
    const candidate = makeCandidate({
      cancellationStatus: "order_intake_rejected",
      rejectionReason: "Store connection status needs_reauth does not allow new dropship order intake.",
    });
    const repository = new FakeOrderCancellationRepository([candidate]);
    const marketplaceCancellation = new FakeMarketplaceCancellationProvider({
      status: "cancelled",
      externalCancellationId: "cancel-2",
      rawResult: { provider: "ebay" },
    });
    const service = new DropshipOrderCancellationService({
      repository,
      marketplaceCancellation,
      clock: { now: () => now },
      logger: noopLogger,
    });

    const result = await service.processPendingCancellations({ workerId: "worker-1" });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(marketplaceCancellation.lastInput).toMatchObject({
      reason: "order_intake_rejected",
      idempotencyKey: deriveOrderCancellationIdempotencyKey(candidate),
    });
    expect(repository.successes[0]).toMatchObject({ candidate });
  });

  it("records non-retryable provider failures for ops exception handling", async () => {
    const repository = new FakeOrderCancellationRepository([makeCandidate({ platform: "ebay" })]);
    const marketplaceCancellation = new FakeMarketplaceCancellationProvider(new DropshipError(
      "DROPSHIP_EBAY_ORDER_CANCELLATION_CONFIG_REQUIRED",
      "eBay order cancellation configuration is incomplete.",
      { retryable: false },
    ));
    const service = new DropshipOrderCancellationService({
      repository,
      marketplaceCancellation,
      clock: { now: () => now },
      logger: noopLogger,
    });

    const result = await service.processPendingCancellations({ workerId: "worker-1" });

    expect(result).toMatchObject({ attempted: 1, succeeded: 0, retrying: 0, failed: 1 });
    expect(repository.failures[0]).toMatchObject({
      errorCode: "DROPSHIP_EBAY_ORDER_CANCELLATION_CONFIG_REQUIRED",
      retryable: false,
    });
  });

  it("rejects invalid input before repository calls", async () => {
    const repository = new FakeOrderCancellationRepository([]);
    const service = new DropshipOrderCancellationService({
      repository,
      marketplaceCancellation: new FakeMarketplaceCancellationProvider({
        status: "cancelled",
        externalCancellationId: null,
        rawResult: {},
      }),
      clock: { now: () => now },
      logger: noopLogger,
    });

    await expect(service.processPendingCancellations({
      workerId: "",
      limit: 10,
    })).rejects.toMatchObject({ code: "DROPSHIP_ORDER_CANCELLATION_INVALID_INPUT" });
    expect(repository.lastClaimInput).toBeNull();
  });
});

describe("dropship order cancellation helpers", () => {
  it("builds marketplace cancellation requests from claimed candidates", () => {
    expect(buildCancellationRequest(makeCandidate())).toMatchObject({
      intakeId: 1,
      reason: "payment_hold_expired",
      idempotencyKey: deriveOrderCancellationIdempotencyKey(makeCandidate()),
    });
  });

  it("keeps retry cancellation reasons tied to the original intake reason", () => {
    expect(buildCancellationRequest(makeCandidate({
      cancellationStatus: "marketplace_cancellation_retrying",
      rejectionReason: "Payment hold expired before wallet funds were available.",
    }))).toMatchObject({ reason: "payment_hold_expired" });
    expect(buildCancellationRequest(makeCandidate({
      cancellationStatus: "marketplace_cancellation_retrying",
      rejectionReason: "Store connection status needs_reauth does not allow new dropship order intake.",
    }))).toMatchObject({ reason: "order_intake_rejected" });
  });
});

class FakeOrderCancellationRepository implements DropshipOrderCancellationRepository {
  lastClaimInput: Parameters<DropshipOrderCancellationRepository["claimPendingCancellations"]>[0] | null = null;
  successes: Array<Parameters<DropshipOrderCancellationRepository["recordMarketplaceCancellationSuccess"]>[0]> = [];
  failures: Array<Parameters<DropshipOrderCancellationRepository["recordMarketplaceCancellationFailure"]>[0]> = [];

  constructor(private readonly candidates: DropshipOrderCancellationCandidate[]) {}

  async claimPendingCancellations(
    input: Parameters<DropshipOrderCancellationRepository["claimPendingCancellations"]>[0],
  ): Promise<DropshipOrderCancellationCandidate[]> {
    this.lastClaimInput = input;
    return this.candidates;
  }

  async recordMarketplaceCancellationSuccess(
    input: Parameters<DropshipOrderCancellationRepository["recordMarketplaceCancellationSuccess"]>[0],
  ): Promise<void> {
    this.successes.push(input);
  }

  async recordMarketplaceCancellationFailure(
    input: Parameters<DropshipOrderCancellationRepository["recordMarketplaceCancellationFailure"]>[0],
  ): Promise<void> {
    this.failures.push(input);
  }
}

class FakeMarketplaceCancellationProvider implements DropshipMarketplaceOrderCancellationProvider {
  lastInput: DropshipMarketplaceOrderCancellationRequest | null = null;

  constructor(private readonly result: DropshipMarketplaceOrderCancellationResult | Error) {}

  async cancelOrder(
    input: DropshipMarketplaceOrderCancellationRequest,
  ): Promise<DropshipMarketplaceOrderCancellationResult> {
    this.lastInput = input;
    if (this.result instanceof Error) {
      throw this.result;
    }
    return this.result;
  }
}

function makeCandidate(
  overrides: Partial<DropshipOrderCancellationCandidate> = {},
): DropshipOrderCancellationCandidate {
  return {
    intakeId: 1,
    vendorId: 10,
    storeConnectionId: 22,
    platform: "shopify",
    externalOrderId: "1234567890",
    externalOrderNumber: "1001",
    sourceOrderId: null,
    orderedAt: "2026-05-02T17:55:00.000Z",
    rejectionReason: "Payment hold expired before wallet funds were available.",
    cancellationStatus: "payment_hold_expired",
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
