import {
  db, eq, and, sql, desc, asc, gte, lte, like, isNotNull,
  type PickingLog, type InsertPickingLog,
  type Order, type OrderItem, type ProductVariant,
  pickingLogs, orders,
} from "../../storage/base";

export interface IPickingLogStorage {
  createPickingLog(log: InsertPickingLog): Promise<PickingLog>;
  getPickingLogsByOrderId(orderId: number): Promise<PickingLog[]>;
  getPickingLogs(filters: {
    startDate?: Date;
    endDate?: Date;
    actionType?: string;
    pickerId?: string;
    orderNumber?: string;
    sku?: string;
    limit?: number;
    offset?: number;
  }): Promise<PickingLog[]>;
  getPickingLogsCount(filters: {
    startDate?: Date;
    endDate?: Date;
    actionType?: string;
    pickerId?: string;
    orderNumber?: string;
    sku?: string;
  }): Promise<number>;
  getPickingMetricsAggregated(startDate: Date, endDate: Date): Promise<{
    totalOrdersCompleted: number;
    totalLinesPicked: number;
    totalItemsPicked: number;
    totalShortPicks: number;
    scanPicks: number;
    manualPicks: number;
    totalPicks: number;
    uniquePickers: number;
    exceptionOrders: number;
    avgPickTimeSeconds: number;
    avgClaimToCompleteSeconds: number;
    avgQueueWaitSeconds: number;
    pickerPerformance: Array<{
      pickerId: string;
      pickerName: string;
      ordersCompleted: number;
      itemsPicked: number;
      avgPickTime: number;
      shortPicks: number;
      scanRate: number;
    }>;
    hourlyTrend: Array<{ hour: string; orders: number; items: number }>;
    shortReasons: Array<{ reason: string; count: number }>;
  }>;
}

export const pickingLogMethods: IPickingLogStorage = {
  async createPickingLog(log: InsertPickingLog): Promise<PickingLog> {
    const result = await db.insert(pickingLogs).values(log).returning();
    return result[0];
  },

  async getPickingLogsByOrderId(orderId: number): Promise<PickingLog[]> {
    return await db
      .select()
      .from(pickingLogs)
      .where(eq(pickingLogs.orderId, orderId))
      .orderBy(asc(pickingLogs.timestamp));
  },

  async getPickingLogs(filters: {
    startDate?: Date;
    endDate?: Date;
    actionType?: string;
    pickerId?: string;
    orderNumber?: string;
    sku?: string;
    limit?: number;
    offset?: number;
  }): Promise<PickingLog[]> {
    const conditions = [];
    
    if (filters.startDate) {
      conditions.push(gte(pickingLogs.timestamp, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(pickingLogs.timestamp, filters.endDate));
    }
    if (filters.actionType) {
      conditions.push(eq(pickingLogs.actionType, filters.actionType));
    }
    if (filters.pickerId) {
      conditions.push(eq(pickingLogs.pickerId, filters.pickerId));
    }
    if (filters.orderNumber) {
      conditions.push(like(pickingLogs.orderNumber, `%${filters.orderNumber}%`));
    }
    if (filters.sku) {
      conditions.push(like(pickingLogs.sku, `%${filters.sku.toUpperCase()}%`));
    }
    
    let query = db.select().from(pickingLogs);
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }
    
    query = query.orderBy(desc(pickingLogs.timestamp)) as any;
    
    if (filters.limit) {
      query = query.limit(filters.limit) as any;
    }
    if (filters.offset) {
      query = query.offset(filters.offset) as any;
    }
    
    return await query;
  },

  async getPickingLogsCount(filters: {
    startDate?: Date;
    endDate?: Date;
    actionType?: string;
    pickerId?: string;
    orderNumber?: string;
    sku?: string;
  }): Promise<number> {
    const conditions = [];
    
    if (filters.startDate) {
      conditions.push(gte(pickingLogs.timestamp, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(pickingLogs.timestamp, filters.endDate));
    }
    if (filters.actionType) {
      conditions.push(eq(pickingLogs.actionType, filters.actionType));
    }
    if (filters.pickerId) {
      conditions.push(eq(pickingLogs.pickerId, filters.pickerId));
    }
    if (filters.orderNumber) {
      conditions.push(like(pickingLogs.orderNumber, `%${filters.orderNumber}%`));
    }
    if (filters.sku) {
      conditions.push(like(pickingLogs.sku, `%${filters.sku.toUpperCase()}%`));
    }
    
    let query = db.select({ count: sql<number>`count(*)` }).from(pickingLogs);
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }
    
    const result = await query;
    return Number(result[0]?.count || 0);
  },

  async getPickingMetricsAggregated(startDate: Date, endDate: Date): Promise<{
    totalOrdersCompleted: number;
    totalLinesPicked: number;
    totalItemsPicked: number;
    totalShortPicks: number;
    scanPicks: number;
    manualPicks: number;
    totalPicks: number;
    uniquePickers: number;
    exceptionOrders: number;
    avgPickTimeSeconds: number;
    avgClaimToCompleteSeconds: number;
    avgQueueWaitSeconds: number;
    pickerPerformance: Array<{
      pickerId: string;
      pickerName: string;
      ordersCompleted: number;
      itemsPicked: number;
      avgPickTime: number;
      shortPicks: number;
      scanRate: number;
    }>;
    hourlyTrend: Array<{ hour: string; orders: number; items: number }>;
    shortReasons: Array<{ reason: string; count: number }>;
  }> {
    const ordersResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(
        eq(orders.warehouseStatus, 'completed'),
        gte(orders.completedAt, startDate),
        lte(orders.completedAt, endDate)
      ));
    const totalOrdersCompleted = ordersResult[0]?.count || 0;

    const exceptionResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(
        eq(orders.warehouseStatus, 'completed'),
        gte(orders.completedAt, startDate),
        lte(orders.completedAt, endDate),
        isNotNull(orders.exceptionAt)
      ));
    const exceptionOrders = exceptionResult[0]?.count || 0;

    const logsAgg = await db
      .select({
        totalLines: sql<number>`count(*) FILTER (WHERE action_type IN ('item_picked', 'item_shorted'))::int`,
        totalItems: sql<number>`COALESCE(SUM(qty_after) FILTER (WHERE action_type IN ('item_picked', 'item_quantity_adjusted')), 0)::int`,
        totalShorts: sql<number>`count(*) FILTER (WHERE action_type = 'item_shorted')::int`,
        scanPicks: sql<number>`count(*) FILTER (WHERE action_type IN ('item_picked', 'item_quantity_adjusted') AND pick_method = 'scan')::int`,
        manualPicks: sql<number>`count(*) FILTER (WHERE action_type IN ('item_picked', 'item_quantity_adjusted') AND pick_method = 'manual')::int`,
        totalPicks: sql<number>`count(*) FILTER (WHERE action_type IN ('item_picked', 'item_quantity_adjusted'))::int`,
        uniquePickers: sql<number>`count(DISTINCT picker_id)::int`
      })
      .from(pickingLogs)
      .where(and(
        gte(pickingLogs.timestamp, startDate),
        lte(pickingLogs.timestamp, endDate)
      ));

    const agg = logsAgg[0] || {};

    const timingResult = await db.execute(sql`
      SELECT 
        AVG(EXTRACT(EPOCH FROM (c.timestamp - cl.timestamp))) as avg_claim_to_complete,
        AVG(EXTRACT(EPOCH FROM (cl.timestamp - o.created_at))) as avg_queue_wait
      FROM wms.orders o
      LEFT JOIN picking_logs cl ON cl.order_id = o.id AND cl.action_type = 'order_claimed'
      LEFT JOIN picking_logs c ON c.order_id = o.id AND c.action_type = 'order_completed'
      WHERE o.warehouse_status = 'completed' 
        AND o.completed_at >= ${startDate} 
        AND o.completed_at <= ${endDate}
        AND cl.timestamp IS NOT NULL
    `);
    const timing = timingResult.rows?.[0] || {};
    const avgClaimToCompleteSeconds = Number(timing.avg_claim_to_complete) || 0;
    const avgQueueWaitSeconds = Number(timing.avg_queue_wait) || 0;
    const avgItemsPerOrder = totalOrdersCompleted > 0 ? (agg.totalItems || 0) / totalOrdersCompleted : 1;
    const avgPickTimeSeconds = avgClaimToCompleteSeconds > 0 && avgItemsPerOrder > 0 
      ? avgClaimToCompleteSeconds / avgItemsPerOrder 
      : 0;

    const pickerResult = await db.execute(sql`
      SELECT 
        picker_id,
        MAX(picker_name) as picker_name,
        count(*) FILTER (WHERE action_type = 'order_completed')::int as orders_completed,
        COALESCE(SUM(qty_after) FILTER (WHERE action_type IN ('item_picked', 'item_quantity_adjusted')), 0)::int as items_picked,
        count(*) FILTER (WHERE action_type = 'item_shorted')::int as short_picks,
        count(*) FILTER (WHERE action_type IN ('item_picked', 'item_quantity_adjusted') AND pick_method = 'scan')::int as scan_picks,
        count(*) FILTER (WHERE action_type IN ('item_picked', 'item_quantity_adjusted'))::int as total_picks
      FROM picking_logs
      WHERE timestamp >= ${startDate} AND timestamp <= ${endDate}
        AND picker_id IS NOT NULL
      GROUP BY picker_id
      ORDER BY items_picked DESC
      LIMIT 20
    `);
    const pickerPerformance = (pickerResult.rows || []).map((p: any) => ({
      pickerId: p.picker_id || '',
      pickerName: p.picker_name || 'Unknown',
      ordersCompleted: Number(p.orders_completed) || 0,
      itemsPicked: Number(p.items_picked) || 0,
      avgPickTime: 0,
      shortPicks: Number(p.short_picks) || 0,
      scanRate: Number(p.total_picks) > 0 ? Number(p.scan_picks) / Number(p.total_picks) : 0
    }));

    const hourlyResult = await db.execute(sql`
      SELECT 
        date_trunc('hour', timestamp) as hour,
        count(*) FILTER (WHERE action_type = 'order_completed')::int as orders,
        count(*) FILTER (WHERE action_type IN ('item_picked', 'item_quantity_adjusted'))::int as items
      FROM picking_logs
      WHERE timestamp >= ${startDate} AND timestamp <= ${endDate}
      GROUP BY date_trunc('hour', timestamp)
      ORDER BY hour
    `);
    const hourlyTrend = (hourlyResult.rows || []).map((h: any) => ({
      hour: new Date(h.hour).toLocaleTimeString("en-US", { hour: "numeric", hour12: true }),
      orders: Number(h.orders) || 0,
      items: Number(h.items) || 0
    }));

    const shortResult = await db.execute(sql`
      SELECT 
        COALESCE(reason, 'unknown') as reason,
        count(*)::int as count
      FROM picking_logs
      WHERE timestamp >= ${startDate} AND timestamp <= ${endDate}
        AND action_type = 'item_shorted'
      GROUP BY reason
      ORDER BY count DESC
    `);
    const shortReasons = (shortResult.rows || []).map((s: any) => ({
      reason: String(s.reason || 'unknown').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      count: Number(s.count) || 0
    }));

    return {
      totalOrdersCompleted,
      totalLinesPicked: agg.totalLines || 0,
      totalItemsPicked: agg.totalItems || 0,
      totalShortPicks: agg.totalShorts || 0,
      scanPicks: agg.scanPicks || 0,
      manualPicks: agg.manualPicks || 0,
      totalPicks: agg.totalPicks || 0,
      uniquePickers: agg.uniquePickers || 0,
      exceptionOrders,
      avgPickTimeSeconds,
      avgClaimToCompleteSeconds,
      avgQueueWaitSeconds,
      pickerPerformance,
      hourlyTrend,
      shortReasons
    };
  },
};
