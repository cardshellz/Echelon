/**
 * Vendor wallet setup model.
 *
 * Pure functions behind the vendor portal Wallet page. They turn the server's
 * wallet overview into the one question the vendor cares about ("what do I do
 * next?"), word the funding policy the way it really works, and produce the
 * exact request bodies the existing wallet routes accept. No server contract
 * is changed by this module; it only decides which of the existing calls to
 * make and with which defaults.
 *
 * Money is integer cents throughout (`formatCents` for display only).
 */

import {
  formatFeeRate,
  isValidCardFundingFeeBps,
  quoteWalletFunding,
  type WalletFundingQuote,
} from "@shared/dropship/wallet-funding-fee";
import {
  buildAutoReloadConfigInput,
  formatCents,
  type DropshipAutoReloadConfigInput,
  type DropshipWalletResponse,
} from "./dropship-ops-surface";

export type DropshipWalletOverview = DropshipWalletResponse["wallet"];
export type DropshipWalletFundingMethod = DropshipWalletOverview["fundingMethods"][number];
export type DropshipAutoReloadSetting = NonNullable<DropshipWalletOverview["autoReload"]>;

/**
 * Three rails, two roles.
 *
 * Funding the wallet: a bank account (ACH) and USDC are free; a card carries
 * the fee. Auto-reload, the routine top-up, may run on a bank account OR a
 * card: it tops up for future orders, so a bank transfer's settlement time is
 * fine as long as the balance it keeps leaves runway. USDC cannot be pulled
 * from a self-custody wallet, so it is never an auto-reload method.
 *
 * The backup card is the other role. Every vendor keeps a card on file, and it
 * alone covers an order the balance cannot: a bank transfer would land days
 * after the order needed it.
 */
export const CARD_FUNDING_RAIL = "stripe_card" as const;
export const BANK_FUNDING_RAIL = "stripe_ach" as const;
export const USDC_FUNDING_RAIL = "usdc_base" as const;
export const AUTO_RELOAD_RAILS = [CARD_FUNDING_RAIL, BANK_FUNDING_RAIL] as const;

/**
 * Defaults offered on the setup step.
 *
 * `minimumBalanceCents` is the balance auto-reload keeps the wallet at: the
 * daily top-up and the after-order top-up both bring it back up to exactly
 * this figure (the server's `calculateAutoReloadAmount`), never by a fixed
 * amount. `maxSingleReloadCents` bounds one top-up, and with it the card
 * charge that covers an order the balance cannot; the server requires it.
 */
export const AUTO_RELOAD_DEFAULTS = {
  minimumBalanceCents: 25_000,
  maxSingleReloadCents: 50_000,
  /** 48 hours: how long an order can wait on a payment hold before it fails. */
  paymentHoldTimeoutMinutes: 2_880,
} as const;

/** Choices shown as plain buttons instead of free-text money fields. */
// Every option clears the server floors (DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS,
// DROPSHIP_AUTO_RELOAD_MIN_AMOUNT_CENTS): the UI never offers what the service rejects.
export const AUTO_RELOAD_MINIMUM_PRESETS_CENTS = [10_000, 25_000, 50_000, 100_000] as const;
export const AUTO_RELOAD_CAP_PRESETS_CENTS = [25_000, 50_000, 100_000, 250_000] as const;
export const FUND_WALLET_PRESETS_CENTS = [2_500, 5_000, 10_000, 25_000] as const;

/** Stripe's hosted page returns with one of these query parameters (server-owned names). */
export const STRIPE_RETURN_PARAMS = ["funding_setup", "wallet_funding"] as const;
export type StripeReturnKind = (typeof STRIPE_RETURN_PARAMS)[number];
export type StripeReturnStatus = "success" | "cancelled";

export interface StripeReturn {
  kind: StripeReturnKind;
  status: StripeReturnStatus;
}

/**
 * How long the page keeps asking the server whether Stripe's webhook has
 * activated a card or bank account after a successful return. Stripe usually
 * delivers in seconds; the cap keeps a misconfigured webhook from polling forever.
 */
export const CARD_CONFIRMATION_POLL_INTERVAL_MS = 3_000;
export const CARD_CONFIRMATION_POLL_TIMEOUT_MS = 90_000;

export type WalletSetupStage =
  /** No usable card yet. */
  | "add_card"
  /** Stripe accepted the card; waiting for the webhook to activate it. */
  | "confirm_card"
  /** Card is active; auto-reload is off or points at nothing usable. */
  | "auto_reload"
  /** Launch gate satisfied. */
  | "ready";

export interface WalletSetupState {
  stage: WalletSetupStage;
  /** The method auto-reload charges, or the best candidate: the saved one, else a bank account, else a card. */
  primaryMethod: DropshipWalletFundingMethod | null;
  /** Every active card: the backup that covers an order the balance cannot. */
  cardMethods: DropshipWalletFundingMethod[];
  /** Every active bank account. */
  bankMethods: DropshipWalletFundingMethod[];
  /** Every registered USDC address. */
  usdcMethods: DropshipWalletFundingMethod[];
  /** Every active card or bank account auto-reload may be bound to, primary first. */
  reloadMethods: DropshipWalletFundingMethod[];
  /** A card exists but is not active yet (webhook pending). */
  hasPendingCardMethod: boolean;
  /** A bank account exists but is not active yet (webhook or verification pending). */
  hasPendingBankMethod: boolean;
  autoReloadOn: boolean;
  /** Auto-reload is on and bound to an active card or bank account. */
  autoReloadReady: boolean;
  availableBalanceCents: number;
  pendingBalanceCents: number;
}

export function isCardFundingMethod(method: DropshipWalletFundingMethod): boolean {
  return method.rail === CARD_FUNDING_RAIL;
}

export function isBankFundingMethod(method: DropshipWalletFundingMethod): boolean {
  return method.rail === BANK_FUNDING_RAIL;
}

export function isUsdcFundingMethod(method: DropshipWalletFundingMethod): boolean {
  return method.rail === USDC_FUNDING_RAIL;
}

export function isAutoReloadFundingMethod(method: DropshipWalletFundingMethod): boolean {
  return (AUTO_RELOAD_RAILS as readonly string[]).includes(method.rail);
}

/**
 * Derive the single next step from the wallet overview. Mirrors the server's
 * launch-gate rule (`buildOnboardingState`): an active card on file, plus
 * auto-reload bound to an active card or bank account. A spendable balance
 * alone does not finish setup, because the balance runs out and the card is
 * what covers the order that follows.
 */
export function deriveWalletSetupState(wallet: DropshipWalletOverview): WalletSetupState {
  const active = wallet.fundingMethods.filter((method) => method.status === "active");
  const cardMethods = active.filter(isCardFundingMethod);
  const bankMethods = active.filter(isBankFundingMethod);
  const usdcMethods = active.filter(isUsdcFundingMethod);
  const reloadCandidates = active.filter(isAutoReloadFundingMethod);
  const hasPendingCardMethod = wallet.fundingMethods.some(
    (method) => isCardFundingMethod(method) && method.status !== "active",
  );
  const hasPendingBankMethod = wallet.fundingMethods.some(
    (method) => isBankFundingMethod(method) && method.status !== "active",
  );
  const configuredId = wallet.autoReload?.fundingMethodId ?? null;
  const configuredMethod = configuredId === null
    ? null
    : reloadCandidates.find((method) => method.fundingMethodId === configuredId) ?? null;
  // The chooser prefers a bank account: it is the free rail, and the one the
  // program steers vendors toward. The card is the fallback, not the default.
  const primaryMethod = configuredMethod
    ?? preferDefault(bankMethods)
    ?? preferDefault(cardMethods)
    ?? null;
  const reloadMethods = primaryMethod
    ? [primaryMethod, ...reloadCandidates.filter((method) => method !== primaryMethod)]
    : [];
  const hasCardBackstop = cardMethods.length > 0;
  const autoReloadOn = wallet.autoReload?.enabled === true;
  const autoReloadReady = autoReloadOn && configuredMethod !== null;

  let stage: WalletSetupStage;
  if (hasCardBackstop && autoReloadReady) stage = "ready";
  else if (hasCardBackstop) stage = "auto_reload";
  else if (hasPendingCardMethod) stage = "confirm_card";
  else stage = "add_card";

  return {
    stage,
    primaryMethod,
    cardMethods,
    bankMethods,
    usdcMethods,
    reloadMethods,
    hasPendingCardMethod,
    hasPendingBankMethod,
    autoReloadOn,
    autoReloadReady,
    availableBalanceCents: wallet.account.availableBalanceCents,
    pendingBalanceCents: wallet.account.pendingBalanceCents,
  };
}

function preferDefault(methods: DropshipWalletFundingMethod[]): DropshipWalletFundingMethod | null {
  return methods.find((method) => method.isDefault) ?? methods[0] ?? null;
}

/** The presets plus whatever is already saved, so an existing choice is never shown as "none of these". */
export function presetsIncluding(presets: readonly number[], savedCents: number | null): number[] {
  const values = new Set<number>(presets);
  if (savedCents !== null && Number.isSafeInteger(savedCents) && savedCents > 0) values.add(savedCents);
  return [...values].sort((left, right) => left - right);
}

/** The smallest cap preset that still clears the chosen minimum; the minimum itself when none does. */
export function smallestCapFor(minimumCents: number, presets: readonly number[] = AUTO_RELOAD_CAP_PRESETS_CENTS): number {
  return presets.find((cents) => cents >= minimumCents) ?? minimumCents;
}

/**
 * Build the auto-reload request for the setup step. The vendor picks the
 * balance to keep and the cap on one top-up; the hold timeout stays whatever
 * is already saved, or the default, because it is an operational detail the
 * setup step does not expose. Validation (positive minimum, cap at least the
 * minimum, method required) is delegated to the shared builder so the rules
 * cannot drift.
 *
 * The card fee rate the vendor was shown travels with the request: turning
 * auto-reload on is agreeing to it, and the server refuses a rate that is no
 * longer the one in force.
 */
export function buildAutoReloadSetupInput(input: {
  fundingMethodId: number;
  minimumBalanceCents: number;
  maxSingleReloadCents: number;
  cardFundingFeeBps: number;
  existing: DropshipWalletOverview["autoReload"];
}): DropshipAutoReloadConfigInput {
  assertCents(input.minimumBalanceCents, "minimumBalanceCents");
  assertCents(input.maxSingleReloadCents, "maxSingleReloadCents");
  if (!isValidCardFundingFeeBps(input.cardFundingFeeBps)) {
    throw new Error("The card fee rate is missing or invalid. Reload the page and try again.");
  }
  const holdMinutes = input.existing?.paymentHoldTimeoutMinutes
    ?? AUTO_RELOAD_DEFAULTS.paymentHoldTimeoutMinutes;
  return {
    ...buildAutoReloadConfigInput({
      enabled: true,
      fundingMethodId: String(input.fundingMethodId),
      minimumBalance: centsToDollarInput(input.minimumBalanceCents),
      maxSingleReload: centsToDollarInput(input.maxSingleReloadCents),
      paymentHoldTimeoutMinutes: String(holdMinutes),
    }),
    acknowledgedCardFeeBps: input.cardFundingFeeBps,
  };
}

/**
 * What putting `creditCents` into the wallet through `method` costs. A card
 * carries the fee on top; a bank account or USDC is charged exactly the
 * credit. Same calculation the server charges with, so the number shown before
 * confirming is the number charged.
 */
export function quoteFundingForMethod(
  method: DropshipWalletFundingMethod,
  creditCents: number,
  cardFundingFeeBps: number,
): WalletFundingQuote {
  return quoteWalletFunding({ rail: method.rail, creditCents, cardFeeBps: cardFundingFeeBps });
}

/** The one line shown under an Add funds amount: what is charged, what lands, and when. */
export function describeFundingQuote(method: DropshipWalletFundingMethod, quote: WalletFundingQuote): string {
  if (quote.feeCents > 0) {
    return `Card fee (${formatFeeRate(quote.feeBps)}): ${formatCents(quote.feeCents)}. Your card is charged ${formatCents(quote.chargedCents)} and ${formatCents(quote.creditCents)} goes into your wallet.`;
  }
  if (isCardFundingMethod(method)) return `No fee. ${formatCents(quote.creditCents)} goes into your wallet.`;
  return `No fee. ${formatCents(quote.creditCents)} goes into your wallet once the bank transfer settles, usually within a few days.`;
}

/** Everything the policy copy needs; built by the page from the chooser's current selection. */
export interface AutoReloadTerms {
  /** The method auto-reload charges: a bank account or a card. */
  method: DropshipWalletFundingMethod;
  /** The card that covers an order the balance cannot; null only before one is on file. */
  backupCard: DropshipWalletFundingMethod | null;
  minimumBalanceCents: number;
  maxSingleReloadCents: number;
  cardFundingFeeBps: number;
}

/** How the top-up works, in the words the server's math actually implements. */
export function describeTopUpRule(terms: AutoReloadTerms): string {
  return `We keep your balance at ${formatCents(terms.minimumBalanceCents)}: once a day, and after any order that takes it lower, we top it back up from ${describeFundingMethod(terms.method)}. One top-up never charges more than ${formatCents(terms.maxSingleReloadCents)}.`;
}

/** What the chosen method costs, and where the card comes in when it is not the chosen method. */
export function describeTopUpFee(terms: AutoReloadTerms): string {
  const feeRate = formatFeeRate(terms.cardFundingFeeBps);
  if (isCardFundingMethod(terms.method)) {
    const quote = quoteFundingForMethod(terms.method, terms.maxSingleReloadCents, terms.cardFundingFeeBps);
    return `Card top-ups carry a ${feeRate} fee on top of the amount added: a ${formatCents(terms.maxSingleReloadCents)} top-up charges ${formatCents(quote.chargedCents)}.`;
  }
  return `Bank top-ups carry no fee and take a few days to land. An order that cannot wait is charged to ${describeBackupCard(terms.backupCard)} plus the ${feeRate} card fee.`;
}

/** The standing authorization the vendor gives by turning auto-reload on. Names every charge it allows. */
export function describeAutoReloadMandate(terms: AutoReloadTerms): string {
  const feeRate = formatFeeRate(terms.cardFundingFeeBps);
  const keep = `keep your balance at ${formatCents(terms.minimumBalanceCents)}`;
  const cap = `up to ${formatCents(terms.maxSingleReloadCents)} per charge`;
  if (isCardFundingMethod(terms.method)) {
    return `By turning this on, you authorize Card Shellz to charge ${describeFundingMethod(terms.method)}, plus the ${feeRate} card fee, to ${keep} and to cover any order your balance cannot, ${cap}.`;
  }
  return `By turning this on, you authorize Card Shellz to debit ${describeFundingMethod(terms.method)} to ${keep}, ${cap}, and to charge ${describeBackupCard(terms.backupCard)} plus the ${feeRate} card fee for any order your balance cannot cover.`;
}

/** What happens on a hard decline. Stated up front because it stops sales, not just a top-up. */
export const PAUSE_ON_DECLINE_NOTE = "If a top-up is declined, or a bank transfer is returned, selling pauses: no orders are accepted and your listings show nothing for sale until your wallet is funded back to that balance. It resumes on its own.";

/** The one-paragraph summary on the wallet once auto-reload is on. */
export function describeAutoReloadPolicy(input: {
  autoReload: DropshipAutoReloadSetting;
  method: DropshipWalletFundingMethod;
  backupCard: DropshipWalletFundingMethod | null;
  cardFundingFeeBps: number;
}): string {
  const feeRate = formatFeeRate(input.cardFundingFeeBps);
  const keep = `Keeps your balance at ${formatCents(input.autoReload.minimumBalanceCents)}`;
  // The server requires a cap while auto-reload is on; the fallback only guards the type.
  const cap = `up to ${formatCents(input.autoReload.maxSingleReloadCents ?? input.autoReload.minimumBalanceCents)} per top-up`;
  if (isCardFundingMethod(input.method)) {
    return `${keep} from ${describeFundingMethod(input.method)}, plus the ${feeRate} card fee, ${cap}.`;
  }
  return `${keep} from ${describeFundingMethod(input.method)}, no fee, ${cap}. ${capitalize(describeBackupCard(input.backupCard))} covers any order that cannot wait, plus the ${feeRate} card fee.`;
}

function describeBackupCard(card: DropshipWalletFundingMethod | null): string {
  return card ? describeFundingMethod(card) : "your card on file";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The USDC funding instructions. Only offered when Card Shellz has published
 * a deposit address; the vendor registers the address they send from so the
 * transfer can be matched to their wallet.
 */
export interface UsdcFundingView {
  depositAddress: string;
  /** The vendor's registered sending address, masked, or null before they register one. */
  registeredAddress: string | null;
  lines: string[];
}

export function describeUsdcFunding(input: {
  depositAddress: string | null;
  usdcMethods: readonly DropshipWalletFundingMethod[];
}): UsdcFundingView | null {
  if (!input.depositAddress) return null;
  const registered = input.usdcMethods.find((method) => method.usdcWalletAddress)?.usdcWalletAddress ?? null;
  const lines = registered
    ? [
      `Send USDC on Base from ${maskAddress(registered)} to the deposit address below.`,
      "No fee. Card Shellz credits your wallet once the transfer is confirmed on chain.",
    ]
    : [
      "No fee. Register the wallet address you will send from, so the transfer can be matched to your wallet.",
      "Then send USDC on Base to the deposit address below; Card Shellz credits your wallet once it is confirmed on chain.",
    ];
  return { depositAddress: input.depositAddress, registeredAddress: registered ? maskAddress(registered) : null, lines };
}

/** Turn auto-reload off while keeping the saved amounts, so it can be re-enabled unchanged. */
export function buildAutoReloadDisableInput(
  existing: DropshipWalletOverview["autoReload"],
): DropshipAutoReloadConfigInput {
  return {
    enabled: false,
    fundingMethodId: existing?.fundingMethodId ?? null,
    minimumBalanceCents: existing?.minimumBalanceCents ?? AUTO_RELOAD_DEFAULTS.minimumBalanceCents,
    maxSingleReloadCents: existing?.maxSingleReloadCents ?? AUTO_RELOAD_DEFAULTS.maxSingleReloadCents,
    paymentHoldTimeoutMinutes: existing?.paymentHoldTimeoutMinutes ?? AUTO_RELOAD_DEFAULTS.paymentHoldTimeoutMinutes,
  };
}

/** Read the Stripe return marker from the current query string, if any. */
export function parseStripeReturn(search: string): StripeReturn | null {
  const params = new URLSearchParams(search);
  for (const kind of STRIPE_RETURN_PARAMS) {
    const value = params.get(kind);
    if (value === "success" || value === "cancelled") {
      return { kind, status: value };
    }
  }
  return null;
}

/** The query string with the Stripe return markers removed, so a reload does not replay the banner. */
export function stripStripeReturn(search: string): string {
  const params = new URLSearchParams(search);
  for (const kind of STRIPE_RETURN_PARAMS) params.delete(kind);
  const remaining = params.toString();
  return remaining ? `?${remaining}` : "";
}

/** Human label for a funding method; Stripe labels already read "Visa ending in 4242". */
export function describeFundingMethod(method: DropshipWalletFundingMethod): string {
  if (method.displayLabel?.trim()) return method.displayLabel.trim();
  switch (method.rail) {
    case "stripe_card":
      return "Card";
    case "stripe_ach":
      return "Bank account";
    case "usdc_base":
      return method.usdcWalletAddress ? `USDC ${maskAddress(method.usdcWalletAddress)}` : "USDC on Base";
    default:
      return "Funding method";
  }
}

export function maskAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

/** Integer cents to the "12.34" form the shared dollar parser accepts. */
export function centsToDollarInput(cents: number): string {
  assertCents(cents, "cents");
  const dollars = Math.trunc(cents / 100);
  const remainder = cents % 100;
  return `${dollars}.${String(remainder).padStart(2, "0")}`;
}

function assertCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative whole number of cents.`);
  }
}
