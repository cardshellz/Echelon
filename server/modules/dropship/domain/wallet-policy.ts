/**
 * Dropship wallet policy — the limits the vendor wallet enforces.
 *
 * Ten numbers, staff-managed as versioned data
 * (`dropship.dropship_wallet_policies`, migrations 0682 and 0683):
 *
 *   - the two LISTING TIER minimums. A vendor selling eaches and inner packs
 *     (variant type P, B) keeps at least the pack tier minimum; a vendor with
 *     case listings (variant type C) enabled keeps at least the case tier
 *     minimum. One balance, one minimum per vendor: the highest tier enabled.
 *     The pack tier minimum is also the auto-reload trigger floor no vendor
 *     may set below, which is why its field keeps the name the vendor DTO has
 *     always served.
 *   - the smallest permitted single auto-reload top-up;
 *   - the bounds on a vendor-initiated manual top-up;
 *   - how long an unfunded order waits in payment hold, and how long before
 *     that hold expires the vendor is warned;
 *   - the pending-ACH ADVANCE: the service fee (basis points) on the pending
 *     amount an order is accepted against, and the global cap on that amount.
 *     A cap of zero advances nothing — arithmetic, not a flag;
 *   - the GRACE PERIOD a vendor below a raised tier minimum keeps that tier's
 *     listings before they are unpublished.
 *
 * This module holds the PURE part: the shape, the documented fallback used when
 * no policy row exists, and the invariants, so the SQL CHECK constraints and
 * the Zod boundary schema can be tested against the same rules without a
 * database.
 *
 * Money is integer cents. Fees are basis points. Timings are whole minutes or
 * whole days. Nothing here reads the database or the clock.
 */

import { DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES } from "../../../../shared/schema/dropship.schema";

/**
 * The resolved limits. Field names match the vendor wallet DTO
 * (`wallet.limits`) the portal reads, so the serializer is a straight pass
 * through rather than a rename table nobody can keep in sync.
 */
export interface DropshipWalletPolicyLimits {
  /**
   * Pack tier minimum (eaches and inner packs, variant type P, B). Auto-reload
   * fires below this balance and no vendor may set a lower minimum.
   */
  autoReloadMinTriggerCents: number;
  /** Case tier minimum (variant type C). Never below the pack tier minimum. */
  caseTierMinimumCents: number;
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
  /** Service fee, in basis points, on the pending-ACH amount an order is accepted against. */
  advanceFeeBps: number;
  /** Global ceiling on the pending-ACH amount an order may be accepted against. Zero advances nothing. */
  advanceCapCents: number;
  /** Days a vendor below a raised tier minimum keeps that tier's listings before they are unpublished. */
  tierChangeGraceDays: number;
}

/**
 * Resolves the limits in force. Implemented by the wallet policy service (the
 * active DB row, falling back to the documented defaults) and injected into the
 * wallet service, so the wallet never reads `process.env` directly.
 */
export interface DropshipWalletPolicyResolver {
  resolveWalletLimits(): Promise<DropshipWalletPolicyLimits>;
}

/**
 * Listing tier minimums (owner decision, 2026-09-20): $100 for eaches and inner
 * packs, $500 for cases. The pack tier doubles as the auto-reload TRIGGER
 * floor, which is the number that matters operationally: auto-reload fires
 * when the balance drops BELOW it, so a trigger smaller than a single order's
 * debit leaves the balance sitting above the trigger while still failing to
 * cover the next order.
 */
export const DEFAULT_AUTO_RELOAD_MIN_TRIGGER_CENTS = 10_000;
export const DEFAULT_CASE_TIER_MINIMUM_CENTS = 50_000;

/**
 * The AMOUNT floor keeps Stripe's fixed per-charge fee from dominating: at
 * 2.9% + $0.30, a $25 reload costs ~4.1% against ~3.0% at $250.
 */
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
 * The pending-ACH advance (owner decision, 2026-09-20): 1% on the amount
 * used, at most $500 per vendor unless their credit profile overrides the cap.
 */
export const DEFAULT_ADVANCE_FEE_BPS = 100;
export const DEFAULT_ADVANCE_CAP_CENTS = 50_000;

/** Grace after a tier minimum is raised (owner decision, 2026-09-20). */
export const DEFAULT_TIER_CHANGE_GRACE_DAYS = 14;

/**
 * 30 days. The ceiling the auto-reload input schema already enforces and the
 * `dropship_wallet_policies_hold_timeout_chk` CHECK constraint mirrors.
 */
export const MAX_PAYMENT_HOLD_TIMEOUT_MINUTES = 60 * 24 * 30;

/** 100%. A fee above the whole amount is a data error, not a policy. */
export const MAX_ADVANCE_FEE_BPS = 10_000;

/** A year. A typo must not grandfather a vendor forever. */
export const MAX_TIER_CHANGE_GRACE_DAYS = 365;

/**
 * The environment variable each limit falls back to, for the admin read. The
 * limits introduced by the funding design (case tier, advance, grace) and the
 * hold timeout have no environment override: their fallback is the documented
 * default in this module, and the policy row is the only way to move them.
 */
export const DROPSHIP_WALLET_POLICY_ENV_KEYS = Object.freeze({
  autoReloadMinTriggerCents: "DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS",
  caseTierMinimumCents: null,
  autoReloadMinAmountCents: "DROPSHIP_AUTO_RELOAD_MIN_AMOUNT_CENTS",
  manualFundingMinCents: "DROPSHIP_STRIPE_MIN_WALLET_FUNDING_CENTS",
  manualFundingMaxCents: "DROPSHIP_STRIPE_MAX_WALLET_FUNDING_CENTS",
  // No env override exists for the hold timeout: it is the schema default on
  // dropship.dropship_auto_reload_settings.payment_hold_timeout_minutes.
  defaultPaymentHoldTimeoutMinutes: null,
  holdExpiryWarningMinutes: "DROPSHIP_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES",
  advanceFeeBps: null,
  advanceCapCents: null,
  tierChangeGraceDays: null,
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
 * The fallback layer: the limits derived from the environment and the
 * documented defaults, used when no policy row exists. `env` is injectable so
 * the result is deterministic under test rather than depending on ambient
 * process state.
 *
 * The case tier is derived so that the fallback can never violate its own
 * invariant: an environment that raises the pack floor above $500 raises the
 * case tier with it.
 */
export function resolveDropshipWalletPolicyLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DropshipWalletPolicyLimits {
  const autoReloadMinTriggerCents = parsePositiveEnvInteger(
    env[DROPSHIP_WALLET_POLICY_ENV_KEYS.autoReloadMinTriggerCents],
    DEFAULT_AUTO_RELOAD_MIN_TRIGGER_CENTS,
  );
  return {
    autoReloadMinTriggerCents,
    caseTierMinimumCents: Math.max(DEFAULT_CASE_TIER_MINIMUM_CENTS, autoReloadMinTriggerCents),
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
    advanceFeeBps: DEFAULT_ADVANCE_FEE_BPS,
    advanceCapCents: DEFAULT_ADVANCE_CAP_CENTS,
    tierChangeGraceDays: DEFAULT_TIER_CHANGE_GRACE_DAYS,
  };
}

export interface WalletPolicyInvariantViolation {
  field: keyof DropshipWalletPolicyLimits;
  message: string;
}

/**
 * The cross-field rules, mirroring the CHECK constraints in migrations 0682 and
 * 0683. Returns every violation rather than the first, so staff fix one form
 * instead of playing whack-a-mole. Per-field positivity/range is left to the
 * Zod schema at the boundary; this function assumes integers and checks the
 * relationships.
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
  if (limits.caseTierMinimumCents < limits.autoReloadMinTriggerCents) {
    violations.push({
      field: "caseTierMinimumCents",
      message: "Case tier minimum must be at least the pack tier minimum.",
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
