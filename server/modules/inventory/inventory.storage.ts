import {
  db, eq, and, or, sql, desc, asc, gte, lte, like,
  type InventoryLevel, type InsertInventoryLevel,
  type InventoryTransaction, type InsertInventoryTransaction,
  type AdjustmentReason, type InsertAdjustmentReason,
  type ChannelFeed, type InsertChannelFeed,
  type ProductVariant,
  inventoryLevels, inventoryTransactions, adjustmentReasons,
  channelFeeds, productVariants, warehouseLocations, productLocations,
} from "../../storage/base";

export interface IInventoryStorage {
  getAllInventoryLevels(): Promise<InventoryLevel[]>;
  getInventoryLevelsByProductVariantId(productVariantId: number): Promise<InventoryLevel[]>;
  getInventoryLevelByLocationAndVariant(warehouseLocationId: number, productVariantId: number): Promise<InventoryLevel | undefined>;
  createInventoryLevel(level: InsertInventoryLevel): Promise<InventoryLevel>;
  upsertInventoryLevel(level: InsertInventoryLevel): Promise<InventoryLevel>;
  adjustInventoryLevel(id: number, adjustments: { variantQty?: number; reservedQty?: number; pickedQty?: number; backorderQty?: number }): Promise<InventoryLevel | null>;
  updateInventoryLevel(id: number, updates: { productVariantId?: number; variantQty?: number }): Promise<InventoryLevel | null>;
  getTotalOnHandByProductVariantId(productVariantId: number, pickableOnly?: boolean): Promise<number>;
  getTotalReservedByProductVariantId(productVariantId: number): Promise<number>;

  createInventoryTransaction(transaction: InsertInventoryTransaction): Promise<InventoryTransaction>;
  getInventoryTransactionsByProductVariantId(productVariantId: number, limit?: number): Promise<InventoryTransaction[]>;
  getInventoryTransactions(filters: {
    batchId?: string;
    transactionType?: string;
    startDate?: Date;
    endDate?: Date;
    locationId?: number;
    limit?: number;
    offset?: number;
  }): Promise<InventoryTransaction[]>;

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

  getAllAdjustmentReasons(): Promise<AdjustmentReason[]>;
  getActiveAdjustmentReasons(): Promise<AdjustmentReason[]>;
  getAdjustmentReasonByCode(code: string): Promise<AdjustmentReason | undefined>;
  getAdjustmentReasonById(id: number): Promise<AdjustmentReason | undefined>;
  createAdjustmentReason(reason: InsertAdjustmentReason): Promise<AdjustmentReason>;
  updateAdjustmentReason(id: number, updates: Partial<InsertAdjustmentReason>): Promise<AdjustmentReason | null>;

  getChannelFeedsByProductVariantId(productVariantId: number): Promise<ChannelFeed[]>;
  getChannelFeedByVariantAndChannel(productVariantId: number, channelType: string): Promise<ChannelFeed | undefined>;
  upsertChannelFeed(feed: InsertChannelFeed): Promise<ChannelFeed>;
  updateChannelFeedSyncStatus(id: number, qty: number): Promise<ChannelFeed | null>;
  getChannelFeedsByChannel(channelType: string): Promise<(ChannelFeed & { variant: ProductVariant })[]>;

  hasInventoryAtLocation(warehouseLocationId: number): Promise<boolean>;

  getInventoryLevelById(id: number): Promise<InventoryLevel | undefined>;
  deleteInventoryLevel(id: number): Promise<void>;
  hasProductLocationAssignment(productVariantId: number, warehouseLocationId: number): Promise<boolean>;
  getAssignedLocationIdsForVariant(productVariantId: number): Promise<number[]>;

  searchSkusByLocation(locationId: number, limit: number): Promise<Record<string, unknown>[]>;
  searchSkusByPattern(searchPattern: string, limit: number): Promise<Record<string, unknown>[]>;
  searchSkuLocations(searchPattern: string): Promise<Record<string, unknown>[]>;
  getSourceInventoryForConversion(variantId: number, locationId?: number): Promise<Record<string, unknown>[]>;

  getInventoryLevelsSummary(warehouseId?: number | null): Promise<Record<string, unknown>[]>;
  getInventoryByBin(warehouseId?: number | null, search?: string): Promise<Record<string, unknown>[]>;
  getVariantLocationBreakdown(variantId: number, warehouseId?: number | null): Promise<Record<string, unknown>[]>;
  getInventoryExport(): Promise<Record<string, unknown>[]>;

  getSyncHealthStats(): Promise<Record<string, unknown>>;
  getDebugOrderDates(orderNumber: string): Promise<Record<string, unknown> | null>;
  getDebugSyncStatus(): Promise<{ missingCount: number; sampleOrders: Record<string, unknown>[] }>;
}

export const inventoryMethods: IInventoryStorage = {
  async getAllInventoryLevels(): Promise<InventoryLevel[]> {
    return await db.select().from(inventoryLevels);
  },

  async getInventoryLevelsByProductVariantId(productVariantId: number): Promise<InventoryLevel[]> {
    return await db
      .select()
      .from(inventoryLevels)
      .where(eq(inventoryLevels.productVariantId, productVariantId));
  },

  async getInventoryLevelByLocationAndVariant(warehouseLocationId: number, productVariantId: number): Promise<InventoryLevel | undefined> {
    const result = await db
      .select()
      .from(inventoryLevels)
      .where(and(
        eq(inventoryLevels.warehouseLocationId, warehouseLocationId),
        eq(inventoryLevels.productVariantId, productVariantId)
      ));
    return result[0];
  },

  async createInventoryLevel(level: InsertInventoryLevel): Promise<InventoryLevel> {
    const result = await db.insert(inventoryLevels).values(level).returning();
    return result[0];
  },

  async upsertInventoryLevel(level: InsertInventoryLevel): Promise<InventoryLevel> {
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
  },

  async adjustInventoryLevel(id: number, adjustments: { variantQty?: number; reservedQty?: number; pickedQty?: number; backorderQty?: number }): Promise<InventoryLevel | null> {
    const updates: any = { updatedAt: new Date() };

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
  },

  async updateInventoryLevel(id: number, updates: { productVariantId?: number; variantQty?: number }): Promise<InventoryLevel | null> {
    const setValues: any = { updatedAt: new Date() };

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
  },

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
  },

  async getTotalReservedByProductVariantId(productVariantId: number): Promise<number> {
    const result = await db
      .select({ total: sql<number>`COALESCE(SUM(${inventoryLevels.reservedQty}), 0)` })
      .from(inventoryLevels)
      .where(eq(inventoryLevels.productVariantId, productVariantId));
    return result[0]?.total || 0;
  },

  async createInventoryTransaction(transaction: InsertInventoryTransaction): Promise<InventoryTransaction> {
    const result = await db.insert(inventoryTransactions).values(transaction).returning();
    return result[0];
  },

  async getInventoryTransactionsByProductVariantId(productVariantId: number, limit: number = 100): Promise<InventoryTransaction[]> {
    return await db
      .select()
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.productVariantId, productVariantId))
      .orderBy(desc(inventoryTransactions.createdAt))
      .limit(limit);
  },

  async getInventoryTransactions(filters: {
    batchId?: string;
    transactionType?: string;
    startDate?: Date;
    endDate?: Date;
    locationId?: number;
    limit?: number;
    offset?: number;
  }): Promise<InventoryTransaction[]> {
    const conditions = [];
    if (filters.batchId) conditions.push(eq(inventoryTransactions.batchId, filters.batchId));
    if (filters.transactionType) conditions.push(eq(inventoryTransactions.transactionType, filters.transactionType));
    if (filters.startDate) conditions.push(gte(inventoryTransactions.createdAt, filters.startDate));
    if (filters.endDate) conditions.push(lte(inventoryTransactions.createdAt, filters.endDate));
    if (filters.locationId) {
      conditions.push(or(
        eq(inventoryTransactions.fromLocationId, filters.locationId),
        eq(inventoryTransactions.toLocationId, filters.locationId),
      )!);
    }

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
  },

  async executeTransfer(params: {
    fromLocationId: number;
    toLocationId: number;
    productVariantId: number;
    quantity: number;
    userId: string;
    notes?: string;
  }): Promise<InventoryTransaction> {
    const { fromLocationId, toLocationId, productVariantId, quantity, userId, notes } = params;

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

    const variant = await db.select().from(productVariants).where(eq(productVariants.id, productVariantId)).limit(1);
    if (!variant.length) {
      throw new Error("Variant not found");
    }

    await db
      .update(inventoryLevels)
      .set({
        variantQty: sql`${inventoryLevels.variantQty} - ${quantity}`,
        updatedAt: new Date()
      })
      .where(eq(inventoryLevels.id, sourceLevel[0].id));

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
  },

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
  },

  async undoTransfer(transactionId: number, userId: string): Promise<InventoryTransaction> {
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
    
    return await (this as any).executeTransfer({
      fromLocationId: txn.toLocationId!,
      toLocationId: txn.fromLocationId!,
      productVariantId: txn.productVariantId!,
      quantity: txn.variantQtyDelta || 0,
      userId,
      notes: `Undo of transfer ${transactionId}`
    });
  },

  async getAllAdjustmentReasons(): Promise<AdjustmentReason[]> {
    return await db.select().from(adjustmentReasons).orderBy(asc(adjustmentReasons.sortOrder));
  },

  async getActiveAdjustmentReasons(): Promise<AdjustmentReason[]> {
    return await db
      .select()
      .from(adjustmentReasons)
      .where(eq(adjustmentReasons.isActive, 1))
      .orderBy(asc(adjustmentReasons.sortOrder));
  },

  async getAdjustmentReasonByCode(code: string): Promise<AdjustmentReason | undefined> {
    const result = await db
      .select()
      .from(adjustmentReasons)
      .where(eq(adjustmentReasons.code, code.toUpperCase()));
    return result[0];
  },

  async getAdjustmentReasonById(id: number): Promise<AdjustmentReason | undefined> {
    const result = await db.select().from(adjustmentReasons).where(eq(adjustmentReasons.id, id));
    return result[0];
  },

  async createAdjustmentReason(reason: InsertAdjustmentReason): Promise<AdjustmentReason> {
    const result = await db.insert(adjustmentReasons).values({
      ...reason,
      code: reason.code.toUpperCase(),
    }).returning();
    return result[0];
  },

  async updateAdjustmentReason(id: number, updates: Partial<InsertAdjustmentReason>): Promise<AdjustmentReason | null> {
    const result = await db
      .update(adjustmentReasons)
      .set(updates)
      .where(eq(adjustmentReasons.id, id))
      .returning();
    return result[0] || null;
  },

  async getChannelFeedsByProductVariantId(productVariantId: number): Promise<ChannelFeed[]> {
    return await db
      .select()
      .from(channelFeeds)
      .where(eq(channelFeeds.productVariantId, productVariantId));
  },

  async getChannelFeedByVariantAndChannel(productVariantId: number, channelType: string): Promise<ChannelFeed | undefined> {
    const result = await db
      .select()
      .from(channelFeeds)
      .where(and(
        eq(channelFeeds.productVariantId, productVariantId),
        eq(channelFeeds.channelType, channelType)
      ));
    return result[0];
  },

  async upsertChannelFeed(feed: InsertChannelFeed): Promise<ChannelFeed> {
    const existing = await (this as any).getChannelFeedByVariantAndChannel(feed.productVariantId, feed.channelType || "shopify");
    
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
  },

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
  },

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
  },

  async hasInventoryAtLocation(warehouseLocationId: number): Promise<boolean> {
    const result = await db.select({ id: inventoryLevels.id })
      .from(inventoryLevels)
      .where(eq(inventoryLevels.warehouseLocationId, warehouseLocationId))
      .limit(1);
    return result.length > 0;
  },

  async getInventoryLevelById(id: number): Promise<InventoryLevel | undefined> {
    const result = await db.select().from(inventoryLevels).where(eq(inventoryLevels.id, id)).limit(1);
    return result[0];
  },

  async deleteInventoryLevel(id: number): Promise<void> {
    await db.delete(inventoryLevels).where(eq(inventoryLevels.id, id));
  },

  async hasProductLocationAssignment(productVariantId: number, warehouseLocationId: number): Promise<boolean> {
    const result = await db.select({ id: productLocations.id })
      .from(productLocations)
      .where(and(
        eq(productLocations.productVariantId, productVariantId),
        eq(productLocations.warehouseLocationId, warehouseLocationId),
      ))
      .limit(1);
    return result.length > 0;
  },

  async getAssignedLocationIdsForVariant(productVariantId: number): Promise<number[]> {
    const result = await db.select({ warehouseLocationId: productLocations.warehouseLocationId })
      .from(productLocations)
      .where(eq(productLocations.productVariantId, productVariantId));
    return result.map(a => a.warehouseLocationId);
  },

  async searchSkusByLocation(locationId: number, limit: number): Promise<Record<string, unknown>[]> {
    const result = await db.execute(sql`
      SELECT
        pv.sku as sku,
        pv.name as name,
        pv.id as "variantId",
        il.variant_qty as available,
        wl.id as "locationId",
        wl.code as location
      FROM inventory_levels il
      JOIN product_variants pv ON pv.id = il.product_variant_id
      JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
      WHERE il.warehouse_location_id = ${locationId}
        AND il.variant_qty > 0
      ORDER BY pv.sku
      LIMIT ${limit}
    `);
    return result.rows as Record<string, unknown>[];
  },

  async searchSkusByPattern(searchPattern: string, limit: number): Promise<Record<string, unknown>[]> {
    const result = await db.execute(sql`
      SELECT
        pv.sku as sku,
        pv.name as name,
        'product_variant' as source,
        pv.product_id as "productId",
        pv.id as "productVariantId",
        pv.units_per_variant as "unitsPerVariant"
      FROM product_variants pv
      WHERE pv.is_active = true
        AND pv.sku IS NOT NULL
        AND (
          LOWER(pv.sku) LIKE ${searchPattern} OR
          LOWER(pv.name) LIKE ${searchPattern}
        )
      ORDER BY pv.sku
      LIMIT ${limit}
    `);
    return result.rows as Record<string, unknown>[];
  },

  async searchSkuLocations(searchPattern: string): Promise<Record<string, unknown>[]> {
    const result = await db.execute(sql`
      SELECT
        pv.sku,
        pv.name,
        pv.id as "variantId",
        wl.code as location,
        wl.zone,
        wl.location_type as "locationType",
        il.variant_qty as available,
        il.warehouse_location_id as "locationId",
        w.code as "warehouseCode"
      FROM inventory_levels il
      JOIN product_variants pv ON pv.id = il.product_variant_id
      JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
      LEFT JOIN warehouses w ON w.id = wl.warehouse_id
      WHERE il.variant_qty > 0
        AND (
          LOWER(pv.sku) LIKE ${searchPattern} OR
          LOWER(pv.name) LIKE ${searchPattern}
        )
      ORDER BY pv.sku, wl.code
    `);
    return result.rows as Record<string, unknown>[];
  },

  async getSourceInventoryForConversion(variantId: number, locationId?: number): Promise<Record<string, unknown>[]> {
    if (locationId) {
      const result = await db.execute(sql`
        SELECT il.*, wl.code as location_code
        FROM inventory_levels il
        JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
        WHERE il.product_variant_id = ${variantId}
          AND il.warehouse_location_id = ${locationId}
          AND il.variant_qty > 0
      `);
      return result.rows as Record<string, unknown>[];
    }
    const result = await db.execute(sql`
      SELECT il.*, wl.code as location_code
      FROM inventory_levels il
      JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
      WHERE il.product_variant_id = ${variantId}
        AND il.variant_qty > 0
    `);
    return result.rows as Record<string, unknown>[];
  },

  async getInventoryLevelsSummary(warehouseId?: number | null): Promise<Record<string, unknown>[]> {
    const result = warehouseId ? await db.execute(sql`
      SELECT
        pv.id as variant_id,
        pv.sku as variant_sku,
        pv.name as variant_name,
        pv.units_per_variant,
        pv.parent_variant_id,
        pv.hierarchy_level,
        pv.is_base_unit,
        p.id as product_id,
        p.sku as base_sku,
        p.name as product_name,
        pv.barcode,
        COALESCE(SUM(il.variant_qty), 0) as total_variant_qty,
        COALESCE(SUM(il.reserved_qty), 0) as total_reserved_qty,
        COALESCE(SUM(il.picked_qty), 0) as total_picked_qty,
        COUNT(DISTINCT il.warehouse_location_id) as location_count,
        COALESCE(SUM(CASE WHEN wl.is_pickable = 1 THEN il.variant_qty ELSE 0 END), 0) as pickable_variant_qty,
        COUNT(DISTINCT pl.id) as bin_count,
        MAX(CASE WHEN rr.id IS NOT NULL AND rr.is_active = 1 THEN 1
                  WHEN rtd.id IS NOT NULL AND rtd.is_active = 1 THEN 1
                  ELSE 0 END) as has_replen_rule
      FROM product_variants pv
      LEFT JOIN products p ON pv.product_id = p.id
      INNER JOIN inventory_levels il ON il.product_variant_id = pv.id
      INNER JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id AND wl.warehouse_id = ${warehouseId}
      LEFT JOIN product_locations pl ON pl.product_variant_id = pv.id AND pl.warehouse_location_id = wl.id
      LEFT JOIN replen_rules rr ON rr.product_id = pv.product_id
      LEFT JOIN replen_tier_defaults rtd ON rtd.hierarchy_level = pv.hierarchy_level AND rtd.is_active = 1
      WHERE pv.is_active = true
      GROUP BY pv.id, pv.sku, pv.name, pv.units_per_variant, pv.parent_variant_id, pv.hierarchy_level, pv.is_base_unit, p.id, p.sku, p.name, pv.barcode
      HAVING COALESCE(SUM(il.variant_qty), 0) != 0 OR COALESCE(SUM(il.reserved_qty), 0) != 0
      ORDER BY pv.sku
    `) : await db.execute(sql`
      SELECT
        pv.id as variant_id,
        pv.sku as variant_sku,
        pv.name as variant_name,
        pv.units_per_variant,
        pv.parent_variant_id,
        pv.hierarchy_level,
        pv.is_base_unit,
        p.id as product_id,
        p.sku as base_sku,
        p.name as product_name,
        pv.barcode,
        COALESCE(SUM(il.variant_qty), 0) as total_variant_qty,
        COALESCE(SUM(il.reserved_qty), 0) as total_reserved_qty,
        COALESCE(SUM(il.picked_qty), 0) as total_picked_qty,
        COUNT(DISTINCT il.warehouse_location_id) as location_count,
        COALESCE(SUM(CASE WHEN wl.is_pickable = 1 THEN il.variant_qty ELSE 0 END), 0) as pickable_variant_qty,
        COUNT(DISTINCT pl.id) as bin_count,
        MAX(CASE WHEN rr.id IS NOT NULL AND rr.is_active = 1 THEN 1
                  WHEN rtd.id IS NOT NULL AND rtd.is_active = 1 THEN 1
                  ELSE 0 END) as has_replen_rule
      FROM product_variants pv
      LEFT JOIN products p ON pv.product_id = p.id
      LEFT JOIN inventory_levels il ON il.product_variant_id = pv.id
      LEFT JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
      LEFT JOIN product_locations pl ON pl.product_variant_id = pv.id
      LEFT JOIN replen_rules rr ON rr.product_id = pv.product_id
      LEFT JOIN replen_tier_defaults rtd ON rtd.hierarchy_level = pv.hierarchy_level AND rtd.is_active = 1
      WHERE pv.is_active = true
      GROUP BY pv.id, pv.sku, pv.name, pv.units_per_variant, pv.parent_variant_id, pv.hierarchy_level, pv.is_base_unit, p.id, p.sku, p.name, pv.barcode
      ORDER BY pv.sku
    `);
    return result.rows as Record<string, unknown>[];
  },

  async getInventoryByBin(warehouseId?: number | null, search?: string): Promise<Record<string, unknown>[]> {
    const result = await db.execute(sql`
      SELECT
        wl.id as warehouse_location_id,
        wl.code as location_code,
        wl.location_type,
        wl.zone,
        wl.is_pickable,
        wl.warehouse_id,
        w.code as warehouse_code,
        il.id as inventory_level_id,
        il.product_variant_id,
        pv.sku,
        pv.name as variant_name,
        COALESCE(p.title, p.name) as product_name,
        il.variant_qty,
        il.reserved_qty,
        il.picked_qty,
        CASE WHEN pl.id IS NOT NULL THEN 1 ELSE 0 END as is_assigned,
        (SELECT pv2.sku FROM product_locations pl2
         JOIN product_variants pv2 ON pl2.product_variant_id = pv2.id
         WHERE pl2.warehouse_location_id = wl.id LIMIT 1) as assigned_sku
      FROM inventory_levels il
      JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
      JOIN product_variants pv ON il.product_variant_id = pv.id
      LEFT JOIN products p ON pv.product_id = p.id
      LEFT JOIN product_locations pl ON pl.product_variant_id = pv.id AND pl.warehouse_location_id = wl.id
      LEFT JOIN warehouses w ON wl.warehouse_id = w.id
      WHERE (il.variant_qty != 0 OR il.reserved_qty != 0)
        ${warehouseId ? sql`AND wl.warehouse_id = ${warehouseId}` : sql``}
        ${search ? sql`AND (wl.code LIKE ${'%' + search + '%'} OR pv.sku LIKE ${'%' + search + '%'} OR pv.name LIKE ${'%' + search + '%'})` : sql``}
      ORDER BY wl.code, pv.sku
    `);
    return result.rows as Record<string, unknown>[];
  },

  async getVariantLocationBreakdown(variantId: number, warehouseId?: number | null): Promise<Record<string, unknown>[]> {
    const result = await db.execute(sql`
      SELECT
        il.id,
        il.warehouse_location_id,
        wl.code as location_code,
        wl.zone,
        il.variant_qty,
        il.reserved_qty,
        il.picked_qty
      FROM inventory_levels il
      LEFT JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
      WHERE il.product_variant_id = ${variantId}
        ${warehouseId ? sql`AND wl.warehouse_id = ${warehouseId}` : sql``}
      ORDER BY wl.code
    `);
    return result.rows as Record<string, unknown>[];
  },

  async getInventoryExport(): Promise<Record<string, unknown>[]> {
    const result = await db.execute(sql`
      SELECT
        pv.sku,
        pv.name as variant_name,
        p.sku as base_sku,
        p.name as item_name,
        wl.code as location_code,
        wl.zone,
        wl.location_type,
        wl.bin_type,
        wl.is_pickable,
        il.variant_qty,
        il.reserved_qty,
        il.picked_qty,
        (il.variant_qty - il.reserved_qty - il.picked_qty) as available_qty
      FROM inventory_levels il
      JOIN product_variants pv ON il.product_variant_id = pv.id
      LEFT JOIN products p ON pv.product_id = p.id
      LEFT JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
      WHERE il.variant_qty > 0
      ORDER BY wl.code, pv.sku
    `);
    return result.rows as Record<string, unknown>[];
  },

  async getSyncHealthStats(): Promise<Record<string, unknown>> {
    const result = await db.execute(sql`
      SELECT
        (SELECT MAX(ordered_at) FROM oms_orders) as latest_oms_order,
        (SELECT MAX(created_at) FROM orders) as latest_synced_order,
        (SELECT COUNT(*) FROM oms_orders oms
         WHERE NOT EXISTS(SELECT 1 FROM orders WHERE order_number = oms.external_order_number)
         AND oms.created_at > NOW() - INTERVAL '24 hours'
         AND oms.cancelled_at IS NULL
         AND oms.fulfillment_status IS DISTINCT FROM 'fulfilled'
        ) as unsynced_24h
    `);
    return (result.rows[0] || {}) as Record<string, unknown>;
  },

  async getDebugOrderDates(orderNumber: string): Promise<Record<string, unknown> | null> {
    const result = await db.execute(sql`
      SELECT id, order_number, order_placed_at, shopify_created_at, created_at
      FROM orders WHERE order_number LIKE ${'%' + orderNumber}
      LIMIT 1
    `);
    return (result.rows[0] as Record<string, unknown>) || null;
  },

  async getDebugSyncStatus(): Promise<{ missingCount: number; sampleOrders: Record<string, unknown>[] }> {
    const missing = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*) as count FROM oms_orders
      WHERE external_order_number NOT IN (SELECT order_number FROM orders WHERE order_number IS NOT NULL)
    `);

    const sample = await db.execute<{
      id: string;
      order_number: string | null;
      created_at: Date | null;
    }>(sql`
      SELECT id::text as id, external_order_number as order_number, created_at FROM oms_orders
      WHERE external_order_number NOT IN (SELECT order_number FROM orders WHERE order_number IS NOT NULL)
      ORDER BY created_at DESC
      LIMIT 5
    `);

    const sampleWithItems = [];
    for (const order of sample.rows) {
      const items = await db.execute<{
        id: string;
        fulfillment_status: string | null;
        fulfillable_quantity: number | null;
        quantity: number;
      }>(sql`
        SELECT id::text as id, fulfillment_status, quantity as fulfillable_quantity, quantity FROM oms_order_lines WHERE order_id = ${order.id}::bigint
      `);
      sampleWithItems.push({
        ...order,
        items: items.rows.map(i => ({
          id: i.id,
          fulfillmentStatus: i.fulfillment_status,
          fulfillableQty: i.fulfillable_quantity,
          qty: i.quantity
        }))
      });
    }

    return {
      missingCount: parseInt(missing.rows[0].count),
      sampleOrders: sampleWithItems,
    };
  },
};
