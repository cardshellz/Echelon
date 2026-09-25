/**
 * The rewards policy in force — the per-rail rates and the expiry setting —
 * read on the caller's client so an accrual is decided, and its lot dated,
 * inside the same transaction that settles the credit (funding design phase
 * 7). The staff-managed policy row carries both; a database with no policy
 * row (or one migrated before the table existed) uses the documented launch
 * defaults, the same fallback the wallet policy service serves. Read-only.
 *
 * `to_regclass` first: a query against a missing relation aborts the whole
 * transaction, and this read must never take a settlement down with it.
 */

import type { PoolClient } from "pg";
import {
  DEFAULT_WALLET_REWARDS_RATES,
  isValidRewardsRateBps,
  type DropshipWalletRewardsRates,
} from "../domain/wallet-rewards";
import { DEFAULT_REWARDS_EXPIRY_DAYS, isValidRewardsExpiryDays } from "../domain/wallet-rewards-expiry";
import { DropshipError } from "../domain/errors";

const POLICY_TABLE = "dropship.dropship_wallet_policies";

export interface DropshipRewardsPolicyInForce {
  rates: DropshipWalletRewardsRates;
  /** Days until unused points expire, or null for never. */
  expiryDays: number | null;
}

interface RewardsPolicyRow {
  rewards_rate_bank_bps: number | string | null;
  rewards_rate_usdc_bps: number | string | null;
  rewards_rate_card_bps: number | string | null;
  rewards_expiry_days: number | string | null;
}

export async function loadRewardsPolicyInForceWithClient(client: PoolClient): Promise<DropshipRewardsPolicyInForce> {
  const present = await client.query<{ present: string | null }>(
    `SELECT to_regclass($1)::text AS present`,
    [POLICY_TABLE],
  );
  if (!present.rows[0]?.present) {
    return launchDefaults();
  }
  const result = await client.query<RewardsPolicyRow>(
    `SELECT rewards_rate_bank_bps, rewards_rate_usdc_bps, rewards_rate_card_bps, rewards_expiry_days
     FROM dropship.dropship_wallet_policies
     WHERE is_active = true
     LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) {
    return launchDefaults();
  }
  return {
    rates: {
      bankBps: rateBps(row.rewards_rate_bank_bps, "rewards_rate_bank_bps"),
      usdcBps: rateBps(row.rewards_rate_usdc_bps, "rewards_rate_usdc_bps"),
      cardBps: rateBps(row.rewards_rate_card_bps, "rewards_rate_card_bps"),
    },
    expiryDays: expiryDays(row.rewards_expiry_days),
  };
}

function launchDefaults(): DropshipRewardsPolicyInForce {
  return { rates: { ...DEFAULT_WALLET_REWARDS_RATES }, expiryDays: DEFAULT_REWARDS_EXPIRY_DAYS };
}

/**
 * A stored rate outside the ceiling is a data error the CHECK constraint
 * should have refused; failing closed here keeps a corrupt row from paying
 * out, rather than defaulting it silently.
 */
function rateBps(value: number | string | null, column: string): number {
  const parsed = value === null ? Number.NaN : Number(value);
  if (!isValidRewardsRateBps(parsed)) {
    throw new DropshipError(
      "DROPSHIP_WALLET_REWARDS_RATE_UNREADABLE",
      "Dropship wallet rewards rate on the active policy is not usable.",
      { column, value, classification: "fatal" },
    );
  }
  return parsed;
}

/** Null is never; anything but null or whole days within the bound is refused, never read as "never". */
function expiryDays(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!isValidRewardsExpiryDays(parsed)) {
    throw new DropshipError(
      "DROPSHIP_WALLET_REWARDS_EXPIRY_UNREADABLE",
      "Dropship wallet rewards expiry on the active policy is not usable.",
      { column: "rewards_expiry_days", value, classification: "fatal" },
    );
  }
  return parsed;
}
