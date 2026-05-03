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
  type DropshipAutoReloadResult,
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

  it("starts minimum-balance auto-reload after an accepted order when configured", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const quoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService();
    const walletAutoReload = new FakeWalletAutoReloadService();
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      walletAutoReload,
      clock: { now: () => now },
      logger: noopLogger,
    });

    const input = {
      intakeId: 1,
      workerId: "worker-1",
      idempotencyKey: "process-intake-1",
    };
    const result = await service.processIntake(input);

    expect(result.outcome).toBe("accepted");
    expect(walletAutoReload.lastInput).toEqual({
      vendorId: 10,
      reason: "minimum_balance",
      intakeId: 1,
      idempotencyKey: deriveOrderProcessingIdempotencyKey("auto-reload-minimum", input),
    });
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

  it("starts wallet auto-reload when acceptance leaves the intake on payment hold", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const quoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService(null, {
      outcome: "payment_hold",
      intakeId: 1,
      vendorId: 10,
      storeConnectionId: 22,
      shippingQuoteSnapshotId: 33,
      omsOrderId: null,
      walletLedgerEntryId: null,
      economicsSnapshotId: null,
      totalDebitCents: 7500,
      currency: "USD",
      paymentHoldExpiresAt: new Date("2026-05-03T12:00:00.000Z"),
      idempotentReplay: false,
    });
    const walletAutoReload = new FakeWalletAutoReloadService();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      walletAutoReload,
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
      outcome: "payment_hold",
      intakeId: 1,
    });
    expect(walletAutoReload.lastInput).toEqual({
      vendorId: 10,
      reason: "payment_hold",
      requiredBalanceCents: 7500,
      intakeId: 1,
      idempotencyKey: deriveOrderProcessingIdempotencyKey("auto-reload-payment-hold", input),
    });
    expect(repository.failure).toBeNull();
  });

  it("does not fail payment-hold processing when auto-reload fails", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const quoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService(null, {
      outcome: "payment_hold",
      intakeId: 1,
      vendorId: 10,
      storeConnectionId: 22,
      shippingQuoteSnapshotId: 33,
      omsOrderId: null,
      walletLedgerEntryId: null,
      economicsSnapshotId: null,
      totalDebitCents: 7500,
      currency: "USD",
      paymentHoldExpiresAt: new Date("2026-05-03T12:00:00.000Z"),
      idempotentReplay: false,
    });
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      walletAutoReload: new FakeWalletAutoReloadService(new Error("Stripe declined")),
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.processIntake({
      intakeId: 1,
      workerId: "worker-1",
      idempotencyKey: "process-intake-1",
    });

    expect(result.outcome).toBe("payment_hold");
    expect(repository.failure).toBeNull();
    expect(logs.some((event) => event.code === "DROPSHIP_ORDER_PAYMENT_HOLD_AUTO_RELOAD_FAILED")).toBe(true);
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

  constructor(
    private readonly error: Error | null = null,
    private readonly result: DropshipOrderAcceptanceResult | null = null,
  ) {}

  async acceptOrder(input: unknown): Promise<DropshipOrderAcceptanceResult> {
    this.lastInput = input;
    if (this.error) {
      throw this.error;
    }
    if (this.result) {
      return this.result;
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

class FakeWalletAutoReloadService {
  lastInput: unknown = null;

  constructor(private readonly error: Error | null = null) {}

  async handleAutoReload(input: unknown): Promise<DropshipAutoReloadResult> {
    this.lastInput = input;
    if (this.error) {
      throw this.error;
    }
    return {
      outcome: "funding_created",
      vendorId: 10,
      fundingMethodId: 99,
      amountCents: 6500,
      currency: "USD",
      providerPaymentIntentId: "pi_auto_1",
      fundingLedgerEntryId: 501,
      fundingStatus: "settled",
      skipReason: null,
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
