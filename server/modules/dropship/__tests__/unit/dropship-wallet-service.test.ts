import { beforeEach, describe, expect, it } from "vitest";
import type { DropshipVendorStatus } from "../../../../../shared/schema/dropship.schema";
import { DropshipError } from "../../domain/errors";
import type {
  DropshipLogEvent,
  DropshipNotificationSenderInput,
} from "../../application/dropship-ports";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "../../application/dropship-vendor-provisioning-service";
import {
  DropshipWalletService,
  resolveDropshipAutoReloadFloors,
  resolveDropshipCardFundingFeeBps,
  resolveDropshipUsdcBaseDepositAddress,
  type ConfigureDropshipAutoReloadRepositoryInput,
  type CreateDropshipConfirmedUsdcFundingRepositoryInput,
  type CreateDropshipWalletFundingLedgerInput,
  type CreateDropshipWalletOrderDebitInput,
  type DropshipAutoReloadSettingRecord,
  type DropshipAutoReloadResult,
  type DropshipConfirmedUsdcFundingResult,
  type DropshipFundingMethodMutationResult,
  type DropshipFundingMethodRecord,
  type DropshipStripeAutoReloadPaymentIntent,
  type DropshipStripeFundingSetupSession,
  type DropshipStripeWalletFundingSession,
  type DropshipUsdcLedgerEntryRecord,
  type DropshipWalletAccountRecord,
  type DropshipWalletFundingFailureRepositoryResult,
  type DropshipWalletFundingProvider,
  type DropshipWalletLedgerRecord,
  type DropshipWalletMutationResult,
  type DropshipWalletOverview,
  type DropshipWalletRepository,
  type FailDropshipPendingFundingRepositoryInput,
  type UpsertDropshipFundingMethodRepositoryInput,
} from "../../application/dropship-wallet-service";

const now = new Date("2026-05-01T20:00:00.000Z");

describe("DropshipWalletService", () => {
  let repository: FakeWalletRepository;
  let fundingProvider: FakeFundingProvider;
  let notificationSender: FakeNotificationSender;
  let logs: Array<DropshipLogEvent & { level: "info" | "warn" | "error" }>;
  let service: DropshipWalletService;

  beforeEach(() => {
    repository = new FakeWalletRepository();
    fundingProvider = new FakeFundingProvider();
    notificationSender = new FakeNotificationSender();
    logs = [];
    service = buildService();
  });

  function buildService(overrides: { vendorStanding?: FakeVendorStandingService } = {}): DropshipWalletService {
    return new DropshipWalletService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      fundingProvider,
      notificationSender,
      vendorStanding: overrides.vendorStanding,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push({ ...event, level: "info" }),
        warn: (event) => logs.push({ ...event, level: "warn" }),
        error: (event) => logs.push({ ...event, level: "error" }),
      },
      // The launch rate, pinned so the assertions below do not depend on the environment.
      cardFundingFeeBps: 300,
    });
  }

  it("credits settled card funding into available balance idempotently", async () => {
    const first = await service.creditFunding({
      vendorId: 10,
      fundingMethodId: 99,
      rail: "stripe_card",
      status: "settled",
      amountCents: 5000,
      currency: "USD",
      referenceType: "stripe_payment_intent",
      referenceId: "pi_1",
      idempotencyKey: "funding-pi-1",
    });
    const replay = await service.creditFunding({
      vendorId: 10,
      fundingMethodId: 99,
      rail: "stripe_card",
      status: "settled",
      amountCents: 5000,
      currency: "USD",
      referenceType: "stripe_payment_intent",
      referenceId: "pi_1",
      idempotencyKey: "funding-pi-1",
    });

    expect(first.account.availableBalanceCents).toBe(5000);
    expect(first.account.pendingBalanceCents).toBe(0);
    expect(first.ledgerEntry).toMatchObject({
      type: "funding",
      status: "settled",
      amountCents: 5000,
      availableBalanceAfterCents: 5000,
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(repository.ledger).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  it("notifies vendors when Stripe wallet funding fails", async () => {
    await service.recordWalletFundingFailure({
      vendorId: 10,
      fundingMethodId: 99,
      rail: "stripe_card",
      amountCents: 25000,
      currency: "USD",
      provider: "stripe",
      providerEventId: "evt_failed_1",
      providerPaymentIntentId: "pi_failed_1",
      providerStatus: "requires_payment_method",
      failureCode: "card_declined",
      failureMessage: "Your card was declined.",
      autoReload: false,
      idempotencyKey: "stripe-funding-failed:pi_failed_1",
    });

    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_WALLET_FUNDING_FAILED",
      context: expect.objectContaining({
        vendorId: 10,
        fundingMethodId: 99,
        amountCents: 25000,
        providerPaymentIntentId: "pi_failed_1",
        failureCode: "card_declined",
      }),
    });
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_wallet_funding_failed",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship wallet funding failed",
      idempotencyKey: "stripe-funding-failed:pi_failed_1",
      payload: {
        vendorId: 10,
        fundingMethodId: 99,
        rail: "stripe_card",
        amountCents: 25000,
        currency: "USD",
        provider: "stripe",
        providerEventId: "evt_failed_1",
        providerPaymentIntentId: "pi_failed_1",
        providerStatus: "requires_payment_method",
        failureCode: "card_declined",
        failureMessage: "Your card was declined.",
        autoReload: false,
        autoReloadReason: null,
        intakeId: null,
      },
    });
  });

  it("does not fail funding failure handling when notification delivery fails", async () => {
    notificationSender.error = new Error("email unavailable");

    await service.recordWalletFundingFailure({
      vendorId: 10,
      fundingMethodId: 99,
      rail: "stripe_card",
      amountCents: 25000,
      currency: "USD",
      provider: "stripe",
      providerEventId: "evt_failed_1",
      providerPaymentIntentId: "pi_failed_1",
      providerStatus: "requires_payment_method",
      failureCode: "card_declined",
      failureMessage: "Your card was declined.",
      autoReload: false,
      idempotencyKey: "stripe-funding-failed:pi_failed_1",
    });

    expect(notificationSender.sent).toHaveLength(1);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_WALLET_FUNDING_FAILURE_NOTIFICATION_FAILED",
        context: expect.objectContaining({
          vendorId: 10,
          fundingMethodId: 99,
          provider: "stripe",
          providerPaymentIntentId: "pi_failed_1",
          error: "email unavailable",
        }),
      }),
    ]));
  });

  it("keeps pending ACH funding out of spendable balance", async () => {
    await service.creditFunding({
      vendorId: 10,
      fundingMethodId: 100,
      rail: "stripe_ach",
      status: "pending",
      amountCents: 4000,
      currency: "USD",
      referenceType: "stripe_payment_intent",
      referenceId: "pi_ach_pending",
      idempotencyKey: "funding-ach-1",
    });

    expect(repository.account.availableBalanceCents).toBe(0);
    expect(repository.account.pendingBalanceCents).toBe(4000);
    await expect(service.debitForOrder({
      vendorId: 10,
      intakeId: 123,
      amountCents: 1000,
      currency: "USD",
      idempotencyKey: "order-debit-123",
    })).rejects.toMatchObject({ code: "DROPSHIP_WALLET_INSUFFICIENT_FUNDS" });
  });

  it("settles pending ACH funding into the same ledger entry without double credit", async () => {
    const pending = await service.creditFunding({
      vendorId: 10,
      fundingMethodId: 100,
      rail: "stripe_ach",
      status: "pending",
      amountCents: 4000,
      currency: "USD",
      referenceType: "stripe_payment_intent",
      referenceId: "pi_ach",
      idempotencyKey: "stripe-funding:pi_ach",
    });
    const settled = await service.creditFunding({
      vendorId: 10,
      fundingMethodId: 100,
      rail: "stripe_ach",
      status: "settled",
      amountCents: 4000,
      currency: "USD",
      referenceType: "stripe_payment_intent",
      referenceId: "pi_ach",
      externalTransactionId: "ch_ach",
      idempotencyKey: "stripe-funding:pi_ach",
    });

    expect(pending.ledgerEntry.ledgerEntryId).toBe(settled.ledgerEntry.ledgerEntryId);
    expect(settled.idempotentReplay).toBe(false);
    expect(settled.account.availableBalanceCents).toBe(4000);
    expect(settled.account.pendingBalanceCents).toBe(0);
    expect(settled.ledgerEntry).toMatchObject({
      status: "settled",
      amountCents: 4000,
      availableBalanceAfterCents: 4000,
      pendingBalanceAfterCents: 0,
      externalTransactionId: "ch_ach",
    });
    expect(repository.ledger).toHaveLength(1);
  });

  it("treats late pending wallet funding webhooks as idempotent after settlement", async () => {
    const settled = await service.creditFunding({
      vendorId: 10,
      fundingMethodId: 100,
      rail: "stripe_ach",
      status: "settled",
      amountCents: 4000,
      currency: "USD",
      referenceType: "stripe_payment_intent",
      referenceId: "pi_ach_late",
      externalTransactionId: "ch_ach",
      idempotencyKey: "stripe-funding:pi_ach_late",
    });
    const latePending = await service.creditFunding({
      vendorId: 10,
      fundingMethodId: 100,
      rail: "stripe_ach",
      status: "pending",
      amountCents: 4000,
      currency: "USD",
      referenceType: "stripe_payment_intent",
      referenceId: "pi_ach_late",
      idempotencyKey: "stripe-funding:pi_ach_late",
    });

    expect(latePending.idempotentReplay).toBe(true);
    expect(latePending.ledgerEntry.ledgerEntryId).toBe(settled.ledgerEntry.ledgerEntryId);
    expect(latePending.account.availableBalanceCents).toBe(4000);
    expect(latePending.account.pendingBalanceCents).toBe(0);
    expect(repository.ledger).toHaveLength(1);
  });

  it("credits admin manual funding without a stored funding method", async () => {
    const result = await service.creditManualFunding({
      vendorId: 10,
      amountCents: 12500,
      currency: "USD",
      reason: "Internal dogfood wallet seed",
      idempotencyKey: "admin-manual-credit-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.account.availableBalanceCents).toBe(12500);
    expect(result.ledgerEntry).toMatchObject({
      type: "funding",
      status: "settled",
      amountCents: 12500,
      referenceType: "admin_manual_wallet_credit",
      referenceId: "admin-manual-credit-1",
      idempotencyKey: "admin-manual-credit-1",
      fundingMethodId: null,
      metadata: expect.objectContaining({
        rail: "manual",
        reason: "Internal dogfood wallet seed",
        actorType: "admin",
        actorId: "admin-1",
      }),
    });
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_WALLET_MANUAL_FUNDING_CREDITED",
        context: expect.objectContaining({
          vendorId: 10,
          amountCents: 12500,
        }),
      }),
    ]));
  });

  it("credits confirmed USDC Base funding atomically with a USDC ledger entry", async () => {
    repository.fundingMethods.push(makeFundingMethod({
      fundingMethodId: 101,
      rail: "usdc_base",
      providerCustomerId: null,
      providerPaymentMethodId: null,
      usdcWalletAddress: "0x1111111111111111111111111111111111111111",
      displayLabel: "USDC on Base",
      isDefault: false,
    }));

    const result = await service.creditConfirmedUsdcFunding({
      vendorId: 10,
      fundingMethodId: 101,
      amountCents: 2500,
      currency: "USD",
      amountAtomicUnits: "25000000",
      chainId: 8453,
      transactionHash: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      fromAddress: "0x2222222222222222222222222222222222222222",
      toAddress: "0x1111111111111111111111111111111111111111",
      confirmations: 12,
      idempotencyKey: "usdc-credit-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });
    const replay = await service.creditConfirmedUsdcFunding({
      vendorId: 10,
      fundingMethodId: 101,
      amountCents: 2500,
      currency: "USD",
      amountAtomicUnits: "25000000",
      chainId: 8453,
      transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      fromAddress: "0x2222222222222222222222222222222222222222",
      toAddress: "0x1111111111111111111111111111111111111111",
      confirmations: 12,
      idempotencyKey: "usdc-credit-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.account.availableBalanceCents).toBe(2500);
    expect(result.ledgerEntry).toMatchObject({
      type: "funding",
      status: "settled",
      amountCents: 2500,
      referenceType: "usdc_base_transaction",
      referenceId: "8453:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      fundingMethodId: 101,
      externalTransactionId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      metadata: expect.objectContaining({
        rail: "usdc_base",
        amountAtomicUnits: "25000000",
        actorType: "admin",
      }),
    });
    expect(result.usdcLedgerEntry).toMatchObject({
      walletLedgerId: result.ledgerEntry.ledgerEntryId,
      chainId: 8453,
      transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      amountAtomicUnits: "25000000",
      status: "settled",
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(repository.ledger).toHaveLength(1);
    expect(repository.usdcLedger).toHaveLength(1);
  });

  it("rejects USDC funding when the selected funding method is not a USDC rail", async () => {
    await expect(service.creditConfirmedUsdcFunding({
      vendorId: 10,
      fundingMethodId: 99,
      amountCents: 2500,
      currency: "USD",
      amountAtomicUnits: "25000000",
      chainId: 8453,
      transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      toAddress: "0x1111111111111111111111111111111111111111",
      confirmations: 12,
      idempotencyKey: "usdc-credit-wrong-rail",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toMatchObject({ code: "DROPSHIP_FUNDING_METHOD_RAIL_MISMATCH" });
  });

  it("debits accepted orders as negative settled ledger entries", async () => {
    repository.account = {
      ...repository.account,
      availableBalanceCents: 7500,
    };

    const result = await service.debitForOrder({
      vendorId: 10,
      intakeId: 456,
      amountCents: 2250,
      currency: "USD",
      idempotencyKey: "order-debit-456",
    });

    expect(result.account.availableBalanceCents).toBe(5250);
    expect(result.ledgerEntry).toMatchObject({
      type: "order_debit",
      status: "settled",
      amountCents: -2250,
      referenceType: "order_intake",
      referenceId: "456",
    });
  });

  it("rejects idempotency reuse with a different wallet transaction", async () => {
    await service.creditFunding({
      vendorId: 10,
      fundingMethodId: 99,
      rail: "stripe_card",
      status: "settled",
      amountCents: 5000,
      currency: "USD",
      referenceType: "stripe_payment_intent",
      referenceId: "pi_1",
      idempotencyKey: "funding-pi-1",
    });

    await expect(service.creditFunding({
      vendorId: 10,
      fundingMethodId: 99,
      rail: "stripe_card",
      status: "settled",
      amountCents: 6000,
      currency: "USD",
      referenceType: "stripe_payment_intent",
      referenceId: "pi_1",
      idempotencyKey: "funding-pi-1",
    })).rejects.toMatchObject({ code: "DROPSHIP_WALLET_IDEMPOTENCY_CONFLICT" });
  });

  it("rejects funding events that do not match the stored funding method rail", async () => {
    await expect(service.creditFunding({
      vendorId: 10,
      fundingMethodId: 99,
      rail: "stripe_ach",
      status: "settled",
      amountCents: 5000,
      currency: "USD",
      referenceType: "stripe_payment_intent",
      referenceId: "pi_wrong_rail",
      idempotencyKey: "funding-wrong-rail",
    })).rejects.toMatchObject({ code: "DROPSHIP_FUNDING_METHOD_RAIL_MISMATCH" });
  });

  it("requires a funding method when auto-reload is enabled", async () => {
    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: null,
      enabled: true,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({ code: "DROPSHIP_AUTO_RELOAD_FUNDING_METHOD_REQUIRED" });
  });

  it("rejects enabled auto-reload thresholds that cannot safely reload", async () => {
    // A trigger below the floor leaves the balance sitting above the trigger
    // while still failing to cover a single order: auto-reload would be on and
    // the order would still go to payment hold.
    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 0,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({
      code: "DROPSHIP_AUTO_RELOAD_TRIGGER_BELOW_MINIMUM",
      context: expect.objectContaining({ floorCents: 5000 }),
    });

    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 2500,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({ code: "DROPSHIP_AUTO_RELOAD_TRIGGER_BELOW_MINIMUM" });

    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 5000,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({
      code: "DROPSHIP_AUTO_RELOAD_AMOUNT_BELOW_MINIMUM",
      context: expect.objectContaining({ floorCents: 10000 }),
    });

    // A standing card mandate is always bounded: an unbounded reload is refused.
    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: null,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({ code: "DROPSHIP_AUTO_RELOAD_AMOUNT_REQUIRED" });

    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 20000,
      maxSingleReloadCents: 10000,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({ code: "DROPSHIP_AUTO_RELOAD_INVALID_LIMITS" });
  });

  it("accepts a bank account as the routine auto-reload method", async () => {
    // Funding method 100 is the ACH method in the fixture. Routine top-ups may
    // run on ACH; a held order is charged to the card on file instead.
    const setting = await service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 100,
      enabled: true,
      minimumBalanceCents: 50_000,
      maxSingleReloadCents: 100_000,
      paymentHoldTimeoutMinutes: 2880,
    });
    expect(setting).toMatchObject({ enabled: true, fundingMethodId: 100 });

    // USDC is push-only and can never be pulled from, so it is still refused.
    repository.fundingMethods.push(makeFundingMethod({
      fundingMethodId: 200, rail: "usdc_base", providerCustomerId: null, providerPaymentMethodId: null, isDefault: false,
    }));
    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 200,
      enabled: true,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({
      code: "DROPSHIP_AUTO_RELOAD_FUNDING_METHOD_RAIL_UNSUPPORTED",
      context: expect.objectContaining({ rail: "usdc_base" }),
    });
  });

  it("refuses to disable auto-reload while the vendor account is active", async () => {
    repository.vendorStatus = "active";

    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: false,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({
      code: "DROPSHIP_AUTO_RELOAD_REQUIRED_WHILE_ACTIVE",
      context: expect.objectContaining({ vendorId: 10, vendorStatus: "active" }),
    });
  });

  it("allows a vendor that is not live to disable auto-reload", async () => {
    for (const status of ["onboarding", "paused", "closed"] as const) {
      repository.vendorStatus = status;
      const setting = await service.configureAutoReload({
        vendorId: 10,
        fundingMethodId: 99,
        enabled: false,
        minimumBalanceCents: 5000,
        maxSingleReloadCents: 25000,
        paymentHoldTimeoutMinutes: 2880,
      });
      expect(setting.enabled).toBe(false);
    }
  });

  it("configures auto-reload with an active funding method", async () => {
    const setting = await service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
    });

    expect(setting).toMatchObject({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
    });
    expect(logs.at(-1)).toMatchObject({ code: "DROPSHIP_AUTO_RELOAD_CONFIGURED" });
  });

  it("rejects non-Stripe funding methods for enabled auto-reload", async () => {
    repository.fundingMethods.push(makeFundingMethod({
      fundingMethodId: 101,
      rail: "usdc_base",
      providerCustomerId: null,
      providerPaymentMethodId: null,
      usdcWalletAddress: "0x1111111111111111111111111111111111111111",
      displayLabel: "USDC on Base",
      isDefault: false,
    }));

    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 101,
      enabled: true,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({ code: "DROPSHIP_AUTO_RELOAD_FUNDING_METHOD_RAIL_UNSUPPORTED" });
  });

  it("creates an off-session card auto-reload and credits the wallet ledger", async () => {
    repository.autoReload = makeAutoReloadSetting({
      fundingMethodId: 99,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
    });
    repository.account = {
      ...repository.account,
      availableBalanceCents: 1000,
    };

    const result = await service.handleAutoReload({
      vendorId: 10,
      reason: "payment_hold",
      requiredBalanceCents: 7500,
      intakeId: 456,
      idempotencyKey: "auto-reload-intake-456",
    });

    expect(result).toMatchObject({
      outcome: "funding_created",
      vendorId: 10,
      fundingMethodId: 99,
      amountCents: 6500,
      currency: "USD",
      providerPaymentIntentId: "pi_auto_6500",
      fundingLedgerEntryId: 1,
      fundingStatus: "settled",
    } satisfies Partial<DropshipAutoReloadResult>);
    expect(repository.account.availableBalanceCents).toBe(7500);
    expect(repository.ledger[0]).toMatchObject({
      type: "funding",
      status: "settled",
      amountCents: 6500,
      referenceType: "stripe_payment_intent",
      referenceId: "pi_auto_6500",
      idempotencyKey: "stripe-funding:pi_auto_6500",
      fundingMethodId: 99,
    });
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_AUTO_RELOAD_FUNDING_CREATED",
      context: expect.objectContaining({
        reason: "payment_hold",
        intakeId: 456,
        amountCents: 6500,
      }),
    });
  });

  it("counts credits still settling toward a routine top-up, so an ACH reload in flight is not stacked", async () => {
    repository.autoReload = makeAutoReloadSetting({ fundingMethodId: 100, minimumBalanceCents: 5000 });
    repository.account = { ...repository.account, availableBalanceCents: 1000, pendingBalanceCents: 4000 };

    const covered = await service.handleAutoReload({ vendorId: 10, reason: "minimum_balance", idempotencyKey: "routine-pending-1" });
    expect(covered).toMatchObject({ outcome: "skipped", skipReason: "balance_already_sufficient" });
    expect(fundingProvider.paymentIntentInputs).toHaveLength(0);

    repository.account = { ...repository.account, pendingBalanceCents: 2500 };
    const topped = await service.handleAutoReload({ vendorId: 10, reason: "minimum_balance", idempotencyKey: "routine-pending-2" });
    expect(topped).toMatchObject({ outcome: "funding_created", amountCents: 1500, fundingStatus: "pending" });
  });

  it("charges the card for a held order's whole gap even while an ACH credit is pending", async () => {
    repository.autoReload = makeAutoReloadSetting({ fundingMethodId: 99, minimumBalanceCents: 5000 });
    repository.account = { ...repository.account, availableBalanceCents: 1000, pendingBalanceCents: 9000 };

    const result = await service.handleAutoReload({
      vendorId: 10, reason: "payment_hold", requiredBalanceCents: 7500, intakeId: 456, idempotencyKey: "hold-pending-1",
    });

    expect(result).toMatchObject({ outcome: "funding_created", amountCents: 6500, fundingStatus: "settled" });
  });

  it("voids a pending ACH credit when Stripe reports the payment failed, then tells the vendor", async () => {
    await service.creditFunding({
      vendorId: 10, fundingMethodId: 100, rail: "stripe_ach", status: "pending", amountCents: 4000, currency: "USD",
      referenceType: "stripe_payment_intent", referenceId: "pi_ach_1", idempotencyKey: "funding-pi-ach-1",
    });
    expect(repository.account.pendingBalanceCents).toBe(4000);

    const failure = {
      vendorId: 10, fundingMethodId: 100, rail: "stripe_ach" as const, amountCents: 4000, currency: "USD", provider: "stripe",
      providerEventId: "evt_ach_failed_1", providerPaymentIntentId: "pi_ach_1", providerStatus: "requires_payment_method",
      failureCode: "payment_intent_payment_attempt_failed", failureMessage: "The bank returned the debit.",
      autoReload: true, autoReloadReason: "minimum_balance" as const, idempotencyKey: "stripe-funding-failed:pi_ach_1",
    };
    const result = await service.recordWalletFundingFailure(failure);

    expect(result).toEqual({ pendingCreditVoided: true, ledgerEntryId: 1, vendorPaused: false });
    expect(repository.account.pendingBalanceCents).toBe(0);
    expect(repository.account.availableBalanceCents).toBe(0);
    expect(repository.ledger[0]).toMatchObject({ status: "failed", amountCents: 4000, pendingBalanceAfterCents: 0 });
    expect(repository.ledger[0].metadata).toMatchObject({
      failure: expect.objectContaining({ code: "payment_intent_payment_attempt_failed", providerEventId: "evt_ach_failed_1" }),
    });
    expect(logs.at(-1)).toMatchObject({
      level: "warn",
      code: "DROPSHIP_WALLET_FUNDING_FAILED",
      context: expect.objectContaining({ pendingCreditVoided: true, ledgerEntryId: 1, pendingBalanceAfterCents: 0 }),
    });
    expect(notificationSender.sent.at(-1)).toMatchObject({
      eventType: "dropship_wallet_funding_failed",
      payload: expect.objectContaining({ pendingCreditVoided: true, ledgerEntryId: 1 }),
    });
    expect(notificationSender.sent.at(-1)?.message).toContain("The pending credit has been removed from your balance.");

    // A replayed webhook finds the entry already failed and moves nothing.
    const replay = await service.recordWalletFundingFailure(failure);
    expect(replay).toEqual({ pendingCreditVoided: false, ledgerEntryId: 1, vendorPaused: false });
    expect(repository.account.pendingBalanceCents).toBe(0);
    expect(notificationSender.sent.at(-1)?.message).not.toContain("removed from your balance");
  });

  it("pauses an active vendor in the void transaction, announces it, and lets the pause notice replace the funding-failed notice", async () => {
    const standing = new FakeVendorStandingService();
    service = buildService({ vendorStanding: standing });
    repository.vendorStatus = "active";
    await service.creditFunding({
      vendorId: 10, fundingMethodId: 100, rail: "stripe_ach", status: "pending", amountCents: 4000, currency: "USD",
      referenceType: "stripe_payment_intent", referenceId: "pi_ach_1", idempotencyKey: "funding-pi-ach-1",
    });
    const failure = {
      vendorId: 10, fundingMethodId: 100, rail: "stripe_ach" as const, amountCents: 4000, currency: "USD", provider: "stripe",
      providerEventId: "evt_ach_failed_1", providerPaymentIntentId: "pi_ach_1", providerStatus: "requires_payment_method",
      failureCode: "payment_intent_payment_attempt_failed", failureMessage: "The bank returned the debit.",
      autoReload: true, autoReloadReason: "minimum_balance" as const, idempotencyKey: "stripe-funding-failed:pi_ach_1",
    };

    const result = await service.recordWalletFundingFailure(failure);

    expect(result).toEqual({ pendingCreditVoided: true, ledgerEntryId: 1, vendorPaused: true });
    expect(repository.vendorStatus).toBe("paused");
    expect(repository.failInputs.at(-1)?.pauseVendor).toEqual({
      reason: "funding_returned",
      evidence: {
        source: "funding_webhook", provider: "stripe", providerEventId: "evt_ach_failed_1", providerPaymentIntentId: "pi_ach_1",
        failureCode: "payment_intent_payment_attempt_failed", failureMessage: "The bank returned the debit.", rail: "stripe_ach",
        amountCents: 4000, currency: "USD", autoReload: true, intakeId: null,
      },
    });
    expect(standing.announceCalls).toEqual([{ vendorId: 10, evidence: expect.objectContaining({ source: "funding_webhook", ledgerEntryId: 1, amountCents: 4000 }) }]);
    expect(notificationSender.sent.filter((sent) => sent.eventType === "dropship_wallet_funding_failed")).toEqual([]);
    expect(logs.find((entry) => entry.code === "DROPSHIP_WALLET_FUNDING_FAILED")).toMatchObject({
      level: "warn",
      context: expect.objectContaining({ pendingCreditVoided: true, vendorPaused: true, standingRevision: 1 }),
    });

    // A replayed webhook voids nothing, pauses nobody, and announces nothing.
    const replay = await service.recordWalletFundingFailure(failure);
    expect(replay).toEqual({ pendingCreditVoided: false, ledgerEntryId: 1, vendorPaused: false });
    expect(standing.announceCalls).toHaveLength(1);
    expect(notificationSender.sent.filter((sent) => sent.eventType === "dropship_wallet_funding_failed")).toHaveLength(1);
  });

  it("treats a card that fails after the wallet counted it as a decline", async () => {
    service = buildService({ vendorStanding: new FakeVendorStandingService() });
    repository.vendorStatus = "active";
    await service.creditFunding({
      vendorId: 10, fundingMethodId: 99, rail: "stripe_card", status: "pending", amountCents: 4000, currency: "USD",
      referenceType: "stripe_payment_intent", referenceId: "pi_card_1", idempotencyKey: "funding-pi-card-1",
    });

    await service.recordWalletFundingFailure({
      vendorId: 10, fundingMethodId: 99, rail: "stripe_card", amountCents: 4000, currency: "USD", provider: "stripe",
      providerEventId: "evt_card_failed_1", providerPaymentIntentId: "pi_card_1", failureCode: "card_declined",
      failureMessage: "Your card was declined.", autoReload: true, idempotencyKey: "stripe-funding-failed:pi_card_1",
    });

    expect(repository.failInputs.at(-1)?.pauseVendor?.reason).toBe("card_declined");
  });

  it("falls back to the funding-failed notice when the pause cannot be announced, or nothing is wired to announce it", async () => {
    const standing = new FakeVendorStandingService();
    standing.announceError = new Error("standing db down");
    service = buildService({ vendorStanding: standing });
    repository.vendorStatus = "active";
    await service.creditFunding({
      vendorId: 10, fundingMethodId: 100, rail: "stripe_ach", status: "pending", amountCents: 4000, currency: "USD",
      referenceType: "stripe_payment_intent", referenceId: "pi_ach_1", idempotencyKey: "funding-pi-ach-1",
    });
    const failure = {
      vendorId: 10, fundingMethodId: 100, rail: "stripe_ach" as const, amountCents: 4000, currency: "USD", provider: "stripe",
      providerEventId: "evt_ach_failed_1", providerPaymentIntentId: "pi_ach_1", failureCode: "payment_intent_payment_attempt_failed",
      failureMessage: "The bank returned the debit.", autoReload: true, idempotencyKey: "stripe-funding-failed:pi_ach_1",
    };

    const result = await service.recordWalletFundingFailure(failure);

    expect(result).toEqual({ pendingCreditVoided: true, ledgerEntryId: 1, vendorPaused: true });
    expect(repository.vendorStatus).toBe("paused");
    expect(logs.find((entry) => entry.code === "DROPSHIP_VENDOR_PAUSE_ANNOUNCE_FAILED")).toMatchObject({
      level: "error",
      context: expect.objectContaining({ vendorId: 10, error: "standing db down" }),
    });
    expect(notificationSender.sent.at(-1)).toMatchObject({ eventType: "dropship_wallet_funding_failed" });

    // No standing service at all: the pause is still recorded and flagged.
    repository = new FakeWalletRepository();
    repository.vendorStatus = "active";
    notificationSender = new FakeNotificationSender();
    logs = [];
    service = buildService();
    await service.creditFunding({
      vendorId: 10, fundingMethodId: 100, rail: "stripe_ach", status: "pending", amountCents: 4000, currency: "USD",
      referenceType: "stripe_payment_intent", referenceId: "pi_ach_1", idempotencyKey: "funding-pi-ach-1",
    });
    expect(await service.recordWalletFundingFailure(failure)).toEqual({ pendingCreditVoided: true, ledgerEntryId: 1, vendorPaused: true });
    expect(repository.vendorStatus).toBe("paused");
    expect(logs.find((entry) => entry.code === "DROPSHIP_VENDOR_PAUSE_UNANNOUNCED")).toMatchObject({ level: "warn" });
    expect(notificationSender.sent.at(-1)).toMatchObject({ eventType: "dropship_wallet_funding_failed" });
  });

  it("asks standing to resume the vendor after every settled credit, and never for a pending or replayed one", async () => {
    const standing = new FakeVendorStandingService();
    service = buildService({ vendorStanding: standing });

    await service.creditFunding({
      vendorId: 10, fundingMethodId: 99, rail: "stripe_card", status: "settled", amountCents: 5000, currency: "USD",
      referenceType: "stripe_payment_intent", referenceId: "pi_card_1", idempotencyKey: "funding-pi-card-1",
    });
    expect(standing.restoreCalls).toEqual([{
      vendorId: 10,
      evidence: { source: "wallet_funding_credit", ledgerEntryId: 1, rail: "stripe_card", amountCents: 5000, currency: "USD" },
    }]);

    // Replay: no second check. Pending ACH: nothing settled yet.
    await service.creditFunding({
      vendorId: 10, fundingMethodId: 99, rail: "stripe_card", status: "settled", amountCents: 5000, currency: "USD",
      referenceType: "stripe_payment_intent", referenceId: "pi_card_1", idempotencyKey: "funding-pi-card-1",
    });
    await service.creditFunding({
      vendorId: 10, fundingMethodId: 100, rail: "stripe_ach", status: "pending", amountCents: 4000, currency: "USD",
      referenceType: "stripe_payment_intent", referenceId: "pi_ach_1", idempotencyKey: "funding-pi-ach-1",
    });
    expect(standing.restoreCalls).toHaveLength(1);

    await service.creditManualFunding({
      vendorId: 10, amountCents: 1500, currency: "USD", reason: "goodwill", idempotencyKey: "manual-credit-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });
    expect(standing.restoreCalls.at(-1)).toMatchObject({ vendorId: 10, evidence: expect.objectContaining({ source: "wallet_funding_credit", rail: "manual", amountCents: 1500 }) });

    repository.fundingMethods.push(makeFundingMethod({
      fundingMethodId: 101,
      rail: "usdc_base",
      providerCustomerId: null,
      providerPaymentMethodId: null,
      usdcWalletAddress: "0x1111111111111111111111111111111111111111",
      displayLabel: "USDC on Base",
      isDefault: false,
    }));
    await service.creditConfirmedUsdcFunding({
      vendorId: 10,
      fundingMethodId: 101,
      amountCents: 2500,
      currency: "USD",
      amountAtomicUnits: "25000000",
      chainId: 8453,
      transactionHash: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      fromAddress: "0x2222222222222222222222222222222222222222",
      toAddress: "0x1111111111111111111111111111111111111111",
      confirmations: 12,
      idempotencyKey: "usdc-credit-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });
    expect(standing.restoreCalls).toHaveLength(3);
    expect(standing.restoreCalls.at(-1)).toMatchObject({ vendorId: 10, evidence: expect.objectContaining({ source: "wallet_usdc_funding_credit", rail: "usdc_base", amountCents: 2500 }) });
  });

  it("logs and moves on when the standing check fails after a credit", async () => {
    const standing = new FakeVendorStandingService();
    standing.restoreError = new Error("standing db down");
    service = buildService({ vendorStanding: standing });

    const result = await service.creditFunding({
      vendorId: 10, fundingMethodId: 99, rail: "stripe_card", status: "settled", amountCents: 5000, currency: "USD",
      referenceType: "stripe_payment_intent", referenceId: "pi_card_1", idempotencyKey: "funding-pi-card-1",
    });

    expect(result.ledgerEntry.status).toBe("settled");
    expect(logs.find((entry) => entry.code === "DROPSHIP_VENDOR_RESTORE_FAILED")).toMatchObject({
      level: "error",
      context: expect.objectContaining({ vendorId: 10, error: "standing db down" }),
    });
  });

  it("warns when the backstop cannot fire, and stays at info for a correct no-op", async () => {
    // Backstop broken: an order is held, auto-reload runs on ACH, and the card
    // that should cover the shortfall is gone.
    repository.fundingMethods = repository.fundingMethods.filter((method) => method.rail !== "stripe_card");
    repository.autoReload = makeAutoReloadSetting({ fundingMethodId: 100 });
    await service.handleAutoReload({
      vendorId: 10, reason: "payment_hold", requiredBalanceCents: 7500, intakeId: 456, idempotencyKey: "skip-warn-1",
    });
    expect(logs.at(-1)).toMatchObject({
      level: "warn",
      code: "DROPSHIP_AUTO_RELOAD_SKIPPED",
      context: expect.objectContaining({
        vendorId: 10,
        fundingMethodId: 100,
        intakeId: 456,
        skipReason: "card_backstop_unavailable",
      }),
    });

    // Switched off on purpose: the policy working as configured, not an anomaly.
    repository.autoReload = makeAutoReloadSetting({ fundingMethodId: 99, enabled: false });
    await service.handleAutoReload({ vendorId: 10, reason: "minimum_balance", idempotencyKey: "skip-info-1" });
    expect(logs.at(-1)).toMatchObject({
      level: "info",
      code: "DROPSHIP_AUTO_RELOAD_SKIPPED",
      context: expect.objectContaining({ skipReason: "auto_reload_disabled" }),
    });
  });

  it("records a routine ACH auto-reload as pending until Stripe settlement", async () => {
    repository.autoReload = makeAutoReloadSetting({
      fundingMethodId: 100,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
    });

    const result = await service.handleAutoReload({
      vendorId: 10,
      reason: "minimum_balance",
      idempotencyKey: "auto-reload-minimum-1",
    });

    // The vendor chose ACH for routine top-ups: it is charged, and the funds
    // stay pending — not spendable — until Stripe settles them.
    expect(result).toMatchObject({
      outcome: "funding_created",
      fundingMethodId: 100,
      amountCents: 5000,
      fundingStatus: "pending",
      providerPaymentIntentId: "pi_auto_5000",
    });
    expect(repository.account.availableBalanceCents).toBe(0);
    expect(repository.account.pendingBalanceCents).toBe(5000);
    expect(repository.ledger[0]).toMatchObject({ status: "pending", amountCents: 5000, fundingMethodId: 100 });
  });

  it("charges the card on file for a held order even when auto-reload runs on ACH", async () => {
    repository.autoReload = makeAutoReloadSetting({
      fundingMethodId: 100,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
    });

    const result = await service.handleAutoReload({
      vendorId: 10,
      reason: "payment_hold",
      requiredBalanceCents: 6500,
      intakeId: 456,
      idempotencyKey: "auto-reload-intake-456",
    });

    // An order already waiting cannot wait days for ACH: the shortfall goes to
    // the card (fixture method 99), and lands settled so the order can proceed.
    expect(result).toMatchObject({
      outcome: "funding_created",
      fundingMethodId: 99,
      amountCents: 6500,
      fundingStatus: "settled",
    });
    expect(repository.account.availableBalanceCents).toBe(6500);
    expect(repository.account.pendingBalanceCents).toBe(0);
    expect(repository.ledger[0]).toMatchObject({ status: "settled", amountCents: 6500, fundingMethodId: 99 });
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_AUTO_RELOAD_FUNDING_CREATED",
      context: expect.objectContaining({ reason: "payment_hold", intakeId: 456, amountCents: 6500 }),
    });
  });

  it("skips payment-hold auto-reload when the needed amount exceeds the configured max", async () => {
    repository.autoReload = makeAutoReloadSetting({
      fundingMethodId: 99,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 6000,
    });

    const result = await service.handleAutoReload({
      vendorId: 10,
      reason: "payment_hold",
      requiredBalanceCents: 7500,
      intakeId: 456,
      idempotencyKey: "auto-reload-intake-456",
    });

    expect(result).toMatchObject({
      outcome: "skipped",
      skipReason: "amount_exceeds_max_single_reload",
      fundingMethodId: 99,
    });
    expect(repository.ledger).toHaveLength(0);
  });

  it("charges a card reload plus the fee and credits the wallet exactly the reload amount", async () => {
    repository.autoReload = makeAutoReloadSetting({
      fundingMethodId: 99,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
    });
    repository.account = { ...repository.account, availableBalanceCents: 1000 };

    const result = await service.handleAutoReload({
      vendorId: 10,
      reason: "payment_hold",
      requiredBalanceCents: 7500,
      intakeId: 456,
      idempotencyKey: "auto-reload-intake-456",
    });

    // $65.00 short: the card is charged $66.95 (3% on top) and the wallet gets exactly $65.00.
    expect(fundingProvider.paymentIntentInputs).toEqual([
      expect.objectContaining({ rail: "stripe_card", amountCents: 6500, cardFee: { feeCents: 195, feeBps: 300 } }),
    ]);
    expect(result).toMatchObject({
      outcome: "funding_created",
      amountCents: 6500,
      cardFeeCents: 195,
      chargedCents: 6695,
      fundingStatus: "settled",
    });
    expect(repository.account.availableBalanceCents).toBe(7500);
    expect(repository.ledger[0]).toMatchObject({
      type: "funding",
      amountCents: 6500,
      metadata: expect.objectContaining({ cardFeeCents: 195, cardFeeBps: 300, chargedCents: 6695 }),
    });
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_AUTO_RELOAD_FUNDING_CREATED",
      context: expect.objectContaining({ amountCents: 6500, cardFeeCents: 195, cardFeeBps: 300, chargedCents: 6695 }),
    });
  });

  it("charges a bank reload exactly the reload amount and records no fee", async () => {
    repository.autoReload = makeAutoReloadSetting({
      fundingMethodId: 100,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
    });

    const result = await service.handleAutoReload({
      vendorId: 10,
      reason: "minimum_balance",
      idempotencyKey: "auto-reload-minimum-1",
    });

    expect(fundingProvider.paymentIntentInputs).toEqual([
      expect.objectContaining({ rail: "stripe_ach", amountCents: 5000, cardFee: null }),
    ]);
    expect(result).toMatchObject({ amountCents: 5000, cardFeeCents: 0, chargedCents: 5000 });
    expect(repository.ledger[0].metadata).not.toHaveProperty("cardFeeCents");
  });

  it("refuses to book a card reload when Stripe reports a charge that does not match the quote", async () => {
    repository.autoReload = makeAutoReloadSetting({
      fundingMethodId: 99,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
    });
    // The fee went missing between the quote and the charge.
    fundingProvider.chargedCentsOverride = 5000;

    await expect(service.handleAutoReload({
      vendorId: 10,
      reason: "minimum_balance",
      idempotencyKey: "auto-reload-minimum-2",
    })).rejects.toMatchObject({
      code: "DROPSHIP_STRIPE_AUTO_RELOAD_AMOUNT_MISMATCH",
      context: expect.objectContaining({
        chargedCents: 5000,
        expectedChargedCents: 5150,
        creditCents: 5000,
        cardFeeCents: 150,
      }),
    });
    expect(repository.ledger).toHaveLength(0);
    expect(repository.account.availableBalanceCents).toBe(0);
  });

  it("quotes the card fee on a manual top-up and hands the provider both amounts", async () => {
    const session = await service.createStripeWalletFundingSessionForMember("member-1", {
      fundingMethodId: 99,
      amountCents: 25000,
      successUrl: "https://cardshellz.io/wallet?wallet_funding=success",
      cancelUrl: "https://cardshellz.io/wallet?wallet_funding=cancelled",
    });

    expect(fundingProvider.fundingSessionInputs).toEqual([
      expect.objectContaining({ rail: "stripe_card", amountCents: 25000, cardFee: { feeCents: 750, feeBps: 300 } }),
    ]);
    expect(session).toMatchObject({ amountCents: 25000, cardFeeCents: 750, chargedCents: 25750 });
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_STRIPE_WALLET_FUNDING_SESSION_CREATED",
      context: expect.objectContaining({ amountCents: 25000, cardFeeCents: 750, cardFeeBps: 300, chargedCents: 25750 }),
    });
  });

  it("quotes no fee on a manual bank top-up", async () => {
    const session = await service.createStripeWalletFundingSessionForMember("member-1", {
      fundingMethodId: 100,
      amountCents: 25000,
      successUrl: "https://cardshellz.io/wallet?wallet_funding=success",
      cancelUrl: "https://cardshellz.io/wallet?wallet_funding=cancelled",
    });

    expect(fundingProvider.fundingSessionInputs[0]).toMatchObject({ rail: "stripe_ach", amountCents: 25000, cardFee: null });
    expect(session).toMatchObject({ amountCents: 25000, cardFeeCents: 0, chargedCents: 25000 });
  });

  it("serves the fee rate with the wallet so the page quotes with the rate that will be charged", async () => {
    const wallet = await service.getWalletForVendor(10);
    expect(wallet.cardFundingFeeBps).toBe(300);
    const memberWallet = await service.getWalletForMember("member-1");
    expect(memberWallet.cardFundingFeeBps).toBe(300);
  });

  it("records the fee rate the vendor agreed to when auto-reload is configured", async () => {
    await service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
      acknowledgedCardFeeBps: 300,
    });

    expect(repository.lastConfigureInput).toMatchObject({ cardFundingFeeBps: 300, acknowledgedCardFeeBps: 300 });
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_AUTO_RELOAD_CONFIGURED",
      context: expect.objectContaining({ cardFundingFeeBps: 300, acknowledgedCardFeeBps: 300 }),
    });
  });

  it("refuses auto-reload enrolment under a fee rate the vendor did not see", async () => {
    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
      acknowledgedCardFeeBps: 250,
    })).rejects.toMatchObject({
      code: "DROPSHIP_CARD_FUNDING_FEE_ACKNOWLEDGEMENT_STALE",
      context: expect.objectContaining({ acknowledgedCardFeeBps: 250, cardFundingFeeBps: 300 }),
    });
    expect(repository.lastConfigureInput).toBeNull();

    // Turning auto-reload off agrees to nothing, so a stale rate does not block it.
    repository.vendorStatus = "onboarding";
    await service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: false,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
      acknowledgedCardFeeBps: 250,
    });
    expect(repository.lastConfigureInput).toMatchObject({ enabled: false });
  });

  it("creates a Stripe setup session using the reusable provider customer", async () => {
    const session = await service.createStripeFundingSetupSessionForMember("member-1", {
      rail: "stripe_card",
      successUrl: "https://cardshellz.io/wallet?funding_setup=success",
      cancelUrl: "https://cardshellz.io/wallet?funding_setup=cancelled",
    });

    expect(session).toMatchObject({
      checkoutUrl: "https://checkout.stripe.test/session",
      providerSessionId: "cs_test_1",
      providerCustomerId: "cus_existing",
    });
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_STRIPE_FUNDING_SETUP_SESSION_CREATED",
      context: expect.objectContaining({ rail: "stripe_card" }),
    });
  });

  it("creates a Stripe wallet funding session with the selected active funding method", async () => {
    const session = await service.createStripeWalletFundingSessionForMember("member-1", {
      fundingMethodId: 99,
      amountCents: 25000,
      successUrl: "https://cardshellz.io/wallet?wallet_funding=success",
      cancelUrl: "https://cardshellz.io/wallet?wallet_funding=cancelled",
    });

    expect(session).toMatchObject({
      checkoutUrl: "https://checkout.stripe.test/funding",
      providerSessionId: "cs_funding_1",
      providerCustomerId: "cus_existing",
      amountCents: 25000,
      currency: "USD",
    });
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_STRIPE_WALLET_FUNDING_SESSION_CREATED",
      context: expect.objectContaining({
        vendorId: 10,
        fundingMethodId: 99,
        amountCents: 25000,
        rail: "stripe_card",
      }),
    });
  });

  it("registers Stripe funding methods idempotently and defaults the first active method", async () => {
    repository.fundingMethods = [];

    const first = await service.registerFundingMethod({
      vendorId: 10,
      rail: "stripe_card",
      status: "active",
      providerCustomerId: "cus_1",
      providerPaymentMethodId: "pm_1",
      usdcWalletAddress: null,
      displayLabel: "Visa ending in 4242",
      isDefault: false,
      metadata: { provider: "stripe", last4: "4242" },
    });
    const replay = await service.registerFundingMethod({
      vendorId: 10,
      rail: "stripe_card",
      status: "active",
      providerCustomerId: "cus_1",
      providerPaymentMethodId: "pm_1",
      usdcWalletAddress: null,
      displayLabel: "Visa ending in 4242",
      isDefault: false,
      metadata: { provider: "stripe", last4: "4242" },
    });

    expect(first.fundingMethod).toMatchObject({
      fundingMethodId: 1,
      providerPaymentMethodId: "pm_1",
      isDefault: true,
    });
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(repository.fundingMethods).toHaveLength(1);
    expect(logs.filter((event) => event.code === "DROPSHIP_FUNDING_METHOD_REGISTERED")).toHaveLength(1);
  });

  it("registers USDC Base funding methods for the provisioned member", async () => {
    repository.fundingMethods = [];

    const first = await service.registerUsdcBaseFundingMethodForMember("member-1", {
      walletAddress: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD",
      displayLabel: "Treasury wallet",
    });
    const replay = await service.registerUsdcBaseFundingMethodForMember("member-1", {
      walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      displayLabel: "Treasury wallet",
    });

    expect(first.fundingMethod).toMatchObject({
      rail: "usdc_base",
      usdcWalletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      providerCustomerId: null,
      providerPaymentMethodId: null,
      isDefault: true,
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(repository.fundingMethods).toHaveLength(1);
  });

  it("requires a valid USDC wallet address for USDC Base funding methods", async () => {
    await expect(service.registerFundingMethod({
      vendorId: 10,
      rail: "usdc_base",
      status: "active",
      providerCustomerId: null,
      providerPaymentMethodId: null,
      usdcWalletAddress: null,
      displayLabel: "USDC",
      isDefault: false,
    })).rejects.toMatchObject({ code: "DROPSHIP_WALLET_INVALID_INPUT" });
  });
});

class FakeVendorStandingService {
  announceCalls: unknown[] = [];
  restoreCalls: unknown[] = [];
  announceError: Error | null = null;
  restoreError: Error | null = null;

  async announcePause(input: unknown) {
    if (this.announceError) throw this.announceError;
    this.announceCalls.push(input);
    return { outcome: "paused" as const, standing: null, shortfallCents: null, listingHold: null };
  }

  async restoreIfFunded(input: unknown) {
    if (this.restoreError) throw this.restoreError;
    this.restoreCalls.push(input);
    return { outcome: "unchanged" as const, standing: null, shortfallCents: null, listingHold: null };
  }
}

class FakeNotificationSender {
  sent: DropshipNotificationSenderInput[] = [];
  error: Error | null = null;

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    this.sent.push(input);
    if (this.error) {
      throw this.error;
    }
  }
}

class FakeFundingProvider implements DropshipWalletFundingProvider {
  fundingSessionInputs: Array<Parameters<DropshipWalletFundingProvider["createStripeWalletFundingSession"]>[0]> = [];
  paymentIntentInputs: Array<Parameters<DropshipWalletFundingProvider["createStripeAutoReloadPaymentIntent"]>[0]> = [];
  /** When set, the fake reports this charged amount instead of what it was asked for. */
  chargedCentsOverride: number | null = null;

  async createStripeSetupSession(input: Parameters<DropshipWalletFundingProvider["createStripeSetupSession"]>[0]): Promise<DropshipStripeFundingSetupSession> {
    expect(input.existingProviderCustomerId).toBe("cus_existing");
    return {
      checkoutUrl: "https://checkout.stripe.test/session",
      providerSessionId: "cs_test_1",
      providerCustomerId: input.existingProviderCustomerId ?? "cus_created",
      expiresAt: now,
    };
  }

  async createStripeWalletFundingSession(
    input: Parameters<DropshipWalletFundingProvider["createStripeWalletFundingSession"]>[0],
  ): Promise<DropshipStripeWalletFundingSession> {
    expect(input.existingProviderCustomerId).toBe("cus_existing");
    this.fundingSessionInputs.push(input);
    const cardFeeCents = input.cardFee?.feeCents ?? 0;
    return {
      checkoutUrl: "https://checkout.stripe.test/funding",
      providerSessionId: "cs_funding_1",
      providerCustomerId: input.existingProviderCustomerId ?? "cus_created",
      amountCents: input.amountCents,
      cardFeeCents,
      chargedCents: input.amountCents + cardFeeCents,
      currency: input.currency,
      expiresAt: now,
    };
  }

  async createStripeAutoReloadPaymentIntent(
    input: Parameters<DropshipWalletFundingProvider["createStripeAutoReloadPaymentIntent"]>[0],
  ): Promise<DropshipStripeAutoReloadPaymentIntent> {
    expect(input.providerCustomerId).toBe("cus_existing");
    expect(input.providerPaymentMethodId).toMatch(/^pm_/);
    this.paymentIntentInputs.push(input);
    // Stripe charges what it was asked for: the credit plus the fee.
    const chargedCents = this.chargedCentsOverride ?? input.amountCents + (input.cardFee?.feeCents ?? 0);
    return {
      providerPaymentIntentId: `pi_auto_${input.amountCents}`,
      status: input.rail === "stripe_ach" ? "pending" : "settled",
      amountCents: chargedCents,
      currency: input.currency,
      externalTransactionId: input.rail === "stripe_ach" ? null : `ch_auto_${input.amountCents}`,
    };
  }
}

class FakeVendorProvisioningService {
  async provisionForMember(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    return {
      vendor: makeVendor({ memberId }),
      created: false,
      changedFields: [],
    };
  }
}

describe("resolveDropshipCardFundingFeeBps", () => {
  it("defaults to the launch rate when nothing is configured", () => {
    expect(resolveDropshipCardFundingFeeBps({})).toBe(300);
    expect(resolveDropshipCardFundingFeeBps({ DROPSHIP_CARD_FUNDING_FEE_BPS: "  " })).toBe(300);
  });

  it("honours a configured rate, including zero", () => {
    expect(resolveDropshipCardFundingFeeBps({ DROPSHIP_CARD_FUNDING_FEE_BPS: "250" })).toBe(250);
    expect(resolveDropshipCardFundingFeeBps({ DROPSHIP_CARD_FUNDING_FEE_BPS: "0" })).toBe(0);
    expect(resolveDropshipCardFundingFeeBps({ DROPSHIP_CARD_FUNDING_FEE_BPS: " 1000 " })).toBe(1000);
  });

  it("refuses a value it cannot trust instead of charging a rate nobody set", () => {
    for (const bad of ["abc", "-1", "12.5", "1001", "3%"]) {
      expect(() => resolveDropshipCardFundingFeeBps({ DROPSHIP_CARD_FUNDING_FEE_BPS: bad }))
        .toThrow(expect.objectContaining({ code: "DROPSHIP_CARD_FUNDING_FEE_MISCONFIGURED" }));
    }
  });
});

describe("resolveDropshipUsdcBaseDepositAddress", () => {
  it("offers no USDC funding when nothing is configured", () => {
    expect(resolveDropshipUsdcBaseDepositAddress({})).toBeNull();
    expect(resolveDropshipUsdcBaseDepositAddress({ DROPSHIP_USDC_BASE_DEPOSIT_ADDRESS: "  " })).toBeNull();
  });

  it("normalizes a configured Base address", () => {
    expect(resolveDropshipUsdcBaseDepositAddress({
      DROPSHIP_USDC_BASE_DEPOSIT_ADDRESS: " 0xABCDEF0123456789abcdef0123456789ABCDEF01 ",
    })).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  it("refuses an address it cannot trust instead of pointing vendors at it", () => {
    for (const bad of ["abc", "0x1234", "0xZZCDEF0123456789abcdef0123456789ABCDEF01", "ABCDEF0123456789abcdef0123456789ABCDEF01"]) {
      expect(() => resolveDropshipUsdcBaseDepositAddress({ DROPSHIP_USDC_BASE_DEPOSIT_ADDRESS: bad }))
        .toThrow(expect.objectContaining({ code: "DROPSHIP_USDC_DEPOSIT_ADDRESS_MISCONFIGURED" }));
    }
  });
});

describe("resolveDropshipAutoReloadFloors", () => {
  it("defaults to a trigger that clears one order and an amount that is not fee-dominated", () => {
    expect(resolveDropshipAutoReloadFloors({})).toEqual({
      minTriggerCents: 5_000,
      minAmountCents: 10_000,
    });
  });

  it("honours env overrides", () => {
    expect(resolveDropshipAutoReloadFloors({
      DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS: "7500",
      DROPSHIP_AUTO_RELOAD_MIN_AMOUNT_CENTS: "20000",
    })).toEqual({ minTriggerCents: 7_500, minAmountCents: 20_000 });
  });

  it("falls back to the defaults for values that are not positive integers", () => {
    for (const bad of ["0", "-100", "abc", "12.5", "", "   "]) {
      expect(resolveDropshipAutoReloadFloors({
        DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS: bad,
        DROPSHIP_AUTO_RELOAD_MIN_AMOUNT_CENTS: bad,
      })).toEqual({ minTriggerCents: 5_000, minAmountCents: 10_000 });
    }
  });
});

class FakeWalletRepository implements DropshipWalletRepository {
  account: DropshipWalletAccountRecord = makeAccount();
  /** Drives the guard that keeps a live vendor from removing the card backstop. */
  vendorStatus: DropshipVendorStatus | null = "onboarding";
  standingRevision = 0;
  failInputs: FailDropshipPendingFundingRepositoryInput[] = [];
  lastConfigureInput: ConfigureDropshipAutoReloadRepositoryInput | null = null;
  fundingMethods: DropshipFundingMethodRecord[] = [
    makeFundingMethod(),
    makeFundingMethod({
      fundingMethodId: 100,
      rail: "stripe_ach",
      displayLabel: "ACH ending in 6789",
      isDefault: false,
    }),
  ];
  autoReload: DropshipAutoReloadSettingRecord | null = null;
  ledger: DropshipWalletLedgerRecord[] = [];
  usdcLedger: DropshipUsdcLedgerEntryRecord[] = [];

  async getOrCreateWalletAccount(): Promise<DropshipWalletAccountRecord> {
    return this.account;
  }

  async getOverview(): Promise<DropshipWalletOverview> {
    return {
      account: this.account,
      autoReload: this.autoReload,
      fundingMethods: this.fundingMethods,
      recentLedger: this.ledger,
    };
  }

  async creditFunding(input: CreateDropshipWalletFundingLedgerInput): Promise<DropshipWalletMutationResult> {
    const fundingMethod = this.assertFundingMethod(input.fundingMethodId ?? null);
    if (fundingMethod && fundingMethod.rail !== input.rail) {
      throw new DropshipError("DROPSHIP_FUNDING_METHOD_RAIL_MISMATCH", "Funding method rail mismatch.");
    }
    const replay = this.findReplay(input.idempotencyKey, input.referenceType, input.referenceId);
    if (replay) {
      if (replay.status === "settled" && input.status === "pending") {
        this.assertReplay(replay, input.requestHash);
        return { account: this.account, ledgerEntry: replay, idempotentReplay: true };
      }
      if (replay.status === "pending" && input.status === "settled") {
        this.assertReplay(replay, input.requestHash);
        const availableBalanceCents = this.account.availableBalanceCents + replay.amountCents;
        const pendingBalanceCents = this.account.pendingBalanceCents - replay.amountCents;
        this.account = {
          ...this.account,
          availableBalanceCents,
          pendingBalanceCents,
          updatedAt: input.occurredAt,
        };
        const settled: DropshipWalletLedgerRecord = {
          ...replay,
          status: "settled",
          fundingMethodId: input.fundingMethodId ?? replay.fundingMethodId,
          externalTransactionId: input.externalTransactionId ?? replay.externalTransactionId,
          availableBalanceAfterCents: availableBalanceCents,
          pendingBalanceAfterCents: pendingBalanceCents,
          metadata: {
            ...replay.metadata,
            requestHash: input.requestHash,
            rail: input.rail,
            settledFromPending: true,
          },
          settledAt: input.occurredAt,
        };
        this.ledger = this.ledger.map((entry) =>
          entry.ledgerEntryId === replay.ledgerEntryId ? settled : entry,
        );
        return { account: this.account, ledgerEntry: settled, idempotentReplay: false };
      }
      this.assertReplay(replay, input.requestHash);
      return { account: this.account, ledgerEntry: replay, idempotentReplay: true };
    }

    const availableBalanceCents = input.status === "settled"
      ? this.account.availableBalanceCents + input.amountCents
      : this.account.availableBalanceCents;
    const pendingBalanceCents = input.status === "pending"
      ? this.account.pendingBalanceCents + input.amountCents
      : this.account.pendingBalanceCents;
    this.account = {
      ...this.account,
      availableBalanceCents,
      pendingBalanceCents,
      updatedAt: input.occurredAt,
    };
    const ledgerEntry = this.insertLedger({
      type: "funding",
      status: input.status,
      amountCents: input.amountCents,
      currency: input.currency,
      availableBalanceAfterCents: availableBalanceCents,
      pendingBalanceAfterCents: pendingBalanceCents,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      idempotencyKey: input.idempotencyKey,
      fundingMethodId: input.fundingMethodId ?? null,
      metadata: {
        ...(input.metadata ?? {}),
        requestHash: input.requestHash,
        rail: input.rail,
        ...(input.cardFee
          ? { cardFeeCents: input.cardFee.feeCents, cardFeeBps: input.cardFee.feeBps, chargedCents: input.cardFee.chargedCents }
          : {}),
      },
      createdAt: input.occurredAt,
      settledAt: input.status === "settled" ? input.occurredAt : null,
    });
    return { account: this.account, ledgerEntry, idempotentReplay: false };
  }

  async failPendingFunding(input: FailDropshipPendingFundingRepositoryInput): Promise<DropshipWalletFundingFailureRepositoryResult | null> {
    this.failInputs.push(input);
    const entry = this.ledger.find((candidate) =>
      candidate.type === "funding"
      && candidate.referenceType === input.referenceType
      && candidate.referenceId === input.referenceId
    );
    if (!entry) return null;
    if (entry.status !== "pending") {
      return { account: this.account, ledgerEntry: entry, idempotentReplay: true, vendorPaused: null };
    }
    const pendingBalanceCents = this.account.pendingBalanceCents - entry.amountCents;
    this.account = { ...this.account, pendingBalanceCents, updatedAt: input.occurredAt };
    const failed: DropshipWalletLedgerRecord = {
      ...entry,
      status: "failed",
      availableBalanceAfterCents: this.account.availableBalanceCents,
      pendingBalanceAfterCents: pendingBalanceCents,
      metadata: {
        ...entry.metadata,
        failure: {
          code: input.failureCode,
          message: input.failureMessage,
          providerStatus: input.providerStatus,
          providerEventId: input.providerEventId,
          failedAt: input.occurredAt.toISOString(),
        },
      },
    };
    this.ledger = this.ledger.map((candidate) => (candidate === entry ? failed : candidate));
    // Mirrors the real repository: the guarded pause rides the void transaction.
    let vendorPaused: DropshipWalletFundingFailureRepositoryResult["vendorPaused"] = null;
    if (input.pauseVendor && this.vendorStatus === "active") {
      this.vendorStatus = "paused";
      this.standingRevision += 1;
      vendorPaused = {
        vendorId: input.vendorId,
        status: "paused",
        standingReason: input.pauseVendor.reason,
        pausedAt: input.occurredAt,
        standingRevision: this.standingRevision,
        listingHoldState: "released",
        listingHoldReconciledAt: null,
        listingHoldDetail: null,
      };
    }
    return { account: this.account, ledgerEntry: failed, idempotentReplay: false, vendorPaused };
  }

  async creditConfirmedUsdcFunding(
    input: CreateDropshipConfirmedUsdcFundingRepositoryInput,
  ): Promise<DropshipConfirmedUsdcFundingResult> {
    const fundingMethod = this.assertFundingMethod(input.fundingMethodId);
    if (fundingMethod && fundingMethod.rail !== "usdc_base") {
      throw new DropshipError("DROPSHIP_FUNDING_METHOD_RAIL_MISMATCH", "Funding method rail mismatch.");
    }
    const referenceType = "usdc_base_transaction";
    const referenceId = `${input.chainId}:${input.transactionHash}`;
    const existingUsdc = this.usdcLedger.find((entry) =>
      entry.chainId === input.chainId && entry.transactionHash === input.transactionHash
    );
    if (existingUsdc) {
      const replay = this.ledger.find((entry) => entry.ledgerEntryId === existingUsdc.walletLedgerId);
      if (!replay) throw new DropshipError("DROPSHIP_USDC_WALLET_LEDGER_MISSING", "Missing wallet ledger.");
      this.assertReplay(replay, input.requestHash);
      return {
        account: this.account,
        ledgerEntry: replay,
        usdcLedgerEntry: existingUsdc,
        idempotentReplay: true,
      };
    }

    const replay = this.findReplay(input.idempotencyKey, referenceType, referenceId);
    if (replay) {
      this.assertReplay(replay, input.requestHash);
      const usdcLedgerEntry = this.insertUsdcLedger({ ...input, walletLedgerId: replay.ledgerEntryId });
      return {
        account: this.account,
        ledgerEntry: replay,
        usdcLedgerEntry,
        idempotentReplay: true,
      };
    }

    const availableBalanceCents = this.account.availableBalanceCents + input.amountCents;
    this.account = {
      ...this.account,
      availableBalanceCents,
      updatedAt: input.occurredAt,
    };
    const ledgerEntry = this.insertLedger({
      type: "funding",
      status: "settled",
      amountCents: input.amountCents,
      currency: input.currency,
      availableBalanceAfterCents: availableBalanceCents,
      pendingBalanceAfterCents: this.account.pendingBalanceCents,
      referenceType,
      referenceId,
      idempotencyKey: input.idempotencyKey,
      fundingMethodId: input.fundingMethodId,
      externalTransactionId: input.transactionHash,
      metadata: {
        requestHash: input.requestHash,
        rail: "usdc_base",
        amountAtomicUnits: input.amountAtomicUnits,
        actorType: input.actor.actorType,
      },
      createdAt: input.occurredAt,
      settledAt: input.occurredAt,
    });
    const usdcLedgerEntry = this.insertUsdcLedger({
      ...input,
      walletLedgerId: ledgerEntry.ledgerEntryId,
    });
    return {
      account: this.account,
      ledgerEntry,
      usdcLedgerEntry,
      idempotentReplay: false,
    };
  }

  async debitOrder(input: CreateDropshipWalletOrderDebitInput): Promise<DropshipWalletMutationResult> {
    const referenceType = "order_intake";
    const referenceId = String(input.intakeId);
    const replay = this.findReplay(input.idempotencyKey, referenceType, referenceId);
    if (replay) {
      this.assertReplay(replay, input.requestHash);
      return { account: this.account, ledgerEntry: replay, idempotentReplay: true };
    }
    if (this.account.availableBalanceCents < input.amountCents) {
      throw new DropshipError("DROPSHIP_WALLET_INSUFFICIENT_FUNDS", "Insufficient funds.");
    }
    const availableBalanceCents = this.account.availableBalanceCents - input.amountCents;
    this.account = {
      ...this.account,
      availableBalanceCents,
      updatedAt: input.occurredAt,
    };
    const ledgerEntry = this.insertLedger({
      type: "order_debit",
      status: "settled",
      amountCents: -input.amountCents,
      currency: input.currency,
      availableBalanceAfterCents: availableBalanceCents,
      pendingBalanceAfterCents: this.account.pendingBalanceCents,
      referenceType,
      referenceId,
      idempotencyKey: input.idempotencyKey,
      fundingMethodId: null,
      metadata: { requestHash: input.requestHash },
      createdAt: input.occurredAt,
      settledAt: input.occurredAt,
    });
    return { account: this.account, ledgerEntry, idempotentReplay: false };
  }

  async configureAutoReload(
    input: ConfigureDropshipAutoReloadRepositoryInput,
  ): Promise<DropshipAutoReloadSettingRecord> {
    this.assertFundingMethod(input.fundingMethodId);
    this.lastConfigureInput = input;
    this.autoReload = {
      autoReloadSettingId: 1,
      vendorId: input.vendorId,
      fundingMethodId: input.fundingMethodId,
      enabled: input.enabled,
      minimumBalanceCents: input.minimumBalanceCents,
      maxSingleReloadCents: input.maxSingleReloadCents,
      paymentHoldTimeoutMinutes: input.paymentHoldTimeoutMinutes,
      createdAt: this.autoReload?.createdAt ?? input.updatedAt,
      updatedAt: input.updatedAt,
    };
    return this.autoReload;
  }

  async getVendorLifecycleStatus(): Promise<DropshipVendorStatus | null> {
    return this.vendorStatus;
  }

  async getReusableFundingProviderCustomerId(): Promise<string | null> {
    return this.fundingMethods.find((method) =>
      (method.rail === "stripe_card" || method.rail === "stripe_ach")
      && method.providerCustomerId
    )?.providerCustomerId ?? null;
  }

  async upsertFundingMethod(
    input: UpsertDropshipFundingMethodRepositoryInput,
  ): Promise<DropshipFundingMethodMutationResult> {
    const existing = this.fundingMethods.find((method) =>
      method.vendorId === input.vendorId
      && method.rail === input.rail
      && (
        input.rail === "usdc_base"
          ? method.usdcWalletAddress === input.usdcWalletAddress
          : method.providerPaymentMethodId === input.providerPaymentMethodId
      )
    );
    const isDefault = input.isDefault || this.fundingMethods.every((method) => method.status !== "active");
    if (isDefault) {
      this.fundingMethods = this.fundingMethods.map((method) => ({ ...method, isDefault: false }));
    }
    if (existing) {
      const updated = {
        ...existing,
        status: input.status,
        providerCustomerId: input.providerCustomerId,
        providerPaymentMethodId: input.providerPaymentMethodId,
        usdcWalletAddress: input.usdcWalletAddress,
        displayLabel: input.displayLabel,
        isDefault: existing.isDefault || isDefault,
        metadata: input.metadata ?? {},
        updatedAt: input.updatedAt,
      };
      this.fundingMethods = this.fundingMethods.map((method) =>
        method.fundingMethodId === existing.fundingMethodId ? updated : method,
      );
      return { fundingMethod: updated, idempotentReplay: true };
    }

    const fundingMethod: DropshipFundingMethodRecord = {
      fundingMethodId: this.fundingMethods.length + 1,
      vendorId: input.vendorId,
      rail: input.rail,
      status: input.status,
      providerCustomerId: input.providerCustomerId,
      providerPaymentMethodId: input.providerPaymentMethodId,
      usdcWalletAddress: input.usdcWalletAddress,
      displayLabel: input.displayLabel,
      isDefault,
      metadata: input.metadata ?? {},
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    };
    this.fundingMethods.push(fundingMethod);
    return { fundingMethod, idempotentReplay: false };
  }

  private findReplay(
    idempotencyKey: string,
    referenceType: string,
    referenceId: string,
  ): DropshipWalletLedgerRecord | null {
    return this.ledger.find((entry) =>
      entry.idempotencyKey === idempotencyKey
      || (entry.referenceType === referenceType && entry.referenceId === referenceId)
    ) ?? null;
  }

  private assertReplay(entry: DropshipWalletLedgerRecord, requestHash: string): void {
    if (entry.metadata.requestHash !== requestHash) {
      throw new DropshipError(
        "DROPSHIP_WALLET_IDEMPOTENCY_CONFLICT",
        "Wallet idempotency conflict.",
      );
    }
  }

  private assertFundingMethod(fundingMethodId: number | null): DropshipFundingMethodRecord | null {
    if (!fundingMethodId) return null;
    const fundingMethod = this.fundingMethods.find((method) => method.fundingMethodId === fundingMethodId);
    if (!fundingMethod) {
      throw new DropshipError("DROPSHIP_FUNDING_METHOD_NOT_FOUND", "Funding method not found.");
    }
    if (fundingMethod.status !== "active") {
      throw new DropshipError("DROPSHIP_FUNDING_METHOD_NOT_ACTIVE", "Funding method is not active.");
    }
    return fundingMethod;
  }

  private insertLedger(
    input: Omit<DropshipWalletLedgerRecord, "ledgerEntryId" | "walletAccountId" | "vendorId" | "externalTransactionId">
      & { externalTransactionId?: string | null },
  ): DropshipWalletLedgerRecord {
    const ledgerEntry: DropshipWalletLedgerRecord = {
      ledgerEntryId: this.ledger.length + 1,
      walletAccountId: this.account.walletAccountId,
      vendorId: this.account.vendorId,
      externalTransactionId: null,
      ...input,
    };
    this.ledger.push(ledgerEntry);
    return ledgerEntry;
  }

  private insertUsdcLedger(
    input: CreateDropshipConfirmedUsdcFundingRepositoryInput & { walletLedgerId: number },
  ): DropshipUsdcLedgerEntryRecord {
    const usdcLedgerEntry: DropshipUsdcLedgerEntryRecord = {
      usdcLedgerEntryId: this.usdcLedger.length + 1,
      vendorId: input.vendorId,
      walletLedgerId: input.walletLedgerId,
      chainId: input.chainId,
      transactionHash: input.transactionHash,
      fromAddress: input.fromAddress ?? null,
      toAddress: input.toAddress,
      amountAtomicUnits: input.amountAtomicUnits,
      confirmations: input.confirmations,
      status: "settled",
      observedAt: input.observedAt,
      settledAt: input.occurredAt,
    };
    this.usdcLedger.push(usdcLedgerEntry);
    return usdcLedgerEntry;
  }
}

function makeAccount(): DropshipWalletAccountRecord {
  return {
    walletAccountId: 5,
    vendorId: 10,
    availableBalanceCents: 0,
    pendingBalanceCents: 0,
    currency: "USD",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function makeAutoReloadSetting(
  overrides: Partial<DropshipAutoReloadSettingRecord> = {},
): DropshipAutoReloadSettingRecord {
  return {
    autoReloadSettingId: 1,
    vendorId: 10,
    fundingMethodId: 99,
    enabled: true,
    minimumBalanceCents: 5000,
    maxSingleReloadCents: 25000,
    paymentHoldTimeoutMinutes: 2880,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeFundingMethod(overrides: Partial<DropshipFundingMethodRecord> = {}): DropshipFundingMethodRecord {
  return {
    fundingMethodId: 99,
    vendorId: 10,
    rail: "stripe_card",
    status: "active",
    providerCustomerId: "cus_existing",
    providerPaymentMethodId: "pm_4242",
    usdcWalletAddress: null,
    displayLabel: "Visa ending in 4242",
    isDefault: true,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeVendor(overrides: Partial<DropshipProvisionedVendorProfile> = {}): DropshipProvisionedVendorProfile {
  return {
    vendorId: 10,
    memberId: "member-1",
    currentSubscriptionId: "sub-1",
    currentPlanId: "ops",
    businessName: null,
    contactName: null,
    email: "vendor@cardshellz.test",
    phone: null,
    status: "active",
    entitlementStatus: "active",
    entitlementCheckedAt: now,
    membershipGraceEndsAt: null,
    includedStoreConnections: 1,
    standingReason: null,
    pausedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
