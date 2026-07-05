/**
 * Echelon Sync Orchestrator
 *
 * The central wiring service that makes Echelon the source of truth for
 * Shopify. Coordinates between:
 *   - Allocation Engine (computes ATP per channel per variant)
 *   - Source Lock Service (determines sync direction per field)
 *   - Channel Adapters (pushes data to/pulls data from channels)
 *   - Product Push Service (resolves canonical product data)
 *
 * This service replaces the direct inventory push in sync.service.ts with
 * allocation-aware pushes through the adapter interface.
 *
 * All push operations support DRY_RUN mode.
 */

import { eq, and, or, isNull, isNotNull, sql, inArray } from "drizzle-orm";
import { clearVelocityCache } from "./allocation-engine.service";
import {
  products,
  productVariants,
  channels,
  channelFeeds,
  channelListings,
  channelPricing,
  channelSyncLog,
  channelConnections,
  channelWarehouseAssignments,
  channelAllocationRules,
  warehouses,
  warehouseLocations,
  productLocations,
  inventoryLevels,
  type Product,
  type ProductVariant,
  type Channel,
  type ChannelFeed,
  type ChannelListing,
  type ChannelPricing as ChannelPricingType,
} from "@shared/schema";

import type {
  IChannelAdapter,
  InventoryPushItem,
  InventoryPushResult,
  PricingPushItem,
  PricingPushResult,
  ChannelListingPayload,
  ListingPushResult,
} from "./channel-adapter.interface";
import { ChannelAdapterRegistry } from "./channel-adapter.interface";
import type { AllocationEngine, ProductAllocationResult } from "./allocation-engine.service";
import type { SourceLockService } from "./source-lock.service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: <T = any>(query: any) => Promise<{ rows: T[] }>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

type ProductPushService = {
  getResolvedProductForChannel: (productId: number, channelId: number) => Promise<any>;
};

type AtpService = {
  getAtpBase(productId: number): Promise<number>;
  getAtpPerVariant(productId: number): Promise<Array<{
    productVariantId: number;
    sku: string;
    name: string;
    unitsPerVariant: number;
    atpUnits: number;
    atpBase: number;
  }>>;
  getAtpPerVariantByWarehouse(productId: number, warehouseId: number): Promise<Array<{
    productVariantId: number;
    sku: string;
    name: string;
    unitsPerVariant: number;
    atpUnits: number;
    atpBase: number;
  }>>;
  getAtpBaseByWarehouse(productId: number, warehouseId: number): Promise<number>;
  getDirectVariantAtpByWarehouse(variantIds: number[], warehouseId: number): Promise<Map<number, number>>;
};

export interface SyncOrchestratorConfig {
  /** If true, log what would happen without making external API calls */
  dryRun: boolean;
}

export interface InventorySyncResult {
  channelId: number;
  channelName: string;
  dryRun: boolean;
  products: number;
  variantsPushed: number;
  variantsSkipped: number;
  variantsErrored: number;
  details: Array<{
    productId: number;
    variantId: number;
    sku: string | null;
    allocatedQty: number;
    previousQty: number | null;
    status: string;
    error?: string;
  }>;
}

export interface PricingSyncResult {
  channelId: number;
  channelName: string;
  dryRun: boolean;
  variantsPushed: number;
  variantsSkipped: number;
  variantsErrored: number;
  details: Array<{
    variantId: number;
    sku: string | null;
    priceCents: number;
    compareAtPriceCents: number | null;
    status: string;
    error?: string;
  }>;
}

export interface ListingSyncResult {
  channelId: number;
  channelName: string;
  dryRun: boolean;
  productsProcessed: number;
  pushed: number;
  pulled: number;
  skipped: number;
  errored: number;
  details: Array<{
    productId: number;
    direction: "push" | "pull" | "skip";
    fields: string[];
    status: string;
    error?: string;
  }>;
}

export interface FullSyncResult {
  dryRun: boolean;
  startedAt: Date;
  completedAt: Date;
  inventory: InventorySyncResult[];
  pricing: PricingSyncResult[];
  listings: ListingSyncResult[];
  errors: string[];
}

interface NonShopifyInventorySyncState {
  productVariantId: number;
  feedId: number | null;
  feedLastSyncedQty: number | null;
  feedQuarantinedAt: Date | null;
  channelVariantId: string | null;
  channelSku: string | null;
  channelInventoryItemId: string | null;
  listingId: number | null;
  listingExternalVariantId: string | null;
  listingExternalSku: string | null;
}

interface NonShopifyInventoryPushItem extends InventoryPushItem {
  previousQty: number | null;
  listingId: number | null;
}

// ---------------------------------------------------------------------------
// Permanent-failure quarantine (CLAUDE.md §6: never retry a permanent error)
// ---------------------------------------------------------------------------

/**
 * Consecutive permanent failures before a mapping is quarantined. >1 so a
 * freak false-positive (e.g. Shopify eventual-consistency right after a
 * product is created) cannot retire a healthy mapping.
 */
export const PERMANENT_FAILURE_QUARANTINE_THRESHOLD = 3;

/**
 * True when a push error means the EXTERNAL RESOURCE IS GONE and a retry can
 * never succeed:
 *  - Shopify: "... failed (404) ..." — inventory item / variant deleted
 *  - eBay: [25710]/[25713], or the message-only "Please enter a valid
 *    offerId." variant (prod 2026-07-05) — offerId no longer exists AND the
 *    adapter's by-SKU recovery found nothing fresher
 * Rate limits (429), 5xx, and network errors are transient and never match.
 */
export function isPermanentInventoryPushError(error: string | null | undefined): boolean {
  if (!error) return false;
  return (
    /failed \(404\)/.test(error) ||
    /\[25710\]|\[25713\]/.test(error) ||
    /valid offerId|offerId is invalid/i.test(error)
  );
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class EchelonSyncOrchestrator {
  constructor(
    private readonly db: DrizzleDb,
    private readonly allocationEngine: AllocationEngine,
    private readonly sourceLockService: SourceLockService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly productPushService: ProductPushService,
    private readonly atpService?: AtpService,
  ) {}

  // =========================================================================
  // 1. INVENTORY SYNC — Allocation Engine → Shopify Adapter
  // =========================================================================

  /**
   * Run warehouse-aware inventory sync for a product across all active channels.
   *
   * For each channel:
   *   1. Load assigned warehouses (with Shopify location IDs)
   *   2. For each warehouse, determine which variants exist there
   *      (via product_locations → warehouse_locations)
   *   3. Only push variants that exist at each warehouse
   *   4. Use per-warehouse ATP and the warehouse's Shopify location_id
   *
   * This eliminates 404 errors from pushing variants to locations where
   * the inventory item doesn't exist.
   */
  async syncInventoryForProduct(
    productId: number,
    config: SyncOrchestratorConfig,
    triggeredBy?: string,
  ): Promise<InventorySyncResult[]> {
    const results: InventorySyncResult[] = [];

    // Run allocation engine (still needed for allocation rules: mirror/share/fixed)
    const allocation = await this.allocationEngine.allocateProduct(
      productId,
      triggeredBy ?? "orchestrator",
    );

    if (allocation.allocations.length === 0) {
      console.log(`[SyncOrchestrator] No allocations for product ${productId}`);
      return results;
    }

    // Group allocations by channel
    const byChannel = new Map<number, {
      channel: { id: number; name: string; provider: string };
      allocations: typeof allocation.allocations;
    }>();

    for (const a of allocation.allocations) {
      if (!byChannel.has(a.channelId)) {
        byChannel.set(a.channelId, {
          channel: { id: a.channelId, name: a.channelName, provider: a.channelProvider },
          allocations: [],
        });
      }
      byChannel.get(a.channelId)!.allocations.push(a);
    }

    // Push to each channel — warehouse-aware
    for (const [channelId, data] of byChannel) {
      const channelResult = await this.pushInventoryToChannelWarehouseAware(
        channelId,
        data.channel,
        data.allocations,
        productId,
        config,
        triggeredBy,
      );
      results.push(channelResult);
    }

    return results;
  }

  /**
   * Run allocation and push inventory for ALL active products.
   */
  async syncInventoryForAllProducts(
    config: SyncOrchestratorConfig,
    triggeredBy?: string,
  ): Promise<InventorySyncResult[]> {
    const allResults: InventorySyncResult[] = [];

    const productIds = await this.getInventorySyncProductIds();
    console.log(`[SyncOrchestrator] Syncing inventory for ${productIds.length} products`);

    // Clear velocity cache at start of full sync cycle — each product will query fresh
    clearVelocityCache();

    for (const productId of productIds) {
      try {
        const results = await this.syncInventoryForProduct(productId, config, triggeredBy);
        // Merge results by channel
        for (const result of results) {
          const existing = allResults.find((r) => r.channelId === result.channelId);
          if (existing) {
            existing.products += result.products;
            existing.variantsPushed += result.variantsPushed;
            existing.variantsSkipped += result.variantsSkipped;
            existing.variantsErrored += result.variantsErrored;
            existing.details.push(...result.details);
          } else {
            allResults.push(result);
          }
        }
      } catch (err: any) {
        console.error(`[SyncOrchestrator] Failed to sync inventory for product ${productId}: ${err.message}`);
      }

      // Rate limiting between products
      await this.delay(100);
    }

    return allResults;
  }

  /**
   * Warehouse-aware inventory push for a channel.
   *
   * Instead of pushing all variants to a single location, this method:
   * 1. Loads all warehouses assigned to the channel (with Shopify location IDs)
   * 2. For each warehouse, queries which variants actually exist there
   *    (via product_locations → warehouse_locations)
   * 3. Only pushes variants that exist at each warehouse's Shopify location
   * 4. Uses per-warehouse ATP for quantity calculation
   *
   * This eliminates 404 errors from Shopify when a variant's inventory item
   * doesn't exist at a particular location.
   */
  private async pushInventoryToChannelWarehouseAware(
    channelId: number,
    channel: { id: number; name: string; provider: string },
    allocations: ProductAllocationResult["allocations"],
    productId: number,
    config: SyncOrchestratorConfig,
    triggeredBy?: string,
  ): Promise<InventorySyncResult> {
    const result: InventorySyncResult = {
      channelId,
      channelName: channel.name,
      dryRun: config.dryRun,
      products: 1,
      variantsPushed: 0,
      variantsSkipped: 0,
      variantsErrored: 0,
      details: [],
    };

    // Get adapter
    const adapter = this.adapterRegistry.get(channel.provider);
    if (!adapter) {
      console.warn(`[SyncOrchestrator] No adapter for provider "${channel.provider}"`);
      result.variantsErrored = allocations.length;
      return result;
    }

    // Load assigned warehouses for this channel (enabled only)
    const assignedWarehouses = await this.db
      .select({
        warehouseId: channelWarehouseAssignments.warehouseId,
        shopifyLocationId: warehouses.shopifyLocationId,
        warehouseName: warehouses.name,
      })
      .from(channelWarehouseAssignments)
      .innerJoin(warehouses, eq(warehouses.id, channelWarehouseAssignments.warehouseId))
      .where(
        and(
          eq(channelWarehouseAssignments.channelId, channelId),
          eq(channelWarehouseAssignments.enabled, true),
          isNotNull(warehouses.shopifyLocationId),
        ),
      );

    if (assignedWarehouses.length === 0 && channel.provider !== "ebay") {
      console.log(`[SyncOrchestrator] No enabled warehouses assigned to channel ${channel.name}`);
      return result;
    }

    // For non-Shopify channels (eBay), use allocation engine results directly
    if (channel.provider !== "shopify") {
      const syncStates = await this.getNonShopifyInventorySyncStates(
        channelId,
        allocations.map((a) => a.productVariantId),
      );
      const pushItems: NonShopifyInventoryPushItem[] = [];
      for (const a of allocations) {
        const syncState = syncStates.get(a.productVariantId);
        const previousQty = syncState?.feedLastSyncedQty ?? null;
        const externalVariantId = syncState?.listingExternalVariantId
          ?? syncState?.channelVariantId
          ?? null;
        const externalSku = syncState?.listingExternalSku
          ?? syncState?.channelSku
          ?? a.sku;
        
        // Quarantined mapping — the external resource is gone; skip cleanly
        // instead of re-erroring every sweep (see recordPermanentPushFailure).
        if (syncState?.feedQuarantinedAt) {
          result.variantsSkipped++;
          result.details.push({
            productId,
            variantId: a.productVariantId,
            sku: a.sku,
            previousQty,
            allocatedQty: a.allocatedUnits,
            status: "skipped" as const,
            error: "Mapping quarantined (external resource gone) — re-link or retire",
          });
          continue;
        }

        // Skip if unchanged
        if (previousQty !== null && previousQty === a.allocatedUnits) {
          result.variantsSkipped++;
          result.details.push({
            productId,
            variantId: a.productVariantId,
            sku: a.sku,
            previousQty,
            allocatedQty: a.allocatedUnits,
            status: "skipped" as const,
          });
          continue;
        }

        if (!syncState?.listingId && !syncState?.feedId) {
          result.variantsSkipped++;
          result.details.push({
            productId,
            variantId: a.productVariantId,
            sku: a.sku,
            previousQty,
            allocatedQty: a.allocatedUnits,
            status: "skipped",
            error: "No channel listing or feed target exists for inventory sync",
          });
          continue;
        }

        pushItems.push({
          variantId: a.productVariantId,
          sku: externalSku,
          externalVariantId,
          externalInventoryItemId: syncState?.channelInventoryItemId ?? null,
          allocatedQty: a.allocatedUnits,
          previousQty,
          listingId: syncState?.listingId ?? null,
        });
      }

      if (!config.dryRun && pushItems.length > 0) {
        try {
          const adapter = this.adapterRegistry.get(channel.provider);
          if (adapter) {
            const pushResults = await adapter.pushInventory(channelId, pushItems);
            const pushResultsByVariant = new Map<number, InventoryPushResult>();
            for (const pushResult of pushResults) {
              pushResultsByVariant.set(pushResult.variantId, pushResult);
            }

            for (const item of pushItems) {
              const pushResult = pushResultsByVariant.get(item.variantId);
              const status = pushResult?.status ?? "error";
              const error = pushResult?.error ?? (pushResult ? undefined : "Adapter returned no result for inventory push");

              if (status === "success" || status === "skipped") {
                if (status === "success") {
                  result.variantsPushed++;
                } else {
                  result.variantsSkipped++;
                }
                await this.recordNonShopifyInventorySyncSuccess(
                  channel,
                  item,
                  pushResult?.refreshedExternalVariantId,
                );
              } else {
                result.variantsErrored++;
                if (isPermanentInventoryPushError(error)) {
                  await this.recordPermanentPushFailure(
                    channelId,
                    channel.provider,
                    item.variantId,
                    error ?? "permanent push failure",
                    item.externalVariantId ?? item.sku ?? null,
                  );
                }
                await this.recordChannelListingSyncError(channelId, item.variantId, error ?? "Inventory push failed");
              }

              await this.logSync({
                productVariantId: item.variantId,
                channelId,
                pushedQty: status === "success" || status === "skipped" ? item.allocatedQty : 0,
                status,
                errorMessage: error,
                triggeredBy: triggeredBy ?? "orchestrator",
              });

              result.details.push({
                productId,
                variantId: item.variantId,
                sku: item.sku,
                previousQty: item.previousQty,
                allocatedQty: item.allocatedQty,
                status,
                error,
              });
            }
          }
        } catch (err: any) {
          console.error(`[SyncOrchestrator] ${channel.provider} push failed: ${err.message}`);
          result.variantsErrored = pushItems.length;
          for (const item of pushItems) {
            await this.recordChannelListingSyncError(channelId, item.variantId, err.message);
            await this.logSync({
              productVariantId: item.variantId,
              channelId,
              pushedQty: 0,
              status: "error",
              errorMessage: err.message,
              triggeredBy: triggeredBy ?? "orchestrator",
            });
            result.details.push({
              productId,
              variantId: item.variantId,
              sku: item.sku,
              previousQty: item.previousQty,
              allocatedQty: item.allocatedQty,
              status: "error",
              error: err.message,
            });
          }
        }
      } else if (config.dryRun) {
        for (const item of pushItems) {
          result.details.push({
            productId,
            variantId: item.variantId,
            sku: item.sku,
            previousQty: item.previousQty,
            allocatedQty: item.allocatedQty,
            status: "pushed",
          });
        }
      }

      return result;
    }

    // Pre-fetch variant existence for each warehouse to avoid 404 errors when pushing to shopify locations
    const warehouseVariantExistence = new Map<number, Set<number>>();

    // Create a fast lookup map for assigned warehouses to cross-reference the engines payload
    const whMap = new Map<number, typeof assignedWarehouses[0]>();

    for (const wh of assignedWarehouses) {
      if (!wh.shopifyLocationId) {
        console.warn(`[SyncOrchestrator] Warehouse ${wh.warehouseId} (${wh.warehouseName}) has no shopify_location_id — skipping`);
        continue;
      }
      
      whMap.set(wh.warehouseId, wh);

      // Verify physical product placement existence
      const variantIdsAtWarehouse = await this.db.execute(sql`
        SELECT DISTINCT vid AS "variantId" FROM (
          SELECT il.product_variant_id AS vid
          FROM inventory.inventory_levels il
          INNER JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
          INNER JOIN warehouse.warehouses w ON w.id = wl.warehouse_id
          WHERE (wl.warehouse_id = ${wh.warehouseId} OR w.hub_warehouse_id = ${wh.warehouseId})
            AND (il.variant_qty > 0 OR il.reserved_qty > 0)
          UNION
          SELECT pl.product_variant_id AS vid
          FROM warehouse.product_locations pl
          INNER JOIN warehouse.warehouse_locations wl ON wl.id = pl.warehouse_location_id
          INNER JOIN warehouse.warehouses w ON w.id = wl.warehouse_id
          WHERE (wl.warehouse_id = ${wh.warehouseId} OR w.hub_warehouse_id = ${wh.warehouseId})
            AND pl.status = 'active'
            AND pl.product_variant_id IS NOT NULL
        ) AS variant_existence
      `).then((r: any) => r.rows);

      const existingVariantIds = new Set<number>(variantIdsAtWarehouse.map((r: any) => Number(r.variantId)));
      warehouseVariantExistence.set(wh.warehouseId, existingVariantIds);
    }

    const pushItems: InventoryPushItem[] = [];

    // Main Loop: Iterate by Variant, aggregate by Warehouse
    for (const a of allocations) {
      const variantId = a.productVariantId;
      const breakdownItems: { warehouseId: number; externalLocationId: string; qty: number }[] = [];
      let totalPushQty = 0;

      // If the engine zeroes out the item (warehouseBreakdown empty), we must manually 
      // pad 0 across all assigned locations so that Shopify properly unlists the quantity!
      let targetBreakdown = a.warehouseBreakdown;
      if (!targetBreakdown || targetBreakdown.length === 0) {
        targetBreakdown = assignedWarehouses.map((wh: any) => ({
          warehouseId: wh.warehouseId,
          qty: 0
        }));
      }
      
      for (const loc of targetBreakdown) {
        const wh = whMap.get(loc.warehouseId);
        if (!wh?.shopifyLocationId) continue;
        
        const exists = warehouseVariantExistence.get(wh.warehouseId)?.has(variantId);
        if (!exists) continue;

        const locationQty = loc.qty;

        breakdownItems.push({
          warehouseId: wh.warehouseId,
          externalLocationId: wh.shopifyLocationId,
          qty: locationQty,
        });

        totalPushQty += locationQty;

        console.log(
          `[SyncOrchestrator] ${config.dryRun ? "DRY_RUN " : ""}Inventory Eval: ` +
          `variant=${a.sku} channel=${channel.name} ` +
          `warehouse=${wh.warehouseName}(${wh.warehouseId}) ` +
          `pushQty=${locationQty} ` +
          `engineMethod=${a.method}`
        );
      }

      if (breakdownItems.length === 0) continue;

      const [variant] = await this.db.select({
        id: productVariants.id,
        sku: productVariants.sku,
        shopifyVariantId: productVariants.shopifyVariantId,
        shopifyInventoryItemId: productVariants.shopifyInventoryItemId,
      }).from(productVariants).where(eq(productVariants.id, variantId)).limit(1);

      if (!variant) {
        result.details.push({
          productId, variantId, sku: a.sku, allocatedQty: totalPushQty, previousQty: null, status: "error", error: "Variant not found"
        });
        result.variantsErrored++;
        continue;
      }

      const [feed] = await this.db.select({
        lastSyncedQty: channelFeeds.lastSyncedQty,
        channelInventoryItemId: channelFeeds.channelInventoryItemId,
        quarantinedAt: channelFeeds.quarantinedAt,
      }).from(channelFeeds).where(and(eq(channelFeeds.channelId, channelId), eq(channelFeeds.productVariantId, variantId))).limit(1);

      // Quarantined = the external resource is gone (repeated permanent
      // failures). Skipping is the point: no push, no 404, no error spam.
      // recordPermanentPushFailure() explains how a mapping gets here.
      if (feed?.quarantinedAt) {
        result.details.push({
          productId, variantId, sku: a.sku, allocatedQty: totalPushQty, previousQty: null, status: "skipped", error: "Mapping quarantined (external resource gone) — re-link or retire",
        });
        result.variantsSkipped++;
        continue;
      }

      const inventoryItemId = feed?.channelInventoryItemId || variant.shopifyInventoryItemId;

      if (!inventoryItemId) {
        result.details.push({
          productId, variantId, sku: a.sku, allocatedQty: totalPushQty, previousQty: null, status: "skipped", error: "No inventoryItemId"
        });
        result.variantsSkipped++;
        continue;
      }

      const previousQty = feed?.lastSyncedQty ?? null;

      pushItems.push({
        variantId,
        sku: variant.sku,
        externalVariantId: variant.shopifyVariantId,
        externalInventoryItemId: inventoryItemId,
        allocatedQty: totalPushQty,
        warehouseBreakdown: breakdownItems,
      });

      result.details.push({
        productId,
        variantId,
        sku: variant.sku,
        allocatedQty: totalPushQty,
        previousQty,
        status: config.dryRun ? "dry_run" : "pending",
      });
    }

    // Filter unchanged aggregates based on previousQty
    const changedItems = pushItems.filter((item) => {
      const detail = result.details.find((d) => d.variantId === item.variantId);
      return detail?.previousQty == null || detail.previousQty !== item.allocatedQty;
    });

    // Execute atomic channel push for all changed variants
    if (!config.dryRun && changedItems.length > 0) {
      try {
        const pushResults = await adapter.pushInventory(channelId, changedItems);

        for (const pr of pushResults) {
          const detail = result.details.find((d) => d.variantId === pr.variantId && d.status === "pending");
          if (detail) {
            detail.status = pr.status;
            if (pr.error) detail.error = pr.error;
          }

          if (pr.status === "success") {
            result.variantsPushed++;

            await this.db.update(channelFeeds)
              .set({
                lastSyncedQty: pr.pushedQty,
                lastSyncedAt: new Date(),
                updatedAt: new Date(),
                // a successful push proves the mapping is alive
                consecutivePushFailures: 0,
                quarantinedAt: null,
                quarantineReason: null,
              })
              .where(and(eq(channelFeeds.channelId, channelId), eq(channelFeeds.productVariantId, pr.variantId)));

            // Extract the warehouseBreakdown payload that we sent for this variant to log
            const item = changedItems.find((i) => i.variantId === pr.variantId);
            if (item?.warehouseBreakdown) {
              for (const wh of item.warehouseBreakdown) {
                await this.logSync({
                  productVariantId: pr.variantId,
                  channelId,
                  pushedQty: wh.qty,
                  status: "success",
                  triggeredBy: triggeredBy ?? "orchestrator",
                  warehouseId: wh.warehouseId,
                  shopifyLocationId: wh.externalLocationId,
                });
              }
            }
          } else if (pr.status === "error") {
            result.variantsErrored++;
            if (isPermanentInventoryPushError(pr.error)) {
              const item = changedItems.find((i) => i.variantId === pr.variantId);
              await this.recordPermanentPushFailure(
                channelId,
                channel.provider,
                pr.variantId,
                pr.error ?? "permanent push failure",
                item?.externalVariantId ?? item?.sku ?? null,
              );
            }
            await this.logSync({
              productVariantId: pr.variantId,
              channelId,
              pushedQty: 0,
              status: "error",
              errorMessage: pr.error,
              triggeredBy: triggeredBy ?? "orchestrator",
              // Since push entirely failed, we mock null log inputs
              warehouseId: 0,
              shopifyLocationId: "",
            });
          } else {
            result.variantsSkipped++;
          }
        }
      } catch (err: any) {
        console.error(`[SyncOrchestrator] Inventory push failed for channel ${channel.name}: ${err.message}`);
        result.variantsErrored += changedItems.length;
      }
    } else if (config.dryRun) {
      result.variantsPushed += changedItems.length;
    }

    return result;
  }

  // =========================================================================
  // 2. PRICING SYNC — Channel Pricing → Shopify Adapter (with source lock)
  // =========================================================================

  /**
   * Push pricing from channel_pricing table to the channel.
   * Respects source lock — only pushes if pricing field is locked.
   */
  async syncPricingForChannel(
    channelId: number,
    config: SyncOrchestratorConfig,
    productIds?: number[],
  ): Promise<PricingSyncResult> {
    // Get channel info
    const [channel] = await this.db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    if (!channel) {
      return {
        channelId,
        channelName: "Unknown",
        dryRun: config.dryRun,
        variantsPushed: 0,
        variantsSkipped: 0,
        variantsErrored: 0,
        details: [{ variantId: 0, sku: null, priceCents: 0, compareAtPriceCents: null, status: "error", error: "Channel not found" }],
      };
    }

    const result: PricingSyncResult = {
      channelId,
      channelName: channel.name,
      dryRun: config.dryRun,
      variantsPushed: 0,
      variantsSkipped: 0,
      variantsErrored: 0,
      details: [],
    };

    // Check source lock — pricing is always locked, but check anyway for safety
    const pricingLocked = await this.sourceLockService.isFieldLocked(channelId, "pricing");
    if (!pricingLocked) {
      console.log(`[SyncOrchestrator] Pricing NOT locked for channel ${channelId} — skipping push`);
      return result;
    }

    // Get adapter
    const adapter = this.adapterRegistry.get(channel.provider);
    if (!adapter) {
      result.details.push({
        variantId: 0,
        sku: null,
        priceCents: 0,
        compareAtPriceCents: null,
        status: "error",
        error: `No adapter for provider "${channel.provider}"`,
      });
      return result;
    }

    // Load channel pricing
    let pricingQuery = this.db
      .select({
        id: channelPricing.id,
        productVariantId: channelPricing.productVariantId,
        price: channelPricing.price,
        compareAtPrice: channelPricing.compareAtPrice,
        currency: channelPricing.currency,
        variantSku: productVariants.sku,
        shopifyVariantId: productVariants.shopifyVariantId,
        listingExternalVariantId: channelListings.externalVariantId,
        listingExternalSku: channelListings.externalSku,
      })
      .from(channelPricing)
      .innerJoin(productVariants, eq(channelPricing.productVariantId, productVariants.id))
      .leftJoin(
        channelListings,
        and(
          eq(channelListings.channelId, channelId),
          eq(channelListings.productVariantId, productVariants.id),
        ),
      )
      .where(eq(channelPricing.channelId, channelId));

    if (productIds && productIds.length > 0) {
      pricingQuery = pricingQuery.where(
        and(
          eq(channelPricing.channelId, channelId),
          inArray(productVariants.productId, productIds),
        ),
      );
    }

    const pricingRows = await pricingQuery;

    if (pricingRows.length === 0) {
      console.log(`[SyncOrchestrator] No pricing data for channel ${channelId}`);
      return result;
    }

    // Build push items
    const pushItems: PricingPushItem[] = [];

    for (const pr of pricingRows) {
      const externalVariantId = pr.listingExternalVariantId ?? pr.shopifyVariantId;
      const externalSku = pr.listingExternalSku ?? pr.variantSku;

      if (!externalVariantId) {
        result.details.push({
          variantId: pr.productVariantId!,
          sku: pr.variantSku,
          priceCents: pr.price,
          compareAtPriceCents: pr.compareAtPrice,
          status: "skipped",
          error: `No external variant id for channel ${channel.name}`,
        });
        result.variantsSkipped++;
        continue;
      }

      // Check if price actually changed vs. last synced
      const [listing] = await this.db
        .select({ lastSyncedPrice: channelListings.lastSyncedPrice })
        .from(channelListings)
        .where(
          and(
            eq(channelListings.channelId, channelId),
            eq(channelListings.productVariantId, pr.productVariantId!),
          ),
        )
        .limit(1);

      const priceChanged = !listing || listing.lastSyncedPrice !== pr.price;

      if (!priceChanged) {
        result.details.push({
          variantId: pr.productVariantId!,
          sku: pr.variantSku,
          priceCents: pr.price,
          compareAtPriceCents: pr.compareAtPrice,
          status: "skipped",
          error: "Price unchanged",
        });
        result.variantsSkipped++;
        continue;
      }

      console.log(
        `[SyncOrchestrator] ${config.dryRun ? "DRY_RUN " : ""}Pricing: ` +
        `variant=${pr.variantSku} channel=${channel.name} ` +
        `price=${pr.price}¢ compare_at=${pr.compareAtPrice ?? "none"}`,
      );

      pushItems.push({
        variantId: pr.productVariantId!,
        sku: externalSku,
        externalVariantId,
        priceCents: pr.price,
        compareAtPriceCents: pr.compareAtPrice,
        currency: pr.currency,
      });

      result.details.push({
        variantId: pr.productVariantId!,
        sku: pr.variantSku,
        priceCents: pr.price,
        compareAtPriceCents: pr.compareAtPrice,
        status: config.dryRun ? "dry_run" : "pending",
      });
    }

    // Push (unless dry run)
    if (!config.dryRun && pushItems.length > 0) {
      try {
        const pushResults = await adapter.pushPricing(channelId, pushItems);

        for (const pr of pushResults) {
          const detail = result.details.find((d) => d.variantId === pr.variantId && d.status === "pending");
          if (detail) {
            detail.status = pr.status;
            if (pr.error) detail.error = pr.error;
          }

          if (pr.status === "success") {
            result.variantsPushed++;

            // Update channel_listings with last synced price
            const pushItem = pushItems.find((pi) => pi.variantId === pr.variantId);
            if (pushItem) {
              await this.db
                .update(channelListings)
                .set({
                  lastSyncedPrice: pushItem.priceCents,
                  lastSyncedAt: new Date(),
                  syncStatus: "synced",
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(channelListings.channelId, channelId),
                    eq(channelListings.productVariantId, pr.variantId),
                  ),
                );
            }
          } else if (pr.status === "error") {
            result.variantsErrored++;
          } else {
            result.variantsSkipped++;
          }
        }
      } catch (err: any) {
        console.error(`[SyncOrchestrator] Pricing push failed for channel ${channel.name}: ${err.message}`);
        result.variantsErrored = pushItems.length;
      }
    } else {
      result.variantsPushed = pushItems.length;
    }

    return result;
  }

  // =========================================================================
  // 3. LISTINGS SYNC — Bidirectional based on source lock
  // =========================================================================

  /**
   * Sync listings between Echelon and a channel.
   * - Locked fields: push from Echelon → Channel
   * - Unlocked fields: pull from Channel → Echelon
   */
  async syncListingsForChannel(
    channelId: number,
    config: SyncOrchestratorConfig,
    productIds?: number[],
  ): Promise<ListingSyncResult> {
    const [channel] = await this.db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    if (!channel) {
      return {
        channelId,
        channelName: "Unknown",
        dryRun: config.dryRun,
        productsProcessed: 0,
        pushed: 0,
        pulled: 0,
        skipped: 0,
        errored: 0,
        details: [],
      };
    }

    const result: ListingSyncResult = {
      channelId,
      channelName: channel.name,
      dryRun: config.dryRun,
      productsProcessed: 0,
      pushed: 0,
      pulled: 0,
      skipped: 0,
      errored: 0,
      details: [],
    };

    // Get lock status
    const lockedFields = await this.sourceLockService.getLockedFields(channelId);
    const syncableFields = await this.sourceLockService.getSyncableFields(channelId);

    const adapter = this.adapterRegistry.get(channel.provider);
    if (!adapter) {
      result.details.push({
        productId: 0,
        direction: "skip",
        fields: [],
        status: "error",
        error: `No adapter for provider "${channel.provider}"`,
      });
      return result;
    }

    // Get products to sync
    let productQuery;
    if (productIds && productIds.length > 0) {
      productQuery = await this.db
        .select()
        .from(products)
        .where(
          and(
            inArray(products.id, productIds),
            eq(products.isActive, true),
          ),
        );
    } else {
      productQuery = await this.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.isActive, true),
            sql`${products.shopifyProductId} IS NOT NULL`,
          ),
        );
    }

    console.log(`[SyncOrchestrator] Syncing listings for ${productQuery.length} products on channel ${channel.name}`);

    for (const product of productQuery) {
      result.productsProcessed++;

      try {
        // Determine what to push vs pull
        const pushFields: string[] = [];
        const pullFields: string[] = [];

        if (lockedFields.has("title")) pushFields.push("title");
        else if (syncableFields.has("title")) pullFields.push("title");

        if (lockedFields.has("description")) pushFields.push("description");
        else if (syncableFields.has("description")) pullFields.push("description");

        if (lockedFields.has("images")) pushFields.push("images");

        // PUSH locked fields
        if (pushFields.length > 0) {
          const resolved = await this.productPushService.getResolvedProductForChannel(product.id, channelId);
          if (resolved && resolved.isListed) {
            console.log(
              `[SyncOrchestrator] ${config.dryRun ? "DRY_RUN " : ""}Listings PUSH: ` +
              `product="${product.name}" channel=${channel.name} fields=[${pushFields.join(",")}]`,
            );

            if (!config.dryRun) {
              // Build partial listing payload with only locked fields
              const listingPayload = {
                productId: product.id,
                title: pushFields.includes("title") ? resolved.title : product.title || product.name,
                description: pushFields.includes("description") ? resolved.description : null,
                category: resolved.category,
                tags: resolved.tags,
                // status: resolved.status as "active" | "draft" | "archived",  // REMOVED: don't push listing status to Shopify
                variants: resolved.variants
                  .filter((v: any) => v.isListed)
                  .map((v: any) => ({
                    variantId: v.id,
                    sku: v.sku,
                    name: v.name,
                    barcode: v.barcode,
                    gtin: v.gtin,
                    mpn: v.mpn,
                    weightGrams: v.weight,
                    priceCents: v.price,
                    compareAtPriceCents: v.compareAtPrice,
                    isListed: v.isListed,
                    externalVariantId: v.shopifyVariantId,
                    externalInventoryItemId: null,
                  })),
                images: pushFields.includes("images")
                  ? resolved.images.map((img: any) => ({
                      url: img.url,
                      altText: img.altText,
                      position: img.position,
                      variantSku: img.variantSku,
                    }))
                  : [],
              } as ChannelListingPayload;

              const pushResults = await adapter.pushListings(channelId, [listingPayload]);

              for (const pr of pushResults) {
                if (pr.status === "created" || pr.status === "updated") {
                  result.pushed++;
                  result.details.push({
                    productId: product.id,
                    direction: "push",
                    fields: pushFields,
                    status: pr.status,
                  });

                  // Update channel_listings with external IDs
                  if (pr.externalVariantIds) {
                    for (const [variantId, extId] of Object.entries(pr.externalVariantIds)) {
                      await this.db
                        .update(channelListings)
                        .set({
                          externalVariantId: extId,
                          syncStatus: "synced",
                          lastSyncedAt: new Date(),
                          updatedAt: new Date(),
                        })
                        .where(
                          and(
                            eq(channelListings.channelId, channelId),
                            eq(channelListings.productVariantId, Number(variantId)),
                          ),
                        );
                    }
                  }
                } else if (pr.status === "error") {
                  result.errored++;
                  result.details.push({
                    productId: product.id,
                    direction: "push",
                    fields: pushFields,
                    status: "error",
                    error: pr.error,
                  });
                }
              }
            } else {
              result.pushed++;
              result.details.push({
                productId: product.id,
                direction: "push",
                fields: pushFields,
                status: "dry_run",
              });
            }
          }
        }

        // PULL unlocked fields from Shopify → Echelon
        if (pullFields.length > 0 && product.shopifyProductId) {
          console.log(
            `[SyncOrchestrator] ${config.dryRun ? "DRY_RUN " : ""}Listings PULL: ` +
            `product="${product.name}" channel=${channel.name} fields=[${pullFields.join(",")}]`,
          );

          if (!config.dryRun) {
            const shopifyData = await this.fetchShopifyProductData(channelId, product.shopifyProductId);
            if (shopifyData) {
              const updates: Partial<{ title: string; description: string | null; updatedAt: Date }> = {};

              if (pullFields.includes("title") && shopifyData.title) {
                updates.title = shopifyData.title;
              }
              if (pullFields.includes("description")) {
                updates.description = shopifyData.body_html || null;
              }

              if (Object.keys(updates).length > 0) {
                updates.updatedAt = new Date();
                await this.db
                  .update(products)
                  .set(updates)
                  .where(eq(products.id, product.id));

                result.pulled++;
                result.details.push({
                  productId: product.id,
                  direction: "pull",
                  fields: pullFields,
                  status: "success",
                });
              }
            }
          } else {
            result.pulled++;
            result.details.push({
              productId: product.id,
              direction: "pull",
              fields: pullFields,
              status: "dry_run",
            });
          }
        }

        // If no fields to sync
        if (pushFields.length === 0 && pullFields.length === 0) {
          result.skipped++;
          result.details.push({
            productId: product.id,
            direction: "skip",
            fields: [],
            status: "no_fields",
          });
        }
      } catch (err: any) {
        result.errored++;
        result.details.push({
          productId: product.id,
          direction: "skip",
          fields: [],
          status: "error",
          error: err.message,
        });
      }

      // Rate limiting
      await this.delay(200);
    }

    return result;
  }

  // =========================================================================
  // 4. FULL SYNC — runs all sync types for a channel
  // =========================================================================

  /**
   * Run a complete sync cycle for all active channels:
   * 1. Allocation → Inventory push
   * 2. Pricing push (locked fields)
   * 3. Listings push/pull (based on lock status)
   */
  async runFullSync(config: SyncOrchestratorConfig): Promise<FullSyncResult> {
    const startedAt = new Date();
    const result: FullSyncResult = {
      dryRun: config.dryRun,
      startedAt,
      completedAt: new Date(),
      inventory: [],
      pricing: [],
      listings: [],
      errors: [],
    };

    console.log(`[SyncOrchestrator] Starting ${config.dryRun ? "DRY RUN" : "LIVE"} full sync`);

    // Get all active channels
    const activeChannels = await this.db
      .select()
      .from(channels)
      .where(eq(channels.status, "active"));

    if (activeChannels.length === 0) {
      console.log("[SyncOrchestrator] No active channels");
      result.completedAt = new Date();
      return result;
    }

    // 1. Inventory sync (runs allocation for all products, pushes to all channels)
    try {
      const inventoryResults = await this.syncInventoryForAllProducts(config, "scheduled_sync");
      result.inventory = inventoryResults;
    } catch (err: any) {
      result.errors.push(`Inventory sync failed: ${err.message}`);
      console.error("[SyncOrchestrator] Inventory sync failed:", err.message);
    }

    // 2. Pricing sync per channel (DISABLED TEMPORARILY)
    /*
    for (const channel of activeChannels) {
      if (!this.adapterRegistry.has(channel.provider)) continue;

      try {
        const pricingResult = await this.syncPricingForChannel(channel.id, config);
        result.pricing.push(pricingResult);
      } catch (err: any) {
        result.errors.push(`Pricing sync failed for channel ${channel.name}: ${err.message}`);
      }
    }
    */

    // 3. Listings sync per channel (DISABLED TEMPORARILY)
    /*
    for (const channel of activeChannels) {
      if (!this.adapterRegistry.has(channel.provider)) continue;

      try {
        const listingsResult = await this.syncListingsForChannel(channel.id, config);
        result.listings.push(listingsResult);
      } catch (err: any) {
        result.errors.push(`Listings sync failed for channel ${channel.name}: ${err.message}`);
      }
    }
    */

    result.completedAt = new Date();
    const durationMs = result.completedAt.getTime() - startedAt.getTime();
    console.log(`[SyncOrchestrator] Full sync completed in ${durationMs}ms`);

    return result;
  }

  // =========================================================================
  // 5. EVENT-TRIGGERED INVENTORY SYNC
  // =========================================================================

  /**
   * Called when inventory changes in Echelon (receiving, adjustments, picks, etc.)
   * Runs allocation and pushes updated ATP to all channels for the affected product.
   */
  async onInventoryChange(
    productVariantId: number,
    triggeredBy: string,
    config?: SyncOrchestratorConfig,
  ): Promise<InventorySyncResult[]> {
    // Look up the product
    const [variant] = await this.db
      .select({ productId: productVariants.productId })
      .from(productVariants)
      .where(eq(productVariants.id, productVariantId))
      .limit(1);

    if (!variant) {
      console.warn(`[SyncOrchestrator] onInventoryChange: variant ${productVariantId} not found`);
      return [];
    }

    return this.syncInventoryForProduct(
      variant.productId,
      config ?? { dryRun: false },
      triggeredBy,
    );
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private async getInventorySyncProductIds(): Promise<number[]> {
    const feedRows = await this.db
      .select({ productId: productVariants.productId })
      .from(channelFeeds)
      .innerJoin(productVariants, eq(channelFeeds.productVariantId, productVariants.id))
      .where(eq(channelFeeds.isActive, 1))
      .groupBy(productVariants.productId);

    const listingRows = await this.db
      .select({ productId: productVariants.productId })
      .from(channelListings)
      .innerJoin(productVariants, eq(channelListings.productVariantId, productVariants.id))
      .innerJoin(channels, eq(channelListings.channelId, channels.id))
      .where(
        and(
          eq(channels.status, "active"),
          eq(channels.syncEnabled, true),
        ),
      )
      .groupBy(productVariants.productId);

    return Array.from(new Set([
      ...feedRows.map((r: any) => r.productId as number),
      ...listingRows.map((r: any) => r.productId as number),
    ]));
  }

  private async getNonShopifyInventorySyncStates(
    channelId: number,
    productVariantIds: number[],
  ): Promise<Map<number, NonShopifyInventorySyncState>> {
    if (productVariantIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        productVariantId: productVariants.id,
        feedId: channelFeeds.id,
        feedLastSyncedQty: channelFeeds.lastSyncedQty,
        feedQuarantinedAt: channelFeeds.quarantinedAt,
        channelVariantId: channelFeeds.channelVariantId,
        channelSku: channelFeeds.channelSku,
        channelInventoryItemId: channelFeeds.channelInventoryItemId,
        listingId: channelListings.id,
        listingExternalVariantId: channelListings.externalVariantId,
        listingExternalSku: channelListings.externalSku,
        listingLastSyncedQty: channelListings.lastSyncedQty,
      })
      .from(productVariants)
      .leftJoin(
        channelFeeds,
        and(
          eq(channelFeeds.channelId, channelId),
          eq(channelFeeds.productVariantId, productVariants.id),
        ),
      )
      .leftJoin(
        channelListings,
        and(
          eq(channelListings.channelId, channelId),
          eq(channelListings.productVariantId, productVariants.id),
        ),
      )
      .where(inArray(productVariants.id, productVariantIds));

    const byVariant = new Map<number, NonShopifyInventorySyncState>();
    for (const row of rows as NonShopifyInventorySyncState[]) {
      byVariant.set(row.productVariantId, row);
    }
    return byVariant;
  }

  private async recordNonShopifyInventorySyncSuccess(
    channel: { id: number; provider: string },
    item: NonShopifyInventoryPushItem,
    // Adapter re-resolved a stale external id (e.g. a relisted eBay offer);
    // persist it or every future sync re-fails on the dead id.
    refreshedExternalVariantId?: string,
  ): Promise<void> {
    const now = new Date();
    const effectiveExternalVariantId =
      refreshedExternalVariantId ?? item.externalVariantId;
    const channelVariantId = effectiveExternalVariantId ?? item.sku ?? String(item.variantId);
    const [existingFeed] = await this.db
      .select({ id: channelFeeds.id })
      .from(channelFeeds)
      .where(
        and(
          eq(channelFeeds.channelId, channel.id),
          eq(channelFeeds.productVariantId, item.variantId),
        ),
      )
      .limit(1);

    const feedValues = {
      channelType: channel.provider,
      channelVariantId,
      channelProductId: null,
      channelSku: item.sku,
      channelInventoryItemId: item.externalInventoryItemId,
      isActive: 1,
      lastSyncedQty: item.allocatedQty,
      lastSyncedAt: now,
      updatedAt: now,
      // a successful push proves the mapping is alive
      consecutivePushFailures: 0,
      quarantinedAt: null,
      quarantineReason: null,
    };

    if (existingFeed) {
      await this.db
        .update(channelFeeds)
        .set(feedValues)
        .where(eq(channelFeeds.id, existingFeed.id));
    } else {
      await this.db.insert(channelFeeds).values({
        channelId: channel.id,
        productVariantId: item.variantId,
        ...feedValues,
      });
    }

    await this.db
      .update(channelListings)
      .set({
        lastSyncedQty: item.allocatedQty,
        lastSyncedAt: now,
        syncStatus: "synced",
        syncError: null,
        updatedAt: now,
        ...(refreshedExternalVariantId
          ? { externalVariantId: refreshedExternalVariantId }
          : {}),
      })
      .where(
        and(
          eq(channelListings.channelId, channel.id),
          eq(channelListings.productVariantId, item.variantId),
        ),
      );
  }

  private async recordChannelListingSyncError(
    channelId: number,
    productVariantId: number,
    error: string,
  ): Promise<void> {
    await this.db
      .update(channelListings)
      .set({
        syncStatus: "error",
        syncError: error,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(channelListings.channelId, channelId),
          eq(channelListings.productVariantId, productVariantId),
        ),
      );
  }

  /**
   * Count a PERMANENT push failure (external resource gone — see
   * isPermanentInventoryPushError) and quarantine the mapping once it fails
   * PERMANENT_FAILURE_QUARANTINE_THRESHOLD times in a row. Quarantined
   * mappings are skipped by both inventory-push branches, so a dead mapping
   * asks for review ONCE instead of erroring every sweep forever.
   *
   * Upserts so pv-fallback mappings (no feed row yet) are countable too.
   * The counter resets on any successful push; repair paths
   * (scripts/relink-shopify-variant-ids.ts) clear the quarantine explicitly.
   */
  private async recordPermanentPushFailure(
    channelId: number,
    provider: string,
    productVariantId: number,
    error: string,
    externalVariantId: string | null,
  ): Promise<void> {
    const now = new Date();
    const [feed] = await this.db
      .insert(channelFeeds)
      .values({
        channelId,
        productVariantId,
        channelType: provider,
        channelVariantId: externalVariantId ?? String(productVariantId),
        isActive: 1,
        consecutivePushFailures: 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [channelFeeds.channelId, channelFeeds.productVariantId],
        set: {
          consecutivePushFailures: sql`${channelFeeds.consecutivePushFailures} + 1`,
          updatedAt: now,
        },
      })
      .returning({
        failures: channelFeeds.consecutivePushFailures,
        quarantinedAt: channelFeeds.quarantinedAt,
      });

    if (
      !feed ||
      feed.quarantinedAt !== null ||
      feed.failures < PERMANENT_FAILURE_QUARANTINE_THRESHOLD
    ) {
      return;
    }

    const reason = `CHANNELS_PUSH_PERMANENT after ${feed.failures} consecutive failures: ${error.slice(0, 500)}`;
    await this.db
      .update(channelFeeds)
      .set({ quarantinedAt: now, quarantineReason: reason, updatedAt: now })
      .where(and(eq(channelFeeds.channelId, channelId), eq(channelFeeds.productVariantId, productVariantId)));
    await this.recordChannelListingSyncError(
      channelId,
      productVariantId,
      `Quarantined: external resource gone (${error.slice(0, 300)}). Re-link or retire the mapping.`,
    );
    // ERROR level: a human must decide relist-vs-retire; the sweep stops asking.
    console.error(
      `[SyncOrchestrator] QUARANTINED inventory mapping channel=${channelId} variant=${productVariantId}: ${reason}`,
    );
  }

  /**
   * Fetch a single product from Shopify for pulling unlocked fields.
   */
  private async fetchShopifyProductData(
    channelId: number,
    shopifyProductId: string,
  ): Promise<{ title: string; body_html: string | null } | null> {
    const [conn] = await this.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.channelId, channelId))
      .limit(1);

    if (!conn?.shopDomain || !conn?.accessToken) return null;

    const apiVersion = conn.apiVersion || "2024-01";
    const url = `https://${conn.shopDomain}/admin/api/${apiVersion}/products/${shopifyProductId}.json?fields=id,title,body_html`;

    try {
      const response = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": conn.accessToken,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) return null;

      const data = await response.json();
      return data?.product || null;
    } catch {
      return null;
    }
  }

  /**
   * Log a sync event with optional warehouse/location info.
   */
  private async logSync(entry: {
    productVariantId: number;
    channelId: number;
    pushedQty: number;
    status: string;
    errorMessage?: string;
    triggeredBy: string;
    warehouseId?: number;
    shopifyLocationId?: string;
  }): Promise<void> {
    try {
      // Get product ID
      const [variant] = await this.db
        .select({ productId: productVariants.productId })
        .from(productVariants)
        .where(eq(productVariants.id, entry.productVariantId))
        .limit(1);

      // Get feed ID
      const [feed] = await this.db
        .select({ id: channelFeeds.id })
        .from(channelFeeds)
        .where(
          and(
            eq(channelFeeds.channelId, entry.channelId),
            eq(channelFeeds.productVariantId, entry.productVariantId),
          ),
        )
        .limit(1);

      await this.db.insert(channelSyncLog).values({
        productId: variant?.productId ?? null,
        productVariantId: entry.productVariantId,
        channelId: entry.channelId,
        channelFeedId: feed?.id ?? null,
        atpBase: 0,
        pushedQty: entry.pushedQty,
        previousQty: null,
        status: entry.status,
        errorMessage: entry.errorMessage ?? null,
        durationMs: 0,
        triggeredBy: entry.triggeredBy,
        warehouseId: entry.warehouseId ?? null,
        shopifyLocationId: entry.shopifyLocationId ?? null,
      });
    } catch (err: any) {
      console.warn(`[SyncOrchestrator] Failed to log sync: ${err.message}`);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEchelonSyncOrchestrator(
  db: any,
  allocationEngine: AllocationEngine,
  sourceLockService: SourceLockService,
  adapterRegistry: ChannelAdapterRegistry,
  productPushService: ProductPushService,
  atpService?: any,
) {
  return new EchelonSyncOrchestrator(
    db,
    allocationEngine,
    sourceLockService,
    adapterRegistry,
    productPushService,
    atpService,
  );
}

export type { EchelonSyncOrchestrator };
