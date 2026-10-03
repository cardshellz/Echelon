import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  DATABASE_CONSTRAINT_VIOLATION_CODE,
  DATABASE_QUERY_INVALID_CODE,
  DROPSHIP_OMS_LINE_AUTHORITY_REFUSED_CODE,
  DropshipOrderProcessingService,
  aggregateQuoteItems,
  classifyOrderProcessingError,
  buildQuoteDestination,
  deriveOrderProcessingIdempotencyKey,
  type DropshipNotificationSenderInput,
  type DropshipLogEvent,
  type DropshipOrderAcceptanceResult,
  type DropshipOrderProcessingClaim,
  type DropshipOrderProcessingIntakeRecord,
  type DropshipOrderProcessingQuoteItem,
  type DropshipOrderProcessingRepository,
  type DropshipOmsFulfillmentSync,
  type DropshipShippingQuoteResult,
  type DropshipAutoReloadResult,
  type DropshipVendorStandingChange,
  type DropshipAcceptanceNoticeContext,
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
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DROPSHIP_ORDER_PROCESSING_COMPLETED" }),
    ]));
  });

  // Order 22039 (intake 43): acceptance staged it with quote 3652; a later pass
  // with a new request key (an ops "Process" click) priced a new quote, and the
  // stage refused it as DROPSHIP_ORDER_ACCEPTANCE_IDEMPOTENCY_CONFLICT.
  it.each([
    { label: "the processing job's key", idempotencyKey: "dropship-order-processing:intake:1" },
    { label: "an ops Process click's new key", idempotencyKey: "admin-order-process-1-a1b2c3d4" },
  ])("replays the staged quote for a staged intake under $label", async ({ idempotencyKey }) => {
    const repository = new FakeProcessingRepository(makeClaim({ stagedShippingQuoteSnapshotId: 3652 }));
    const quoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService();
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      clock: { now: () => now },
      logger: noopLogger,
    });

    const result = await service.processIntake({ intakeId: 1, workerId: "worker-1", idempotencyKey });

    expect(quoteService.replayInputs).toEqual([{ vendorId: 10, storeConnectionId: 22, quoteSnapshotId: 3652 }]);
    expect(quoteService.lastInput).toBeNull();
    expect(repository.resolveQuoteItemsCalls).toBe(0);
    expect(acceptanceService.lastInput).toMatchObject({ intakeId: 1, shippingQuoteSnapshotId: 3652 });
    expect(result.outcome).toBe("accepted");
  });

  it("fails the pass without accepting when the staged quote cannot be loaded", async () => {
    const repository = new FakeProcessingRepository(makeClaim({ stagedShippingQuoteSnapshotId: 3652 }));
    const acceptanceService = new FakeAcceptanceService();
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: {
        replayQuoteSnapshot: async () => {
          throw new DropshipError(
            "DROPSHIP_SHIPPING_QUOTE_SNAPSHOT_NOT_FOUND",
            "The saved shipping quote was not found for this vendor and store.",
            { vendorId: 10, storeConnectionId: 22, quoteSnapshotId: 3652 },
          );
        },
        quote: async () => {
          throw new Error("A staged intake must not be quoted again.");
        },
      },
      orderAcceptance: acceptanceService,
      notificationSender: new FakeNotificationSender(),
      clock: { now: () => now },
      logger: noopLogger,
    });

    const result = await service.processIntake({ intakeId: 1, workerId: "worker-1", idempotencyKey: "process-intake-1" });

    expect(result).toMatchObject({
      outcome: "failed",
      failureCode: "DROPSHIP_SHIPPING_QUOTE_SNAPSHOT_NOT_FOUND",
      retryable: false,
    });
    expect(repository.failure).toMatchObject({ status: "failed", retryable: false });
    expect(acceptanceService.lastInput).toBeNull();
  });

  it("continues to acceptance when the quote carries packaging warnings", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const acceptanceService = new FakeAcceptanceService();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: new FakePackagingWarningQuoteService(),
      orderAcceptance: acceptanceService,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.processIntake({
      intakeId: 1,
      workerId: "worker-1",
      idempotencyKey: "process-intake-packaging-warning",
    });

    // A quote with PACKAGING_DATA_INCOMPLETE warnings is a successful quote:
    // acceptance proceeds and the order is not failed.
    expect(result).toMatchObject({
      outcome: "accepted",
      intakeId: 1,
    });
    expect(acceptanceService.lastInput).toMatchObject({
      intakeId: 1,
      shippingQuoteSnapshotId: 34,
    });
    expect(repository.failure).toBeNull();
  });

  it("syncs accepted dropship OMS orders into WMS", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const fulfillmentSync = new FakeFulfillmentSync(6001);
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: new FakeShippingQuoteService(),
      orderAcceptance: new FakeAcceptanceService(),
      fulfillmentSync,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.processIntake({
      intakeId: 1,
      workerId: "worker-1",
      idempotencyKey: "process-intake-1",
    });

    expect(result.outcome).toBe("accepted");
    expect(fulfillmentSync.calls).toEqual([1001]);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_ACCEPTED_ORDER_WMS_SYNCED",
        context: expect.objectContaining({
          intakeId: 1,
          omsOrderId: 1001,
          wmsOrderId: 6001,
          source: "order_processing",
        }),
      }),
    ]));
  });

  it("does not fail accepted processing when WMS sync is unresolved", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const fulfillmentSync = new FakeFulfillmentSync(null);
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: new FakeShippingQuoteService(),
      orderAcceptance: new FakeAcceptanceService(),
      fulfillmentSync,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.processIntake({
      intakeId: 1,
      workerId: "worker-1",
      idempotencyKey: "process-intake-1",
    });

    expect(result.outcome).toBe("accepted");
    expect(repository.failure).toBeNull();
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_ACCEPTED_ORDER_WMS_SYNC_UNRESOLVED",
        context: expect.objectContaining({ omsOrderId: 1001 }),
      }),
    ]));
  });

  it("does not fail accepted processing when WMS sync throws", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const fulfillmentSync = new FakeFulfillmentSync(null, new Error("connection timeout"));
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: new FakeShippingQuoteService(),
      orderAcceptance: new FakeAcceptanceService(),
      fulfillmentSync,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.processIntake({
      intakeId: 1,
      workerId: "worker-1",
      idempotencyKey: "process-intake-1",
    });

    expect(result.outcome).toBe("accepted");
    expect(repository.failure).toBeNull();
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_ACCEPTED_ORDER_WMS_SYNC_FAILED",
        context: expect.objectContaining({
          omsOrderId: 1001,
          error: "connection timeout",
        }),
      }),
    ]));
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
    const notificationSender = new FakeNotificationSender();
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      notificationSender,
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
    expect(notificationSender.sent[0]).toMatchObject({
      eventType: "dropship_order_processing_failed",
      critical: true,
      idempotencyKey: "order-processing:1:DROPSHIP_ORDER_PROCESSING_WAREHOUSE_CONFIG_REQUIRED",
    });
  });

  it("keeps processing retryable when a DropshipError is marked retryable", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const acceptanceService = new FakeAcceptanceService();
    const notificationSender = new FakeNotificationSender();
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: {
        replayQuoteSnapshot: unexpectedQuoteReplay,
        quote: async () => {
          throw new DropshipError(
            "DROPSHIP_CARRIER_RATE_PROVIDER_UNAVAILABLE",
            "Carrier rate provider is temporarily unavailable.",
            { retryable: true },
          );
        },
      },
      orderAcceptance: acceptanceService,
      notificationSender,
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
      failureCode: "DROPSHIP_CARRIER_RATE_PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    expect(repository.failure).toMatchObject({
      status: "retrying",
      errorCode: "DROPSHIP_CARRIER_RATE_PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    expect(acceptanceService.lastInput).toBeNull();
    expect(notificationSender.sent[0]).toMatchObject({
      eventType: "dropship_order_processing_retrying",
      critical: false,
      payload: {
        retryable: true,
      },
    });
  });

  it("leaves the intake failed, not retrying, when a database constraint refuses a write", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const acceptanceService = new FakeAcceptanceService();
    const notificationSender = new FakeNotificationSender();
    // The error order 22039 hit on every pass (intake 43), as node-postgres raises it.
    const constraintError = Object.assign(
      new Error(
        'insert or update on table "dropship_shipping_quote_snapshots" violates foreign key constraint "dropship_shipping_quote_snapshots_rate_table_id_fkey"',
      ),
      { code: "23503" },
    );
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: {
        replayQuoteSnapshot: unexpectedQuoteReplay,
        quote: async () => {
          throw constraintError;
        },
      },
      orderAcceptance: acceptanceService,
      notificationSender,
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
      failureCode: DATABASE_CONSTRAINT_VIOLATION_CODE,
      retryable: false,
    });
    expect(repository.failure).toMatchObject({
      status: "failed",
      errorCode: DATABASE_CONSTRAINT_VIOLATION_CODE,
      errorMessage: constraintError.message,
      retryable: false,
    });
    expect(acceptanceService.lastInput).toBeNull();
    // Staff keep the database error on the intake; the vendor is not shown table names.
    const notice = notificationSender.sent[0];
    expect(notice).toMatchObject({
      eventType: "dropship_order_processing_failed",
      critical: true,
      message: "Order intake 1 could not be processed: an internal Card Shellz error stopped it; the order is saved and Card Shellz staff can retry it.",
      payload: { failureCode: DATABASE_CONSTRAINT_VIOLATION_CODE },
    });
    expect(JSON.stringify(notice)).not.toContain("dropship_shipping_quote_snapshots");
  });

  it("leaves the intake failed, not retrying, when a query names a column the database does not have", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const notificationSender = new FakeNotificationSender();
    // The error order 22039 hit at acceptance once its quote saved (intake 43).
    const missingColumn = Object.assign(new Error("column p.tier does not exist"), { code: "42703" });
    const acceptanceService = new FakeAcceptanceService();
    acceptanceService.acceptOrder = async () => {
      throw missingColumn;
    };
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: new FakeShippingQuoteService(),
      orderAcceptance: acceptanceService,
      notificationSender,
      clock: { now: () => now },
      logger: noopLogger,
    });

    const result = await service.processIntake({
      intakeId: 1,
      workerId: "worker-1",
      idempotencyKey: "process-intake-1",
    });

    expect(result).toMatchObject({ outcome: "failed", failureCode: DATABASE_QUERY_INVALID_CODE, retryable: false });
    expect(repository.failure).toMatchObject({
      status: "failed",
      errorCode: DATABASE_QUERY_INVALID_CODE,
      errorMessage: "column p.tier does not exist",
      retryable: false,
    });
    expect(notificationSender.sent[0]).toMatchObject({
      eventType: "dropship_order_processing_failed",
      message: "Order intake 1 could not be processed: an internal Card Shellz error stopped it; the order is saved and Card Shellz staff can retry it.",
    });
    expect(JSON.stringify(notificationSender.sent[0])).not.toContain("p.tier");
  });

  it("leaves the intake failed, and tells the vendor only that staff can retry, when OMS refuses line authority", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const notificationSender = new FakeNotificationSender();
    const acceptanceService = new FakeAcceptanceService();
    acceptanceService.acceptOrder = async () => {
      throw new DropshipError(
        DROPSHIP_OMS_LINE_AUTHORITY_REFUSED_CODE,
        "OMS refused fulfillment authority for the accepted order's lines: A dropship OMS line was cancelled or refunded before its order was paid.",
        { intakeId: 1, omsOrderId: 1001, omsErrorCode: "OMS_LINE_AUTHORITY_GRANT_LINE_ADJUSTED" },
      );
    };
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: new FakeShippingQuoteService(),
      orderAcceptance: acceptanceService,
      notificationSender,
      clock: { now: () => now },
      logger: noopLogger,
    });

    const result = await service.processIntake({ intakeId: 1, workerId: "worker-1", idempotencyKey: "process-intake-1" });

    expect(result).toMatchObject({
      outcome: "failed",
      failureCode: DROPSHIP_OMS_LINE_AUTHORITY_REFUSED_CODE,
      retryable: false,
    });
    expect(repository.failure).toMatchObject({ status: "failed", retryable: false });
    expect(notificationSender.sent[0]).toMatchObject({
      eventType: "dropship_order_processing_failed",
      message: "Order intake 1 could not be processed: an internal Card Shellz error stopped it; the order is saved and Card Shellz staff can retry it.",
    });
    expect(JSON.stringify(notificationSender.sent[0])).not.toContain("OMS refused");
  });

  it("keeps an unexpected error that is not a constraint violation retryable", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: {
        replayQuoteSnapshot: unexpectedQuoteReplay,
        quote: async () => {
          throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
        },
      },
      orderAcceptance: new FakeAcceptanceService(),
      notificationSender: new FakeNotificationSender(),
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
      failureCode: "DROPSHIP_ORDER_PROCESSING_UNEXPECTED_ERROR",
      retryable: true,
    });
    expect(repository.failure).toMatchObject({ status: "retrying", retryable: true });
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
      rewardsCents: 0,
      currency: "USD",
      paymentHoldExpiresAt: new Date("2026-05-03T12:00:00.000Z"),
      paymentHoldReason: "insufficient_balance",
      advance: null,
      idempotentReplay: false,
    });
    const walletAutoReload = new FakeWalletAutoReloadService();
    const fulfillmentSync = new FakeFulfillmentSync(6001);
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      walletAutoReload,
      fulfillmentSync,
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
    expect(fulfillmentSync.calls).toEqual([]);
    expect(repository.failure).toBeNull();
  });

  it("accepts a held order in the same pass once its shortfall is charged to the card", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const quoteService = new FakeShippingQuoteService();
    const acceptanceService = new ScriptedAcceptanceService([heldAcceptance(), acceptedAfterHold()]);
    const walletAutoReload = new FakeWalletAutoReloadService(); // settled card credit
    const fulfillmentSync = new FakeFulfillmentSync(6001);
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      walletAutoReload,
      fulfillmentSync,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });
    const input = { intakeId: 1, workerId: "worker-1", idempotencyKey: "process-intake-1" };

    const result = await service.processIntake(input);

    // Charged, re-accepted, shipped: no parked order for the next pass to find.
    expect(result).toMatchObject({ outcome: "accepted", intakeId: 1, omsOrderId: 1001 });
    expect(acceptanceService.inputs).toHaveLength(2);
    expect(acceptanceService.inputs[1]).toMatchObject({
      intakeId: 1,
      idempotencyKey: deriveOrderProcessingIdempotencyKey("accept-after-reload", input),
    });
    // The two attempts must not share an idempotency key, or the second would replay the hold.
    expect((acceptanceService.inputs[1] as { idempotencyKey: string }).idempotencyKey)
      .not.toBe((acceptanceService.inputs[0] as { idempotencyKey: string }).idempotencyKey);
    expect(fulfillmentSync.calls).toEqual([1001]);
    expect(logs.some((entry) => entry.code === "DROPSHIP_ORDER_ACCEPTED_AFTER_RELOAD")).toBe(true);
    // One email for the pass: accepted. The hold that preceded it was never announced.
    expect(acceptanceService.options).toEqual([{ notify: false }, { notify: false }]);
    expect(acceptanceService.notified.map((notice) => notice.result.outcome)).toEqual(["accepted"]);
  });

  it("leaves a held order held when the reload is only pending (ACH), since pending funds are not spendable", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const acceptanceService = new ScriptedAcceptanceService([heldAcceptance()]);
    const walletAutoReload = new FakeWalletAutoReloadService({
      outcome: "funding_created",
      vendorId: 10,
      fundingMethodId: 100,
      amountCents: 7500,
      cardFeeCents: 0,
      chargedCents: 7500,
      currency: "USD",
      providerPaymentIntentId: "pi_ach_1",
      fundingLedgerEntryId: 502,
      fundingStatus: "pending",
      skipReason: null,
      idempotentReplay: false,
    });
    const fulfillmentSync = new FakeFulfillmentSync(6001);
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: new FakeShippingQuoteService(),
      orderAcceptance: acceptanceService,
      walletAutoReload,
      fulfillmentSync,
      clock: { now: () => now },
      logger: captureLogger([]),
    });

    const result = await service.processIntake({ intakeId: 1, workerId: "worker-1", idempotencyKey: "process-intake-1" });

    expect(result.outcome).toBe("payment_hold");
    expect(acceptanceService.inputs).toHaveLength(1);
    expect(fulfillmentSync.calls).toEqual([]);
    // One email: the hold, saying a bank top-up is on its way.
    expect(acceptanceService.notified).toEqual([{
      result: expect.objectContaining({ outcome: "payment_hold" }),
      context: { reload: { kind: "pending", amountCents: 7500, currency: "USD" } },
    }]);
  });

  it("keeps the hold, and the credit, when re-acceptance fails after the card was charged", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const acceptanceService = new ScriptedAcceptanceService([
      heldAcceptance(),
      new Error("inventory changed under us"),
    ]);
    const walletAutoReload = new FakeWalletAutoReloadService();
    const fulfillmentSync = new FakeFulfillmentSync(6001);
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: new FakeShippingQuoteService(),
      orderAcceptance: acceptanceService,
      walletAutoReload,
      fulfillmentSync,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.processIntake({ intakeId: 1, workerId: "worker-1", idempotencyKey: "process-intake-1" });

    // Not a processing failure: the wallet holds the credit and the intake
    // stays re-acceptable, so the next pass finishes the job with money in place.
    expect(result.outcome).toBe("payment_hold");
    expect(repository.failure).toBeNull();
    expect(fulfillmentSync.calls).toEqual([]);
    expect(logs.find((entry) => entry.code === "DROPSHIP_ORDER_REACCEPTANCE_AFTER_RELOAD_FAILED")).toMatchObject({
      context: expect.objectContaining({ intakeId: 1, reloadLedgerEntryId: 501, error: "inventory changed under us" }),
    });
  });

  it("pauses the vendor when the backstop card is declined outright, and lets the pause notice replace the auto-reload notice", async () => {
    const repository = new FakeProcessingRepository(makeClaim());
    const pauses: unknown[] = [];
    const notificationSender = new FakeNotificationSender();
    const logs: DropshipLogEvent[] = [];
    const acceptanceService = new FakeAcceptanceService(null, heldAcceptance());
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: new FakeShippingQuoteService(),
      orderAcceptance: acceptanceService,
      walletAutoReload: new FakeWalletAutoReloadService(new DropshipError("DROPSHIP_STRIPE_CARD_DECLINED", "Your card was declined.", {
        classification: "permanent",
        stripeCode: "card_declined",
        stripeDeclineCode: "insufficient_funds",
      })),
      vendorStanding: {
        pauseForFundingFailure: async (input) => {
          pauses.push(input);
          return { outcome: "paused", standing: null, shortfallCents: null, listingHold: null } satisfies DropshipVendorStandingChange;
        },
      },
      notificationSender,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.processIntake({ intakeId: 1, workerId: "worker-1", idempotencyKey: "process-intake-1" });

    expect(result.outcome).toBe("payment_hold");
    expect(pauses).toEqual([{
      vendorId: 10,
      reason: "card_declined",
      evidence: {
        source: "order_backstop",
        intakeId: 1,
        autoReloadReason: "payment_hold",
        failureCode: "DROPSHIP_STRIPE_CARD_DECLINED",
        stripeCode: "card_declined",
        stripeDeclineCode: "insufficient_funds",
      },
    }]);
    expect(notificationSender.sent).toEqual([]);
    expect(logs.some((event) => event.code === "DROPSHIP_ORDER_PAYMENT_HOLD_AUTO_RELOAD_FAILED")).toBe(true);
    // The pause notice stands in for the order notice in this pass.
    expect(acceptanceService.notified).toEqual([]);
    expect(logs.some((event) => event.code === "DROPSHIP_ORDER_HOLD_NOTICE_COVERED_BY_PAUSE")).toBe(true);
  });

  it("keeps the hold notice, with the decline in it, when the decline does not pause anyone, and never pauses for a non-decline error", async () => {
    const pauses: unknown[] = [];
    const build = (error: Error, pauseOutcome: () => Promise<DropshipVendorStandingChange>) => {
      const notificationSender = new FakeNotificationSender();
      const acceptanceService = new FakeAcceptanceService(null, heldAcceptance());
      const logs: DropshipLogEvent[] = [];
      const service = new DropshipOrderProcessingService({
        repository: new FakeProcessingRepository(makeClaim()),
        shippingQuote: new FakeShippingQuoteService(),
        orderAcceptance: acceptanceService,
        walletAutoReload: new FakeWalletAutoReloadService(error),
        vendorStanding: { pauseForFundingFailure: async (input) => { pauses.push(input); return pauseOutcome(); } },
        notificationSender,
        clock: { now: () => now },
        logger: captureLogger(logs),
      });
      return { service, acceptanceService, notificationSender, logs };
    };
    const unchanged = { outcome: "unchanged", standing: null, shortfallCents: null, listingHold: null } satisfies DropshipVendorStandingChange;
    const declineError = () => new DropshipError("DROPSHIP_STRIPE_CARD_DECLINED", "Declined.", { classification: "permanent", stripeDeclineCode: "insufficient_funds" });

    // Already paused: the vendor still hears that this order's card charge was declined.
    const alreadyPaused = build(declineError(), async () => unchanged);
    await alreadyPaused.service.processIntake({ intakeId: 1, workerId: "worker-1", idempotencyKey: "process-intake-1" });
    expect(pauses).toHaveLength(1);
    expect(alreadyPaused.notificationSender.sent).toEqual([]);
    expect(alreadyPaused.acceptanceService.notified).toEqual([{
      result: expect.objectContaining({ outcome: "payment_hold" }),
      context: { reload: { kind: "declined", detail: "insufficient_funds" } },
    }]);

    // Standing failed: logged for a human, the order pass is unaffected.
    const standingDown = build(declineError(), async () => { throw new Error("standing db down"); });
    const result = await standingDown.service.processIntake({ intakeId: 1, workerId: "worker-1", idempotencyKey: "process-intake-1" });
    expect(result.outcome).toBe("payment_hold");
    expect(pauses).toHaveLength(2);
    expect(standingDown.logs.find((event) => event.code === "DROPSHIP_ORDER_VENDOR_PAUSE_FAILED")).toMatchObject({
      context: expect.objectContaining({ intakeId: 1, vendorId: 10, error: "standing db down" }),
    });
    expect(standingDown.acceptanceService.notified.map((notice) => notice.context)).toEqual([{ reload: { kind: "declined", detail: "insufficient_funds" } }]);

    // A rate limit or outage is not a decline: nobody is paused for it, and the notice says it failed.
    const transient = build(new DropshipError("DROPSHIP_STRIPE_RATE_LIMITED", "Slow down.", { classification: "transient" }), async () => unchanged);
    await transient.service.processIntake({ intakeId: 1, workerId: "worker-1", idempotencyKey: "process-intake-1" });
    expect(pauses).toHaveLength(2);
    expect(transient.acceptanceService.notified.map((notice) => notice.context)).toEqual([{ reload: { kind: "failed", message: "Slow down." } }]);
  });

  it("does not charge the backstop card for an order held because the vendor is paused", async () => {
    const walletAutoReload = new FakeWalletAutoReloadService();
    const notificationSender = new FakeNotificationSender();
    const acceptanceService = new FakeAcceptanceService(null, { ...heldAcceptance(), paymentHoldReason: "vendor_paused" });
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository: new FakeProcessingRepository(makeClaim()),
      shippingQuote: new FakeShippingQuoteService(),
      orderAcceptance: acceptanceService,
      walletAutoReload,
      notificationSender,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.processIntake({ intakeId: 1, workerId: "worker-1", idempotencyKey: "process-intake-1" });

    expect(result).toMatchObject({ outcome: "payment_hold" });
    expect(walletAutoReload.lastInput).toBeNull();
    expect(logs.find((event) => event.code === "DROPSHIP_ORDER_BACKSTOP_SKIPPED_VENDOR_PAUSED")).toMatchObject({
      context: expect.objectContaining({ intakeId: 1, vendorId: 10 }),
    });
    expect(notificationSender.sent).toEqual([]);
    expect(acceptanceService.notified).toEqual([{ result: expect.objectContaining({ paymentHoldReason: "vendor_paused" }), context: { reload: null } }]);
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
      rewardsCents: 0,
      currency: "USD",
      paymentHoldExpiresAt: new Date("2026-05-03T12:00:00.000Z"),
      paymentHoldReason: "insufficient_balance",
      advance: null,
      idempotentReplay: false,
    });
    const logs: DropshipLogEvent[] = [];
    const notificationSender = new FakeNotificationSender();
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      walletAutoReload: new FakeWalletAutoReloadService(new Error("Stripe declined")),
      notificationSender,
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
    // One email: the hold, saying the top-up failed. No separate auto-reload email.
    expect(notificationSender.sent).toEqual([]);
    expect(acceptanceService.notified).toEqual([{
      result: expect.objectContaining({ outcome: "payment_hold", intakeId: 1 }),
      context: { reload: { kind: "failed", message: "Stripe declined" } },
    }]);
  });

  it("folds a skipped payment-hold auto-reload into the hold notice", async () => {
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
      rewardsCents: 0,
      currency: "USD",
      paymentHoldExpiresAt: new Date("2026-05-03T12:00:00.000Z"),
      paymentHoldReason: "insufficient_balance",
      advance: null,
      idempotentReplay: false,
    });
    const notificationSender = new FakeNotificationSender();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      walletAutoReload: new FakeWalletAutoReloadService({
        outcome: "skipped",
        vendorId: 10,
        fundingMethodId: null,
        amountCents: 0,
        cardFeeCents: 0,
        chargedCents: 0,
        currency: "USD",
        providerPaymentIntentId: null,
        fundingLedgerEntryId: null,
        fundingStatus: null,
        skipReason: "funding_method_required",
        idempotentReplay: false,
      }),
      notificationSender,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.processIntake({
      intakeId: 1,
      workerId: "worker-1",
      idempotencyKey: "process-intake-1",
    });

    expect(result.outcome).toBe("payment_hold");
    expect(logs.some((event) => event.code === "DROPSHIP_ORDER_PAYMENT_HOLD_AUTO_RELOAD_SKIPPED")).toBe(true);
    expect(notificationSender.sent).toEqual([]);
    expect(acceptanceService.notified).toEqual([{
      result: expect.objectContaining({ outcome: "payment_hold" }),
      context: { reload: { kind: "skipped", reason: "funding_method_required" } },
    }]);
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
    const notificationSender = new FakeNotificationSender();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: quoteService,
      orderAcceptance: acceptanceService,
      notificationSender,
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
    expect(notificationSender.sent[0]).toMatchObject({
      eventType: "dropship_order_payment_hold_expired",
      critical: true,
      idempotencyKey: "order-processing:1:payment-hold-expired",
    });
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_ORDER_PROCESSING_PAYMENT_HOLD_EXPIRED" });
  });
});

describe("dropship order processing helpers", () => {
  it.each(["23000", "23502", "23503", "23505", "23514", "23P01"])(
    "classifies SQLSTATE %s, an integrity constraint violation, as permanent",
    (code) => {
      expect(classifyOrderProcessingError(Object.assign(new Error("refused"), { code }))).toEqual({
        code: DATABASE_CONSTRAINT_VIOLATION_CODE,
        message: "refused",
        retryable: false,
      });
    },
  );

  it.each(["42501", "42601", "42703", "42883", "42P01"])(
    "classifies SQLSTATE %s, a query the database cannot run, as permanent",
    (code) => {
      expect(classifyOrderProcessingError(Object.assign(new Error("refused"), { code }))).toEqual({
        code: DATABASE_QUERY_INVALID_CODE,
        message: "refused",
        retryable: false,
      });
    },
  );

  it.each<{ code: string | number | undefined; reason: string }>([
    { code: "40001", reason: "serialization failure" },
    { code: "40P01", reason: "deadlock" },
    { code: "57014", reason: "statement timeout" },
    { code: "08006", reason: "connection failure" },
    { code: "ECONNRESET", reason: "socket reset" },
    { code: "EPIPE", reason: "a five-letter Node error code, not a SQLSTATE class 23 or 42" },
    { code: 23503, reason: "a numeric code, which no PostgreSQL error carries" },
    { code: undefined, reason: "no code" },
  ])("keeps code $code ($reason) retryable", ({ code }) => {
    expect(classifyOrderProcessingError(Object.assign(new Error("try again"), { code }))).toEqual({
      code: "DROPSHIP_ORDER_PROCESSING_UNEXPECTED_ERROR",
      message: "try again",
      retryable: true,
    });
  });

  it("leaves a DropshipError's own retryable flag in charge, and classifies non-Error throws", () => {
    expect(classifyOrderProcessingError(
      new DropshipError("DROPSHIP_X", "Refused.", { retryable: false, code: "40001" }),
    )).toEqual({ code: "DROPSHIP_X", message: "Refused.", retryable: false });
    expect(classifyOrderProcessingError("boom")).toEqual({
      code: "DROPSHIP_ORDER_PROCESSING_UNEXPECTED_ERROR",
      message: "boom",
      retryable: true,
    });
    expect(classifyOrderProcessingError(null)).toMatchObject({ retryable: true });
  });

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

  resolveQuoteItemsCalls = 0;

  constructor(private readonly claim: DropshipOrderProcessingClaim) {}

  async claimIntake(): Promise<DropshipOrderProcessingClaim> {
    return this.claim;
  }

  async resolveQuoteItems(): Promise<DropshipOrderProcessingQuoteItem[]> {
    this.resolveQuoteItemsCalls += 1;
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

async function unexpectedQuoteReplay(): Promise<DropshipShippingQuoteResult> {
  throw new Error("This test's intake has no acceptance stage; its quote must not be replayed.");
}

class FakeShippingQuoteService {
  lastInput: unknown = null;
  replayInputs: unknown[] = [];

  async replayQuoteSnapshot(input: { quoteSnapshotId: number }): Promise<DropshipShippingQuoteResult> {
    this.replayInputs.push(input);
    return { ...(await this.quoteResult()), quoteSnapshotId: input.quoteSnapshotId, idempotentReplay: true };
  }

  async quote(input: unknown): Promise<DropshipShippingQuoteResult> {
    this.lastInput = input;
    return this.quoteResult();
  }

  private async quoteResult(): Promise<DropshipShippingQuoteResult> {
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
      warnings: [],
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

class FakePackagingWarningQuoteService {
  replayQuoteSnapshot = unexpectedQuoteReplay;

  async quote(): Promise<DropshipShippingQuoteResult> {
    return {
      quoteSnapshotId: 34,
      idempotentReplay: false,
      vendorId: 10,
      storeConnectionId: 22,
      warehouseId: 3,
      destination: { country: "US", postalCode: "10001", region: "NY" },
      packageCount: 1,
      totalShippingCents: 1122,
      currency: "USD",
      carrierServices: [{ carrier: "USPS", service: "Ground Advantage" }],
      // Quote succeeded with degraded (weight-only) packaging — order
      // acceptance must continue.
      warnings: [{
        code: "PACKAGING_DATA_INCOMPLETE",
        reason: "missing_dims",
        productVariantIds: [101],
        message: "One or more variants are missing catalog dimensions; quoted as weight-only packages.",
      }],
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
  options: unknown[] = [];
  notified: Array<{ result: DropshipOrderAcceptanceResult; context: DropshipAcceptanceNoticeContext }> = [];

  constructor(
    private readonly error: Error | null = null,
    private readonly result: DropshipOrderAcceptanceResult | null = null,
  ) {}

  async notifyAcceptanceOutcome(result: DropshipOrderAcceptanceResult, context: DropshipAcceptanceNoticeContext = {}): Promise<void> {
    this.notified.push({ result, context });
  }

  async acceptOrder(input: unknown, options?: unknown): Promise<DropshipOrderAcceptanceResult> {
    this.lastInput = input;
    this.options.push(options);
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
      rewardsCents: 0,
      currency: "USD",
      paymentHoldExpiresAt: null,
      paymentHoldReason: null,
      advance: null,
      idempotentReplay: false,
    };
  }
}

/** Answers acceptOrder calls in order, so a hold followed by an acceptance can be scripted. */
class ScriptedAcceptanceService {
  inputs: unknown[] = [];
  options: unknown[] = [];
  notified: Array<{ result: DropshipOrderAcceptanceResult; context: DropshipAcceptanceNoticeContext }> = [];

  constructor(private readonly script: Array<DropshipOrderAcceptanceResult | Error>) {}

  async notifyAcceptanceOutcome(result: DropshipOrderAcceptanceResult, context: DropshipAcceptanceNoticeContext = {}): Promise<void> {
    this.notified.push({ result, context });
  }

  async acceptOrder(input: unknown, options?: unknown): Promise<DropshipOrderAcceptanceResult> {
    this.inputs.push(input);
    this.options.push(options);
    const next = this.script[this.inputs.length - 1];
    if (!next) throw new Error(`acceptOrder called ${this.inputs.length} times; only ${this.script.length} scripted`);
    if (next instanceof Error) throw next;
    return next;
  }
}

function heldAcceptance(): DropshipOrderAcceptanceResult {
  return {
    outcome: "payment_hold",
    intakeId: 1,
    vendorId: 10,
    storeConnectionId: 22,
    shippingQuoteSnapshotId: 33,
    omsOrderId: null,
    walletLedgerEntryId: null,
    economicsSnapshotId: null,
    totalDebitCents: 7500,
    rewardsCents: 0,
    currency: "USD",
    paymentHoldExpiresAt: new Date("2026-05-03T12:00:00.000Z"),
    paymentHoldReason: "insufficient_balance",
    advance: null,
    idempotentReplay: false,
  };
}

function acceptedAfterHold(): DropshipOrderAcceptanceResult {
  return {
    outcome: "accepted",
    intakeId: 1,
    vendorId: 10,
    storeConnectionId: 22,
    shippingQuoteSnapshotId: 33,
    omsOrderId: 1001,
    walletLedgerEntryId: 2002,
    economicsSnapshotId: 3001,
    totalDebitCents: 7500,
    rewardsCents: 0,
    currency: "USD",
    paymentHoldExpiresAt: null,
    paymentHoldReason: null,
    advance: null,
    idempotentReplay: false,
  };
}

class FakeWalletAutoReloadService {
  lastInput: unknown = null;

  constructor(private readonly result: DropshipAutoReloadResult | Error | null = null) {}

  async handleAutoReload(input: unknown): Promise<DropshipAutoReloadResult> {
    this.lastInput = input;
    if (this.result instanceof Error) {
      throw this.result;
    }
    if (this.result) {
      return this.result;
    }
    return {
      outcome: "funding_created",
      vendorId: 10,
      fundingMethodId: 99,
      amountCents: 6500,
      cardFeeCents: 195,
      chargedCents: 6695,
      currency: "USD",
      providerPaymentIntentId: "pi_auto_1",
      fundingLedgerEntryId: 501,
      fundingStatus: "settled",
      skipReason: null,
      idempotentReplay: false,
    };
  }
}

class FakeFulfillmentSync implements DropshipOmsFulfillmentSync {
  calls: number[] = [];

  constructor(
    private readonly result: number | null,
    private readonly error: Error | null = null,
  ) {}

  async syncOmsOrderToWms(omsOrderId: number): Promise<number | null> {
    this.calls.push(omsOrderId);
    if (this.error) {
      throw this.error;
    }
    return this.result;
  }
}

class FakeNotificationSender {
  sent: DropshipNotificationSenderInput[] = [];

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    this.sent.push(input);
  }
}

function makeClaim(overrides: Partial<DropshipOrderProcessingClaim> = {}): DropshipOrderProcessingClaim {
  return {
    claimed: true,
    skipReason: null,
    intake: baseIntake(),
    config: { defaultWarehouseId: 3, warehouseConfigError: null },
    stagedShippingQuoteSnapshotId: null,
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
