import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  DropshipOrderProcessingService,
  aggregateQuoteItems,
  buildQuoteDestination,
  deriveOrderProcessingIdempotencyKey,
  type DropshipLogEvent,
  type DropshipOrderAcceptanceResult,
  type DropshipOrderProcessingClaim,
  type DropshipOrderProcessingIntakeRecord,
  type DropshipOrderProcessingQuoteItem,
  type DropshipOrderProcessingRepository,
  type DropshipShippingQuoteResult,
} from "../../application";

const now = new Date("2026-05-01T18:00:00.000Z");

describe("DropshipOrderProcessingService", () => {
  it("quotes shipping and accepts the intake with deterministic idempotency keys", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const quoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const input = {
      intakeId: 1,
      workerId: "worker-1",
      idempotencyKey: "process-intake-1",
    };
    const result = await service.processIntake(input);

    expect(result).toMatchObject({
      outcome: "accepted",
      intakeId: 1,
      shippingQuoteSnapshotId: 33,
      omsOrderId: 1001,
    });
    expect(quoteService.lastInput).toMatchObject({
      vendorId: 10,
      storeConnectionId: 22,
      warehouseId: 3,
      destination: { country: "US", postalCode: "10001", region: "NY" },
      items: [{ productVariantId: 101, quantity: 2 }],
      idempotencyKey: deriveOrderProcessingIdempotencyKey("quote", input),
    });
    expect(acceptanceService.lastInput).toMatchObject({
      intakeId: 1,
      vendorId: 10,
      storeConnectionId: 22,
      shippingQuoteSnapshotId: 33,
      idempotencyKey: deriveOrderProcessingIdempotencyKey("accept", input),
      actor: { actorType: "job", actorId: "worker-1" },
    });
    expect(repository.failure).toBeNull();
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_ORDER_PROCESSING_COMPLETED" });
  });

  it("marks the intake failed without quote or acceptance when warehouse config is missing", async () => {
    const repository = new FakeProcessingRepository(makeClaim({
      config: { defaultWarehouseId: null, warehouseConfigError: null },
    }));
    const quoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService();
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      clock: { now: () => now },
      logger: noopLogger,
    });

    const result = await service.processIntake({
      intakeId: 1,
      workerId: "worker-1",
      idempotencyKey: "process-intake-1",
    });

    expect(result).toMatchObject({
      outcome: "failed",
      failureCode: "DROPSHIP_ORDER_PROCESSING_WAREHOUSE_CONFIG_REQUIRED",
      retryable: false,
    });
    expect(quoteService.lastInput).toBeNull();
    expect(acceptanceService.lastInput).toBeNull();
    expect(repository.failure).toMatchObject({
      status: "failed",
      errorCode: "DROPSHIP_ORDER_PROCESSING_WAREHOUSE_CONFIG_REQUIRED",
      retryable: false,
    });
  });

  it("returns skipped without side effects when the intake is not claimable", async () => {
    const repository = new FakeProcessingRepository(makeClaim({
      claimed: false,
      skipReason: "Status accepted is not claimable for order processing.",
      intake: { ...baseIntake(), status: "accepted" },
    }));
    const quoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService();
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      clock: { now: () => now },
      logger: noopLogger,
    });

    const result = await service.processIntake({
      intakeId: 1,
      workerId: "worker-1",
      idempotencyKey: "process-intake-1",
    });

    expect(result).toMatchObject({
      outcome: "skipped",
      failureCode: "DROPSHIP_ORDER_PROCESSING_SKIPPED",
    });
    expect(quoteService.lastInput).toBeNull();
    expect(acceptanceService.lastInput).toBeNull();
    expect(repository.failure).toBeNull();
  });

  it("cancels a payment hold that expires during processing", async () => {
    const repository = new FakeProcessingRepository(makeClaim({
      intake: {
        ...baseIntake(),
        status: "processing",
        paymentHoldExpiresAt: new Date("2026-05-01T17:59:59.000Z"),
      },
    }));
    const quoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService(new DropshipError(
      "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED",
      "Dropship payment hold expired before order acceptance.",
    ));
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.processIntake({
      intakeId: 1,
      workerId: "worker-1",
      idempotencyKey: "process-intake-1",
    });

    expect(result).toMatchObject({
      outcome: "cancelled",
      failureCode: "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED",
      retryable: false,
    });
    expect(repository.expiredHold).toMatchObject({
      intakeId: 1,
      workerId: "worker-1",
      now,
    });
    expect(repository.failure).toBeNull();
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_ORDER_PROCESSING_PAYMENT_HOLD_EXPIRED" });
  });
});

describe("dropship order processing helpers", () => {
  it("builds quote destination from intake ship-to", () => {
    expect(buildQuoteDestination(baseIntake())).toEqual({
      country: "US",
      region: "NY",
      postalCode: "10001",
    });
  });

  it("aggregates quote items by variant and rejects invalid rows", () => {
    expect(aggregateQuoteItems([
      { lineIndex: 0, productVariantId: 101, quantity: 1 },
      { lineIndex: 1, productVariantId: 101, quantity: 2 },
      { lineIndex: 2, productVariantId: 202, quantity: 1 },
    ])).toEqual([
      { lineIndex: 0, productVariantId: 101, quantity: 3 },
      { lineIndex: 1, productVariantId: 202, quantity: 1 },
    ]);

    expectDropshipError(() => aggregateQuoteItems([
      { lineIndex: 0, productVariantId: 0, quantity: 1 },
    ]), "DROPSHIP_ORDER_PROCESSING_ITEM_VARIANT_INVALID");
  });
});

class FakeProcessingRepository implements DropshipOrderProcessingRepository {
  failure: Parameters<DropshipOrderProcessingRepository["markIntakeFailure"]>[0] | null = null;
  expiredHold: Parameters<DropshipOrderProcessingRepository["markPaymentHoldExpired"]>[0] | null = null;

  constructor(private readonly claim: DropshipOrderProcessingClaim) {}

  async claimIntake(): Promise<DropshipOrderProcessingClaim> {
    return this.claim;
  }

  async resolveQuoteItems(): Promise<DropshipOrderProcessingQuoteItem[]> {
    return this.claim.intake.normalizedPayload.lines.map((line, lineIndex) => ({
      lineIndex,
      productVariantId: line.productVariantId ?? 101,
      quantity: line.quantity,
    }));
  }

  async markIntakeFailure(
    input: Parameters<DropshipOrderProcessingRepository["markIntakeFailure"]>[0],
  ): Promise<void> {
    this.failure = input;
  }

  async markPaymentHoldExpired(
    input: Parameters<DropshipOrderProcessingRepository["markPaymentHoldExpired"]>[0],
  ): Promise<boolean> {
    this.expiredHold = input;
    return true;
  }
}

class FakeShippingQuoteService {
  lastInput: unknown = null;

  async quote(input: unknown): Promise<DropshipShippingQuoteResult> {
    this.lastInput = input;
    return {
      quoteSnapshotId: 33,
      idempotentReplay: false,
      vendorId: 10,
      storeConnectionId: 22,
      warehouseId: 3,
      destination: { country: "US", postalCode: "10001", region: "NY" },
      packageCount: 1,
      totalShippingCents: 1122,
      currency: "USD",
      carrierServices: [{ carrier: "USPS", service: "Ground Advantage" }],
      internalBreakdown: {
        baseRateCents: 1000,
        markupCents: 100,
        insurancePoolCents: 22,
        dunnageCents: 0,
        rateTableId: 4,
        requestHash: "quote-hash",
      },
    };
  }
}

class FakeAcceptanceService {
  lastInput: unknown = null;

  constructor(private readonly error: Error | null = null) {}

  async acceptOrder(input: unknown): Promise<DropshipOrderAcceptanceResult> {
    this.lastInput = input;
    if (this.error) {
      throw this.error;
    }
    return {
      outcome: "accepted",
      intakeId: 1,
      vendorId: 10,
      storeConnectionId: 22,
      shippingQuoteSnapshotId: 33,
      omsOrderId: 1001,
      walletLedgerEntryId: 2001,
      economicsSnapshotId: 3001,
      totalDebitCents: 2722,
      currency: "USD",
      paymentHoldExpiresAt: null,
      idempotentReplay: false,
    };
  }
}

function makeClaim(overrides: Partial<DropshipOrderProcessingClaim> = {}): DropshipOrderProcessingClaim {
  return {
    claimed: true,
    skipReason: null,
    intake: baseIntake(),
    config: { defaultWarehouseId: 3, warehouseConfigError: null },
    ...overrides,
  };
}

function baseIntake(): DropshipOrderProcessingIntakeRecord {
  return {
    intakeId: 1,
    vendorId: 10,
    storeConnectionId: 22,
    platform: "shopify",
    externalOrderId: "EXT-1",
    status: "processing",
    paymentHoldExpiresAt: null,
    normalizedPayload: {
      lines: [{
        productVariantId: 101,
        quantity: 2,
        unitRetailPriceCents: 1000,
        externalLineItemId: "line-1",
        title: "Shell",
      }],
      shipTo: {
        name: "Buyer Name",
        address1: "1 Main St",
        city: "New York",
        region: "NY",
        postalCode: "10001",
        country: "us",
      },
    },
  };
}

function expectDropshipError(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DropshipError);
  expect((thrown as DropshipError).code).toBe(code);
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
