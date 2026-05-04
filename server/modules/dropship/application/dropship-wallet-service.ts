import { createHash } from "crypto";
import { z } from "zod";
import {
  CentsSchema,
  CurrencyCodeSchema,
  PositiveCentsSchema,
} from "../../../../shared/validation/currency";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipVendorProvisioningService,
} from "./dropship-vendor-provisioning-service";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const jsonObjectSchema = z.record(z.unknown());

export const dropshipWalletFundingRailSchema = z.enum([
  "stripe_ach",
  "stripe_card",
  "usdc_base",
  "manual",
]);
export type DropshipWalletFundingRail = z.infer<typeof dropshipWalletFundingRailSchema>;

export const dropshipStripeFundingSetupRailSchema = z.enum(["stripe_ach", "stripe_card"]);
export type DropshipStripeFundingSetupRail = z.infer<typeof dropshipStripeFundingSetupRailSchema>;

export const dropshipWalletLedgerStatusSchema = z.enum([
  "pending",
  "settled",
  "failed",
  "voided",
]);
export type DropshipWalletLedgerStatus = z.infer<typeof dropshipWalletLedgerStatusSchema>;

export const dropshipWalletLedgerTypeSchema = z.enum([
  "funding",
  "order_debit",
  "refund_credit",
  "return_credit",
  "return_fee",
  "insurance_pool_credit",
  "manual_adjustment",
]);
export type DropshipWalletLedgerType = z.infer<typeof dropshipWalletLedgerTypeSchema>;

export const creditDropshipWalletFundingInputSchema = z.object({
  vendorId: positiveIdSchema,
  walletAccountId: positiveIdSchema.optional(),
  fundingMethodId: positiveIdSchema.optional(),
  rail: dropshipWalletFundingRailSchema,
  status: z.enum(["pending", "settled"]),
  amountCents: PositiveCentsSchema,
  currency: CurrencyCodeSchema.default("USD"),
  referenceType: z.string().trim().min(1).max(80),
  referenceId: z.string().trim().min(1).max(255),
  externalTransactionId: z.string().trim().min(1).max(255).optional(),
  metadata: jsonObjectSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const debitDropshipWalletForOrderInputSchema = z.object({
  vendorId: positiveIdSchema,
  walletAccountId: positiveIdSchema.optional(),
  intakeId: positiveIdSchema,
  amountCents: PositiveCentsSchema,
  currency: CurrencyCodeSchema.default("USD"),
  metadata: jsonObjectSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const configureDropshipAutoReloadInputSchema = z.object({
  vendorId: positiveIdSchema,
  fundingMethodId: positiveIdSchema.nullable(),
  enabled: z.boolean(),
  minimumBalanceCents: CentsSchema,
  maxSingleReloadCents: CentsSchema.nullable(),
  paymentHoldTimeoutMinutes: z.number().int().positive().max(60 * 24 * 30),
}).strict();

export const createDropshipStripeFundingSetupSessionInputSchema = z.object({
  rail: dropshipStripeFundingSetupRailSchema,
  successUrl: z.string().trim().url().max(1000),
  cancelUrl: z.string().trim().url().max(1000),
}).strict();

export const createDropshipStripeWalletFundingSessionInputSchema = z.object({
  fundingMethodId: positiveIdSchema,
  amountCents: PositiveCentsSchema,
  successUrl: z.string().trim().url().max(1000),
  cancelUrl: z.string().trim().url().max(1000),
}).strict();

export const creditDropshipWalletManualFundingInputSchema = z.object({
  vendorId: positiveIdSchema,
  amountCents: PositiveCentsSchema,
  currency: CurrencyCodeSchema.default("USD"),
  reason: z.string().trim().min(1).max(1000),
  idempotencyKey: idempotencyKeySchema,
  actor: z.object({
    actorType: z.enum(["admin", "system"]),
    actorId: z.string().trim().min(1).max(255).optional(),
  }).strict(),
}).strict();

export const handleDropshipAutoReloadInputSchema = z.object({
  vendorId: positiveIdSchema,
  reason: z.enum(["minimum_balance", "payment_hold"]),
  requiredBalanceCents: PositiveCentsSchema.optional(),
  intakeId: positiveIdSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine((input, context) => {
  if (input.reason === "payment_hold" && !input.requiredBalanceCents) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requiredBalanceCents"],
      message: "Payment hold auto-reload requires the required order balance.",
    });
  }
  if (input.reason === "payment_hold" && !input.intakeId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["intakeId"],
      message: "Payment hold auto-reload requires the intake id.",
    });
  }
});

export const registerDropshipFundingMethodInputSchema = z.object({
  vendorId: positiveIdSchema,
  rail: dropshipWalletFundingRailSchema,
  status: z.enum(["active", "setup_pending", "archived", "failed"]).default("active"),
  providerCustomerId: z.string().trim().min(1).max(255).nullable(),
  providerPaymentMethodId: z.string().trim().min(1).max(255).nullable(),
  usdcWalletAddress: z.string().trim().min(1).max(128).nullable().default(null),
  displayLabel: z.string().trim().min(1).max(200).nullable(),
  isDefault: z.boolean().default(false),
  metadata: jsonObjectSchema.optional(),
}).strict().superRefine((input, context) => {
  if ((input.rail === "stripe_ach" || input.rail === "stripe_card") && !input.providerPaymentMethodId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["providerPaymentMethodId"],
      message: "Stripe funding methods require a provider payment method id.",
    });
  }
});

export type CreditDropshipWalletFundingInput = z.infer<typeof creditDropshipWalletFundingInputSchema>;
export type DebitDropshipWalletForOrderInput = z.infer<typeof debitDropshipWalletForOrderInputSchema>;
export type ConfigureDropshipAutoReloadInput = z.infer<typeof configureDropshipAutoReloadInputSchema>;
export type CreateDropshipStripeFundingSetupSessionInput = z.infer<typeof createDropshipStripeFundingSetupSessionInputSchema>;
export type CreateDropshipStripeWalletFundingSessionInput = z.infer<typeof createDropshipStripeWalletFundingSessionInputSchema>;
export type CreditDropshipWalletManualFundingInput = z.infer<typeof creditDropshipWalletManualFundingInputSchema>;
export type HandleDropshipAutoReloadInput = z.infer<typeof handleDropshipAutoReloadInputSchema>;
export type RegisterDropshipFundingMethodInput = z.infer<typeof registerDropshipFundingMethodInputSchema>;

export interface DropshipWalletAccountRecord {
  walletAccountId: number;
  vendorId: number;
  availableBalanceCents: number;
  pendingBalanceCents: number;
  currency: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipFundingMethodRecord {
  fundingMethodId: number;
  vendorId: number;
  rail: DropshipWalletFundingRail;
  status: string;
  providerCustomerId: string | null;
  providerPaymentMethodId: string | null;
  usdcWalletAddress: string | null;
  displayLabel: string | null;
  isDefault: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipAutoReloadSettingRecord {
  autoReloadSettingId: number;
  vendorId: number;
  fundingMethodId: number | null;
  enabled: boolean;
  minimumBalanceCents: number;
  maxSingleReloadCents: number | null;
  paymentHoldTimeoutMinutes: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipWalletLedgerRecord {
  ledgerEntryId: number;
  walletAccountId: number | null;
  vendorId: number;
  type: DropshipWalletLedgerType;
  status: DropshipWalletLedgerStatus;
  amountCents: number;
  currency: string;
  availableBalanceAfterCents: number | null;
  pendingBalanceAfterCents: number | null;
  referenceType: string | null;
  referenceId: string | null;
  idempotencyKey: string | null;
  fundingMethodId: number | null;
  externalTransactionId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  settledAt: Date | null;
}

export interface DropshipWalletOverview {
  account: DropshipWalletAccountRecord;
  autoReload: DropshipAutoReloadSettingRecord | null;
  fundingMethods: DropshipFundingMethodRecord[];
  recentLedger: DropshipWalletLedgerRecord[];
}

export interface DropshipWalletMutationResult {
  account: DropshipWalletAccountRecord;
  ledgerEntry: DropshipWalletLedgerRecord;
  idempotentReplay: boolean;
}

export interface DropshipFundingMethodMutationResult {
  fundingMethod: DropshipFundingMethodRecord;
  idempotentReplay: boolean;
}

export interface DropshipStripeFundingSetupSession {
  checkoutUrl: string;
  providerSessionId: string;
  providerCustomerId: string;
  expiresAt: Date | null;
}

export interface DropshipStripeWalletFundingSession {
  checkoutUrl: string;
  providerSessionId: string;
  providerCustomerId: string;
  amountCents: number;
  currency: string;
  expiresAt: Date | null;
}

export interface DropshipStripeAutoReloadPaymentIntent {
  providerPaymentIntentId: string;
  status: Extract<DropshipWalletLedgerStatus, "pending" | "settled">;
  amountCents: number;
  currency: string;
  externalTransactionId: string | null;
}

export interface DropshipAutoReloadResult {
  outcome: "funding_created" | "skipped";
  vendorId: number;
  fundingMethodId: number | null;
  amountCents: number;
  currency: string;
  providerPaymentIntentId: string | null;
  fundingLedgerEntryId: number | null;
  fundingStatus: Extract<DropshipWalletLedgerStatus, "pending" | "settled"> | null;
  skipReason: string | null;
  idempotentReplay: boolean;
}

export interface DropshipWalletFundingProvider {
  createStripeSetupSession(input: {
    vendorId: number;
    memberId: string;
    rail: DropshipStripeFundingSetupRail;
    customerEmail: string | null;
    customerName: string;
    existingProviderCustomerId: string | null;
    successUrl: string;
    cancelUrl: string;
    now: Date;
  }): Promise<DropshipStripeFundingSetupSession>;
  createStripeWalletFundingSession(input: {
    vendorId: number;
    memberId: string;
    fundingMethodId: number;
    rail: DropshipStripeFundingSetupRail;
    amountCents: number;
    currency: string;
    customerEmail: string | null;
    customerName: string;
    existingProviderCustomerId: string | null;
    providerPaymentMethodId: string | null;
    successUrl: string;
    cancelUrl: string;
    now: Date;
  }): Promise<DropshipStripeWalletFundingSession>;
  createStripeAutoReloadPaymentIntent(input: {
    vendorId: number;
    fundingMethodId: number;
    rail: DropshipStripeFundingSetupRail;
    amountCents: number;
    currency: string;
    providerCustomerId: string;
    providerPaymentMethodId: string;
    reason: HandleDropshipAutoReloadInput["reason"];
    intakeId: number | null;
    requiredBalanceCents: number | null;
    idempotencyKey: string;
    now: Date;
  }): Promise<DropshipStripeAutoReloadPaymentIntent>;
}

export interface DropshipWalletRepository {
  getOrCreateWalletAccount(input: {
    vendorId: number;
    currency: string;
    now: Date;
  }): Promise<DropshipWalletAccountRecord>;

  getOverview(input: {
    vendorId: number;
    ledgerLimit: number;
    now: Date;
  }): Promise<DropshipWalletOverview>;

  creditFunding(input: CreateDropshipWalletFundingLedgerInput): Promise<DropshipWalletMutationResult>;
  debitOrder(input: CreateDropshipWalletOrderDebitInput): Promise<DropshipWalletMutationResult>;
  configureAutoReload(input: ConfigureDropshipAutoReloadRepositoryInput): Promise<DropshipAutoReloadSettingRecord>;
  getReusableFundingProviderCustomerId(input: {
    vendorId: number;
    provider: "stripe";
  }): Promise<string | null>;
  upsertFundingMethod(input: UpsertDropshipFundingMethodRepositoryInput): Promise<DropshipFundingMethodMutationResult>;
}

export type CreateDropshipWalletFundingLedgerInput = Omit<CreditDropshipWalletFundingInput, "walletAccountId"> & {
  walletAccountId: number | null;
  requestHash: string;
  occurredAt: Date;
};

export type CreateDropshipWalletOrderDebitInput = Omit<DebitDropshipWalletForOrderInput, "walletAccountId"> & {
  walletAccountId: number | null;
  requestHash: string;
  occurredAt: Date;
};

export interface ConfigureDropshipAutoReloadRepositoryInput extends ConfigureDropshipAutoReloadInput {
  updatedAt: Date;
}

export interface UpsertDropshipFundingMethodRepositoryInput extends RegisterDropshipFundingMethodInput {
  updatedAt: Date;
}

export class DropshipWalletService {
  constructor(
    private readonly deps: {
      vendorProvisioning: DropshipVendorProvisioningService;
      repository: DropshipWalletRepository;
      fundingProvider?: DropshipWalletFundingProvider;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async getWalletForMember(
    memberId: string,
    input: { ledgerLimit?: number } = {},
  ): Promise<DropshipWalletOverview> {
    const vendor = await this.provisionVendor(memberId);
    return this.deps.repository.getOverview({
      vendorId: vendor.vendor.vendorId,
      ledgerLimit: clampLedgerLimit(input.ledgerLimit),
      now: this.deps.clock.now(),
    });
  }

  async getWalletForVendor(
    vendorId: number,
    input: { ledgerLimit?: number } = {},
  ): Promise<DropshipWalletOverview> {
    return this.deps.repository.getOverview({
      vendorId,
      ledgerLimit: clampLedgerLimit(input.ledgerLimit),
      now: this.deps.clock.now(),
    });
  }

  async creditFunding(input: unknown): Promise<DropshipWalletMutationResult> {
    const parsed = parseWalletInput(creditDropshipWalletFundingInputSchema, input);
    const occurredAt = this.deps.clock.now();
    const requestHash = hashWalletFundingCreditRequest(parsed);
    const result = await this.deps.repository.creditFunding({
      ...parsed,
      walletAccountId: parsed.walletAccountId ?? null,
      requestHash,
      occurredAt,
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_WALLET_FUNDING_CREDITED",
        message: "Dropship wallet funding ledger entry was recorded.",
        context: {
          vendorId: parsed.vendorId,
          walletAccountId: result.account.walletAccountId,
          ledgerEntryId: result.ledgerEntry.ledgerEntryId,
          amountCents: parsed.amountCents,
          status: parsed.status,
          rail: parsed.rail,
        },
      });
    }
    return result;
  }

  async debitForOrder(input: unknown): Promise<DropshipWalletMutationResult> {
    const parsed = parseWalletInput(debitDropshipWalletForOrderInputSchema, input);
    const occurredAt = this.deps.clock.now();
    const requestHash = hashWalletOrderDebitRequest(parsed);
    const result = await this.deps.repository.debitOrder({
      ...parsed,
      walletAccountId: parsed.walletAccountId ?? null,
      requestHash,
      occurredAt,
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_WALLET_ORDER_DEBITED",
        message: "Dropship wallet was debited for an accepted order.",
        context: {
          vendorId: parsed.vendorId,
          walletAccountId: result.account.walletAccountId,
          intakeId: parsed.intakeId,
          ledgerEntryId: result.ledgerEntry.ledgerEntryId,
          amountCents: parsed.amountCents,
        },
      });
    }
    return result;
  }

  async configureAutoReload(input: unknown): Promise<DropshipAutoReloadSettingRecord> {
    const parsed = parseWalletInput(configureDropshipAutoReloadInputSchema, input);
    assertAutoReloadConfigIsUsable(parsed);
    const updatedAt = this.deps.clock.now();
    const setting = await this.deps.repository.configureAutoReload({
      ...parsed,
      updatedAt,
    });
    this.deps.logger.info({
      code: "DROPSHIP_AUTO_RELOAD_CONFIGURED",
      message: "Dropship auto-reload settings were configured.",
      context: {
        vendorId: parsed.vendorId,
        enabled: parsed.enabled,
        fundingMethodId: parsed.fundingMethodId,
        minimumBalanceCents: parsed.minimumBalanceCents,
        maxSingleReloadCents: parsed.maxSingleReloadCents,
      },
    });
    return setting;
  }

  async creditManualFunding(input: unknown): Promise<DropshipWalletMutationResult> {
    const parsed = parseWalletInput(creditDropshipWalletManualFundingInputSchema, input);
    const result = await this.creditFunding({
      vendorId: parsed.vendorId,
      rail: "manual",
      status: "settled",
      amountCents: parsed.amountCents,
      currency: parsed.currency,
      referenceType: "admin_manual_wallet_credit",
      referenceId: parsed.idempotencyKey,
      metadata: {
        reason: parsed.reason,
        actorType: parsed.actor.actorType,
        actorId: parsed.actor.actorId ?? null,
      },
      idempotencyKey: parsed.idempotencyKey,
    });
    this.deps.logger.info({
      code: "DROPSHIP_WALLET_MANUAL_FUNDING_CREDITED",
      message: "Dropship wallet was credited by an admin manual funding event.",
      context: {
        vendorId: parsed.vendorId,
        walletAccountId: result.account.walletAccountId,
        ledgerEntryId: result.ledgerEntry.ledgerEntryId,
        amountCents: parsed.amountCents,
        idempotentReplay: result.idempotentReplay,
        actorType: parsed.actor.actorType,
        actorId: parsed.actor.actorId ?? null,
      },
    });
    return result;
  }

  async createStripeFundingSetupSessionForMember(
    memberId: string,
    input: unknown,
  ): Promise<DropshipStripeFundingSetupSession> {
    const parsed = parseWalletInput(createDropshipStripeFundingSetupSessionInputSchema, input);
    const provider = this.deps.fundingProvider;
    if (!provider) {
      throw new DropshipError(
        "DROPSHIP_FUNDING_PROVIDER_NOT_CONFIGURED",
        "Dropship funding provider is not configured.",
        { provider: "stripe" },
      );
    }

    const provisioned = await this.provisionVendor(memberId);
    const vendor = provisioned.vendor;
    const now = this.deps.clock.now();
    const existingProviderCustomerId = await this.deps.repository.getReusableFundingProviderCustomerId({
      vendorId: vendor.vendorId,
      provider: "stripe",
    });
    const session = await provider.createStripeSetupSession({
      vendorId: vendor.vendorId,
      memberId,
      rail: parsed.rail,
      customerEmail: vendor.email,
      customerName: vendor.businessName ?? vendor.contactName ?? vendor.email ?? `Dropship vendor ${vendor.vendorId}`,
      existingProviderCustomerId,
      successUrl: parsed.successUrl,
      cancelUrl: parsed.cancelUrl,
      now,
    });
    this.deps.logger.info({
      code: "DROPSHIP_STRIPE_FUNDING_SETUP_SESSION_CREATED",
      message: "Dropship Stripe funding setup session was created.",
      context: {
        vendorId: vendor.vendorId,
        rail: parsed.rail,
        providerSessionId: session.providerSessionId,
      },
    });
    return session;
  }

  async createStripeWalletFundingSessionForMember(
    memberId: string,
    input: unknown,
  ): Promise<DropshipStripeWalletFundingSession> {
    const parsed = parseWalletInput(createDropshipStripeWalletFundingSessionInputSchema, input);
    const provider = this.deps.fundingProvider;
    if (!provider) {
      throw new DropshipError(
        "DROPSHIP_FUNDING_PROVIDER_NOT_CONFIGURED",
        "Dropship funding provider is not configured.",
        { provider: "stripe" },
      );
    }

    assertStripeWalletFundingAmount(parsed.amountCents);
    const provisioned = await this.provisionVendor(memberId);
    const vendor = provisioned.vendor;
    const wallet = await this.deps.repository.getOverview({
      vendorId: vendor.vendorId,
      ledgerLimit: 1,
      now: this.deps.clock.now(),
    });
    const fundingMethod = wallet.fundingMethods.find((method) => method.fundingMethodId === parsed.fundingMethodId);
    if (!fundingMethod) {
      throw new DropshipError(
        "DROPSHIP_FUNDING_METHOD_NOT_FOUND",
        "Dropship funding method was not found.",
        { vendorId: vendor.vendorId, fundingMethodId: parsed.fundingMethodId },
      );
    }
    if (fundingMethod.status !== "active") {
      throw new DropshipError(
        "DROPSHIP_FUNDING_METHOD_NOT_ACTIVE",
        "Dropship funding method is not active.",
        { vendorId: vendor.vendorId, fundingMethodId: parsed.fundingMethodId, status: fundingMethod.status },
      );
    }
    if (fundingMethod.rail !== "stripe_card" && fundingMethod.rail !== "stripe_ach") {
      throw new DropshipError(
        "DROPSHIP_FUNDING_METHOD_RAIL_UNSUPPORTED",
        "Dropship wallet funding currently requires a Stripe card or ACH funding method.",
        { vendorId: vendor.vendorId, fundingMethodId: parsed.fundingMethodId, rail: fundingMethod.rail },
      );
    }
    if (!fundingMethod.providerCustomerId) {
      throw new DropshipError(
        "DROPSHIP_FUNDING_METHOD_PROVIDER_CUSTOMER_REQUIRED",
        "Stripe wallet funding requires a provider customer id.",
        { vendorId: vendor.vendorId, fundingMethodId: parsed.fundingMethodId },
      );
    }

    const now = this.deps.clock.now();
    const session = await provider.createStripeWalletFundingSession({
      vendorId: vendor.vendorId,
      memberId,
      fundingMethodId: fundingMethod.fundingMethodId,
      rail: fundingMethod.rail,
      amountCents: parsed.amountCents,
      currency: wallet.account.currency,
      customerEmail: vendor.email,
      customerName: vendor.businessName ?? vendor.contactName ?? vendor.email ?? `Dropship vendor ${vendor.vendorId}`,
      existingProviderCustomerId: fundingMethod.providerCustomerId,
      providerPaymentMethodId: fundingMethod.providerPaymentMethodId,
      successUrl: parsed.successUrl,
      cancelUrl: parsed.cancelUrl,
      now,
    });
    this.deps.logger.info({
      code: "DROPSHIP_STRIPE_WALLET_FUNDING_SESSION_CREATED",
      message: "Dropship Stripe wallet funding session was created.",
      context: {
        vendorId: vendor.vendorId,
        fundingMethodId: fundingMethod.fundingMethodId,
        amountCents: parsed.amountCents,
        rail: fundingMethod.rail,
        providerSessionId: session.providerSessionId,
      },
    });
    return session;
  }

  async handleAutoReload(input: unknown): Promise<DropshipAutoReloadResult> {
    const parsed = parseWalletInput(handleDropshipAutoReloadInputSchema, input);
    const provider = this.deps.fundingProvider;
    if (!provider) {
      return skippedAutoReload(parsed, "funding_provider_not_configured", "USD");
    }

    const now = this.deps.clock.now();
    const wallet = await this.deps.repository.getOverview({
      vendorId: parsed.vendorId,
      ledgerLimit: 1,
      now,
    });
    const setting = wallet.autoReload;
    if (!setting?.enabled) {
      return skippedAutoReload(parsed, "auto_reload_disabled", wallet.account.currency);
    }
    if (!setting.fundingMethodId) {
      return skippedAutoReload(parsed, "funding_method_required", wallet.account.currency);
    }

    const fundingMethod = wallet.fundingMethods.find((method) => method.fundingMethodId === setting.fundingMethodId);
    if (!fundingMethod) {
      return skippedAutoReload(parsed, "funding_method_missing", wallet.account.currency, setting.fundingMethodId);
    }
    if (fundingMethod.status !== "active") {
      return skippedAutoReload(parsed, "funding_method_not_active", wallet.account.currency, fundingMethod.fundingMethodId);
    }
    if (fundingMethod.rail !== "stripe_card" && fundingMethod.rail !== "stripe_ach") {
      return skippedAutoReload(parsed, "funding_method_rail_unsupported", wallet.account.currency, fundingMethod.fundingMethodId);
    }
    if (!fundingMethod.providerCustomerId || !fundingMethod.providerPaymentMethodId) {
      return skippedAutoReload(parsed, "funding_method_provider_identity_required", wallet.account.currency, fundingMethod.fundingMethodId);
    }

    const amount = calculateAutoReloadAmount({
      availableBalanceCents: wallet.account.availableBalanceCents,
      minimumBalanceCents: setting.minimumBalanceCents,
      maxSingleReloadCents: setting.maxSingleReloadCents,
      requiredBalanceCents: parsed.requiredBalanceCents ?? null,
      reason: parsed.reason,
    });
    if (amount.outcome === "skipped") {
      return skippedAutoReload(parsed, amount.skipReason, wallet.account.currency, fundingMethod.fundingMethodId);
    }

    const paymentIntent = await provider.createStripeAutoReloadPaymentIntent({
      vendorId: parsed.vendorId,
      fundingMethodId: fundingMethod.fundingMethodId,
      rail: fundingMethod.rail,
      amountCents: amount.amountCents,
      currency: wallet.account.currency,
      providerCustomerId: fundingMethod.providerCustomerId,
      providerPaymentMethodId: fundingMethod.providerPaymentMethodId,
      reason: parsed.reason,
      intakeId: parsed.intakeId ?? null,
      requiredBalanceCents: parsed.requiredBalanceCents ?? null,
      idempotencyKey: `dropship-auto-reload:${parsed.idempotencyKey}`,
      now,
    });
    const funding = await this.creditFunding({
      vendorId: parsed.vendorId,
      fundingMethodId: fundingMethod.fundingMethodId,
      rail: fundingMethod.rail,
      status: paymentIntent.status,
      amountCents: paymentIntent.amountCents,
      currency: paymentIntent.currency,
      referenceType: "stripe_payment_intent",
      referenceId: paymentIntent.providerPaymentIntentId,
      externalTransactionId: paymentIntent.externalTransactionId ?? undefined,
      metadata: {
        provider: "stripe",
        autoReload: true,
        autoReloadReason: parsed.reason,
        intakeId: parsed.intakeId ?? null,
        requiredBalanceCents: parsed.requiredBalanceCents ?? null,
      },
      idempotencyKey: `stripe-funding:${paymentIntent.providerPaymentIntentId}`,
    });

    this.deps.logger.info({
      code: "DROPSHIP_AUTO_RELOAD_FUNDING_CREATED",
      message: "Dropship wallet auto-reload funding was created.",
      context: {
        vendorId: parsed.vendorId,
        fundingMethodId: fundingMethod.fundingMethodId,
        amountCents: paymentIntent.amountCents,
        status: paymentIntent.status,
        reason: parsed.reason,
        intakeId: parsed.intakeId ?? null,
        providerPaymentIntentId: paymentIntent.providerPaymentIntentId,
        ledgerEntryId: funding.ledgerEntry.ledgerEntryId,
        idempotentReplay: funding.idempotentReplay,
      },
    });

    return {
      outcome: "funding_created",
      vendorId: parsed.vendorId,
      fundingMethodId: fundingMethod.fundingMethodId,
      amountCents: paymentIntent.amountCents,
      currency: paymentIntent.currency,
      providerPaymentIntentId: paymentIntent.providerPaymentIntentId,
      fundingLedgerEntryId: funding.ledgerEntry.ledgerEntryId,
      fundingStatus: paymentIntent.status,
      skipReason: null,
      idempotentReplay: funding.idempotentReplay,
    };
  }

  async registerFundingMethod(input: unknown): Promise<DropshipFundingMethodMutationResult> {
    const parsed = parseWalletInput(registerDropshipFundingMethodInputSchema, input);
    const updatedAt = this.deps.clock.now();
    const result = await this.deps.repository.upsertFundingMethod({
      ...parsed,
      updatedAt,
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_FUNDING_METHOD_REGISTERED",
        message: "Dropship funding method was registered.",
        context: {
          vendorId: parsed.vendorId,
          fundingMethodId: result.fundingMethod.fundingMethodId,
          rail: parsed.rail,
          status: parsed.status,
        },
      });
    }
    return result;
  }

  private async provisionVendor(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    return this.deps.vendorProvisioning.provisionForMember(memberId);
  }
}

function calculateAutoReloadAmount(input: {
  availableBalanceCents: number;
  minimumBalanceCents: number;
  maxSingleReloadCents: number | null;
  requiredBalanceCents: number | null;
  reason: HandleDropshipAutoReloadInput["reason"];
}): { outcome: "funding_created"; amountCents: number } | { outcome: "skipped"; skipReason: string } {
  const targetBalanceCents = input.reason === "payment_hold"
    ? Math.max(input.minimumBalanceCents, input.requiredBalanceCents ?? 0)
    : input.minimumBalanceCents;
  const amountNeededCents = targetBalanceCents - input.availableBalanceCents;
  if (amountNeededCents <= 0) {
    return { outcome: "skipped", skipReason: "balance_already_sufficient" };
  }
  if (input.maxSingleReloadCents !== null && amountNeededCents > input.maxSingleReloadCents) {
    return { outcome: "skipped", skipReason: "amount_exceeds_max_single_reload" };
  }
  return { outcome: "funding_created", amountCents: amountNeededCents };
}

function skippedAutoReload(
  input: HandleDropshipAutoReloadInput,
  skipReason: string,
  currency: string,
  fundingMethodId: number | null = null,
): DropshipAutoReloadResult {
  return {
    outcome: "skipped",
    vendorId: input.vendorId,
    fundingMethodId,
    amountCents: 0,
    currency,
    providerPaymentIntentId: null,
    fundingLedgerEntryId: null,
    fundingStatus: null,
    skipReason,
    idempotentReplay: false,
  };
}

const DEFAULT_STRIPE_MIN_WALLET_FUNDING_CENTS = 1000;
const DEFAULT_STRIPE_MAX_WALLET_FUNDING_CENTS = 500000;

function assertStripeWalletFundingAmount(amountCents: number): void {
  const minCents = parsePositiveEnvInteger(
    process.env.DROPSHIP_STRIPE_MIN_WALLET_FUNDING_CENTS,
    DEFAULT_STRIPE_MIN_WALLET_FUNDING_CENTS,
  );
  const maxCents = parsePositiveEnvInteger(
    process.env.DROPSHIP_STRIPE_MAX_WALLET_FUNDING_CENTS,
    DEFAULT_STRIPE_MAX_WALLET_FUNDING_CENTS,
  );
  if (minCents > maxCents) {
    throw new DropshipError(
      "DROPSHIP_WALLET_FUNDING_LIMITS_INVALID",
      "Dropship wallet funding limits are misconfigured.",
      { minCents, maxCents },
    );
  }
  if (amountCents < minCents || amountCents > maxCents) {
    throw new DropshipError(
      "DROPSHIP_WALLET_FUNDING_AMOUNT_OUT_OF_RANGE",
      "Dropship wallet funding amount is outside the configured range.",
      { amountCents, minCents, maxCents },
    );
  }
}

function parsePositiveEnvInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertAutoReloadConfigIsUsable(input: ConfigureDropshipAutoReloadInput): void {
  if (!input.enabled) {
    return;
  }

  if (!input.fundingMethodId) {
    throw new DropshipError(
      "DROPSHIP_AUTO_RELOAD_FUNDING_METHOD_REQUIRED",
      "Auto-reload requires an active funding method.",
      { vendorId: input.vendorId },
    );
  }

  if (input.minimumBalanceCents <= 0) {
    throw new DropshipError(
      "DROPSHIP_AUTO_RELOAD_INVALID_LIMITS",
      "Auto-reload minimum balance must be greater than zero when enabled.",
      { vendorId: input.vendorId, minimumBalanceCents: input.minimumBalanceCents },
    );
  }

  if (input.maxSingleReloadCents !== null && input.maxSingleReloadCents <= 0) {
    throw new DropshipError(
      "DROPSHIP_AUTO_RELOAD_INVALID_LIMITS",
      "Auto-reload maximum single reload must be greater than zero when provided.",
      { vendorId: input.vendorId, maxSingleReloadCents: input.maxSingleReloadCents },
    );
  }

  if (
    input.maxSingleReloadCents !== null
    && input.maxSingleReloadCents < input.minimumBalanceCents
  ) {
    throw new DropshipError(
      "DROPSHIP_AUTO_RELOAD_INVALID_LIMITS",
      "Auto-reload maximum single reload must be at least the minimum balance.",
      {
        vendorId: input.vendorId,
        minimumBalanceCents: input.minimumBalanceCents,
        maxSingleReloadCents: input.maxSingleReloadCents,
      },
    );
  }
}

export function hashWalletFundingCreditRequest(input: CreditDropshipWalletFundingInput): string {
  return hashWalletRequest({
    vendorId: input.vendorId,
    walletAccountId: input.walletAccountId ?? null,
    fundingMethodId: input.fundingMethodId ?? null,
    rail: input.rail,
    amountCents: input.amountCents,
    currency: input.currency,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
  });
}

export function hashWalletOrderDebitRequest(input: DebitDropshipWalletForOrderInput): string {
  return hashWalletRequest({
    vendorId: input.vendorId,
    walletAccountId: input.walletAccountId ?? null,
    intakeId: input.intakeId,
    amountCents: input.amountCents,
    currency: input.currency,
    referenceType: "order_intake",
    referenceId: String(input.intakeId),
  });
}

export function makeDropshipWalletLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipWalletEvent("info", event),
    warn: (event) => logDropshipWalletEvent("warn", event),
    error: (event) => logDropshipWalletEvent("error", event),
  };
}

export const systemDropshipWalletClock: DropshipClock = {
  now: () => new Date(),
};

function parseWalletInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_WALLET_INVALID_INPUT",
      "Dropship wallet input failed validation.",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

function hashWalletRequest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function clampLedgerLimit(value: number | undefined): number {
  if (value === undefined) return 25;
  if (!Number.isInteger(value) || value <= 0) return 25;
  return Math.min(value, 100);
}

function logDropshipWalletEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.info(payload);
  }
}
