/**
 * The rewards rates in force, read on the caller's client so the accrual is
 * decided inside the same transaction that settles the credit (funding
 * design phase 7). The staff-managed policy row carries the rates; a database
 * with no policy row (or one migrated before the table existed) uses the
 * documented launch defaults, the same fallback the wallet policy service
 * serves. Read-only.
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
import { DropshipError } from "../domain/errors";

const POLICY_TABLE = "dropship.dropship_wallet_policies";

interface RewardsRatesRow {
  rewards_rate_bank_bps: number | string | null;
  rewards_rate_usdc_bps: number | string | null;
  rewards_rate_card_bps: number | string | null;
}

export async function loadRewardsRatesInForceWithClient(client: PoolClient): Promise<DropshipWalletRewardsRates> {
  const present = await client.query<{ present: string | null }>(
    `SELECT to_regclass($1)::text AS present`,
    [POLICY_TABLE],
  );
  if (!present.rows[0]?.present) {
    return { ...DEFAULT_WALLET_REWARDS_RATES };
  }
  const result = await client.query<RewardsRatesRow>(
    `SELECT rewards_rate_bank_bps, rewards_rate_usdc_bps, rewards_rate_card_bps
     FROM dropship.dropship_wallet_policies
     WHERE is_active = true
     LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) {
    return { ...DEFAULT_WALLET_REWARDS_RATES };
  }
  return {
    bankBps: rateBps(row.rewards_rate_bank_bps, "rewards_rate_bank_bps"),
    usdcBps: rateBps(row.rewards_rate_usdc_bps, "rewards_rate_usdc_bps"),
    cardBps: rateBps(row.rewards_rate_card_bps, "rewards_rate_card_bps"),
  };
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
