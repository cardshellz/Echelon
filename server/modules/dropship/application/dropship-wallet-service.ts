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
    status: input.status,
    amountCents: input.amountCents,
    currency: input.currency,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    externalTransactionId: input.externalTransactionId ?? null,
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
