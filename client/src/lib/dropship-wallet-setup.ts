/**
 * Vendor wallet setup model.
 *
 * Pure functions behind the vendor portal Wallet page. They turn the server's
 * wallet overview into the one question the vendor cares about ("what do I do
 * next?") and produce the exact request bodies the existing wallet routes
 * accept. No server contract is changed by this module; it only decides which
 * of the existing calls to make and with which defaults.
 *
 * Money is integer cents throughout (`formatCents` for display only).
 */

import {
  buildAutoReloadConfigInput,
  type DropshipAutoReloadConfigInput,
  type DropshipWalletResponse,
} from "./dropship-ops-surface";

export type DropshipWalletOverview = DropshipWalletResponse["wallet"];
export type DropshipWalletFundingMethod = DropshipWalletOverview["fundingMethods"][number];

/**
 * Two separate roles, two rail sets.
 *
 * The backstop — what covers an order the balance cannot — is a card, and only
 * a card: ACH settles in days and USDC cannot be pulled from a self-custody
 * wallet at all, so neither can help an order that is already waiting.
 *
 * Auto-reload — the routine top-up once the balance dips under the trigger —
 * may run on a card OR ACH. It is topping up for future orders, so ACH's
 * settlement time is fine as long as the trigger leaves runway for it.
 */
export const CARD_FUNDING_RAIL = "stripe_card" as const;
export const AUTO_RELOAD_RAILS = ["stripe_card", "stripe_ach"] as const;

/**
 * Defaults offered on the setup step. They match what the previous form
 * pre-filled, so a vendor who accepts them gets the same policy as before.
 */
export const AUTO_RELOAD_DEFAULTS = {
  minimumBalanceCents: 5_000,
  maxSingleReloadCents: 25_000,
  /** 48 hours: how long an order can wait on a payment hold before it fails. */
  paymentHoldTimeoutMinutes: 2_880,
} as const;

/** Choices shown as plain buttons instead of free-text money fields. */
// Lowest option matches the server trigger floor (DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS):
// the UI must never offer a threshold the service will reject.
export const AUTO_RELOAD_MINIMUM_PRESETS_CENTS = [5_000, 10_000, 25_000, 50_000] as const;
// Lowest option matches the server amount floor (DROPSHIP_AUTO_RELOAD_MIN_AMOUNT_CENTS).
export const AUTO_RELOAD_AMOUNT_PRESETS_CENTS = [10_000, 25_000, 50_000, 100_000] as const;
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
 * activated the card after a successful return. Stripe usually delivers in
 * seconds; the cap keeps a misconfigured webhook from polling forever.
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
  /** The method auto-reload charges (card or ACH), or the best candidate for it. */
  primaryMethod: DropshipWalletFundingMethod | null;
  /** Every active card: the backstop. */
  cardMethods: DropshipWalletFundingMethod[];
  /** Every active card or bank account auto-reload may be bound to, primary first. */
  reloadMethods: DropshipWalletFundingMethod[];
  /** A card exists but is not active yet (webhook pending). */
  hasPendingCardMethod: boolean;
  autoReloadOn: boolean;
  /** Auto-reload is on and bound to an active card or bank account. */
  autoReloadReady: boolean;
  availableBalanceCents: number;
  pendingBalanceCents: number;
}

export function isCardFundingMethod(method: DropshipWalletFundingMethod): boolean {
  return method.rail === CARD_FUNDING_RAIL;
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
  const cardMethods = wallet.fundingMethods.filter(
    (method) => isCardFundingMethod(method) && method.status === "active",
  );
  const reloadCandidates = wallet.fundingMethods.filter(
    (method) => isAutoReloadFundingMethod(method) && method.status === "active",
  );
  const hasPendingCardMethod = wallet.fundingMethods.some(
    (method) => isCardFundingMethod(method) && method.status !== "active",
  );
  const configuredId = wallet.autoReload?.fundingMethodId ?? null;
  const configuredMethod = configuredId === null
    ? null
    : reloadCandidates.find((method) => method.fundingMethodId === configuredId) ?? null;
  // The chooser defaults to a card: it is the rail the vendor just proved
  // works, and the cheapest path to a finished setup.
  const primaryMethod = configuredMethod
    ?? cardMethods.find((method) => method.isDefault)
    ?? cardMethods[0]
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
    reloadMethods,
    hasPendingCardMethod,
    autoReloadOn,
    autoReloadReady,
    availableBalanceCents: wallet.account.availableBalanceCents,
    pendingBalanceCents: wallet.account.pendingBalanceCents,
  };
}

/**
 * Build the auto-reload request for the setup step. The vendor picks two
 * amounts; the hold timeout stays whatever is already saved, or the default,
 * because it is an operational detail the setup step does not expose.
 * Validation (positive minimum, reload at least the minimum, method required)
 * is delegated to the shared builder so the rules cannot drift.
 */
export function buildAutoReloadSetupInput(input: {
  fundingMethodId: number;
  minimumBalanceCents: number;
  maxSingleReloadCents: number;
  existing: DropshipWalletOverview["autoReload"];
}): DropshipAutoReloadConfigInput {
  assertCents(input.minimumBalanceCents, "minimumBalanceCents");
  assertCents(input.maxSingleReloadCents, "maxSingleReloadCents");
  const holdMinutes = input.existing?.paymentHoldTimeoutMinutes
    ?? AUTO_RELOAD_DEFAULTS.paymentHoldTimeoutMinutes;
  return buildAutoReloadConfigInput({
    enabled: true,
    fundingMethodId: String(input.fundingMethodId),
    minimumBalance: centsToDollarInput(input.minimumBalanceCents),
    maxSingleReload: centsToDollarInput(input.maxSingleReloadCents),
    paymentHoldTimeoutMinutes: String(holdMinutes),
  });
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
