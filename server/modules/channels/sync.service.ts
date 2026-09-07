import { eq, and, sql, inArray } from "drizzle-orm";
import { getSettingsForWarehouse } from "../warehouse/settings.resolver";
import {
  channelFeeds,
  channelWarehouseAssignments,
  channelReservations,
  channelProductAllocation,
  channelSyncLog,
  channels,
  productVariants,
  products,
  warehouses,
  productLineProducts,
  channelProductLines,
} from "@shared/schema";
import type {
  ChannelFeed,
  ChannelReservation,
  ChannelProductAllocation,
  Channel,
  ProductVariant,
  Product,
  Warehouse,
} from "@shared/schema";
import { isInventoryManagedVariant } from "@shared/catalog/variant-inventory-eligibility";
import { isCustomerSellableVariant } from "@shared/catalog/variant-sales-eligibility";
import { ChannelIdentityService } from "./channel-identity.service";
import { ChannelIdentityError } from "./channel-identity.domain";
import { ShopifyAdapter } from "./adapters/shopify.adapter";

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

  /**
   * Optional reference to the Echelon sync orchestrator.
   * When set, event-driven syncs (queueSyncAfterInventoryChange) will
   * delegate to the orchestrator which respects channel_allocation_rules.
   * Set via setOrchestrator() after construction to break circular deps.
   */
  private orchestrator: any | null = null;

  constructor(
    private readonly db: DrizzleDb,
    private readonly atpService: InventoryAtpService,
  ) {}

  /**
   * Wire the Echelon sync orchestrator into this service.
   * Must be called after the orchestrator is created (breaks circular dependency).
   * Once set, all event-driven syncs route through the orchestrator which
   * uses the Allocation Engine (channel_allocation_rules).
   */
  setOrchestrator(orchestrator: any): void {
    this.orchestrator = orchestrator;
    console.log("[ChannelSync] Orchestrator wired — event-driven syncs will use Allocation Engine");
  }

  /** Check if channel sync is enabled (cached, lazy-loaded) */
  private async isSyncEnabled(): Promise<boolean> {
    if (this._syncEnabled !== null) return this._syncEnabled;
    await this.refreshSyncEnabled();
    return this._syncEnabled!;
  }

  /**
   * Reload the global kill switch from the DEFAULT warehouse_settings row.
   * Previously read via LIMIT 1 — picked an arbitrary row, which was a
   * correctness bug once multiple warehouses existed. The DEFAULT row
   * is now the global template; per-warehouse overrides happen at
   * push time in the orchestrator.
   */
  async refreshSyncEnabled(): Promise<boolean> {
    try {
      const row = await getSettingsForWarehouse(null, this.db as any);
      this._syncEnabled = (row?.channelSyncEnabled ?? 0) === 1;
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

    // ── Orchestrator delegation ──────────────────────────────────────────
    // When the Echelon orchestrator is wired, delegate to it so that
    // channel_allocation_rules (fixed/share/mirror) are respected.
    // The old allocation logic below is kept as fallback only.
    if (this.orchestrator) {
      try {
        const orchResults = await this.orchestrator.syncInventoryForProduct(
          productId,
          { dryRun: false },
          triggeredBy ?? "channel_sync",
        );

        // Convert orchestrator results to legacy SyncResult format
        const result: SyncResult = { productId, synced: 0, errors: [], variants: [] };
        for (const r of orchResults) {
          result.synced += r.variantsPushed;
          for (const d of r.details) {
            if (d.status === "error" && d.error) {
              result.errors.push(`${d.sku}: ${d.error}`);
            }
            result.variants.push({
              productVariantId: d.variantId,
              channelVariantId: "",
              pushedQty: d.allocatedQty,
              atpBase: 0,
              status: d.status,
            });
          }
        }
        return result;
      } catch (err: any) {
        // Do NOT fall back to legacy allocation — the orchestrator is the
        // single source of truth. Falling back to legacy logic (which uses
        // channel.allocationPct / allocationFixedQty instead of
        // channel_allocation_rules) could produce wrong quantities.
        console.error(
          `[ChannelSync] Orchestrator delegation failed for product ${productId} — ` +
            `NOT falling back to legacy allocation: ${err.message}`,
        );
        return { productId, synced: 0, errors: [`Orchestrator failed: ${err.message}`], variants: [] };
      }
    }

    // No orchestrator wired — this is a configuration error in Echelon.
    // The orchestrator must be set via setOrchestrator() after construction.
    console.error(
      `[ChannelSync] No orchestrator wired for syncProduct(${productId}). ` +
        `Legacy allocation path has been removed — wire the orchestrator via setOrchestrator().`,
    );
    return {
      productId,
      synced: 0,
      errors: ["No orchestrator wired — cannot sync without allocation engine"],
      variants: [],
    };
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
      .where(and(
        inArray(productVariants.id, variantIds),
        eq(productVariants.requiresShipping, true),
        sql`COALESCE(${productVariants.trackInventory}, true) = true`,
        eq(productVariants.salesEligibility, "sellable"),
      ));

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
   *
   * Now respects the Echelon sync control hierarchy:
   * 1. Check sync_settings.global_enabled
   * 2. Check per-channel sync_enabled
   * 3. Respect sync_mode (live vs dry_run)
   * 4. Log to sync_log
   */
  async queueSyncAfterInventoryChange(
    productVariantId: number,
    triggeredBy?: string,
  ): Promise<void> {
    // Check new sync control hierarchy first
    try {
      const { syncSettings: syncSettingsTable } = await import("@shared/schema");
      const [globalSettings] = await this.db
        .select()
        .from(syncSettingsTable)
        .limit(1);

      if (globalSettings && !globalSettings.globalEnabled) {
        return; // Global sync disabled
      }
    } catch {
      // Fallback to old kill switch if sync_settings table doesn't exist yet
      if (!(await this.isSyncEnabled())) return;
    }

    const [variant] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, productVariantId))
      .limit(1);

    if (!variant) {
      console.warn(`[ChannelSync] Cannot queue sync: variant ${productVariantId} not found`);
      return;
    }
    if (!isCustomerSellableVariant(variant)) {
      console.warn(`[ChannelSync] Cannot queue sync: variant ${productVariantId} is internal-only`);
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
        // Check per-channel sync settings before syncing
        const feedChannelIds = await this.db
          .select({ channelId: channelFeeds.channelId })
          .from(channelFeeds)
          .where(and(
            eq(channelFeeds.productVariantId, productVariantId),
            eq(channelFeeds.isActive, 1),
          ));

        const uniqueChannelIds = [...new Set(feedChannelIds.map((f: any) => f.channelId).filter(Boolean))];

        // Check which channels have sync enabled
        if (uniqueChannelIds.length > 0) {
          const channelRows = await this.db
            .select()
            .from(channels)
            .where(inArray(channels.id, uniqueChannelIds as number[]));

          const hasAnyEnabled = channelRows.some((c: any) => c.syncEnabled === true);
          if (!hasAnyEnabled) {
            return; // No channels have sync enabled
          }

          // Check if any channels are in dry-run mode — log but still sync (live channels proceed normally)
          for (const ch of channelRows) {
            if ((ch as any).syncEnabled && (ch as any).syncMode === "dry_run") {
              // Log dry-run event
              try {
                const { syncLog: syncLogTable } = await import("@shared/schema");
                await this.db.insert(syncLogTable).values({
                  channelId: ch.id,
                  channelName: ch.name,
                  action: "inventory_push",
                  productVariantId: productVariantId,
                  status: "dry_run",
                  source: "event",
                });
              } catch {
                // Don't let logging failures block sync
              }
            }
          }
        }

        await this.syncProduct(productId, triggeredBy ?? "inventory_change");

        // Log event-driven sync to sync_log
        try {
          const { syncLog: syncLogTable } = await import("@shared/schema");
          for (const chId of uniqueChannelIds) {
            const ch = (await this.db.select().from(channels).where(eq(channels.id, chId as number)).limit(1))[0];
            if (ch && (ch as any).syncEnabled && (ch as any).syncMode === "live") {
              await this.db.insert(syncLogTable).values({
                channelId: ch.id,
                channelName: ch.name,
                action: "inventory_push",
                productVariantId: productVariantId,
                status: "pushed",
                source: "event",
              });
            }
          }
        } catch {
          // Don't let logging failures block
        }
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
      if (!isInventoryManagedVariant(variant)) continue;
      if (!isCustomerSellableVariant(variant)) continue;

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
  async discoverFeeds(): Promise<{ created: number; channels: number; blocked: string[] }> {
    const activeChannels: Channel[] = await this.db.select().from(channels)
      .where(and(eq(channels.status, "active"), eq(channels.provider, "shopify")));
    const allVariants: ProductVariant[] = await this.db.select().from(productVariants).where(and(
      eq(productVariants.isActive, true), eq(productVariants.requiresShipping, true),
      sql`COALESCE(${productVariants.trackInventory}, true) = true`,
      eq(productVariants.salesEligibility, "sellable"),
    ));
    const existingFeeds: ChannelFeed[] = await this.db.select().from(channelFeeds);
    const existingSet = new Set(existingFeeds.map((feed) => `${feed.channelId}:${feed.productVariantId}`));
    const channelLineRows = await this.db.select().from(channelProductLines).where(eq(channelProductLines.isActive, true));
    const productLineRows = await this.db.select().from(productLineProducts);
    const linesByProduct = new Map<number, Set<number>>();
    for (const row of productLineRows) {
      const lines = linesByProduct.get(row.productId) ?? new Set<number>();
      lines.add(row.productLineId);
      linesByProduct.set(row.productId, lines);
    }
    const identityService = new ChannelIdentityService(this.db);
    const blocked: string[] = [];
    let created = 0;
    for (const channel of activeChannels) {
      // Discovery repairs missing feed rows from this channel's listings only.
      // The provider reader verifies each candidate against this exact account.
      const listings = await identityService.listingIdentities(channel.id, allVariants.map((variant) => variant.id));
      const listedVariants = new Set(listings.filter((listing) => listing.externalVariantId && listing.syncStatus !== "requires_review").map((listing) => listing.productVariantId));
      const allowedLines = new Set<number>(channelLineRows.filter((row: { channelId: number }) => row.channelId === channel.id)
        .map((row: { productLineId: number }) => row.productLineId));
      for (const variant of allVariants) {
        if (existingSet.has(`${channel.id}:${variant.id}`) || !listedVariants.has(variant.id)) continue;
        const productLines = linesByProduct.get(variant.productId);
        if (productLines?.size && !hasOverlap(productLines, allowedLines)) continue;
        try {
          await identityService.ensureShopifyFeed({ channelId: channel.id, productVariantId: variant.id, sku: variant.sku, actor: "channel-feed-discovery" });
          created++;
        } catch (error) {
          const code = error instanceof ChannelIdentityError ? error.code : "CHANNEL_FEED_DISCOVERY_FAILED";
          blocked.push(`${channel.id}:${variant.id}:${code}`);
        }
      }
    }
    if (blocked.length > 0) console.warn(JSON.stringify({ action: "channel_feed.discovery", outcome: "blocked", blocked }));
    return { created, channels: activeChannels.length, blocked };
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
        if (err instanceof ChannelIdentityError && err.failureClass === "permanent") throw err;
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

  private async pushToShopify(feed: ChannelFeed, _atpUnits: number): Promise<void> {
    if (!feed.channelId || !feed.channelInventoryItemId || feed.isActive !== 1 || feed.quarantinedAt) {
      throw new ChannelIdentityError("CHANNEL_INVENTORY_MAPPING_REQUIRED", "An active, non-quarantined destination inventory mapping is required");
    }
    await new ChannelIdentityService(this.db).shopifyConnection(feed.channelId);
    const [variant] = await this.db.select({ productId: productVariants.productId,
      requiresShipping: productVariants.requiresShipping, trackInventory: productVariants.trackInventory,
      salesEligibility: productVariants.salesEligibility,
    }).from(productVariants).where(eq(productVariants.id, feed.productVariantId)).limit(1);
    if (!variant || !isInventoryManagedVariant(variant) || !isCustomerSellableVariant(variant)) {
      throw new ChannelIdentityError("CHANNEL_VARIANT_INELIGIBLE", "Only sellable, inventory-managed variants may publish quantities");
    }
    const assignments: Array<{ warehouseId: number }> = await this.db.select({ warehouseId: channelWarehouseAssignments.warehouseId })
      .from(channelWarehouseAssignments).where(and(eq(channelWarehouseAssignments.channelId, feed.channelId), eq(channelWarehouseAssignments.enabled, true)));
    if (assignments.length === 0) throw new ChannelIdentityError("CHANNEL_WAREHOUSE_REQUIRED", "No warehouses are explicitly assigned to this channel");
    const warehouseRows: Warehouse[] = await this.db.select().from(warehouses).where(and(
      inArray(warehouses.id, assignments.map((assignment) => assignment.warehouseId)), eq(warehouses.isActive, 1),
      sql`COALESCE(${warehouses.inventorySourceType}, 'internal') = 'internal'`,
    ));
    const breakdown: Array<{ warehouseId: number; externalLocationId: string; qty: number }> = [];
    const locations = new Set<string>();
    for (const warehouse of warehouseRows) {
      if (!warehouse.shopifyLocationId || locations.has(warehouse.shopifyLocationId)) {
        throw new ChannelIdentityError("CHANNEL_LOCATION_AMBIGUOUS", "Assigned warehouses require distinct explicit provider locations");
      }
      locations.add(warehouse.shopifyLocationId);
      const atp = await this.atpService.getAtpPerVariantByWarehouse(variant.productId, warehouse.id);
      const quantity = atp.find((item) => item.productVariantId === feed.productVariantId)?.atpUnits ?? 0;
      if (!Number.isSafeInteger(quantity) || quantity < 0) throw new ChannelIdentityError("CHANNEL_QUANTITY_INVALID", "Allocated inventory quantity is invalid");
      breakdown.push({ warehouseId: warehouse.id, externalLocationId: warehouse.shopifyLocationId, qty: quantity });
    }
    if (breakdown.length === 0) throw new ChannelIdentityError("CHANNEL_WAREHOUSE_REQUIRED", "No assigned internal-stock warehouse is eligible for publication");
    const quantity = breakdown.reduce((total, item) => total + item.qty, 0);
    if (!Number.isSafeInteger(quantity)) throw new ChannelIdentityError("CHANNEL_QUANTITY_INVALID", "Combined inventory quantity exceeds the supported range");
    const results = await new ShopifyAdapter(this.db).pushInventory(feed.channelId, [{
      variantId: feed.productVariantId, sku: feed.channelSku, externalVariantId: feed.channelVariantId,
      externalInventoryItemId: feed.channelInventoryItemId, allocatedQty: quantity, warehouseBreakdown: breakdown,
    }]);
    if (results.length !== 1 || results[0].status !== "success") {
      throw new ChannelIdentityError("CHANNEL_INVENTORY_PUSH_FAILED", results[0]?.error || "Provider did not confirm inventory publication", results[0]?.retryable === false ? "permanent" : "transient");
    }
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
// Helpers
// ---------------------------------------------------------------------------

/** Check if two sets share at least one element */
function hasOverlap(a: Set<number>, b: Set<number>): boolean {
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of smaller) {
    if (larger.has(v)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChannelSyncService(db: any, atpService: any) {
  return new ChannelSyncService(db, atpService);
}
