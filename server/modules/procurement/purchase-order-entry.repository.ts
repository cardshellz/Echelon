import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@shared/schema";
import { PurchaseOrderEntryError } from "./domain/purchase-order-entry";

export type PurchaseOrderEntryTransaction = Pick<NodePgDatabase<typeof schema>, "execute" | "transaction" | "select" | "insert">;

/** The legacy cache has no actor, route, original status or atomic commit
 * evidence. Never reinterpret one of its rows as a new unexecuted request. */
export async function assertNoLegacyPurchaseOrderEntry(tx: PurchaseOrderEntryTransaction, key: string): Promise<void> {
  const result = await tx.execute(sql`SELECT key FROM public.idempotency_keys WHERE key=${key} LIMIT 1`);
  if (result.rows.length > 0) throw new PurchaseOrderEntryError("PURCHASE_ORDER_ENTRY_LEGACY_REVIEW_REQUIRED",
    "This request has an older unresolved record. Review the purchase order outcome before starting another request; the original key has been retained.", 409);
}
