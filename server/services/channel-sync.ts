import { eq, and, sql, inArray } from "drizzle-orm";
import {
  channelFeeds,
  channelConnections,
  channels,
  productVariants,
  products,
  warehouses,
} from "@shared/schema";
import type {
  ChannelFeed,
  ChannelConnection,
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

/**
 * Result of syncing a single product's inventory to all active channels.
 */
export interface SyncResult {
  productId: number;
  synced: number;
  errors: string[];
  variants: Array<{
    productVariantId: number;
    channelVariantId: string;
    pushedQty: number;
  }>;
}

/**
 * Channel sync service for the Echelon WMS.
 *
 * Pushes fungible ATP (Available-to-Promise) quantities to external sales
 * channels (Shopify, future Amazon/eBay). This is a ONE-WAY PUSH only --
 * channels never write back to Echelon inventory.
 *
 * The service reads ATP from the InventoryService, then for each variant
 * with an active `channel_feeds` entry, pushes the quantity to the
 * corresponding channel API.
 *
 * Design principles:
 * - Receives `db` and `atpService` via constructor -- no global singletons.
 * - Rate-limits Shopify API calls with configurable delays.
 * - Records last-synced state on `channel_feeds` for monitoring.
 * - Extensible: new channel providers can be added by extending
 *   the `pushToChannel` method.
 */
class ChannelSyncService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly atpService: InventoryAtpService,
  ) {}

  // ---------------------------------------------------------------------------
  // 1. SYNC PRODUCT -- push ATP for a single product to all active channels
  // ---------------------------------------------------------------------------

  /**
   * Calculate fungible ATP for every variant of the given product, then push
   * the quantity to each active channel feed entry.
   *
   * For Shopify channels, this calls the Inventory Levels `set.json` REST API
   * endpoint. Other channel providers can be added in the future.
   *
   * @param productId  The internal product ID to sync.
   * @returns A `SyncResult` with counts of synced feeds and any errors.
   */
  async syncProduct(productId: number): Promise<SyncResult> {
    const result: SyncResult = {
      productId,
      synced: 0,
      errors: [],
      variants: [],
    };

    // Get the product and its variants
    const [product] = await this.db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);

    if (!product) {
      result.errors.push(`Product ${productId} not found`);
      return result;
    }

    // Calculate fungible ATP for all variants of this product
    const variantAtp = await this.atpService.getAtpPerVariant(productId);
    const atpByVariantId = new Map(
      variantAtp.map((v) => [v.productVariantId, v]),
    );

    const variantIds = variantAtp.map((v) => v.productVariantId);
    if (variantIds.length === 0) {
      return result;
    }

    // Get active channel feeds for these variants
    const feeds: ChannelFeed[] = await this.db
      .select()
      .from(channelFeeds)
      .where(
        and(
          inArray(channelFeeds.productVariantId, variantIds),
          eq(channelFeeds.isActive, 1),
        ),
      );

    if (feeds.length === 0) {
      return result;
    }

    // Push each feed
    for (const feed of feeds) {
      const atp = atpByVariantId.get(feed.productVariantId);
      const atpUnits = atp?.atpUnits ?? 0;

      try {
        await this.pushToChannel(feed, atpUnits);

        // Update the feed's sync state
        await this.db
          .update(channelFeeds)
          .set({
            lastSyncedQty: atpUnits,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(channelFeeds.id, feed.id));

        result.synced += 1;
        result.variants.push({
          productVariantId: feed.productVariantId,
          channelVariantId: feed.channelVariantId,
          pushedQty: atpUnits,
        });
      } catch (err: any) {
        const message =
          `Failed to sync variant ${feed.productVariantId} ` +
          `to channel ${feed.channelType}/${feed.channelVariantId}: ` +
          `${err.message ?? err}`;
        result.errors.push(message);
        console.error(`[ChannelSync] ${message}`);
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // 2. SYNC ALL PRODUCTS -- batch sync with rate limiting
  // ---------------------------------------------------------------------------

  /**
   * Sync inventory for all products (or all products on a specific channel).
   *
   * Iterates through every product that has at least one active channel feed
   * and calls `syncProduct` for each. Introduces a 300ms delay between
   * Shopify API calls to respect rate limits.
   *
   * @param channelId  Optional -- limit the sync to feeds for a specific
   *                   channel (by channel type, e.g., "shopify").
   * @returns Aggregate counts of total products attempted, synced, and errors.
   */
  async syncAllProducts(
    channelId?: number,
  ): Promise<{ total: number; synced: number; errors: string[] }> {
    const aggregated = { total: 0, synced: 0, errors: [] as string[] };

    // Get all active feeds (optionally filtered by channel)
    let feedQuery = this.db
      .select({
        productVariantId: channelFeeds.productVariantId,
      })
      .from(channelFeeds)
      .where(eq(channelFeeds.isActive, 1));

    // If channelId is specified, join to product_variants to filter
    // channel feeds by a specific channel record. For now, we filter
    // by looking at the channel_feeds table and cross-referencing.
    const allActiveFeeds = await feedQuery;

    // Resolve unique product IDs from variant IDs
    const variantIds: number[] = Array.from(new Set(allActiveFeeds.map((f: any) => f.productVariantId as number)));
    if (variantIds.length === 0) return aggregated;

    const variantRows: ProductVariant[] = await this.db
      .select()
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds));

    const productIds = Array.from(new Set(variantRows.map((v) => v.productId)));

    // If channelId is provided, further filter to products that have feeds
    // associated with that channel
    let filteredProductIds = productIds;
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

      // Filter feeds by channel type matching this channel's provider
      const channelFedsForProvider: ChannelFeed[] = await this.db
        .select()
        .from(channelFeeds)
        .where(
          and(
            eq(channelFeeds.isActive, 1),
            eq(channelFeeds.channelType, channel.provider),
          ),
        );

      const channelVariantIds = new Set(
        channelFedsForProvider.map((f) => f.productVariantId),
      );
      const channelVariantRows = variantRows.filter((v) =>
        channelVariantIds.has(v.id),
      );
      filteredProductIds = Array.from(new Set(channelVariantRows.map((v) => v.productId)));
    }

    aggregated.total = filteredProductIds.length;

    for (const productId of filteredProductIds) {
      const syncResult = await this.syncProduct(productId);
      aggregated.synced += syncResult.synced;
      aggregated.errors.push(...syncResult.errors);

      // Rate limit: 300ms delay between products to respect Shopify API limits
      await this.delay(300);
    }

    return aggregated;
  }

  // ---------------------------------------------------------------------------
  // 3. QUEUE SYNC AFTER INVENTORY CHANGE -- reactive trigger
  // ---------------------------------------------------------------------------

  /**
   * Trigger a sync for the product that owns the given variant. Called after
   * any inventory mutation (receive, pick, adjustment, transfer) so that
   * channel quantities stay current.
   *
   * For now this calls `syncProduct` directly. In the future this can be
   * replaced with an async job queue (e.g., BullMQ, pg-boss) for better
   * throughput and retry handling.
   *
   * @param productVariantId  The variant whose inventory just changed.
   */
  async queueSyncAfterInventoryChange(
    productVariantId: number,
  ): Promise<void> {
    // Find which product this variant belongs to
    const [variant] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, productVariantId))
      .limit(1);

    if (!variant) {
      console.warn(
        `[ChannelSync] Cannot queue sync: variant ${productVariantId} not found`,
      );
      return;
    }

    // Check if this variant has any active feeds before triggering a sync
    const [feed] = await this.db
      .select()
      .from(channelFeeds)
      .where(
        and(
          eq(channelFeeds.productVariantId, productVariantId),
          eq(channelFeeds.isActive, 1),
        ),
      )
      .limit(1);

    if (!feed) {
      // No active feeds for this variant -- nothing to sync
      return;
    }

    try {
      await this.syncProduct(variant.productId);
    } catch (err: any) {
      console.error(
        `[ChannelSync] Failed to sync product ${variant.productId} ` +
        `after inventory change on variant ${productVariantId}: ${err.message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 4. GET LAST SYNC STATUS -- monitoring endpoint
  // ---------------------------------------------------------------------------

  /**
   * Return the last sync status for all active channel feeds, optionally
   * filtered by channel ID. Useful for admin monitoring dashboards.
   *
   * @param channelId  Optional -- filter to a specific channel.
   * @returns Array of sync status records with variant IDs, channel IDs,
   *          last synced quantities, and timestamps.
   */
  async getLastSyncStatus(
    channelId?: number,
  ): Promise<
    Array<{
      productVariantId: number;
      channelVariantId: string;
      lastSyncedQty: number;
      lastSyncedAt: Date | null;
    }>
  > {
    let query;

    if (channelId != null) {
      // Look up the channel to get its provider type
      const [channel] = await this.db
        .select()
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1);

      if (!channel) return [];

      query = this.db
        .select({
          productVariantId: channelFeeds.productVariantId,
          channelVariantId: channelFeeds.channelVariantId,
          lastSyncedQty: channelFeeds.lastSyncedQty,
          lastSyncedAt: channelFeeds.lastSyncedAt,
        })
        .from(channelFeeds)
        .where(
          and(
            eq(channelFeeds.isActive, 1),
            eq(channelFeeds.channelType, channel.provider),
          ),
        );
    } else {
      query = this.db
        .select({
          productVariantId: channelFeeds.productVariantId,
          channelVariantId: channelFeeds.channelVariantId,
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
      lastSyncedQty: row.lastSyncedQty ?? 0,
      lastSyncedAt: row.lastSyncedAt ?? null,
    }));
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Push an ATP quantity to the appropriate channel API based on the feed's
   * channel type. Currently supports Shopify; other providers can be added
   * as additional cases.
   *
   * @param feed      The channel feed entry describing which external variant to update.
   * @param atpUnits  The available-to-promise quantity to push.
   * @throws On API errors or missing configuration.
   */
  private async pushToChannel(
    feed: ChannelFeed,
    atpUnits: number,
  ): Promise<void> {
    switch (feed.channelType) {
      case "shopify":
        await this.pushToShopify(feed, atpUnits);
        break;

      case "amazon":
      case "ebay":
        // Future: implement marketplace-specific push logic
        console.warn(
          `[ChannelSync] Channel type "${feed.channelType}" not yet implemented`,
        );
        break;

      default:
        console.warn(
          `[ChannelSync] Unknown channel type "${feed.channelType}" for feed ${feed.id}`,
        );
    }
  }

  /**
   * Push inventory quantity to Shopify via the Inventory Levels `set.json`
   * REST API endpoint.
   *
   * Reads credentials from the channel's `channel_connections` record
   * (per-channel, not env vars). Supports multiple Shopify locations:
   * queries all warehouses with a `shopify_location_id` configured and
   * pushes that warehouse's ATP to the corresponding Shopify location.
   * Falls back to `SHOPIFY_LOCATION_ID` env var with global ATP if no
   * warehouses are configured.
   *
   * @param feed      The channel feed with `channelVariantId` containing the
   *                  Shopify inventory item ID.
   * @param atpUnits  The global ATP quantity (used as fallback).
   * @throws On missing credentials or Shopify API errors.
   */
  private async pushToShopify(
    feed: ChannelFeed,
    atpUnits: number,
  ): Promise<void> {
    // Read credentials from the channel's stored connection
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
    const shopifyDomain = conn.shopDomain;
    const accessToken = conn.accessToken;

    // Resolve the Shopify inventory_item_id and product_id from product_variants
    // (channelVariantId stores the Shopify variant ID, NOT the inventory item ID)
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
        `Variant ${feed.productVariantId} has no shopifyInventoryItemId — ` +
        `run Shopify product sync first to populate it`,
      );
    }
    const shopifyInventoryItemId = variantRow.shopifyInventoryItemId;

    // Look up managed warehouses with Shopify location IDs configured
    // Only push for internal-source warehouses (Echelon is truth).
    // External warehouses (3PL/channel/integration) manage their own Shopify inventory.
    const warehouseRows: Warehouse[] = await this.db
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.isActive, 1),
          sql`${warehouses.shopifyLocationId} IS NOT NULL`,
          sql`COALESCE(${warehouses.inventorySourceType}, 'internal') = 'internal'`,
        ),
      );

    if (warehouseRows.length > 0) {
      // Multi-warehouse mode: push per-warehouse ATP to each Shopify location
      for (const wh of warehouseRows) {
        const warehouseAtp = await this.atpService.getAtpPerVariantByWarehouse(
          variantRow.productId,
          wh.id,
        );
        const variantAtp = warehouseAtp.find(
          (v) => v.productVariantId === feed.productVariantId,
        );
        const qty = variantAtp?.atpUnits ?? 0;

        await this.pushToShopifyLocation(
          shopifyDomain,
          accessToken,
          shopifyInventoryItemId,
          wh.shopifyLocationId!,
          qty,
        );
      }
    } else {
      // Fallback: single location from env var (backward compatible)
      const shopifyLocationId = process.env.SHOPIFY_LOCATION_ID;
      if (!shopifyLocationId) {
        throw new Error(
          "No warehouses with shopify_location_id configured and " +
          "SHOPIFY_LOCATION_ID environment variable is not set",
        );
      }

      await this.pushToShopifyLocation(
        shopifyDomain,
        accessToken,
        shopifyInventoryItemId,
        shopifyLocationId,
        atpUnits,
      );
    }
  }

  /**
   * Push a single inventory level to a specific Shopify location.
   */
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
      throw new Error(
        `Shopify API error ${response.status} for location ${shopifyLocationId}: ${body}`,
      );
    }

    console.log(
      `[ChannelSync] Pushed ${available} units to Shopify ` +
      `location=${shopifyLocationId} for inventory_item_id=${inventoryItemId}`,
    );
  }

  /**
   * Async delay utility for rate limiting between API calls.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new `ChannelSyncService` bound to the supplied Drizzle
 * database instance and ATP service.
 *
 * ```ts
 * import { db } from "../db";
 * import { createInventoryAtpService } from "./services/inventory-atp";
 * import { createChannelSyncService } from "./services/channel-sync";
 *
 * const atp = createInventoryAtpService(db);
 * const channelSync = createChannelSyncService(db, atp);
 * await channelSync.syncProduct(42);
 * ```
 */
export function createChannelSyncService(db: any, atpService: any) {
  return new ChannelSyncService(db, atpService);
}
