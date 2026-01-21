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
  type PickingLog,
  type InsertPickingLog,
  type AdjustmentReason,
  type InsertAdjustmentReason,
  type Channel,
  type InsertChannel,
  type ChannelConnection,
  type InsertChannelConnection,
  type PartnerProfile,
  type InsertPartnerProfile,
  type ChannelReservation,
  type InsertChannelReservation,
  users,
  productLocations,
  orders,
  orderItems,
  warehouseLocations,
  inventoryItems,
  uomVariants,
  inventoryLevels,
  inventoryTransactions,
  channelFeeds,
  pickingLogs,
  adjustmentReasons,
  channels,
  channelConnections,
  partnerProfiles,
  channelReservations
} from "@shared/schema";
import { db } from "./db";
import { eq, inArray, notInArray, and, isNull, sql, desc, asc, gte, lte, like } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUserLastLogin(id: string): Promise<void>;
  updateUser(id: string, data: { displayName?: string; role?: string; password?: string; active?: number }): Promise<User | undefined>;
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
  forceReleaseOrder(orderId: number, resetProgress?: boolean): Promise<Order | null>;
  updateOrderStatus(orderId: number, status: OrderStatus): Promise<Order | null>;
  holdOrder(orderId: number): Promise<Order | null>;
  releaseHoldOrder(orderId: number): Promise<Order | null>;
  setOrderPriority(orderId: number, priority: "rush" | "high" | "normal"): Promise<Order | null>;
  
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
  getWarehouseLocationById(id: number): Promise<WarehouseLocation | undefined>;
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
  getAllInventoryLevels(): Promise<InventoryLevel[]>;
  getInventoryLevelsByItemId(inventoryItemId: number): Promise<InventoryLevel[]>;
  getInventoryLevelByLocationAndVariant(warehouseLocationId: number, variantId: number): Promise<InventoryLevel | undefined>;
  upsertInventoryLevel(level: InsertInventoryLevel): Promise<InventoryLevel>;
  adjustInventoryLevel(id: number, adjustments: { variantQty?: number; onHandBase?: number; reservedBase?: number; pickedBase?: number; backorderBase?: number }): Promise<InventoryLevel | null>;
  getTotalOnHandByItemId(inventoryItemId: number, pickableOnly?: boolean): Promise<number>;
  getTotalReservedByItemId(inventoryItemId: number): Promise<number>;
  
  // Inventory Transactions
  createInventoryTransaction(transaction: InsertInventoryTransaction): Promise<InventoryTransaction>;
  getInventoryTransactionsByItemId(inventoryItemId: number, limit?: number): Promise<InventoryTransaction[]>;
  getInventoryTransactions(filters: {
    batchId?: string;
    transactionType?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<InventoryTransaction[]>;
  
  // Adjustment Reasons
  getAllAdjustmentReasons(): Promise<AdjustmentReason[]>;
  getActiveAdjustmentReasons(): Promise<AdjustmentReason[]>;
  getAdjustmentReasonByCode(code: string): Promise<AdjustmentReason | undefined>;
  getAdjustmentReasonById(id: number): Promise<AdjustmentReason | undefined>;
  createAdjustmentReason(reason: InsertAdjustmentReason): Promise<AdjustmentReason>;
  updateAdjustmentReason(id: number, updates: Partial<InsertAdjustmentReason>): Promise<AdjustmentReason | null>;
  
  // Channel Feeds
  getChannelFeedsByVariantId(variantId: number): Promise<ChannelFeed[]>;
  getChannelFeedByVariantAndChannel(variantId: number, channelType: string): Promise<ChannelFeed | undefined>;
  upsertChannelFeed(feed: InsertChannelFeed): Promise<ChannelFeed>;
  updateChannelFeedSyncStatus(id: number, qty: number): Promise<ChannelFeed | null>;
  getChannelFeedsByChannel(channelType: string): Promise<(ChannelFeed & { variant: UomVariant })[]>;
  
  // ============================================
  // PICKING LOGS (Audit Trail)
  // ============================================
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
  
  // ============================================
  // ORDER HISTORY
  // ============================================
  getOrderHistory(filters: {
    orderNumber?: string;
    customerName?: string;
    sku?: string;
    pickerId?: string;
    status?: string[];
    priority?: string;
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
    startDate?: Date;
    endDate?: Date;
  }): Promise<number>;
  getOrderDetail(orderId: number): Promise<{
    order: Order;
    items: OrderItem[];
    pickingLogs: PickingLog[];
    picker?: { id: string; displayName: string | null };
  } | null>;
  
  // ============================================
  // CHANNELS MANAGEMENT
  // ============================================
  getAllChannels(): Promise<Channel[]>;
  getChannelById(id: number): Promise<Channel | undefined>;
  createChannel(channel: InsertChannel): Promise<Channel>;
  updateChannel(id: number, updates: Partial<InsertChannel>): Promise<Channel | null>;
  deleteChannel(id: number): Promise<boolean>;
  
  // Channel Connections
  getChannelConnection(channelId: number): Promise<ChannelConnection | undefined>;
  upsertChannelConnection(connection: InsertChannelConnection): Promise<ChannelConnection>;
  updateChannelConnectionSyncStatus(channelId: number, status: string, error?: string | null): Promise<void>;
  
  // Partner Profiles
  getPartnerProfile(channelId: number): Promise<PartnerProfile | undefined>;
  upsertPartnerProfile(profile: InsertPartnerProfile): Promise<PartnerProfile>;
  
  // Channel Reservations
  getChannelReservations(channelId?: number): Promise<(ChannelReservation & { channel?: Channel; inventoryItem?: InventoryItem })[]>;
  getChannelReservationByChannelAndItem(channelId: number, inventoryItemId: number): Promise<ChannelReservation | undefined>;
  upsertChannelReservation(reservation: InsertChannelReservation): Promise<ChannelReservation>;
  deleteChannelReservation(id: number): Promise<boolean>;
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

  async updateUser(id: string, data: { displayName?: string; role?: string; password?: string; active?: number }): Promise<User | undefined> {
    const updateData: Partial<{ displayName: string; role: string; password: string; active: number }> = {};
    if (data.displayName !== undefined) updateData.displayName = data.displayName;
    if (data.role !== undefined) updateData.role = data.role;
    if (data.password !== undefined) updateData.password = data.password;
    if (data.active !== undefined) updateData.active = data.active;
    
    if (Object.keys(updateData).length === 0) return undefined;
    
    const result = await db.update(users).set(updateData).where(eq(users.id, id)).returning();
    return result[0];
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

  async forceReleaseOrder(orderId: number, resetProgress: boolean = false): Promise<Order | null> {
    // Force release clears assignment and hold status, optionally resets progress
    const orderUpdates: any = {
      status: "ready" as OrderStatus,
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

  async setOrderPriority(orderId: number, priority: "rush" | "high" | "normal"): Promise<Order | null> {
    const result = await db
      .update(orders)
      .set({ priority })
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

  async getWarehouseLocationById(id: number): Promise<WarehouseLocation | undefined> {
    const result = await db.select().from(warehouseLocations).where(eq(warehouseLocations.id, id));
    return result[0];
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
  async getAllInventoryLevels(): Promise<InventoryLevel[]> {
    return await db.select().from(inventoryLevels);
  }

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

  async adjustInventoryLevel(id: number, adjustments: { variantQty?: number; onHandBase?: number; reservedBase?: number; pickedBase?: number; backorderBase?: number }): Promise<InventoryLevel | null> {
    const updates: any = { updatedAt: new Date() };
    
    // Delta-based updates: values are added to current amounts
    if (adjustments.variantQty !== undefined) {
      updates.variantQty = sql`${inventoryLevels.variantQty} + ${adjustments.variantQty}`;
    }
    if (adjustments.onHandBase !== undefined) {
      updates.onHandBase = sql`${inventoryLevels.onHandBase} + ${adjustments.onHandBase}`;
    }
    if (adjustments.reservedBase !== undefined) {
      updates.reservedBase = sql`${inventoryLevels.reservedBase} + ${adjustments.reservedBase}`;
    }
    if (adjustments.pickedBase !== undefined) {
      updates.pickedBase = sql`${inventoryLevels.pickedBase} + ${adjustments.pickedBase}`;
    }
    if (adjustments.backorderBase !== undefined) {
      updates.backorderBase = sql`${inventoryLevels.backorderBase} + ${adjustments.backorderBase}`;
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

  async getInventoryTransactions(filters: {
    batchId?: string;
    transactionType?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<InventoryTransaction[]> {
    const conditions = [];
    if (filters.batchId) conditions.push(eq(inventoryTransactions.batchId, filters.batchId));
    if (filters.transactionType) conditions.push(eq(inventoryTransactions.transactionType, filters.transactionType));
    if (filters.startDate) conditions.push(gte(inventoryTransactions.createdAt, filters.startDate));
    if (filters.endDate) conditions.push(lte(inventoryTransactions.createdAt, filters.endDate));
    
    let query = db
      .select()
      .from(inventoryTransactions)
      .orderBy(desc(inventoryTransactions.createdAt))
      .limit(filters.limit || 100)
      .offset(filters.offset || 0);
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }
    
    return await query;
  }

  // Adjustment Reasons
  async getAllAdjustmentReasons(): Promise<AdjustmentReason[]> {
    return await db.select().from(adjustmentReasons).orderBy(asc(adjustmentReasons.sortOrder));
  }

  async getActiveAdjustmentReasons(): Promise<AdjustmentReason[]> {
    return await db
      .select()
      .from(adjustmentReasons)
      .where(eq(adjustmentReasons.isActive, 1))
      .orderBy(asc(adjustmentReasons.sortOrder));
  }

  async getAdjustmentReasonByCode(code: string): Promise<AdjustmentReason | undefined> {
    const result = await db
      .select()
      .from(adjustmentReasons)
      .where(eq(adjustmentReasons.code, code.toUpperCase()));
    return result[0];
  }

  async getAdjustmentReasonById(id: number): Promise<AdjustmentReason | undefined> {
    const result = await db.select().from(adjustmentReasons).where(eq(adjustmentReasons.id, id));
    return result[0];
  }

  async createAdjustmentReason(reason: InsertAdjustmentReason): Promise<AdjustmentReason> {
    const result = await db.insert(adjustmentReasons).values({
      ...reason,
      code: reason.code.toUpperCase(),
    }).returning();
    return result[0];
  }

  async updateAdjustmentReason(id: number, updates: Partial<InsertAdjustmentReason>): Promise<AdjustmentReason | null> {
    const result = await db
      .update(adjustmentReasons)
      .set(updates)
      .where(eq(adjustmentReasons.id, id))
      .returning();
    return result[0] || null;
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

  // ============================================
  // PICKING LOGS (Audit Trail)
  // ============================================

  async createPickingLog(log: InsertPickingLog): Promise<PickingLog> {
    const result = await db.insert(pickingLogs).values(log).returning();
    return result[0];
  }

  async getPickingLogsByOrderId(orderId: number): Promise<PickingLog[]> {
    return await db
      .select()
      .from(pickingLogs)
      .where(eq(pickingLogs.orderId, orderId))
      .orderBy(asc(pickingLogs.timestamp));
  }

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
  }

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
  }
  
  // ============================================
  // ORDER HISTORY
  // ============================================
  
  async getOrderHistory(filters: {
    orderNumber?: string;
    customerName?: string;
    sku?: string;
    pickerId?: string;
    status?: string[];
    priority?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<(Order & { items: OrderItem[]; pickerName?: string })[]> {
    const conditions = [];
    
    // Default to completed/shipped/cancelled orders (historical)
    const defaultStatuses = ['completed', 'shipped', 'cancelled', 'exception'];
    const statuses = filters.status && filters.status.length > 0 ? filters.status : defaultStatuses;
    conditions.push(inArray(orders.status, statuses as any));
    
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
    if (filters.startDate) {
      conditions.push(gte(orders.completedAt, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(orders.completedAt, filters.endDate));
    }
    
    // If filtering by SKU, find matching order IDs first (before pagination)
    if (filters.sku) {
      const skuFilter = filters.sku.toUpperCase();
      const ordersWithSku = await db
        .select({ orderId: orderItems.orderId })
        .from(orderItems)
        .where(like(orderItems.sku, `%${skuFilter}%`));
      const matchingOrderIds = [...new Set(ordersWithSku.map(i => i.orderId))];
      
      if (matchingOrderIds.length === 0) {
        return []; // No orders match the SKU filter
      }
      conditions.push(inArray(orders.id, matchingOrderIds));
    }
    
    let query = db.select().from(orders);
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }
    
    query = query.orderBy(desc(orders.completedAt), desc(orders.createdAt)) as any;
    
    const limit = filters.limit || 50;
    query = query.limit(limit) as any;
    
    if (filters.offset) {
      query = query.offset(filters.offset) as any;
    }
    
    const orderList = await query;
    
    // Get items and picker names for each order
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
  }
  
  async getOrderHistoryCount(filters: {
    orderNumber?: string;
    customerName?: string;
    sku?: string;
    pickerId?: string;
    status?: string[];
    priority?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<number> {
    const conditions = [];
    
    const defaultStatuses = ['completed', 'shipped', 'cancelled', 'exception'];
    const statuses = filters.status && filters.status.length > 0 ? filters.status : defaultStatuses;
    conditions.push(inArray(orders.status, statuses as any));
    
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
    if (filters.startDate) {
      conditions.push(gte(orders.completedAt, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(orders.completedAt, filters.endDate));
    }
    
    // If filtering by SKU, we need a subquery approach
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
  }
  
  async getOrderDetail(orderId: number): Promise<{
    order: Order;
    items: OrderItem[];
    pickingLogs: PickingLog[];
    picker?: { id: string; displayName: string | null };
  } | null> {
    const order = await db.select().from(orders).where(eq(orders.id, orderId));
    if (order.length === 0) return null;
    
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const logs = await db.select().from(pickingLogs).where(eq(pickingLogs.orderId, orderId)).orderBy(asc(pickingLogs.timestamp));
    
    let picker: { id: string; displayName: string | null } | undefined;
    if (order[0].assignedPickerId) {
      const pickerResult = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, order[0].assignedPickerId));
      picker = pickerResult[0];
    }
    
    return {
      order: order[0],
      items,
      pickingLogs: logs,
      picker
    };
  }
  
  // ============================================
  // CHANNELS MANAGEMENT
  // ============================================
  async getAllChannels(): Promise<Channel[]> {
    return db.select().from(channels).orderBy(asc(channels.priority), asc(channels.name));
  }
  
  async getChannelById(id: number): Promise<Channel | undefined> {
    const result = await db.select().from(channels).where(eq(channels.id, id));
    return result[0];
  }
  
  async createChannel(channel: InsertChannel): Promise<Channel> {
    const result = await db.insert(channels).values(channel).returning();
    return result[0];
  }
  
  async updateChannel(id: number, updates: Partial<InsertChannel>): Promise<Channel | null> {
    const result = await db.update(channels)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(channels.id, id))
      .returning();
    return result[0] || null;
  }
  
  async deleteChannel(id: number): Promise<boolean> {
    const result = await db.delete(channels).where(eq(channels.id, id)).returning();
    return result.length > 0;
  }
  
  // Channel Connections
  async getChannelConnection(channelId: number): Promise<ChannelConnection | undefined> {
    const result = await db.select().from(channelConnections).where(eq(channelConnections.channelId, channelId));
    return result[0];
  }
  
  async upsertChannelConnection(connection: InsertChannelConnection): Promise<ChannelConnection> {
    const existing = await this.getChannelConnection(connection.channelId);
    if (existing) {
      const result = await db.update(channelConnections)
        .set({ ...connection, updatedAt: new Date() })
        .where(eq(channelConnections.channelId, connection.channelId))
        .returning();
      return result[0];
    }
    const result = await db.insert(channelConnections).values(connection).returning();
    return result[0];
  }
  
  async updateChannelConnectionSyncStatus(channelId: number, status: string, error?: string | null): Promise<void> {
    await db.update(channelConnections)
      .set({ 
        syncStatus: status, 
        syncError: error,
        lastSyncAt: status === 'ok' ? new Date() : undefined,
        updatedAt: new Date() 
      })
      .where(eq(channelConnections.channelId, channelId));
  }
  
  // Partner Profiles
  async getPartnerProfile(channelId: number): Promise<PartnerProfile | undefined> {
    const result = await db.select().from(partnerProfiles).where(eq(partnerProfiles.channelId, channelId));
    return result[0];
  }
  
  async upsertPartnerProfile(profile: InsertPartnerProfile): Promise<PartnerProfile> {
    const existing = await this.getPartnerProfile(profile.channelId);
    if (existing) {
      const result = await db.update(partnerProfiles)
        .set({ ...profile, updatedAt: new Date() })
        .where(eq(partnerProfiles.channelId, profile.channelId))
        .returning();
      return result[0];
    }
    const result = await db.insert(partnerProfiles).values(profile).returning();
    return result[0];
  }
  
  // Channel Reservations
  async getChannelReservations(channelId?: number): Promise<(ChannelReservation & { channel?: Channel; inventoryItem?: InventoryItem })[]> {
    let query = db.select({
      reservation: channelReservations,
      channel: channels,
      inventoryItem: inventoryItems
    })
    .from(channelReservations)
    .leftJoin(channels, eq(channelReservations.channelId, channels.id))
    .leftJoin(inventoryItems, eq(channelReservations.inventoryItemId, inventoryItems.id));
    
    if (channelId) {
      query = query.where(eq(channelReservations.channelId, channelId)) as any;
    }
    
    const results = await query.orderBy(asc(channels.name));
    return results.map(r => ({
      ...r.reservation,
      channel: r.channel || undefined,
      inventoryItem: r.inventoryItem || undefined
    }));
  }
  
  async getChannelReservationByChannelAndItem(channelId: number, inventoryItemId: number): Promise<ChannelReservation | undefined> {
    const result = await db.select().from(channelReservations)
      .where(and(
        eq(channelReservations.channelId, channelId),
        eq(channelReservations.inventoryItemId, inventoryItemId)
      ));
    return result[0];
  }
  
  async upsertChannelReservation(reservation: InsertChannelReservation): Promise<ChannelReservation> {
    const existing = await this.getChannelReservationByChannelAndItem(reservation.channelId, reservation.inventoryItemId);
    if (existing) {
      const result = await db.update(channelReservations)
        .set({ ...reservation, updatedAt: new Date() })
        .where(eq(channelReservations.id, existing.id))
        .returning();
      return result[0];
    }
    const result = await db.insert(channelReservations).values(reservation).returning();
    return result[0];
  }
  
  async deleteChannelReservation(id: number): Promise<boolean> {
    const result = await db.delete(channelReservations).where(eq(channelReservations.id, id)).returning();
    return result.length > 0;
  }
}

export const storage = new DatabaseStorage();
