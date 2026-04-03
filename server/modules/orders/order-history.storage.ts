import { db, eq, and, or, sql, desc, asc, like, inArray } from "../../storage/base";
import { omsOrders, omsOrderLines, omsOrderEvents, channels } from "@shared/schema";
import type { OmsOrder, OmsOrderLine } from "@shared/schema";

export interface IOrderHistoryStorage {
  getOrderHistory(filters: {
    search?: string;
    orderNumber?: string;
    customerName?: string;
    sku?: string;
    status?: string[];
    channel?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<(OmsOrder & { items: OmsOrderLine[], channelProvider?: string })[]>;
  getOrderHistoryCount(filters: {
    search?: string;
    orderNumber?: string;
    customerName?: string;
    sku?: string;
    status?: string[];
    channel?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<number>;
  getOrderDetail(orderId: number): Promise<{
    order: OmsOrder;
    items: OmsOrderLine[];
    events: any[];
  } | null>;
}

export const orderHistoryMethods: IOrderHistoryStorage = {
  async getOrderHistory(filters) {
    const conditions = [];

    if (filters.search) {
      const term = `%${filters.search}%`;
      conditions.push(or(
        like(omsOrders.externalOrderNumber, term),
        like(omsOrders.customerName, term),
        like(omsOrders.externalOrderId, term),
      )!);
    }

    if (filters.status && filters.status.length > 0) {
      conditions.push(inArray(omsOrders.status, filters.status));
    }
    if (filters.orderNumber) {
      conditions.push(like(omsOrders.externalOrderNumber, `%${filters.orderNumber}%`));
    }
    if (filters.customerName) {
      conditions.push(like(omsOrders.customerName, `%${filters.customerName}%`));
    }
    if (filters.channel) {
      // For now, channel filtering assumes channel name or provider string
      const matchingChannels = await db.select({ id: channels.id }).from(channels).where(like(channels.provider, `%${filters.channel}%`));
      const channelIds = matchingChannels.map(c => c.id);
      if (channelIds.length > 0) {
        conditions.push(inArray(omsOrders.channelId, channelIds));
      } else {
        return [];
      }
    }
    if (filters.startDate) {
      conditions.push(sql`${omsOrders.orderedAt} >= ${filters.startDate}`);
    }
    if (filters.endDate) {
      conditions.push(sql`${omsOrders.orderedAt} <= ${filters.endDate}`);
    }
    if (filters.sku) {
      const skuFilter = filters.sku.toUpperCase();
      const ordersWithSku = await db.select({ orderId: omsOrderLines.orderId }).from(omsOrderLines).where(like(omsOrderLines.sku, `%${skuFilter}%`));
      const matchingOrderIds = [...new Set(ordersWithSku.map(i => i.orderId))];
      if (matchingOrderIds.length === 0) return [];
      conditions.push(inArray(omsOrders.id, matchingOrderIds));
    }

    let query = db.select({
      order: omsOrders,
      channelProvider: channels.provider,
    }).from(omsOrders)
      .leftJoin(channels, eq(omsOrders.channelId, channels.id)) as any;
      
    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }
    
    query = query.orderBy(desc(omsOrders.orderedAt));
    const limit = filters.limit || 50;
    query = query.limit(limit);
    if (filters.offset) query = query.offset(filters.offset);

    const orderList = await query;
    const results = [];
    
    for (const row of orderList) {
      const items = await db.select().from(omsOrderLines).where(eq(omsOrderLines.orderId, row.order.id));
      results.push({ ...row.order, items, channelProvider: row.channelProvider });
    }
    
    return results;
  },
  
  async getOrderHistoryCount(filters) {
    const conditions = [];

    if (filters.search) {
      const term = `%${filters.search}%`;
      conditions.push(or(
        like(omsOrders.externalOrderNumber, term),
        like(omsOrders.customerName, term),
        like(omsOrders.externalOrderId, term),
      )!);
    }

    if (filters.status && filters.status.length > 0) {
      conditions.push(inArray(omsOrders.status, filters.status));
    }
    if (filters.orderNumber) {
      conditions.push(like(omsOrders.externalOrderNumber, `%${filters.orderNumber}%`));
    }
    if (filters.customerName) {
      conditions.push(like(omsOrders.customerName, `%${filters.customerName}%`));
    }
    if (filters.channel) {
      const matchingChannels = await db.select({ id: channels.id }).from(channels).where(like(channels.provider, `%${filters.channel}%`));
      const channelIds = matchingChannels.map(c => c.id);
      if (channelIds.length > 0) {
        conditions.push(inArray(omsOrders.channelId, channelIds));
      } else {
        return 0;
      }
    }
    if (filters.startDate) {
      conditions.push(sql`${omsOrders.orderedAt} >= ${filters.startDate}`);
    }
    if (filters.endDate) {
      conditions.push(sql`${omsOrders.orderedAt} <= ${filters.endDate}`);
    }
    if (filters.sku) {
      const skuFilter = filters.sku.toUpperCase();
      const ordersWithSku = await db.select({ orderId: omsOrderLines.orderId }).from(omsOrderLines).where(like(omsOrderLines.sku, `%${skuFilter}%`));
      const matchingOrderIds = [...new Set(ordersWithSku.map(i => i.orderId))];
      if (matchingOrderIds.length === 0) return 0;
      conditions.push(inArray(omsOrders.id, matchingOrderIds));
    }
    
    let query = db.select({ count: sql<number>`count(*)` }).from(omsOrders) as any;
    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }
    
    const result = await query;
    return Number(result[0]?.count || 0);
  },
  
  async getOrderDetail(orderId: number) {
    const order = await db.select().from(omsOrders).where(eq(omsOrders.id, orderId));
    if (order.length === 0) return null;

    const items = await db.select().from(omsOrderLines).where(eq(omsOrderLines.orderId, orderId));
    const events = await db.select().from(omsOrderEvents).where(eq(omsOrderEvents.orderId, orderId)).orderBy(asc(omsOrderEvents.createdAt));

    return {
      order: order[0] as OmsOrder,
      items: items as OmsOrderLine[],
      events,
    };
  },
};
