import { createHash } from "crypto";
import { z } from "zod";
import {
  CentsSchema,
  CurrencyCodeSchema,
  PositiveCentsSchema,
} from "../../../../shared/validation/currency";
import {
  MAX_CARD_FUNDING_FEE_BPS,
  quoteWalletFunding,
  type WalletFundingQuote,
} from "../../../../shared/dropship/wallet-funding-fee";
import type { DropshipVendorStandingReason, DropshipVendorStatus } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import { standingReasonForFailedFunding } from "../domain/vendor-standing";
import {
  DROPSHIP_DISPUTE_STATUSES,
  DROPSHIP_FUNDING_REVERSAL_STANDING_REASON,
  disputeOutcomeFor,
  type DropshipDisputeStatus,
} from "../domain/funding-reversal";
import { decideAutopayRefill, deriveSingleChargeBoundCents } from "../domain/autopay-refill";
import { usdcAtomicUnitsToCents, type UsdcTransferObservation } from "../domain/usdc-deposits";
import {
  assessAdvanceStanding,
  decideCardBackstopCharge,
  type DropshipAdvanceContext,
  type DropshipAdvanceStanding,
} from "../domain/acceptance-funding";
import {
  fundingMethodFinancialConnectionsAccountId,
  fundingMethodProviderDetachOutcome,
  type FundingMethodDetachOutcome,
} from "../domain/funding-method";
import {
  resolveDropshipWalletPolicyLimitsFromEnv,
  type DropshipWalletPolicyLimits,
  type DropshipWalletPolicyResolver,
} from "../domain/wallet-policy";
import {
  formatNotificationCurrency,
  formatNotificationDate,
  sendDropshipNotificationSafely,
} from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";
import type {
  DropshipVendorStandingRecord,
  DropshipVendorStandingService,
} from "./dropship-vendor-standing-service";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipVendorProvisioningService,
} from "./dropship-vendor-provisioning-service";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const jsonObjectSchema = z.record(z.unknown());
const usdcBaseTransactionHashSchema = z.string().trim().regex(/^0x[a-fA-F0-9]{64}$/, {
  message: "USDC Base transaction hash must be a 32-byte EVM transaction hash.",
});
const usdcBaseWalletAddressSchema = z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, {
  message: "USDC Base wallet address must be a 20-byte EVM address.",
});
const usdcAtomicUnitsSchema = z.string().trim().regex(/^[1-9][0-9]{0,77}$/, {
  message: "USDC amount must be a positive integer atomic-unit string.",
});
const usdcBaseChainIdSchema = z.literal(8453);
const optionalObservedAtSchema = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === "string" && value.trim()) return new Date(value);
  return value;
}, z.date().optional());

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
  /** The service fee on an order accepted against pending ACH (migration 0688). */
  "advance_fee",
  /** A settled credit taken back by a dispute or ACH return, and its return when the dispute is won (migration 0689). */
  "funding_reversal",
  "funding_reinstated",
  /**
   * Rewards points (migration 0702): earned on a settled transfer, spent on
   * an order debit, taken back with the transfer that earned them and
   * returned when that dispute is won; expired when unused past their date
   * (migration 0705, which retired the never-written coupon kind).
   */
  "rewards_earned",
  "rewards_spent",
  "rewards_reversed",
  "rewards_reinstated",
  "rewards_expired",
]);
export type DropshipWalletLedgerType = z.infer<typeof dropshipWalletLedgerTypeSchema>;

/**
 * The card fee charged on top of a wallet credit. `chargedCents` is what the
 * card was charged; `amountCents` on the credit is what the wallet receives.
 * Present only for card rails: ACH and USDC carry no fee.
 */
export const dropshipWalletFundingCardFeeSchema = z.object({
  feeCents: CentsSchema,
  feeBps: z.number().int().min(0).max(MAX_CARD_FUNDING_FEE_BPS),
  chargedCents: PositiveCentsSchema,
}).strict();
export type DropshipWalletFundingCardFee = z.infer<typeof dropshipWalletFundingCardFeeSchema>;

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
  cardFee: dropshipWalletFundingCardFeeSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine((input, context) => {
  if (!input.cardFee) return;
  if (input.rail !== "stripe_card") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cardFee"],
      message: "A card fee can only accompany a card funding credit.",
    });
  }
  if (input.cardFee.chargedCents !== input.amountCents + input.cardFee.feeCents) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cardFee", "chargedCents"],
      message: "The charged amount must equal the wallet credit plus the card fee.",
    });
  }
});

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
  /** The one number the vendor keeps: the balance autopay tops back up to ("keep $X"). */
  minimumBalanceCents: CentsSchema,
  /**
   * The per-charge bound. Left out (or null) it is derived as max(minimum,
   * top-up amount): the vendor keeps one number and the bound is the
   * server's (funding design phase 5). Older clients still send their own.
   */
  maxSingleReloadCents: CentsSchema.nullable().optional(),
  /** What each automatic refill pulls; null or left out pulls the minimum. */
  topUpAmountCents: PositiveCentsSchema.nullable().optional(),
  paymentHoldTimeoutMinutes: z.number().int().positive().max(60 * 24 * 30),
  /**
   * The card fee rate the vendor was shown when they agreed to auto-reload.
   * Optional for older clients; when present it must match the rate in force,
   * so a stale screen cannot enrol a vendor under a rate they never saw.
   */
  acknowledgedCardFeeBps: z.number().int().min(0).max(MAX_CARD_FUNDING_FEE_BPS).optional(),
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

export const creditDropshipWalletConfirmedUsdcFundingInputSchema = z.object({
  vendorId: positiveIdSchema,
  fundingMethodId: positiveIdSchema.optional(),
  amountCents: PositiveCentsSchema,
  currency: CurrencyCodeSchema.default("USD"),
  amountAtomicUnits: usdcAtomicUnitsSchema,
  chainId: usdcBaseChainIdSchema.default(8453),
  transactionHash: usdcBaseTransactionHashSchema,
  fromAddress: usdcBaseWalletAddressSchema.nullable().optional(),
  toAddress: usdcBaseWalletAddressSchema,
  /** Which transfer in the transaction, for a batched withdrawal; absent means the transaction's only transfer. */
  logIndex: z.number().int().min(0).max(1_000_000).nullable().optional(),
  confirmations: z.number().int().positive().max(10_000),
  observedAt: optionalObservedAtSchema,
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

export const recordDropshipWalletFundingFailureInputSchema = z.object({
  vendorId: positiveIdSchema,
  fundingMethodId: positiveIdSchema.nullable().optional(),
  rail: dropshipWalletFundingRailSchema.nullable().optional(),
  amountCents: PositiveCentsSchema,
  currency: CurrencyCodeSchema.default("USD"),
  provider: z.string().trim().min(1).max(80),
  providerEventId: z.string().trim().min(1).max(255),
  providerPaymentIntentId: z.string().trim().min(1).max(255),
  providerStatus: z.string().trim().min(1).max(120).nullable().optional(),
  failureCode: z.string().trim().min(1).max(255).nullable().optional(),
  failureMessage: z.string().trim().min(1).max(1000).nullable().optional(),
  autoReload: z.boolean().default(false),
  autoReloadReason: z.enum(["minimum_balance", "payment_hold"]).nullable().optional(),
  intakeId: positiveIdSchema.nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const dropshipDisputeStatusSchema = z.enum(
  DROPSHIP_DISPUTE_STATUSES as [DropshipDisputeStatus, ...DropshipDisputeStatus[]],
);

/** A provider dispute on a funding payment: a card chargeback or an ACH debit returned after it cleared. */
export const recordDropshipWalletFundingReversalInputSchema = z.object({
  provider: z.literal("stripe"),
  providerEventId: z.string().trim().min(1).max(255),
  providerDisputeId: z.string().trim().min(1).max(255),
  providerPaymentIntentId: z.string().trim().min(1).max(255),
  amountCents: PositiveCentsSchema,
  currency: CurrencyCodeSchema,
  status: dropshipDisputeStatusSchema,
  reason: z.string().trim().min(1).max(120).nullable(),
  /** True once the provider has taken the funds: an inquiry that has not moves nothing yet. */
  fundsWithdrawn: z.boolean(),
}).strict();

export const recordDropshipWalletDisputeOutcomeInputSchema = z.object({
  provider: z.literal("stripe"),
  providerEventId: z.string().trim().min(1).max(255),
  providerDisputeId: z.string().trim().min(1).max(255),
  providerPaymentIntentId: z.string().trim().min(1).max(255),
  amountCents: PositiveCentsSchema,
  currency: CurrencyCodeSchema,
  status: dropshipDisputeStatusSchema,
  /** True when the funds came back to us: the dispute was won. */
  fundsReinstated: z.boolean(),
}).strict();

export const removeDropshipFundingMethodForMemberInputSchema = z.object({
  fundingMethodId: positiveIdSchema,
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
  if (input.rail === "usdc_base" && !input.usdcWalletAddress) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["usdcWalletAddress"],
      message: "USDC Base funding methods require a wallet address.",
    });
  }
});

export const registerDropshipUsdcBaseFundingMethodForMemberInputSchema = z.object({
  walletAddress: usdcBaseWalletAddressSchema,
  displayLabel: z.string().trim().min(1).max(200).nullable().optional(),
  isDefault: z.boolean().default(false),
}).strict();

export type CreditDropshipWalletFundingInput = z.infer<typeof creditDropshipWalletFundingInputSchema>;
export type DebitDropshipWalletForOrderInput = z.infer<typeof debitDropshipWalletForOrderInputSchema>;
export type ConfigureDropshipAutoReloadInput = z.infer<typeof configureDropshipAutoReloadInputSchema>;

/** The vendor's rewards spend preference (funding design phase 7). */
export const setDropshipRewardsSpendPreferenceInputSchema = z.object({
  spendRewardsFirst: z.boolean(),
}).strict();
export type SetDropshipRewardsSpendPreferenceInput = z.infer<typeof setDropshipRewardsSpendPreferenceInputSchema>;
export type CreateDropshipStripeFundingSetupSessionInput = z.infer<typeof createDropshipStripeFundingSetupSessionInputSchema>;
export type CreateDropshipStripeWalletFundingSessionInput = z.infer<typeof createDropshipStripeWalletFundingSessionInputSchema>;
export type CreditDropshipWalletManualFundingInput = z.infer<typeof creditDropshipWalletManualFundingInputSchema>;
export type CreditDropshipWalletConfirmedUsdcFundingInput = z.infer<typeof creditDropshipWalletConfirmedUsdcFundingInputSchema>;
export type HandleDropshipAutoReloadInput = z.infer<typeof handleDropshipAutoReloadInputSchema>;
export type RecordDropshipWalletFundingFailureInput = z.infer<typeof recordDropshipWalletFundingFailureInputSchema>;
export type RecordDropshipWalletFundingReversalInput = z.infer<typeof recordDropshipWalletFundingReversalInputSchema>;
export type RecordDropshipWalletDisputeOutcomeInput = z.infer<typeof recordDropshipWalletDisputeOutcomeInputSchema>;
export type RegisterDropshipFundingMethodInput = z.infer<typeof registerDropshipFundingMethodInputSchema>;
export type RegisterDropshipUsdcBaseFundingMethodForMemberInput = z.infer<typeof registerDropshipUsdcBaseFundingMethodForMemberInputSchema>;

export interface DropshipWalletAccountRecord {
  walletAccountId: number;
  vendorId: number;
  availableBalanceCents: number;
  pendingBalanceCents: number;
  /**
   * The spend-only rewards balance (funding design phase 7): money Card
   * Shellz issued on settled bank and USDC transfers. Never paid out, never
   * counted toward the minimum, the credit allowance or a top-up trigger, and
   * never negative.
   */
  rewardsBalanceCents: number;
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
  /** The per-charge bound: the client's, or max(minimum, top-up) derived at configure time. */
  maxSingleReloadCents: number | null;
  /** What each automatic refill pulls; null pulls the minimum (migration 0690). */
  topUpAmountCents: number | null;
  paymentHoldTimeoutMinutes: number;
  /**
   * The card fee rate the vendor agreed to when they turned autopay on, and
   * when (migration 0701). Null on a row saved before the acknowledgement was
   * stored, or by a client that sent none; an unattended charge then carries
   * the live rate, as before.
   */
  acknowledgedCardFeeBps: number | null;
  acknowledgedAt: Date | null;
  /**
   * The vendor's choice for their rewards points (funding design phase 7):
   * true auto-applies them to each order debit before cash, false saves them,
   * null means they have not chosen yet, which reads as saved. Auto-apply is
   * never a default (migration 0704).
   */
  spendRewardsFirst: boolean | null;
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
  /** The rewards balance after this line; null on lines written before migration 0702 or by writers that never move rewards. */
  rewardsBalanceAfterCents: number | null;
  referenceType: string | null;
  referenceId: string | null;
  idempotencyKey: string | null;
  fundingMethodId: number | null;
  externalTransactionId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  settledAt: Date | null;
}

export interface DropshipUsdcLedgerEntryRecord {
  usdcLedgerEntryId: number;
  vendorId: number;
  walletLedgerId: number | null;
  chainId: number;
  transactionHash: string;
  fromAddress: string | null;
  toAddress: string | null;
  amountAtomicUnits: string;
  confirmations: number;
  status: string;
  observedAt: Date;
  settledAt: Date | null;
  /** Chain facts the watcher records (migration 0691); null on a manual staff credit. */
  logIndex: number | null;
  blockNumber: number | null;
  blockHash: string | null;
  tokenAddress: string | null;
  depositAddressId: number | null;
  /** The sub-cent remainder left at the address, never credited. */
  dustAtomicUnits: string;
  voidedAt: Date | null;
}

/** The soonest instant rewards points leave the balance unless used, and how many (migration 0705). */
export interface DropshipRewardsNextExpiryRecord {
  expiresAt: Date;
  cents: number;
}

export interface DropshipWalletOverview {
  account: DropshipWalletAccountRecord;
  autoReload: DropshipAutoReloadSettingRecord | null;
  fundingMethods: DropshipFundingMethodRecord[];
  recentLedger: DropshipWalletLedgerRecord[];
  /** Null when no points are set to expire: none held, or none earned while an expiry was set. */
  rewardsNextExpiry: DropshipRewardsNextExpiryRecord | null;
}

/** The overview as served to a vendor or admin: stored state plus the fee policy in force. */
export interface DropshipWalletView extends DropshipWalletOverview {
  /** Fee rate on card charges, in basis points. ACH and USDC carry none. */
  cardFundingFeeBps: number;
  /**
   * Where a vendor sends USDC on Base to fund the wallet, or null when USDC
   * funding is not offered (nothing configured). Card Shellz credits the
   * wallet once the transfer is confirmed on chain.
   */
  usdcBaseDepositAddress: string | null;
  /**
   * The wallet policy limits in force — the staff-managed
   * `dropship.dropship_wallet_policies` row, or the environment fallback. The
   * portal renders these instead of a hard-coded table, so a limit change is
   * visible to vendors the moment it is published.
   */
  limits: DropshipWalletPolicyLimits;
  /**
   * The vendor's pending-ACH advance position (funding design phase 3): which
   * bank accounts qualify, the cap and fee in force, and how much a new order
   * could draw. Null when the policy could not be read.
   */
  advance: DropshipAdvanceStanding | null;
}

/**
 * What the funding provider reports for a linked bank account, before the
 * wallet's currency is applied: every available cash balance by lowercase
 * ISO currency code, in the provider's integer minor units.
 */
export type DropshipBankBalanceSnapshot =
  | { status: "succeeded"; availableByCurrency: Readonly<Record<string, number>>; asOf: Date }
  | { status: "pending"; nextRefreshAvailableAt: Date | null }
  | { status: "failed"; reason: string };

/** A bank balance read through the funding provider, in the wallet's currency. */
export type DropshipBankBalanceReading =
  | {
      status: "succeeded";
      providerAccountId: string;
      /** The provider's available cash balance in integer minor units of `currency`. */
      availableCents: number;
      currency: string;
      asOf: Date;
    }
  | { status: "pending"; providerAccountId: string; nextRefreshAvailableAt: Date | null }
  | { status: "failed"; providerAccountId: string; reason: string };

export type DropshipBankBalanceVerificationSource = "link" | "refresh" | "webhook";

export interface DropshipBankBalanceVerificationRecord {
  verificationId: number;
  vendorId: number;
  fundingMethodId: number;
  provider: string;
  providerAccountId: string;
  status: DropshipBankBalanceReading["status"];
  source: DropshipBankBalanceVerificationSource;
  availableCents: number | null;
  currency: string | null;
  balanceAsOf: Date | null;
  providerEventId: string | null;
  createdAt: Date;
}

export interface RecordDropshipBankBalanceVerificationRepositoryInput {
  vendorId: number;
  fundingMethodId: number;
  provider: "stripe";
  reading: DropshipBankBalanceReading;
  source: DropshipBankBalanceVerificationSource;
  /** The provider event that carried the reading; a replay records nothing twice. Null for a read we initiated. */
  providerEventId: string | null;
  occurredAt: Date;
}

export type DropshipBankBalanceVerificationOutcome =
  | { outcome: "recorded"; record: DropshipBankBalanceVerificationRecord; idempotentReplay: boolean }
  | { outcome: "not_applicable"; reason: "not_bank_account" | "no_provider_account" | "funding_method_missing" | "provider_not_configured" }
  | { outcome: "failed"; message: string };

export interface DropshipWalletMutationResult {
  account: DropshipWalletAccountRecord;
  ledgerEntry: DropshipWalletLedgerRecord;
  idempotentReplay: boolean;
}

export interface FailDropshipPendingFundingRepositoryInput {
  vendorId: number;
  referenceType: string;
  referenceId: string;
  failureCode: string | null;
  failureMessage: string | null;
  providerStatus: string | null;
  providerEventId: string;
  occurredAt: Date;
  /**
   * Pause the vendor in the same transaction as the void. Null keeps the
   * vendor's standing untouched (only tests and non-standing callers).
   */
  pauseVendor: {
    reason: DropshipVendorStandingReason;
    evidence: Record<string, unknown>;
  } | null;
}

export interface DropshipWalletFundingFailureRepositoryResult extends DropshipWalletMutationResult {
  /** The vendor's standing after this call paused it; null when nothing changed (replay, or already paused). */
  vendorPaused: DropshipVendorStandingRecord | null;
}

export interface ReverseDropshipSettledFundingRepositoryInput {
  provider: "stripe";
  providerPaymentIntentId: string;
  providerDisputeId: string;
  providerEventId: string;
  disputeAmountCents: number;
  currency: string;
  disputeStatus: DropshipDisputeStatus;
  disputeReason: string | null;
  occurredAt: Date;
  /** Pause the vendor in the same transaction as the reversal; null keeps standing untouched (tests only). */
  pauseVendor: {
    reason: DropshipVendorStandingReason;
    evidence: Record<string, unknown>;
  } | null;
}

export type DropshipFundingReversalRepositoryResult =
  | {
      outcome: "reversed";
      vendorId: number;
      account: DropshipWalletAccountRecord;
      /** The settled credit the dispute is about. */
      credit: DropshipWalletLedgerRecord;
      reversal: DropshipWalletLedgerRecord;
      idempotentReplay: boolean;
      /** The vendor's standing after this call paused it; null when nothing changed (replay, or already paused). */
      vendorPaused: DropshipVendorStandingRecord | null;
    }
  | {
      outcome: "ignored";
      vendorId: number;
      credit: DropshipWalletLedgerRecord;
      reason: "credit_not_settled" | "currency_mismatch" | "nothing_to_reverse";
    };

export interface ReinstateDropshipReversedFundingRepositoryInput {
  provider: "stripe";
  providerDisputeId: string;
  providerEventId: string;
  occurredAt: Date;
}

export interface DropshipFundingReinstatementRepositoryResult {
  vendorId: number;
  account: DropshipWalletAccountRecord;
  reversal: DropshipWalletLedgerRecord;
  reinstatement: DropshipWalletLedgerRecord;
  idempotentReplay: boolean;
}

export type DropshipWalletFundingReversalResult =
  | { outcome: "deferred" }
  | { outcome: "not_applicable" }
  | { outcome: "ignored"; reason: "credit_not_settled" | "currency_mismatch" | "nothing_to_reverse" }
  | {
      outcome: "reversed";
      vendorId: number;
      reversalLedgerEntryId: number;
      reversalCents: number;
      availableBalanceAfterCents: number;
      vendorPaused: boolean;
      idempotentReplay: boolean;
    };

export type DropshipWalletDisputeOutcomeResult =
  | { outcome: "unchanged" }
  | { outcome: "not_applicable" }
  | {
      outcome: "reinstated";
      vendorId: number;
      reinstatementLedgerEntryId: number;
      amountCents: number;
      availableBalanceAfterCents: number;
      idempotentReplay: boolean;
    };

export interface DropshipWalletFundingFailureResult {
  /** True when this call voided a pending credit; false on a replay or when nothing was recorded for the payment. */
  pendingCreditVoided: boolean;
  ledgerEntryId: number | null;
  /** True when the voided credit paused the vendor in the same transaction. */
  vendorPaused: boolean;
}

export interface DropshipConfirmedUsdcFundingResult extends DropshipWalletMutationResult {
  usdcLedgerEntry: DropshipUsdcLedgerEntryRecord;
}

/** A USDC transfer the watcher found, recorded against the vendor whose deposit address received it. */
export interface ObserveDropshipUsdcDepositRepositoryInput {
  vendorId: number;
  depositAddressId: number;
  transfer: UsdcTransferObservation;
  /** Whole cents credited; zero for dust. */
  amountCents: number;
  dustAtomicUnits: string;
  confirmations: number;
  /** pending: credited to the pending balance; settled: available; dust: recorded, never credited. */
  status: "pending" | "settled" | "dust";
  currency: string;
  requestHash: string;
  occurredAt: Date;
}

export interface DropshipUsdcDepositLedgerResult {
  account: DropshipWalletAccountRecord;
  /** Null for dust: no money moved. */
  ledgerEntry: DropshipWalletLedgerRecord | null;
  usdcLedgerEntry: DropshipUsdcLedgerEntryRecord;
  idempotentReplay: boolean;
}

export interface SettleDropshipUsdcDepositRepositoryInput {
  vendorId: number;
  usdcLedgerEntryId: number;
  confirmations: number;
  current: { blockNumber: number; blockHash: string };
  occurredAt: Date;
}

export interface VoidDropshipUsdcDepositRepositoryInput {
  vendorId: number;
  usdcLedgerEntryId: number;
  reasonCode: string;
  reasonMessage: string;
  occurredAt: Date;
}

export interface RecordDropshipUsdcDepositMovedRepositoryInput {
  vendorId: number;
  usdcLedgerEntryId: number;
  confirmations: number;
  current: { blockNumber: number; blockHash: string };
  occurredAt: Date;
}

/**
 * The wallet ledger's side of watched USDC deposits (funding design phase 6):
 * every write moves the wallet balances and the chain observation together.
 */
export interface DropshipUsdcDepositLedgerRepository {
  findUsdcDepositByLog(input: { chainId: number; transactionHash: string; logIndex: number }): Promise<DropshipUsdcLedgerEntryRecord | null>;
  listPendingUsdcDeposits(input: { chainId: number; limit: number }): Promise<DropshipUsdcLedgerEntryRecord[]>;
  observeUsdcDeposit(input: ObserveDropshipUsdcDepositRepositoryInput): Promise<DropshipUsdcDepositLedgerResult>;
  settleUsdcDeposit(input: SettleDropshipUsdcDepositRepositoryInput): Promise<DropshipUsdcDepositLedgerResult>;
  voidUsdcDeposit(input: VoidDropshipUsdcDepositRepositoryInput): Promise<DropshipUsdcDepositLedgerResult>;
  recordUsdcDepositMoved(input: RecordDropshipUsdcDepositMovedRepositoryInput): Promise<DropshipUsdcLedgerEntryRecord>;
}

export interface DropshipFundingMethodMutationResult {
  fundingMethod: DropshipFundingMethodRecord;
  idempotentReplay: boolean;
}

/** How the provider-side detach ended; see `FUNDING_METHOD_DETACH_OUTCOMES` in the domain. */
export type DropshipFundingMethodDetachOutcome = FundingMethodDetachOutcome;

export interface DropshipFundingMethodRemovalResult {
  fundingMethod: DropshipFundingMethodRecord;
  idempotentReplay: boolean;
  providerDetach: DropshipFundingMethodDetachOutcome;
}

export interface ArchiveDropshipFundingMethodRepositoryInput {
  vendorId: number;
  fundingMethodId: number;
  /** The signed-in member who asked; recorded as the audit row's actor. */
  actorMemberId: string;
  archivedAt: Date;
}

export interface RecordDropshipFundingMethodDetachOutcomeRepositoryInput {
  vendorId: number;
  fundingMethodId: number;
  outcome: DropshipFundingMethodDetachOutcome;
  /** The structured error code when the detach did not complete; null otherwise. */
  errorCode: string | null;
  recordedAt: Date;
}

/** The provider's answer to a detach request that completed. Failures throw a classified DropshipError. */
export interface DropshipProviderDetachResult {
  outcome: "detached" | "already_detached";
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
  /** What the wallet will receive. */
  amountCents: number;
  /** The card fee on top; zero for ACH. */
  cardFeeCents: number;
  /** What the payment method is charged: amount plus fee. */
  chargedCents: number;
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
  /** What the wallet was credited. */
  amountCents: number;
  /** The card fee on top; zero for ACH and for a skip. */
  cardFeeCents: number;
  /** What the payment method was charged: amount plus fee; zero for a skip. */
  chargedCents: number;
  currency: string;
  providerPaymentIntentId: string | null;
  fundingLedgerEntryId: number | null;
  fundingStatus: Extract<DropshipWalletLedgerStatus, "pending" | "settled"> | null;
  skipReason: string | null;
  idempotentReplay: boolean;
}

/**
 * Turns on the Financial Connections balance permission when a bank account is
 * linked. Off by default: Stripe refuses the entire bank link when the
 * permission is requested before the account is registered for that product,
 * and a bank account without it still funds the wallet — it only forfeits the
 * pending-bank advance, which needs the balance read.
 */
export const STRIPE_BANK_BALANCE_PERMISSION_ENV = "DROPSHIP_STRIPE_FINANCIAL_CONNECTIONS_BALANCES";

/** Stripe's own word on whether a funding rail is usable: one of its capability states. */
export type DropshipStripeRailState = "active" | "inactive" | "pending";

/**
 * Which rails the Stripe account can run, as the account itself reports them.
 *
 * `outcome` is "unavailable" when the account could not be read at all (no
 * credentials, Stripe unreachable); the rail fields are then null and `reason`
 * carries the structured error code. A rail we never asked about is also null,
 * which is why the two are distinguished by `outcome` rather than by nulls.
 */
export interface DropshipStripeRailAvailability {
  outcome: "read" | "unavailable";
  accountId: string | null;
  cardPayments: DropshipStripeRailState | null;
  achPayments: DropshipStripeRailState | null;
  reason: string | null;
}

export interface DropshipWalletFundingProvider {
  /** Read-only: which rails the Stripe account can actually run. */
  readRailAvailability(): Promise<DropshipStripeRailAvailability>;
  /**
   * Detach a saved payment method from its customer at the provider, so it
   * cannot be charged from the provider's side either. `already_detached`
   * when the provider no longer has it. Any other failure throws a
   * classified DropshipError; the caller decides what the archived method
   * reports.
   */
  detachPaymentMethod(input: { providerPaymentMethodId: string }): Promise<DropshipProviderDetachResult>;
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
    /** What the wallet will receive. */
    amountCents: number;
    /** The fee charged on top of `amountCents`; null when the rail carries none. */
    cardFee: DropshipWalletFundingCardFeeRate | null;
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
    /** What the wallet will receive. */
    amountCents: number;
    /** The fee charged on top of `amountCents`; null when the rail carries none. */
    cardFee: DropshipWalletFundingCardFeeRate | null;
    currency: string;
    providerCustomerId: string;
    providerPaymentMethodId: string;
    reason: HandleDropshipAutoReloadInput["reason"];
    intakeId: number | null;
    requiredBalanceCents: number | null;
    idempotencyKey: string;
    now: Date;
  }): Promise<DropshipStripeAutoReloadPaymentIntent>;
  /**
   * Read the balance of a bank account linked through the provider. A
   * `pending` reading means a refresh was requested and the provider will
   * report the balance later (webhook); `failed` names why nothing was read.
   */
  readBankBalance(input: {
    providerAccountId: string;
    now: Date;
  }): Promise<DropshipBankBalanceSnapshot>;
}

/**
 * The reading the wallet records from a provider snapshot: the available cash
 * balance in the wallet's currency. A snapshot without that currency is a
 * failed reading, not a zero — nothing about the account is known.
 */
export function bankBalanceReadingFor(input: {
  providerAccountId: string;
  currency: string;
  snapshot: DropshipBankBalanceSnapshot;
}): DropshipBankBalanceReading {
  const { providerAccountId, snapshot } = input;
  if (snapshot.status === "pending") {
    return { status: "pending", providerAccountId, nextRefreshAvailableAt: snapshot.nextRefreshAvailableAt };
  }
  if (snapshot.status === "failed") {
    return { status: "failed", providerAccountId, reason: snapshot.reason };
  }
  const availableCents = snapshot.availableByCurrency[input.currency.toLowerCase()];
  if (typeof availableCents !== "number" || !Number.isSafeInteger(availableCents)) {
    return { status: "failed", providerAccountId, reason: "balance_currency_missing" };
  }
  return {
    status: "succeeded",
    providerAccountId,
    availableCents,
    currency: input.currency.toUpperCase(),
    asOf: snapshot.asOf,
  };
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
  /** Save whether rewards pay first on each order or are kept, with its audit row (funding design phase 7). */
  setRewardsSpendPreference(input: SetDropshipRewardsSpendPreferenceRepositoryInput): Promise<DropshipAutoReloadSettingRecord>;
  getReusableFundingProviderCustomerId(input: {
    vendorId: number;
    provider: "stripe";
  }): Promise<string | null>;
  /** Lifecycle status of the vendor, or null when the vendor does not exist. */
  getVendorLifecycleStatus(vendorId: number): Promise<DropshipVendorStatus | null>;
  /**
   * Void a pending funding credit whose payment failed: the ledger entry moves
   * to `failed` and the pending balance drops by its amount, in one
   * transaction with the audit row. Null when no funding entry matches the
   * reference; a replay (entry no longer pending) returns it unchanged.
   */
  failPendingFunding(input: FailDropshipPendingFundingRepositoryInput): Promise<DropshipWalletFundingFailureRepositoryResult | null>;
  upsertFundingMethod(input: UpsertDropshipFundingMethodRepositoryInput): Promise<DropshipFundingMethodMutationResult>;
  /**
   * Archive a funding method the vendor is removing: one transaction under
   * the method's row lock, applying `decideFundingMethodRemoval` to facts
   * read in that same transaction. A refusal throws its DropshipError; a
   * method already archived is a replay and changes nothing.
   */
  archiveFundingMethod(input: ArchiveDropshipFundingMethodRepositoryInput): Promise<DropshipFundingMethodMutationResult>;
  /** Record how the provider-side detach of an archived method ended, with its audit row. */
  recordFundingMethodDetachOutcome(
    input: RecordDropshipFundingMethodDetachOutcomeRepositoryInput,
  ): Promise<DropshipFundingMethodRecord>;
  creditConfirmedUsdcFunding(input: CreateDropshipConfirmedUsdcFundingRepositoryInput): Promise<DropshipConfirmedUsdcFundingResult>;
  /** The facts the pending-ACH advance is decided from, read in one transaction; null when the policy is unreadable. */
  readAdvanceContext(input: { vendorId: number; now: Date }): Promise<DropshipAdvanceContext | null>;
  /** Append a bank balance reading for a funding method of this vendor, with its audit row. */
  recordBankBalanceVerification(
    input: RecordDropshipBankBalanceVerificationRepositoryInput,
  ): Promise<{ record: DropshipBankBalanceVerificationRecord; idempotentReplay: boolean }>;
  /** The bank-account funding method linked to a provider account, or null. */
  findFundingMethodByProviderAccount(input: {
    provider: "stripe";
    providerAccountId: string;
  }): Promise<DropshipFundingMethodRecord | null>;
  /**
   * Take back a settled funding credit the provider disputed: one
   * `funding_reversal` debit per dispute, the vendor paused in the same
   * transaction. Null when no funding credit matches the payment intent;
   * `ignored` when the credit is not reversible (domain/funding-reversal.ts);
   * a replay returns the existing reversal and moves nothing.
   */
  reverseSettledFunding(
    input: ReverseDropshipSettledFundingRepositoryInput,
  ): Promise<DropshipFundingReversalRepositoryResult | null>;
  /** Credit a reversal back once the dispute is won; null when no reversal exists for the dispute. */
  reinstateReversedFunding(
    input: ReinstateDropshipReversedFundingRepositoryInput,
  ): Promise<DropshipFundingReinstatementRepositoryResult | null>;
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

/** The configuration with its amounts resolved: the bound as sent, or derived from the minimum and the top-up amount. */
export type ResolvedDropshipAutoReloadConfig =
  Omit<ConfigureDropshipAutoReloadInput, "maxSingleReloadCents" | "topUpAmountCents"> & {
    maxSingleReloadCents: number | null;
    topUpAmountCents: number | null;
  };

export interface ConfigureDropshipAutoReloadRepositoryInput extends ResolvedDropshipAutoReloadConfig {
  /** The card fee rate in force when the vendor agreed, recorded in the audit trail. */
  cardFundingFeeBps: number;
  updatedAt: Date;
}

export interface SetDropshipRewardsSpendPreferenceRepositoryInput {
  vendorId: number;
  spendRewardsFirst: boolean;
  /** The signed-in member who chose, for the audit row. */
  actorMemberId: string;
  updatedAt: Date;
}

export interface UpsertDropshipFundingMethodRepositoryInput extends RegisterDropshipFundingMethodInput {
  updatedAt: Date;
}

export type CreateDropshipConfirmedUsdcFundingRepositoryInput =
  Omit<CreditDropshipWalletConfirmedUsdcFundingInput, "fundingMethodId" | "observedAt" | "logIndex"> & {
    fundingMethodId: number | null;
    observedAt: Date;
    logIndex: number | null;
    requestHash: string;
    occurredAt: Date;
  };

export class DropshipWalletService {
  constructor(
    private readonly deps: {
      vendorProvisioning: DropshipVendorProvisioningService;
      repository: DropshipWalletRepository;
      fundingProvider?: DropshipWalletFundingProvider;
      notificationSender?: DropshipNotificationSender;
      /**
       * Vendor standing: announces the pause a voided credit caused and
       * resumes a paused vendor once a settled credit funds the wallet.
       */
      vendorStanding?: Pick<DropshipVendorStandingService, "announcePause" | "restoreIfFunded">;
      clock: DropshipClock;
      logger: DropshipLogger;
      /**
       * Wallet policy limits (auto-reload floors, manual funding bounds, hold
       * timings). Absent means the documented environment fallback, exactly as
       * before this became staff-managed data. Injected so tests are
       * deterministic.
       */
      walletPolicy?: DropshipWalletPolicyResolver;
      /** Card fee rate override; the environment's rate when absent. Injected so tests are deterministic. */
      cardFundingFeeBps?: number;
      /** USDC deposit address override; the environment's address when absent. Injected so tests are deterministic. */
      usdcBaseDepositAddress?: string | null;
      /**
       * The vendor's own USDC deposit address (funding design phase 6), or
       * null when none was handed out. A manual credit must name it or the
       * shared address: a transfer to anywhere else cannot be attributed.
       */
      usdcDepositAddressLookup?: (vendorId: number) => Promise<string | null>;
    },
  ) {}

  async getWalletForMember(
    memberId: string,
    input: { ledgerLimit?: number } = {},
  ): Promise<DropshipWalletView> {
    const vendor = await this.provisionVendor(memberId);
    return this.getWalletForVendor(vendor.vendor.vendorId, input);
  }

  async getWalletForVendor(
    vendorId: number,
    input: { ledgerLimit?: number } = {},
  ): Promise<DropshipWalletView> {
    const now = this.deps.clock.now();
    const overview = await this.deps.repository.getOverview({
      vendorId,
      ledgerLimit: clampLedgerLimit(input.ledgerLimit),
      now,
    });
    const advanceContext = await this.deps.repository.readAdvanceContext({ vendorId, now });
    const limits = await this.walletLimits();
    return {
      ...overview,
      cardFundingFeeBps: this.feeBpsFrom(limits),
      usdcBaseDepositAddress: this.usdcBaseDepositAddress(),
      limits,
      advance: advanceContext
        ? assessAdvanceStanding({
            availableBalanceCents: overview.account.availableBalanceCents,
            context: advanceContext,
          })
        : null,
    };
  }

  /**
   * Read and record the balance behind a bank account (funding design phase
   * 3): one of the three facts the pending-ACH advance requires. Best-effort
   * by design — the account was linked and stays usable whatever happens
   * here; a failed or missing reading only means "balance not verified", so
   * nothing is advanced against that account until a later reading succeeds.
   */
  async verifyBankBalanceForFundingMethod(input: {
    vendorId: number;
    fundingMethodId: number;
    source: Extract<DropshipBankBalanceVerificationSource, "link" | "refresh">;
    providerEventId: string | null;
  }): Promise<DropshipBankBalanceVerificationOutcome> {
    const provider = this.deps.fundingProvider;
    if (!provider) {
      return { outcome: "not_applicable", reason: "provider_not_configured" };
    }
    const now = this.deps.clock.now();
    const wallet = await this.deps.repository.getOverview({ vendorId: input.vendorId, ledgerLimit: 1, now });
    const method = wallet.fundingMethods.find((candidate) => candidate.fundingMethodId === input.fundingMethodId);
    if (!method) {
      return { outcome: "not_applicable", reason: "funding_method_missing" };
    }
    if (method.rail !== "stripe_ach") {
      return { outcome: "not_applicable", reason: "not_bank_account" };
    }
    const providerAccountId = fundingMethodFinancialConnectionsAccountId(method.metadata);
    if (!providerAccountId) {
      this.deps.logger.info({
        code: "DROPSHIP_BANK_BALANCE_NOT_READABLE",
        message: "Dropship bank account was not linked through the provider's account connection; its balance cannot be read, so it will not qualify for the pending-ACH advance.",
        context: { vendorId: input.vendorId, fundingMethodId: input.fundingMethodId },
      });
      return { outcome: "not_applicable", reason: "no_provider_account" };
    }
    try {
      const snapshot = await provider.readBankBalance({ providerAccountId, now });
      const reading = bankBalanceReadingFor({ providerAccountId, currency: wallet.account.currency, snapshot });
      const recorded = await this.deps.repository.recordBankBalanceVerification({
        vendorId: input.vendorId,
        fundingMethodId: input.fundingMethodId,
        provider: "stripe",
        reading,
        source: input.source,
        providerEventId: input.providerEventId,
        occurredAt: now,
      });
      this.logBankBalanceReading(reading, { vendorId: input.vendorId, fundingMethodId: input.fundingMethodId, source: input.source, idempotentReplay: recorded.idempotentReplay });
      return { outcome: "recorded", record: recorded.record, idempotentReplay: recorded.idempotentReplay };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn({
        code: "DROPSHIP_BANK_BALANCE_VERIFICATION_FAILED",
        message: "Dropship bank balance could not be read or recorded; the account stays unverified for the pending-ACH advance.",
        context: { vendorId: input.vendorId, fundingMethodId: input.fundingMethodId, providerAccountId, source: input.source, error: message },
      });
      return { outcome: "failed", message };
    }
  }

  /**
   * The provider reported a refreshed balance for a linked account (webhook).
   * Recorded against the bank account it belongs to; unknown accounts are
   * ignored at DEBUG, since the provider also reports accounts linked for
   * other products.
   */
  async recordBankBalanceRefresh(input: {
    providerAccountId: string;
    snapshot: DropshipBankBalanceSnapshot;
    providerEventId: string;
  }): Promise<DropshipBankBalanceVerificationOutcome> {
    const method = await this.deps.repository.findFundingMethodByProviderAccount({
      provider: "stripe",
      providerAccountId: input.providerAccountId,
    });
    if (!method) {
      // Expected: the provider reports every linked account, including ones
      // other products linked. Info, not warn — nothing needs a human.
      this.deps.logger.info({
        code: "DROPSHIP_BANK_BALANCE_REFRESH_UNMATCHED",
        message: "Dropship bank balance refresh did not match a funding method.",
        context: { providerAccountId: input.providerAccountId, providerEventId: input.providerEventId },
      });
      return { outcome: "not_applicable", reason: "funding_method_missing" };
    }
    const now = this.deps.clock.now();
    const wallet = await this.deps.repository.getOverview({ vendorId: method.vendorId, ledgerLimit: 1, now });
    const reading = bankBalanceReadingFor({
      providerAccountId: input.providerAccountId,
      currency: wallet.account.currency,
      snapshot: input.snapshot,
    });
    const recorded = await this.deps.repository.recordBankBalanceVerification({
      vendorId: method.vendorId,
      fundingMethodId: method.fundingMethodId,
      provider: "stripe",
      reading,
      source: "webhook",
      providerEventId: input.providerEventId,
      occurredAt: now,
    });
    this.logBankBalanceReading(reading, { vendorId: method.vendorId, fundingMethodId: method.fundingMethodId, source: "webhook", idempotentReplay: recorded.idempotentReplay });
    return { outcome: "recorded", record: recorded.record, idempotentReplay: recorded.idempotentReplay };
  }

  private logBankBalanceReading(
    reading: DropshipBankBalanceReading,
    context: { vendorId: number; fundingMethodId: number; source: DropshipBankBalanceVerificationSource; idempotentReplay: boolean },
  ): void {
    const base = { ...context, providerAccountId: reading.providerAccountId, status: reading.status };
    if (reading.status === "succeeded") {
      this.deps.logger.info({
        code: "DROPSHIP_BANK_BALANCE_VERIFIED",
        message: "Dropship bank balance was read and recorded.",
        context: { ...base, availableCents: reading.availableCents, currency: reading.currency, asOf: reading.asOf.toISOString() },
      });
    } else if (reading.status === "pending") {
      this.deps.logger.info({
        code: "DROPSHIP_BANK_BALANCE_REFRESH_PENDING",
        message: "Dropship bank balance refresh was requested; the provider reports it later.",
        context: { ...base, nextRefreshAvailableAt: reading.nextRefreshAvailableAt?.toISOString() ?? null },
      });
    } else {
      this.deps.logger.warn({
        code: "DROPSHIP_BANK_BALANCE_READ_FAILED",
        message: "Dropship bank balance could not be read; the account stays unverified for the pending-ACH advance.",
        context: { ...base, reason: reading.reason },
      });
    }
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
      if (parsed.status === "settled") {
        await this.restoreVendorStandingIfFunded(parsed.vendorId, {
          source: "wallet_funding_credit",
          ledgerEntryId: result.ledgerEntry.ledgerEntryId,
          rail: parsed.rail,
          amountCents: parsed.amountCents,
          currency: parsed.currency,
        });
      }
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
    const parsed = resolveAutoReloadAmounts(parseWalletInput(configureDropshipAutoReloadInputSchema, input));
    const limits = await this.walletLimits();
    assertAutoReloadConfigIsUsable(parsed, limits);
    const cardFundingFeeBps = this.feeBpsFrom(limits);
    assertCardFeeAcknowledgementIsCurrent(parsed, cardFundingFeeBps);
    await this.assertAutoReloadMayBeDisabled(parsed);
    const updatedAt = this.deps.clock.now();
    await this.assertAutoReloadFundingMethodIsUsable(parsed, updatedAt);
    const setting = await this.deps.repository.configureAutoReload({
      ...parsed,
      cardFundingFeeBps,
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
        topUpAmountCents: parsed.topUpAmountCents,
        maxSingleReloadCents: parsed.maxSingleReloadCents,
        cardFundingFeeBps,
        acknowledgedCardFeeBps: parsed.acknowledgedCardFeeBps ?? null,
        autoReloadMinTriggerCents: limits.autoReloadMinTriggerCents,
        autoReloadMinAmountCents: limits.autoReloadMinAmountCents,
      },
    });
    return setting;
  }

  /**
   * The vendor's choice between spending rewards first on each order (the
   * default) and saving them (funding design phase 7). A preference, not a
   * money movement: no proof of a sensitive action is required; the audit
   * row commits with the change.
   */
  async setRewardsSpendPreferenceForMember(
    memberId: string,
    input: unknown,
  ): Promise<DropshipAutoReloadSettingRecord> {
    const parsed = parseWalletInput(setDropshipRewardsSpendPreferenceInputSchema, input);
    const provisioned = await this.provisionVendor(memberId);
    const vendorId = provisioned.vendor.vendorId;
    const setting = await this.deps.repository.setRewardsSpendPreference({
      vendorId,
      spendRewardsFirst: parsed.spendRewardsFirst,
      actorMemberId: memberId,
      updatedAt: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: "DROPSHIP_WALLET_REWARDS_PREFERENCE_SAVED",
      message: "Dropship wallet rewards spend preference was saved.",
      context: { vendorId, memberId, spendRewardsFirst: setting.spendRewardsFirst },
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

  async creditConfirmedUsdcFunding(input: unknown): Promise<DropshipConfirmedUsdcFundingResult> {
    const parsed = normalizeConfirmedUsdcFundingInput(parseWalletInput(
      creditDropshipWalletConfirmedUsdcFundingInputSchema,
      input,
    ));
    // Two independent amounts would let a typo credit dollars the chain never
    // carried: the cents must be the atomic units, rounded down to whole cents.
    const expected = usdcAtomicUnitsToCents(parsed.amountAtomicUnits);
    if (expected.cents !== parsed.amountCents) {
      throw new DropshipError(
        "DROPSHIP_USDC_AMOUNT_MISMATCH",
        "The dollar amount does not match the USDC amount: whole cents are the atomic units divided by 10,000, rounded down.",
        {
          vendorId: parsed.vendorId,
          amountCents: parsed.amountCents,
          expectedCents: expected.cents,
          amountAtomicUnits: parsed.amountAtomicUnits,
          classification: "permanent",
        },
      );
    }
    await this.assertUsdcDepositAddressIsOurs(parsed.vendorId, parsed.toAddress);
    const occurredAt = this.deps.clock.now();
    const requestHash = hashWalletConfirmedUsdcFundingRequest(parsed);
    const result = await this.deps.repository.creditConfirmedUsdcFunding({
      ...parsed,
      fundingMethodId: parsed.fundingMethodId ?? null,
      observedAt: parsed.observedAt ?? occurredAt,
      logIndex: parsed.logIndex ?? null,
      requestHash,
      occurredAt,
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_WALLET_USDC_FUNDING_CREDITED",
        message: "Dropship wallet was credited by a confirmed USDC Base transfer.",
        context: {
          vendorId: parsed.vendorId,
          walletAccountId: result.account.walletAccountId,
          ledgerEntryId: result.ledgerEntry.ledgerEntryId,
          usdcLedgerEntryId: result.usdcLedgerEntry.usdcLedgerEntryId,
          fundingMethodId: parsed.fundingMethodId ?? null,
          amountCents: parsed.amountCents,
          amountAtomicUnits: parsed.amountAtomicUnits,
          transactionHash: parsed.transactionHash,
          logIndex: parsed.logIndex ?? null,
          chainId: parsed.chainId,
          confirmations: parsed.confirmations,
          actorType: parsed.actor.actorType,
          actorId: parsed.actor.actorId ?? null,
        },
      });
      await this.restoreVendorStandingIfFunded(parsed.vendorId, {
        source: "wallet_usdc_funding_credit",
        ledgerEntryId: result.ledgerEntry.ledgerEntryId,
        rail: "usdc_base",
        amountCents: parsed.amountCents,
        currency: parsed.currency,
      });
    }
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

    // The minimum depends on the rail (a card deposit has its own), so the
    // amount is checked once the method, and with it the rail, is known.
    const limits = await this.walletLimits();
    assertStripeWalletFundingAmount(parsed.amountCents, fundingMethod.rail, limits);
    const quote = this.quoteFunding(fundingMethod.rail, parsed.amountCents, this.feeBpsFrom(limits));
    const now = this.deps.clock.now();
    const session = await provider.createStripeWalletFundingSession({
      vendorId: vendor.vendorId,
      memberId,
      fundingMethodId: fundingMethod.fundingMethodId,
      rail: fundingMethod.rail,
      amountCents: quote.creditCents,
      cardFee: cardFeeForProvider(quote),
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
        amountCents: quote.creditCents,
        cardFeeCents: quote.feeCents,
        cardFeeBps: quote.feeBps,
        chargedCents: quote.chargedCents,
        rail: fundingMethod.rail,
        providerSessionId: session.providerSessionId,
      },
    });
    return session;
  }

/**
   * Records every auto-reload that does not charge.
   *
   * A skip is how the backstop fails, and it used to be invisible: the result
   * carried a reason but nothing was written down, so a vendor whose card had
   * expired — or whose auto-reload pointed at a rail that cannot be charged —
   * simply stopped reloading, and the first anyone knew of it was the order
   * cancelling on the marketplace.
   *
   * WARN for the reasons that mean the backstop cannot fire when it is needed:
   * those want a human. INFO for the ones that are a correct no-op.
   */
  private skipAutoReload(
    input: HandleDropshipAutoReloadInput,
    skipReason: string,
    currency: string,
    fundingMethodId: number | null = null,
  ): DropshipAutoReloadResult {
    const event = {
      code: "DROPSHIP_AUTO_RELOAD_SKIPPED",
      message: "Dropship auto-reload did not charge.",
      context: {
        vendorId: input.vendorId,
        fundingMethodId,
        reason: input.reason,
        intakeId: input.intakeId ?? null,
        requiredBalanceCents: input.requiredBalanceCents ?? null,
        skipReason,
        currency,
      },
    };
    if (AUTO_RELOAD_SKIPS_NEEDING_ATTENTION.has(skipReason)) {
      this.deps.logger.warn(event);
    } else {
      this.deps.logger.info(event);
    }
    return skippedAutoReload(input, skipReason, currency, fundingMethodId);
  }

  async handleAutoReload(input: unknown): Promise<DropshipAutoReloadResult> {
    const parsed = parseWalletInput(handleDropshipAutoReloadInputSchema, input);
    const provider = this.deps.fundingProvider;
    if (!provider) {
      return this.skipAutoReload(parsed, "funding_provider_not_configured", "USD");
    }

    const now = this.deps.clock.now();
    const wallet = await this.deps.repository.getOverview({
      vendorId: parsed.vendorId,
      ledgerLimit: 1,
      now,
    });
    const setting = wallet.autoReload;
    if (!setting?.enabled) {
      return this.skipAutoReload(parsed, "auto_reload_disabled", wallet.account.currency);
    }
    if (!setting.fundingMethodId) {
      return this.skipAutoReload(parsed, "funding_method_required", wallet.account.currency);
    }

    const fundingMethod = wallet.fundingMethods.find((method) => method.fundingMethodId === setting.fundingMethodId);
    if (!fundingMethod) {
      return this.skipAutoReload(parsed, "funding_method_missing", wallet.account.currency, setting.fundingMethodId);
    }
    if (fundingMethod.status !== "active") {
      return this.skipAutoReload(parsed, "funding_method_not_active", wallet.account.currency, fundingMethod.fundingMethodId);
    }
    // A held order cannot wait days for ACH to settle, so the shortfall is
    // always charged to a card; the configured method serves only the routine
    // top-up. Routine reloads charge whatever the vendor configured.
    const chargeMethod = parsed.reason === "payment_hold"
      ? selectPaymentHoldCard(wallet.fundingMethods, fundingMethod)
      : fundingMethod;
    if (!chargeMethod) {
      return this.skipAutoReload(parsed, "card_backstop_unavailable", wallet.account.currency, fundingMethod.fundingMethodId);
    }
    // The rail check sits on the method being charged, not the configured one:
    // a routine reload on USDC is refused here, and this is also where the
    // type narrows to the two Stripe rails the provider accepts.
    if (chargeMethod.rail !== "stripe_card" && chargeMethod.rail !== "stripe_ach") {
      return this.skipAutoReload(parsed, "funding_method_rail_unsupported", wallet.account.currency, chargeMethod.fundingMethodId);
    }
    if (!chargeMethod.providerCustomerId || !chargeMethod.providerPaymentMethodId) {
      return this.skipAutoReload(parsed, "funding_method_provider_identity_required", wallet.account.currency, chargeMethod.fundingMethodId);
    }

    // The policy in force: the fee rate for the charge and, for a held order,
    // the ceiling on any single payment. A held order's card charge covers its
    // whole gap (funding design phase 7); routine reloads keep the vendor's own
    // bound.
    const limits = await this.walletLimits();
    const chargeCeilingCents = parsed.reason === "payment_hold" ? limits.manualFundingMaxCents : null;
    const amount = calculateAutoReloadAmount({
      availableBalanceCents: wallet.account.availableBalanceCents,
      pendingBalanceCents: wallet.account.pendingBalanceCents,
      minimumBalanceCents: setting.minimumBalanceCents,
      topUpAmountCents: setting.topUpAmountCents,
      maxSingleReloadCents: setting.maxSingleReloadCents,
      chargeCeilingCents,
      requiredBalanceCents: parsed.requiredBalanceCents ?? null,
      reason: parsed.reason,
    });
    if (amount.outcome === "skipped") {
      return this.skipAutoReload(parsed, amount.skipReason, wallet.account.currency, chargeMethod.fundingMethodId);
    }

    // The reload amount is what the wallet receives; a card is charged that
    // plus the fee. The wallet is credited from the quote, never from what
    // Stripe echoes back, and the two are cross-checked so a charge that does
    // not match the quote is refused rather than booked.
    const quote = this.quoteFunding(chargeMethod.rail, amount.amountCents, this.unattendedFeeBps(limits, setting));
    const paymentIntent = await provider.createStripeAutoReloadPaymentIntent({
      vendorId: parsed.vendorId,
      fundingMethodId: chargeMethod.fundingMethodId,
      rail: chargeMethod.rail,
      amountCents: quote.creditCents,
      cardFee: cardFeeForProvider(quote),
      currency: wallet.account.currency,
      providerCustomerId: chargeMethod.providerCustomerId,
      providerPaymentMethodId: chargeMethod.providerPaymentMethodId,
      reason: parsed.reason,
      intakeId: parsed.intakeId ?? null,
      requiredBalanceCents: parsed.requiredBalanceCents ?? null,
      idempotencyKey: `dropship-auto-reload:${parsed.idempotencyKey}`,
      now,
    });
    if (paymentIntent.amountCents !== quote.chargedCents) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_AUTO_RELOAD_AMOUNT_MISMATCH",
        "Stripe charged an amount that does not match the auto-reload quote.",
        {
          vendorId: parsed.vendorId,
          fundingMethodId: chargeMethod.fundingMethodId,
          providerPaymentIntentId: paymentIntent.providerPaymentIntentId,
          chargedCents: paymentIntent.amountCents,
          expectedChargedCents: quote.chargedCents,
          creditCents: quote.creditCents,
          cardFeeCents: quote.feeCents,
        },
      );
    }
    const funding = await this.creditFunding({
      vendorId: parsed.vendorId,
      fundingMethodId: chargeMethod.fundingMethodId,
      rail: chargeMethod.rail,
      status: paymentIntent.status,
      amountCents: quote.creditCents,
      cardFee: cardFeeForCredit(quote),
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
        fundingMethodId: chargeMethod.fundingMethodId,
        amountCents: quote.creditCents,
        // A routine refill: how far under the minimum the wallet sat, and
        // whether the per-charge bound left some of that for the next run.
        refillShortfallCents: amount.refill?.shortfallCents ?? null,
        refillPartial: amount.refill?.partial ?? false,
        cardFeeCents: quote.feeCents,
        cardFeeBps: quote.feeBps,
        chargedCents: quote.chargedCents,
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
      fundingMethodId: chargeMethod.fundingMethodId,
      amountCents: quote.creditCents,
      cardFeeCents: quote.feeCents,
      chargedCents: quote.chargedCents,
      currency: paymentIntent.currency,
      providerPaymentIntentId: paymentIntent.providerPaymentIntentId,
      fundingLedgerEntryId: funding.ledgerEntry.ledgerEntryId,
      fundingStatus: paymentIntent.status,
      skipReason: null,
      idempotentReplay: funding.idempotentReplay,
    };
  }

  /**
   * A Stripe payment that failed after the wallet recorded it. For an ACH
   * debit that is the bank returning it, days after the credit showed as
   * pending: the pending credit is voided first, so the balance stops counting
   * money that is not coming, and only then is the vendor told. A failure for
   * a payment the wallet never recorded (a card declined at charge time) has
   * nothing to void and only notifies. A replayed webhook finds the entry
   * already failed and changes nothing.
   */
  async recordWalletFundingFailure(input: unknown): Promise<DropshipWalletFundingFailureResult> {
    const parsed = parseWalletInput(recordDropshipWalletFundingFailureInputSchema, input);
    const pauseReason = standingReasonForFailedFunding(parsed.rail ?? null);
    const pauseEvidence = {
      source: "funding_webhook",
      provider: parsed.provider,
      providerEventId: parsed.providerEventId,
      providerPaymentIntentId: parsed.providerPaymentIntentId,
      failureCode: parsed.failureCode ?? null,
      failureMessage: parsed.failureMessage ?? null,
      rail: parsed.rail ?? null,
      amountCents: parsed.amountCents,
      currency: parsed.currency,
      autoReload: parsed.autoReload,
      intakeId: parsed.intakeId ?? null,
    };
    const voided = await this.deps.repository.failPendingFunding({
      vendorId: parsed.vendorId,
      referenceType: "stripe_payment_intent",
      referenceId: parsed.providerPaymentIntentId,
      failureCode: parsed.failureCode ?? null,
      failureMessage: parsed.failureMessage ?? null,
      providerStatus: parsed.providerStatus ?? null,
      providerEventId: parsed.providerEventId,
      occurredAt: this.deps.clock.now(),
      // A credit the wallet counted on and the bank refused is the first hard
      // decline: the vendor is paused in the same transaction as the void, so
      // the two facts are never recorded apart.
      pauseVendor: { reason: pauseReason, evidence: pauseEvidence },
    });
    const pendingCreditVoided = voided !== null && !voided.idempotentReplay;
    const ledgerEntryId = voided?.ledgerEntry.ledgerEntryId ?? null;
    const vendorPaused = voided?.vendorPaused ?? null;

    this.deps.logger.warn({
      code: "DROPSHIP_WALLET_FUNDING_FAILED",
      message: "Dropship wallet funding failed.",
      context: {
        vendorId: parsed.vendorId,
        fundingMethodId: parsed.fundingMethodId ?? null,
        rail: parsed.rail ?? null,
        amountCents: parsed.amountCents,
        currency: parsed.currency,
        provider: parsed.provider,
        providerEventId: parsed.providerEventId,
        providerPaymentIntentId: parsed.providerPaymentIntentId,
        providerStatus: parsed.providerStatus ?? null,
        failureCode: parsed.failureCode ?? null,
        autoReload: parsed.autoReload,
        intakeId: parsed.intakeId ?? null,
        pendingCreditVoided,
        ledgerEntryId,
        pendingBalanceAfterCents: voided?.account.pendingBalanceCents ?? null,
        vendorPaused: vendorPaused !== null,
        standingRevision: vendorPaused?.standingRevision ?? null,
      },
    });

    // The pause notice tells the vendor what failed and what to do, so the
    // generic funding-failed notice is only sent when no pause went out.
    const pauseAnnounced = vendorPaused !== null
      && await this.announceVendorPauseSafely(parsed.vendorId, { ...pauseEvidence, ledgerEntryId });
    if (pauseAnnounced) {
      return { pendingCreditVoided, ledgerEntryId, vendorPaused: true };
    }

    await sendDropshipNotificationSafely(this.deps, {
      vendorId: parsed.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.WALLET_FUNDING_FAILED,
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship wallet funding failed",
      message: `Wallet funding for ${formatNotificationCurrency(parsed.amountCents, parsed.currency)} failed${parsed.failureMessage ? `: ${parsed.failureMessage}` : "."}${pendingCreditVoided ? " The pending credit has been removed from your balance." : ""}${negativeBalanceSentenceFor(voided?.account ?? null)}`,
      payload: {
        vendorId: parsed.vendorId,
        fundingMethodId: parsed.fundingMethodId ?? null,
        rail: parsed.rail ?? null,
        amountCents: parsed.amountCents,
        currency: parsed.currency,
        provider: parsed.provider,
        providerEventId: parsed.providerEventId,
        providerPaymentIntentId: parsed.providerPaymentIntentId,
        providerStatus: parsed.providerStatus ?? null,
        failureCode: parsed.failureCode ?? null,
        failureMessage: parsed.failureMessage ?? null,
        autoReload: parsed.autoReload,
        autoReloadReason: parsed.autoReloadReason ?? null,
        intakeId: parsed.intakeId ?? null,
        pendingCreditVoided,
        ledgerEntryId,
      },
      idempotencyKey: parsed.idempotencyKey,
    }, {
      code: "DROPSHIP_WALLET_FUNDING_FAILURE_NOTIFICATION_FAILED",
      message: "Dropship wallet funding failure notification failed.",
      context: {
        vendorId: parsed.vendorId,
        fundingMethodId: parsed.fundingMethodId ?? null,
        provider: parsed.provider,
        providerPaymentIntentId: parsed.providerPaymentIntentId,
        pendingCreditVoided,
        ledgerEntryId,
      },
    });

    return { pendingCreditVoided, ledgerEntryId, vendorPaused: vendorPaused !== null };
  }

  /**
   * A settled credit the provider has taken back: a card chargeback, or an
   * ACH debit returned after it cleared (funding design phase 4). The
   * reversal posts against the credit and the vendor is paused in the same
   * transaction, then the vendor is told once. An inquiry that has not
   * withdrawn funds moves nothing yet; a dispute on a payment the wallet never
   * recorded is not ours; a replayed webhook finds the reversal and moves
   * nothing.
   */
  async recordWalletFundingReversal(input: unknown): Promise<DropshipWalletFundingReversalResult> {
    const parsed = parseWalletInput(recordDropshipWalletFundingReversalInputSchema, input);
    const context = {
      provider: parsed.provider,
      providerEventId: parsed.providerEventId,
      providerDisputeId: parsed.providerDisputeId,
      providerPaymentIntentId: parsed.providerPaymentIntentId,
      amountCents: parsed.amountCents,
      currency: parsed.currency,
      disputeStatus: parsed.status,
      disputeReason: parsed.reason,
    };
    if (!parsed.fundsWithdrawn) {
      this.deps.logger.info({
        code: "DROPSHIP_WALLET_FUNDING_DISPUTE_OPENED",
        message: "Dropship wallet funding dispute was opened without withdrawing funds; nothing moves until it does.",
        context,
      });
      return { outcome: "deferred" };
    }
    const pauseEvidence = {
      source: "dispute_webhook",
      disputed: true,
      ...context,
    };
    const result = await this.deps.repository.reverseSettledFunding({
      provider: parsed.provider,
      providerPaymentIntentId: parsed.providerPaymentIntentId,
      providerDisputeId: parsed.providerDisputeId,
      providerEventId: parsed.providerEventId,
      disputeAmountCents: parsed.amountCents,
      currency: parsed.currency,
      disputeStatus: parsed.status,
      disputeReason: parsed.reason,
      occurredAt: this.deps.clock.now(),
      // The money is gone whichever rail it came over: the vendor is paused
      // in the same transaction as the reversal, so the two facts never part.
      pauseVendor: { reason: DROPSHIP_FUNDING_REVERSAL_STANDING_REASON, evidence: pauseEvidence },
    });
    if (!result) {
      // Every dispute on the Stripe account arrives here; one on a payment the
      // wallet never recorded belongs to another product.
      this.deps.logger.info({
        code: "DROPSHIP_WALLET_FUNDING_DISPUTE_UNMATCHED",
        message: "Dropship wallet funding dispute did not match a recorded funding credit.",
        context,
      });
      return { outcome: "not_applicable" };
    }
    if (result.outcome === "ignored") {
      this.deps.logger.warn({
        code: "DROPSHIP_WALLET_FUNDING_REVERSAL_IGNORED",
        message: "Dropship wallet funding dispute matched a credit that cannot be reversed as reported; a human should look.",
        context: { ...context, vendorId: result.vendorId, creditLedgerEntryId: result.credit.ledgerEntryId, creditStatus: result.credit.status, creditCurrency: result.credit.currency, reason: result.reason },
      });
      return { outcome: "ignored", reason: result.reason };
    }
    const reversalCents = -result.reversal.amountCents;
    this.deps.logger.warn({
      code: "DROPSHIP_WALLET_FUNDING_REVERSED",
      message: "Dropship wallet funding credit was reversed by a dispute.",
      context: {
        ...context,
        vendorId: result.vendorId,
        creditLedgerEntryId: result.credit.ledgerEntryId,
        reversalLedgerEntryId: result.reversal.ledgerEntryId,
        reversalCents,
        availableBalanceAfterCents: result.account.availableBalanceCents,
        vendorPaused: result.vendorPaused !== null,
        standingRevision: result.vendorPaused?.standingRevision ?? null,
        idempotentReplay: result.idempotentReplay,
      },
    });
    const summary = {
      outcome: "reversed" as const,
      vendorId: result.vendorId,
      reversalLedgerEntryId: result.reversal.ledgerEntryId,
      reversalCents,
      availableBalanceAfterCents: result.account.availableBalanceCents,
      vendorPaused: result.vendorPaused !== null,
      idempotentReplay: result.idempotentReplay,
    };
    if (result.idempotentReplay) {
      return summary;
    }
    // The pause notice tells the vendor what was reversed and what to do, so
    // the reversal notice is only sent when no pause went out.
    const pauseAnnounced = result.vendorPaused !== null
      && await this.announceVendorPauseSafely(result.vendorId, { ...pauseEvidence, ledgerEntryId: result.reversal.ledgerEntryId });
    if (pauseAnnounced) {
      return summary;
    }
    const credited = formatNotificationDate(result.credit.settledAt ?? result.credit.createdAt);
    const balance = formatNotificationCurrency(result.account.availableBalanceCents, result.account.currency);
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: result.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.WALLET_FUNDING_REVERSED,
      critical: true,
      channels: ["email", "in_app"],
      title: "A payment to your wallet was reversed",
      message: `Your bank reversed ${formatNotificationCurrency(reversalCents, result.account.currency)} that you added on ${credited}. That amount has been taken back out of your wallet, leaving ${balance}.${result.account.availableBalanceCents < 0 ? " Your wallet is below zero until funds are added; the daily wallet run collects the shortfall from your saved funding source when one is set up." : ""}`,
      payload: {
        ...context,
        vendorId: result.vendorId,
        creditLedgerEntryId: result.credit.ledgerEntryId,
        reversalLedgerEntryId: result.reversal.ledgerEntryId,
        reversalCents,
        availableBalanceAfterCents: result.account.availableBalanceCents,
      },
      idempotencyKey: `stripe-dispute-reversed:${parsed.providerDisputeId}`,
    }, {
      code: "DROPSHIP_WALLET_FUNDING_REVERSAL_NOTIFICATION_FAILED",
      message: "Dropship wallet funding reversal notification failed after the reversal committed.",
      context: { ...context, vendorId: result.vendorId, reversalLedgerEntryId: result.reversal.ledgerEntryId },
    });
    return summary;
  }

  /**
   * A dispute closed. Won: the provider returns the funds and the wallet
   * credits the reversal back, then checks whether the vendor can resume.
   * Lost: the reversal stands and only the log says so. Any other status
   * changes nothing.
   */
  async recordWalletFundingDisputeOutcome(input: unknown): Promise<DropshipWalletDisputeOutcomeResult> {
    const parsed = parseWalletInput(recordDropshipWalletDisputeOutcomeInputSchema, input);
    const context = {
      provider: parsed.provider,
      providerEventId: parsed.providerEventId,
      providerDisputeId: parsed.providerDisputeId,
      providerPaymentIntentId: parsed.providerPaymentIntentId,
      amountCents: parsed.amountCents,
      currency: parsed.currency,
      disputeStatus: parsed.status,
    };
    if (!parsed.fundsReinstated) {
      const lost = disputeOutcomeFor(parsed.status) === "lost";
      const event = {
        code: lost ? "DROPSHIP_WALLET_FUNDING_DISPUTE_LOST" : "DROPSHIP_WALLET_FUNDING_DISPUTE_UNCHANGED",
        message: lost
          ? "Dropship wallet funding dispute was lost; the reversal stands."
          : "Dropship wallet funding dispute event changed nothing.",
        context,
      };
      if (lost) this.deps.logger.warn(event);
      else this.deps.logger.info(event);
      return { outcome: "unchanged" };
    }
    const result = await this.deps.repository.reinstateReversedFunding({
      provider: parsed.provider,
      providerDisputeId: parsed.providerDisputeId,
      providerEventId: parsed.providerEventId,
      occurredAt: this.deps.clock.now(),
    });
    if (!result) {
      this.deps.logger.info({
        code: "DROPSHIP_WALLET_FUNDING_REINSTATEMENT_UNMATCHED",
        message: "Dropship wallet funding dispute was won but no reversal was recorded for it; nothing to credit back.",
        context,
      });
      return { outcome: "not_applicable" };
    }
    this.deps.logger.info({
      code: "DROPSHIP_WALLET_FUNDING_REINSTATED",
      message: "Dropship wallet funding reversal was credited back after the dispute was won.",
      context: {
        ...context,
        vendorId: result.vendorId,
        reversalLedgerEntryId: result.reversal.ledgerEntryId,
        reinstatementLedgerEntryId: result.reinstatement.ledgerEntryId,
        amountCents: result.reinstatement.amountCents,
        availableBalanceAfterCents: result.account.availableBalanceCents,
        idempotentReplay: result.idempotentReplay,
      },
    });
    const summary = {
      outcome: "reinstated" as const,
      vendorId: result.vendorId,
      reinstatementLedgerEntryId: result.reinstatement.ledgerEntryId,
      amountCents: result.reinstatement.amountCents,
      availableBalanceAfterCents: result.account.availableBalanceCents,
      idempotentReplay: result.idempotentReplay,
    };
    if (result.idempotentReplay) {
      return summary;
    }
    await this.restoreVendorStandingIfFunded(result.vendorId, {
      source: "dispute_webhook",
      ...context,
      reinstatementLedgerEntryId: result.reinstatement.ledgerEntryId,
    });
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: result.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.WALLET_FUNDING_REINSTATED,
      critical: false,
      channels: ["email", "in_app"],
      title: "A reversed payment was returned to your wallet",
      message: `The dispute on ${formatNotificationCurrency(result.reinstatement.amountCents, result.account.currency)} you added was resolved in your favour, and that amount is back in your wallet, leaving ${formatNotificationCurrency(result.account.availableBalanceCents, result.account.currency)}.`,
      payload: {
        ...context,
        vendorId: result.vendorId,
        reversalLedgerEntryId: result.reversal.ledgerEntryId,
        reinstatementLedgerEntryId: result.reinstatement.ledgerEntryId,
        amountCents: result.reinstatement.amountCents,
        availableBalanceAfterCents: result.account.availableBalanceCents,
      },
      idempotencyKey: `stripe-dispute-reinstated:${parsed.providerDisputeId}`,
    }, {
      code: "DROPSHIP_WALLET_FUNDING_REINSTATEMENT_NOTIFICATION_FAILED",
      message: "Dropship wallet funding reinstatement notification failed after the credit committed.",
      context: { ...context, vendorId: result.vendorId, reinstatementLedgerEntryId: result.reinstatement.ledgerEntryId },
    });
    return summary;
  }

  /**
   * The pause is already committed; announcing it (vendor notice, listing
   * hold) must not fail the webhook, which would only replay a void that no
   * longer changes anything. A failure is logged for a human; the hourly
   * standing reconcile still lands the listing hold.
   */
  private async announceVendorPauseSafely(vendorId: number, evidence: Record<string, unknown>): Promise<boolean> {
    if (!this.deps.vendorStanding) {
      this.deps.logger.warn({
        code: "DROPSHIP_VENDOR_PAUSE_UNANNOUNCED",
        message: "Dropship vendor was paused by a voided funding credit but no standing service is configured to announce it.",
        context: { vendorId },
      });
      return false;
    }
    try {
      const change = await this.deps.vendorStanding.announcePause({ vendorId, evidence });
      return change.outcome === "paused";
    } catch (error) {
      this.deps.logger.error({
        code: "DROPSHIP_VENDOR_PAUSE_ANNOUNCE_FAILED",
        message: "Dropship vendor pause was recorded but could not be announced; the vendor gets the funding-failed notice instead.",
        context: { vendorId, error: error instanceof Error ? error.message : String(error) },
      });
      return false;
    }
  }

  /**
   * A settled credit may be what a paused vendor was waiting for. The check
   * is best-effort here: the hourly standing reconcile repeats it, so a
   * failure is logged and never fails the credit that was just recorded.
   */
  private async restoreVendorStandingIfFunded(vendorId: number, evidence: Record<string, unknown>): Promise<void> {
    if (!this.deps.vendorStanding) {
      return;
    }
    try {
      await this.deps.vendorStanding.restoreIfFunded({ vendorId, evidence });
    } catch (error) {
      this.deps.logger.error({
        code: "DROPSHIP_VENDOR_RESTORE_FAILED",
        message: "Dropship vendor standing could not be checked after a settled credit; the hourly reconcile retries.",
        context: { vendorId, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async registerFundingMethod(input: unknown): Promise<DropshipFundingMethodMutationResult> {
    const parsed = normalizeFundingMethodInput(parseWalletInput(registerDropshipFundingMethodInputSchema, input));
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

  async registerUsdcBaseFundingMethodForMember(
    memberId: string,
    input: unknown,
  ): Promise<DropshipFundingMethodMutationResult> {
    const parsed = parseWalletInput(registerDropshipUsdcBaseFundingMethodForMemberInputSchema, input);
    const provisioned = await this.provisionVendor(memberId);
    return this.registerFundingMethod({
      vendorId: provisioned.vendor.vendorId,
      rail: "usdc_base",
      status: "active",
      providerCustomerId: null,
      providerPaymentMethodId: null,
      usdcWalletAddress: normalizeUsdcBaseAddress(parsed.walletAddress),
      displayLabel: parsed.displayLabel ?? "USDC on Base",
      isDefault: parsed.isDefault,
      metadata: {
        provider: "usdc_base",
        registeredByMemberId: memberId,
      },
    });
  }

  /**
   * Remove a saved funding method for the signed-in member (wallet "Saved
   * methods"). The method is archived in our ledger first — every charge path
   * requires `active`, so that alone stops the money — and only then detached
   * at the provider. A detach that does not complete never un-archives
   * anything: its outcome is recorded on the method and reported, so the
   * vendor's screen and the audit trail both say the provider side is still
   * owed. Replaying the request returns the stored state and detaches nothing
   * twice.
   */
  async removeFundingMethodForMember(
    memberId: string,
    input: unknown,
  ): Promise<DropshipFundingMethodRemovalResult> {
    const parsed = parseWalletInput(removeDropshipFundingMethodForMemberInputSchema, input);
    const provisioned = await this.provisionVendor(memberId);
    const vendorId = provisioned.vendor.vendorId;
    const archived = await this.deps.repository.archiveFundingMethod({
      vendorId,
      fundingMethodId: parsed.fundingMethodId,
      actorMemberId: memberId,
      archivedAt: this.deps.clock.now(),
    });
    if (archived.idempotentReplay) {
      return {
        fundingMethod: archived.fundingMethod,
        idempotentReplay: true,
        providerDetach: detachOutcomeOnReplay(archived.fundingMethod),
      };
    }
    this.deps.logger.info({
      code: "DROPSHIP_FUNDING_METHOD_ARCHIVED",
      message: "Dropship funding method was removed from the wallet; nothing charges it from here on.",
      context: {
        vendorId,
        fundingMethodId: archived.fundingMethod.fundingMethodId,
        rail: archived.fundingMethod.rail,
        memberId,
      },
    });
    const detach = await this.detachArchivedMethodAtProvider(archived.fundingMethod);
    const fundingMethod = await this.recordDetachOutcome(archived.fundingMethod, detach);
    return { fundingMethod, idempotentReplay: false, providerDetach: detach.outcome };
  }

  /**
   * The provider-side half of a removal. Only Stripe rails have something to
   * detach; a failure is classified into what the archived method reports:
   * `pending` when the provider could not be reached (the detach is owed) and
   * `requires_review` when it refused (a human reconciles Stripe's side).
   */
  private async detachArchivedMethodAtProvider(
    method: DropshipFundingMethodRecord,
  ): Promise<{ outcome: DropshipFundingMethodDetachOutcome; errorCode: string | null }> {
    const context = { vendorId: method.vendorId, fundingMethodId: method.fundingMethodId, rail: method.rail };
    if (!isStripeRail(method.rail) || method.providerPaymentMethodId === null) {
      return { outcome: "not_applicable", errorCode: null };
    }
    const provider = this.deps.fundingProvider;
    if (!provider) {
      this.deps.logger.warn({
        code: "DROPSHIP_FUNDING_METHOD_DETACH_DEFERRED",
        message: "No funding provider is configured; the provider-side removal of the method is still owed.",
        context,
      });
      return { outcome: "pending", errorCode: "DROPSHIP_FUNDING_PROVIDER_NOT_CONFIGURED" };
    }
    try {
      const result = await provider.detachPaymentMethod({ providerPaymentMethodId: method.providerPaymentMethodId });
      this.deps.logger.info({
        code: "DROPSHIP_FUNDING_METHOD_DETACHED",
        message: "The removed funding method was detached at the provider.",
        context: { ...context, outcome: result.outcome },
      });
      return { outcome: result.outcome, errorCode: null };
    } catch (error) {
      const classification = error instanceof DropshipError ? error.context?.classification : undefined;
      const outcome: DropshipFundingMethodDetachOutcome = classification === "transient" ? "pending" : "requires_review";
      const errorCode = error instanceof DropshipError
        ? error.code
        : error instanceof Error ? error.name : "unknown_error";
      const event = {
        code: "DROPSHIP_FUNDING_METHOD_DETACH_FAILED",
        message: outcome === "pending"
          ? "The provider could not be reached to detach a removed funding method; the method stays archived and the detach is owed."
          : "The provider refused to detach a removed funding method; the method stays archived and the provider side needs review.",
        context: { ...context, outcome, errorCode, classification: classification ?? null },
      };
      if (outcome === "pending") {
        this.deps.logger.warn(event);
      } else {
        this.deps.logger.error(event);
      }
      return { outcome, errorCode };
    }
  }

  private async recordDetachOutcome(
    method: DropshipFundingMethodRecord,
    detach: { outcome: DropshipFundingMethodDetachOutcome; errorCode: string | null },
  ): Promise<DropshipFundingMethodRecord> {
    try {
      return await this.deps.repository.recordFundingMethodDetachOutcome({
        vendorId: method.vendorId,
        fundingMethodId: method.fundingMethodId,
        outcome: detach.outcome,
        errorCode: detach.errorCode,
        recordedAt: this.deps.clock.now(),
      });
    } catch (error) {
      // Deliberate: the removal is committed and nothing charges the method any
      // more. Losing the bookkeeping of the provider outcome must not undo that
      // or make the vendor retry, so it is an ERROR line for an operator rather
      // than a failed request. The response still carries the outcome computed
      // above.
      this.deps.logger.error({
        code: "DROPSHIP_FUNDING_METHOD_DETACH_RECORD_FAILED",
        message: "The provider detach outcome of a removed funding method could not be recorded.",
        context: {
          vendorId: method.vendorId,
          fundingMethodId: method.fundingMethodId,
          outcome: detach.outcome,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return method;
    }
  }

  /**
   * The wallet policy limits in force. The injected resolver reads the active
   * policy row; with no resolver wired the documented environment fallback is
   * used, which is what every caller got before the policy table existed.
   */
  private async walletLimits(): Promise<DropshipWalletPolicyLimits> {
    return this.deps.walletPolicy
      ? this.deps.walletPolicy.resolveWalletLimits()
      : resolveDropshipWalletPolicyLimitsFromEnv();
  }

  /** The card fee rate in force: the injected override under test, else the policy's. */
  private feeBpsFrom(limits: Pick<DropshipWalletPolicyLimits, "cardFundingFeeBps">): number {
    return this.deps.cardFundingFeeBps ?? limits.cardFundingFeeBps;
  }

  /**
   * The rate an unattended card charge (a routine top-up, a backup-card cover)
   * may carry: never above the rate the vendor acknowledged when they turned
   * autopay on. Staff can raise the policy's fee, and the mandate promises the
   * vendor confirms before paying more, so until they re-acknowledge, the rate
   * they agreed to holds. A lower live rate always applies. A row without an
   * acknowledgement (saved by an older client) pays the live rate, as before.
   */
  private unattendedFeeBps(
    limits: Pick<DropshipWalletPolicyLimits, "cardFundingFeeBps">,
    setting: { acknowledgedCardFeeBps: number | null },
  ): number {
    const live = this.feeBpsFrom(limits);
    // A row read before migration 0701 carries no acknowledgement at all.
    const acknowledged = setting.acknowledgedCardFeeBps ?? null;
    return acknowledged === null ? live : Math.min(live, acknowledged);
  }

  /**
   * A manual USDC credit is only ever for a transfer to an address Card
   * Shellz controls: the vendor's own deposit address (funding design phase
   * 6) or the shared address, when either is configured.
   */
  private async assertUsdcDepositAddressIsOurs(vendorId: number, toAddress: string): Promise<void> {
    const own = this.deps.usdcDepositAddressLookup ? await this.deps.usdcDepositAddressLookup(vendorId) : null;
    const shared = this.usdcBaseDepositAddress();
    const allowed = [own, shared].filter((address): address is string => address !== null).map((address) => address.toLowerCase());
    if (!allowed.includes(toAddress)) {
      throw new DropshipError(
        "DROPSHIP_USDC_DEPOSIT_ADDRESS_UNKNOWN",
        allowed.length === 0
          ? "No USDC deposit address is configured for this vendor; the transfer cannot be attributed."
          : "The transfer was not sent to this vendor's deposit address or the shared deposit address.",
        { vendorId, toAddress, allowedAddresses: allowed, classification: "permanent" },
      );
    }
  }

  private usdcBaseDepositAddress(): string | null {
    return this.deps.usdcBaseDepositAddress === undefined
      ? resolveDropshipUsdcBaseDepositAddress()
      : this.deps.usdcBaseDepositAddress;
  }

  private quoteFunding(rail: DropshipStripeFundingSetupRail, creditCents: number, cardFeeBps: number): WalletFundingQuote {
    return quoteWalletFunding({ rail, creditCents, cardFeeBps });
  }

  private async provisionVendor(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    return this.deps.vendorProvisioning.provisionForMember(memberId);
  }

  /**
   * The card backstop is a launch requirement, so it cannot be withdrawn while
   * the vendor is live. An active vendor with auto-reload off accumulates
   * payment holds that cancel on the marketplace, which damages their seller
   * standing before anyone notices. Vendors who are not live may configure
   * freely.
   */
  private async assertAutoReloadMayBeDisabled(
    input: ConfigureDropshipAutoReloadInput,
  ): Promise<void> {
    if (input.enabled) {
      return;
    }
    const vendorStatus = await this.deps.repository.getVendorLifecycleStatus(input.vendorId);
    if (vendorStatus === "active") {
      throw new DropshipError(
        "DROPSHIP_AUTO_RELOAD_REQUIRED_WHILE_ACTIVE",
        "Auto-reload cannot be turned off while the vendor account is active.",
        { vendorId: input.vendorId, vendorStatus },
      );
    }
  }

  private async assertAutoReloadFundingMethodIsUsable(
    input: ConfigureDropshipAutoReloadInput,
    now: Date,
  ): Promise<void> {
    if (!input.enabled || !input.fundingMethodId) {
      return;
    }
    const wallet = await this.deps.repository.getOverview({
      vendorId: input.vendorId,
      ledgerLimit: 1,
      now,
    });
    const fundingMethod = wallet.fundingMethods.find((method) =>
      method.fundingMethodId === input.fundingMethodId
    );
    if (!fundingMethod) {
      throw new DropshipError(
        "DROPSHIP_FUNDING_METHOD_NOT_FOUND",
        "Dropship funding method was not found.",
        { vendorId: input.vendorId, fundingMethodId: input.fundingMethodId },
      );
    }
    if (fundingMethod.status !== "active") {
      throw new DropshipError(
        "DROPSHIP_FUNDING_METHOD_NOT_ACTIVE",
        "Dropship funding method is not active.",
        {
          vendorId: input.vendorId,
          fundingMethodId: input.fundingMethodId,
          status: fundingMethod.status,
        },
      );
    }
    // Card or ACH. Auto-reload's routine job (minimum_balance) is topping the
    // wallet up for FUTURE orders once the balance dips under the trigger, and
    // ACH is fine for that as long as the trigger leaves enough runway for it
    // to settle. The one case ACH cannot serve — an order already waiting on a
    // short balance — is charged to the card on file instead (see
    // selectPaymentHoldCard), so the routine method is free to be ACH.
    if (fundingMethod.rail !== "stripe_card" && fundingMethod.rail !== "stripe_ach") {
      throw new DropshipError(
        "DROPSHIP_AUTO_RELOAD_FUNDING_METHOD_RAIL_UNSUPPORTED",
        "Auto-reload requires a Stripe card or ACH funding method.",
        {
          vendorId: input.vendorId,
          fundingMethodId: input.fundingMethodId,
          rail: fundingMethod.rail,
        },
      );
    }
  }
}

function normalizeFundingMethodInput(
  input: RegisterDropshipFundingMethodInput,
): RegisterDropshipFundingMethodInput {
  if (input.rail !== "usdc_base") {
    return input;
  }
  return {
    ...input,
    providerCustomerId: null,
    providerPaymentMethodId: null,
    usdcWalletAddress: normalizeUsdcBaseAddress(input.usdcWalletAddress),
  };
}

function normalizeConfirmedUsdcFundingInput(
  input: CreditDropshipWalletConfirmedUsdcFundingInput,
): CreditDropshipWalletConfirmedUsdcFundingInput {
  return {
    ...input,
    transactionHash: normalizeUsdcBaseHash(input.transactionHash),
    fromAddress: input.fromAddress ? normalizeUsdcBaseAddress(input.fromAddress) : null,
    toAddress: normalizeUsdcBaseAddress(input.toAddress),
  };
}

/**
 * How much to credit so the wallet reaches its target.
 *
 * A routine top-up counts credits that are still settling: an ACH reload takes
 * days to land, and charging again on every run until it does would stack
 * reloads on top of money that is already on its way. A held order cannot
 * spend pending money, so the backstop measures against the available balance
 * alone and charges the card for the whole gap.
 */
/**
 * What a reload puts in the wallet.
 *
 * A routine top-up restores the vendor's minimum, counting credits still
 * settling so an ACH reload in flight is not stacked. A held order's backstop
 * charge follows the funding design's card rule (domain/acceptance-funding.ts,
 * decideCardBackstopCharge): back to the minimum, or the vendor's single
 * top-up limit when that is smaller, and never less than the order's gap —
 * pending money does not count, because the order cannot wait for it.
 */
function calculateAutoReloadAmount(input: {
  availableBalanceCents: number;
  pendingBalanceCents: number;
  minimumBalanceCents: number;
  topUpAmountCents: number | null;
  maxSingleReloadCents: number | null;
  /** The program's ceiling on any single payment; only a held order's charge is measured against it. */
  chargeCeilingCents: number | null;
  requiredBalanceCents: number | null;
  reason: HandleDropshipAutoReloadInput["reason"];
}):
  | { outcome: "funding_created"; amountCents: number; refill: { shortfallCents: number; partial: boolean } | null }
  | { outcome: "skipped"; skipReason: string } {
  if (input.reason === "payment_hold") {
    const charge = decideCardBackstopCharge({
      availableBalanceCents: input.availableBalanceCents,
      minimumBalanceCents: input.minimumBalanceCents,
      requiredBalanceCents: input.requiredBalanceCents ?? 0,
      singleChargeLimitCents: input.maxSingleReloadCents,
      chargeCeilingCents: input.chargeCeilingCents,
    });
    if (charge.outcome === "not_needed") {
      return { outcome: "skipped", skipReason: "balance_already_sufficient" };
    }
    if (charge.outcome === "ceiling_below_gap") {
      return { outcome: "skipped", skipReason: "amount_exceeds_funding_ceiling" };
    }
    return { outcome: "funding_created", amountCents: charge.amountCents, refill: null };
  }
  // A routine refill pulls the top-up amount (the minimum by default), or the
  // whole shortfall when that is more, and never more than the per-charge
  // bound: a deep negative is collected over several runs, never skipped.
  const refill = decideAutopayRefill({
    availableBalanceCents: input.availableBalanceCents,
    pendingBalanceCents: input.pendingBalanceCents,
    minimumBalanceCents: input.minimumBalanceCents,
    topUpAmountCents: input.topUpAmountCents,
    singleChargeBoundCents: input.maxSingleReloadCents,
  });
  if (refill.outcome === "not_needed") {
    return { outcome: "skipped", skipReason: "balance_already_sufficient" };
  }
  return {
    outcome: "funding_created",
    amountCents: refill.amountCents,
    refill: { shortfallCents: refill.shortfallCents, partial: refill.partial },
  };
}

/**
 * Skip reasons that mean the wallet has no usable backstop. Each one leaves the
 * next order that outruns the balance in payment hold, so they are anomalies a
 * human should see, not routine outcomes. `auto_reload_disabled`,
 * `balance_already_sufficient` and `amount_exceeds_funding_ceiling` are
 * deliberately absent: those are the policy working as configured (a held
 * order above the ceiling is already reported by the hold notice).
 */
const AUTO_RELOAD_SKIPS_NEEDING_ATTENTION: ReadonlySet<string> = new Set([
  "funding_provider_not_configured",
  "card_backstop_unavailable",
  "funding_method_required",
  "funding_method_missing",
  "funding_method_not_active",
  "funding_method_rail_unsupported",
  "funding_method_provider_identity_required",
]);

function isChargeableCard(method: DropshipFundingMethodRecord): boolean {
  return method.rail === "stripe_card"
    && method.status === "active"
    && method.providerCustomerId !== null
    && method.providerPaymentMethodId !== null;
}

/**
 * What a replayed removal reports for the provider side: the stored outcome
 * when one was recorded; otherwise a Stripe method is still owed its detach
 * and any other rail never had one.
 */
function detachOutcomeOnReplay(method: DropshipFundingMethodRecord): DropshipFundingMethodDetachOutcome {
  const stored = fundingMethodProviderDetachOutcome(method.metadata);
  if (stored) return stored;
  return isStripeRail(method.rail) && method.providerPaymentMethodId !== null ? "pending" : "not_applicable";
}

function isStripeRail(rail: string): boolean {
  return rail === "stripe_card" || rail === "stripe_ach";
}

/**
 * The card charged when an order is held on a short balance.
 *
 * The configured auto-reload method serves routine top-ups and may be ACH,
 * which settles in days. An order that is already waiting cannot wait that
 * long, so the shortfall goes to a card: the configured method when it is one,
 * otherwise the default card, otherwise any chargeable card. Null means there
 * is no card to fall back to — the launch gate requires one, but a card can be
 * detached or expire after activation.
 */
function selectPaymentHoldCard(
  fundingMethods: readonly DropshipFundingMethodRecord[],
  configured: DropshipFundingMethodRecord,
): DropshipFundingMethodRecord | null {
  if (isChargeableCard(configured)) return configured;
  const cards = fundingMethods.filter(isChargeableCard);
  return cards.find((method) => method.isDefault) ?? cards[0] ?? null;
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
    cardFeeCents: 0,
    chargedCents: 0,
    currency,
    providerPaymentIntentId: null,
    fundingLedgerEntryId: null,
    fundingStatus: null,
    skipReason,
    idempotentReplay: false,
  };
}

/**
 * Orders accepted against a transfer that then failed leave the balance
 * negative (funding design phase 3). The notice says so and what happens next:
 * the daily wallet run collects it, and selling stays paused until then.
 */
function negativeBalanceSentenceFor(account: DropshipWalletAccountRecord | null): string {
  if (!account || account.availableBalanceCents >= 0) return "";
  return ` Orders accepted against it leave your balance at ${formatNotificationCurrency(account.availableBalanceCents, account.currency)}; the next wallet run collects that amount from your funding source.`;
}

/** What the provider needs to charge the fee: the rate and the amount, or nothing for a fee-free rail. */
export type DropshipWalletFundingCardFeeRate = Pick<DropshipWalletFundingCardFee, "feeCents" | "feeBps">;

function cardFeeForProvider(quote: WalletFundingQuote): DropshipWalletFundingCardFeeRate | null {
  return quote.rail === "stripe_card" ? { feeCents: quote.feeCents, feeBps: quote.feeBps } : null;
}

/**
 * The fee breakdown recorded with a card credit. Recorded even at a zero rate
 * so the ledger shows the policy was applied, and absent for every other rail.
 */
function cardFeeForCredit(quote: WalletFundingQuote): DropshipWalletFundingCardFee | undefined {
  return quote.rail === "stripe_card"
    ? { feeCents: quote.feeCents, feeBps: quote.feeBps, chargedCents: quote.chargedCents }
    : undefined;
}

// The fee's environment fallback lives with the other policy fallbacks; kept
// importable from here for the callers that learned it at this path.
export { resolveDropshipCardFundingFeeBps } from "../domain/wallet-policy";

/**
 * The USDC (Base) deposit address vendors fund the wallet with. Unset means
 * USDC funding is not offered, and the wallet page does not show it. A
 * malformed value is refused rather than shown: a typo here would send
 * vendors' money to an address nobody controls.
 */
export function resolveDropshipUsdcBaseDepositAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.DROPSHIP_USDC_BASE_DEPOSIT_ADDRESS;
  if (raw === undefined || !raw.trim()) return null;
  const parsed = usdcBaseWalletAddressSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DropshipError(
      "DROPSHIP_USDC_DEPOSIT_ADDRESS_MISCONFIGURED",
      "Dropship USDC deposit address is misconfigured.",
      { env: "DROPSHIP_USDC_BASE_DEPOSIT_ADDRESS", value: raw },
    );
  }
  return normalizeUsdcBaseAddress(parsed.data);
}

/**
 * A vendor who enables auto-reload agrees to the card fee rate on screen. A
 * client that sends a rate BELOW the one in force is refused — the screen was
 * stale and the vendor would be charged more than they saw — so the vendor
 * re-reads before agreeing. A rate at or above the live one is an agreement
 * that covers it: after a fee cut (funding design phase 7) the recorded 3%
 * still stands as the ceiling an unattended charge may carry, and an ordinary
 * save carrying it must not be refused. Older clients send nothing and are
 * not gated.
 */
function assertCardFeeAcknowledgementIsCurrent(
  input: ConfigureDropshipAutoReloadInput,
  cardFundingFeeBps: number,
): void {
  if (!input.enabled || input.acknowledgedCardFeeBps === undefined) return;
  if (input.acknowledgedCardFeeBps < cardFundingFeeBps) {
    throw new DropshipError(
      "DROPSHIP_CARD_FUNDING_FEE_ACKNOWLEDGEMENT_STALE",
      "The card fee shown has changed. Reload the page and review it before turning on auto-reload.",
      { vendorId: input.vendorId, acknowledgedCardFeeBps: input.acknowledgedCardFeeBps, cardFundingFeeBps },
    );
  }
}

/**
 * Manual (vendor-initiated) wallet funding bounds.
 *
 * `limits` is the resolved wallet policy — the active
 * `dropship.dropship_wallet_policies` row, or the environment fallback. This
 * function reads NO ambient state, so the bounds a vendor is held to are
 * exactly the bounds the wallet page showed them. The minimum depends on the
 * rail: a card deposit has its own (funding design phase 7); a bank deposit
 * keeps the general manual minimum. The maximum is the same on both.
 */
export function assertStripeWalletFundingAmount(
  amountCents: number,
  rail: DropshipStripeFundingSetupRail,
  limits: Pick<DropshipWalletPolicyLimits, "manualFundingMinCents" | "manualFundingMaxCents" | "cardFundingMinCents">,
): void {
  const minCents = rail === "stripe_card" ? limits.cardFundingMinCents : limits.manualFundingMinCents;
  const maxCents = limits.manualFundingMaxCents;
  if (minCents > maxCents) {
    throw new DropshipError(
      "DROPSHIP_WALLET_FUNDING_LIMITS_INVALID",
      "Dropship wallet funding limits are misconfigured.",
      { rail, minCents, maxCents },
    );
  }
  if (amountCents < minCents || amountCents > maxCents) {
    throw new DropshipError(
      "DROPSHIP_WALLET_FUNDING_AMOUNT_OUT_OF_RANGE",
      "Dropship wallet funding amount is outside the configured range.",
      { amountCents, rail, minCents, maxCents },
    );
  }
}

/**
 * Resolves the auto-reload floors FROM THE ENVIRONMENT.
 *
 * This is the documented fallback layer, not the source of truth: the limits in
 * force come from `dropship.dropship_wallet_policies` through the injected
 * policy resolver, and these values are what the wallet uses when no policy row
 * exists (an empty dev database, or before migration 0681 lands). `env` is
 * injectable so the result is deterministic under test rather than depending on
 * ambient process state.
 */
export function resolveDropshipAutoReloadFloors(
  env: NodeJS.ProcessEnv = process.env,
): { minTriggerCents: number; minAmountCents: number } {
  const limits = resolveDropshipWalletPolicyLimitsFromEnv(env);
  return {
    minTriggerCents: limits.autoReloadMinTriggerCents,
    minAmountCents: limits.autoReloadMinAmountCents,
  };
}

/**
 * Auto-reload configuration rules.
 *
 * `limits` is passed in rather than resolved here so a single request is judged
 * against one snapshot of the policy: the floors the vendor was shown, the
 * floors validated against, and the floors recorded in the log line are the
 * same numbers.
 */
/**
 * The amounts as stored. The top-up amount is the vendor's optional second
 * number; the per-charge bound is derived from the two unless the client
 * sent one (older clients do), and stays null while autopay is off and
 * nothing was sent.
 */
function resolveAutoReloadAmounts(input: ConfigureDropshipAutoReloadInput): ResolvedDropshipAutoReloadConfig {
  const topUpAmountCents = input.topUpAmountCents ?? null;
  const maxSingleReloadCents = input.maxSingleReloadCents
    ?? (input.enabled
      ? deriveSingleChargeBoundCents({ minimumBalanceCents: input.minimumBalanceCents, topUpAmountCents })
      : null);
  return { ...input, maxSingleReloadCents, topUpAmountCents };
}

function assertAutoReloadConfigIsUsable(
  input: ResolvedDropshipAutoReloadConfig,
  limits: Pick<DropshipWalletPolicyLimits, "autoReloadMinTriggerCents" | "autoReloadMinAmountCents">,
): void {
  if (!input.enabled) {
    return;
  }

  // A top-up amount below the policy's smallest top-up would make every
  // refill a nuisance pull; the minimum itself is already held above it.
  if (input.topUpAmountCents !== null && input.topUpAmountCents < limits.autoReloadMinAmountCents) {
    throw new DropshipError(
      "DROPSHIP_AUTO_RELOAD_TOP_UP_BELOW_MINIMUM",
      "Auto-reload top-up amount is below the minimum allowed.",
      {
        vendorId: input.vendorId,
        topUpAmountCents: input.topUpAmountCents,
        floorCents: limits.autoReloadMinAmountCents,
      },
    );
  }

  if (!input.fundingMethodId) {
    throw new DropshipError(
      "DROPSHIP_AUTO_RELOAD_FUNDING_METHOD_REQUIRED",
      "Auto-reload requires an active funding method.",
      { vendorId: input.vendorId },
    );
  }

  if (input.minimumBalanceCents < limits.autoReloadMinTriggerCents) {
    throw new DropshipError(
      "DROPSHIP_AUTO_RELOAD_TRIGGER_BELOW_MINIMUM",
      "Auto-reload trigger balance is below the minimum allowed.",
      {
        vendorId: input.vendorId,
        minimumBalanceCents: input.minimumBalanceCents,
        floorCents: limits.autoReloadMinTriggerCents,
      },
    );
  }

  // The card mandate is a standing authorization to charge without the vendor
  // present, so the per-charge amount is always bounded. An unbounded reload is
  // refused rather than defaulted.
  if (input.maxSingleReloadCents === null) {
    throw new DropshipError(
      "DROPSHIP_AUTO_RELOAD_AMOUNT_REQUIRED",
      "Auto-reload requires a maximum single reload amount when enabled.",
      { vendorId: input.vendorId },
    );
  }

  if (input.maxSingleReloadCents < limits.autoReloadMinAmountCents) {
    throw new DropshipError(
      "DROPSHIP_AUTO_RELOAD_AMOUNT_BELOW_MINIMUM",
      "Auto-reload amount is below the minimum allowed.",
      {
        vendorId: input.vendorId,
        maxSingleReloadCents: input.maxSingleReloadCents,
        floorCents: limits.autoReloadMinAmountCents,
      },
    );
  }

  if (
    input.maxSingleReloadCents !== null
    && (
      input.maxSingleReloadCents < input.minimumBalanceCents
      || (input.topUpAmountCents !== null && input.maxSingleReloadCents < input.topUpAmountCents)
    )
  ) {
    throw new DropshipError(
      "DROPSHIP_AUTO_RELOAD_INVALID_LIMITS",
      "Auto-reload maximum single reload must be at least the minimum balance and the top-up amount.",
      {
        vendorId: input.vendorId,
        minimumBalanceCents: input.minimumBalanceCents,
        topUpAmountCents: input.topUpAmountCents,
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
    // Only when present: credits recorded before the fee existed must keep
    // replaying under the hash they were stored with.
    ...(input.cardFee
      ? { cardFee: { feeCents: input.cardFee.feeCents, feeBps: input.cardFee.feeBps, chargedCents: input.cardFee.chargedCents } }
      : {}),
  });
}

export function hashWalletConfirmedUsdcFundingRequest(
  input: CreditDropshipWalletConfirmedUsdcFundingInput,
): string {
  return hashWalletRequest({
    vendorId: input.vendorId,
    fundingMethodId: input.fundingMethodId ?? null,
    amountCents: input.amountCents,
    currency: input.currency,
    amountAtomicUnits: input.amountAtomicUnits,
    chainId: input.chainId,
    transactionHash: input.transactionHash,
    fromAddress: input.fromAddress ?? null,
    toAddress: input.toAddress,
    logIndex: input.logIndex ?? null,
    referenceType: "usdc_base_transaction",
    referenceId: usdcTransactionReferenceId(input),
  });
}

/**
 * The ledger reference of a USDC transfer: the transaction alone for a
 * credit recorded without a log index, the transaction and the log when the
 * watcher (or a staff member crediting one transfer of a batch) named it.
 */
export function usdcTransactionReferenceId(input: { chainId: number; transactionHash: string; logIndex?: number | null }): string {
  return input.logIndex === null || input.logIndex === undefined
    ? `${input.chainId}:${input.transactionHash}`
    : `${input.chainId}:${input.transactionHash}:${input.logIndex}`;
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

function normalizeUsdcBaseHash(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeUsdcBaseAddress(value: string | null): string {
  if (!value) {
    throw new DropshipError(
      "DROPSHIP_USDC_WALLET_ADDRESS_REQUIRED",
      "USDC Base funding requires a wallet address.",
    );
  }
  return value.trim().toLowerCase();
}

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
