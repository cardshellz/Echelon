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
  type Warehouse,
  type InsertWarehouse,
  type WarehouseLocation,
  type InsertWarehouseLocation,
  type WarehouseZone,
  type InsertWarehouseZone,
  type Product,
  type InsertProduct,
  type ProductVariant,
  type InsertProductVariant,
  type InventoryLevel,
  type InsertInventoryLevel,
  type InventoryTransaction,
  type InsertInventoryTransaction,
  type ChannelFeed,
  type InsertChannelFeed,
  type PickingLog,
  type EchelonSetting,
  type InsertEchelonSetting,
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
  type CatalogProduct,
  type InsertCatalogProduct,
  type ReplenTierDefault,
  type InsertReplenTierDefault,
  type CatalogAsset,
  type InsertCatalogAsset,
  type CycleCount,
  type InsertCycleCount,
  type CycleCountItem,
  type InsertCycleCountItem,
  type Vendor,
  type InsertVendor,
  type ReceivingOrder,
  type InsertReceivingOrder,
  type ReceivingLine,
  type InsertReceivingLine,
  type ReplenRule,
  type InsertReplenRule,
  type LocationReplenConfig,
  type InsertLocationReplenConfig,
  type ReplenTask,
  type InsertReplenTask,
  type WarehouseSettings,
  type InsertWarehouseSettings,
  users,
  productLocations,
  orders,
  orderItems,
  warehouses,
  warehouseLocations,
  warehouseZones,
  products,
  productVariants,
  inventoryLevels,
  inventoryTransactions,
  channelFeeds,
  pickingLogs,
  adjustmentReasons,
  channels,
  channelConnections,
  partnerProfiles,
  channelReservations,
  catalogProducts,
  catalogAssets,
  cycleCounts,
  cycleCountItems,
  vendors,
  receivingOrders,
  receivingLines,
  replenTierDefaults,
  replenRules,
  locationReplenConfig,
  replenTasks,
  warehouseSettings,
  generateLocationCode,
  echelonSettings
} from "@shared/schema";
import { db } from "./db";
import { eq, inArray, notInArray, and, or, isNull, isNotNull, sql, desc, asc, gte, lte, like } from "drizzle-orm";

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
  getBinLocationFromInventoryBySku(sku: string): Promise<{ location: string; zone: string; barcode: string | null; imageUrl: string | null } | undefined>;
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
  
  // Order Items
  getOrderItems(orderId: number): Promise<OrderItem[]>;
  getOrderItemById(itemId: number): Promise<OrderItem | undefined>;
  updateOrderItemStatus(itemId: number, status: ItemStatus, pickedQty?: number, shortReason?: string, expectedCurrentStatus?: ItemStatus): Promise<OrderItem | null>;
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
  
  // Warehouse Zones
  // Warehouses (physical sites)
  getAllWarehouses(): Promise<Warehouse[]>;
  getWarehouseById(id: number): Promise<Warehouse | undefined>;
  getWarehouseByCode(code: string): Promise<Warehouse | undefined>;
  createWarehouse(warehouse: InsertWarehouse): Promise<Warehouse>;
  updateWarehouse(id: number, updates: Partial<InsertWarehouse>): Promise<Warehouse | null>;
  deleteWarehouse(id: number): Promise<boolean>;
  
  getAllWarehouseZones(): Promise<WarehouseZone[]>;
  getWarehouseZoneByCode(code: string): Promise<WarehouseZone | undefined>;
  createWarehouseZone(zone: InsertWarehouseZone): Promise<WarehouseZone>;
  updateWarehouseZone(id: number, updates: Partial<InsertWarehouseZone>): Promise<WarehouseZone | null>;
  deleteWarehouseZone(id: number): Promise<boolean>;
  
  // Warehouse Locations
  getAllWarehouseLocations(): Promise<WarehouseLocation[]>;
  getWarehouseLocationById(id: number): Promise<WarehouseLocation | undefined>;
  getWarehouseLocationByCode(code: string): Promise<WarehouseLocation | undefined>;
  createWarehouseLocation(location: Omit<InsertWarehouseLocation, 'code'>): Promise<WarehouseLocation>;
  updateWarehouseLocation(id: number, updates: Partial<Omit<InsertWarehouseLocation, 'code'>>): Promise<WarehouseLocation | null>;
  deleteWarehouseLocation(id: number): Promise<boolean>;
  
  // Catalog Products
  getAllCatalogProducts(): Promise<CatalogProduct[]>;
  getCatalogProductById(id: number): Promise<CatalogProduct | undefined>;
  getCatalogProductByProductVariantId(productVariantId: number): Promise<CatalogProduct | undefined>;
  createCatalogProduct(product: InsertCatalogProduct): Promise<CatalogProduct>;
  updateCatalogProduct(id: number, updates: Partial<InsertCatalogProduct>): Promise<CatalogProduct | null>;
  deleteCatalogProduct(id: number): Promise<boolean>;
  
  // Catalog Assets
  getCatalogAssetsByProductId(catalogProductId: number): Promise<CatalogAsset[]>;
  createCatalogAsset(asset: InsertCatalogAsset): Promise<CatalogAsset>;
  deleteCatalogAsset(id: number): Promise<boolean>;
  
  // Products (Master Catalog - NEW)
  getAllProducts(): Promise<Product[]>;
  getProductById(id: number): Promise<Product | undefined>;
  getProductBySku(sku: string): Promise<Product | undefined>;
  createProduct(product: InsertProduct): Promise<Product>;
  updateProduct(id: number, updates: Partial<InsertProduct>): Promise<Product | null>;
  deleteProduct(id: number): Promise<boolean>;
  
  // Product Variants (Sellable SKUs - NEW)
  getAllProductVariants(): Promise<ProductVariant[]>;
  getProductVariantById(id: number): Promise<ProductVariant | undefined>;
  getProductVariantBySku(sku: string): Promise<ProductVariant | undefined>;
  getProductVariantsByProductId(productId: number): Promise<ProductVariant[]>;
  createProductVariant(variant: InsertProductVariant): Promise<ProductVariant>;
  updateProductVariant(id: number, updates: Partial<InsertProductVariant>): Promise<ProductVariant | null>;
  deleteProductVariant(id: number): Promise<boolean>;
  
  // Catalog Products - additional methods
  getCatalogProductBySku(sku: string): Promise<CatalogProduct | undefined>;
  getCatalogProductByVariantId(variantId: number): Promise<CatalogProduct | undefined>;
  upsertCatalogProductBySku(sku: string, data: Partial<InsertCatalogProduct>): Promise<CatalogProduct>;
  upsertCatalogProductByVariantId(variantId: number, data: Partial<InsertCatalogProduct>): Promise<CatalogProduct>;
  deleteCatalogAssetsByProductId(catalogProductId: number): Promise<number>;
  
  // Inventory Levels
  getAllInventoryLevels(): Promise<InventoryLevel[]>;
  getInventoryLevelsByProductVariantId(productVariantId: number): Promise<InventoryLevel[]>;
  getInventoryLevelByLocationAndVariant(warehouseLocationId: number, productVariantId: number): Promise<InventoryLevel | undefined>;
  createInventoryLevel(level: InsertInventoryLevel): Promise<InventoryLevel>;
  upsertInventoryLevel(level: InsertInventoryLevel): Promise<InventoryLevel>;
  adjustInventoryLevel(id: number, adjustments: { variantQty?: number; reservedQty?: number; pickedQty?: number; backorderQty?: number }): Promise<InventoryLevel | null>;
  updateInventoryLevel(id: number, updates: { productVariantId?: number; variantQty?: number }): Promise<InventoryLevel | null>;
  getTotalOnHandByProductVariantId(productVariantId: number, pickableOnly?: boolean): Promise<number>;
  getTotalReservedByProductVariantId(productVariantId: number): Promise<number>;
  
  // Inventory Transactions
  createInventoryTransaction(transaction: InsertInventoryTransaction): Promise<InventoryTransaction>;
  getInventoryTransactionsByProductVariantId(productVariantId: number, limit?: number): Promise<InventoryTransaction[]>;
  getInventoryTransactions(filters: {
    batchId?: string;
    transactionType?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<InventoryTransaction[]>;
  
  // Bin-to-Bin Transfers
  executeTransfer(params: {
    fromLocationId: number;
    toLocationId: number;
    productVariantId: number;
    quantity: number;
    userId: string;
    notes?: string;
  }): Promise<InventoryTransaction>;
  getTransferHistory(limit?: number): Promise<{
    id: number;
    fromLocation: string;
    toLocation: string;
    sku: string;
    productName: string;
    quantity: number;
    userId: string;
    createdAt: Date;
    canUndo: boolean;
  }[]>;
  undoTransfer(transactionId: number, userId: string): Promise<InventoryTransaction>;
  
  // Adjustment Reasons
  getAllAdjustmentReasons(): Promise<AdjustmentReason[]>;
  getActiveAdjustmentReasons(): Promise<AdjustmentReason[]>;
  getAdjustmentReasonByCode(code: string): Promise<AdjustmentReason | undefined>;
  getAdjustmentReasonById(id: number): Promise<AdjustmentReason | undefined>;
  createAdjustmentReason(reason: InsertAdjustmentReason): Promise<AdjustmentReason>;
  updateAdjustmentReason(id: number, updates: Partial<InsertAdjustmentReason>): Promise<AdjustmentReason | null>;
  
  // Channel Feeds
  getChannelFeedsByProductVariantId(productVariantId: number): Promise<ChannelFeed[]>;
  getChannelFeedByVariantAndChannel(productVariantId: number, channelType: string): Promise<ChannelFeed | undefined>;
  upsertChannelFeed(feed: InsertChannelFeed): Promise<ChannelFeed>;
  updateChannelFeedSyncStatus(id: number, qty: number): Promise<ChannelFeed | null>;
  getChannelFeedsByChannel(channelType: string): Promise<(ChannelFeed & { variant: ProductVariant })[]>;
  
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
  getChannelReservations(channelId?: number): Promise<(ChannelReservation & { channel?: Channel; productVariant?: ProductVariant })[]>;
  getChannelReservationByChannelAndProductVariant(channelId: number, productVariantId: number): Promise<ChannelReservation | undefined>;
  upsertChannelReservation(reservation: InsertChannelReservation): Promise<ChannelReservation>;
  deleteChannelReservation(id: number): Promise<boolean>;
  
  // App Settings
  getAllSettings(): Promise<Record<string, string | null>>;
  getSetting(key: string): Promise<string | null>;
  upsertSetting(key: string, value: string | null, category?: string): Promise<EchelonSetting | null>;
  
  // ============================================
  // CYCLE COUNTS (Inventory Reconciliation)
  // ============================================
  getAllCycleCounts(): Promise<CycleCount[]>;
  getCycleCountById(id: number): Promise<CycleCount | undefined>;
  createCycleCount(data: InsertCycleCount): Promise<CycleCount>;
  updateCycleCount(id: number, updates: Partial<InsertCycleCount>): Promise<CycleCount | null>;
  deleteCycleCount(id: number): Promise<boolean>;
  
  // Cycle Count Items
  getCycleCountItems(cycleCountId: number): Promise<CycleCountItem[]>;
  getCycleCountItemById(id: number): Promise<CycleCountItem | undefined>;
  createCycleCountItem(data: InsertCycleCountItem): Promise<CycleCountItem>;
  updateCycleCountItem(id: number, updates: Partial<InsertCycleCountItem>): Promise<CycleCountItem | null>;
  deleteCycleCountItem(id: number): Promise<boolean>;
  bulkCreateCycleCountItems(items: InsertCycleCountItem[]): Promise<CycleCountItem[]>;
  
  // ============================================
  // REPLENISHMENT
  // ============================================
  
  // Tier Defaults (default rules by UOM hierarchy level)
  getAllReplenTierDefaults(): Promise<ReplenTierDefault[]>;
  getReplenTierDefaultById(id: number): Promise<ReplenTierDefault | undefined>;
  getReplenTierDefaultByLevel(hierarchyLevel: number): Promise<ReplenTierDefault | undefined>;
  getActiveReplenTierDefaults(): Promise<ReplenTierDefault[]>;
  createReplenTierDefault(data: InsertReplenTierDefault): Promise<ReplenTierDefault>;
  updateReplenTierDefault(id: number, updates: Partial<InsertReplenTierDefault>): Promise<ReplenTierDefault | null>;
  deleteReplenTierDefault(id: number): Promise<boolean>;
  
  // SKU Overrides (product-specific exceptions)
  getAllReplenRules(): Promise<ReplenRule[]>;
  getReplenRuleById(id: number): Promise<ReplenRule | undefined>;
  getReplenRulesForVariant(pickProductVariantId: number): Promise<ReplenRule[]>;
  getReplenRulesForProduct(catalogProductId: number): Promise<ReplenRule[]>;
  createReplenRule(data: InsertReplenRule): Promise<ReplenRule>;
  updateReplenRule(id: number, updates: Partial<InsertReplenRule>): Promise<ReplenRule | null>;
  deleteReplenRule(id: number): Promise<boolean>;
  getActiveReplenRules(): Promise<ReplenRule[]>;

  // Location Replen Config (per-location overrides)
  getLocationReplenConfigs(warehouseLocationId?: number): Promise<LocationReplenConfig[]>;
  getLocationReplenConfig(warehouseLocationId: number, productVariantId: number | null): Promise<LocationReplenConfig | undefined>;
  getLocationReplenConfigById(id: number): Promise<LocationReplenConfig | undefined>;
  createLocationReplenConfig(data: InsertLocationReplenConfig): Promise<LocationReplenConfig>;
  updateLocationReplenConfig(id: number, updates: Partial<InsertLocationReplenConfig>): Promise<LocationReplenConfig | null>;
  deleteLocationReplenConfig(id: number): Promise<boolean>;

  // Replen Tasks
  getAllReplenTasks(filters?: { status?: string; assignedTo?: string }): Promise<ReplenTask[]>;
  getReplenTaskById(id: number): Promise<ReplenTask | undefined>;
  createReplenTask(data: InsertReplenTask): Promise<ReplenTask>;
  updateReplenTask(id: number, updates: Partial<InsertReplenTask>): Promise<ReplenTask | null>;
  deleteReplenTask(id: number): Promise<boolean>;
  getPendingReplenTasksForLocation(toLocationId: number): Promise<ReplenTask[]>;
  
  // Warehouse Settings
  getAllWarehouseSettings(): Promise<WarehouseSettings[]>;
  getWarehouseSettingsByCode(code: string): Promise<WarehouseSettings | undefined>;
  getWarehouseSettingsById(id: number): Promise<WarehouseSettings | undefined>;
  getDefaultWarehouseSettings(): Promise<WarehouseSettings | undefined>;
  createWarehouseSettings(data: InsertWarehouseSettings): Promise<WarehouseSettings>;
  updateWarehouseSettings(id: number, updates: Partial<InsertWarehouseSettings>): Promise<WarehouseSettings | null>;
  deleteWarehouseSettings(id: number): Promise<boolean>;
  
  // Vendors
  getAllVendors(): Promise<Vendor[]>;
  getVendorById(id: number): Promise<Vendor | undefined>;
  getVendorByCode(code: string): Promise<Vendor | undefined>;
  createVendor(data: InsertVendor): Promise<Vendor>;
  updateVendor(id: number, updates: Partial<InsertVendor>): Promise<Vendor | null>;
  deleteVendor(id: number): Promise<boolean>;
  
  // Receiving Orders
  getAllReceivingOrders(): Promise<ReceivingOrder[]>;
  getReceivingOrderById(id: number): Promise<ReceivingOrder | undefined>;
  getReceivingOrderByReceiptNumber(receiptNumber: string): Promise<ReceivingOrder | undefined>;
  getReceivingOrdersByStatus(status: string): Promise<ReceivingOrder[]>;
  createReceivingOrder(data: InsertReceivingOrder): Promise<ReceivingOrder>;
  updateReceivingOrder(id: number, updates: Partial<InsertReceivingOrder>): Promise<ReceivingOrder | null>;
  deleteReceivingOrder(id: number): Promise<boolean>;
  generateReceiptNumber(): Promise<string>;
  
  // Receiving Lines
  getReceivingLines(receivingOrderId: number): Promise<ReceivingLine[]>;
  getReceivingLineById(id: number): Promise<ReceivingLine | undefined>;
  createReceivingLine(data: InsertReceivingLine): Promise<ReceivingLine>;
  updateReceivingLine(id: number, updates: Partial<InsertReceivingLine>): Promise<ReceivingLine | null>;
  deleteReceivingLine(id: number): Promise<boolean>;
  bulkCreateReceivingLines(lines: InsertReceivingLine[]): Promise<ReceivingLine[]>;
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

  // NEW: Get bin location from inventory_levels instead of product_locations
  // Returns location data for picking based on where inventory actually exists
  // CRITICAL: Prioritizes pick locations over reserve to ensure pickers go to pickable bins
  async getBinLocationFromInventoryBySku(sku: string): Promise<{
    location: string;
    zone: string;
    barcode: string | null;
    imageUrl: string | null;
  } | undefined> {
    // Look up product variant by SKU, then find any inventory level for that variant
    // barcode and image_url are on product_variants / products
    // Priority: pick first, then reserve, then by pick sequence, then by quantity
    const result = await db.execute<{
      location_code: string;
      zone: string | null;
      barcode: string | null;
      image_url: string | null;
    }>(sql`
      SELECT
        wl.code as location_code,
        wl.zone,
        pv.barcode,
        COALESCE(pv.image_url, p.image_url) as image_url
      FROM product_variants pv
      JOIN inventory_levels il ON il.product_variant_id = pv.id
      JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
      LEFT JOIN products p ON pv.product_id = p.id
      WHERE UPPER(pv.sku) = ${sku.toUpperCase()}
        AND il.variant_qty > 0
        AND wl.is_pickable = 1
      ORDER BY
        CASE wl.location_type
          WHEN 'pick' THEN 1
          WHEN 'reserve' THEN 2
          ELSE 3
        END,
        wl.is_pickable DESC,
        wl.pick_sequence ASC NULLS LAST,
        il.variant_qty DESC
      LIMIT 1
    `);
    
    if (result.rows.length === 0) return undefined;
    
    const row = result.rows[0];
    return {
      location: row.location_code,
      zone: row.zone || "U",
      barcode: row.barcode,
      imageUrl: row.image_url,
    };
  }

  async getProductLocationByCatalogProductId(catalogProductId: number): Promise<ProductLocation | undefined> {
    const result = await db.select().from(productLocations).where(eq(productLocations.catalogProductId, catalogProductId));
    return result[0];
  }

  async getProductLocationsByCatalogProductId(catalogProductId: number): Promise<ProductLocation[]> {
    return await db.select().from(productLocations)
      .where(eq(productLocations.catalogProductId, catalogProductId))
      .orderBy(sql`${productLocations.isPrimary} DESC`);
  }

  async getProductLocationsByWarehouseLocationId(warehouseLocationId: number): Promise<ProductLocation[]> {
    return await db.select().from(productLocations)
      .where(eq(productLocations.warehouseLocationId, warehouseLocationId))
      .orderBy(productLocations.name);
  }

  async addProductToLocation(data: {
    catalogProductId: number;
    warehouseLocationId: number;
    sku?: string | null;
    shopifyVariantId?: number | null;
    name: string;
    location: string;
    zone: string;
    locationType?: string;
    isPrimary?: number;
    imageUrl?: string | null;
    barcode?: string | null;
  }): Promise<ProductLocation> {
    // Check if product already has a location entry (handles legacy unique constraints on sku or catalog_product_id)
    // If so, update the existing entry instead of inserting
    const existingByProduct = await db.select().from(productLocations)
      .where(eq(productLocations.catalogProductId, data.catalogProductId));
    
    if (existingByProduct.length > 0) {
      // Product already has a location - update the existing entry to the new location
      const existing = existingByProduct[0];
      const result = await db.update(productLocations)
        .set({
          warehouseLocationId: data.warehouseLocationId,
          sku: data.sku?.toUpperCase() || existing.sku,
          shopifyVariantId: data.shopifyVariantId || existing.shopifyVariantId,
          name: data.name || existing.name,
          location: data.location.toUpperCase(),
          zone: data.zone.toUpperCase(),
          locationType: data.locationType || existing.locationType,
          isPrimary: data.isPrimary ?? 1,
          imageUrl: data.imageUrl || existing.imageUrl,
          barcode: data.barcode || existing.barcode,
          updatedAt: new Date(),
        })
        .where(eq(productLocations.id, existing.id))
        .returning();
      return result[0];
    }
    
    // Also check by SKU in case product was synced via legacy path
    if (data.sku) {
      const existingBySku = await db.select().from(productLocations)
        .where(eq(productLocations.sku, data.sku.toUpperCase()));
      
      if (existingBySku.length > 0) {
        const existing = existingBySku[0];
        const result = await db.update(productLocations)
          .set({
            catalogProductId: data.catalogProductId,
            warehouseLocationId: data.warehouseLocationId,
            shopifyVariantId: data.shopifyVariantId || existing.shopifyVariantId,
            name: data.name || existing.name,
            location: data.location.toUpperCase(),
            zone: data.zone.toUpperCase(),
            locationType: data.locationType || existing.locationType,
            isPrimary: data.isPrimary ?? 1,
            imageUrl: data.imageUrl || existing.imageUrl,
            barcode: data.barcode || existing.barcode,
            updatedAt: new Date(),
          })
          .where(eq(productLocations.id, existing.id))
          .returning();
        return result[0];
      }
    }
    
    if (data.isPrimary === 1) {
      await db.update(productLocations)
        .set({ isPrimary: 0, updatedAt: new Date() })
        .where(eq(productLocations.catalogProductId, data.catalogProductId));
    }
    
    const result = await db.insert(productLocations).values({
      catalogProductId: data.catalogProductId,
      warehouseLocationId: data.warehouseLocationId,
      sku: data.sku?.toUpperCase() || null,
      shopifyVariantId: data.shopifyVariantId || null,
      name: data.name,
      location: data.location.toUpperCase(),
      zone: data.zone.toUpperCase(),
      locationType: data.locationType || "pick",
      isPrimary: data.isPrimary ?? 1,
      status: "active",
      imageUrl: data.imageUrl || null,
      barcode: data.barcode || null,
    }).returning();
    return result[0];
  }

  async setPrimaryLocation(productLocationId: number): Promise<ProductLocation | undefined> {
    const location = await this.getProductLocationById(productLocationId);
    if (!location || !location.catalogProductId) return undefined;
    
    await db.update(productLocations)
      .set({ isPrimary: 0, updatedAt: new Date() })
      .where(eq(productLocations.catalogProductId, location.catalogProductId));
    
    const result = await db.update(productLocations)
      .set({ isPrimary: 1, updatedAt: new Date() })
      .where(eq(productLocations.id, productLocationId))
      .returning();
    return result[0];
  }

  async createProductLocation(location: InsertProductLocation): Promise<ProductLocation> {
    const result = await db.insert(productLocations).values({
      ...location,
      sku: location.sku?.toUpperCase() || null,
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
      query = query.where(inArray(orders.warehouseStatus, status)) as any;
    }
    
    const orderList = await query.orderBy(desc(orders.createdAt));
    
    if (orderList.length === 0) {
      return [];
    }
    
    // Fetch all items for these orders in ONE query (avoid N+1)
    const orderIds = orderList.map(o => o.id);
    const allItems = await db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds));
    
    // Group items by orderId
    const itemsByOrderId = new Map<number, OrderItem[]>();
    for (const item of allItems) {
      const existing = itemsByOrderId.get(item.orderId) || [];
      existing.push(item);
      itemsByOrderId.set(item.orderId, existing);
    }
    
    // Combine orders with their items
    return orderList.map(order => ({
      ...order,
      items: itemsByOrderId.get(order.id) || [],
    }));
  }

  async getPickQueueOrders(): Promise<(Order & { items: OrderItem[] })[]> {
    // Optimized: Only fetch orders that need to be in pick queue
    // - EXCLUDE orders already fulfilled in Shopify (source of truth) for ready/in_progress
    // - ready and in_progress orders (unfulfilled only)
    // - completed orders from last 24 hours (show regardless of fulfillment status for done queue)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // Use raw SQL to JOIN with shopify_orders and exclude fulfilled
    // Get customer name from shopify_orders as fallback
    // NOTE: Completed orders are shown even if fulfilled (for done queue history)
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
    
    // Map snake_case columns to camelCase for Order type
    const orderRows: Order[] = (orderList.rows as any[]).map(row => ({
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
    
    // Fetch all items for these orders in ONE query
    const orderIds = orderRows.map(o => o.id);
    const allItems = await db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds));
    
    // Enrich items missing imageUrl by looking up from product_locations, product_variants, products
    const skusMissingImages = [...new Set(
      allItems.filter(item => !item.imageUrl && item.sku).map(item => item.sku!.toUpperCase())
    )];

    const imageMap = new Map<string, string>();
    if (skusMissingImages.length > 0) {
      try {
        const imageResults = await db.execute<{ sku: string; image_url: string }>(sql`
          SELECT UPPER(sku) as sku, image_url FROM (
            SELECT pl.sku, pl.image_url FROM product_locations pl
            WHERE UPPER(pl.sku) = ANY(${skusMissingImages}) AND pl.image_url IS NOT NULL
            UNION ALL
            SELECT pv.sku, COALESCE(pv.image_url, p.image_url) as image_url
            FROM product_variants pv
            LEFT JOIN products p ON pv.product_id = p.id
            WHERE UPPER(pv.sku) = ANY(${skusMissingImages})
              AND COALESCE(pv.image_url, p.image_url) IS NOT NULL
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
    
    // Apply enriched images to items missing them
    const enrichedItems = allItems.map(item => {
      if (!item.imageUrl && item.sku) {
        const foundImage = imageMap.get(item.sku.toUpperCase());
        if (foundImage) {
          return { ...item, imageUrl: foundImage };
        }
      }
      return item;
    });
    
    // Group items by orderId
    const itemsByOrderId = new Map<number, OrderItem[]>();
    for (const item of enrichedItems) {
      const existing = itemsByOrderId.get(item.orderId) || [];
      existing.push(item);
      itemsByOrderId.set(item.orderId, existing);
    }
    
    // Auto-fix stuck orders: if all shippable items are done but warehouse_status is still in_progress
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

    // Combine orders with their items
    return orderRows.map(order => ({
      ...order,
      items: itemsByOrderId.get(order.id) || [],
    }));
  }

  async createOrderWithItems(order: InsertOrder, items: InsertOrderItem[]): Promise<Order> {
    // DEDUPLICATION: Check if order already exists by shopifyOrderId OR sourceTableId
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
  }

  async claimOrder(orderId: number, pickerId: string): Promise<Order | null> {
    // First, check if this picker already owns the order (can continue their work)
    const existingOrder = await db.select().from(orders).where(
      and(
        eq(orders.id, orderId),
        eq(orders.assignedPickerId, pickerId)
      )
    );
    
    if (existingOrder.length > 0) {
      // Picker already owns this order - return it so they can continue
      console.log(`[CLAIM] Picker ${pickerId} already owns order ${orderId}, returning existing`);
      return existingOrder[0];
    }
    
    // Check current order state for debugging
    const currentOrder = await db.select().from(orders).where(eq(orders.id, orderId));
    if (currentOrder.length > 0) {
      console.log(`[CLAIM] Order ${orderId} current state:`, {
        warehouseStatus: currentOrder[0].warehouseStatus,
        assignedPickerId: currentOrder[0].assignedPickerId,
        onHold: currentOrder[0].onHold
      });
    }
    
    // Try to claim an unassigned order that is ready OR in_progress but unassigned
    // (handles edge case where release set status but picker ID update was partial)
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
            // Normal case: ready order with no picker
            eq(orders.warehouseStatus, "ready"),
            // Edge case: in_progress but no picker assigned (incomplete release)
            and(
              eq(orders.warehouseStatus, "in_progress"),
              isNull(orders.assignedPickerId)
            )
          ),
          isNull(orders.assignedPickerId),
          eq(orders.onHold, 0) // Cannot claim held orders
        )
      )
      .returning();
    
    if (result.length === 0) {
      console.log(`[CLAIM] Order ${orderId} claim failed - not available for picker ${pickerId}`);
    } else {
      console.log(`[CLAIM] Order ${orderId} claimed successfully by picker ${pickerId}`);
    }
    
    return result[0] || null;
  }

  async releaseOrder(orderId: number, resetProgress: boolean = true): Promise<Order | null> {
    // Get current state for logging
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
  }

  async forceReleaseOrder(orderId: number, resetProgress: boolean = false): Promise<Order | null> {
    // Force release clears assignment and hold status, optionally resets progress
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
  }

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
    
    return result[0] || null;
  }

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
    shortReason?: string,
    expectedCurrentStatus?: ItemStatus,
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

    // Idempotency guard: if caller specifies expectedCurrentStatus, only
    // update if the row still has that status (prevents concurrent overwrites).
    const condition = expectedCurrentStatus
      ? and(eq(orderItems.id, itemId), eq(orderItems.status, expectedCurrentStatus))
      : eq(orderItems.id, itemId);

    const result = await db
      .update(orderItems)
      .set(updates)
      .where(condition)
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
        // Auto-pack: skip manual "completed" step, go straight to ready_to_ship.
        // No pack station — ShipStation handles packing/shipping externally.
        updates.warehouseStatus = "ready_to_ship" as OrderStatus;
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
      .where(eq(orders.warehouseStatus, "exception"))
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

  // Warehouses (physical sites)
  async getAllWarehouses(): Promise<Warehouse[]> {
    return await db.select().from(warehouses).orderBy(asc(warehouses.name));
  }

  async getWarehouseById(id: number): Promise<Warehouse | undefined> {
    const result = await db.select().from(warehouses).where(eq(warehouses.id, id));
    return result[0];
  }

  async getWarehouseByCode(code: string): Promise<Warehouse | undefined> {
    const result = await db.select().from(warehouses).where(eq(warehouses.code, code.toUpperCase()));
    return result[0];
  }

  async createWarehouse(warehouse: InsertWarehouse): Promise<Warehouse> {
    const result = await db.insert(warehouses).values({
      ...warehouse,
      code: warehouse.code.toUpperCase(),
    }).returning();
    return result[0];
  }

  async updateWarehouse(id: number, updates: Partial<InsertWarehouse>): Promise<Warehouse | null> {
    const result = await db
      .update(warehouses)
      .set({
        ...updates,
        code: updates.code ? updates.code.toUpperCase() : undefined,
        updatedAt: new Date(),
      })
      .where(eq(warehouses.id, id))
      .returning();
    return result[0] || null;
  }

  async deleteWarehouse(id: number): Promise<boolean> {
    const result = await db.delete(warehouses).where(eq(warehouses.id, id)).returning();
    return result.length > 0;
  }

  // Warehouse Zones
  async getAllWarehouseZones(): Promise<WarehouseZone[]> {
    return await db.select().from(warehouseZones).orderBy(asc(warehouseZones.code));
  }

  async getWarehouseZoneByCode(code: string): Promise<WarehouseZone | undefined> {
    const result = await db.select().from(warehouseZones).where(eq(warehouseZones.code, code.toUpperCase()));
    return result[0];
  }

  async createWarehouseZone(zone: InsertWarehouseZone): Promise<WarehouseZone> {
    const result = await db.insert(warehouseZones).values({
      ...zone,
      code: zone.code.toUpperCase(),
    }).returning();
    return result[0];
  }

  async updateWarehouseZone(id: number, updates: Partial<InsertWarehouseZone>): Promise<WarehouseZone | null> {
    const result = await db
      .update(warehouseZones)
      .set(updates)
      .where(eq(warehouseZones.id, id))
      .returning();
    return result[0] || null;
  }

  async deleteWarehouseZone(id: number): Promise<boolean> {
    const result = await db.delete(warehouseZones).where(eq(warehouseZones.id, id)).returning();
    return result.length > 0;
  }

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

  async createWarehouseLocation(location: Omit<InsertWarehouseLocation, 'code'>): Promise<WarehouseLocation> {
    // generateLocationCode throws if no hierarchy fields provided
    const code = generateLocationCode(location);
    
    // Check for duplicate code
    const existing = await this.getWarehouseLocationByCode(code);
    if (existing) {
      throw new Error(`Location code "${code}" already exists`);
    }
    
    const result = await db.insert(warehouseLocations).values({
      ...location,
      code,
    }).returning();
    return result[0];
  }

  async updateWarehouseLocation(id: number, updates: Partial<Omit<InsertWarehouseLocation, 'code'>>): Promise<WarehouseLocation | null> {
    // Get existing location to merge hierarchy fields
    const existing = await this.getWarehouseLocationById(id);
    if (!existing) return null;
    
    // Merge updates with existing values for code regeneration
    const merged = { ...existing, ...updates };
    const newCode = generateLocationCode(merged);
    
    // Check if the new code would conflict with another location
    if (newCode !== existing.code) {
      const conflict = await this.getWarehouseLocationByCode(newCode);
      if (conflict && conflict.id !== id) {
        throw new Error(`Location code "${newCode}" already exists`);
      }
    }
    
    const result = await db
      .update(warehouseLocations)
      .set({ ...updates, code: newCode, updatedAt: new Date() })
      .where(eq(warehouseLocations.id, id))
      .returning();
    return result[0] || null;
  }

  async deleteWarehouseLocation(id: number): Promise<boolean> {
    const result = await db.delete(warehouseLocations).where(eq(warehouseLocations.id, id)).returning();
    return result.length > 0;
  }

  // Catalog Products
  async getAllCatalogProducts(): Promise<CatalogProduct[]> {
    return await db.select().from(catalogProducts).orderBy(desc(catalogProducts.updatedAt));
  }

  async getCatalogProductById(id: number): Promise<CatalogProduct | undefined> {
    const result = await db.select().from(catalogProducts).where(eq(catalogProducts.id, id));
    return result[0];
  }

  async getCatalogProductByProductVariantId(productVariantId: number): Promise<CatalogProduct | undefined> {
    const result = await db.select().from(catalogProducts).where(eq(catalogProducts.productVariantId, productVariantId));
    return result[0];
  }

  async createCatalogProduct(product: InsertCatalogProduct): Promise<CatalogProduct> {
    const result = await db.insert(catalogProducts).values(product).returning();
    return result[0];
  }

  async updateCatalogProduct(id: number, updates: Partial<InsertCatalogProduct>): Promise<CatalogProduct | null> {
    const result = await db.update(catalogProducts)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(catalogProducts.id, id))
      .returning();
    return result[0] || null;
  }

  async deleteCatalogProduct(id: number): Promise<boolean> {
    const result = await db.delete(catalogProducts).where(eq(catalogProducts.id, id)).returning();
    return result.length > 0;
  }

  // Catalog Assets
  async getCatalogAssetsByProductId(catalogProductId: number): Promise<CatalogAsset[]> {
    return await db.select().from(catalogAssets)
      .where(eq(catalogAssets.catalogProductId, catalogProductId))
      .orderBy(asc(catalogAssets.position));
  }

  async createCatalogAsset(asset: InsertCatalogAsset): Promise<CatalogAsset> {
    const result = await db.insert(catalogAssets).values(asset).returning();
    return result[0];
  }

  async deleteCatalogAsset(id: number): Promise<boolean> {
    const result = await db.delete(catalogAssets).where(eq(catalogAssets.id, id)).returning();
    return result.length > 0;
  }

  // ============================================================================
  // Products (Master Catalog - NEW)
  // ============================================================================
  async getAllProducts(): Promise<Product[]> {
    return await db.select().from(products).orderBy(asc(products.name));
  }

  async getProductById(id: number): Promise<Product | undefined> {
    const result = await db.select().from(products).where(eq(products.id, id));
    return result[0];
  }

  async getProductBySku(sku: string): Promise<Product | undefined> {
    const result = await db.select().from(products)
      .where(eq(products.sku, sku.toUpperCase()));
    return result[0];
  }

  async createProduct(product: InsertProduct): Promise<Product> {
    const result = await db.insert(products).values(product).returning();
    return result[0];
  }

  async updateProduct(id: number, updates: Partial<InsertProduct>): Promise<Product | null> {
    const result = await db.update(products)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    return result[0] || null;
  }

  async deleteProduct(id: number): Promise<boolean> {
    const result = await db.delete(products).where(eq(products.id, id)).returning();
    return result.length > 0;
  }

  // ============================================================================
  // Product Variants (Sellable SKUs - NEW)
  // ============================================================================
  async getAllProductVariants(): Promise<ProductVariant[]> {
    return await db.select().from(productVariants).orderBy(asc(productVariants.sku));
  }

  async getProductVariantById(id: number): Promise<ProductVariant | undefined> {
    const result = await db.select().from(productVariants).where(eq(productVariants.id, id));
    return result[0];
  }

  async getProductVariantBySku(sku: string): Promise<ProductVariant | undefined> {
    const result = await db.select().from(productVariants)
      .where(eq(productVariants.sku, sku.toUpperCase()));
    return result[0];
  }

  async getProductVariantsByProductId(productId: number): Promise<ProductVariant[]> {
    return await db.select().from(productVariants)
      .where(eq(productVariants.productId, productId))
      .orderBy(asc(productVariants.hierarchyLevel));
  }

  async createProductVariant(variant: InsertProductVariant): Promise<ProductVariant> {
    const result = await db.insert(productVariants).values(variant).returning();
    return result[0];
  }

  async updateProductVariant(id: number, updates: Partial<InsertProductVariant>): Promise<ProductVariant | null> {
    const result = await db.update(productVariants)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(productVariants.id, id))
      .returning();
    return result[0] || null;
  }

  async deleteProductVariant(id: number): Promise<boolean> {
    const result = await db.delete(productVariants).where(eq(productVariants.id, id)).returning();
    return result.length > 0;
  }


  async getAllCatalogProductsWithLocations(): Promise<{
    id: number;
    catalogProductId: number;
    productLocationId: number | null;
    shopifyVariantId: number | null;
    sku: string | null;
    name: string;
    location: string | null;
    zone: string | null;
    warehouseLocationId: number | null;
    warehouseId: number | null;
    status: string;
    imageUrl: string | null;
    updatedAt: Date | null;
  }[]> {
    // Get ALL catalog products with their locations (if assigned)
    // Join to warehouse_locations to get warehouseId for filtering
    // Join to product_variants/products for imageUrl
    const result = await db
      .select({
        id: catalogProducts.id,
        catalogProductId: catalogProducts.id,
        productLocationId: productLocations.id,
        shopifyVariantId: catalogProducts.shopifyVariantId,
        sku: catalogProducts.sku,
        name: catalogProducts.title,
        location: productLocations.location,
        zone: productLocations.zone,
        warehouseLocationId: productLocations.warehouseLocationId,
        warehouseId: warehouseLocations.warehouseId,
        status: sql<string>`COALESCE(${productLocations.status}, 'unassigned')`.as('status'),
        imageUrl: sql<string | null>`COALESCE(${productVariants.imageUrl}, ${products.imageUrl})`.as('image_url'),
        updatedAt: productLocations.updatedAt,
      })
      .from(catalogProducts)
      .leftJoin(productVariants, eq(catalogProducts.productVariantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productLocations, eq(catalogProducts.id, productLocations.catalogProductId))
      .leftJoin(warehouseLocations, eq(productLocations.warehouseLocationId, warehouseLocations.id))
      .orderBy(asc(catalogProducts.title));
    return result;
  }

  async getCatalogProductsWithoutLocations(): Promise<{
    id: number;
    shopifyVariantId: number | null;
    sku: string | null;
    title: string;
    imageUrl: string | null;
  }[]> {
    // Get all catalog products that don't have a product_locations entry (join by catalogProductId - internal ID is source of truth)
    const result = await db
      .select({
        id: catalogProducts.id,
        shopifyVariantId: catalogProducts.shopifyVariantId,
        sku: catalogProducts.sku,
        title: catalogProducts.title,
        imageUrl: sql<string | null>`COALESCE(${productVariants.imageUrl}, ${products.imageUrl})`.as('image_url'),
      })
      .from(catalogProducts)
      .leftJoin(productVariants, eq(catalogProducts.productVariantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productLocations, eq(catalogProducts.id, productLocations.catalogProductId))
      .where(isNull(productLocations.id))
      .orderBy(asc(catalogProducts.title));
    return result;
  }

  async getCatalogProductBySku(sku: string): Promise<CatalogProduct | undefined> {
    const result = await db.select().from(catalogProducts).where(eq(catalogProducts.sku, sku.toUpperCase()));
    return result[0];
  }

  async getCatalogProductByVariantId(variantId: number): Promise<CatalogProduct | undefined> {
    const result = await db.select().from(catalogProducts).where(eq(catalogProducts.shopifyVariantId, variantId));
    return result[0];
  }

  async upsertCatalogProductBySku(sku: string, data: Partial<InsertCatalogProduct>): Promise<CatalogProduct> {
    const normalizedSku = sku.toUpperCase();
    const existing = await this.getCatalogProductBySku(normalizedSku);

    if (existing) {
      const result = await db.update(catalogProducts)
        .set({
          ...data,
          updatedAt: new Date(),
        })
        .where(eq(catalogProducts.id, existing.id))
        .returning();
      return result[0];
    }

    const result = await db.insert(catalogProducts).values({
      productVariantId: data.productVariantId,
      sku: normalizedSku,
      title: data.title || normalizedSku,
      description: data.description,
      category: data.category,
      brand: data.brand,
      manufacturer: data.manufacturer,
      tags: data.tags,
      status: data.status || "active",
    }).returning();
    return result[0];
  }

  async upsertCatalogProductByVariantId(variantId: number, data: Partial<InsertCatalogProduct>): Promise<CatalogProduct> {
    const existing = await this.getCatalogProductByVariantId(variantId);

    if (existing) {
      const result = await db.update(catalogProducts)
        .set({
          ...data,
          sku: data.sku?.toUpperCase() || existing.sku,
          shopifyVariantId: variantId,
          updatedAt: new Date(),
        })
        .where(eq(catalogProducts.id, existing.id))
        .returning();
      return result[0];
    }

    const result = await db.insert(catalogProducts).values({
      productVariantId: data.productVariantId,
      shopifyVariantId: variantId,
      sku: data.sku?.toUpperCase() || null,
      title: data.title || "Untitled Product",
      description: data.description,
      category: data.category,
      brand: data.brand,
      manufacturer: data.manufacturer,
      tags: data.tags,
      status: data.status || "active",
    }).returning();
    return result[0];
  }

  async deleteCatalogAssetsByProductId(catalogProductId: number): Promise<number> {
    const result = await db.delete(catalogAssets).where(eq(catalogAssets.catalogProductId, catalogProductId)).returning();
    return result.length;
  }

  // Inventory Levels
  async getAllInventoryLevels(): Promise<InventoryLevel[]> {
    return await db.select().from(inventoryLevels);
  }

  async getInventoryLevelsByProductVariantId(productVariantId: number): Promise<InventoryLevel[]> {
    return await db
      .select()
      .from(inventoryLevels)
      .where(eq(inventoryLevels.productVariantId, productVariantId));
  }

  async getInventoryLevelByLocationAndVariant(warehouseLocationId: number, productVariantId: number): Promise<InventoryLevel | undefined> {
    const result = await db
      .select()
      .from(inventoryLevels)
      .where(and(
        eq(inventoryLevels.warehouseLocationId, warehouseLocationId),
        eq(inventoryLevels.productVariantId, productVariantId)
      ));
    return result[0];
  }

  async createInventoryLevel(level: InsertInventoryLevel): Promise<InventoryLevel> {
    const result = await db.insert(inventoryLevels).values(level).returning();
    return result[0];
  }

  async upsertInventoryLevel(level: InsertInventoryLevel): Promise<InventoryLevel> {
    // Check if exists by productVariantId + location
    if (!level.productVariantId) {
      throw new Error("productVariantId is required for upsertInventoryLevel");
    }

    const existing = await db
      .select()
      .from(inventoryLevels)
      .where(and(
        eq(inventoryLevels.productVariantId, level.productVariantId),
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

  async adjustInventoryLevel(id: number, adjustments: { variantQty?: number; reservedQty?: number; pickedQty?: number; backorderQty?: number }): Promise<InventoryLevel | null> {
    const updates: any = { updatedAt: new Date() };

    // Delta-based updates: values are added to current amounts
    if (adjustments.variantQty !== undefined) {
      updates.variantQty = sql`${inventoryLevels.variantQty} + ${adjustments.variantQty}`;
    }
    if (adjustments.reservedQty !== undefined) {
      updates.reservedQty = sql`${inventoryLevels.reservedQty} + ${adjustments.reservedQty}`;
    }
    if (adjustments.pickedQty !== undefined) {
      updates.pickedQty = sql`${inventoryLevels.pickedQty} + ${adjustments.pickedQty}`;
    }
    if (adjustments.backorderQty !== undefined) {
      updates.backorderQty = sql`${inventoryLevels.backorderQty} + ${adjustments.backorderQty}`;
    }

    const result = await db
      .update(inventoryLevels)
      .set(updates)
      .where(eq(inventoryLevels.id, id))
      .returning();
    return result[0] || null;
  }

  async updateInventoryLevel(id: number, updates: { productVariantId?: number; variantQty?: number }): Promise<InventoryLevel | null> {
    const setValues: any = { updatedAt: new Date() };

    // Absolute updates: set values directly (not delta-based)
    if (updates.productVariantId !== undefined) {
      setValues.productVariantId = updates.productVariantId;
    }
    if (updates.variantQty !== undefined) {
      setValues.variantQty = updates.variantQty;
    }

    const result = await db
      .update(inventoryLevels)
      .set(setValues)
      .where(eq(inventoryLevels.id, id))
      .returning();
    return result[0] || null;
  }

  async getTotalOnHandByProductVariantId(productVariantId: number, pickableOnly: boolean = false): Promise<number> {
    if (pickableOnly) {
      const result = await db
        .select({ total: sql<number>`COALESCE(SUM(${inventoryLevels.variantQty}), 0)` })
        .from(inventoryLevels)
        .innerJoin(warehouseLocations, eq(inventoryLevels.warehouseLocationId, warehouseLocations.id))
        .where(and(
          eq(inventoryLevels.productVariantId, productVariantId),
          eq(warehouseLocations.isPickable, 1)
        ));
      return result[0]?.total || 0;
    } else {
      const result = await db
        .select({ total: sql<number>`COALESCE(SUM(${inventoryLevels.variantQty}), 0)` })
        .from(inventoryLevels)
        .where(eq(inventoryLevels.productVariantId, productVariantId));
      return result[0]?.total || 0;
    }
  }

  async getTotalReservedByProductVariantId(productVariantId: number): Promise<number> {
    const result = await db
      .select({ total: sql<number>`COALESCE(SUM(${inventoryLevels.reservedQty}), 0)` })
      .from(inventoryLevels)
      .where(eq(inventoryLevels.productVariantId, productVariantId));
    return result[0]?.total || 0;
  }

  // Inventory Transactions
  async createInventoryTransaction(transaction: InsertInventoryTransaction): Promise<InventoryTransaction> {
    const result = await db.insert(inventoryTransactions).values(transaction).returning();
    return result[0];
  }

  async getInventoryTransactionsByProductVariantId(productVariantId: number, limit: number = 100): Promise<InventoryTransaction[]> {
    return await db
      .select()
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.productVariantId, productVariantId))
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

  // Bin-to-Bin Transfers
  async executeTransfer(params: {
    fromLocationId: number;
    toLocationId: number;
    productVariantId: number;
    quantity: number;
    userId: string;
    notes?: string;
  }): Promise<InventoryTransaction> {
    const { fromLocationId, toLocationId, productVariantId, quantity, userId, notes } = params;

    // Get source inventory level
    const sourceLevel = await db
      .select()
      .from(inventoryLevels)
      .where(and(
        eq(inventoryLevels.warehouseLocationId, fromLocationId),
        eq(inventoryLevels.productVariantId, productVariantId)
      ))
      .limit(1);

    if (!sourceLevel.length || sourceLevel[0].variantQty < quantity) {
      throw new Error(`Insufficient inventory at source location. Available: ${sourceLevel[0]?.variantQty || 0}`);
    }

    // Get variant info for base unit calculation
    const variant = await db.select().from(productVariants).where(eq(productVariants.id, productVariantId)).limit(1);
    if (!variant.length) {
      throw new Error("Variant not found");
    }
    const unitsPerVariant = variant[0].unitsPerVariant;

    // Decrease source location
    await db
      .update(inventoryLevels)
      .set({
        variantQty: sql`${inventoryLevels.variantQty} - ${quantity}`,
        updatedAt: new Date()
      })
      .where(eq(inventoryLevels.id, sourceLevel[0].id));

    // Increase or create destination inventory level
    const destLevel = await db
      .select()
      .from(inventoryLevels)
      .where(and(
        eq(inventoryLevels.warehouseLocationId, toLocationId),
        eq(inventoryLevels.productVariantId, productVariantId)
      ))
      .limit(1);

    if (destLevel.length) {
      await db
        .update(inventoryLevels)
        .set({
          variantQty: sql`${inventoryLevels.variantQty} + ${quantity}`,
          updatedAt: new Date()
        })
        .where(eq(inventoryLevels.id, destLevel[0].id));
    } else {
      await db.insert(inventoryLevels).values({
        warehouseLocationId: toLocationId,
        productVariantId: productVariantId,
        variantQty: quantity,
        reservedQty: 0,
        pickedQty: 0,
        packedQty: 0,
        backorderQty: 0
      });
    }

    // Create audit transaction
    const batchId = `TRANSFER-${Date.now()}`;
    const transaction = await db.insert(inventoryTransactions).values({
      productVariantId,
      fromLocationId,
      toLocationId,
      transactionType: "transfer",
      variantQtyDelta: quantity,
      variantQtyBefore: sourceLevel[0].variantQty,
      variantQtyAfter: sourceLevel[0].variantQty - quantity,
      batchId,
      sourceState: "on_hand",
      targetState: "on_hand",
      notes: notes || `Transfer by ${userId}`,
      userId
    }).returning();

    return transaction[0];
  }

  async getTransferHistory(limit: number = 50): Promise<{
    id: number;
    fromLocation: string;
    toLocation: string;
    sku: string;
    productName: string;
    quantity: number;
    userId: string;
    createdAt: Date;
    canUndo: boolean;
  }[]> {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    const results = await db
      .select({
        id: inventoryTransactions.id,
        fromLocationId: inventoryTransactions.fromLocationId,
        toLocationId: inventoryTransactions.toLocationId,
        productVariantId: inventoryTransactions.productVariantId,
        quantity: inventoryTransactions.variantQtyDelta,
        userId: inventoryTransactions.userId,
        createdAt: inventoryTransactions.createdAt,
        batchId: inventoryTransactions.batchId
      })
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.transactionType, "transfer"))
      .orderBy(desc(inventoryTransactions.createdAt))
      .limit(limit);

    // Enrich with location codes and SKU info
    const enriched = await Promise.all(results.map(async (row) => {
      const fromLoc = row.fromLocationId
        ? await db.select().from(warehouseLocations).where(eq(warehouseLocations.id, row.fromLocationId)).limit(1)
        : [];
      const toLoc = row.toLocationId
        ? await db.select().from(warehouseLocations).where(eq(warehouseLocations.id, row.toLocationId)).limit(1)
        : [];
      const variant = row.productVariantId
        ? await db.select().from(productVariants).where(eq(productVariants.id, row.productVariantId)).limit(1)
        : [];
      
      // Check if already reversed
      const reverseExists = await db
        .select()
        .from(inventoryTransactions)
        .where(and(
          eq(inventoryTransactions.transactionType, "transfer"),
          eq(inventoryTransactions.notes, `Undo of transfer ${row.id}`)
        ))
        .limit(1);
      
      return {
        id: row.id,
        fromLocation: fromLoc[0]?.code || "Unknown",
        toLocation: toLoc[0]?.code || "Unknown",
        sku: variant[0]?.sku || "Unknown",
        productName: variant[0]?.name || "Unknown",
        quantity: row.quantity || 0,
        userId: row.userId || "system",
        createdAt: row.createdAt,
        canUndo: row.createdAt > fiveMinutesAgo && reverseExists.length === 0
      };
    }));
    
    return enriched;
  }

  async undoTransfer(transactionId: number, userId: string): Promise<InventoryTransaction> {
    // Get original transaction
    const original = await db
      .select()
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.id, transactionId))
      .limit(1);
    
    if (!original.length) {
      throw new Error("Transaction not found");
    }
    
    const txn = original[0];
    if (txn.transactionType !== "transfer") {
      throw new Error("Can only undo transfer transactions");
    }
    
    // Check if already undone
    const alreadyUndone = await db
      .select()
      .from(inventoryTransactions)
      .where(and(
        eq(inventoryTransactions.transactionType, "transfer"),
        eq(inventoryTransactions.notes, `Undo of transfer ${transactionId}`)
      ))
      .limit(1);
    
    if (alreadyUndone.length) {
      throw new Error("This transfer has already been undone");
    }
    
    // Execute reverse transfer
    return await this.executeTransfer({
      fromLocationId: txn.toLocationId!,
      toLocationId: txn.fromLocationId!,
      productVariantId: txn.productVariantId!,
      quantity: txn.variantQtyDelta || 0,
      userId,
      notes: `Undo of transfer ${transactionId}`
    });
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
  async getChannelFeedsByProductVariantId(productVariantId: number): Promise<ChannelFeed[]> {
    return await db
      .select()
      .from(channelFeeds)
      .where(eq(channelFeeds.productVariantId, productVariantId));
  }

  async getChannelFeedByVariantAndChannel(productVariantId: number, channelType: string): Promise<ChannelFeed | undefined> {
    const result = await db
      .select()
      .from(channelFeeds)
      .where(and(
        eq(channelFeeds.productVariantId, productVariantId),
        eq(channelFeeds.channelType, channelType)
      ));
    return result[0];
  }

  async upsertChannelFeed(feed: InsertChannelFeed): Promise<ChannelFeed> {
    const existing = await this.getChannelFeedByVariantAndChannel(feed.productVariantId, feed.channelType || "shopify");
    
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

  async getChannelFeedsByChannel(channelType: string): Promise<(ChannelFeed & { variant: ProductVariant })[]> {
    const result = await db
      .select({
        id: channelFeeds.id,
        productVariantId: channelFeeds.productVariantId,
        channelType: channelFeeds.channelType,
        channelVariantId: channelFeeds.channelVariantId,
        channelProductId: channelFeeds.channelProductId,
        channelSku: channelFeeds.channelSku,
        isActive: channelFeeds.isActive,
        lastSyncedAt: channelFeeds.lastSyncedAt,
        lastSyncedQty: channelFeeds.lastSyncedQty,
        createdAt: channelFeeds.createdAt,
        updatedAt: channelFeeds.updatedAt,
        variant: productVariants
      })
      .from(channelFeeds)
      .innerJoin(productVariants, eq(channelFeeds.productVariantId, productVariants.id))
      .where(eq(channelFeeds.channelType, channelType));
    return result as (ChannelFeed & { variant: ProductVariant })[];
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
    // Use SQL aggregation to compute metrics without loading all records
    
    // 1. Completed orders count
    const ordersResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(
        eq(orders.warehouseStatus, 'completed'),
        gte(orders.completedAt, startDate),
        lte(orders.completedAt, endDate)
      ));
    const totalOrdersCompleted = ordersResult[0]?.count || 0;

    // 2. Exception orders count  
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

    // 3. Picking logs aggregation - all in one query
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

    // 4. Average claim-to-complete time using SQL
    const timingResult = await db.execute(sql`
      SELECT 
        AVG(EXTRACT(EPOCH FROM (c.timestamp - cl.timestamp))) as avg_claim_to_complete,
        AVG(EXTRACT(EPOCH FROM (cl.timestamp - o.created_at))) as avg_queue_wait
      FROM orders o
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

    // 5. Picker performance - grouped by picker
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

    // 6. Hourly trend - last 24 hours
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

    // 7. Short reasons breakdown
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
    channel?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<(Order & { items: OrderItem[]; pickerName?: string })[]> {
    const conditions = [];
    
    // Default to completed/shipped/cancelled orders (historical)
    const defaultStatuses = ['completed', 'shipped', 'cancelled', 'exception'];
    const statuses = filters.status && filters.status.length > 0 ? filters.status : defaultStatuses;
    conditions.push(inArray(orders.warehouseStatus, statuses as any));
    
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
    channel?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<number> {
    const conditions = [];
    
    const defaultStatuses = ['completed', 'shipped', 'cancelled', 'exception'];
    const statuses = filters.status && filters.status.length > 0 ? filters.status : defaultStatuses;
    conditions.push(inArray(orders.warehouseStatus, statuses as any));
    
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
  async getChannelReservations(channelId?: number): Promise<(ChannelReservation & { channel?: Channel; productVariant?: ProductVariant })[]> {
    let query = db.select({
      reservation: channelReservations,
      channel: channels,
      productVariant: productVariants
    })
    .from(channelReservations)
    .leftJoin(channels, eq(channelReservations.channelId, channels.id))
    .leftJoin(productVariants, eq(channelReservations.productVariantId, productVariants.id));

    if (channelId) {
      query = query.where(eq(channelReservations.channelId, channelId)) as any;
    }

    const results = await query.orderBy(asc(channels.name));
    return results.map(r => ({
      ...r.reservation,
      channel: r.channel || undefined,
      productVariant: r.productVariant || undefined
    }));
  }

  async getChannelReservationByChannelAndProductVariant(channelId: number, productVariantId: number): Promise<ChannelReservation | undefined> {
    const result = await db.select().from(channelReservations)
      .where(and(
        eq(channelReservations.channelId, channelId),
        eq(channelReservations.productVariantId, productVariantId)
      ));
    return result[0];
  }

  async upsertChannelReservation(reservation: InsertChannelReservation): Promise<ChannelReservation> {
    const existing = await this.getChannelReservationByChannelAndProductVariant(reservation.channelId, reservation.productVariantId!);
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
  
  // Echelon Settings
  async getAllSettings(): Promise<Record<string, string | null>> {
    const settings = await db.select().from(echelonSettings);
    const result: Record<string, string | null> = {};
    for (const setting of settings) {
      result[setting.key] = setting.value;
    }
    return result;
  }
  
  async getSetting(key: string): Promise<string | null> {
    try {
      const result = await db.select().from(echelonSettings).where(eq(echelonSettings.key, key)).limit(1);
      return result[0]?.value ?? null;
    } catch (error) {
      console.warn(`getSetting failed for key "${key}" - echelon_settings table may not exist yet`);
      return null;
    }
  }
  
  async upsertSetting(key: string, value: string | null, category?: string): Promise<EchelonSetting | null> {
    try {
      const existing = await db.select().from(echelonSettings).where(eq(echelonSettings.key, key)).limit(1);
      
      if (existing.length > 0) {
        const updated = await db.update(echelonSettings)
          .set({ value, updatedAt: new Date() })
          .where(eq(echelonSettings.key, key))
          .returning();
        return updated[0];
      }
      
      const inserted = await db.insert(echelonSettings).values({
        key,
        value,
        type: "string",
        category: category || (
          key.startsWith("company_") ? "company" : 
          key.startsWith("low_stock") || key.startsWith("critical_stock") ? "inventory" :
          key.startsWith("picking") || key.startsWith("auto_release") ? "picking" : "general"
        ),
      }).returning();
      return inserted[0];
    } catch (error) {
      console.warn(`upsertSetting failed for key "${key}" - echelon_settings table may not exist yet`);
      return null;
    }
  }
  
  // ============================================
  // CYCLE COUNTS (Inventory Reconciliation)
  // ============================================
  
  async getAllCycleCounts(): Promise<CycleCount[]> {
    return await db.select().from(cycleCounts).orderBy(desc(cycleCounts.createdAt));
  }
  
  async getCycleCountById(id: number): Promise<CycleCount | undefined> {
    const result = await db.select().from(cycleCounts).where(eq(cycleCounts.id, id)).limit(1);
    return result[0];
  }
  
  async createCycleCount(data: InsertCycleCount): Promise<CycleCount> {
    const result = await db.insert(cycleCounts).values(data).returning();
    return result[0];
  }
  
  async updateCycleCount(id: number, updates: Partial<InsertCycleCount>): Promise<CycleCount | null> {
    const result = await db.update(cycleCounts)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(cycleCounts.id, id))
      .returning();
    return result[0] || null;
  }
  
  async deleteCycleCount(id: number): Promise<boolean> {
    const result = await db.delete(cycleCounts).where(eq(cycleCounts.id, id));
    return (result.rowCount ?? 0) > 0;
  }
  
  // Cycle Count Items
  async getCycleCountItems(cycleCountId: number): Promise<CycleCountItem[]> {
    return await db.select().from(cycleCountItems).where(eq(cycleCountItems.cycleCountId, cycleCountId));
  }
  
  async getCycleCountItemById(id: number): Promise<CycleCountItem | undefined> {
    const result = await db.select().from(cycleCountItems).where(eq(cycleCountItems.id, id)).limit(1);
    return result[0];
  }
  
  async createCycleCountItem(data: InsertCycleCountItem): Promise<CycleCountItem> {
    const result = await db.insert(cycleCountItems).values(data).returning();
    return result[0];
  }
  
  async updateCycleCountItem(id: number, updates: Partial<InsertCycleCountItem>): Promise<CycleCountItem | null> {
    const result = await db.update(cycleCountItems)
      .set(updates)
      .where(eq(cycleCountItems.id, id))
      .returning();
    return result[0] || null;
  }
  
  async deleteCycleCountItem(id: number): Promise<boolean> {
    const result = await db.delete(cycleCountItems).where(eq(cycleCountItems.id, id));
    return (result.rowCount ?? 0) > 0;
  }
  
  async bulkCreateCycleCountItems(items: InsertCycleCountItem[]): Promise<CycleCountItem[]> {
    if (items.length === 0) return [];
    return await db.insert(cycleCountItems).values(items).returning();
  }
  
  // ===== VENDORS =====
  async getAllVendors(): Promise<Vendor[]> {
    return await db.select().from(vendors).orderBy(asc(vendors.name));
  }
  
  async getVendorById(id: number): Promise<Vendor | undefined> {
    const result = await db.select().from(vendors).where(eq(vendors.id, id)).limit(1);
    return result[0];
  }
  
  async getVendorByCode(code: string): Promise<Vendor | undefined> {
    const result = await db.select().from(vendors).where(eq(vendors.code, code.toUpperCase())).limit(1);
    return result[0];
  }
  
  async createVendor(data: InsertVendor): Promise<Vendor> {
    const result = await db.insert(vendors).values({
      ...data,
      code: data.code.toUpperCase(),
    }).returning();
    return result[0];
  }
  
  async updateVendor(id: number, updates: Partial<InsertVendor>): Promise<Vendor | null> {
    const updateData: any = { ...updates, updatedAt: new Date() };
    if (updates.code) updateData.code = updates.code.toUpperCase();
    const result = await db.update(vendors)
      .set(updateData)
      .where(eq(vendors.id, id))
      .returning();
    return result[0] || null;
  }
  
  async deleteVendor(id: number): Promise<boolean> {
    const result = await db.delete(vendors).where(eq(vendors.id, id));
    return (result.rowCount ?? 0) > 0;
  }
  
  // ===== RECEIVING ORDERS =====
  async getAllReceivingOrders(): Promise<ReceivingOrder[]> {
    return await db.select().from(receivingOrders).orderBy(desc(receivingOrders.createdAt));
  }
  
  async getReceivingOrderById(id: number): Promise<ReceivingOrder | undefined> {
    const result = await db.select().from(receivingOrders).where(eq(receivingOrders.id, id)).limit(1);
    return result[0];
  }
  
  async getReceivingOrderByReceiptNumber(receiptNumber: string): Promise<ReceivingOrder | undefined> {
    const result = await db.select().from(receivingOrders).where(eq(receivingOrders.receiptNumber, receiptNumber)).limit(1);
    return result[0];
  }
  
  async getReceivingOrdersByStatus(status: string): Promise<ReceivingOrder[]> {
    return await db.select().from(receivingOrders)
      .where(eq(receivingOrders.status, status))
      .orderBy(desc(receivingOrders.createdAt));
  }
  
  async createReceivingOrder(data: InsertReceivingOrder): Promise<ReceivingOrder> {
    const result = await db.insert(receivingOrders).values(data).returning();
    return result[0];
  }
  
  async updateReceivingOrder(id: number, updates: Partial<InsertReceivingOrder>): Promise<ReceivingOrder | null> {
    const result = await db.update(receivingOrders)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(receivingOrders.id, id))
      .returning();
    return result[0] || null;
  }
  
  async deleteReceivingOrder(id: number): Promise<boolean> {
    const result = await db.delete(receivingOrders).where(eq(receivingOrders.id, id));
    return (result.rowCount ?? 0) > 0;
  }
  
  async generateReceiptNumber(): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `RCV-${dateStr}-`;
    
    // Find highest existing receipt number for today
    const existing = await db.select({ receiptNumber: receivingOrders.receiptNumber })
      .from(receivingOrders)
      .where(like(receivingOrders.receiptNumber, `${prefix}%`))
      .orderBy(desc(receivingOrders.receiptNumber))
      .limit(1);
    
    let nextNum = 1;
    if (existing.length > 0 && existing[0].receiptNumber) {
      const lastNum = parseInt(existing[0].receiptNumber.replace(prefix, ''), 10);
      if (!isNaN(lastNum)) nextNum = lastNum + 1;
    }
    
    return `${prefix}${String(nextNum).padStart(3, '0')}`;
  }
  
  // ===== RECEIVING LINES =====
  async getReceivingLines(receivingOrderId: number): Promise<ReceivingLine[]> {
    return await db.select().from(receivingLines)
      .where(eq(receivingLines.receivingOrderId, receivingOrderId))
      .orderBy(asc(receivingLines.id));
  }
  
  async getReceivingLineById(id: number): Promise<ReceivingLine | undefined> {
    const result = await db.select().from(receivingLines).where(eq(receivingLines.id, id)).limit(1);
    return result[0];
  }
  
  async createReceivingLine(data: InsertReceivingLine): Promise<ReceivingLine> {
    const result = await db.insert(receivingLines).values(data).returning();
    return result[0];
  }
  
  async updateReceivingLine(id: number, updates: Partial<InsertReceivingLine>): Promise<ReceivingLine | null> {
    const result = await db.update(receivingLines)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(receivingLines.id, id))
      .returning();
    return result[0] || null;
  }
  
  async deleteReceivingLine(id: number): Promise<boolean> {
    const result = await db.delete(receivingLines).where(eq(receivingLines.id, id));
    return (result.rowCount ?? 0) > 0;
  }
  
  async bulkCreateReceivingLines(lines: InsertReceivingLine[]): Promise<ReceivingLine[]> {
    if (lines.length === 0) return [];
    return await db.insert(receivingLines).values(lines).returning();
  }

  // ============================================
  // REPLENISHMENT
  // ============================================
  
  // Tier Defaults
  async getAllReplenTierDefaults(): Promise<ReplenTierDefault[]> {
    return await db.select().from(replenTierDefaults).orderBy(asc(replenTierDefaults.hierarchyLevel));
  }
  
  async getReplenTierDefaultById(id: number): Promise<ReplenTierDefault | undefined> {
    const result = await db.select().from(replenTierDefaults).where(eq(replenTierDefaults.id, id)).limit(1);
    return result[0];
  }
  
  async getReplenTierDefaultByLevel(hierarchyLevel: number): Promise<ReplenTierDefault | undefined> {
    const result = await db.select().from(replenTierDefaults)
      .where(and(
        eq(replenTierDefaults.hierarchyLevel, hierarchyLevel),
        eq(replenTierDefaults.isActive, 1)
      ))
      .limit(1);
    return result[0];
  }
  
  async getActiveReplenTierDefaults(): Promise<ReplenTierDefault[]> {
    return await db.select().from(replenTierDefaults)
      .where(eq(replenTierDefaults.isActive, 1))
      .orderBy(asc(replenTierDefaults.hierarchyLevel));
  }
  
  async createReplenTierDefault(data: InsertReplenTierDefault): Promise<ReplenTierDefault> {
    const result = await db.insert(replenTierDefaults).values(data).returning();
    return result[0];
  }
  
  async updateReplenTierDefault(id: number, updates: Partial<InsertReplenTierDefault>): Promise<ReplenTierDefault | null> {
    const result = await db.update(replenTierDefaults)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(replenTierDefaults.id, id))
      .returning();
    return result[0] || null;
  }
  
  async deleteReplenTierDefault(id: number): Promise<boolean> {
    const result = await db.delete(replenTierDefaults).where(eq(replenTierDefaults.id, id));
    return (result.rowCount ?? 0) > 0;
  }
  
  // SKU Overrides
  async getAllReplenRules(): Promise<ReplenRule[]> {
    return await db.select().from(replenRules).orderBy(asc(replenRules.priority));
  }
  
  async getReplenRuleById(id: number): Promise<ReplenRule | undefined> {
    const result = await db.select().from(replenRules).where(eq(replenRules.id, id)).limit(1);
    return result[0];
  }
  
  async getReplenRulesForVariant(pickProductVariantId: number): Promise<ReplenRule[]> {
    return await db.select().from(replenRules)
      .where(and(
        eq(replenRules.pickProductVariantId, pickProductVariantId),
        eq(replenRules.isActive, 1)
      ))
      .orderBy(asc(replenRules.priority));
  }
  
  async getReplenRulesForProduct(catalogProductId: number): Promise<ReplenRule[]> {
    return await db.select().from(replenRules)
      .where(and(
        eq(replenRules.catalogProductId, catalogProductId),
        eq(replenRules.isActive, 1)
      ))
      .orderBy(asc(replenRules.priority));
  }
  
  async createReplenRule(data: InsertReplenRule): Promise<ReplenRule> {
    const result = await db.insert(replenRules).values(data).returning();
    return result[0];
  }
  
  async updateReplenRule(id: number, updates: Partial<InsertReplenRule>): Promise<ReplenRule | null> {
    const result = await db.update(replenRules)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(replenRules.id, id))
      .returning();
    return result[0] || null;
  }
  
  async deleteReplenRule(id: number): Promise<boolean> {
    const result = await db.delete(replenRules).where(eq(replenRules.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // Location Replen Config
  async getLocationReplenConfigs(warehouseLocationId?: number): Promise<LocationReplenConfig[]> {
    if (warehouseLocationId !== undefined) {
      return await db.select().from(locationReplenConfig)
        .where(eq(locationReplenConfig.warehouseLocationId, warehouseLocationId))
        .orderBy(asc(locationReplenConfig.id));
    }
    return await db.select().from(locationReplenConfig).orderBy(asc(locationReplenConfig.id));
  }

  async getLocationReplenConfig(warehouseLocationId: number, productVariantId: number | null): Promise<LocationReplenConfig | undefined> {
    const conditions = [eq(locationReplenConfig.warehouseLocationId, warehouseLocationId)];
    if (productVariantId !== null) {
      conditions.push(eq(locationReplenConfig.productVariantId, productVariantId));
    } else {
      conditions.push(isNull(locationReplenConfig.productVariantId));
    }
    const result = await db.select().from(locationReplenConfig)
      .where(and(...conditions))
      .limit(1);
    return result[0];
  }

  async getLocationReplenConfigById(id: number): Promise<LocationReplenConfig | undefined> {
    const result = await db.select().from(locationReplenConfig)
      .where(eq(locationReplenConfig.id, id)).limit(1);
    return result[0];
  }

  async createLocationReplenConfig(data: InsertLocationReplenConfig): Promise<LocationReplenConfig> {
    const result = await db.insert(locationReplenConfig).values(data).returning();
    return result[0];
  }

  async updateLocationReplenConfig(id: number, updates: Partial<InsertLocationReplenConfig>): Promise<LocationReplenConfig | null> {
    const result = await db.update(locationReplenConfig)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(locationReplenConfig.id, id))
      .returning();
    return result[0] || null;
  }

  async deleteLocationReplenConfig(id: number): Promise<boolean> {
    const result = await db.delete(locationReplenConfig).where(eq(locationReplenConfig.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // Replen Tasks
  async getAllReplenTasks(filters?: { status?: string; assignedTo?: string }): Promise<ReplenTask[]> {
    let query = db.select().from(replenTasks);
    
    const conditions = [];
    if (filters?.status) {
      conditions.push(eq(replenTasks.status, filters.status));
    }
    if (filters?.assignedTo) {
      conditions.push(eq(replenTasks.assignedTo, filters.assignedTo));
    }
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }
    
    return await query.orderBy(asc(replenTasks.priority), desc(replenTasks.createdAt));
  }
  
  async getReplenTaskById(id: number): Promise<ReplenTask | undefined> {
    const result = await db.select().from(replenTasks).where(eq(replenTasks.id, id)).limit(1);
    return result[0];
  }
  
  async createReplenTask(data: InsertReplenTask): Promise<ReplenTask> {
    const result = await db.insert(replenTasks).values(data).returning();
    return result[0];
  }
  
  async updateReplenTask(id: number, updates: Partial<InsertReplenTask>): Promise<ReplenTask | null> {
    const result = await db.update(replenTasks)
      .set(updates)
      .where(eq(replenTasks.id, id))
      .returning();
    return result[0] || null;
  }
  
  async deleteReplenTask(id: number): Promise<boolean> {
    const result = await db.delete(replenTasks).where(eq(replenTasks.id, id));
    return (result.rowCount ?? 0) > 0;
  }
  
  async getPendingReplenTasksForLocation(toLocationId: number): Promise<ReplenTask[]> {
    return await db.select().from(replenTasks)
      .where(and(
        eq(replenTasks.toLocationId, toLocationId),
        or(
          eq(replenTasks.status, "pending"),
          eq(replenTasks.status, "assigned"),
          eq(replenTasks.status, "in_progress")
        )
      ));
  }
  
  async getActiveReplenRules(): Promise<ReplenRule[]> {
    return await db.select().from(replenRules)
      .where(eq(replenRules.isActive, 1))
      .orderBy(asc(replenRules.priority));
  }
  
  // Warehouse Settings
  async getAllWarehouseSettings(): Promise<WarehouseSettings[]> {
    return await db.select().from(warehouseSettings).orderBy(asc(warehouseSettings.warehouseCode));
  }
  
  async getWarehouseSettingsByCode(code: string): Promise<WarehouseSettings | undefined> {
    const result = await db.select().from(warehouseSettings)
      .where(eq(warehouseSettings.warehouseCode, code)).limit(1);
    return result[0];
  }
  
  async getWarehouseSettingsById(id: number): Promise<WarehouseSettings | undefined> {
    const result = await db.select().from(warehouseSettings)
      .where(eq(warehouseSettings.id, id)).limit(1);
    return result[0];
  }
  
  async getDefaultWarehouseSettings(): Promise<WarehouseSettings | undefined> {
    const result = await db.select().from(warehouseSettings)
      .where(eq(warehouseSettings.warehouseCode, "DEFAULT")).limit(1);
    return result[0];
  }
  
  async createWarehouseSettings(data: InsertWarehouseSettings): Promise<WarehouseSettings> {
    const result = await db.insert(warehouseSettings).values(data).returning();
    return result[0];
  }
  
  async updateWarehouseSettings(id: number, updates: Partial<InsertWarehouseSettings>): Promise<WarehouseSettings | null> {
    const result = await db.update(warehouseSettings)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(warehouseSettings.id, id))
      .returning();
    return result[0] || null;
  }
  
  async deleteWarehouseSettings(id: number): Promise<boolean> {
    const result = await db.delete(warehouseSettings).where(eq(warehouseSettings.id, id)).returning();
    return result.length > 0;
  }
}

export const storage = new DatabaseStorage();
