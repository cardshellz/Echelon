/**
 * Reads the facts the pending-ACH advance is decided from, on a transaction
 * client so the acceptance transaction and the wallet view see one consistent
 * snapshot (funding design phase 3; rules in domain/acceptance-funding.ts).
 *
 * Two readers, both fail-closed:
 *   - loadAdvancePolicyWithClient: the fee and the effective cap (the vendor's
 *     credit-profile override, else the active policy). Null when the policy
 *     table is not there yet, so a dyno booting ahead of a release-phase
 *     migration accepts orders without advancing anything.
 *   - loadAdvanceSourcesWithClient: every bank account (ACH funding method) of
 *     the vendor with the three facts the domain needs. A verification table
 *     that does not exist yet reads as "no balance verified".
 *
 * Every relation the acceptance transaction cannot assume is probed with
 * to_regclass first: a query against a missing relation aborts the whole
 * transaction, which would refuse orders rather than merely refuse advances.
 */

import type { PoolClient } from "pg";
import { DropshipError } from "../domain/errors";
import { fundingMethodAccountHolderType } from "../domain/funding-method";
import { resolveEffectiveAdvanceCapCents } from "../domain/vendor-credit";
import type { DropshipAdvancePolicy, DropshipAdvanceSource } from "../domain/acceptance-funding";

const POLICY_TABLE = "dropship.dropship_wallet_policies";
const CREDIT_PROFILE_TABLE = "dropship.dropship_vendor_credit_profiles";
const VERIFICATION_TABLE = "dropship.dropship_funding_method_balance_verifications";

/** The one rail whose pending credits can be advanced against. */
const ADVANCE_RAIL = "stripe_ach";

interface PolicyRow {
  advance_fee_bps: number | string;
  advance_cap_cents: number | string;
}

interface CreditProfileRow {
  advance_cap_override_cents: number | string | null;
}

interface SourceRow {
  funding_method_id: number;
  metadata: Record<string, unknown> | null;
  pending_cents: string | number;
  prior_pull_settled: boolean;
  balance_verified: boolean;
}

export async function relationExistsWithClient(client: PoolClient, relation: string): Promise<boolean> {
  const result = await client.query<{ present: string | null }>(
    `SELECT to_regclass($1)::text AS present`,
    [relation],
  );
  return Boolean(result.rows[0]?.present);
}

export async function loadAdvancePolicyWithClient(
  client: PoolClient,
  vendorId: number,
): Promise<DropshipAdvancePolicy | null> {
  if (!await relationExistsWithClient(client, POLICY_TABLE)) {
    return null;
  }
  const policy = await client.query<PolicyRow>(
    `SELECT advance_fee_bps, advance_cap_cents
     FROM dropship.dropship_wallet_policies
     WHERE is_active = true
     LIMIT 1`,
  );
  const row = policy.rows[0];
  if (!row) {
    return null;
  }
  const feeBps = toSafeInteger(row.advance_fee_bps, "advance_fee_bps");
  const policyAdvanceCapCents = toSafeInteger(row.advance_cap_cents, "advance_cap_cents");
  let override: number | null = null;
  if (await relationExistsWithClient(client, CREDIT_PROFILE_TABLE)) {
    const profile = await client.query<CreditProfileRow>(
      `SELECT advance_cap_override_cents
       FROM dropship.dropship_vendor_credit_profiles
       WHERE vendor_id = $1
       LIMIT 1`,
      [vendorId],
    );
    const value = profile.rows[0]?.advance_cap_override_cents ?? null;
    override = value === null ? null : toSafeInteger(value, "advance_cap_override_cents");
  }
  const cap = resolveEffectiveAdvanceCapCents({
    policyAdvanceCapCents,
    profile: override === null ? null : { advanceCapOverrideCents: override },
  });
  return { feeBps, capCents: cap.advanceCapCents, capSource: cap.source };
}

/**
 * The vendor's bank accounts with, for each, its pending funding credits on
 * this wallet, whether an earlier pull settled, whether a balance read
 * succeeded, and the account holder type from the method's provider metadata.
 * Archived accounts are listed only while a pending credit still rides on them.
 */
export async function loadAdvanceSourcesWithClient(
  client: PoolClient,
  input: { vendorId: number; walletAccountId: number },
): Promise<DropshipAdvanceSource[]> {
  const verificationsPresent = await relationExistsWithClient(client, VERIFICATION_TABLE);
  const balanceVerifiedSql = verificationsPresent
    ? `EXISTS (
         SELECT 1
         FROM dropship.dropship_funding_method_balance_verifications v
         WHERE v.funding_method_id = m.id
           AND v.status = 'succeeded'
       )`
    : "false";
  const result = await client.query<SourceRow>(
    `SELECT m.id AS funding_method_id,
            m.metadata,
            COALESCE(p.pending_cents, 0)::text AS pending_cents,
            EXISTS (
              SELECT 1
              FROM dropship.dropship_wallet_ledger s
              WHERE s.funding_method_id = m.id
                AND s.type = 'funding'
                AND s.status = 'settled'
            ) AS prior_pull_settled,
            ${balanceVerifiedSql} AS balance_verified
     FROM dropship.dropship_funding_methods m
     LEFT JOIN (
       SELECT funding_method_id, SUM(amount_cents) AS pending_cents
       FROM dropship.dropship_wallet_ledger
       WHERE wallet_account_id = $2
         AND type = 'funding'
         AND status = 'pending'
         AND funding_method_id IS NOT NULL
       GROUP BY funding_method_id
     ) p ON p.funding_method_id = m.id
     WHERE m.vendor_id = $1
       AND m.rail = $3
       AND (m.status = 'active' OR COALESCE(p.pending_cents, 0) > 0)
     ORDER BY m.id`,
    [input.vendorId, input.walletAccountId, ADVANCE_RAIL],
  );
  return result.rows.map((row) => ({
    fundingMethodId: toSafeInteger(row.funding_method_id, "funding_method_id"),
    pendingCents: toSafeInteger(row.pending_cents, "pending_cents"),
    accountHolderType: fundingMethodAccountHolderType(row.metadata),
    balanceVerified: row.balance_verified === true,
    priorPullSettled: row.prior_pull_settled === true,
  }));
}

function toSafeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DropshipError(
      "DROPSHIP_ADVANCE_INVALID_STORED_VALUE",
      `Dropship advance read returned a non-integer ${field}.`,
      { field, value, classification: "fatal" },
    );
  }
  return parsed;
}
