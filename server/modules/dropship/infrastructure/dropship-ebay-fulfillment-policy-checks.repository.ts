import type { PoolClient } from "pg";

/**
 * The latest verdict on each shipping policy a store's live eBay listings use
 * (plan v4 §6.3, SB27), and the verdict the vendor was last told about. Runs
 * on the caller's client and transaction; the notice that a verdict change
 * sends is written in the same transaction as `notified_verdict_hash`.
 */
type Client = Pick<PoolClient, "query">;

export interface FulfillmentPolicyCheck {
  storeConnectionId: number;
  fulfillmentPolicyId: string;
  compatible: boolean;
  issueCodes: string[];
  verdictHash: string;
  notifiedVerdictHash: string | null;
  checkedAt: Date;
}

interface CheckRow {
  store_connection_id: number; fulfillment_policy_id: string; compatible: boolean; issue_codes: string[];
  verdict_hash: string; notified_verdict_hash: string | null; checked_at: Date;
}

/**
 * Records a fresh verdict, keeping the verdict last told (a new verdict
 * never erases what the vendor was told). Answers the stored row. A read that
 * gave no verdict is never recorded, so the previous verdict stands.
 */
export async function upsertFulfillmentPolicyCheckWithClient(client: Client, input: {
  storeConnectionId: number; fulfillmentPolicyId: string; compatible: boolean; issueCodes: readonly string[];
  verdictHash: string; checkedAt: Date;
}): Promise<FulfillmentPolicyCheck> {
  const result = await client.query<CheckRow>(`INSERT INTO dropship.dropship_ebay_fulfillment_policy_checks
      (store_connection_id, fulfillment_policy_id, compatible, issue_codes, verdict_hash, checked_at)
    VALUES ($1, $2, $3, $4::text[], $5, $6)
    ON CONFLICT (store_connection_id, fulfillment_policy_id) DO UPDATE SET compatible = EXCLUDED.compatible,
      issue_codes = EXCLUDED.issue_codes, verdict_hash = EXCLUDED.verdict_hash, checked_at = EXCLUDED.checked_at
    RETURNING store_connection_id, fulfillment_policy_id, compatible, issue_codes, verdict_hash, notified_verdict_hash, checked_at`,
  [input.storeConnectionId, input.fulfillmentPolicyId, input.compatible, [...new Set(input.issueCodes)].sort(), input.verdictHash, input.checkedAt]);
  return mapCheck(result.rows[0]!);
}

/**
 * Remembers which verdict the vendor was told about (null: the "fixed"
 * line), only while the stored verdict is still `verdictHash`. Answers
 * whether it applied.
 */
export async function setFulfillmentPolicyNotifiedVerdictWithClient(client: Client, input: {
  storeConnectionId: number; fulfillmentPolicyId: string; verdictHash: string; notifiedVerdictHash: string | null;
}): Promise<boolean> {
  const result = await client.query(`UPDATE dropship.dropship_ebay_fulfillment_policy_checks SET notified_verdict_hash = $4
    WHERE store_connection_id = $1 AND fulfillment_policy_id = $2 AND verdict_hash = $3`,
  [input.storeConnectionId, input.fulfillmentPolicyId, input.verdictHash, input.notifiedVerdictHash]);
  return result.rowCount === 1;
}

function mapCheck(row: CheckRow): FulfillmentPolicyCheck {
  return {
    storeConnectionId: row.store_connection_id, fulfillmentPolicyId: row.fulfillment_policy_id, compatible: row.compatible,
    issueCodes: row.issue_codes, verdictHash: row.verdict_hash, notifiedVerdictHash: row.notified_verdict_hash, checkedAt: row.checked_at,
  };
}
