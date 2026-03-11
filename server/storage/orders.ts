import {
  type Order,
  type InsertOrder,
  type OrderItem,
  type InsertOrderItem,
  type OrderStatus,
  type ItemStatus,
  orders,
  orderItems,
} from "@shared/schema";
import { db } from "../db";
import { eq, inArray, and, or, isNull, desc, sql } from "drizzle-orm";

export interface IOrderStorage {
  getOrderByShopifyId(shopifyOrderId: string): Promise<Order | undefined>;
  getOrderById(id: number): Promise<Order | undefined>;
  getOrdersWithItems(status?: OrderStatus[]): Promise<(Order & { items: OrderItem[] })[]>;
  getPickQueueOrders(): Promise<(Order & { items: OrderItem[] })[]>;
  createOrderWithItems(order: InsertOrder, items: InsertOrderItem[]): Promise<Order>;
  claimOrder(orderId: number, pickerId: string): Promise<Order | null>;
  releaseOrder(orderId: number, resetProgress?: boolean): Promise<Order | null>;
  forceReleaseOrder(orderId: number, resetProgress?: boolean): Promise<Order | null>;
  updateOrderStatus(orderId: number, status: OrderStatus): Promise<Order | null>;
  updateOrderFields(orderId: number, updates: Partial<Order>): Promise<Order | null>;
  holdOrder(orderId: number): Promise<Order | null>;
  releaseHoldOrder(orderId: number): Promise<Order | null>;
  setOrderPriority(orderId: number, priority: "rush" | "high" | "normal"): Promise<Order | null>;

  getOrderItems(orderId: number): Promise<OrderItem[]>;
  getOrderItemById(itemId: number): Promise<OrderItem | undefined>;
  updateOrderItemStatus(itemId: number, status: ItemStatus, pickedQty?: number, shortReason?: string, expectedCurrentStatus?: ItemStatus): Promise<OrderItem | null>;
  updateOrderItemLocation(itemId: number, location: string, zone: string, barcode: string | null, imageUrl: string | null): Promise<OrderItem | null>;
  updateOrderProgress(orderId: number, postPickStatus?: string): Promise<Order | null>;

  updateItemFulfilledQuantity(shopifyLineItemId: string, additionalQty: number): Promise<OrderItem | null>;
  getOrderItemByShopifyLineId(shopifyLineItemId: string): Promise<OrderItem | undefined>;
  areAllItemsFulfilled(orderId: number): Promise<boolean>;

  getExceptionOrders(): Promise<(Order & { items: OrderItem[] })[]>;
  resolveException(orderId: number, resolution: string, resolvedBy: string, notes?: string): Promise<Order | null>;
}

export const orderMethods: IOrderStorage = {
  async getOrderByShopifyId(shopifyOrderId: string): Promise<Order | undefined> {
    const result = await db.select().from(orders).where(eq(orders.shopifyOrderId, shopifyOrderId));
    return result[0];
  },

  async getOrderById(id: number): Promise<Order | undefined> {
    const result = await db.select().from(orders).where(eq(orders.id, id));
    return result[0];
  },

  async getOrdersWithItems(status?: OrderStatus[]): Promise<(Order & { items: OrderItem[] })[]> {
    let query = db.select().from(orders);
    
    if (status && status.length > 0) {
      query = query.where(inArray(orders.warehouseStatus, status)) as any;
    }
    
    const orderList = await query.orderBy(desc(orders.createdAt));
    
    if (orderList.length === 0) {
      return [];
    }
    
    const orderIds = orderList.map(o => o.id);
    const allItems = await db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds));
    
    const itemsByOrderId = new Map<number, OrderItem[]>();
    for (const item of allItems) {
      const existing = itemsByOrderId.get(item.orderId) || [];
      existing.push(item);
      itemsByOrderId.set(item.orderId, existing);
    }
    
    return orderList.map(order => ({
      ...order,
      items: itemsByOrderId.get(order.id) || [],
    }));
  },

  async getPickQueueOrders(): Promise<(Order & { items: OrderItem[] })[]> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const orderList = await db.execute(sql`
      SELECT o.*, COALESCE(NULLIF(o.customer_name, ''), s.customer_name) as resolved_customer_name
      FROM orders o
      LEFT JOIN shopify_orders s ON o.source_table_id = s.id
      WHERE (s.cancelled_at IS NULL OR s.id IS NULL)
        AND o.warehouse_status NOT IN ('shipped', 'ready_to_ship', 'cancelled')
        AND (s.id IS NULL OR s.fulfillment_status IS NULL OR s.fulfillment_status != 'fulfilled')
        AND (
          -- Ready/in_progress orders: show in pick queue
          o.warehouse_status IN ('ready', 'in_progress')
          -- Completed orders: show for 24 hours in done queue
          OR (o.warehouse_status = 'completed' AND o.completed_at >= ${twentyFourHoursAgo})
        )
      ORDER BY COALESCE(o.order_placed_at, o.shopify_created_at, o.created_at) ASC
    `);
    
    const orderRows = (orderList.rows as any[]).map((row: any) => ({
      id: row.id,
      channelId: row.channel_id,
      source: row.source,
      externalOrderId: row.external_order_id,
      sourceTableId: row.source_table_id,
      shopifyOrderId: row.shopify_order_id,
      orderNumber: row.order_number,
      customerName: row.resolved_customer_name || row.customer_name,
      customerEmail: row.customer_email,
      shippingAddress: row.shipping_address,
      shippingCity: row.shipping_city,
      shippingState: row.shipping_state,
      shippingPostalCode: row.shipping_postal_code,
      shippingCountry: row.shipping_country,
      priority: row.priority,
      warehouseStatus: row.warehouse_status,
      onHold: row.on_hold,
      heldAt: row.held_at,
      heldBy: row.held_by,
      assignedPickerId: row.assigned_picker_id,
      claimedAt: row.claimed_at,
      completedAt: row.completed_at,
      exceptionAt: row.exception_at,
      exceptionType: row.exception_type,
      exceptionNotes: row.exception_notes,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      resolutionNotes: row.resolution_notes,
      itemCount: row.item_count,
      unitCount: row.unit_count,
      totalAmount: row.total_amount,
      currency: row.currency,
      shopifyCreatedAt: row.shopify_created_at,
      orderPlacedAt: row.order_placed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: row.metadata,
      legacyOrderId: row.legacy_order_id,
      combinedGroupId: row.combined_group_id,
      combinedRole: row.combined_role,
    }));
    
    if (orderRows.length === 0) {
      return [];
    }
    
    const orderIds = orderRows.map(o => o.id);
    const allItems = await db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds));
    
    const skusMissingImages = [...new Set(
      allItems.filter(item => !item.imageUrl && item.sku).map(item => item.sku!.toUpperCase())
    )];

    const imageMap = new Map<string, string>();
    if (skusMissingImages.length > 0) {
      try {
        const imageSkuList = sql.join(skusMissingImages.map(s => sql`${s}`), sql`, `);
        const imageResults = await db.execute<{ sku: string; image_url: string }>(sql`
          SELECT UPPER(sku) as sku, image_url FROM (
            SELECT pl.sku, pl.image_url FROM product_locations pl
            WHERE UPPER(pl.sku) IN (${imageSkuList}) AND pl.image_url IS NOT NULL
            UNION ALL
            SELECT pv.sku, COALESCE(pva.url, pa.url) as image_url
            FROM product_variants pv
            LEFT JOIN product_assets pva ON pva.product_variant_id = pv.id AND pva.is_primary = 1
            LEFT JOIN product_assets pa ON pa.product_id = pv.product_id AND pa.product_variant_id IS NULL AND pa.is_primary = 1
            WHERE UPPER(pv.sku) IN (${imageSkuList})
              AND COALESCE(pva.url, pa.url) IS NOT NULL
          ) sub
        `);
        for (const row of imageResults.rows) {
          if (row.image_url && !imageMap.has(row.sku)) {
            imageMap.set(row.sku, row.image_url);
          }
        }
      } catch (err) {
        console.warn("[PickQueue] Failed to enrich images:", (err as Error).message);
      }
    }
    
    const skusMissingBarcodes = [...new Set(
      allItems.filter(item => !item.barcode && item.sku).map(item => item.sku!.toUpperCase())
    )];

    const barcodeMap = new Map<string, string>();
    if (skusMissingBarcodes.length > 0) {
      try {
        const barcodeSkuList = sql.join(skusMissingBarcodes.map(s => sql`${s}`), sql`, `);
        const barcodeResults = await db.execute<{ sku: string; barcode: string }>(sql`
          SELECT UPPER(pv.sku) as sku, pv.barcode
          FROM product_variants pv
          WHERE UPPER(pv.sku) IN (${barcodeSkuList})
            AND pv.barcode IS NOT NULL
        `);
        for (const row of barcodeResults.rows) {
          if (row.barcode && !barcodeMap.has(row.sku)) {
            barcodeMap.set(row.sku, row.barcode);
          }
        }
      } catch (err) {
        console.warn("[PickQueue] Failed to enrich barcodes:", (err as Error).message);
      }
    }

    const enrichedItems = allItems.map(item => {
      let enriched = item;
      if (!item.imageUrl && item.sku) {
        const foundImage = imageMap.get(item.sku.toUpperCase());
        if (foundImage) enriched = { ...enriched, imageUrl: foundImage };
      }
      if (!item.barcode && item.sku) {
        const foundBarcode = barcodeMap.get(item.sku.toUpperCase());
        if (foundBarcode) enriched = { ...enriched, barcode: foundBarcode };
      }
      return enriched;
    });
    
    const itemsByOrderId = new Map<number, OrderItem[]>();
    for (const item of enrichedItems) {
      const existing = itemsByOrderId.get(item.orderId) || [];
      existing.push(item);
      itemsByOrderId.set(item.orderId, existing);
    }
    
    for (const order of orderRows) {
      if (order.warehouseStatus === "in_progress") {
        const items = itemsByOrderId.get(order.id) || [];
        const shippableItems = items.filter(i => i.requiresShipping === 1);
        const allShippableDone = shippableItems.length > 0 && 
          shippableItems.every(i => i.status === "completed" || i.status === "short");
        if (allShippableDone) {
          const hasShort = shippableItems.some(i => i.status === "short");
          const fixedStatus = hasShort ? "exception" : "completed";
          try {
            await db.execute(
              sql`UPDATE orders SET warehouse_status = ${fixedStatus}, completed_at = NOW() WHERE id = ${order.id}`
            );
            const nonShippablePending = items.filter(i => i.requiresShipping !== 1 && i.status === "pending");
            for (const item of nonShippablePending) {
              await db.execute(sql`UPDATE order_items SET status = 'completed' WHERE id = ${item.id}`);
              item.status = "completed";
            }
            order.warehouseStatus = fixedStatus;
            order.completedAt = new Date();
          } catch (err) {
            console.error(`[PickQueue] Failed to auto-fix order ${order.orderNumber}:`, err);
          }
        }
      }
    }

    return orderRows.map((order: any) => ({
      ...order,
      items: itemsByOrderId.get(order.id) || [],
    })) as any;
  },

  async createOrderWithItems(order: InsertOrder, items: InsertOrderItem[]): Promise<Order> {
    if (order.shopifyOrderId) {
      const existingByShopifyId = await this.getOrderByShopifyId(order.shopifyOrderId);
      if (existingByShopifyId) {
        console.log(`[ORDER CREATE] Skipping duplicate order - already exists by shopifyOrderId: ${order.shopifyOrderId}`);
        return existingByShopifyId;
      }
    }
    if (order.sourceTableId) {
      const existingBySourceTableId = await db.select().from(orders).where(eq(orders.sourceTableId, order.sourceTableId));
      if (existingBySourceTableId.length > 0) {
        console.log(`[ORDER CREATE] Skipping duplicate order - already exists by sourceTableId: ${order.sourceTableId}`);
        return existingBySourceTableId[0];
      }
    }
    
    const [newOrder] = await db.insert(orders).values({
      ...order,
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    }).returning();
    
    if (items.length > 0) {
      const itemsWithOrderId = items.map(item => ({
        ...item,
        orderId: newOrder.id,
      }));
      await db.insert(orderItems).values(itemsWithOrderId);
    }
    
    return newOrder;
  },

  async claimOrder(orderId: number, pickerId: string): Promise<Order | null> {
    const existingOrder = await db.select().from(orders).where(
      and(
        eq(orders.id, orderId),
        eq(orders.assignedPickerId, pickerId)
      )
    );
    
    if (existingOrder.length > 0) {
      console.log(`[CLAIM] Picker ${pickerId} already owns order ${orderId}, returning existing`);
      return existingOrder[0];
    }
    
    const currentOrder = await db.select().from(orders).where(eq(orders.id, orderId));
    if (currentOrder.length > 0) {
      console.log(`[CLAIM] Order ${orderId} current state:`, {
        warehouseStatus: currentOrder[0].warehouseStatus,
        assignedPickerId: currentOrder[0].assignedPickerId,
        onHold: currentOrder[0].onHold
      });
    }
    
    const result = await db
      .update(orders)
      .set({
        warehouseStatus: "in_progress" as OrderStatus,
        assignedPickerId: pickerId,
        startedAt: new Date(),
      })
      .where(
        and(
          eq(orders.id, orderId),
          or(
            eq(orders.warehouseStatus, "ready"),
            and(
              eq(orders.warehouseStatus, "in_progress"),
              isNull(orders.assignedPickerId)
            )
          ),
          isNull(orders.assignedPickerId),
          eq(orders.onHold, 0)
        )
      )
      .returning();
    
    if (result.length === 0) {
      console.log(`[CLAIM] Order ${orderId} claim failed - not available for picker ${pickerId}`);
    } else {
      console.log(`[CLAIM] Order ${orderId} claimed successfully by picker ${pickerId}`);
    }
    
    return result[0] || null;
  },

  async releaseOrder(orderId: number, resetProgress: boolean = true): Promise<Order | null> {
    const beforeOrder = await db.select().from(orders).where(eq(orders.id, orderId));
    console.log(`[RELEASE] Order ${orderId} before release:`, {
      warehouseStatus: beforeOrder[0]?.warehouseStatus,
      assignedPickerId: beforeOrder[0]?.assignedPickerId,
      resetProgress
    });
    
    const orderUpdates: any = {
      warehouseStatus: "ready" as OrderStatus,
      assignedPickerId: null,
      startedAt: null,
    };
    
    if (resetProgress) {
      orderUpdates.pickedCount = 0;
      orderUpdates.completedAt = null;
    }
    
    const result = await db
      .update(orders)
      .set(orderUpdates)
      .where(eq(orders.id, orderId))
      .returning();
    
    console.log(`[RELEASE] Order ${orderId} after release:`, {
      warehouseStatus: result[0]?.warehouseStatus,
      assignedPickerId: result[0]?.assignedPickerId
    });
    
    if (resetProgress) {
      await db
        .update(orderItems)
        .set({ status: "pending" as ItemStatus, pickedQuantity: 0, shortReason: null })
        .where(eq(orderItems.orderId, orderId));
    }
    
    return result[0] || null;
  },

  async forceReleaseOrder(orderId: number, resetProgress: boolean = false): Promise<Order | null> {
    const orderUpdates: any = {
      warehouseStatus: "ready" as OrderStatus,
      assignedPickerId: null,
      startedAt: null,
      onHold: 0,
      heldAt: null,
    };
    
    if (resetProgress) {
      orderUpdates.pickedCount = 0;
      orderUpdates.completedAt = null;
    }
    
    const result = await db
      .update(orders)
      .set(orderUpdates)
      .where(eq(orders.id, orderId))
      .returning();
    
    if (resetProgress) {
      await db
        .update(orderItems)
        .set({ status: "pending" as ItemStatus, pickedQuantity: 0, shortReason: null })
        .where(eq(orderItems.orderId, orderId));
    }
    
    return result[0] || null;
  },

  async updateOrderStatus(orderId: number, status: OrderStatus): Promise<Order | null> {
    const updates: any = { warehouseStatus: status };
    if (status === "completed" || status === "ready_to_ship") {
      updates.completedAt = new Date();
    }

    const result = await db
      .update(orders)
      .set(updates)
      .where(eq(orders.id, orderId))
      .returning();

    if (status === "shipped" || status === "completed" || status === "cancelled") {
      await db.execute(sql`
        UPDATE order_items SET status = 'completed'
        WHERE order_id = ${orderId}
          AND status NOT IN ('completed', 'short')
      `);
    }

    return result[0] || null;
  },

  async updateOrderFields(orderId: number, updates: Partial<Order>): Promise<Order | null> {
    const { id, createdAt, ...safeUpdates } = updates as any;
    
    if (Object.keys(safeUpdates).length === 0) {
      const existing = await this.getOrderById(orderId);
      return existing || null;
    }
    
    const result = await db
      .update(orders)
      .set(safeUpdates)
      .where(eq(orders.id, orderId))
      .returning();
    
    return result[0] || null;
  },

  async getOrderItems(orderId: number): Promise<OrderItem[]> {
    return await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  },

  async getOrderItemById(itemId: number): Promise<OrderItem | undefined> {
    const result = await db.select().from(orderItems).where(eq(orderItems.id, itemId)).limit(1);
    return result[0];
  },

  async updateOrderItemStatus(
    itemId: number,
    status: ItemStatus,
    pickedQty?: number,
    shortReason?: string,
    expectedCurrentStatus?: ItemStatus,
  ): Promise<OrderItem | null> {
    const updates: any = { status };
    if (pickedQty !== undefined) updates.pickedQuantity = pickedQty;
    if (shortReason !== undefined) updates.shortReason = shortReason;
    if (status === "completed") {
      updates.pickedAt = new Date();
    } else if (status === "pending") {
      updates.pickedAt = null;
    }

    const condition = expectedCurrentStatus
      ? and(eq(orderItems.id, itemId), eq(orderItems.status, expectedCurrentStatus))
      : eq(orderItems.id, itemId);

    const result = await db
      .update(orderItems)
      .set(updates)
      .where(condition)
      .returning();

    return result[0] || null;
  },

  async updateOrderItemLocation(
    itemId: number,
    location: string,
    zone: string,
    barcode: string | null,
    imageUrl: string | null
  ): Promise<OrderItem | null> {
    const result = await db
      .update(orderItems)
      .set({ location, zone, barcode, imageUrl })
      .where(eq(orderItems.id, itemId))
      .returning();
    
    return result[0] || null;
  },

  async updateOrderProgress(orderId: number, postPickStatus: string = "ready_to_ship"): Promise<Order | null> {
    const items = await this.getOrderItems(orderId);
    const shippableItems = items.filter(item => item.requiresShipping === 1);
    const pickedCount = shippableItems.reduce((sum, item) => sum + item.pickedQuantity, 0);
    const itemCount = items.length;
    const unitCount = items.reduce((sum, item) => sum + item.quantity, 0);

    const allShippableDone = shippableItems.length > 0 &&
      shippableItems.every(item => item.status === "completed" || item.status === "short");
    const hasShortItems = shippableItems.some(item => item.status === "short");

    const updates: any = { pickedCount, itemCount, unitCount };
    if (allShippableDone) {
      if (hasShortItems) {
        updates.warehouseStatus = "exception" as OrderStatus;
        updates.exceptionAt = new Date();
        updates.completedAt = new Date();
      } else {
        updates.warehouseStatus = postPickStatus as OrderStatus;
        updates.completedAt = new Date();
      }
      
      const nonShippablePending = items.filter(item => item.requiresShipping !== 1 && item.status === "pending");
      for (const item of nonShippablePending) {
        await db.update(orderItems).set({ status: "completed" }).where(eq(orderItems.id, item.id));
      }
    }
    
    const result = await db
      .update(orders)
      .set(updates)
      .where(eq(orders.id, orderId))
      .returning();
    
    return result[0] || null;
  },

  async holdOrder(orderId: number): Promise<Order | null> {
    const result = await db
      .update(orders)
      .set({ onHold: 1, heldAt: new Date() })
      .where(eq(orders.id, orderId))
      .returning();
    return result[0] || null;
  },

  async releaseHoldOrder(orderId: number): Promise<Order | null> {
    const result = await db
      .update(orders)
      .set({ onHold: 0, heldAt: null })
      .where(eq(orders.id, orderId))
      .returning();
    return result[0] || null;
  },

  async setOrderPriority(orderId: number, priority: "rush" | "high" | "normal"): Promise<Order | null> {
    const result = await db
      .update(orders)
      .set({ priority })
      .where(eq(orders.id, orderId))
      .returning();
    return result[0] || null;
  },

  async getOrderItemByShopifyLineId(shopifyLineItemId: string): Promise<OrderItem | undefined> {
    const result = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.shopifyLineItemId, shopifyLineItemId));
    return result[0];
  },

  async updateItemFulfilledQuantity(shopifyLineItemId: string, additionalQty: number): Promise<OrderItem | null> {
    const item = await this.getOrderItemByShopifyLineId(shopifyLineItemId);
    if (!item) return null;
    
    const newFulfilledQty = Math.min(
      item.quantity, 
      (item.fulfilledQuantity || 0) + additionalQty
    );
    
    const result = await db
      .update(orderItems)
      .set({ fulfilledQuantity: newFulfilledQty })
      .where(eq(orderItems.shopifyLineItemId, shopifyLineItemId))
      .returning();
    
    return result[0] || null;
  },

  async areAllItemsFulfilled(orderId: number): Promise<boolean> {
    const items = await this.getOrderItems(orderId);
    if (items.length === 0) return false;
    
    return items.every(item => (item.fulfilledQuantity || 0) >= item.quantity);
  },

  async getExceptionOrders(): Promise<(Order & { items: OrderItem[] })[]> {
    const exceptionOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.warehouseStatus, "exception"))
      .orderBy(desc(orders.exceptionAt));
    
    const result: (Order & { items: OrderItem[] })[] = [];
    for (const order of exceptionOrders) {
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      result.push({ ...order, items });
    }
    
    return result;
  },

  async resolveException(
    orderId: number, 
    resolution: string, 
    resolvedBy: string, 
    notes?: string
  ): Promise<Order | null> {
    let newStatus: OrderStatus;
    switch (resolution) {
      case "ship_partial":
        newStatus = "completed";
        break;
      case "hold":
        newStatus = "exception";
        break;
      case "resolved":
        newStatus = "completed";
        break;
      case "cancelled":
        newStatus = "cancelled";
        break;
      default:
        newStatus = "completed";
    }
    
    const updates: any = {
      exceptionResolution: resolution,
      exceptionResolvedAt: new Date(),
      exceptionResolvedBy: resolvedBy,
      exceptionNotes: notes || null,
    };
    
    if (resolution !== "hold") {
      updates.status = newStatus;
    }
    
    const result = await db
      .update(orders)
      .set(updates)
      .where(eq(orders.id, orderId))
      .returning();
    
    return result[0] || null;
  },
};
