import type { PoolClient } from "pg";

/**
 * The setup check the order-intake health ledger writes for a store. It reports
 * how order intake is running; it is not a setup step.
 */
export const ORDER_INTAKE_HEALTH_SETUP_CHECK_KEY = "order_intake_health";

/**
 * SQL condition, over `dropship.dropship_store_setup_checks`, for a check that
 * blocks a store. A store with such a check gets setup status
 * "attention_required", which stops order intake, listing pushes and order
 * acceptance for it. Bind the order-intake health check key at `$keyParam`.
 *
 * The order-intake health check never blocks. It is raised when polls fail and
 * cleared only by a successful poll, so letting it block the store stopped the
 * very polls that would clear it, and an order recorded meanwhile was rejected
 * as "not launch-ready". It stays visible to the vendor and ops as a check.
 */
export function openStoreSetupBlockerCondition(alias: string, keyParam: string): string {
  return `${alias}.resolved_at IS NULL
       AND ${alias}.status <> 'passed'
       AND ${alias}.severity IN ('blocker','error')
       AND ${alias}.check_key <> ${keyParam}`;
}

/** Whether the store has a setup check that blocks it (see `openStoreSetupBlockerCondition`). */
export async function hasOpenStoreSetupBlockers(
  client: PoolClient,
  storeConnectionId: number,
): Promise<boolean> {
  const result = await client.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count
     FROM dropship.dropship_store_setup_checks ssc
     WHERE ssc.store_connection_id = $1
       AND ${openStoreSetupBlockerCondition("ssc", "$2")}`,
    [storeConnectionId, ORDER_INTAKE_HEALTH_SETUP_CHECK_KEY],
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}
