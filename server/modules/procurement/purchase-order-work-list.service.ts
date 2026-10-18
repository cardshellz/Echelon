import { purchaseOrderWorkListQuerySchema, purchaseOrderWorkListPageSchema, type PurchaseOrderWorkListQuery } from "@shared/procurement/purchase-order-work-list";
import { readPurchaseOrderWorkList, type PurchaseOrderWorkListFilters } from "./purchase-order-work-list.repository";

/** Selection policy belongs to the read application, not the persistence query.
 * Preserve the existing create-invoice exclusions; invoice linking and shipment
 * line selection rely on their mutation owners to validate supported actions. */
export function resolvePurchaseOrderWorkListFilters(query: PurchaseOrderWorkListQuery): PurchaseOrderWorkListFilters {
  const { purpose, ...filters } = query;
  return { ...filters, excludedStatuses: purpose === "invoice-create" ? ["cancelled", "voided", "closed"] : [] };
}

export async function getPurchaseOrderWorkList(rawQuery: unknown) {
  const query = purchaseOrderWorkListQuerySchema.parse(rawQuery);
  const result = purchaseOrderWorkListPageSchema.safeParse(await readPurchaseOrderWorkList(resolvePurchaseOrderWorkListFilters(query)));
  if (!result.success) throw new Error("Purchase order selection could not be verified", { cause: result.error });
  return result.data;
}
