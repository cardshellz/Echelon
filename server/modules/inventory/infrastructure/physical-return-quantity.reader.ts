import { sql } from "drizzle-orm";
import { costInteger, CostEvidenceError } from "./cost-evidence-values";
import type { CostEvidenceTransaction } from "./cost-evidence.repository";

/** Published Inventory fact read. Orders supplies its locked source quantities;
 * Inventory owns the exact physical return journal attribution and units.
 */
export async function readPhysicalReturnQuantities(tx: CostEvidenceTransaction, orderId: number,
  orderItemIds: readonly number[]): Promise<ReadonlyMap<number, bigint>> {
  costInteger(orderId, "wmsOrderId", 1);
  orderItemIds.forEach(id=>costInteger(id, "wmsOrderItemId", 1));
  if (orderItemIds.length === 0 || orderItemIds.length > 200 || new Set(orderItemIds).size !== orderItemIds.length) {
    throw new CostEvidenceError("RETURN_HISTORY_INPUT_INVALID", "Return history requires exact distinct source items.");
  }
  const result = await tx.execute(sql`SELECT order_item_id,variant_qty_delta FROM inventory.inventory_transactions
    WHERE order_id=${orderId} AND transaction_type='return' AND voided_at IS NULL
      AND order_item_id IN (${sql.join(orderItemIds.map(id=>sql`${id}`),sql`, `)})`);
  const totals = new Map<number, bigint>();
  for (const row of result.rows) {
    const itemId = costInteger(row.order_item_id, "return.orderItemId", 1);
    const quantity = costInteger(row.variant_qty_delta, "return.quantity", 1);
    if (!orderItemIds.includes(itemId)) throw new CostEvidenceError("RETURN_HISTORY_IDENTITY_INVALID", "Physical return history changed source identity.");
    totals.set(itemId, (totals.get(itemId) ?? BigInt(0)) + BigInt(quantity));
  }
  return totals;
}
