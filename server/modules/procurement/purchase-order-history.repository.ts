import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { purchaseOrderHistorySchema, type PurchaseOrderHistoryPresence } from "./purchase-order-history.policy";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

export async function readPurchaseOrderHistoryPresence(
  tx: { execute(query: SQL): Promise<{ rows: unknown[] }> },
  purchaseOrderId: number,
): Promise<PurchaseOrderHistoryPresence> {
  const id = z.number().int().positive().max(POSTGRES_INTEGER_MAX).parse(purchaseOrderId);
  const result = await tx.execute(sql`
    SELECT EXISTS (SELECT 1 FROM procurement.po_events WHERE po_id=${id}) AS "hasEvents",
      EXISTS (SELECT 1 FROM procurement.po_status_history WHERE purchase_order_id=${id}) AS "hasStatusHistory",
      EXISTS (SELECT 1 FROM procurement.po_revisions WHERE purchase_order_id=${id}) AS "hasRevisions"
  `);
  return purchaseOrderHistorySchema.parse(result.rows[0]);
}

/** Drizzle may wrap the PostgreSQL error in cause; inspect only known guard
 * constraints so unrelated integrity failures retain their own classification. */
export function isPurchaseOrderHistoryConstraintViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown; cause?: unknown };
  const constraint = candidate.constraint;
  if (candidate.code === "23514" && (constraint === "po_event_history_immutable" || constraint === "purchase_order_history_retention")) return true;
  if (!candidate.cause || typeof candidate.cause !== "object") return false;
  const cause = candidate.cause as { code?: unknown; constraint?: unknown };
  return cause.code === "23514" && (cause.constraint === "po_event_history_immutable" || cause.constraint === "purchase_order_history_retention");
}