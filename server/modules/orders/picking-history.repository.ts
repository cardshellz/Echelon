import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { channels, pickingLogs, wmsOrders as orders, wmsOrderItems as items } from "@shared/schema";
import {
  MAX_PICKING_HISTORY_PAGE_SIZE, PICKING_HISTORY_PAGE_SIZE, pickingHistoryPageSchema,
  type PickingHistoryItem, type PickingHistoryPage,
} from "@shared/picking-history";
import type { db } from "../../db";
import { offsetPageQuerySchema } from "../../platform/http/page-query";
import { ORDER_LIST_STATEMENT_TIMEOUT_MS } from "./order-list.repository";

const idQuery = z.union([z.string().regex(/^\d+$/).transform(Number), z.number()])
  .pipe(z.number().int().positive().max(2_147_483_647));
export const pickingHistoryQuerySchema = offsetPageQuerySchema.extend({
  search: z.string().trim().max(200).default(""),
  provider: z.string().trim().min(1).max(30).optional(),
  channelId: idQuery.optional(),
  warehouseId: idQuery.optional(),
}).refine(query => query.limit <= MAX_PICKING_HISTORY_PAGE_SIZE, { path: ["limit"], message: "History pages may contain at most 100 orders" });
export type PickingHistoryQuery = z.input<typeof pickingHistoryQuerySchema>;

/** Read-only historical projection. Never calls the active queue's self-heal,
 * inventory preview or replenishment paths. No rolling date/status exclusion.
 */
export class PickingHistoryRepository {
  constructor(private readonly database: typeof db) {}

  async page(input: PickingHistoryQuery = {}): Promise<PickingHistoryPage> {
    const query = pickingHistoryQuerySchema.parse({ limit: PICKING_HISTORY_PAGE_SIZE, ...input });
    // A later cancellation/release/unpick must not erase a recorded pick. Header
    // completion is retained for legacy orders whose detailed audit is absent;
    // it is not evidence of a scan or of shipment, and the UI labels it as such.
    const predicates: SQL[] = [sql`(
      ${orders.completedAt} is not null or
      ${orders.warehouseStatus} in ('completed', 'ready_to_ship', 'shipped') or
      exists (select 1 from ${items} where ${items.orderId} = ${orders.id}
        and ${items.pickedQuantity} > 0) or
      exists (select 1 from ${pickingLogs} where ${pickingLogs.orderId} = ${orders.id}
        and ${pickingLogs.actionType} in ('item_picked', 'item_quantity_adjusted', 'item_unpicked', 'item_shorted', 'order_completed'))
    )`];
    if (query.provider) predicates.push(eq(channels.provider, query.provider));
    if (query.channelId !== undefined) predicates.push(eq(orders.channelId, query.channelId));
    if (query.warehouseId !== undefined) predicates.push(eq(orders.warehouseId, query.warehouseId));
    if (query.search) {
      const term = query.search.toLowerCase();
      predicates.push(sql`(
        strpos(lower(${orders.orderNumber}), ${term}) > 0 or
        strpos(lower(${orders.customerName}), ${term}) > 0 or
        exists (select 1 from ${items} where ${items.orderId} = ${orders.id}
          and (strpos(lower(${items.sku}), ${term}) > 0 or strpos(lower(${items.name}), ${term}) > 0)) or
        exists (select 1 from ${pickingLogs} where ${pickingLogs.orderId} = ${orders.id}
          and strpos(lower(coalesce(${pickingLogs.sku}, '')), ${term}) > 0)
      )`);
    }
    return this.database.transaction(async transaction => {
      await transaction.execute(sql`select set_config('statement_timeout', ${String(ORDER_LIST_STATEMENT_TIMEOUT_MS)}, true)`);
      const scope = and(...predicates);
      // Count and page consume the same CTE, so PostgreSQL evaluates the costly
      // historical search only once. Only IDs/sort keys are materialized there;
      // headers, lines and picker details are hydrated for the page alone.
      const matches = transaction.$with("picking_history_matches").as(
        transaction.select({ id: orders.id, createdAt: orders.createdAt })
          .from(orders).leftJoin(channels, eq(orders.channelId, channels.id)).where(scope),
      );
      const count = transaction.select({ total: sql<number>`count(*)`.mapWith(Number).as("total") })
        .from(matches).as("history_count");
      const pageIds = transaction.select({ id: matches.id, createdAt: matches.createdAt }).from(matches)
        .orderBy(desc(matches.createdAt), desc(matches.id)).limit(query.limit).offset(query.offset).as("history_page");
      // Keep the aggregate row even for zero matches or an out-of-range page.
      // That preserves exact counts and lets the client correct a shrinking page.
      const result = await transaction.with(matches).select({
        total: count.total,
        order: {
          id: orders.id, orderNumber: orders.orderNumber, customerName: orders.customerName,
          warehouseStatus: orders.warehouseStatus, warehouseId: orders.warehouseId,
          createdAt: orders.createdAt, completedAt: orders.completedAt,
        },
        channelName: channels.name,
      }).from(count).leftJoin(pageIds, sql`true`).leftJoin(orders, eq(orders.id, pageIds.id))
        .leftJoin(channels, eq(orders.channelId, channels.id))
        .orderBy(desc(orders.createdAt), desc(orders.id));
      const page = result.flatMap(row => row.order ? [{ ...row.order, channelName: row.channelName }] : []);
      const byOrder = new Map<number, PickingHistoryItem[]>();
      const auditByOrder = new Map<number, { lastPickAt: string | null; lastPickerName: string | null }>();
      if (page.length > 0) {
        const ids = page.map(order => order.id);
        const lines = await transaction.select({
          id: items.id, orderId: items.orderId, sku: items.sku, name: items.name,
          quantity: items.quantity, pickedQuantity: items.pickedQuantity, status: items.status, pickedAt: items.pickedAt,
        }).from(items).where(and(inArray(items.orderId, ids), sql`coalesce(${items.requiresShipping}, 1) <> 0`)).orderBy(asc(items.id));
        for (const { orderId, pickedAt, ...line } of lines) {
          const group = byOrder.get(orderId) ?? [];
          group.push({ ...line, pickedAt: pickedAt?.toISOString() ?? null });
          byOrder.set(orderId, group);
        }
        // DISTINCT ON returns at most one audit record per selected order, not
        // an unbounded lifetime log array. Timestamp + ID break ties reliably.
        const latest = await transaction.selectDistinctOn([pickingLogs.orderId], {
          orderId: pickingLogs.orderId, at: pickingLogs.timestamp, picker: pickingLogs.pickerName,
        }).from(pickingLogs).where(and(inArray(pickingLogs.orderId, ids),
          inArray(pickingLogs.actionType, ["item_picked", "item_quantity_adjusted"])))
          .orderBy(asc(pickingLogs.orderId), desc(pickingLogs.timestamp), desc(pickingLogs.id));
        for (const entry of latest) {
          if (entry.orderId !== null) auditByOrder.set(entry.orderId, {
            lastPickAt: entry.at.toISOString(), lastPickerName: entry.picker,
          });
        }
      }
      return pickingHistoryPageSchema.parse({
        orders: page.map(order => ({ ...order,
          createdAt: order.createdAt.toISOString(), completedAt: order.completedAt?.toISOString() ?? null,
          lastPickAt: null, lastPickerName: null, ...auditByOrder.get(order.id), items: byOrder.get(order.id) ?? [],
        })),
        total: result[0].total, limit: query.limit, offset: query.offset,
      });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
}
