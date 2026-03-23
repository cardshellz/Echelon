import {
  db,
  type Channel,
  type InsertChannel,
  type ChannelConnection,
  type InsertChannelConnection,
  type PartnerProfile,
  type InsertPartnerProfile,
  type ChannelReservation,
  type InsertChannelReservation,
  type ProductVariant,
  type ChannelFeed,
  type InsertChannelFeed,
  type ChannelProductAllocation,
  type ProductLine,
  type ProductLineProduct,
  type ChannelProductLine,
  channels,
  channelConnections,
  partnerProfiles,
  channelReservations,
  channelFeeds,
  channelProductAllocation,
  channelSyncLog,
  channelProductLines,
  productVariants,
  products,
  productLines,
  productLineProducts,
  inventoryLevels,
  eq, and, asc, desc, sql, inArray, gt, or, ilike,
} from "../../storage/base";
import { count } from "drizzle-orm";

export interface IChannelStorage {
  getAllChannels(): Promise<Channel[]>;
  getChannelById(id: number): Promise<Channel | undefined>;
  createChannel(channel: InsertChannel): Promise<Channel>;
  updateChannel(id: number, updates: Partial<InsertChannel>): Promise<Channel | null>;
  deleteChannel(id: number): Promise<boolean>;
  getChannelConnection(channelId: number): Promise<ChannelConnection | undefined>;
  upsertChannelConnection(connection: InsertChannelConnection): Promise<ChannelConnection>;
  updateChannelConnectionSyncStatus(channelId: number, status: string, error?: string | null): Promise<void>;
  getPartnerProfile(channelId: number): Promise<PartnerProfile | undefined>;
  upsertPartnerProfile(profile: InsertPartnerProfile): Promise<PartnerProfile>;
  getChannelReservations(channelId?: number): Promise<(ChannelReservation & { channel?: Channel; productVariant?: ProductVariant })[]>;
  getChannelReservationByChannelAndProductVariant(channelId: number, productVariantId: number): Promise<ChannelReservation | undefined>;
  upsertChannelReservation(reservation: InsertChannelReservation): Promise<ChannelReservation>;
  deleteChannelReservation(id: number): Promise<boolean>;
  getChannelConnectionByShopDomain(shopDomain: string): Promise<{ channelId: number; webhookSecret: string | null } | undefined>;
  getChannelNameById(id: number): Promise<string | null>;

  // Channel feed queries (channelId-based, complementing inventory module's channelType-based methods)
  getChannelFeedByChannelAndVariant(channelId: number, productVariantId: number): Promise<ChannelFeed | undefined>;
  reactivateChannelFeed(feedId: number): Promise<void>;
  createChannelFeedDirect(data: InsertChannelFeed): Promise<ChannelFeed>;
  getActiveChannelFeeds(): Promise<{ feedId: number; channelId: number | null; productVariantId: number; lastSyncedQty: number | null; lastSyncedAt: Date | null }[]>;
  getChannelFeedsByVariantIds(variantIds: number[]): Promise<{ id: number; channelId: number | null; productVariantId: number; lastSyncedQty: number | null; lastSyncedAt: Date | null; isActive: number | null }[]>;

  // Product line / product gate queries
  getProductLineIdsByProduct(productId: number): Promise<number[]>;
  getActiveChannelProductLineIds(channelId: number): Promise<number[]>;

  // Channel product allocation
  getAllChannelProductAllocations(): Promise<ChannelProductAllocation[]>;
  getChannelProductAllocation(channelId: number, productId: number): Promise<ChannelProductAllocation | undefined>;
  upsertChannelProductAllocation(data: { channelId: number; productId: number; minAtpBase?: number | null; maxAtpBase?: number | null; isListed?: number; notes?: string | null }): Promise<ChannelProductAllocation>;
  deleteChannelProductAllocation(id: number): Promise<void>;
  getChannelProductAllocationsByProduct(productId: number): Promise<ChannelProductAllocation[]>;

  // Active channels
  getActiveChannels(): Promise<Channel[]>;

  // Channel reservations by variant IDs
  getChannelReservationsByVariantIds(variantIds: number[]): Promise<ChannelReservation[]>;

  // Product lines CRUD
  getProductLinesWithCounts(): Promise<(ProductLine & { productCount: number; channelCount: number })[]>;
  getProductLineById(id: number): Promise<ProductLine | undefined>;
  getProductLineAssignedProducts(lineId: number): Promise<{ productId: number; productName: string; sku: string | null }[]>;
  getProductLineAssignedChannels(lineId: number): Promise<{ channelId: number; channelName: string; provider: string | null; isActive: boolean | null }[]>;
  createProductLine(data: { code: string; name: string; description?: string | null }): Promise<ProductLine>;
  updateProductLine(id: number, updates: { name?: string; description?: string | null; isActive?: boolean; sortOrder?: number }): Promise<ProductLine | undefined>;
  replaceProductLineProducts(lineId: number, productIds: number[]): Promise<void>;
  addProductToProductLine(lineId: number, productId: number): Promise<ProductLineProduct | null>;
  removeProductFromProductLine(lineId: number, productId: number): Promise<void>;
  getProductLineProductIds(lineId: number): Promise<number[]>;

  // Grid/allocation helper queries
  getActiveProductLinesForDropdown(): Promise<{ id: number; code: string; name: string }[]>;
  getVariantIdsWithInventory(): Promise<number[]>;
  getVariantIdsByProductIds(productIds: number[]): Promise<number[]>;
  getProductLineProductMap(): Promise<Map<number, Set<number>>>;
  getChannelProductLineMap(): Promise<Map<number, Set<number>>>;
  getChannelSyncErrorCount(channelId: number, since: Date): Promise<number>;
  getLastChannelSyncError(channelId: number): Promise<string | null>;
  getChannelConnectionStatus(channelId: number): Promise<string | null>;

  // Cross-module utility queries
  getShopifyOrderFinancials(sourceTableId: string): Promise<{
    subtotalCents: number | null;
    taxCents: number | null;
    shippingCents: number | null;
    discountCents: number | null;
    totalCents: number | null;
    discountCodes: any;
  } | null>;
  getMemberPlanByEmail(email: string): Promise<string | null>;
  searchVariantsWithInventory(query: string): Promise<{ variantId: number; productId: number; sku: string | null; variantName: string | null; productName: string | null }[]>;
  updateChannelAllocation(channelId: number, allocationPct: number | null, allocationFixedQty: number | null): Promise<Channel | null>;
}

export const channelMethods: IChannelStorage = {
  async getAllChannels(): Promise<Channel[]> {
    return db.select().from(channels).orderBy(asc(channels.priority), asc(channels.name));
  },

  async getChannelById(id: number): Promise<Channel | undefined> {
    const result = await db.select().from(channels).where(eq(channels.id, id));
    return result[0];
  },

  async createChannel(channel: InsertChannel): Promise<Channel> {
    const result = await db.insert(channels).values(channel).returning();
    return result[0];
  },

  async updateChannel(id: number, updates: Partial<InsertChannel>): Promise<Channel | null> {
    const result = await db.update(channels)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(channels.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteChannel(id: number): Promise<boolean> {
    const result = await db.delete(channels).where(eq(channels.id, id)).returning();
    return result.length > 0;
  },

  async getChannelConnection(channelId: number): Promise<ChannelConnection | undefined> {
    const result = await db.select().from(channelConnections).where(eq(channelConnections.channelId, channelId));
    return result[0];
  },

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
  },

  async updateChannelConnectionSyncStatus(channelId: number, status: string, error?: string | null): Promise<void> {
    await db.update(channelConnections)
      .set({
        syncStatus: status,
        syncError: error,
        lastSyncAt: status === 'ok' ? new Date() : undefined,
        updatedAt: new Date()
      })
      .where(eq(channelConnections.channelId, channelId));
  },

  async getPartnerProfile(channelId: number): Promise<PartnerProfile | undefined> {
    const result = await db.select().from(partnerProfiles).where(eq(partnerProfiles.channelId, channelId));
    return result[0];
  },

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
  },

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
  },

  async getChannelReservationByChannelAndProductVariant(channelId: number, productVariantId: number): Promise<ChannelReservation | undefined> {
    const result = await db.select().from(channelReservations)
      .where(and(
        eq(channelReservations.channelId, channelId),
        eq(channelReservations.productVariantId, productVariantId)
      ));
    return result[0];
  },

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
  },

  async deleteChannelReservation(id: number): Promise<boolean> {
    const result = await db.delete(channelReservations).where(eq(channelReservations.id, id)).returning();
    return result.length > 0;
  },

  async getChannelConnectionByShopDomain(shopDomain: string): Promise<{ channelId: number; webhookSecret: string | null } | undefined> {
    const result = await db.execute<{ channel_id: number; webhook_secret: string | null }>(sql`
      SELECT cc.channel_id, cc.webhook_secret
      FROM channel_connections cc
      WHERE LOWER(cc.shop_domain) = LOWER(${shopDomain})
      LIMIT 1
    `);
    if (result.rows.length === 0) return undefined;
    return { channelId: result.rows[0].channel_id, webhookSecret: result.rows[0].webhook_secret };
  },

  async getChannelNameById(id: number): Promise<string | null> {
    const [ch] = await db.select({ name: channels.name }).from(channels).where(eq(channels.id, id)).limit(1);
    return ch?.name ?? null;
  },

  // --- Channel feed queries ---

  async getChannelFeedByChannelAndVariant(channelId: number, productVariantId: number): Promise<ChannelFeed | undefined> {
    const [existing] = await db.select().from(channelFeeds)
      .where(and(eq(channelFeeds.channelId, channelId), eq(channelFeeds.productVariantId, productVariantId)))
      .limit(1);
    return existing;
  },

  async reactivateChannelFeed(feedId: number): Promise<void> {
    await db.update(channelFeeds).set({ isActive: 1, updatedAt: new Date() }).where(eq(channelFeeds.id, feedId));
  },

  async createChannelFeedDirect(data: InsertChannelFeed): Promise<ChannelFeed> {
    const [feed] = await db.insert(channelFeeds).values(data).returning();
    return feed;
  },

  async getActiveChannelFeeds(): Promise<{ feedId: number; channelId: number | null; productVariantId: number; lastSyncedQty: number | null; lastSyncedAt: Date | null }[]> {
    return db.select({
      feedId: channelFeeds.id,
      channelId: channelFeeds.channelId,
      productVariantId: channelFeeds.productVariantId,
      lastSyncedQty: channelFeeds.lastSyncedQty,
      lastSyncedAt: channelFeeds.lastSyncedAt,
    }).from(channelFeeds).where(eq(channelFeeds.isActive, 1));
  },

  async getChannelFeedsByVariantIds(variantIds: number[]): Promise<{ id: number; channelId: number | null; productVariantId: number; lastSyncedQty: number | null; lastSyncedAt: Date | null; isActive: number | null }[]> {
    if (variantIds.length === 0) return [];
    return db.select({
      id: channelFeeds.id,
      channelId: channelFeeds.channelId,
      productVariantId: channelFeeds.productVariantId,
      lastSyncedQty: channelFeeds.lastSyncedQty,
      lastSyncedAt: channelFeeds.lastSyncedAt,
      isActive: channelFeeds.isActive,
    }).from(channelFeeds).where(inArray(channelFeeds.productVariantId, variantIds));
  },

  // --- Product line / product gate queries ---

  async getProductLineIdsByProduct(productId: number): Promise<number[]> {
    const rows = await db.select({ plId: productLineProducts.productLineId }).from(productLineProducts)
      .where(eq(productLineProducts.productId, productId));
    return rows.map((r: any) => r.plId);
  },

  async getActiveChannelProductLineIds(channelId: number): Promise<number[]> {
    const rows = await db.select({ plId: channelProductLines.productLineId }).from(channelProductLines)
      .where(and(eq(channelProductLines.channelId, channelId), eq(channelProductLines.isActive, true)));
    return rows.map((r: any) => r.plId);
  },

  // --- Channel product allocation ---

  async getAllChannelProductAllocations(): Promise<ChannelProductAllocation[]> {
    return db.select().from(channelProductAllocation);
  },

  async getChannelProductAllocation(channelId: number, productId: number): Promise<ChannelProductAllocation | undefined> {
    const [row] = await db.select().from(channelProductAllocation).where(
      and(eq(channelProductAllocation.channelId, channelId), eq(channelProductAllocation.productId, productId))
    ).limit(1);
    return row;
  },

  async upsertChannelProductAllocation(data: { channelId: number; productId: number; minAtpBase?: number | null; maxAtpBase?: number | null; isListed?: number; notes?: string | null }): Promise<ChannelProductAllocation> {
    const existing = await this.getChannelProductAllocation(data.channelId, data.productId);
    if (existing) {
      const [updated] = await db.update(channelProductAllocation).set({
        minAtpBase: data.minAtpBase ?? null,
        maxAtpBase: data.maxAtpBase ?? null,
        isListed: data.isListed ?? 1,
        notes: data.notes ?? null,
        updatedAt: new Date(),
      }).where(eq(channelProductAllocation.id, existing.id)).returning();
      return updated;
    }
    const [created] = await db.insert(channelProductAllocation).values({
      channelId: data.channelId,
      productId: data.productId,
      minAtpBase: data.minAtpBase ?? null,
      maxAtpBase: data.maxAtpBase ?? null,
      isListed: data.isListed ?? 1,
      notes: data.notes ?? null,
    }).returning();
    return created;
  },

  async deleteChannelProductAllocation(id: number): Promise<void> {
    await db.delete(channelProductAllocation).where(eq(channelProductAllocation.id, id));
  },

  async getChannelProductAllocationsByProduct(productId: number): Promise<ChannelProductAllocation[]> {
    return db.select().from(channelProductAllocation).where(eq(channelProductAllocation.productId, productId));
  },

  // --- Active channels ---

  async getActiveChannels(): Promise<Channel[]> {
    return db.select().from(channels).where(eq(channels.status, "active"));
  },

  // --- Channel reservations by variant IDs ---

  async getChannelReservationsByVariantIds(variantIds: number[]): Promise<ChannelReservation[]> {
    if (variantIds.length === 0) return [];
    return db.select().from(channelReservations).where(inArray(channelReservations.productVariantId, variantIds));
  },

  // --- Product lines CRUD ---

  async getProductLinesWithCounts(): Promise<(ProductLine & { productCount: number; channelCount: number })[]> {
    const lines = await db.select().from(productLines).orderBy(productLines.sortOrder, productLines.name);

    const productCounts = await db
      .select({ productLineId: productLineProducts.productLineId, count: count() })
      .from(productLineProducts)
      .groupBy(productLineProducts.productLineId);
    const countMap = new Map(productCounts.map((r: any) => [r.productLineId, Number(r.count)]));

    const channelCounts = await db
      .select({ productLineId: channelProductLines.productLineId, count: count() })
      .from(channelProductLines)
      .where(eq(channelProductLines.isActive, true))
      .groupBy(channelProductLines.productLineId);
    const chCountMap = new Map(channelCounts.map((r: any) => [r.productLineId, Number(r.count)]));

    return lines.map((l: any) => ({
      ...l,
      productCount: countMap.get(l.id) ?? 0,
      channelCount: chCountMap.get(l.id) ?? 0,
    }));
  },

  async getProductLineById(id: number): Promise<ProductLine | undefined> {
    const [line] = await db.select().from(productLines).where(eq(productLines.id, id));
    return line;
  },

  async getProductLineAssignedProducts(lineId: number): Promise<{ productId: number; productName: string; sku: string | null }[]> {
    return db
      .select({ productId: productLineProducts.productId, productName: products.name, sku: products.sku })
      .from(productLineProducts)
      .innerJoin(products, eq(products.id, productLineProducts.productId))
      .where(eq(productLineProducts.productLineId, lineId))
      .orderBy(products.name);
  },

  async getProductLineAssignedChannels(lineId: number): Promise<{ channelId: number; channelName: string; provider: string | null; isActive: boolean | null }[]> {
    return db
      .select({ channelId: channelProductLines.channelId, channelName: channels.name, provider: channels.provider, isActive: channelProductLines.isActive })
      .from(channelProductLines)
      .innerJoin(channels, eq(channels.id, channelProductLines.channelId))
      .where(eq(channelProductLines.productLineId, lineId))
      .orderBy(channels.name);
  },

  async createProductLine(data: { code: string; name: string; description?: string | null }): Promise<ProductLine> {
    const [created] = await db.insert(productLines).values({
      code: data.code.toUpperCase().replace(/\s+/g, "_"),
      name: data.name,
      description: data.description || null,
    }).returning();
    return created;
  },

  async updateProductLine(id: number, updates: { name?: string; description?: string | null; isActive?: boolean; sortOrder?: number }): Promise<ProductLine | undefined> {
    const setData: any = { updatedAt: new Date() };
    if (updates.name !== undefined) setData.name = updates.name;
    if (updates.description !== undefined) setData.description = updates.description;
    if (updates.isActive !== undefined) setData.isActive = updates.isActive;
    if (updates.sortOrder !== undefined) setData.sortOrder = updates.sortOrder;

    const [updated] = await db.update(productLines).set(setData).where(eq(productLines.id, id)).returning();
    return updated;
  },

  async replaceProductLineProducts(lineId: number, productIds: number[]): Promise<void> {
    await db.delete(productLineProducts).where(eq(productLineProducts.productLineId, lineId));
    if (productIds.length > 0) {
      await db.insert(productLineProducts).values(
        productIds.map((pid: number) => ({ productLineId: lineId, productId: pid }))
      ).onConflictDoNothing();
    }
  },

  async addProductToProductLine(lineId: number, productId: number): Promise<ProductLineProduct | null> {
    const [created] = await db.insert(productLineProducts).values({
      productLineId: lineId,
      productId,
    }).onConflictDoNothing().returning();
    return created || null;
  },

  async removeProductFromProductLine(lineId: number, productId: number): Promise<void> {
    await db.delete(productLineProducts).where(
      and(eq(productLineProducts.productLineId, lineId), eq(productLineProducts.productId, productId))
    );
  },

  async getProductLineProductIds(lineId: number): Promise<number[]> {
    const rows = await db
      .select({ productId: productLineProducts.productId })
      .from(productLineProducts)
      .where(eq(productLineProducts.productLineId, lineId));
    return rows.map((r: any) => r.productId);
  },

  // --- Grid/allocation helper queries ---

  async getActiveProductLinesForDropdown(): Promise<{ id: number; code: string; name: string }[]> {
    return db.select({ id: productLines.id, code: productLines.code, name: productLines.name })
      .from(productLines).where(eq(productLines.isActive, true)).orderBy(productLines.sortOrder, productLines.name);
  },

  async getVariantIdsWithInventory(): Promise<number[]> {
    const rows = await db
      .selectDistinct({ id: productVariants.id })
      .from(productVariants)
      .innerJoin(inventoryLevels, eq(inventoryLevels.productVariantId, productVariants.id))
      .where(and(eq(productVariants.isActive, true), gt(inventoryLevels.variantQty, 0)));
    return rows.map((v: any) => v.id);
  },

  async getVariantIdsByProductIds(productIds: number[]): Promise<number[]> {
    if (productIds.length === 0) return [];
    const rows = await db.select({ id: productVariants.id }).from(productVariants)
      .where(inArray(productVariants.productId, productIds));
    return rows.map((v: any) => v.id);
  },

  async getProductLineProductMap(): Promise<Map<number, Set<number>>> {
    const rows = await db.select({ productId: productLineProducts.productId, productLineId: productLineProducts.productLineId }).from(productLineProducts);
    const map = new Map<number, Set<number>>();
    for (const r of rows) {
      if (!map.has(r.productId)) map.set(r.productId, new Set());
      map.get(r.productId)!.add(r.productLineId);
    }
    return map;
  },

  async getChannelProductLineMap(): Promise<Map<number, Set<number>>> {
    const rows = await db.select({ channelId: channelProductLines.channelId, productLineId: channelProductLines.productLineId }).from(channelProductLines);
    const map = new Map<number, Set<number>>();
    for (const r of rows) {
      if (!map.has(r.channelId)) map.set(r.channelId, new Set());
      map.get(r.channelId)!.add(r.productLineId);
    }
    return map;
  },

  async getChannelSyncErrorCount(channelId: number, since: Date): Promise<number> {
    const [row] = await db.select({ cnt: sql`COUNT(*)::int` }).from(channelSyncLog)
      .where(and(eq(channelSyncLog.channelId, channelId), eq(channelSyncLog.status, "error"), gt(channelSyncLog.createdAt, since)));
    return (row as any)?.cnt ?? 0;
  },

  async getLastChannelSyncError(channelId: number): Promise<string | null> {
    const [row] = await db.select({ errorMessage: channelSyncLog.errorMessage }).from(channelSyncLog)
      .where(and(eq(channelSyncLog.channelId, channelId), eq(channelSyncLog.status, "error")))
      .orderBy(desc(channelSyncLog.createdAt)).limit(1);
    return (row as any)?.errorMessage ?? null;
  },

  async getChannelConnectionStatus(channelId: number): Promise<string | null> {
    const [conn] = await db.select({ syncStatus: channelConnections.syncStatus }).from(channelConnections)
      .where(eq(channelConnections.channelId, channelId)).limit(1);
    return (conn as any)?.syncStatus ?? null;
  },

  // --- Cross-module utility queries ---

  async getShopifyOrderFinancials(sourceTableId: string): Promise<{
    subtotalCents: number | null;
    taxCents: number | null;
    shippingCents: number | null;
    discountCents: number | null;
    totalCents: number | null;
    discountCodes: any;
  } | null> {
    // Primary: read from oms_orders (source of truth)
    const result = await db.execute<{
      subtotal_cents: number | null;
      total_cents: number | null;
      tax_cents: number | null;
      shipping_cents: number | null;
      discount_cents: number | null;
    }>(sql`
      SELECT
        subtotal_cents,
        total_cents,
        tax_cents,
        shipping_cents,
        discount_cents
      FROM oms_orders
      WHERE external_order_id = ${sourceTableId}
      LIMIT 1
    `);
    if (result.rows.length === 0) return null;
    const raw = result.rows[0];
    return {
      subtotalCents: raw.subtotal_cents,
      taxCents: raw.tax_cents,
      shippingCents: raw.shipping_cents,
      discountCents: raw.discount_cents,
      totalCents: raw.total_cents,
      discountCodes: null, // discount codes not stored on oms_orders; use raw_payload if needed
    };
  },

  async getMemberPlanByEmail(email: string): Promise<string | null> {
    const result = await db.execute<{ plan_name: string }>(sql`
      SELECT p.name as plan_name
      FROM members m
      JOIN plans p ON m.plan_id = p.id
      WHERE LOWER(m.email) = LOWER(${email})
      LIMIT 1
    `);
    if (result.rows.length === 0) return null;
    return result.rows[0].plan_name;
  },

  async searchVariantsWithInventory(query: string): Promise<{ variantId: number; productId: number; sku: string | null; variantName: string | null; productName: string | null }[]> {
    const pattern = `%${query}%`;
    return db
      .selectDistinct({
        variantId: productVariants.id,
        productId: products.id,
        sku: productVariants.sku,
        variantName: productVariants.name,
        productName: products.name,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(
        eq(productVariants.isActive, true),
        or(
          ilike(productVariants.sku, pattern),
          ilike(productVariants.name, pattern),
          ilike(products.name, pattern),
        ),
      ))
      .limit(15);
  },

  async updateChannelAllocation(channelId: number, allocationPct: number | null, allocationFixedQty: number | null): Promise<Channel | null> {
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel) return null;

    const [updated] = await db.update(channels).set({
      allocationPct: allocationPct != null ? Math.max(0, Math.min(100, allocationPct)) : null,
      allocationFixedQty: allocationFixedQty != null ? Math.max(0, allocationFixedQty) : null,
      updatedAt: new Date(),
    }).where(eq(channels.id, channelId)).returning();

    return updated || null;
  },
};
