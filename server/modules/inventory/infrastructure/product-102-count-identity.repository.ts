import type { PoolClient } from "pg";
import {
  PRODUCT_102_CLEANUP_KEY,
  PRODUCT_102_COUNT_IDS,
  cleanupRequire,
} from "@shared/catalog/product-102-cleanup-contract";

/** Fix only the reviewed historical count links. This is not a quantity writer
 * and must run inside the catalog cleanup's already authorized transaction. */
export async function correctProduct102CountIdentity(
  client: PoolClient,
): Promise<void> {
  const admitted = (
    await client.query<{ admitted: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM catalog.product_cleanup_receipts
    WHERE command_key=$1 AND owner_transaction_id=pg_current_xact_id()::text) AS admitted`,
      [PRODUCT_102_CLEANUP_KEY],
    )
  ).rows[0].admitted;
  cleanupRequire(
    admitted,
    "CLEANUP_ADMISSION_MISSING",
    "Count correction requires the current authorized cleanup transaction.",
  );
  const result = await client.query(
    "UPDATE inventory.cycle_count_items SET product_id=5 WHERE id=ANY($1::int[]) AND product_id=102",
    [PRODUCT_102_COUNT_IDS],
  );
  cleanupRequire(
    result.rowCount === PRODUCT_102_COUNT_IDS.length,
    "CLEANUP_WRITE_SCOPE_CHANGED",
    "The exact count-link row count changed; roll back the transaction.",
  );
}
