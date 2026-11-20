import type { PoolClient } from "pg";
import { z } from "zod";

const orderIdSchema = z.number().int().positive().safe();

/** Published customer-account write surface for a changed upstream read model.
 * The caller owns this transaction: invalidation commits or rolls back with its
 * source evidence. This function never starts a transaction or calls providers.
 */
export async function invalidateCustomerOrderActions(
  transaction: PoolClient,
  rawOmsOrderId: number,
): Promise<void> {
  const omsOrderId = orderIdSchema.parse(rawOmsOrderId);
  await transaction.query(
    "INSERT INTO oms.customer_order_action_invalidations(oms_order_id) VALUES($1)",
    [omsOrderId],
  );
}
