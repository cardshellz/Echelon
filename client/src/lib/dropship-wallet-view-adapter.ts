/**
 * Wallet view adapter.
 *
 * The rebuilt Wallet page reads ONE shape: the §4.1 wallet view of the wallet
 * redesign spec (typed statuses, card / bank details, roles, a stored backup
 * card, the fee acknowledgement, server limits, a typed ledger and a
 * server-derived setup status). Today's `GET /api/dropship/wallet` serves only
 * part of it. `adaptWalletView(raw)` turns today's response into that shape:
 * every field the server serves is used as-is; every field it does not serve
 * yet is DERIVED by a named function below, or filled with a clearly named
 * fallback. Each derivation is documented and unit-tested, and the view lists
 * which fallbacks it applied (`clientFallbacks`) so nothing is silently made
 * up. When the server serves the full DTO, the derivations become no-ops and
 * the page needs no change.
 *
 * Money is integer cents throughout. Balances are SIGNED (a return fee can
 * take the available balance below zero); amounts are non-negative.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// The adapted shape the page reads (spec §4.1)
// ---------------------------------------------------------------------------

export type WalletFundingRail = "stripe_card" | "stripe_ach" | "usdc_base" | "manual";
export type WalletMethodStatus = "active" | "setup_pending" | "archived" | "failed";

export interface WalletCardDetails {
  brand: string;
  last4: string;
  /** Null when the server has not served the expiry yet (legacy rows): the page then shows no expiry. */
  expMonth: number | null;
  expYear: number | null;
}

export interface WalletBankAccountDetails {
  bankName: string | null;
  last4: string;
  accountType: string | null;
}

export interface WalletMethodRoles {
  /** Auto-reload is enabled and this method is its source. */
  isAutoReloadSource: boolean;
  /** Auto-reload is enabled and this card is the designated backup card. */
  isBackupCard: boolean;
  /** An active card Card Shellz can charge. */
  chargeable: boolean;
}

export interface WalletFundingMethod {
  fundingMethodId: number;
  rail: WalletFundingRail;
  status: WalletMethodStatus;
  displayLabel: string | null;
  usdcWalletAddress: string | null;
  createdAt: string;
  updatedAt: string;
  card: WalletCardDetails | null;
  bankAccount: WalletBankAccountDetails | null;
  roles: WalletMethodRoles;
}

export interface WalletAutoReload {
  autoReloadSettingId: number;
  enabled: boolean;
  minimumBalanceCents: number;
  maxSingleReloadCents: number | null;
  paymentHoldTimeoutMinutes: number;
  fundingMethodId: number | null;
  updatedAt: string;
  backstopFundingMethodId: number | null;
  acknowledgedCardFeeBps: number | null;
  acknowledgedAt: string | null;
}

export type WalletLedgerReason =
  | "daily_top_up" | "after_order_top_up" | "activation_top_up" | "covered_held_order" | "manual_top_up"
  | "usdc_deposit" | "admin_credit" | "order" | "return_fee" | "return_credit" | "insurance_pool_credit" | "other";

export interface WalletLedgerEntry {
  ledgerEntryId: number;
  type: string;
  status: string;
  amountCents: number;
  currency: string;
  /** Signed: a return fee can leave the balance below zero. */
  availableBalanceAfterCents: number | null;
  pendingBalanceAfterCents: number | null;
  createdAt: string;
  settledAt: string | null;
  reason: WalletLedgerReason;
  fundingMethodId: number | null;
  cardFee: { feeCents: number; feeBps: number; chargedCents: number } | null;
  failure: { code: string | null; message: string | null } | null;
}

export interface WalletLimits {
  /** Pack tier minimum (eaches and inner packs): the lowest floor any vendor may keep. */
  autoReloadMinTriggerCents: number;
  /** Case tier minimum: a vendor with case listings enabled keeps at least this. */
  caseTierMinimumCents: number;
  autoReloadMinAmountCents: number;
  manualFundingMinCents: number;
  manualFundingMaxCents: number;
  /** Set by staff for every wallet; the vendor never chooses it. */
  defaultPaymentHoldTimeoutMinutes: number;
  holdExpiryWarningMinutes: number;
  /** Service fee, in basis points, on pending bank money an order is accepted against. */
  advanceFeeBps: number;
  /** Ceiling on that pending amount; zero advances nothing. */
  advanceCapCents: number;
  /** Days a vendor below a raised tier minimum keeps that tier's listings. */
  tierChangeGraceDays: number;
}

export interface WalletSetupStatus {
  sourceReady: boolean;
  backupReady: boolean;
  acknowledged: boolean;
  done: boolean;
  launchReady: boolean;
}

export type WalletClientFallback =
  | "method_status_mapped"
  | "card_details_from_label"
  | "bank_details_from_label"
  | "backstop_from_first_active_card"
  | "acknowledgement_assumed_from_settings_row"
  | "roles_derived"
  | "limits_from_documented_defaults"
  | "ledger_reason_derived"
  | "setup_status_derived";

export interface DropshipWalletView {
  account: { availableBalanceCents: number; pendingBalanceCents: number; currency: string; status: string };
  autoReload: WalletAutoReload | null;
  fundingMethods: WalletFundingMethod[];
  recentLedger: WalletLedgerEntry[];
  cardFundingFeeBps: number;
  usdcBaseDepositAddress: string | null;
  limits: WalletLimits;
  setupStatus: WalletSetupStatus;
  /** Which parts of this view the client derived because the server did not serve them. Empty once the server serves the full DTO. */
  clientFallbacks: WalletClientFallback[];
}

// ---------------------------------------------------------------------------
// Today's response, validated leniently: the fields the server serves today are
// required; the §4.1 additions are optional and used when present.
// ---------------------------------------------------------------------------

const isoString = z.string().min(1);
const signedCents = z.number().int();
const cents = z.number().int().nonnegative();

const rawCardSchema = z.object({
  brand: z.string(),
  last4: z.string(),
  expMonth: z.number().int().nullable().optional(),
  expYear: z.number().int().nullable().optional(),
});

const rawBankAccountSchema = z.object({
  bankName: z.string().nullable(),
  last4: z.string(),
  accountType: z.string().nullable().optional(),
});

const rawRolesSchema = z.object({
  isAutoReloadSource: z.boolean(),
  isBackupCard: z.boolean(),
  chargeable: z.boolean(),
});

const rawFundingMethodSchema = z.object({
  fundingMethodId: z.number().int().positive(),
  rail: z.enum(["stripe_card", "stripe_ach", "usdc_base", "manual"]),
  status: z.string(),
  displayLabel: z.string().nullable(),
  isDefault: z.boolean().optional(),
  usdcWalletAddress: z.string().nullable(),
  createdAt: isoString,
  updatedAt: isoString,
  card: rawCardSchema.nullable().optional(),
  bankAccount: rawBankAccountSchema.nullable().optional(),
  roles: rawRolesSchema.optional(),
}).passthrough();

const rawAutoReloadSchema = z.object({
  autoReloadSettingId: z.number().int(),
  enabled: z.boolean(),
  minimumBalanceCents: cents,
  maxSingleReloadCents: cents.nullable(),
  paymentHoldTimeoutMinutes: z.number().int().positive(),
  fundingMethodId: z.number().int().nullable(),
  updatedAt: isoString,
  backstopFundingMethodId: z.number().int().nullable().optional(),
  acknowledgedCardFeeBps: z.number().int().nullable().optional(),
  acknowledgedAt: z.string().nullable().optional(),
}).passthrough();

const ledgerReasonSchema = z.enum([
  "daily_top_up", "after_order_top_up", "activation_top_up", "covered_held_order", "manual_top_up",
  "usdc_deposit", "admin_credit", "order", "return_fee", "return_credit", "insurance_pool_credit", "other",
]);

const rawLedgerEntrySchema = z.object({
  ledgerEntryId: z.number().int(),
  type: z.string(),
  status: z.string(),
  amountCents: signedCents,
  currency: z.string(),
  availableBalanceAfterCents: signedCents.nullable(),
  pendingBalanceAfterCents: signedCents.nullable(),
  referenceType: z.string().nullable().optional(),
  createdAt: isoString,
  settledAt: z.string().nullable(),
  reason: ledgerReasonSchema.optional(),
  fundingMethodId: z.number().int().nullable().optional(),
  cardFee: z.object({ feeCents: cents, feeBps: z.number().int(), chargedCents: cents }).nullable().optional(),
  failure: z.object({ code: z.string().nullable(), message: z.string().nullable() }).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
}).passthrough();

/**
 * The four limits the funding design added (migration 0683) are optional on
 * the wire so a server one release behind still serves a wallet; a missing one
 * is filled from the documented default and the fallback is named.
 */
const rawLimitsSchema = z.object({
  autoReloadMinTriggerCents: cents,
  caseTierMinimumCents: cents.optional(),
  autoReloadMinAmountCents: cents,
  manualFundingMinCents: cents,
  manualFundingMaxCents: cents,
  defaultPaymentHoldTimeoutMinutes: z.number().int().positive(),
  holdExpiryWarningMinutes: z.number().int().positive(),
  advanceFeeBps: z.number().int().nonnegative().optional(),
  advanceCapCents: z.number().int().nonnegative().optional(),
  tierChangeGraceDays: z.number().int().nonnegative().optional(),
});

const rawSetupStatusSchema = z.object({
  sourceReady: z.boolean(),
  backupReady: z.boolean(),
  acknowledged: z.boolean(),
  done: z.boolean(),
  launchReady: z.boolean(),
});

export const rawWalletResponseSchema = z.object({
  wallet: z.object({
    account: z.object({
      availableBalanceCents: signedCents,
      pendingBalanceCents: signedCents,
      currency: z.string(),
      status: z.string(),
    }).passthrough(),
    autoReload: rawAutoReloadSchema.nullable(),
    fundingMethods: z.array(rawFundingMethodSchema),
    recentLedger: z.array(rawLedgerEntrySchema),
    cardFundingFeeBps: z.number().int().nonnegative(),
    usdcBaseDepositAddress: z.string().nullable(),
    limits: rawLimitsSchema.optional(),
    setupStatus: rawSetupStatusSchema.optional(),
  }).passthrough(),
});

export type RawWalletResponse = z.infer<typeof rawWalletResponseSchema>;
type RawFundingMethod = z.infer<typeof rawFundingMethodSchema>;
type RawAutoReload = z.infer<typeof rawAutoReloadSchema>;
type RawLedgerEntry = z.infer<typeof rawLedgerEntrySchema>;

// ---------------------------------------------------------------------------
// Fallbacks (named, documented)
// ---------------------------------------------------------------------------

/**
 * The server's documented defaults
 * (server/modules/dropship/domain/wallet-policy.ts, migration 0683 version 2),
 * used only for a limit the server did not serve: pack tier $100, case tier
 * $500, minimum single top-up $100, manual top-up $10–$5,000, 24-hour payment
 * hold warned 2 hours before expiry, 1% advance fee capped at $500, 14 days
 * of grace after a tier is raised. A staff-published policy is invisible to the
 * client until the server serves the resolved values.
 */
export const CLIENT_FALLBACK_LIMITS: WalletLimits = Object.freeze({
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

/** The keys of `value` whose entries are defined, so a spread never overwrites a default with `undefined`. */
function definedEntries<T extends object>(value: T): Partial<T> {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return Object.fromEntries(entries) as Partial<T>;
}

/** "Visa ending in 4242" / "Chase ending in 1234": the label Stripe's provider writes today. */
const LABEL_ENDING_IN = /^(.+?) ending in (\d{4})$/;

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/**
 * Today's rows carry free-text statuses ("active", "pending", "inactive", …).
 * Anything that is not clearly active or still being set up is treated as
 * archived, so the page never offers a row the server would refuse.
 */
export function deriveMethodStatus(rawStatus: string): WalletMethodStatus {
  switch (rawStatus) {
    case "active":
      return "active";
    case "pending":
    case "setup_pending":
      return "setup_pending";
    case "failed":
      return "failed";
    default:
      return "archived";
  }
}

/** Card details from the served block, else parsed from the display label (expiry unknown). */
export function deriveCardDetails(method: Pick<RawFundingMethod, "rail" | "displayLabel" | "card">): WalletCardDetails | null {
  if (method.rail !== "stripe_card") return null;
  if (method.card) {
    return { brand: method.card.brand, last4: method.card.last4, expMonth: method.card.expMonth ?? null, expYear: method.card.expYear ?? null };
  }
  const match = method.displayLabel ? LABEL_ENDING_IN.exec(method.displayLabel.trim()) : null;
  if (!match) return null;
  return { brand: match[1], last4: match[2], expMonth: null, expYear: null };
}

/** Bank details from the served block, else parsed from the display label (account type unknown). */
export function deriveBankAccountDetails(method: Pick<RawFundingMethod, "rail" | "displayLabel" | "bankAccount">): WalletBankAccountDetails | null {
  if (method.rail !== "stripe_ach") return null;
  if (method.bankAccount) {
    return { bankName: method.bankAccount.bankName, last4: method.bankAccount.last4, accountType: method.bankAccount.accountType ?? null };
  }
  const match = method.displayLabel ? LABEL_ENDING_IN.exec(method.displayLabel.trim()) : null;
  if (!match) return null;
  return { bankName: match[1], last4: match[2], accountType: null };
}

/** Whether a row is a card Card Shellz can charge. Provider ids are not exposed to the client, so an active card is assumed chargeable. */
export function deriveChargeable(method: Pick<RawFundingMethod, "rail" | "status" | "roles">): boolean {
  if (method.roles) return method.roles.chargeable;
  return method.rail === "stripe_card" && deriveMethodStatus(method.status) === "active";
}

/**
 * The stored backup card (spec D4). Until the server stores one, the client
 * replicates today's server derivation: the auto-reload source when it is a
 * card, else the default active card, else the newest active card.
 */
export function deriveBackstopFundingMethodId(
  autoReload: RawAutoReload | null,
  methods: readonly RawFundingMethod[],
): { backstopFundingMethodId: number | null; derived: boolean } {
  if (autoReload && autoReload.backstopFundingMethodId !== undefined) {
    return { backstopFundingMethodId: autoReload.backstopFundingMethodId, derived: false };
  }
  const cards = methods.filter((method) => method.rail === "stripe_card" && deriveMethodStatus(method.status) === "active");
  const source = autoReload?.fundingMethodId === null || autoReload === null
    ? null
    : cards.find((card) => card.fundingMethodId === autoReload.fundingMethodId) ?? null;
  const chosen = source
    ?? cards.find((card) => card.isDefault === true)
    ?? [...cards].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
    ?? null;
  return { backstopFundingMethodId: chosen?.fundingMethodId ?? null, derived: true };
}

/**
 * The fee acknowledgement (spec D7). Until the server records it, an enabled
 * row is assumed to have been agreed at the rate in force when it was last
 * saved: today's server already refuses a PUT whose rate is stale, so the row
 * was written under the rate in force at that moment. The date shown is the
 * row's `updatedAt`. A disabled row has no acknowledgement.
 */
export function deriveAcknowledgement(
  autoReload: RawAutoReload | null,
  cardFundingFeeBps: number,
): { acknowledgedCardFeeBps: number | null; acknowledgedAt: string | null; derived: boolean } {
  if (!autoReload) return { acknowledgedCardFeeBps: null, acknowledgedAt: null, derived: false };
  if (autoReload.acknowledgedCardFeeBps !== undefined || autoReload.acknowledgedAt !== undefined) {
    return {
      acknowledgedCardFeeBps: autoReload.acknowledgedCardFeeBps ?? null,
      acknowledgedAt: autoReload.acknowledgedAt ?? null,
      derived: false,
    };
  }
  if (!autoReload.enabled || autoReload.fundingMethodId === null) {
    return { acknowledgedCardFeeBps: null, acknowledgedAt: null, derived: true };
  }
  return { acknowledgedCardFeeBps: cardFundingFeeBps, acknowledgedAt: autoReload.updatedAt, derived: true };
}

/** Roles are `enabled`-aware: a disabled settings row gives no method a role (spec §4.1). */
export function deriveRoles(
  method: Pick<RawFundingMethod, "fundingMethodId" | "rail" | "status" | "roles">,
  autoReload: Pick<WalletAutoReload, "enabled" | "fundingMethodId" | "backstopFundingMethodId"> | null,
): WalletMethodRoles {
  if (method.roles) return { ...method.roles };
  const enabled = autoReload?.enabled === true;
  return {
    isAutoReloadSource: enabled && autoReload?.fundingMethodId === method.fundingMethodId,
    isBackupCard: enabled && autoReload?.backstopFundingMethodId === method.fundingMethodId,
    chargeable: deriveChargeable(method),
  };
}

/** The same predicates the server's launch gate uses (spec §4.1 `setupStatus`). */
export function deriveSetupStatus(input: {
  autoReload: WalletAutoReload | null;
  fundingMethods: readonly WalletFundingMethod[];
  cardFundingFeeBps: number;
}): WalletSetupStatus {
  const { autoReload } = input;
  const enabled = autoReload?.enabled === true;
  const source = enabled ? input.fundingMethods.find((method) => method.fundingMethodId === autoReload?.fundingMethodId) ?? null : null;
  const sourceReady = source !== null && source.status === "active" && (source.rail === "stripe_card" || source.rail === "stripe_ach");
  const backup = enabled ? input.fundingMethods.find((method) => method.fundingMethodId === autoReload?.backstopFundingMethodId) ?? null : null;
  const backupReady = backup !== null && backup.roles.chargeable;
  const acknowledged = autoReload !== null
    && autoReload.acknowledgedAt !== null
    && autoReload.acknowledgedCardFeeBps === input.cardFundingFeeBps;
  const done = sourceReady && backupReady;
  return { sourceReady, backupReady, acknowledged, done, launchReady: done && acknowledged };
}

/**
 * The ledger reason (spec §4.1), from the served field, else from the row's
 * type, reference and metadata exactly as the spec's server derivation reads
 * them. A funding row with no metadata at all cannot be told apart, so it is
 * "other" rather than a guess.
 */
export function deriveLedgerReason(entry: Pick<RawLedgerEntry, "type" | "reason" | "referenceType" | "metadata">): WalletLedgerReason {
  if (entry.reason) return entry.reason;
  switch (entry.type) {
    case "order_debit":
      return "order";
    case "return_fee":
      return "return_fee";
    case "return_credit":
      return "return_credit";
    case "insurance_pool_credit":
      return "insurance_pool_credit";
    case "funding":
      break;
    default:
      return "other";
  }
  const metadata = entry.metadata ?? null;
  if (metadata?.autoReload === true) {
    if (metadata.autoReloadReason === "payment_hold") return "covered_held_order";
    switch (metadata.trigger) {
      case "daily":
        return "daily_top_up";
      case "after_order":
        return "after_order_top_up";
      case "activation":
        return "activation_top_up";
      default:
        return metadata.intakeId !== undefined && metadata.intakeId !== null ? "after_order_top_up" : "daily_top_up";
    }
  }
  if (entry.referenceType === "admin_manual_wallet_credit") return "admin_credit";
  if (entry.referenceType === "usdc_base_transaction") return "usdc_deposit";
  if (metadata !== null) return "manual_top_up";
  return "other";
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Parse today's `GET /api/dropship/wallet` body and adapt it to the §4.1 view.
 * Throws a ZodError on a body that does not even match today's contract, so a
 * drift fails loudly instead of rendering nonsense.
 */
export function adaptWalletView(raw: unknown): DropshipWalletView {
  const { wallet } = rawWalletResponseSchema.parse(raw);
  const fallbacks = new Set<WalletClientFallback>();

  const backstop = deriveBackstopFundingMethodId(wallet.autoReload, wallet.fundingMethods);
  if (backstop.derived && wallet.autoReload) fallbacks.add("backstop_from_first_active_card");
  const acknowledgement = deriveAcknowledgement(wallet.autoReload, wallet.cardFundingFeeBps);
  if (acknowledgement.derived) fallbacks.add("acknowledgement_assumed_from_settings_row");

  const autoReload: WalletAutoReload | null = wallet.autoReload
    ? {
      autoReloadSettingId: wallet.autoReload.autoReloadSettingId,
      enabled: wallet.autoReload.enabled,
      minimumBalanceCents: wallet.autoReload.minimumBalanceCents,
      maxSingleReloadCents: wallet.autoReload.maxSingleReloadCents,
      paymentHoldTimeoutMinutes: wallet.autoReload.paymentHoldTimeoutMinutes,
      fundingMethodId: wallet.autoReload.fundingMethodId,
      updatedAt: wallet.autoReload.updatedAt,
      backstopFundingMethodId: backstop.backstopFundingMethodId,
      acknowledgedCardFeeBps: acknowledgement.acknowledgedCardFeeBps,
      acknowledgedAt: acknowledgement.acknowledgedAt,
    }
    : null;

  const fundingMethods: WalletFundingMethod[] = wallet.fundingMethods.map((method) => {
    const status = deriveMethodStatus(method.status);
    if (status !== method.status) fallbacks.add("method_status_mapped");
    const card = deriveCardDetails(method);
    if (card && !method.card) fallbacks.add("card_details_from_label");
    const bankAccount = deriveBankAccountDetails(method);
    if (bankAccount && !method.bankAccount) fallbacks.add("bank_details_from_label");
    if (!method.roles) fallbacks.add("roles_derived");
    return {
      fundingMethodId: method.fundingMethodId,
      rail: method.rail,
      status,
      displayLabel: method.displayLabel,
      usdcWalletAddress: method.usdcWalletAddress,
      createdAt: method.createdAt,
      updatedAt: method.updatedAt,
      card,
      bankAccount,
      roles: deriveRoles(method, autoReload),
    };
  });

  const recentLedger: WalletLedgerEntry[] = wallet.recentLedger.map((entry) => {
    if (!entry.reason) fallbacks.add("ledger_reason_derived");
    return {
      ledgerEntryId: entry.ledgerEntryId,
      type: entry.type,
      status: entry.status,
      amountCents: entry.amountCents,
      currency: entry.currency,
      availableBalanceAfterCents: entry.availableBalanceAfterCents,
      pendingBalanceAfterCents: entry.pendingBalanceAfterCents,
      createdAt: entry.createdAt,
      settledAt: entry.settledAt,
      reason: deriveLedgerReason(entry),
      fundingMethodId: entry.fundingMethodId ?? null,
      cardFee: entry.cardFee ?? null,
      failure: entry.failure ?? null,
    };
  });

  const served = wallet.limits ?? null;
  const limits: WalletLimits = { ...CLIENT_FALLBACK_LIMITS, ...(served ? definedEntries(served) : {}) };
  // Either no limits at all, or a server that predates one of them: the page
  // is then quoting a documented default for that value, and says so.
  if (!served || (Object.keys(CLIENT_FALLBACK_LIMITS) as Array<keyof WalletLimits>).some((key) => served[key] === undefined)) {
    fallbacks.add("limits_from_documented_defaults");
  }

  const setupStatus = wallet.setupStatus ?? deriveSetupStatus({ autoReload, fundingMethods, cardFundingFeeBps: wallet.cardFundingFeeBps });
  if (!wallet.setupStatus) fallbacks.add("setup_status_derived");

  return {
    account: {
      availableBalanceCents: wallet.account.availableBalanceCents,
      pendingBalanceCents: wallet.account.pendingBalanceCents,
      currency: wallet.account.currency,
      status: wallet.account.status,
    },
    autoReload,
    fundingMethods,
    recentLedger,
    cardFundingFeeBps: wallet.cardFundingFeeBps,
    usdcBaseDepositAddress: wallet.usdcBaseDepositAddress,
    limits,
    setupStatus,
    clientFallbacks: [...fallbacks],
  };
}
