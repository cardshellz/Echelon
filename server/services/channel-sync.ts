import { eq, and, sql, inArray } from "drizzle-orm";
import {
  channelFeeds,
  channelConnections,
  channelReservations,
  channelProductAllocation,
  channelSyncLog,
  channels,
  productVariants,
  products,
  warehouses,
} from "@shared/schema";
import type {
  ChannelFeed,
  ChannelConnection,
  ChannelReservation,
  ChannelProductAllocation,
  Channel,
  ProductVariant,
  Product,
  Warehouse,
} from "@shared/schema";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

type InventoryAtpService = {
  getAtpBase: (productId: number) => Promise<number>;
  getAtpPerVariant: (productId: number) => Promise<Array<{
    productVariantId: number;
    sku: string;
    name: string;
    unitsPerVariant: number;
    atpUnits: number;
    atpBase: number;
  }>>;
  getAtpPerVariantByWarehouse: (productId: number, warehouseId: number) => Promise<Array<{
    productVariantId: number;
    sku: string;
    name: string;
    unitsPerVariant: number;
    atpUnits: number;
    atpBase: number;
  }>>;
};

export interface SyncResult {
  productId: number;
  synced: number;
  errors: string[];
  variants: Array<{
    productVariantId: number;
    channelVariantId: string;
    pushedQty: number;
    atpBase: number;
    status: string;
  }>;
}

/**
 * Channel sync service for the Echelon WMS.
 *
 * Pushes effective ATP to external sales channels. The effective ATP for
 * each variant on each channel is: base ATP → apply product floor →
 * apply variant floor → apply max cap → push result. Always pushes the
 * accurate number on every sync.
 *
 * Shopify is the only live provider. Other configured providers (ebay,
 * amazon, etsy, manual) get stub adapters that log computed ATP and
 * update channel_feeds without calling external APIs.
 */
class ChannelSyncService {
  /** Debounce map: productId → timeout handle */
  private pendingSyncs = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly DEBOUNCE_MS = 2000;
  private readonly MAX_RETRIES = 3;

  /** Cached kill switch — loaded once, refreshed on demand */
  private _syncEnabled: boolean | null = null;

  constructor(
    private readonly db: DrizzleDb,
    private readonly atpService: InventoryAtpService,
  ) {}

  /** Check if channel sync is enabled (cached, lazy-loaded) */
  private async isSyncEnabled(): Promise<boolean> {
    if (this._syncEnabled !== null) return this._syncEnabled;
    await this.refreshSyncEnabled();
    return this._syncEnabled!;
  }

  /** Reload the kill switch from warehouse_settings */
  async refreshSyncEnabled(): Promise<boolean> {
    try {
      const settings = await this.db
        .select({ channelSyncEnabled: warehouseSettings.channelSyncEnabled })
        .from(warehouseSettings)
        .where(eq(warehouseSettings.isActive, 1))
        .limit(1);
      this._syncEnabled = settings[0]?.channelSyncEnabled === 1;
    } catch {
      this._syncEnabled = false; // Fail safe: don't push if we can't read settings
    }
    return this._syncEnabled;
  }

  // ---------------------------------------------------------------------------
  // 1. SYNC PRODUCT — compute effective ATP and push to all active channels
  // ---------------------------------------------------------------------------

  async syncProduct(productId: number, triggeredBy?: string): Promise<SyncResult> {
    // Master kill switch — skip all pushes when disabled
    if (!(await this.isSyncEnabled())) {
      return { productId, synced: 0, errors: [], variants: [] };
    }

    const result: SyncResult = {
      productId,
      synced: 0,
      errors: [],
      variants: [],
    };

    const [product] = await this.db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);

    if (!product) {
      result.errors.push(`Product ${productId} not found`);
      return result;
    }

    // Get fungible ATP for all variants
    const variantAtp = await this.atpService.getAtpPerVariant(productId);
    const atpByVariantId = new Map(variantAtp.map((v) => [v.productVariantId, v]));
    const variantIds = variantAtp.map((v) => v.productVariantId);
    if (variantIds.length === 0) return result;

    // Global ATP in base units (shared pool)
    const atpBase = variantAtp.length > 0 ? variantAtp[0].atpBase : 0;

    // Load active channel feeds for these variants
    const feeds: ChannelFeed[] = await this.db
      .select()
      .from(channelFeeds)
      .where(and(
        inArray(channelFeeds.productVariantId, variantIds),
        eq(channelFeeds.isActive, 1),
      ));

    if (feeds.length === 0) return result;

    // Load allocation rules
    const channelIds = Array.from(new Set(feeds.map((f) => f.channelId).filter(Boolean))) as number[];

    // Load channel records (for allocation %)
    const channelRows: Channel[] = channelIds.length > 0
      ? await this.db.select().from(channels).where(inArray(channels.id, channelIds))
      : [];
    const channelMap = new Map(channelRows.map((c) => [c.id, c]));

    // Product-level allocation rules
    const productAllocations: ChannelProductAllocation[] = channelIds.length > 0
      ? await this.db
          .select()
          .from(channelProductAllocation)
          .where(and(
            eq(channelProductAllocation.productId, productId),
            inArray(channelProductAllocation.channelId, channelIds),
          ))
      : [];
    const productAllocMap = new Map(
      productAllocations.map((pa) => [pa.channelId, pa]),
    );

    // Variant-level reservation rules (floor + cap + override)
    const reservations: ChannelReservation[] = await this.db
      .select()
      .from(channelReservations)
      .where(inArray(channelReservations.productVariantId, variantIds));
    const reservationMap = new Map<string, ChannelReservation>();
    for (const r of reservations) {
      if ((r as any).channelId) {
        reservationMap.set(`${(r as any).channelId}:${(r as any).productVariantId}`, r);
      }
    }

    // Push each feed
    for (const feed of feeds) {
      const atp = atpByVariantId.get(feed.productVariantId);
      const unitsPerVariant = atp?.unitsPerVariant ?? 1;
      let effectiveAtp = atp?.atpUnits ?? 0;
      let status = "success";

      if (feed.channelId) {
        const reservation = reservationMap.get(`${feed.channelId}:${feed.productVariantId}`);

        // 1. VARIANT HARD OVERRIDE — takes absolute precedence
        //    overrideQty = 0 means "stop selling this variant on this channel"
        //    overrideQty = N means "push exactly N units"
        if (reservation && reservation.overrideQty != null) {
          effectiveAtp = reservation.overrideQty;
          status = reservation.overrideQty === 0 ? "variant_override_zero" : "variant_override";
        } else {
          // 2. PRODUCT BLOCK (isListed = 0)
          const prodAlloc = productAllocMap.get(feed.channelId);
          if (prodAlloc && prodAlloc.isListed === 0) {
            effectiveAtp = 0;
            status = "unlisted";
          }

          // 3. CHANNEL ALLOCATION — constrain pool by channel's %/fixed allocation
          if (status === "success") {
            const channel = channelMap.get(feed.channelId);
            if (channel) {
              if ((channel as any).allocationFixedQty != null) {
                // Fixed qty allocation: cap this channel's pool at the fixed amount (in base units)
                const allocBase = (channel as any).allocationFixedQty as number;
                const allocUnits = Math.floor(allocBase / unitsPerVariant);
                effectiveAtp = Math.min(effectiveAtp, allocUnits);
                if (effectiveAtp !== (atp?.atpUnits ?? 0)) status = "channel_alloc_fixed";
              } else if ((channel as any).allocationPct != null) {
                // % allocation: channel gets this % of the product's total ATP pool
                const pct = (channel as any).allocationPct as number;
                const allocBase = Math.floor(atpBase * pct / 100);
                const allocUnits = Math.floor(allocBase / unitsPerVariant);
                effectiveAtp = Math.min(effectiveAtp, allocUnits);
                if (effectiveAtp !== (atp?.atpUnits ?? 0)) status = "channel_alloc_pct";
              }
            }
          }

          // 4. PRODUCT FLOOR — if total ATP below threshold, push 0
          if (status === "success" && prodAlloc?.minAtpBase != null && atpBase < prodAlloc.minAtpBase) {
            effectiveAtp = 0;
            status = "product_floor";
          }

          // 5. PRODUCT CAP
          if (status === "success" && prodAlloc?.maxAtpBase != null) {
            const capUnits = Math.floor(prodAlloc.maxAtpBase / unitsPerVariant);
            effectiveAtp = Math.min(effectiveAtp, capUnits);
          }

          // 6. VARIANT FLOOR + CAP
          if (status === "success" && reservation) {
            if (reservation.minStockBase != null && reservation.minStockBase > 0 && effectiveAtp < reservation.minStockBase) {
              effectiveAtp = 0;
              status = "variant_floor";
            }
            if (reservation.maxStockBase != null && effectiveAtp > 0) {
              const maxUnits = Math.floor(reservation.maxStockBase / unitsPerVariant);
              effectiveAtp = Math.min(effectiveAtp, maxUnits);
            }
          }
        }
      }

      // Ensure non-negative
      effectiveAtp = Math.max(effectiveAtp, 0);

      const previousQty = (feed as any).lastSyncedQty ?? null;
      const startTime = Date.now();

      try {
        await this.pushWithRetry(feed, effectiveAtp);

        // Update feed sync state
        await this.db
          .update(channelFeeds)
          .set({
            lastSyncedQty: effectiveAtp,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(channelFeeds.id, feed.id));

        // Log sync
        await this.logSync({
          productId,
          productVariantId: feed.productVariantId,
          channelId: feed.channelId,
          channelFeedId: feed.id,
          atpBase,
          pushedQty: effectiveAtp,
          previousQty,
          status,
          durationMs: Date.now() - startTime,
          triggeredBy: triggeredBy ?? null,
        });

        result.synced += 1;
        result.variants.push({
          productVariantId: feed.productVariantId,
          channelVariantId: feed.channelVariantId,
          pushedQty: effectiveAtp,
          atpBase,
          status,
        });
      } catch (err: any) {
        const message = `Failed to sync variant ${feed.productVariantId} to ${feed.channelType}/${feed.channelVariantId}: ${err.message ?? err}`;
        result.errors.push(message);
        console.error(`[ChannelSync] ${message}`);

        await this.logSync({
          productId,
          productVariantId: feed.productVariantId,
          channelId: feed.channelId,
          channelFeedId: feed.id,
          atpBase,
          pushedQty: effectiveAtp,
          previousQty,
          status: "error",
          errorMessage: err.message ?? String(err),
          durationMs: Date.now() - startTime,
          triggeredBy: triggeredBy ?? null,
        });
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // 2. SYNC ALL PRODUCTS — batch sync with rate limiting
  // ---------------------------------------------------------------------------

  async syncAllProducts(
    channelId?: number,
  ): Promise<{ total: number; synced: number; errors: string[] }> {
    const aggregated = { total: 0, synced: 0, errors: [] as string[] };

    // Auto-discover feeds regardless of kill switch (feeds ≠ pushing)
    await this.discoverFeeds();

    // Master kill switch — skip all pushes when disabled
    if (!(await this.isSyncEnabled())) return aggregated;

    const allActiveFeeds = await this.db
      .select({ productVariantId: channelFeeds.productVariantId })
      .from(channelFeeds)
      .where(eq(channelFeeds.isActive, 1));

    const variantIds: number[] = Array.from(new Set(allActiveFeeds.map((f: any) => f.productVariantId as number)));
    if (variantIds.length === 0) return aggregated;

    const variantRows: ProductVariant[] = await this.db
      .select()
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds));

    let productIds = Array.from(new Set(variantRows.map((v) => v.productId)));

    if (channelId != null) {
      const [channel] = await this.db
        .select()
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1);

      if (!channel) {
        aggregated.errors.push(`Channel ${channelId} not found`);
        return aggregated;
      }

      const channelFeedsForChannel: ChannelFeed[] = await this.db
        .select()
        .from(channelFeeds)
        .where(and(
          eq(channelFeeds.isActive, 1),
          eq(channelFeeds.channelId, channelId),
        ));

      const channelVariantIds = new Set(channelFeedsForChannel.map((f) => f.productVariantId));
      const channelVariantRows = variantRows.filter((v) => channelVariantIds.has(v.id));
      productIds = Array.from(new Set(channelVariantRows.map((v) => v.productId)));
    }

    aggregated.total = productIds.length;

    for (const productId of productIds) {
      const syncResult = await this.syncProduct(productId, "manual");
      aggregated.synced += syncResult.synced;
      aggregated.errors.push(...syncResult.errors);
      await this.delay(300);
    }

    return aggregated;
  }

  // ---------------------------------------------------------------------------
  // 3. DEBOUNCED SYNC AFTER INVENTORY CHANGE
  // ---------------------------------------------------------------------------

  /**
   * Debounced trigger for channel sync after an inventory mutation.
   * Collapses rapid changes to the same product into a single sync
   * after a 2-second quiet window.
   */
  async queueSyncAfterInventoryChange(
    productVariantId: number,
    triggeredBy?: string,
  ): Promise<void> {
    // Master kill switch — skip entirely when disabled
    if (!(await this.isSyncEnabled())) return;

    const [variant] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, productVariantId))
      .limit(1);

    if (!variant) {
      console.warn(`[ChannelSync] Cannot queue sync: variant ${productVariantId} not found`);
      return;
    }

    // Check if this variant has any active feeds
    const [feed] = await this.db
      .select()
      .from(channelFeeds)
      .where(and(
        eq(channelFeeds.productVariantId, productVariantId),
        eq(channelFeeds.isActive, 1),
      ))
      .limit(1);

    if (!feed) return; // No active feeds — nothing to sync

    const productId = variant.productId;

    // Clear existing debounce timer for this product
    const existing = this.pendingSyncs.get(productId);
    if (existing) clearTimeout(existing);

    // Set new debounce timer
    const timeout = setTimeout(async () => {
      this.pendingSyncs.delete(productId);
      try {
        await this.syncProduct(productId, triggeredBy ?? "inventory_change");
      } catch (err: any) {
        console.error(
          `[ChannelSync] Debounced sync failed for product ${productId}: ${err.message}`,
        );
      }
    }, this.DEBOUNCE_MS);

    this.pendingSyncs.set(productId, timeout);
  }

  // ---------------------------------------------------------------------------
  // 4. SYNC STATUS — monitoring
  // ---------------------------------------------------------------------------

  async getLastSyncStatus(
    channelId?: number,
  ): Promise<Array<{
    productVariantId: number;
    channelVariantId: string;
    channelId: number | null;
    channelType: string;
    lastSyncedQty: number;
    lastSyncedAt: Date | null;
  }>> {
    let query;

    if (channelId != null) {
      query = this.db
        .select({
          productVariantId: channelFeeds.productVariantId,
          channelVariantId: channelFeeds.channelVariantId,
          channelId: channelFeeds.channelId,
          channelType: channelFeeds.channelType,
          lastSyncedQty: channelFeeds.lastSyncedQty,
          lastSyncedAt: channelFeeds.lastSyncedAt,
        })
        .from(channelFeeds)
        .where(and(
          eq(channelFeeds.isActive, 1),
          eq(channelFeeds.channelId, channelId),
        ));
    } else {
      query = this.db
        .select({
          productVariantId: channelFeeds.productVariantId,
          channelVariantId: channelFeeds.channelVariantId,
          channelId: channelFeeds.channelId,
          channelType: channelFeeds.channelType,
          lastSyncedQty: channelFeeds.lastSyncedQty,
          lastSyncedAt: channelFeeds.lastSyncedAt,
        })
        .from(channelFeeds)
        .where(eq(channelFeeds.isActive, 1));
    }

    const rows = await query;
    return rows.map((row: any) => ({
      productVariantId: row.productVariantId,
      channelVariantId: row.channelVariantId,
      channelId: row.channelId ?? null,
      channelType: row.channelType,
      lastSyncedQty: row.lastSyncedQty ?? 0,
      lastSyncedAt: row.lastSyncedAt ?? null,
    }));
  }

  /**
   * Get sync log entries for monitoring/audit.
   */
  async getSyncLog(opts?: {
    channelId?: number;
    productId?: number;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<any>> {
    const conditions = [];
    if (opts?.channelId) conditions.push(eq(channelSyncLog.channelId, opts.channelId));
    if (opts?.productId) conditions.push(eq(channelSyncLog.productId, opts.productId));
    if (opts?.status) conditions.push(eq(channelSyncLog.status, opts.status));

    const rows = await this.db
      .select()
      .from(channelSyncLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(sql`${channelSyncLog.createdAt} DESC`)
      .limit(opts?.limit ?? 100)
      .offset(opts?.offset ?? 0);

    return rows;
  }

  /**
   * Find channel feeds where lastSyncedQty differs from current ATP.
   * Indicates stale inventory on channels.
   */
  async getDivergence(): Promise<Array<{
    productVariantId: number;
    channelId: number | null;
    channelType: string;
    lastSyncedQty: number;
    currentAtpUnits: number;
    lastSyncedAt: Date | null;
  }>> {
    const feeds: ChannelFeed[] = await this.db
      .select()
      .from(channelFeeds)
      .where(eq(channelFeeds.isActive, 1));

    const divergent: Array<any> = [];
    const productCache = new Map<number, Array<any>>();

    for (const feed of feeds) {
      // Resolve product for this variant
      const [variant] = await this.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, feed.productVariantId))
        .limit(1);
      if (!variant) continue;

      // Cache ATP per product
      if (!productCache.has(variant.productId)) {
        productCache.set(variant.productId, await this.atpService.getAtpPerVariant(variant.productId));
      }
      const variantAtp = productCache.get(variant.productId)!;
      const atp = variantAtp.find((v) => v.productVariantId === feed.productVariantId);
      const currentAtpUnits = atp?.atpUnits ?? 0;

      if ((feed as any).lastSyncedQty !== currentAtpUnits) {
        divergent.push({
          productVariantId: feed.productVariantId,
          channelId: feed.channelId,
          channelType: feed.channelType,
          lastSyncedQty: (feed as any).lastSyncedQty ?? 0,
          currentAtpUnits,
          lastSyncedAt: (feed as any).lastSyncedAt ?? null,
        });
      }
    }

    return divergent;
  }

  // ---------------------------------------------------------------------------
  // FEED DISCOVERY — auto-create feeds for active channels
  // ---------------------------------------------------------------------------

  /**
   * For each active channel, ensure every active variant with a shopifyVariantId
   * has a channelFeed record linking it to that channel. Creates missing feeds
   * so the sync can push inventory without manual setup.
   */
  async discoverFeeds(): Promise<{ created: number; channels: number }> {
    const activeChannels: Channel[] = await this.db
      .select()
      .from(channels)
      .where(eq(channels.status, "active"));

    if (activeChannels.length === 0) return { created: 0, channels: 0 };

    // All active variants with a Shopify variant ID
    const allVariants: ProductVariant[] = await this.db
      .select()
      .from(productVariants)
      .where(and(
        eq(productVariants.isActive, true),
        sql`${productVariants.shopifyVariantId} IS NOT NULL`,
      ));

    if (allVariants.length === 0) return { created: 0, channels: 0 };

    // Load all existing feeds keyed by channelId:variantId
    const existingFeeds: ChannelFeed[] = await this.db
      .select()
      .from(channelFeeds);

    const existingSet = new Set(
      existingFeeds.map((f) => `${f.channelId}:${f.productVariantId}`),
    );

    let created = 0;
    let channelsProcessed = 0;

    for (const channel of activeChannels) {
      // Only auto-discover for Shopify channels (they share variant IDs from the catalog)
      if (channel.provider !== "shopify") continue;

      channelsProcessed++;
      const newFeeds: Array<{
        channelId: number;
        productVariantId: number;
        channelType: string;
        channelVariantId: string;
        channelSku: string | null;
        isActive: number;
      }> = [];

      for (const v of allVariants) {
        if (existingSet.has(`${channel.id}:${v.id}`)) continue;

        newFeeds.push({
          channelId: channel.id,
          productVariantId: v.id,
          channelType: channel.provider,
          channelVariantId: v.shopifyVariantId!,
          channelSku: v.sku || null,
          isActive: 1,
        });
      }

      if (newFeeds.length > 0) {
        // Batch insert in chunks of 100
        for (let i = 0; i < newFeeds.length; i += 100) {
          const chunk = newFeeds.slice(i, i + 100);
          await this.db.insert(channelFeeds).values(chunk);
        }
        created += newFeeds.length;
        console.log(
          `[ChannelSync] Discovered ${newFeeds.length} new feeds for channel "${channel.name}" (${channel.id})`,
        );
      }
    }

    return { created, channels: channelsProcessed };
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Push with exponential backoff retry.
   */
  private async pushWithRetry(feed: ChannelFeed, atpUnits: number): Promise<void> {
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        await this.pushToChannel(feed, atpUnits);
        return;
      } catch (err) {
        if (attempt === this.MAX_RETRIES) throw err;
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.warn(`[ChannelSync] Push attempt ${attempt} failed, retrying in ${delayMs}ms`);
        await this.delay(delayMs);
      }
    }
  }

  /**
   * Route push to the appropriate channel adapter.
   * Shopify: live push. Others: stub (log + update feed state).
   */
  private async pushToChannel(feed: ChannelFeed, atpUnits: number): Promise<void> {
    switch (feed.channelType) {
      case "shopify":
        await this.pushToShopify(feed, atpUnits);
        break;

      case "ebay":
      case "amazon":
        // Stub: log computed ATP, don't call external API
        console.log(
          `[ChannelSync] STUB ${feed.channelType}: would push ${atpUnits} units ` +
          `for variant ${feed.productVariantId} (feed ${feed.id})`,
        );
        break;

      case "wholesale":
        // Manual/wholesale channels — no push, just record
        break;

      default:
        console.warn(`[ChannelSync] Unknown channel type "${feed.channelType}" for feed ${feed.id}`);
    }
  }

  private async pushToShopify(feed: ChannelFeed, atpUnits: number): Promise<void> {
    if (!feed.channelId) {
      throw new Error(`Feed ${feed.id} has no channelId — cannot resolve Shopify credentials`);
    }
    const [conn] = await this.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.channelId, feed.channelId))
      .limit(1);
    if (!conn?.shopDomain || !conn?.accessToken) {
      throw new Error(`Channel ${feed.channelId} has no Shopify credentials configured`);
    }

    const [variantRow] = await this.db
      .select({
        productId: productVariants.productId,
        shopifyInventoryItemId: productVariants.shopifyInventoryItemId,
      })
      .from(productVariants)
      .where(eq(productVariants.id, feed.productVariantId))
      .limit(1);

    if (!variantRow?.shopifyInventoryItemId) {
      throw new Error(
        `Variant ${feed.productVariantId} has no shopifyInventoryItemId — run Shopify product sync first`,
      );
    }

    const warehouseRows: Warehouse[] = await this.db
      .select()
      .from(warehouses)
      .where(and(
        eq(warehouses.isActive, 1),
        sql`${warehouses.shopifyLocationId} IS NOT NULL`,
        sql`COALESCE(${warehouses.inventorySourceType}, 'internal') = 'internal'`,
      ));

    if (warehouseRows.length > 0) {
      for (const wh of warehouseRows) {
        const warehouseAtp = await this.atpService.getAtpPerVariantByWarehouse(
          variantRow.productId,
          wh.id,
        );
        const variantAtp = warehouseAtp.find((v) => v.productVariantId === feed.productVariantId);
        const qty = variantAtp?.atpUnits ?? 0;

        await this.pushToShopifyLocation(
          conn.shopDomain,
          conn.accessToken,
          variantRow.shopifyInventoryItemId,
          wh.shopifyLocationId!,
          qty,
        );
      }
    } else {
      const shopifyLocationId = process.env.SHOPIFY_LOCATION_ID;
      if (!shopifyLocationId) {
        throw new Error(
          "No warehouses with shopify_location_id configured and SHOPIFY_LOCATION_ID env var not set",
        );
      }
      await this.pushToShopifyLocation(
        conn.shopDomain,
        conn.accessToken,
        variantRow.shopifyInventoryItemId,
        shopifyLocationId,
        atpUnits,
      );
    }
  }

  private async pushToShopifyLocation(
    shopifyDomain: string,
    accessToken: string,
    inventoryItemId: string,
    shopifyLocationId: string,
    available: number,
  ): Promise<void> {
    const url = `https://${shopifyDomain}/admin/api/2024-01/inventory_levels/set.json`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location_id: Number(shopifyLocationId),
        inventory_item_id: Number(inventoryItemId),
        available,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Shopify API error ${response.status} for location ${shopifyLocationId}: ${body}`);
    }

    console.log(
      `[ChannelSync] Pushed ${available} to Shopify location=${shopifyLocationId} item=${inventoryItemId}`,
    );
  }

  /**
   * Write a sync log entry.
   */
  private async logSync(entry: {
    productId: number;
    productVariantId: number;
    channelId: number | null;
    channelFeedId: number;
    atpBase: number;
    pushedQty: number;
    previousQty: number | null;
    status: string;
    errorMessage?: string;
    responseCode?: number;
    durationMs: number;
    triggeredBy: string | null;
  }): Promise<void> {
    try {
      await this.db.insert(channelSyncLog).values({
        productId: entry.productId,
        productVariantId: entry.productVariantId,
        channelId: entry.channelId,
        channelFeedId: entry.channelFeedId,
        atpBase: entry.atpBase,
        pushedQty: entry.pushedQty,
        previousQty: entry.previousQty,
        status: entry.status,
        errorMessage: entry.errorMessage ?? null,
        responseCode: entry.responseCode ?? null,
        durationMs: entry.durationMs,
        triggeredBy: entry.triggeredBy,
      });
    } catch (err: any) {
      // Don't let logging failures break the sync
      console.warn(`[ChannelSync] Failed to write sync log: ${err.message}`);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChannelSyncService(db: any, atpService: any) {
  return new ChannelSyncService(db, atpService);
}
