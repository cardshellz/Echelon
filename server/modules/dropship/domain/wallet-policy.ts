/**
 * Dropship wallet policy — the limits the vendor wallet enforces.
 *
 * These six numbers decide whether a vendor may turn auto-reload on, how much
 * they may top the wallet up by hand, how long an unfunded order waits in
 * payment hold and how long before that hold expires they are warned. They are
 * staff-managed data (`dropship.dropship_wallet_policies`, migration 0681);
 * this module holds the PURE part: the shape, the documented environment
 * fallback, and the invariants, so both the SQL CHECK constraints and the Zod
 * boundary schema can be tested against the same rules without a database.
 *
 * Money is integer cents. Timings are whole minutes. Nothing here reads the
 * database or the clock.
 */

import { DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES } from "../../../../shared/schema/dropship.schema";

/**
 * The resolved limits. Field names match the vendor wallet DTO
 * (`wallet.limits`) the portal reads, so the serializer is a straight pass
 * through rather than a rename table nobody can keep in sync.
 */
export interface DropshipWalletPolicyLimits {
  /** Auto-reload fires below this balance; a vendor may not set a lower trigger. */
  autoReloadMinTriggerCents: number;
  /** Smallest permitted single auto-reload top-up. */
  autoReloadMinAmountCents: number;
  /** Smallest vendor-initiated manual top-up. */
  manualFundingMinCents: number;
  /** Largest vendor-initiated manual top-up. */
  manualFundingMaxCents: number;
  /** How long an unfunded order waits in payment hold before it is cancelled. */
  defaultPaymentHoldTimeoutMinutes: number;
  /** How long before a hold expires the vendor is warned. */
  holdExpiryWarningMinutes: number;
}

/**
 * Resolves the limits in force. Implemented by the wallet policy service (the
 * active DB row, falling back to the environment) and injected into the wallet
 * service, so the wallet never reads `process.env` directly.
 */
export interface DropshipWalletPolicyResolver {
  resolveWalletLimits(): Promise<DropshipWalletPolicyLimits>;
}

/**
 * Auto-reload floors.
 *
 * The TRIGGER floor is the one that matters operationally: auto-reload fires
 * when the balance drops BELOW the trigger, so a trigger smaller than a single
 * order's debit (product cost + shipping) leaves the balance sitting happily
 * above the trigger while still failing to cover the next order. Auto-reload
 * would be switched on and the order would still land in payment hold.
 *
 * The AMOUNT floor keeps Stripe's fixed per-charge fee from dominating: at
 * 2.9% + $0.30, a $25 reload costs ~4.1% against ~3.0% at $250.
 */
export const DEFAULT_AUTO_RELOAD_MIN_TRIGGER_CENTS = 5_000;
export const DEFAULT_AUTO_RELOAD_MIN_AMOUNT_CENTS = 10_000;

/** Bounds on a vendor-initiated Stripe wallet top-up. */
export const DEFAULT_STRIPE_MIN_WALLET_FUNDING_CENTS = 1_000;
export const DEFAULT_STRIPE_MAX_WALLET_FUNDING_CENTS = 500_000;

/**
 * How long before a payment hold expires the vendor is warned. Two hours is
 * long enough to add funds and short enough that the warning still means
 * something.
 */
export const DEFAULT_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES = 120;

/**
 * 30 days. The ceiling the auto-reload input schema already enforces and the
 * `dropship_wallet_policies_hold_timeout_chk` CHECK constraint mirrors.
 */
export const MAX_PAYMENT_HOLD_TIMEOUT_MINUTES = 60 * 24 * 30;

/** The environment variable each limit falls back to, for the admin read. */
export const DROPSHIP_WALLET_POLICY_ENV_KEYS = Object.freeze({
  autoReloadMinTriggerCents: "DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS",
  autoReloadMinAmountCents: "DROPSHIP_AUTO_RELOAD_MIN_AMOUNT_CENTS",
  manualFundingMinCents: "DROPSHIP_STRIPE_MIN_WALLET_FUNDING_CENTS",
  manualFundingMaxCents: "DROPSHIP_STRIPE_MAX_WALLET_FUNDING_CENTS",
  // No env override exists for the hold timeout: it is the schema default on
  // dropship.dropship_auto_reload_settings.payment_hold_timeout_minutes.
  defaultPaymentHoldTimeoutMinutes: null,
  holdExpiryWarningMinutes: "DROPSHIP_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES",
});

/**
 * A positive integer from the environment, or the documented default. A
 * malformed value falls back rather than throwing: these are floors, and a
 * typo must not take the wallet page down. A value that matters enough to
 * refuse (the card fee rate) is handled separately, in the wallet service.
 */
export function parsePositiveEnvInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The fallback layer: the limits derived from the environment, used when no
 * policy row exists. `env` is injectable so the result is deterministic under
 * test rather than depending on ambient process state.
 */
export function resolveDropshipWalletPolicyLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DropshipWalletPolicyLimits {
  return {
    autoReloadMinTriggerCents: parsePositiveEnvInteger(
      env[DROPSHIP_WALLET_POLICY_ENV_KEYS.autoReloadMinTriggerCents],
      DEFAULT_AUTO_RELOAD_MIN_TRIGGER_CENTS,
    ),
    autoReloadMinAmountCents: parsePositiveEnvInteger(
      env[DROPSHIP_WALLET_POLICY_ENV_KEYS.autoReloadMinAmountCents],
      DEFAULT_AUTO_RELOAD_MIN_AMOUNT_CENTS,
    ),
    manualFundingMinCents: parsePositiveEnvInteger(
      env[DROPSHIP_WALLET_POLICY_ENV_KEYS.manualFundingMinCents],
      DEFAULT_STRIPE_MIN_WALLET_FUNDING_CENTS,
    ),
    manualFundingMaxCents: parsePositiveEnvInteger(
      env[DROPSHIP_WALLET_POLICY_ENV_KEYS.manualFundingMaxCents],
      DEFAULT_STRIPE_MAX_WALLET_FUNDING_CENTS,
    ),
    defaultPaymentHoldTimeoutMinutes: DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES,
    holdExpiryWarningMinutes: parsePositiveEnvInteger(
      env[DROPSHIP_WALLET_POLICY_ENV_KEYS.holdExpiryWarningMinutes],
      DEFAULT_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES,
    ),
  };
}

export interface WalletPolicyInvariantViolation {
  field: keyof DropshipWalletPolicyLimits;
  message: string;
}

/**
 * The cross-field rules, mirroring the CHECK constraints in migration 0681.
 * Returns every violation rather than the first, so staff fix one form instead
 * of playing whack-a-mole. Per-field positivity/range is left to the Zod schema
 * at the boundary; this function assumes integers and checks the relationships.
 */
export function walletPolicyInvariantViolations(
  limits: DropshipWalletPolicyLimits,
): WalletPolicyInvariantViolation[] {
  const violations: WalletPolicyInvariantViolation[] = [];
  if (limits.manualFundingMinCents > limits.manualFundingMaxCents) {
    violations.push({
      field: "manualFundingMaxCents",
      message: "Manual top-up maximum must be at least the manual top-up minimum.",
    });
  }
  if (limits.autoReloadMinAmountCents < limits.autoReloadMinTriggerCents) {
    violations.push({
      field: "autoReloadMinAmountCents",
      message:
        "Minimum single top-up limit must be at least the minimum floor, otherwise a top-up can never clear the trigger.",
    });
  }
  if (limits.holdExpiryWarningMinutes >= limits.defaultPaymentHoldTimeoutMinutes) {
    violations.push({
      field: "holdExpiryWarningMinutes",
      message: "Hold expiry warning window must be shorter than the payment hold timeout.",
    });
  }
  return violations;
}
