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
 * The emergency backstop is a card, and only a card. ACH settles in days and
 * USDC cannot be pulled from a self-custody wallet at all, so neither can
 * rescue an order already sitting in payment hold. Both remain primary funding
 * rails — they just cannot satisfy the launch gate.
 */
export const CARD_FUNDING_RAIL = "stripe_card" as const;

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
  /** The card auto-reload charges, or the best candidate for it. */
  primaryMethod: DropshipWalletFundingMethod | null;
  /** Every active card, primary first. */
  cardMethods: DropshipWalletFundingMethod[];
  /** A card exists but is not active yet (webhook pending). */
  hasPendingCardMethod: boolean;
  autoReloadOn: boolean;
  /** Auto-reload is on and bound to an active card. */
  autoReloadReady: boolean;
  availableBalanceCents: number;
  pendingBalanceCents: number;
}

export function isCardFundingMethod(method: DropshipWalletFundingMethod): boolean {
  return method.rail === CARD_FUNDING_RAIL;
}

/**
 * Derive the single next step from the wallet overview. Mirrors the server's
 * launch-gate rule (`buildOnboardingState`): an active card plus auto-reload
 * bound to that card. A spendable balance alone does not finish setup, because
 * the balance runs out and the backstop is what stops the next order being
 * cancelled on the marketplace.
 */
export function deriveWalletSetupState(wallet: DropshipWalletOverview): WalletSetupState {
  const cardMethods = wallet.fundingMethods.filter(
    (method) => isCardFundingMethod(method) && method.status === "active",
  );
  const hasPendingCardMethod = wallet.fundingMethods.some(
    (method) => isCardFundingMethod(method) && method.status !== "active",
  );
  const configuredId = wallet.autoReload?.fundingMethodId ?? null;
  const configuredMethod = configuredId === null
    ? null
    : cardMethods.find((method) => method.fundingMethodId === configuredId) ?? null;
  const primaryMethod = configuredMethod
    ?? cardMethods.find((method) => method.isDefault)
    ?? cardMethods[0]
    ?? null;
  const orderedMethods = primaryMethod
    ? [primaryMethod, ...cardMethods.filter((method) => method !== primaryMethod)]
    : [];
  const autoReloadOn = wallet.autoReload?.enabled === true;
  const autoReloadReady = autoReloadOn && configuredMethod !== null;

  let stage: WalletSetupStage;
  if (autoReloadReady) stage = "ready";
  else if (primaryMethod) stage = "auto_reload";
  else if (hasPendingCardMethod) stage = "confirm_card";
  else stage = "add_card";

  return {
    stage,
    primaryMethod,
    cardMethods: orderedMethods,
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
