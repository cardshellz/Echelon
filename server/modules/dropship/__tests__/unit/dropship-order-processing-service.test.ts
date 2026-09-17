import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  DropshipOrderProcessingService,
  aggregateQuoteItems,
  buildQuoteDestination,
  deriveAutoReloadIssueNotificationKey,
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
    const service = new DropshipOrderProcessingService({
      repository,
      shippingQuote: new FakeShippingQuoteService(),
      orderAcceptance: new FakeAcceptanceService(null, heldAcceptance()),
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
    expect(notificationSender.sent.filter((sent) => sent.eventType === "dropship_auto_reload_failed")).toEqual([]);
    expect(logs.some((event) => event.code === "DROPSHIP_ORDER_PAYMENT_HOLD_AUTO_RELOAD_FAILED")).toBe(true);
  });

  it("keeps the auto-reload notice when the decline does not pause anyone, and never pauses for a non-decline error", async () => {
    const pauses: unknown[] = [];
    const build = (error: Error, pauseOutcome: () => Promise<DropshipVendorStandingChange>) => {
      const notificationSender = new FakeNotificationSender();
      const logs: DropshipLogEvent[] = [];
      const service = new DropshipOrderProcessingService({
        repository: new FakeProcessingRepository(makeClaim()),
        shippingQuote: new FakeShippingQuoteService(),
        orderAcceptance: new FakeAcceptanceService(null, heldAcceptance()),
        walletAutoReload: new FakeWalletAutoReloadService(error),
        vendorStanding: { pauseForFundingFailure: async (input) => { pauses.push(input); return pauseOutcome(); } },
        notificationSender,
        clock: { now: () => now },
        logger: captureLogger(logs),
      });
      return { service, notificationSender, logs };
    };
    const unchanged = { outcome: "unchanged", standing: null, shortfallCents: null, listingHold: null } satisfies DropshipVendorStandingChange;

    // Already paused: the vendor still hears that this order's reload failed.
    const alreadyPaused = build(new DropshipError("DROPSHIP_STRIPE_CARD_DECLINED", "Declined.", { classification: "permanent" }), async () => unchanged);
    await alreadyPaused.service.processIntake({ intakeId: 1, workerId: "worker-1", idempotencyKey: "process-intake-1" });
    expect(pauses).toHaveLength(1);
    expect(alreadyPaused.notificationSender.sent.map((sent) => sent.eventType)).toEqual(["dropship_auto_reload_failed"]);

    // Standing failed: logged for a human, the order pass is unaffected.
    const standingDown = build(new DropshipError("DROPSHIP_STRIPE_CARD_DECLINED", "Declined.", { classification: "permanent" }), async () => { throw new Error("standing db down"); });
    const result = await standingDown.service.processIntake({ intakeId: 1, workerId: "worker-1", idempotencyKey: "process-intake-1" });
    expect(result.outcome).toBe("payment_hold");
    expect(pauses).toHaveLength(2);
    expect(standingDown.logs.find((event) => event.code === "DROPSHIP_ORDER_VENDOR_PAUSE_FAILED")).toMatchObject({
      context: expect.objectContaining({ intakeId: 1, vendorId: 10, error: "standing db down" }),
    });
    expect(standingDown.notificationSender.sent.map((sent) => sent.eventType)).toEqual(["dropship_auto_reload_failed"]);

    // A rate limit or outage is not a decline: nobody is paused for it.
    const transient = build(new DropshipError("DROPSHIP_STRIPE_RATE_LIMITED", "Slow down.", { classification: "transient" }), async () => unchanged);
    await transient.service.processIntake({ intakeId: 1, workerId: "worker-1", idempotencyKey: "process-intake-1" });
    expect(pauses).toHaveLength(2);
    expect(transient.notificationSender.sent.map((sent) => sent.eventType)).toEqual(["dropship_auto_reload_failed"]);
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
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_auto_reload_failed",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship auto-reload failed",
      idempotencyKey: deriveAutoReloadIssueNotificationKey({
        intakeId: 1,
        reason: "payment_hold",
        issueType: "failed",
        issueCode: "auto_reload_provider_error",
        issueMessage: "Stripe declined",
      }),
      payload: {
        intakeId: 1,
        autoReloadReason: "payment_hold",
        issueType: "failed",
        issueCode: "auto_reload_provider_error",
        issueMessage: "Stripe declined",
      },
    });
  });

  it("notifies when payment-hold auto-reload is skipped", async () => {
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
    expect(notificationSender.sent[0]).toMatchObject({
      eventType: "dropship_auto_reload_failed",
      critical: true,
      idempotencyKey: deriveAutoReloadIssueNotificationKey({
        intakeId: 1,
        reason: "payment_hold",
        issueType: "skipped",
        issueCode: "funding_method_required",
        issueMessage: "Auto-reload was skipped: funding_method_required.",
      }),
      payload: {
        autoReloadReason: "payment_hold",
        issueType: "skipped",
        issueCode: "funding_method_required",
      },
    });
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

/** Answers acceptOrder calls in order, so a hold followed by an acceptance can be scripted. */
class ScriptedAcceptanceService {
  inputs: unknown[] = [];

  constructor(private readonly script: Array<DropshipOrderAcceptanceResult | Error>) {}

  async acceptOrder(input: unknown): Promise<DropshipOrderAcceptanceResult> {
    this.inputs.push(input);
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
    currency: "USD",
    paymentHoldExpiresAt: new Date("2026-05-03T12:00:00.000Z"),
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
    currency: "USD",
    paymentHoldExpiresAt: null,
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
