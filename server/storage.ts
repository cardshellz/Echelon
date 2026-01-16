import { 
  type User, 
  type InsertUser, 
  type SafeUser,
  type ProductLocation, 
  type InsertProductLocation,
  type UpdateProductLocation,
  type Order,
  type InsertOrder,
  type OrderItem,
  type InsertOrderItem,
  type OrderStatus,
  type ItemStatus,
  type WarehouseLocation,
  type InsertWarehouseLocation,
  type InventoryItem,
  type InsertInventoryItem,
  type UomVariant,
  type InsertUomVariant,
  type InventoryLevel,
  type InsertInventoryLevel,
  type InventoryTransaction,
  type InsertInventoryTransaction,
  type ChannelFeed,
  type InsertChannelFeed,
  users,
  productLocations,
  orders,
  orderItems,
  warehouseLocations,
  inventoryItems,
  uomVariants,
  inventoryLevels,
  inventoryTransactions,
  channelFeeds
} from "@shared/schema";
import { db } from "./db";
import { eq, inArray, notInArray, and, isNull, sql, desc, asc } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUserLastLogin(id: string): Promise<void>;
  getAllUsers(): Promise<SafeUser[]>;
  
  // Product Locations
  getAllProductLocations(): Promise<ProductLocation[]>;
  getProductLocationById(id: number): Promise<ProductLocation | undefined>;
  getProductLocationBySku(sku: string): Promise<ProductLocation | undefined>;
  createProductLocation(location: InsertProductLocation): Promise<ProductLocation>;
  updateProductLocation(id: number, location: UpdateProductLocation): Promise<ProductLocation | undefined>;
  deleteProductLocation(id: number): Promise<boolean>;
  
  // Bulk operations for Shopify sync
  upsertProductLocationBySku(sku: string, name: string, status?: string, imageUrl?: string, barcode?: string): Promise<ProductLocation>;
  deleteProductLocationsBySku(skus: string[]): Promise<number>;
  deleteOrphanedSkus(validSkus: string[]): Promise<number>;
  getAllSkus(): Promise<string[]>;
  
  // Orders
  getOrderByShopifyId(shopifyOrderId: string): Promise<Order | undefined>;
  getOrderById(id: number): Promise<Order | undefined>;
  getOrdersWithItems(status?: OrderStatus[]): Promise<(Order & { items: OrderItem[] })[]>;
  createOrderWithItems(order: InsertOrder, items: InsertOrderItem[]): Promise<Order>;
  claimOrder(orderId: number, pickerId: string): Promise<Order | null>;
  releaseOrder(orderId: number, resetProgress?: boolean): Promise<Order | null>;
  updateOrderStatus(orderId: number, status: OrderStatus): Promise<Order | null>;
  holdOrder(orderId: number): Promise<Order | null>;
  releaseHoldOrder(orderId: number): Promise<Order | null>;
  
  // Order Items
  getOrderItems(orderId: number): Promise<OrderItem[]>;
  getOrderItemById(itemId: number): Promise<OrderItem | undefined>;
  updateOrderItemStatus(itemId: number, status: ItemStatus, pickedQty?: number, shortReason?: string): Promise<OrderItem | null>;
  updateOrderItemLocation(itemId: number, location: string, zone: string, barcode: string | null, imageUrl: string | null): Promise<OrderItem | null>;
  updateOrderProgress(orderId: number): Promise<Order | null>;
  
  // Fulfillment tracking
  updateItemFulfilledQuantity(shopifyLineItemId: string, additionalQty: number): Promise<OrderItem | null>;
  getOrderItemByShopifyLineId(shopifyLineItemId: string): Promise<OrderItem | undefined>;
  areAllItemsFulfilled(orderId: number): Promise<boolean>;
  
  // Exception handling
  getExceptionOrders(): Promise<(Order & { items: OrderItem[] })[]>;
  resolveException(orderId: number, resolution: string, resolvedBy: string, notes?: string): Promise<Order | null>;
  
  // ============================================
  // INVENTORY MANAGEMENT (WMS)
  // ============================================
  
  // Warehouse Locations
  getAllWarehouseLocations(): Promise<WarehouseLocation[]>;
  getWarehouseLocationByCode(code: string): Promise<WarehouseLocation | undefined>;
  createWarehouseLocation(location: InsertWarehouseLocation): Promise<WarehouseLocation>;
  updateWarehouseLocation(id: number, updates: Partial<InsertWarehouseLocation>): Promise<WarehouseLocation | null>;
  
  // Inventory Items (Master SKUs)
  getAllInventoryItems(): Promise<InventoryItem[]>;
  getInventoryItemByBaseSku(baseSku: string): Promise<InventoryItem | undefined>;
  getInventoryItemBySku(sku: string): Promise<InventoryItem | undefined>;
  createInventoryItem(item: InsertInventoryItem): Promise<InventoryItem>;
  
  // UOM Variants
  getAllUomVariants(): Promise<UomVariant[]>;
  getUomVariantBySku(sku: string): Promise<UomVariant | undefined>;
  getUomVariantsByInventoryItemId(inventoryItemId: number): Promise<UomVariant[]>;
  createUomVariant(variant: InsertUomVariant): Promise<UomVariant>;
  
  // Inventory Levels
  getInventoryLevelsByItemId(inventoryItemId: number): Promise<InventoryLevel[]>;
  getInventoryLevelByLocationAndVariant(warehouseLocationId: number, variantId: number): Promise<InventoryLevel | undefined>;
  upsertInventoryLevel(level: InsertInventoryLevel): Promise<InventoryLevel>;
  adjustInventoryLevel(id: number, adjustments: { onHandBase?: number; reservedBase?: number; pickedBase?: number }): Promise<InventoryLevel | null>;
  getTotalOnHandByItemId(inventoryItemId: number, pickableOnly?: boolean): Promise<number>;
  getTotalReservedByItemId(inventoryItemId: number): Promise<number>;
  
  // Inventory Transactions
  createInventoryTransaction(transaction: InsertInventoryTransaction): Promise<InventoryTransaction>;
  getInventoryTransactionsByItemId(inventoryItemId: number, limit?: number): Promise<InventoryTransaction[]>;
  
  // Channel Feeds
  getChannelFeedsByVariantId(variantId: number): Promise<ChannelFeed[]>;
  getChannelFeedByVariantAndChannel(variantId: number, channelType: string): Promise<ChannelFeed | undefined>;
  upsertChannelFeed(feed: InsertChannelFeed): Promise<ChannelFeed>;
  updateChannelFeedSyncStatus(id: number, qty: number): Promise<ChannelFeed | null>;
  getChannelFeedsByChannel(channelType: string): Promise<(ChannelFeed & { variant: UomVariant })[]>;
}

export class DatabaseStorage implements IStorage {
  // User methods
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
    return result[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db.insert(users).values(insertUser).returning();
    return result[0];
  }

  async updateUserLastLogin(id: string): Promise<void> {
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
  }

  async getAllUsers(): Promise<SafeUser[]> {
    const result = await db.select({
      id: users.id,
      username: users.username,
      role: users.role,
      displayName: users.displayName,
      active: users.active,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    }).from(users);
    return result as SafeUser[];
  }

  // Product Location methods
  async getAllProductLocations(): Promise<ProductLocation[]> {
    return await db.select().from(productLocations).orderBy(productLocations.sku);
  }

  async getProductLocationById(id: number): Promise<ProductLocation | undefined> {
    const result = await db.select().from(productLocations).where(eq(productLocations.id, id));
    return result[0];
  }

  async getProductLocationBySku(sku: string): Promise<ProductLocation | undefined> {
    const result = await db.select().from(productLocations).where(eq(productLocations.sku, sku.toUpperCase()));
    return result[0];
  }

  async createProductLocation(location: InsertProductLocation): Promise<ProductLocation> {
    const result = await db.insert(productLocations).values({
      ...location,
      sku: location.sku.toUpperCase(),
      location: location.location.toUpperCase(),
      zone: location.zone.toUpperCase(),
    }).returning();
    return result[0];
  }

  async updateProductLocation(id: number, location: UpdateProductLocation): Promise<ProductLocation | undefined> {
    const updates: any = { ...location };
    if (updates.sku) updates.sku = updates.sku.toUpperCase();
    if (updates.location) updates.location = updates.location.toUpperCase();
    if (updates.zone) updates.zone = updates.zone.toUpperCase();
    updates.updatedAt = new Date();
    
    const result = await db
      .update(productLocations)
      .set(updates)
      .where(eq(productLocations.id, id))
      .returning();
    return result[0];
  }

  async deleteProductLocation(id: number): Promise<boolean> {
    const result = await db.delete(productLocations).where(eq(productLocations.id, id)).returning();
    return result.length > 0;
  }

  async upsertProductLocationBySku(sku: string, name: string, status?: string, imageUrl?: string, barcode?: string): Promise<ProductLocation> {
    const upperSku = sku.toUpperCase();
    const existing = await this.getProductLocationBySku(upperSku);
    
    if (existing) {
      const updates: any = { name, updatedAt: new Date() };
      if (status) updates.status = status;
      if (imageUrl !== undefined) updates.imageUrl = imageUrl;
      if (barcode !== undefined) updates.barcode = barcode || null;
      const result = await db
        .update(productLocations)
        .set(updates)
        .where(eq(productLocations.sku, upperSku))
        .returning();
      return result[0];
    } else {
      const result = await db.insert(productLocations).values({
        sku: upperSku,
        name,
        location: "UNASSIGNED",
        zone: "U",
        status: status || "active",
        imageUrl: imageUrl || null,
        barcode: barcode || null,
      }).returning();
      return result[0];
    }
  }

  async deleteProductLocationsBySku(skus: string[]): Promise<number> {
    if (skus.length === 0) return 0;
    const upperSkus = skus.map(s => s.toUpperCase());
    const result = await db.delete(productLocations)
      .where(inArray(productLocations.sku, upperSkus))
      .returning();
    return result.length;
  }

  async deleteOrphanedSkus(validSkus: string[]): Promise<number> {
    if (validSkus.length === 0) {
      const result = await db.delete(productLocations).returning();
      return result.length;
    }
    const upperSkus = validSkus.map(s => s.toUpperCase());
    const result = await db.delete(productLocations)
      .where(notInArray(productLocations.sku, upperSkus))
      .returning();
    return result.length;
  }

  async getAllSkus(): Promise<string[]> {
    const result = await db.select({ sku: productLocations.sku }).from(productLocations);
    return result.map(r => r.sku);
  }

  // Order methods
  async getOrderByShopifyId(shopifyOrderId: string): Promise<Order | undefined> {
    const result = await db.select().from(orders).where(eq(orders.shopifyOrderId, shopifyOrderId));
    return result[0];
  }

  async getOrderById(id: number): Promise<Order | undefined> {
    const result = await db.select().from(orders).where(eq(orders.id, id));
    return result[0];
  }

  async getOrdersWithItems(status?: OrderStatus[]): Promise<(Order & { items: OrderItem[] })[]> {
    let query = db.select().from(orders);
    
    if (status && status.length > 0) {
      query = query.where(inArray(orders.status, status)) as any;
    }
    
    const orderList = await query.orderBy(desc(orders.createdAt));
    
    const result: (Order & { items: OrderItem[] })[] = [];
    for (const order of orderList) {
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      result.push({ ...order, items });
    }
    
    return result;
  }

  async createOrderWithItems(order: InsertOrder, items: InsertOrderItem[]): Promise<Order> {
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
  }

  async claimOrder(orderId: number, pickerId: string): Promise<Order | null> {
    const result = await db
      .update(orders)
      .set({
        status: "in_progress" as OrderStatus,
        assignedPickerId: pickerId,
        startedAt: new Date(),
      })
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.status, "ready"),
          isNull(orders.assignedPickerId),
          eq(orders.onHold, 0) // Cannot claim held orders
        )
      )
      .returning();
    
    return result[0] || null;
  }

  async releaseOrder(orderId: number, resetProgress: boolean = true): Promise<Order | null> {
    const orderUpdates: any = {
      status: "ready" as OrderStatus,
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
    
    if (resetProgress) {
      await db
        .update(orderItems)
        .set({ status: "pending" as ItemStatus, pickedQuantity: 0, shortReason: null })
        .where(eq(orderItems.orderId, orderId));
    }
    
    return result[0] || null;
  }

  async updateOrderStatus(orderId: number, status: OrderStatus): Promise<Order | null> {
    const updates: any = { status };
    if (status === "completed" || status === "ready_to_ship") {
      updates.completedAt = new Date();
    }
    
    const result = await db
      .update(orders)
      .set(updates)
      .where(eq(orders.id, orderId))
      .returning();
    
    return result[0] || null;
  }

  // Order Item methods
  async getOrderItems(orderId: number): Promise<OrderItem[]> {
    return await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  }

  async getOrderItemById(itemId: number): Promise<OrderItem | undefined> {
    const result = await db.select().from(orderItems).where(eq(orderItems.id, itemId)).limit(1);
    return result[0];
  }

  async updateOrderItemStatus(
    itemId: number, 
    status: ItemStatus, 
    pickedQty?: number, 
    shortReason?: string
  ): Promise<OrderItem | null> {
    const updates: any = { status };
    if (pickedQty !== undefined) updates.pickedQuantity = pickedQty;
    if (shortReason !== undefined) updates.shortReason = shortReason;
    // Set pickedAt timestamp when item is marked as completed
    if (status === "completed") {
      updates.pickedAt = new Date();
    } else if (status === "pending") {
      // Clear pickedAt if item is reset
      updates.pickedAt = null;
    }
    
    const result = await db
      .update(orderItems)
      .set(updates)
      .where(eq(orderItems.id, itemId))
      .returning();
    
    return result[0] || null;
  }

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
  }

  async updateOrderProgress(orderId: number): Promise<Order | null> {
    const items = await this.getOrderItems(orderId);
    const pickedCount = items.reduce((sum, item) => sum + item.pickedQuantity, 0);
    const totalCount = items.reduce((sum, item) => sum + item.quantity, 0);
    const allDone = items.every(item => item.status === "completed" || item.status === "short");
    const hasShortItems = items.some(item => item.status === "short");
    
    const updates: any = { pickedCount };
    if (allDone) {
      // If any items are short, move to exception status for lead review
      // Otherwise, move to completed status
      if (hasShortItems) {
        updates.status = "exception" as OrderStatus;
        updates.exceptionAt = new Date();
        updates.completedAt = new Date(); // Still record when picking finished
      } else {
        updates.status = "completed" as OrderStatus;
        updates.completedAt = new Date();
      }
    }
    
    const result = await db
      .update(orders)
      .set(updates)
      .where(eq(orders.id, orderId))
      .returning();
    
    return result[0] || null;
  }

  async holdOrder(orderId: number): Promise<Order | null> {
    const result = await db
      .update(orders)
      .set({ onHold: 1, heldAt: new Date() })
      .where(eq(orders.id, orderId))
      .returning();
    return result[0] || null;
  }

  async releaseHoldOrder(orderId: number): Promise<Order | null> {
    const result = await db
      .update(orders)
      .set({ onHold: 0, heldAt: null })
      .where(eq(orders.id, orderId))
      .returning();
    return result[0] || null;
  }

  // Fulfillment tracking methods
  async getOrderItemByShopifyLineId(shopifyLineItemId: string): Promise<OrderItem | undefined> {
    const result = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.shopifyLineItemId, shopifyLineItemId));
    return result[0];
  }

  async updateItemFulfilledQuantity(shopifyLineItemId: string, additionalQty: number): Promise<OrderItem | null> {
    // First get the current item to add to its fulfilled quantity
    const item = await this.getOrderItemByShopifyLineId(shopifyLineItemId);
    if (!item) return null;
    
    // Clamp to not exceed the ordered quantity (prevents over-counting from webhook retries)
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
  }

  async areAllItemsFulfilled(orderId: number): Promise<boolean> {
    const items = await this.getOrderItems(orderId);
    if (items.length === 0) return false;
    
    // All items must have fulfilledQuantity >= quantity
    return items.every(item => (item.fulfilledQuantity || 0) >= item.quantity);
  }

  // Exception handling methods
  async getExceptionOrders(): Promise<(Order & { items: OrderItem[] })[]> {
    const exceptionOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.status, "exception"))
      .orderBy(desc(orders.exceptionAt));
    
    const result: (Order & { items: OrderItem[] })[] = [];
    for (const order of exceptionOrders) {
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      result.push({ ...order, items });
    }
    
    return result;
  }

  async resolveException(
    orderId: number, 
    resolution: string, 
    resolvedBy: string, 
    notes?: string
  ): Promise<Order | null> {
    // Determine the new status based on resolution
    let newStatus: OrderStatus;
    switch (resolution) {
      case "ship_partial":
        newStatus = "completed"; // Ready to ship what we have
        break;
      case "hold":
        newStatus = "exception"; // Stay in exception, just record the decision
        break;
      case "resolved":
        newStatus = "completed"; // Issue resolved, ready to ship
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
    
    // Only change status if not "hold"
    if (resolution !== "hold") {
      updates.status = newStatus;
    }
    
    const result = await db
      .update(orders)
      .set(updates)
      .where(eq(orders.id, orderId))
      .returning();
    
    return result[0] || null;
  }

  // ============================================
  // INVENTORY MANAGEMENT (WMS) IMPLEMENTATIONS
  // ============================================

  // Warehouse Locations
  async getAllWarehouseLocations(): Promise<WarehouseLocation[]> {
    return await db.select().from(warehouseLocations).orderBy(asc(warehouseLocations.code));
  }

  async getWarehouseLocationByCode(code: string): Promise<WarehouseLocation | undefined> {
    const result = await db.select().from(warehouseLocations).where(eq(warehouseLocations.code, code.toUpperCase()));
    return result[0];
  }

  async createWarehouseLocation(location: InsertWarehouseLocation): Promise<WarehouseLocation> {
    const result = await db.insert(warehouseLocations).values({
      ...location,
      code: location.code.toUpperCase(),
    }).returning();
    return result[0];
  }

  async updateWarehouseLocation(id: number, updates: Partial<InsertWarehouseLocation>): Promise<WarehouseLocation | null> {
    const result = await db
      .update(warehouseLocations)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(warehouseLocations.id, id))
      .returning();
    return result[0] || null;
  }

  // Inventory Items (Master SKUs)
  async getAllInventoryItems(): Promise<InventoryItem[]> {
    return await db.select().from(inventoryItems).orderBy(asc(inventoryItems.baseSku));
  }

  async getInventoryItemByBaseSku(baseSku: string): Promise<InventoryItem | undefined> {
    const result = await db.select().from(inventoryItems).where(eq(inventoryItems.baseSku, baseSku.toUpperCase()));
    return result[0];
  }

  async getInventoryItemBySku(sku: string): Promise<InventoryItem | undefined> {
    // First try to match as a base SKU
    const byBase = await this.getInventoryItemByBaseSku(sku);
    if (byBase) return byBase;
    
    // Then try to find via variant SKU
    const variant = await this.getUomVariantBySku(sku);
    if (variant) {
      const result = await db.select().from(inventoryItems).where(eq(inventoryItems.id, variant.inventoryItemId));
      return result[0];
    }
    
    return undefined;
  }

  async createInventoryItem(item: InsertInventoryItem): Promise<InventoryItem> {
    const result = await db.insert(inventoryItems).values({
      ...item,
      baseSku: item.baseSku.toUpperCase(),
    }).returning();
    return result[0];
  }

  // UOM Variants
  async getAllUomVariants(): Promise<UomVariant[]> {
    return await db.select().from(uomVariants).orderBy(asc(uomVariants.sku));
  }

  async getUomVariantBySku(sku: string): Promise<UomVariant | undefined> {
    const result = await db.select().from(uomVariants).where(eq(uomVariants.sku, sku.toUpperCase()));
    return result[0];
  }

  async getUomVariantsByInventoryItemId(inventoryItemId: number): Promise<UomVariant[]> {
    return await db
      .select()
      .from(uomVariants)
      .where(eq(uomVariants.inventoryItemId, inventoryItemId))
      .orderBy(asc(uomVariants.hierarchyLevel));
  }

  async createUomVariant(variant: InsertUomVariant): Promise<UomVariant> {
    const result = await db.insert(uomVariants).values({
      ...variant,
      sku: variant.sku.toUpperCase(),
    }).returning();
    return result[0];
  }

  // Inventory Levels
  async getInventoryLevelsByItemId(inventoryItemId: number): Promise<InventoryLevel[]> {
    return await db
      .select()
      .from(inventoryLevels)
      .where(eq(inventoryLevels.inventoryItemId, inventoryItemId));
  }

  async getInventoryLevelByLocationAndVariant(warehouseLocationId: number, variantId: number): Promise<InventoryLevel | undefined> {
    const result = await db
      .select()
      .from(inventoryLevels)
      .where(and(
        eq(inventoryLevels.warehouseLocationId, warehouseLocationId),
        eq(inventoryLevels.variantId, variantId)
      ));
    return result[0];
  }

  async upsertInventoryLevel(level: InsertInventoryLevel): Promise<InventoryLevel> {
    // Check if exists
    const existing = await db
      .select()
      .from(inventoryLevels)
      .where(and(
        eq(inventoryLevels.inventoryItemId, level.inventoryItemId),
        eq(inventoryLevels.warehouseLocationId, level.warehouseLocationId)
      ));
    
    if (existing[0]) {
      const result = await db
        .update(inventoryLevels)
        .set({ ...level, updatedAt: new Date() })
        .where(eq(inventoryLevels.id, existing[0].id))
        .returning();
      return result[0];
    } else {
      const result = await db.insert(inventoryLevels).values(level).returning();
      return result[0];
    }
  }

  async adjustInventoryLevel(id: number, adjustments: { onHandBase?: number; reservedBase?: number; pickedBase?: number }): Promise<InventoryLevel | null> {
    const updates: any = { updatedAt: new Date() };
    
    // Delta-based updates: values are added to current amounts
    if (adjustments.onHandBase !== undefined) {
      updates.onHandBase = sql`${inventoryLevels.onHandBase} + ${adjustments.onHandBase}`;
    }
    if (adjustments.reservedBase !== undefined) {
      updates.reservedBase = sql`${inventoryLevels.reservedBase} + ${adjustments.reservedBase}`;
    }
    if (adjustments.pickedBase !== undefined) {
      updates.pickedBase = sql`${inventoryLevels.pickedBase} + ${adjustments.pickedBase}`;
    }
    
    const result = await db
      .update(inventoryLevels)
      .set(updates)
      .where(eq(inventoryLevels.id, id))
      .returning();
    return result[0] || null;
  }

  async getTotalOnHandByItemId(inventoryItemId: number, pickableOnly: boolean = false): Promise<number> {
    if (pickableOnly) {
      const result = await db
        .select({ total: sql<number>`COALESCE(SUM(${inventoryLevels.onHandBase}), 0)` })
        .from(inventoryLevels)
        .innerJoin(warehouseLocations, eq(inventoryLevels.warehouseLocationId, warehouseLocations.id))
        .where(and(
          eq(inventoryLevels.inventoryItemId, inventoryItemId),
          eq(warehouseLocations.isPickable, 1)
        ));
      return result[0]?.total || 0;
    } else {
      const result = await db
        .select({ total: sql<number>`COALESCE(SUM(${inventoryLevels.onHandBase}), 0)` })
        .from(inventoryLevels)
        .where(eq(inventoryLevels.inventoryItemId, inventoryItemId));
      return result[0]?.total || 0;
    }
  }

  async getTotalReservedByItemId(inventoryItemId: number): Promise<number> {
    const result = await db
      .select({ total: sql<number>`COALESCE(SUM(${inventoryLevels.reservedBase}), 0)` })
      .from(inventoryLevels)
      .where(eq(inventoryLevels.inventoryItemId, inventoryItemId));
    return result[0]?.total || 0;
  }

  // Inventory Transactions
  async createInventoryTransaction(transaction: InsertInventoryTransaction): Promise<InventoryTransaction> {
    const result = await db.insert(inventoryTransactions).values(transaction).returning();
    return result[0];
  }

  async getInventoryTransactionsByItemId(inventoryItemId: number, limit: number = 100): Promise<InventoryTransaction[]> {
    return await db
      .select()
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.inventoryItemId, inventoryItemId))
      .orderBy(desc(inventoryTransactions.createdAt))
      .limit(limit);
  }

  // Channel Feeds
  async getChannelFeedsByVariantId(variantId: number): Promise<ChannelFeed[]> {
    return await db
      .select()
      .from(channelFeeds)
      .where(eq(channelFeeds.variantId, variantId));
  }

  async getChannelFeedByVariantAndChannel(variantId: number, channelType: string): Promise<ChannelFeed | undefined> {
    const result = await db
      .select()
      .from(channelFeeds)
      .where(and(
        eq(channelFeeds.variantId, variantId),
        eq(channelFeeds.channelType, channelType)
      ));
    return result[0];
  }

  async upsertChannelFeed(feed: InsertChannelFeed): Promise<ChannelFeed> {
    const existing = await this.getChannelFeedByVariantAndChannel(feed.variantId, feed.channelType || "shopify");
    
    if (existing) {
      const result = await db
        .update(channelFeeds)
        .set({ ...feed, updatedAt: new Date() })
        .where(eq(channelFeeds.id, existing.id))
        .returning();
      return result[0];
    } else {
      const result = await db.insert(channelFeeds).values(feed).returning();
      return result[0];
    }
  }

  async updateChannelFeedSyncStatus(id: number, qty: number): Promise<ChannelFeed | null> {
    const result = await db
      .update(channelFeeds)
      .set({ 
        lastSyncedAt: new Date(),
        lastSyncedQty: qty,
        updatedAt: new Date()
      })
      .where(eq(channelFeeds.id, id))
      .returning();
    return result[0] || null;
  }

  async getChannelFeedsByChannel(channelType: string): Promise<(ChannelFeed & { variant: UomVariant })[]> {
    const result = await db
      .select({
        id: channelFeeds.id,
        variantId: channelFeeds.variantId,
        channelType: channelFeeds.channelType,
        channelVariantId: channelFeeds.channelVariantId,
        channelProductId: channelFeeds.channelProductId,
        channelSku: channelFeeds.channelSku,
        isActive: channelFeeds.isActive,
        lastSyncedAt: channelFeeds.lastSyncedAt,
        lastSyncedQty: channelFeeds.lastSyncedQty,
        createdAt: channelFeeds.createdAt,
        updatedAt: channelFeeds.updatedAt,
        variant: uomVariants
      })
      .from(channelFeeds)
      .innerJoin(uomVariants, eq(channelFeeds.variantId, uomVariants.id))
      .where(eq(channelFeeds.channelType, channelType));
    return result as (ChannelFeed & { variant: UomVariant })[];
  }
}

export const storage = new DatabaseStorage();
