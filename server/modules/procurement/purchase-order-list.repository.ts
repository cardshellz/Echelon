import { and, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { purchaseOrders } from "@shared/schema";
import { db } from "../../db";
import { readPoFinancialEvidenceSourcesWithClient } from "./po-financial-evidence.repository";

export interface PurchaseOrderListFilters {
  status?: string | string[];
  physicalStatus?: string | string[];
  /** Historical whole-linked-invoice filter retained for older API callers. */
  financialStatus?: string | string[];
  vendorId?: number;
  search?: string;
}

function listPredicate(filters: PurchaseOrderListFilters): SQL | undefined {
  const conditions: SQL[] = [];
  for (const [column, value] of [
    [purchaseOrders.status, filters.status],
    [purchaseOrders.physicalStatus, filters.physicalStatus],
    [purchaseOrders.financialStatus, filters.financialStatus],
  ] as const) {
    if (value !== undefined) conditions.push(inArray(column, typeof value === "string" ? [value] : value));
  }
  if (filters.vendorId !== undefined) conditions.push(eq(purchaseOrders.vendorId, filters.vendorId));
  if (filters.search) conditions.push(or(
    like(purchaseOrders.poNumber, `%${filters.search}%`),
    like(purchaseOrders.referenceNumber, `%${filters.search}%`),
  )!);
  return and(...conditions);
}

type ListDatabase = Pick<typeof db, "transaction">;

/** All pages and invoice evidence share one read snapshot. Workflow selection is
 * supplied by the application, never duplicated as SQL financial-status rules. */
export function createPurchaseOrderListRepository(database: ListDatabase = db) {
  return {
    snapshot<T>(filters: PurchaseOrderListFilters, read: (source: {
      rows(limit: number, offset: number): Promise<(typeof purchaseOrders.$inferSelect)[]>;
      count(): Promise<number>;
      evidence: (ids: readonly number[]) => ReturnType<typeof readPoFinancialEvidenceSourcesWithClient>;
    }) => Promise<T>): Promise<T> {
      const predicate = listPredicate(filters);
      return database.transaction(async tx => read({
        rows: (limit, offset) => tx.select().from(purchaseOrders).where(predicate)
          .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id)).limit(limit).offset(offset),
        count: async () => {
          const [row] = await tx.select({ count: sql<string>`COUNT(*)::text` }).from(purchaseOrders).where(predicate);
          const count = Number(row.count);
          if (!Number.isSafeInteger(count) || count < 0) throw new Error("Purchase order count is outside the supported range");
          return count;
        },
        evidence: ids => readPoFinancialEvidenceSourcesWithClient(tx, ids),
      }), { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}
