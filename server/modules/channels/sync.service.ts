import { eq, and, sql, inArray } from "drizzle-orm";
import { getSettingsForWarehouse } from "../warehouse/settings.resolver";
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
  productLineProducts,
  channelProductLines,
  warehouseSettings,
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
import { isInventoryManagedVariant } from "@shared/catalog/variant-inventory-eligibility";
import { isCustomerSellableVariant } from "@shared/catalog/variant-sales-eligibility";
import { ChannelIdentityService } from "./channel-identity.service";
import { ChannelIdentityError } from "./channel-identity.domain";
import { describeAllocationFailure } from "./allocation-engine.errors";
import { logger } from "../../platform/observability/logger";
import type { InventorySyncResult } from "./echelon-sync-orchestrator.service";

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
  private readonly MAX_RETRIES = 3;

  /** Cached kill switch — loaded once, refreshed on demand */
  private _syncEnabled: boolean | null = null;

  /** Optional orchestrator retained for legacy direct sync compatibility. */
  private orchestrator: any | null = null;
  private inventoryChangePublisher: ((productVariantId: number, triggeredBy: string) => Promise<void>) | null = null;

  constructor(
    private readonly db: DrizzleDb,
    private readonly atpService: InventoryAtpService,
  ) {}

  /** Wire the compatibility orchestrator after construction. */
  setOrchestrator(orchestrator: any): void {
    this.orchestrator = orchestrator;
    console.log("[ChannelSync] Orchestrator wired — event-driven syncs will use Allocation Engine");
  }

  setInventoryChangePublisher(
    publisher: (productVariantId: number, triggeredBy: string) => Promise<void>,
  ): void {
    this.inventoryChangePublisher = publisher;
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
      } catch (err: unknown) {
        // Do NOT fall back to legacy allocation — the orchestrator is the
        // single source of truth. Falling back to legacy logic (which uses
        // channel.allocationPct / allocationFixedQty instead of
        // channel_allocation_rules) could produce wrong quantities. Nothing is
        // published for this product on this run; the next trigger retries.
        const failure = describeAllocationFailure(err);
        logger[failure.error_class === "transient" ? "warn" : "error"]("inventory_sync_product", {
          outcome: "skipped",
          product_id: productId,
          triggered_by: triggeredBy ?? "channel_sync",
          error_code: failure.error_code,
          error_class: failure.error_class,
          error: failure.message,
        });
        return {
          productId,
          synced: 0,
          errors: [`Orchestrator failed (${failure.error_code}): ${failure.message}`],
          variants: [],
        };
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
      const syncResult = channelId != null && this.orchestrator
        ? legacyResultFromOrchestrator(productId, await this.orchestrator.syncInventoryForChannelProduct(
            channelId,
            productId,
            { dryRun: false },
            "manual_channel_sync",
          ))
        : await this.syncProduct(productId, "manual");
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
   * The injected publication coordinator resolves runtime authority and every
   * effective publication control; this compatibility method never decides
   * those settings itself.
   */
  async queueSyncAfterInventoryChange(
    productVariantId: number,
    triggeredBy?: string,
  ): Promise<void> {
    if (!Number.isSafeInteger(productVariantId) || productVariantId <= 0) {
      throw new Error("productVariantId must be a positive safe integer");
    }
    if (!this.inventoryChangePublisher) {
      throw new Error("Authority-aware inventory change publisher is not wired");
    }
    await this.inventoryChangePublisher(
      productVariantId,
      triggeredBy?.trim() || "inventory_change",
    );
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
    const identityService = new ChannelIdentityService(this.db);
    const blocked: string[] = [];
    let created = 0;
    for (const channel of activeChannels) {
      // Discovery repairs missing feed rows from this channel's listings only.
      // The provider reader verifies each candidate against this exact account.
      const listings = await identityService.listingIdentities(channel.id, allVariants.map((variant) => variant.id));
      const listedVariants = new Set(listings.filter((listing) => listing.externalVariantId).map((listing) => listing.productVariantId));
      const allowedLines = new Set<number>(channelLineRows.filter((row: { channelId: number }) => row.channelId === channel.id)
        .map((row: { productLineId: number }) => row.productLineId));
      for (const variant of allVariants) {
        if (existingSet.has(`${channel.id}:${variant.id}`) || !listedVariants.has(variant.id)) continue;
        if (allowedLines.size > 0 && !productLineRows.some((row: { productId: number; productLineId: number }) =>
          row.productId === variant.productId && allowedLines.has(row.productLineId))) continue;
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
        requiresShipping: productVariants.requiresShipping,
        trackInventory: productVariants.trackInventory,
        salesEligibility: productVariants.salesEligibility,
      })
      .from(productVariants)
      .where(eq(productVariants.id, feed.productVariantId))
      .limit(1);

    if (!variantRow?.shopifyInventoryItemId) {
      throw new Error(
        `Variant ${feed.productVariantId} has no shopifyInventoryItemId — run Shopify product sync first`,
      );
    }
    if (!isInventoryManagedVariant(variantRow)) {
      throw new Error(
        `Variant ${feed.productVariantId} is digital or inventory-untracked; quantity publication is prohibited`,
      );
    }
    if (!isCustomerSellableVariant(variantRow)) {
      throw new Error(
        `Variant ${feed.productVariantId} is internal-only; quantity publication is prohibited`,
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

function legacyResultFromOrchestrator(productId: number, rows: readonly InventorySyncResult[]): SyncResult {
  const result: SyncResult = { productId, synced: 0, errors: [], variants: [] };
  for (const row of rows) {
    result.synced += row.variantsPushed ?? 0;
    for (const detail of row.details ?? []) {
      if (detail.status === "error" && detail.error) result.errors.push(`${detail.sku}: ${detail.error}`);
      result.variants.push({
        productVariantId: detail.variantId,
        channelVariantId: "",
        pushedQty: detail.allocatedQty,
        atpBase: 0,
        status: detail.status,
      });
    }
  }
  return result;
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
