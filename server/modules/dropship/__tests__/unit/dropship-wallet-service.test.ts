import { beforeEach, describe, expect, it } from "vitest";
import type { DropshipVendorStandingReason, DropshipVendorStatus } from "../../../../../shared/schema/dropship.schema";
import { DropshipError } from "../../domain/errors";
import { decideFundingReversal } from "../../domain/funding-reversal";
import type { DropshipAdvanceContext } from "../../domain/acceptance-funding";
import type {
  DropshipWalletPolicyLimits,
  DropshipWalletPolicyResolver,
} from "../../domain/wallet-policy";
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
  usdcTransactionReferenceId,
  resolveDropshipCardFundingFeeBps,
  resolveDropshipUsdcBaseDepositAddress,
  type ConfigureDropshipAutoReloadRepositoryInput,
  type CreateDropshipConfirmedUsdcFundingRepositoryInput,
  type CreateDropshipWalletFundingLedgerInput,
  type CreateDropshipWalletOrderDebitInput,
  type DropshipAutoReloadSettingRecord,
  type DropshipAutoReloadResult,
  type DropshipBankBalanceSnapshot,
  type DropshipStripeRailAvailability,
  type DropshipBankBalanceVerificationRecord,
  type RecordDropshipBankBalanceVerificationRepositoryInput,
  type DropshipConfirmedUsdcFundingResult,
  type DropshipFundingReinstatementRepositoryResult,
  type DropshipFundingReversalRepositoryResult,
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
  type ReinstateDropshipReversedFundingRepositoryInput,
  type ReverseDropshipSettledFundingRepositoryInput,
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

  function buildService(overrides: {
    vendorStanding?: FakeVendorStandingService;
    walletPolicy?: DropshipWalletPolicyResolver;
    usdcBaseDepositAddress?: string | null;
    usdcDepositAddressLookup?: (vendorId: number) => Promise<string | null>;
  } = {}): DropshipWalletService {
    return new DropshipWalletService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      fundingProvider,
      notificationSender,
      vendorStanding: overrides.vendorStanding,
      walletPolicy: overrides.walletPolicy,
      // The shared deposit address the manual USDC credits below name; the
      // vendor's own address comes from the lookup (funding design phase 6).
      usdcBaseDepositAddress: overrides.usdcBaseDepositAddress === undefined
        ? "0x1111111111111111111111111111111111111111"
        : overrides.usdcBaseDepositAddress,
      usdcDepositAddressLookup: overrides.usdcDepositAddressLookup,
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

  it("refuses a manual USDC credit whose dollar amount is not the USDC amount in whole cents (funding design phase 6)", async () => {
    await expect(service.creditConfirmedUsdcFunding({
      vendorId: 10,
      amountCents: 2501,
      currency: "USD",
      amountAtomicUnits: "25000000",
      chainId: 8453,
      transactionHash: `0x${"c".repeat(64)}`,
      toAddress: "0x1111111111111111111111111111111111111111",
      confirmations: 12,
      idempotencyKey: "usdc-credit-mismatch",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toMatchObject({ code: "DROPSHIP_USDC_AMOUNT_MISMATCH", context: { expectedCents: 2500, amountCents: 2501 } });
    expect(repository.ledger).toHaveLength(0);
  });

  it("refuses a manual USDC credit for a transfer to an address Card Shellz does not control", async () => {
    const credit = (toAddress: string) => ({
      vendorId: 10,
      amountCents: 2500,
      currency: "USD",
      amountAtomicUnits: "25000000",
      chainId: 8453,
      transactionHash: `0x${"c".repeat(64)}`,
      toAddress,
      confirmations: 12,
      idempotencyKey: "usdc-credit-elsewhere",
      actor: { actorType: "admin" as const, actorId: "admin-1" },
    });
    await expect(service.creditConfirmedUsdcFunding(credit("0x3333333333333333333333333333333333333333")))
      .rejects.toMatchObject({ code: "DROPSHIP_USDC_DEPOSIT_ADDRESS_UNKNOWN", context: { allowedAddresses: ["0x1111111111111111111111111111111111111111"] } });
    // Nothing configured at all: no transfer can be attributed to anyone.
    await expect(buildService({ usdcBaseDepositAddress: null }).creditConfirmedUsdcFunding(credit("0x1111111111111111111111111111111111111111")))
      .rejects.toMatchObject({ code: "DROPSHIP_USDC_DEPOSIT_ADDRESS_UNKNOWN", message: expect.stringContaining("No USDC deposit address") });
    expect(repository.ledger).toHaveLength(0);
  });

  it("accepts a manual USDC credit to the vendor's own deposit address and keys one transfer of a batch by its log index", async () => {
    const own = buildService({
      usdcBaseDepositAddress: null,
      usdcDepositAddressLookup: async (vendorId) => (vendorId === 10 ? "0x4444444444444444444444444444444444444444" : null),
    });
    const result = await own.creditConfirmedUsdcFunding({
      vendorId: 10,
      amountCents: 2512,
      currency: "USD",
      amountAtomicUnits: "25123456",
      chainId: 8453,
      transactionHash: `0x${"d".repeat(64)}`,
      toAddress: "0x4444444444444444444444444444444444444444",
      logIndex: 3,
      confirmations: 12,
      idempotencyKey: "usdc-credit-own",
      actor: { actorType: "admin", actorId: "admin-1" },
    });
    expect(result.ledgerEntry).toMatchObject({ amountCents: 2512, referenceId: `8453:0x${"d".repeat(64)}:3` });
    expect(result.usdcLedgerEntry).toMatchObject({ logIndex: 3 });
    expect(logs.find((log) => log.code === "DROPSHIP_WALLET_USDC_FUNDING_CREDITED")?.context).toMatchObject({ logIndex: 3 });
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
      minimumBalanceCents: 10000,
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
      context: expect.objectContaining({ floorCents: 10000 }),
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
      minimumBalanceCents: 10000,
      maxSingleReloadCents: 5000,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({
      code: "DROPSHIP_AUTO_RELOAD_AMOUNT_BELOW_MINIMUM",
      context: expect.objectContaining({ floorCents: 10000 }),
    });

    // A top-up amount below the policy's smallest top-up would make every refill a nuisance pull.
    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 10000,
      topUpAmountCents: 5000,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({
      code: "DROPSHIP_AUTO_RELOAD_TOP_UP_BELOW_MINIMUM",
      context: expect.objectContaining({ topUpAmountCents: 5000, floorCents: 10000 }),
    });

    // An older client's own bound must cover the top-up amount as well as the minimum.
    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 10000,
      topUpAmountCents: 30000,
      maxSingleReloadCents: 20000,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({ code: "DROPSHIP_AUTO_RELOAD_INVALID_LIMITS" });

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
      minimumBalanceCents: 10000,
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
      minimumBalanceCents: 10000,
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
        minimumBalanceCents: 10000,
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
      minimumBalanceCents: 10000,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
    });

    expect(setting).toMatchObject({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 10000,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
    });
    expect(logs.at(-1)).toMatchObject({ code: "DROPSHIP_AUTO_RELOAD_CONFIGURED" });
  });

  it("keeps one number for the vendor: the bound is derived from the minimum and the top-up amount when the client sends none (funding design phase 5)", async () => {
    const derived = await service.configureAutoReload({
      vendorId: 10, fundingMethodId: 99, enabled: true, minimumBalanceCents: 10000, paymentHoldTimeoutMinutes: 2880,
    });
    expect(derived).toMatchObject({ minimumBalanceCents: 10000, topUpAmountCents: null, maxSingleReloadCents: 10000 });
    expect(repository.lastConfigureInput).toMatchObject({ topUpAmountCents: null, maxSingleReloadCents: 10000 });

    // An explicit null bound derives too: the bound is the server's, never unbounded.
    const bigger = await service.configureAutoReload({
      vendorId: 10, fundingMethodId: 99, enabled: true, minimumBalanceCents: 10000, topUpAmountCents: 25000, maxSingleReloadCents: null, paymentHoldTimeoutMinutes: 2880,
    });
    expect(bigger).toMatchObject({ topUpAmountCents: 25000, maxSingleReloadCents: 25000 });

    // An older client's own bound is kept as long as it covers both amounts.
    const explicit = await service.configureAutoReload({
      vendorId: 10, fundingMethodId: 99, enabled: true, minimumBalanceCents: 10000, topUpAmountCents: 15000, maxSingleReloadCents: 40000, paymentHoldTimeoutMinutes: 2880,
    });
    expect(explicit).toMatchObject({ topUpAmountCents: 15000, maxSingleReloadCents: 40000 });
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_AUTO_RELOAD_CONFIGURED",
      context: expect.objectContaining({ topUpAmountCents: 15000, maxSingleReloadCents: 40000 }),
    });

    // Off, with nothing sent: nothing is derived for a mandate that is not in force.
    const off = await service.configureAutoReload({
      vendorId: 10, fundingMethodId: 99, enabled: false, minimumBalanceCents: 10000, paymentHoldTimeoutMinutes: 2880,
    });
    expect(off).toMatchObject({ enabled: false, topUpAmountCents: null, maxSingleReloadCents: null });
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
      minimumBalanceCents: 10000,
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

    // Under the minimum by 1,500: the refill pulls the top-up amount (the minimum, 5,000, by default), not the gap.
    repository.account = { ...repository.account, pendingBalanceCents: 2500 };
    const topped = await service.handleAutoReload({ vendorId: 10, reason: "minimum_balance", idempotencyKey: "routine-pending-2" });
    expect(topped).toMatchObject({ outcome: "funding_created", amountCents: 5000, fundingStatus: "pending" });
  });

  it("pulls the top-up amount on a routine refill, or the whole shortfall when that is more, never past the bound (funding design phase 5)", async () => {
    // Default: the minimum itself, even for a small dip, so refills are few.
    repository.autoReload = makeAutoReloadSetting({ fundingMethodId: 100, minimumBalanceCents: 10000, maxSingleReloadCents: 10000 });
    repository.account = { ...repository.account, availableBalanceCents: 9500 };
    expect(await service.handleAutoReload({ vendorId: 10, reason: "minimum_balance", idempotencyKey: "refill-1" }))
      .toMatchObject({ outcome: "funding_created", amountCents: 10000, fundingStatus: "pending" });
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_AUTO_RELOAD_FUNDING_CREATED",
      context: expect.objectContaining({ refillShortfallCents: 500, refillPartial: false }),
    });

    // The top-up amount the vendor chose.
    repository.autoReload = makeAutoReloadSetting({ fundingMethodId: 100, minimumBalanceCents: 10000, topUpAmountCents: 25000, maxSingleReloadCents: 25000 });
    repository.account = { ...repository.account, availableBalanceCents: 9500, pendingBalanceCents: 0 };
    expect(await service.handleAutoReload({ vendorId: 10, reason: "minimum_balance", idempotencyKey: "refill-2" }))
      .toMatchObject({ outcome: "funding_created", amountCents: 25000 });

    // A shortfall bigger than the top-up amount: the whole shortfall, within the bound.
    repository.autoReload = makeAutoReloadSetting({ fundingMethodId: 100, minimumBalanceCents: 10000, topUpAmountCents: 15000, maxSingleReloadCents: 20000 });
    repository.account = { ...repository.account, availableBalanceCents: -8000, pendingBalanceCents: 0 };
    expect(await service.handleAutoReload({ vendorId: 10, reason: "minimum_balance", idempotencyKey: "refill-3" }))
      .toMatchObject({ outcome: "funding_created", amountCents: 18000 });

    // Past the bound: a bounded partial pull, logged as such, never a skip.
    repository.account = { ...repository.account, availableBalanceCents: -50000, pendingBalanceCents: 0 };
    expect(await service.handleAutoReload({ vendorId: 10, reason: "minimum_balance", idempotencyKey: "refill-4" }))
      .toMatchObject({ outcome: "funding_created", amountCents: 20000 });
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_AUTO_RELOAD_FUNDING_CREATED",
      context: expect.objectContaining({ refillShortfallCents: 60000, refillPartial: true }),
    });
    expect(fundingProvider.paymentIntentInputs.map((input) => input.amountCents)).toEqual([10000, 25000, 18000, 20000]);
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

  describe("wallet policy limits", () => {
    /** A published policy that differs from every environment default. */
    const publishedLimits: DropshipWalletPolicyLimits = {
      autoReloadMinTriggerCents: 9_000,
      autoReloadMinAmountCents: 20_000,
      manualFundingMinCents: 2_500,
      manualFundingMaxCents: 60_000,
      defaultPaymentHoldTimeoutMinutes: 1_440,
      holdExpiryWarningMinutes: 45,
      caseTierMinimumCents: 55_000,
      advanceFeeBps: 150,
      advanceCapCents: 75_000,
      tierChangeGraceDays: 21,
    };
    const policy: DropshipWalletPolicyResolver = { resolveWalletLimits: async () => ({ ...publishedLimits }) };

    it("serves the published limits with the wallet so the page stops guessing them", async () => {
      const wallet = await buildService({ walletPolicy: policy }).getWalletForVendor(10);
      expect(wallet.limits).toEqual(publishedLimits);
    });

    it("falls back to the environment limits when no policy resolver is wired", async () => {
      const wallet = await service.getWalletForVendor(10);
      expect(wallet.limits).toEqual({
        autoReloadMinTriggerCents: 10_000,
        caseTierMinimumCents: 50_000,
        autoReloadMinAmountCents: 10_000,
        manualFundingMinCents: 1_000,
        manualFundingMaxCents: 500_000,
        defaultPaymentHoldTimeoutMinutes: 1_440,
        holdExpiryWarningMinutes: 120,
        advanceFeeBps: 100,
        advanceCapCents: 50_000,
        tierChangeGraceDays: 14,
      });
    });

    it("enforces the published auto-reload floors, not the environment defaults", async () => {
      const policyService = buildService({ walletPolicy: policy });
      // 8500/10000 sits below the published 9_000 floor; the refusal must
      // name the PUBLISHED floor, never the fallback default.
      await expect(policyService.configureAutoReload({
        vendorId: 10,
        fundingMethodId: 99,
        enabled: true,
        minimumBalanceCents: 8_500,
        maxSingleReloadCents: 10_000,
        paymentHoldTimeoutMinutes: 2880,
      })).rejects.toMatchObject({
        code: "DROPSHIP_AUTO_RELOAD_TRIGGER_BELOW_MINIMUM",
        context: expect.objectContaining({ floorCents: 9_000 }),
      });

      await expect(policyService.configureAutoReload({
        vendorId: 10,
        fundingMethodId: 99,
        enabled: true,
        minimumBalanceCents: 9_000,
        maxSingleReloadCents: 10_000,
        paymentHoldTimeoutMinutes: 2880,
      })).rejects.toMatchObject({
        code: "DROPSHIP_AUTO_RELOAD_AMOUNT_BELOW_MINIMUM",
        context: expect.objectContaining({ floorCents: 20_000 }),
      });

      const setting = await policyService.configureAutoReload({
        vendorId: 10,
        fundingMethodId: 99,
        enabled: true,
        minimumBalanceCents: 9_000,
        maxSingleReloadCents: 20_000,
        paymentHoldTimeoutMinutes: 2880,
      });
      expect(setting.minimumBalanceCents).toBe(9_000);
      expect(logs.at(-1)).toMatchObject({
        code: "DROPSHIP_AUTO_RELOAD_CONFIGURED",
        context: expect.objectContaining({
          autoReloadMinTriggerCents: 9_000,
          autoReloadMinAmountCents: 20_000,
        }),
      });
    });

    it("enforces the published manual top-up bounds on a funding session", async () => {
      const policyService = buildService({ walletPolicy: policy });

      await expect(policyService.createStripeWalletFundingSessionForMember("member-1", {
        fundingMethodId: 99,
        amountCents: 2_000,
        successUrl: "https://cardshellz.io/wallet?wallet_funding=success",
        cancelUrl: "https://cardshellz.io/wallet?wallet_funding=cancelled",
      })).rejects.toMatchObject({
        code: "DROPSHIP_WALLET_FUNDING_AMOUNT_OUT_OF_RANGE",
        context: expect.objectContaining({ minCents: 2_500, maxCents: 60_000 }),
      });

      // Above the published ceiling but well inside the environment default.
      await expect(policyService.createStripeWalletFundingSessionForMember("member-1", {
        fundingMethodId: 99,
        amountCents: 100_000,
        successUrl: "https://cardshellz.io/wallet?wallet_funding=success",
        cancelUrl: "https://cardshellz.io/wallet?wallet_funding=cancelled",
      })).rejects.toMatchObject({
        code: "DROPSHIP_WALLET_FUNDING_AMOUNT_OUT_OF_RANGE",
        context: expect.objectContaining({ maxCents: 60_000 }),
      });

      const session = await policyService.createStripeWalletFundingSessionForMember("member-1", {
        fundingMethodId: 99,
        amountCents: 25_000,
        successUrl: "https://cardshellz.io/wallet?wallet_funding=success",
        cancelUrl: "https://cardshellz.io/wallet?wallet_funding=cancelled",
      });
      expect(session).toMatchObject({ amountCents: 25_000 });
    });
  });

  it("records the fee rate the vendor agreed to when auto-reload is configured", async () => {
    await service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 10000,
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
      minimumBalanceCents: 10000,
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
      minimumBalanceCents: 10000,
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
  /** Both rails live: the wallet service never reads this, only the readiness page does. */
  async readRailAvailability(): Promise<DropshipStripeRailAvailability> {
    return { outcome: "read", accountId: "acct_test", cardPayments: "active", achPayments: "active", reason: null };
  }

  /** What a bank balance read reports; USD by default so the wallet's currency resolves. */
  bankBalanceSnapshot: DropshipBankBalanceSnapshot = { status: "succeeded", availableByCurrency: { usd: 123_456 }, asOf: now };
  bankBalanceReads: string[] = [];
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

  async readBankBalance(input: { providerAccountId: string; now: Date }): Promise<DropshipBankBalanceSnapshot> {
    this.bankBalanceReads.push(input.providerAccountId);
    return this.bankBalanceSnapshot;
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

describe("DropshipWalletService advance and bank balance (funding design phase 3)", () => {
  let repository: FakeWalletRepository;
  let fundingProvider: FakeFundingProvider;
  let logs: Array<DropshipLogEvent & { level: "info" | "warn" | "error" }>;
  let service: DropshipWalletService;

  beforeEach(() => {
    repository = new FakeWalletRepository();
    fundingProvider = new FakeFundingProvider();
    logs = [];
    service = new DropshipWalletService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      fundingProvider,
      notificationSender: new FakeNotificationSender(),
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push({ ...event, level: "info" }),
        warn: (event) => logs.push({ ...event, level: "warn" }),
        error: (event) => logs.push({ ...event, level: "error" }),
      },
      cardFundingFeeBps: 300,
    });
  });

  function bankAccount(overrides: Partial<DropshipFundingMethodRecord> = {}): DropshipFundingMethodRecord {
    return makeFundingMethod({
      fundingMethodId: 100,
      rail: "stripe_ach",
      displayLabel: "ACH ending in 6789",
      isDefault: false,
      metadata: { provider: "stripe", accountHolderType: "company", financialConnectionsAccountId: "fca_1" },
      ...overrides,
    });
  }

  it("charges the card the vendor's limit when it sits between the order gap and back-to-minimum", async () => {
    repository.account = { ...makeAccount(), availableBalanceCents: 2_000 };
    repository.autoReload = makeAutoReloadSetting({ fundingMethodId: 99, minimumBalanceCents: 10_000, maxSingleReloadCents: 4_000 });

    const result = await service.handleAutoReload({
      vendorId: 10,
      reason: "payment_hold",
      requiredBalanceCents: 5_000,
      intakeId: 456,
      idempotencyKey: "auto-reload-intake-456",
    });

    // Gap 3,000; back to minimum 8,000; limit 4,000 wins and still covers the order.
    expect(result).toMatchObject({ outcome: "funding_created", fundingMethodId: 99, amountCents: 4_000, fundingStatus: "settled" });
    expect(repository.account.availableBalanceCents).toBe(6_000);
  });

  it("composes the vendor's advance position into the wallet view, and reports its absence", async () => {
    repository.account = { ...makeAccount(), availableBalanceCents: -5_000 };
    repository.advanceContext = {
      policy: { feeBps: 100, capCents: 50_000, capSource: "policy" },
      sources: [{ fundingMethodId: 100, pendingCents: 40_000, accountHolderType: "company", balanceVerified: true, priorPullSettled: true }],
    };

    const view = await service.getWalletForVendor(10);
    expect(view.advance).toMatchObject({
      eligiblePendingCents: 40_000,
      allowanceCents: 40_000,
      exposureCents: 5_000,
      headroomCents: 35_000,
      reasons: [],
      policy: { feeBps: 100, capCents: 50_000, capSource: "policy" },
    });

    repository.advanceContext = null;
    expect((await service.getWalletForVendor(10)).advance).toBeNull();
  });

  it("reads and records the balance behind a linked bank account, once per provider event", async () => {
    repository.fundingMethods = [makeFundingMethod(), bankAccount()];

    const first = await service.verifyBankBalanceForFundingMethod({ vendorId: 10, fundingMethodId: 100, source: "link", providerEventId: "evt_setup_1" });
    expect(first).toMatchObject({
      outcome: "recorded",
      idempotentReplay: false,
      record: { fundingMethodId: 100, providerAccountId: "fca_1", status: "succeeded", source: "link", availableCents: 123_456, currency: "USD", balanceAsOf: now },
    });
    expect(fundingProvider.bankBalanceReads).toEqual(["fca_1"]);
    expect(logs.at(-1)).toMatchObject({ level: "info", code: "DROPSHIP_BANK_BALANCE_VERIFIED", context: expect.objectContaining({ availableCents: 123_456 }) });

    const replay = await service.verifyBankBalanceForFundingMethod({ vendorId: 10, fundingMethodId: 100, source: "link", providerEventId: "evt_setup_1" });
    expect(replay).toMatchObject({ outcome: "recorded", idempotentReplay: true });
    expect(repository.verifications).toHaveLength(1);
  });

  it("leaves a card, and a bank account not linked through the provider, unverified without reading anything", async () => {
    repository.fundingMethods = [makeFundingMethod(), bankAccount({ metadata: { provider: "stripe", accountHolderType: "company" } })];

    expect(await service.verifyBankBalanceForFundingMethod({ vendorId: 10, fundingMethodId: 99, source: "link", providerEventId: "evt_1" }))
      .toEqual({ outcome: "not_applicable", reason: "not_bank_account" });
    expect(await service.verifyBankBalanceForFundingMethod({ vendorId: 10, fundingMethodId: 100, source: "link", providerEventId: "evt_1" }))
      .toEqual({ outcome: "not_applicable", reason: "no_provider_account" });
    expect(await service.verifyBankBalanceForFundingMethod({ vendorId: 10, fundingMethodId: 7, source: "link", providerEventId: "evt_1" }))
      .toEqual({ outcome: "not_applicable", reason: "funding_method_missing" });
    expect(fundingProvider.bankBalanceReads).toEqual([]);
    expect(repository.verifications).toEqual([]);
  });

  it("records a failed reading when the provider reports no balance in the wallet's currency, and never throws", async () => {
    repository.fundingMethods = [bankAccount()];
    fundingProvider.bankBalanceSnapshot = { status: "succeeded", availableByCurrency: { eur: 500 }, asOf: now };

    const outcome = await service.verifyBankBalanceForFundingMethod({ vendorId: 10, fundingMethodId: 100, source: "refresh", providerEventId: null });
    expect(outcome).toMatchObject({ outcome: "recorded", record: { status: "failed", availableCents: null } });
    expect(repository.verifications[0]).toMatchObject({ reading: { status: "failed", reason: "balance_currency_missing" }, source: "refresh", providerEventId: null });
    expect(logs.at(-1)).toMatchObject({ level: "warn", code: "DROPSHIP_BANK_BALANCE_READ_FAILED" });

    fundingProvider.readBankBalance = async () => { throw new Error("stripe unreachable"); };
    const failed = await service.verifyBankBalanceForFundingMethod({ vendorId: 10, fundingMethodId: 100, source: "link", providerEventId: "evt_2" });
    expect(failed).toEqual({ outcome: "failed", message: "stripe unreachable" });
    expect(logs.at(-1)).toMatchObject({ level: "warn", code: "DROPSHIP_BANK_BALANCE_VERIFICATION_FAILED" });
  });

  it("tells the vendor a returned transfer leaves the balance negative when orders were paid from it", async () => {
    const notificationSender = new FakeNotificationSender();
    service = new DropshipWalletService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      fundingProvider,
      notificationSender,
      clock: { now: () => now },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      cardFundingFeeBps: 300,
    });
    // $500 arrived pending, an order then drew $303 of it (balance -$303), and the bank returns the transfer.
    await service.creditFunding({
      vendorId: 10, fundingMethodId: 100, rail: "stripe_ach", status: "pending", amountCents: 50_000, currency: "USD",
      referenceType: "stripe_payment_intent", referenceId: "pi_ach_9", idempotencyKey: "stripe-funding:pi_ach_9",
    });
    repository.account = { ...repository.account, availableBalanceCents: -30_300 };

    const result = await service.recordWalletFundingFailure({
      vendorId: 10, fundingMethodId: 100, rail: "stripe_ach", amountCents: 50_000, currency: "USD", provider: "stripe",
      providerEventId: "evt_ach_returned_9", providerPaymentIntentId: "pi_ach_9", providerStatus: "requires_payment_method",
      failureCode: "payment_intent_payment_attempt_failed", failureMessage: "The bank returned the debit.", autoReload: false,
      idempotencyKey: "stripe-funding-failed:pi_ach_9",
    });

    expect(result.pendingCreditVoided).toBe(true);
    expect(repository.account).toMatchObject({ availableBalanceCents: -30_300, pendingBalanceCents: 0 });
    const notice = notificationSender.sent.at(-1);
    expect(notice?.message).toContain("The pending credit has been removed from your balance.");
    expect(notice?.message).toContain("Orders accepted against it leave your balance at USD -$303.00; the next wallet run collects that amount from your funding source.");
  });

  it("records a refreshed balance the provider reports against the account it belongs to, and ignores unknown accounts", async () => {
    repository.fundingMethods = [bankAccount()];
    const snapshot: DropshipBankBalanceSnapshot = { status: "succeeded", availableByCurrency: { usd: 90_000 }, asOf: now };

    const matched = await service.recordBankBalanceRefresh({ providerAccountId: "fca_1", snapshot, providerEventId: "evt_refresh_1" });
    expect(matched).toMatchObject({ outcome: "recorded", record: { fundingMethodId: 100, status: "succeeded", source: "webhook", availableCents: 90_000 } });

    const unmatched = await service.recordBankBalanceRefresh({ providerAccountId: "fca_other", snapshot, providerEventId: "evt_refresh_2" });
    expect(unmatched).toEqual({ outcome: "not_applicable", reason: "funding_method_missing" });
    expect(repository.verifications).toHaveLength(1);
  });
});

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
      minTriggerCents: 10_000,
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
      })).toEqual({ minTriggerCents: 10_000, minAmountCents: 10_000 });
    }
  });
});

class FakeWalletRepository implements DropshipWalletRepository {
  account: DropshipWalletAccountRecord = makeAccount();
  /** Drives the guard that keeps a live vendor from removing the card backstop. */
  vendorStatus: DropshipVendorStatus | null = "onboarding";
  standingRevision = 0;
  failInputs: FailDropshipPendingFundingRepositoryInput[] = [];
  reverseInputs: ReverseDropshipSettledFundingRepositoryInput[] = [];
  reinstateInputs: ReinstateDropshipReversedFundingRepositoryInput[] = [];
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
  /** The advance facts the view composes from; null models an unreadable policy. */
  advanceContext: DropshipAdvanceContext | null = null;
  verifications: RecordDropshipBankBalanceVerificationRepositoryInput[] = [];

  async getOrCreateWalletAccount(): Promise<DropshipWalletAccountRecord> {
    return this.account;
  }

  async readAdvanceContext(): Promise<DropshipAdvanceContext | null> {
    return this.advanceContext;
  }

  async recordBankBalanceVerification(
    input: RecordDropshipBankBalanceVerificationRepositoryInput,
  ): Promise<{ record: DropshipBankBalanceVerificationRecord; idempotentReplay: boolean }> {
    const idempotentReplay = input.providerEventId !== null
      && this.verifications.some((entry) => entry.providerEventId === input.providerEventId);
    if (!idempotentReplay) this.verifications.push(input);
    const reading = input.reading;
    return {
      record: {
        verificationId: this.verifications.length,
        vendorId: input.vendorId,
        fundingMethodId: input.fundingMethodId,
        provider: input.provider,
        providerAccountId: reading.providerAccountId,
        status: reading.status,
        source: input.source,
        availableCents: reading.status === "succeeded" ? reading.availableCents : null,
        currency: reading.status === "succeeded" ? reading.currency : null,
        balanceAsOf: reading.status === "succeeded" ? reading.asOf : null,
        providerEventId: input.providerEventId,
        createdAt: input.occurredAt,
      },
      idempotentReplay,
    };
  }

  async findFundingMethodByProviderAccount(input: { provider: "stripe"; providerAccountId: string }): Promise<DropshipFundingMethodRecord | null> {
    return this.fundingMethods.find((method) =>
      method.rail === "stripe_ach" && method.metadata.financialConnectionsAccountId === input.providerAccountId,
    ) ?? null;
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
    const vendorPaused = input.pauseVendor
      ? this.pauseIfActive(input.vendorId, input.pauseVendor.reason, input.occurredAt)
      : null;
    return { account: this.account, ledgerEntry: failed, idempotentReplay: false, vendorPaused };
  }

  async reverseSettledFunding(
    input: ReverseDropshipSettledFundingRepositoryInput,
  ): Promise<DropshipFundingReversalRepositoryResult | null> {
    this.reverseInputs.push(input);
    const credit = this.ledger.find((entry) =>
      entry.type === "funding"
      && entry.referenceType === "stripe_payment_intent"
      && entry.referenceId === input.providerPaymentIntentId
    );
    if (!credit) return null;
    const existing = this.ledger.find((entry) =>
      entry.type === "funding_reversal" && entry.referenceType === "stripe_dispute" && entry.referenceId === input.providerDisputeId
    );
    if (existing) {
      return { outcome: "reversed", vendorId: credit.vendorId, account: this.account, credit, reversal: existing, idempotentReplay: true, vendorPaused: null };
    }
    const decision = decideFundingReversal({
      credit: { amountCents: credit.amountCents, currency: credit.currency, status: credit.status },
      dispute: { amountCents: input.disputeAmountCents, currency: input.currency },
    });
    if (decision.outcome === "ignore") {
      return { outcome: "ignored", vendorId: credit.vendorId, credit, reason: decision.reason };
    }
    const availableBalanceCents = this.account.availableBalanceCents - decision.reversalCents;
    this.account = { ...this.account, availableBalanceCents, updatedAt: input.occurredAt };
    const reversal = this.insertLedger({
      type: "funding_reversal",
      status: "settled",
      amountCents: -decision.reversalCents,
      currency: credit.currency,
      availableBalanceAfterCents: availableBalanceCents,
      pendingBalanceAfterCents: this.account.pendingBalanceCents,
      referenceType: "stripe_dispute",
      referenceId: input.providerDisputeId,
      idempotencyKey: `stripe-dispute:${input.providerDisputeId}`,
      fundingMethodId: credit.fundingMethodId,
      metadata: {
        provider: input.provider,
        providerEventId: input.providerEventId,
        fundingLedgerEntryId: credit.ledgerEntryId,
        disputeStatus: input.disputeStatus,
      },
      createdAt: input.occurredAt,
      settledAt: input.occurredAt,
    });
    // Mirrors the real repository: the guarded pause rides the reversal transaction.
    const vendorPaused = input.pauseVendor
      ? this.pauseIfActive(credit.vendorId, input.pauseVendor.reason, input.occurredAt)
      : null;
    return { outcome: "reversed", vendorId: credit.vendorId, account: this.account, credit, reversal, idempotentReplay: false, vendorPaused };
  }

  async reinstateReversedFunding(
    input: ReinstateDropshipReversedFundingRepositoryInput,
  ): Promise<DropshipFundingReinstatementRepositoryResult | null> {
    this.reinstateInputs.push(input);
    const reversal = this.ledger.find((entry) =>
      entry.type === "funding_reversal" && entry.referenceType === "stripe_dispute" && entry.referenceId === input.providerDisputeId
    );
    if (!reversal) return null;
    const existing = this.ledger.find((entry) =>
      entry.type === "funding_reinstated" && entry.referenceType === "stripe_dispute_reinstated" && entry.referenceId === input.providerDisputeId
    );
    if (existing) {
      return { vendorId: reversal.vendorId, account: this.account, reversal, reinstatement: existing, idempotentReplay: true };
    }
    const amountCents = -reversal.amountCents;
    const availableBalanceCents = this.account.availableBalanceCents + amountCents;
    this.account = { ...this.account, availableBalanceCents, updatedAt: input.occurredAt };
    const reinstatement = this.insertLedger({
      type: "funding_reinstated",
      status: "settled",
      amountCents,
      currency: reversal.currency,
      availableBalanceAfterCents: availableBalanceCents,
      pendingBalanceAfterCents: this.account.pendingBalanceCents,
      referenceType: "stripe_dispute_reinstated",
      referenceId: input.providerDisputeId,
      idempotencyKey: `stripe-dispute-reinstated:${input.providerDisputeId}`,
      fundingMethodId: reversal.fundingMethodId,
      metadata: { provider: input.provider, providerEventId: input.providerEventId, reversalLedgerEntryId: reversal.ledgerEntryId },
      createdAt: input.occurredAt,
      settledAt: input.occurredAt,
    });
    return { vendorId: reversal.vendorId, account: this.account, reversal, reinstatement, idempotentReplay: false };
  }

  async creditConfirmedUsdcFunding(
    input: CreateDropshipConfirmedUsdcFundingRepositoryInput,
  ): Promise<DropshipConfirmedUsdcFundingResult> {
    const fundingMethod = this.assertFundingMethod(input.fundingMethodId);
    if (fundingMethod && fundingMethod.rail !== "usdc_base") {
      throw new DropshipError("DROPSHIP_FUNDING_METHOD_RAIL_MISMATCH", "Funding method rail mismatch.");
    }
    const referenceType = "usdc_base_transaction";
    const referenceId = usdcTransactionReferenceId(input);
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
      topUpAmountCents: input.topUpAmountCents,
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

  /** The real repository's guarded pause: only an active vendor changes, and each pause bumps the standing revision. */
  private pauseIfActive(
    vendorId: number,
    reason: DropshipVendorStandingReason,
    occurredAt: Date,
  ): DropshipWalletFundingFailureRepositoryResult["vendorPaused"] {
    if (this.vendorStatus !== "active") return null;
    this.vendorStatus = "paused";
    this.standingRevision += 1;
    return {
      vendorId,
      status: "paused",
      standingReason: reason,
      pausedAt: occurredAt,
      standingRevision: this.standingRevision,
      listingHoldState: "released",
      listingHoldReconciledAt: null,
      listingHoldDetail: null,
    };
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
      logIndex: input.logIndex,
      blockNumber: null,
      blockHash: null,
      tokenAddress: null,
      depositAddressId: null,
      dustAtomicUnits: "0",
      voidedAt: null,
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
    minimumBalanceCents: 10000,
    maxSingleReloadCents: 25000,
    topUpAmountCents: null,
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

describe("DropshipWalletService funding reversals (funding design phase 4)", () => {
  let repository: FakeWalletRepository;
  let notificationSender: FakeNotificationSender;
  let standing: FakeVendorStandingService;
  let logs: Array<DropshipLogEvent & { level: "info" | "warn" | "error" }>;
  let service: DropshipWalletService;

  /** A chargeback on the settled card top-up below, as the provider reports it once the funds are gone. */
  const dispute = {
    provider: "stripe" as const,
    providerEventId: "evt_dp_1",
    providerDisputeId: "dp_1",
    providerPaymentIntentId: "pi_card_1",
    amountCents: 5_000,
    currency: "USD",
    status: "needs_response" as const,
    reason: "fraudulent",
    fundsWithdrawn: true,
  };
  const won = {
    provider: "stripe" as const,
    providerEventId: "evt_dp_2",
    providerDisputeId: "dp_1",
    providerPaymentIntentId: "pi_card_1",
    amountCents: 5_000,
    currency: "USD",
    status: "won" as const,
    fundsReinstated: true,
  };

  beforeEach(async () => {
    repository = new FakeWalletRepository();
    notificationSender = new FakeNotificationSender();
    standing = new FakeVendorStandingService();
    logs = [];
    service = new DropshipWalletService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      fundingProvider: new FakeFundingProvider(),
      notificationSender,
      vendorStanding: standing,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push({ ...event, level: "info" }),
        warn: (event) => logs.push({ ...event, level: "warn" }),
        error: (event) => logs.push({ ...event, level: "error" }),
      },
      cardFundingFeeBps: 300,
    });
    // A card top-up that settled and was partly spent: the reversal takes back more than is left.
    await service.creditFunding({
      vendorId: 10, fundingMethodId: 99, rail: "stripe_card", status: "settled", amountCents: 5_000, currency: "USD",
      referenceType: "stripe_payment_intent", referenceId: "pi_card_1", idempotencyKey: "funding-pi-card-1",
    });
    repository.account = { ...repository.account, availableBalanceCents: 2_000 };
    logs = [];
    notificationSender.sent = [];
    standing.restoreCalls = [];
  });

  it("takes the credit back when the bank disputes it, pauses the vendor in the same write, and lets the pause notice carry the news", async () => {
    repository.vendorStatus = "active";

    const result = await service.recordWalletFundingReversal(dispute);

    expect(result).toEqual({
      outcome: "reversed", vendorId: 10, reversalLedgerEntryId: 2, reversalCents: 5_000,
      availableBalanceAfterCents: -3_000, vendorPaused: true, idempotentReplay: false,
    });
    expect(repository.account.availableBalanceCents).toBe(-3_000);
    expect(repository.ledger[1]).toMatchObject({
      type: "funding_reversal", status: "settled", amountCents: -5_000, availableBalanceAfterCents: -3_000,
      referenceType: "stripe_dispute", referenceId: "dp_1", idempotencyKey: "stripe-dispute:dp_1", fundingMethodId: 99,
    });
    expect(repository.reverseInputs).toEqual([{
      provider: "stripe", providerPaymentIntentId: "pi_card_1", providerDisputeId: "dp_1", providerEventId: "evt_dp_1",
      disputeAmountCents: 5_000, currency: "USD", disputeStatus: "needs_response", disputeReason: "fraudulent", occurredAt: now,
      pauseVendor: {
        reason: "funding_returned",
        evidence: {
          source: "dispute_webhook", disputed: true, provider: "stripe", providerEventId: "evt_dp_1", providerDisputeId: "dp_1",
          providerPaymentIntentId: "pi_card_1", amountCents: 5_000, currency: "USD", disputeStatus: "needs_response", disputeReason: "fraudulent",
        },
      },
    }]);
    expect(repository.vendorStatus).toBe("paused");
    expect(standing.announceCalls).toEqual([{
      vendorId: 10,
      evidence: expect.objectContaining({ source: "dispute_webhook", disputed: true, ledgerEntryId: 2, amountCents: 5_000 }),
    }]);
    expect(notificationSender.sent).toEqual([]);
    expect(logs.find((entry) => entry.code === "DROPSHIP_WALLET_FUNDING_REVERSED")).toMatchObject({
      level: "warn",
      context: expect.objectContaining({
        vendorId: 10, creditLedgerEntryId: 1, reversalLedgerEntryId: 2, reversalCents: 5_000,
        availableBalanceAfterCents: -3_000, vendorPaused: true, standingRevision: 1, idempotentReplay: false,
      }),
    });

    // A replayed webhook finds the reversal, moves nothing, pauses nobody, and says nothing more.
    const replay = await service.recordWalletFundingReversal(dispute);
    expect(replay).toEqual({
      outcome: "reversed", vendorId: 10, reversalLedgerEntryId: 2, reversalCents: 5_000,
      availableBalanceAfterCents: -3_000, vendorPaused: false, idempotentReplay: true,
    });
    expect(repository.ledger).toHaveLength(2);
    expect(repository.account.availableBalanceCents).toBe(-3_000);
    expect(standing.announceCalls).toHaveLength(1);
    expect(notificationSender.sent).toEqual([]);
  });

  it("takes back no more than the credit put in, and tells the vendor itself when no pause goes out", async () => {
    // The vendor is still onboarding: nothing to pause, so the wallet's own notice carries the news.
    const result = await service.recordWalletFundingReversal({ ...dispute, amountCents: 5_150 });

    expect(result).toMatchObject({ outcome: "reversed", reversalCents: 5_000, availableBalanceAfterCents: -3_000, vendorPaused: false });
    expect(repository.vendorStatus).toBe("onboarding");
    expect(standing.announceCalls).toEqual([]);
    expect(notificationSender.sent).toEqual([expect.objectContaining({
      vendorId: 10,
      eventType: "dropship_wallet_funding_reversed",
      critical: true,
      title: "A payment to your wallet was reversed",
      idempotencyKey: "stripe-dispute-reversed:dp_1",
      payload: expect.objectContaining({
        providerDisputeId: "dp_1", creditLedgerEntryId: 1, reversalLedgerEntryId: 2, reversalCents: 5_000, availableBalanceAfterCents: -3_000,
      }),
    })]);
    expect(notificationSender.sent[0].message).toBe(
      "Your bank reversed USD $50.00 that you added on May 1, 2026. That amount has been taken back out of your wallet, leaving USD -$30.00. Your wallet is below zero until funds are added; the daily wallet run collects the shortfall from your saved funding source when one is set up.",
    );
  });

  it("falls back to its own notice when the pause cannot be announced", async () => {
    repository.vendorStatus = "active";
    standing.announceError = new Error("standing db down");

    const result = await service.recordWalletFundingReversal(dispute);

    expect(result).toMatchObject({ outcome: "reversed", vendorPaused: true });
    expect(repository.vendorStatus).toBe("paused");
    expect(logs.find((entry) => entry.code === "DROPSHIP_VENDOR_PAUSE_ANNOUNCE_FAILED")).toMatchObject({ level: "error" });
    expect(notificationSender.sent.map((sent) => sent.eventType)).toEqual(["dropship_wallet_funding_reversed"]);
  });

  it("moves nothing for an inquiry that has not withdrawn funds, or a dispute on a payment the wallet never recorded", async () => {
    expect(await service.recordWalletFundingReversal({ ...dispute, status: "warning_needs_response", fundsWithdrawn: false }))
      .toEqual({ outcome: "deferred" });
    expect(repository.reverseInputs).toEqual([]);
    expect(logs).toEqual([expect.objectContaining({ level: "info", code: "DROPSHIP_WALLET_FUNDING_DISPUTE_OPENED" })]);

    expect(await service.recordWalletFundingReversal({ ...dispute, providerPaymentIntentId: "pi_other_product" }))
      .toEqual({ outcome: "not_applicable" });
    expect(logs.at(-1)).toMatchObject({
      level: "info",
      code: "DROPSHIP_WALLET_FUNDING_DISPUTE_UNMATCHED",
      context: expect.objectContaining({ providerPaymentIntentId: "pi_other_product" }),
    });

    expect(repository.ledger).toHaveLength(1);
    expect(repository.account.availableBalanceCents).toBe(2_000);
    expect(notificationSender.sent).toEqual([]);
    expect(standing.announceCalls).toEqual([]);
  });

  it("refuses to reverse a credit that never settled or one in another currency, and flags it for a human", async () => {
    await service.creditFunding({
      vendorId: 10, fundingMethodId: 100, rail: "stripe_ach", status: "pending", amountCents: 4_000, currency: "USD",
      referenceType: "stripe_payment_intent", referenceId: "pi_ach_1", idempotencyKey: "funding-pi-ach-1",
    });
    logs = [];

    expect(await service.recordWalletFundingReversal({ ...dispute, providerPaymentIntentId: "pi_ach_1", amountCents: 4_000 }))
      .toEqual({ outcome: "ignored", reason: "credit_not_settled" });
    expect(logs.at(-1)).toMatchObject({
      level: "warn",
      code: "DROPSHIP_WALLET_FUNDING_REVERSAL_IGNORED",
      context: expect.objectContaining({ vendorId: 10, creditLedgerEntryId: 2, creditStatus: "pending", reason: "credit_not_settled" }),
    });
    expect(await service.recordWalletFundingReversal({ ...dispute, currency: "EUR" })).toEqual({ outcome: "ignored", reason: "currency_mismatch" });

    expect(repository.ledger).toHaveLength(2);
    expect(repository.account).toMatchObject({ availableBalanceCents: 2_000, pendingBalanceCents: 4_000 });
    expect(notificationSender.sent).toEqual([]);
  });

  it("credits a reversal back when the dispute is won, asks standing whether the vendor can resume, and tells them", async () => {
    repository.vendorStatus = "active";
    await service.recordWalletFundingReversal(dispute);
    logs = [];
    notificationSender.sent = [];

    const result = await service.recordWalletFundingDisputeOutcome(won);

    expect(result).toEqual({
      outcome: "reinstated", vendorId: 10, reinstatementLedgerEntryId: 3, amountCents: 5_000, availableBalanceAfterCents: 2_000, idempotentReplay: false,
    });
    expect(repository.account.availableBalanceCents).toBe(2_000);
    expect(repository.ledger[2]).toMatchObject({
      type: "funding_reinstated", status: "settled", amountCents: 5_000, availableBalanceAfterCents: 2_000,
      referenceType: "stripe_dispute_reinstated", referenceId: "dp_1", idempotencyKey: "stripe-dispute-reinstated:dp_1", fundingMethodId: 99,
    });
    expect(repository.reinstateInputs).toEqual([{ provider: "stripe", providerDisputeId: "dp_1", providerEventId: "evt_dp_2", occurredAt: now }]);
    expect(standing.restoreCalls).toEqual([{
      vendorId: 10,
      evidence: expect.objectContaining({ source: "dispute_webhook", providerDisputeId: "dp_1", reinstatementLedgerEntryId: 3 }),
    }]);
    expect(notificationSender.sent).toEqual([expect.objectContaining({
      vendorId: 10,
      eventType: "dropship_wallet_funding_reinstated",
      critical: false,
      title: "A reversed payment was returned to your wallet",
      idempotencyKey: "stripe-dispute-reinstated:dp_1",
      payload: expect.objectContaining({ reversalLedgerEntryId: 2, reinstatementLedgerEntryId: 3, amountCents: 5_000, availableBalanceAfterCents: 2_000 }),
    })]);
    expect(notificationSender.sent[0].message).toBe(
      "The dispute on USD $50.00 you added was resolved in your favour, and that amount is back in your wallet, leaving USD $20.00.",
    );
    expect(logs.find((entry) => entry.code === "DROPSHIP_WALLET_FUNDING_REINSTATED")).toMatchObject({
      level: "info",
      context: expect.objectContaining({ reversalLedgerEntryId: 2, reinstatementLedgerEntryId: 3, amountCents: 5_000, idempotentReplay: false }),
    });

    // A replay credits nothing more and asks nobody anything.
    expect(await service.recordWalletFundingDisputeOutcome(won)).toEqual({
      outcome: "reinstated", vendorId: 10, reinstatementLedgerEntryId: 3, amountCents: 5_000, availableBalanceAfterCents: 2_000, idempotentReplay: true,
    });
    expect(repository.ledger).toHaveLength(3);
    expect(standing.restoreCalls).toHaveLength(1);
    expect(notificationSender.sent).toHaveLength(1);
  });

  it("leaves a lost dispute where it is, logs a closed inquiry as unchanged, and credits nothing for a win with no reversal on file", async () => {
    expect(await service.recordWalletFundingDisputeOutcome({ ...won, status: "lost", fundsReinstated: false })).toEqual({ outcome: "unchanged" });
    expect(logs.at(-1)).toMatchObject({ level: "warn", code: "DROPSHIP_WALLET_FUNDING_DISPUTE_LOST" });

    expect(await service.recordWalletFundingDisputeOutcome({ ...won, status: "warning_closed", fundsReinstated: false })).toEqual({ outcome: "unchanged" });
    expect(logs.at(-1)).toMatchObject({ level: "info", code: "DROPSHIP_WALLET_FUNDING_DISPUTE_UNCHANGED" });

    expect(await service.recordWalletFundingDisputeOutcome({ ...won, providerDisputeId: "dp_unknown" })).toEqual({ outcome: "not_applicable" });
    expect(logs.at(-1)).toMatchObject({ level: "info", code: "DROPSHIP_WALLET_FUNDING_REINSTATEMENT_UNMATCHED" });

    expect(repository.reinstateInputs).toHaveLength(1);
    expect(repository.ledger).toHaveLength(1);
    expect(standing.restoreCalls).toEqual([]);
    expect(notificationSender.sent).toEqual([]);
  });

  it("rejects malformed dispute input before touching anything", async () => {
    for (const bad of [
      { ...dispute, amountCents: -1 },
      { ...dispute, amountCents: 12.5 },
      { ...dispute, status: "chargeback" },
      { ...dispute, fundsWithdrawn: "yes" },
      { ...dispute, extra: true },
    ]) {
      await expect(service.recordWalletFundingReversal(bad)).rejects.toMatchObject({ code: "DROPSHIP_WALLET_INVALID_INPUT" });
    }
    await expect(service.recordWalletFundingDisputeOutcome({ ...won, fundsReinstated: undefined }))
      .rejects.toMatchObject({ code: "DROPSHIP_WALLET_INVALID_INPUT" });
    expect(repository.reverseInputs).toEqual([]);
    expect(repository.reinstateInputs).toEqual([]);
    expect(logs).toEqual([]);
  });
});
