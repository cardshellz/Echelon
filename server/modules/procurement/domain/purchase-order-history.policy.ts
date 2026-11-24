import { z } from "zod";

export const purchaseOrderHistorySchema = z.object({
  hasEvents: z.boolean(), hasStatusHistory: z.boolean(), hasRevisions: z.boolean(),
});
export type PurchaseOrderHistoryPresence = z.infer<typeof purchaseOrderHistorySchema>;

export const PURCHASE_ORDER_HISTORY_DELETE_MESSAGE = "This purchase order has recorded history. Cancel it instead of deleting it to preserve the audit trail.";

export function retainedPurchaseOrderHistoryKinds(history: PurchaseOrderHistoryPresence): string[] {
  const kinds: string[] = [];
  if (history.hasEvents) kinds.push("events");
  if (history.hasStatusHistory) kinds.push("status_history");
  if (history.hasRevisions) kinds.push("revisions");
  return kinds;
}
