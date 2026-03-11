import {
  db, eq, and, or, inArray, sql, desc, asc, gte, lte, like,
  type Order, type OrderItem, type PickingLog,
  orders, orderItems, pickingLogs, users, shipments, shipmentItems, productVariants,
} from "./base";

export interface IOrderHistoryStorage {
  getOrderHistory(filters: {
    orderNumber?: string;
    customerName?: string;
    sku?: string;
    pickerId?: string;
    status?: string[];
    priority?: string;
    channel?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<(Order & { items: OrderItem[]; pickerName?: string })[]>;
  getOrderHistoryCount(filters: {
    orderNumber?: string;
    customerName?: string;
    sku?: string;
    pickerId?: string;
    status?: string[];
    priority?: string;
    channel?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<number>;
  getOrderDetail(orderId: number): Promise<{
    order: Order;
    items: OrderItem[];
    pickingLogs: PickingLog[];
    picker?: { id: string; displayName: string | null };
    shipmentHistory: Array<{
      id: number;
      status: string;
      carrier: string | null;
      trackingNumber: string | null;
      trackingUrl: string | null;
      shippedAt: string | null;
      deliveredAt: string | null;
      createdAt: string;
      source: string;
      externalFulfillmentId: string | null;
      items: Array<{ sku: string | null; name: string | null; qty: number }>;
    }>;
  } | null>;
}

export const orderHistoryMethods: IOrderHistoryStorage = {
  async getOrderHistory(filters: {
    search?: string;
    orderNumber?: string;
    customerName?: string;
    sku?: string;
    pickerId?: string;
    status?: string[];
    priority?: string;
    channel?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<(Order & { items: OrderItem[]; pickerName?: string })[]> {
    const conditions = [];

    if (filters.search) {
      const term = `%${filters.search}%`;
      conditions.push(or(
        like(orders.orderNumber, term),
        like(orders.customerName, term),
        like(orders.externalOrderId, term),
      )!);
    }

    if (filters.status && filters.status.length > 0) {
      conditions.push(inArray(orders.warehouseStatus, filters.status as any));
    }

    if (filters.orderNumber) {
      conditions.push(like(orders.orderNumber, `%${filters.orderNumber}%`));
    }
    if (filters.customerName) {
      conditions.push(like(orders.customerName, `%${filters.customerName}%`));
    }
    if (filters.pickerId) {
      conditions.push(eq(orders.assignedPickerId, filters.pickerId));
    }
    if (filters.priority) {
      conditions.push(eq(orders.priority, filters.priority));
    }
    if (filters.channel) {
      conditions.push(eq(orders.source, filters.channel));
    }
    if (filters.startDate) {
      conditions.push(sql`COALESCE(${orders.orderPlacedAt}, ${orders.createdAt}) >= ${filters.startDate}`);
    }
    if (filters.endDate) {
      conditions.push(sql`COALESCE(${orders.orderPlacedAt}, ${orders.createdAt}) <= ${filters.endDate}`);
    }

    if (filters.sku) {
      const skuFilter = filters.sku.toUpperCase();
      const ordersWithSku = await db
        .select({ orderId: orderItems.orderId })
        .from(orderItems)
        .where(like(orderItems.sku, `%${skuFilter}%`));
      const matchingOrderIds = [...new Set(ordersWithSku.map(i => i.orderId))];

      if (matchingOrderIds.length === 0) {
        return [];
      }
      conditions.push(inArray(orders.id, matchingOrderIds));
    }

    let query = db.select().from(orders);

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    query = query.orderBy(sql`COALESCE(${orders.orderPlacedAt}, ${orders.createdAt}) DESC`) as any;
    
    const limit = filters.limit || 50;
    query = query.limit(limit) as any;
    
    if (filters.offset) {
      query = query.offset(filters.offset) as any;
    }
    
    const orderList = await query;
    
    const results: (Order & { items: OrderItem[]; pickerName?: string })[] = [];
    
    for (const order of orderList) {
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      
      let pickerName: string | undefined;
      if (order.assignedPickerId) {
        const picker = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, order.assignedPickerId));
        pickerName = picker[0]?.displayName || undefined;
      }
      
      results.push({ ...order, items, pickerName });
    }
    
    return results;
  },
  
  async getOrderHistoryCount(filters: {
    search?: string;
    orderNumber?: string;
    customerName?: string;
    sku?: string;
    pickerId?: string;
    status?: string[];
    priority?: string;
    channel?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<number> {
    const conditions = [];

    if (filters.search) {
      const term = `%${filters.search}%`;
      conditions.push(or(
        like(orders.orderNumber, term),
        like(orders.customerName, term),
        like(orders.externalOrderId, term),
      )!);
    }

    if (filters.status && filters.status.length > 0) {
      conditions.push(inArray(orders.warehouseStatus, filters.status as any));
    }

    if (filters.orderNumber) {
      conditions.push(like(orders.orderNumber, `%${filters.orderNumber}%`));
    }
    if (filters.customerName) {
      conditions.push(like(orders.customerName, `%${filters.customerName}%`));
    }
    if (filters.pickerId) {
      conditions.push(eq(orders.assignedPickerId, filters.pickerId));
    }
    if (filters.priority) {
      conditions.push(eq(orders.priority, filters.priority));
    }
    if (filters.channel) {
      conditions.push(eq(orders.source, filters.channel));
    }
    if (filters.startDate) {
      conditions.push(sql`COALESCE(${orders.orderPlacedAt}, ${orders.createdAt}) >= ${filters.startDate}`);
    }
    if (filters.endDate) {
      conditions.push(sql`COALESCE(${orders.orderPlacedAt}, ${orders.createdAt}) <= ${filters.endDate}`);
    }

    if (filters.sku) {
      const skuFilter = filters.sku.toUpperCase();
      const ordersWithSku = await db
        .select({ orderId: orderItems.orderId })
        .from(orderItems)
        .where(like(orderItems.sku, `%${skuFilter}%`));
      const matchingOrderIds = [...new Set(ordersWithSku.map(i => i.orderId))];
      
      if (matchingOrderIds.length === 0) return 0;
      conditions.push(inArray(orders.id, matchingOrderIds));
    }
    
    let query = db.select({ count: sql<number>`count(*)` }).from(orders);
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }
    
    const result = await query;
    return Number(result[0]?.count || 0);
  },
  
  async getOrderDetail(orderId: number) {
    const order = await db.select().from(orders).where(eq(orders.id, orderId));
    if (order.length === 0) return null;

    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const logs = await db.select().from(pickingLogs).where(eq(pickingLogs.orderId, orderId)).orderBy(asc(pickingLogs.timestamp));

    let picker: { id: string; displayName: string | null } | undefined;
    if (order[0].assignedPickerId) {
      const pickerResult = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, order[0].assignedPickerId));
      picker = pickerResult[0];
    }

    const orderShipments = await db.select().from(shipments).where(eq(shipments.orderId, orderId)).orderBy(asc(shipments.createdAt));
    const shipmentHistory = [];
    for (const s of orderShipments) {
      const sItems = await db.select({
        sku: productVariants.sku,
        name: productVariants.name,
        qty: shipmentItems.qty,
      }).from(shipmentItems)
        .leftJoin(productVariants, eq(shipmentItems.productVariantId, productVariants.id))
        .where(eq(shipmentItems.shipmentId, s.id));
      shipmentHistory.push({
        id: s.id,
        status: s.status,
        carrier: s.carrier,
        trackingNumber: s.trackingNumber,
        trackingUrl: s.trackingUrl,
        shippedAt: s.shippedAt?.toISOString() ?? null,
        deliveredAt: s.deliveredAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
        source: s.source,
        externalFulfillmentId: s.externalFulfillmentId,
        items: sItems.map(si => ({ sku: si.sku, name: si.name, qty: si.qty })),
      });
    }

    return {
      order: order[0],
      items,
      pickingLogs: logs,
      picker,
      shipmentHistory,
    };
  },
};
