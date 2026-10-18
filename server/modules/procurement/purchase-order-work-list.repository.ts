import { and, desc, eq, ilike, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { purchaseOrders } from "@shared/schema";
export interface PurchaseOrderWorkListFilters {
  vendorId?: number;
  search: string;
  excludeIds?: readonly number[];
  excludedStatuses: readonly string[];
  limit: number;
  offset: number;
}

export async function readPurchaseOrderWorkList(query: PurchaseOrderWorkListFilters) {
  const conditions: SQL[] = [];
  if (query.vendorId !== undefined) conditions.push(eq(purchaseOrders.vendorId, query.vendorId));
  if (query.excludedStatuses.length) conditions.push(notInArray(purchaseOrders.status, [...query.excludedStatuses]));
  if (query.excludeIds?.length) conditions.push(notInArray(purchaseOrders.id, [...query.excludeIds]));
  if (query.search) {
    const pattern = `%${query.search.replace(/[\\%_]/g, character => `\\${character}`)}%`;
    conditions.push(or(ilike(purchaseOrders.poNumber, pattern), ilike(purchaseOrders.referenceNumber, pattern))!);
  }
  const predicate = and(...conditions);
  return db.transaction(async tx => {
    const [count] = await tx.select({ total: sql<string>`count(*)` }).from(purchaseOrders).where(predicate);
    const items = await tx.select({ id: purchaseOrders.id, vendorId: purchaseOrders.vendorId, poNumber: purchaseOrders.poNumber,
      status: purchaseOrders.status, totalCents: purchaseOrders.totalCents }).from(purchaseOrders).where(predicate)
      .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id)).limit(query.limit).offset(query.offset);
    const total = Number(count.total);
    return { items, total, limit: query.limit, offset: query.offset,
      nextOffset: query.offset + items.length < total ? query.offset + items.length : null };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
