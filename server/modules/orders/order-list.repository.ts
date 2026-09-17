import { and, asc, desc, eq, gt, inArray, isNotNull, max, notInArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { wmsOrders as orders, wmsOrderItems as items, type WmsOrder, type WmsOrderItem } from "@shared/schema";
import { WMS_BUCKET_STATUSES, WMS_ORDER_BUCKETS, type WmsOrderBucket, type WmsOrderBucketCounts } from "@shared/wms-order-listing";
import type { db } from "../../db";

export const ORDER_PAGE_SIZE = 100;
export const MAX_ORDER_PAGE_SIZE = 250;
// Three bounded queries must finish comfortably inside a web request. This is
// transaction-local: no setting leaks to the pool or to inventory writes.
export const ORDER_LIST_STATEMENT_TIMEOUT_MS = 5_000;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const positiveId = z.number().int().positive().max(MAX_DATABASE_INTEGER);
const statusList = z.array(z.string().min(1).max(40)).max(30);

export const orderPageQuerySchema = z.object({
  bucket: z.enum(WMS_ORDER_BUCKETS).default("needs_pick"),
  statuses: statusList.optional(),
  channelId: positiveId.optional(),
  warehouseId: positiveId.optional(),
  source: z.string().max(100).optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(MAX_ORDER_PAGE_SIZE).default(ORDER_PAGE_SIZE),
  offset: z.number().int().min(0).max(MAX_DATABASE_INTEGER).default(0),
});
export type OrderPageQuery = z.input<typeof orderPageQuerySchema>;
export type OrderWithItems = WmsOrder & { items: WmsOrderItem[] };
export interface OrderPage {
  orders: OrderWithItems[];
  total: number;
  limit: number;
  offset: number;
  buckets: WmsOrderBucketCounts;
}

const scanQuerySchema = z.object({
  statuses: statusList.optional(),
  excludedStatuses: statusList.optional(),
  completedOnly: z.boolean().optional(),
  externalOrderOnly: z.boolean().optional(),
});
export type OrderScanQuery = z.input<typeof scanQuerySchema>;
type ReadDatabase = Pick<typeof db, "select">;

function bucketPredicate(bucket: WmsOrderBucket): SQL {
  if (bucket === "all") return sql`true`;
  const normalizedStatus = sql`lower(btrim(${orders.warehouseStatus}))`;
  const held = sql`(coalesce(${orders.onHold}, 0) = 1 or ${normalizedStatus} = 'on_hold')`;
  const matchesStatus = inArray(normalizedStatus, [...WMS_BUCKET_STATUSES[bucket]]);
  return bucket === "issues" ? sql`(${held} or ${matchesStatus})` : sql`(not ${held} and ${matchesStatus})`;
}

function scopePredicate(query: z.output<typeof orderPageQuerySchema>): SQL | undefined {
  const predicates: SQL[] = [];
  if (query.channelId !== undefined) predicates.push(eq(orders.channelId, query.channelId));
  if (query.warehouseId !== undefined) predicates.push(eq(orders.warehouseId, query.warehouseId));
  if (query.source) predicates.push(eq(orders.source, query.source));
  if (query.search) {
    // strpos preserves literal substring semantics for %, _ and backslashes;
    // using LIKE without escaping would silently broaden the user's search.
    const term = query.search.toLowerCase();
    predicates.push(sql`(
      strpos(lower(coalesce(${orders.orderNumber}, '')), ${term}) > 0 or
      strpos(lower(coalesce(${orders.customerName}, '')), ${term}) > 0 or
      strpos(lower(coalesce(${orders.customerEmail}, '')), ${term}) > 0 or
      strpos(lower(coalesce(${orders.externalOrderId}, '')), ${term}) > 0 or
      exists (select 1 from ${items} where ${items.orderId} = ${orders.id}
        and (strpos(lower(${items.sku}), ${term}) > 0 or strpos(lower(${items.name}), ${term}) > 0))
    )`);
  }
  return and(...predicates);
}

async function attachItems(database: ReadDatabase, page: WmsOrder[]): Promise<OrderWithItems[]> {
  if (page.length === 0) return [];
  // Only the selected page's lines cross the DB boundary. Drizzle maps order_id
  // and picked_quantity to their API names; raw SELECT * did not do that.
  const lines = await database.select().from(items)
    .where(inArray(items.orderId, page.map(order => order.id))).orderBy(asc(items.id));
  const byOrder = new Map<number, WmsOrderItem[]>();
  for (const line of lines) {
    const group = byOrder.get(line.orderId) ?? [];
    group.push(line);
    byOrder.set(line.orderId, group);
  }
  return page.map(order => ({ ...order, items: byOrder.get(order.id) ?? [] }));
}

/** Bounded read model shared by WMS Orders and the legacy orders listing. */
export class OrderListRepository {
  constructor(private readonly database: typeof db) {}

  async page(input: OrderPageQuery): Promise<OrderPage> {
    const query = orderPageQuerySchema.parse(input);
    const scope = scopePredicate(query);
    const selected = query.statuses?.length
      ? inArray(orders.warehouseStatus, query.statuses)
      : bucketPredicate(query.bucket);
    // Counts, headers and lines describe the same snapshot even during picking.
    // This short, read-only transaction never spans provider calls or writes.
    return this.database.transaction(async transaction => {
      await transaction.execute(sql`select set_config('statement_timeout', ${String(ORDER_LIST_STATEMENT_TIMEOUT_MS)}, true)`);
      const countWhere = (predicate: SQL) => sql<number>`count(*) filter (where ${predicate})`.mapWith(Number);
      const [counts] = await transaction.select({
        needsPick: countWhere(bucketPredicate("needs_pick")),
        picked: countWhere(bucketPredicate("picked")),
        issues: countWhere(bucketPredicate("issues")),
        shipped: countWhere(bucketPredicate("shipped")),
        cancelled: countWhere(bucketPredicate("cancelled")),
        all: sql<number>`count(*)`.mapWith(Number),
        total: countWhere(selected),
      }).from(orders).where(scope);
      const page = await transaction.select().from(orders)
        .where(and(scope, selected)).orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(query.limit).offset(query.offset);
      const { total, ...buckets } = counts;
      return { orders: await attachItems(transaction, page), total, buckets, limit: query.limit, offset: query.offset };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  /**
   * Administrative scans use keyset pages, not a lifetime-sized array or OFFSET
   * over a mutating status set. The initial high-water ID prevents an endless
   * scan when new orders arrive. Each order is visited at most once.
   */
  async *scan(input: OrderScanQuery = {}): AsyncGenerator<OrderWithItems[]> {
    const query = scanQuerySchema.parse(input);
    const filters: SQL[] = [];
    if (query.statuses?.length) filters.push(inArray(orders.warehouseStatus, query.statuses));
    if (query.excludedStatuses?.length) filters.push(notInArray(orders.warehouseStatus, query.excludedStatuses));
    if (query.completedOnly) filters.push(isNotNull(orders.completedAt));
    if (query.externalOrderOnly) filters.push(sql`coalesce(${orders.externalOrderId}, '') <> ''`);
    const [ceiling] = await this.database.select({ id: max(orders.id) }).from(orders).where(and(...filters));
    if (ceiling.id === null) return;
    let afterId = 0;
    while (afterId < ceiling.id) {
      const batch = await this.database.select().from(orders)
        .where(and(...filters, gt(orders.id, afterId), sql`${orders.id} <= ${ceiling.id}`))
        .orderBy(asc(orders.id)).limit(ORDER_PAGE_SIZE);
      if (batch.length === 0) return;
      afterId = batch[batch.length - 1].id;
      yield await attachItems(this.database, batch);
    }
  }
}
