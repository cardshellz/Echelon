import { beforeEach, describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "../../application/dropship-vendor-provisioning-service";
import {
  DropshipWalletService,
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
  type DropshipWalletFundingProvider,
  type DropshipWalletLedgerRecord,
  type DropshipWalletMutationResult,
  type DropshipWalletOverview,
  type DropshipWalletRepository,
  type UpsertDropshipFundingMethodRepositoryInput,
} from "../../application/dropship-wallet-service";

const now = new Date("2026-05-01T20:00:00.000Z");

describe("DropshipWalletService", () => {
  let repository: FakeWalletRepository;
  let logs: DropshipLogEvent[];
  let service: DropshipWalletService;

  beforeEach(() => {
    repository = new FakeWalletRepository();
    logs = [];
    service = new DropshipWalletService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      fundingProvider: new FakeFundingProvider(),
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
    });
  });

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
    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 0,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({ code: "DROPSHIP_AUTO_RELOAD_INVALID_LIMITS" });

    await expect(service.configureAutoReload({
      vendorId: 10,
      fundingMethodId: 99,
      enabled: true,
      minimumBalanceCents: 10000,
      maxSingleReloadCents: 5000,
      paymentHoldTimeoutMinutes: 2880,
    })).rejects.toMatchObject({ code: "DROPSHIP_AUTO_RELOAD_INVALID_LIMITS" });
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

  it("records ACH auto-reload as pending until Stripe settlement", async () => {
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

    expect(result).toMatchObject({
      outcome: "funding_created",
      amountCents: 5000,
      fundingStatus: "pending",
      providerPaymentIntentId: "pi_auto_5000",
    });
    expect(repository.account.availableBalanceCents).toBe(0);
    expect(repository.account.pendingBalanceCents).toBe(5000);
    expect(repository.ledger[0]).toMatchObject({
      status: "pending",
      amountCents: 5000,
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

class FakeFundingProvider implements DropshipWalletFundingProvider {
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
    expect(input.providerPaymentMethodId).toBe("pm_4242");
    return {
      checkoutUrl: "https://checkout.stripe.test/funding",
      providerSessionId: "cs_funding_1",
      providerCustomerId: input.existingProviderCustomerId ?? "cus_created",
      amountCents: input.amountCents,
      currency: input.currency,
      expiresAt: now,
    };
  }

  async createStripeAutoReloadPaymentIntent(
    input: Parameters<DropshipWalletFundingProvider["createStripeAutoReloadPaymentIntent"]>[0],
  ): Promise<DropshipStripeAutoReloadPaymentIntent> {
    expect(input.providerCustomerId).toBe("cus_existing");
    expect(input.providerPaymentMethodId).toMatch(/^pm_/);
    return {
      providerPaymentIntentId: `pi_auto_${input.amountCents}`,
      status: input.rail === "stripe_ach" ? "pending" : "settled",
      amountCents: input.amountCents,
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

class FakeWalletRepository implements DropshipWalletRepository {
  account: DropshipWalletAccountRecord = makeAccount();
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
      },
      createdAt: input.occurredAt,
      settledAt: input.status === "settled" ? input.occurredAt : null,
    });
    return { account: this.account, ledgerEntry, idempotentReplay: false };
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
