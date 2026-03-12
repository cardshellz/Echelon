import {
  db, eq, and, or, sql, desc, asc, gte, lte, like,
  type InventoryLevel, type InsertInventoryLevel,
  type InventoryTransaction, type InsertInventoryTransaction,
  type AdjustmentReason, type InsertAdjustmentReason,
  type ChannelFeed, type InsertChannelFeed,
  type ProductVariant,
  inventoryLevels, inventoryTransactions, adjustmentReasons,
  channelFeeds, productVariants, warehouseLocations,
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
};
