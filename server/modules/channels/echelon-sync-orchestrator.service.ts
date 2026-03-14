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

import { eq, and, sql, inArray } from "drizzle-orm";
import {
  products,
  productVariants,
  channels,
  channelFeeds,
  channelListings,
  channelPricing,
  channelSyncLog,
  channelConnections,
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
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

type ProductPushService = {
  getResolvedProductForChannel: (productId: number, channelId: number) => Promise<any>;
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
  ) {}

  // =========================================================================
  // 1. INVENTORY SYNC — Allocation Engine → Shopify Adapter
  // =========================================================================

  /**
   * Run allocation for a product and push allocated ATP to all active channels.
   * This replaces the old direct inventory push in sync.service.ts.
   */
  async syncInventoryForProduct(
    productId: number,
    config: SyncOrchestratorConfig,
    triggeredBy?: string,
  ): Promise<InventorySyncResult[]> {
    const results: InventorySyncResult[] = [];

    // Run allocation engine
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

    // Push to each channel
    for (const [channelId, data] of byChannel) {
      const channelResult = await this.pushInventoryToChannel(
        channelId,
        data.channel,
        data.allocations,
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

    // Get all products that have active channel feeds
    const feedRows = await this.db
      .select({ productId: productVariants.productId })
      .from(channelFeeds)
      .innerJoin(productVariants, eq(channelFeeds.productVariantId, productVariants.id))
      .where(eq(channelFeeds.isActive, 1))
      .groupBy(productVariants.productId);

    const productIds = [...new Set(feedRows.map((r: any) => r.productId))];
    console.log(`[SyncOrchestrator] Syncing inventory for ${productIds.length} products`);

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
   * Push allocated inventory for specific variants to a channel.
   */
  private async pushInventoryToChannel(
    channelId: number,
    channel: { id: number; name: string; provider: string },
    allocations: ProductAllocationResult["allocations"],
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

    // Build push items — need to look up external IDs
    const pushItems: InventoryPushItem[] = [];

    for (const a of allocations) {
      // Get variant details and external IDs
      const [variant] = await this.db
        .select({
          id: productVariants.id,
          sku: productVariants.sku,
          shopifyVariantId: productVariants.shopifyVariantId,
          shopifyInventoryItemId: productVariants.shopifyInventoryItemId,
        })
        .from(productVariants)
        .where(eq(productVariants.id, a.productVariantId))
        .limit(1);

      if (!variant) {
        result.details.push({
          productId: 0,
          variantId: a.productVariantId,
          sku: a.sku,
          allocatedQty: a.allocatedUnits,
          previousQty: null,
          status: "error",
          error: "Variant not found",
        });
        result.variantsErrored++;
        continue;
      }

      if (!variant.shopifyInventoryItemId) {
        result.details.push({
          productId: 0,
          variantId: a.productVariantId,
          sku: a.sku,
          allocatedQty: a.allocatedUnits,
          previousQty: null,
          status: "skipped",
          error: "No shopifyInventoryItemId — run catalog backfill first",
        });
        result.variantsSkipped++;
        continue;
      }

      // Get previous synced qty from channel_feeds
      const [feed] = await this.db
        .select({ lastSyncedQty: channelFeeds.lastSyncedQty })
        .from(channelFeeds)
        .where(
          and(
            eq(channelFeeds.channelId, channelId),
            eq(channelFeeds.productVariantId, a.productVariantId),
          ),
        )
        .limit(1);

      pushItems.push({
        variantId: a.productVariantId,
        sku: variant.sku,
        externalVariantId: variant.shopifyVariantId,
        externalInventoryItemId: variant.shopifyInventoryItemId,
        allocatedQty: a.allocatedUnits,
      });

      const previousQty = feed?.lastSyncedQty ?? null;

      console.log(
        `[SyncOrchestrator] ${config.dryRun ? "DRY_RUN " : ""}Inventory: ` +
        `variant=${a.sku} channel=${channel.name} ` +
        `allocated=${a.allocatedUnits} previous=${previousQty ?? "unknown"} ` +
        `method=${a.method} reason="${a.reason}"`,
      );

      result.details.push({
        productId: 0,
        variantId: a.productVariantId,
        sku: variant.sku,
        allocatedQty: a.allocatedUnits,
        previousQty,
        status: config.dryRun ? "dry_run" : "pending",
      });
    }

    // Push to channel (unless dry run)
    if (!config.dryRun && pushItems.length > 0) {
      try {
        const pushResults = await adapter.pushInventory(channelId, pushItems);

        // Update results and channel_feeds
        for (const pr of pushResults) {
          const detail = result.details.find((d) => d.variantId === pr.variantId);
          if (detail) {
            detail.status = pr.status;
            if (pr.error) detail.error = pr.error;
          }

          if (pr.status === "success") {
            result.variantsPushed++;

            // Update channel_feeds sync state
            await this.db
              .update(channelFeeds)
              .set({
                lastSyncedQty: pr.pushedQty,
                lastSyncedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(channelFeeds.channelId, channelId),
                  eq(channelFeeds.productVariantId, pr.variantId),
                ),
              );

            // Log sync
            await this.logSync({
              productVariantId: pr.variantId,
              channelId,
              pushedQty: pr.pushedQty,
              status: "success",
              triggeredBy: triggeredBy ?? "orchestrator",
            });
          } else if (pr.status === "error") {
            result.variantsErrored++;
            await this.logSync({
              productVariantId: pr.variantId,
              channelId,
              pushedQty: 0,
              status: "error",
              errorMessage: pr.error,
              triggeredBy: triggeredBy ?? "orchestrator",
            });
          } else {
            result.variantsSkipped++;
          }
        }
      } catch (err: any) {
        console.error(`[SyncOrchestrator] Inventory push failed for channel ${channel.name}: ${err.message}`);
        result.variantsErrored = pushItems.length;
      }
    } else {
      // Dry run — all items are "pushed" as dry_run
      result.variantsPushed = pushItems.length;
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
      })
      .from(channelPricing)
      .innerJoin(productVariants, eq(channelPricing.productVariantId, productVariants.id))
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
      if (!pr.shopifyVariantId) {
        result.details.push({
          variantId: pr.productVariantId!,
          sku: pr.variantSku,
          priceCents: pr.price,
          compareAtPriceCents: pr.compareAtPrice,
          status: "skipped",
          error: "No shopifyVariantId",
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
        externalVariantId: pr.shopifyVariantId,
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
              const listingPayload: ChannelListingPayload = {
                productId: product.id,
                title: pushFields.includes("title") ? resolved.title : product.title || product.name,
                description: pushFields.includes("description") ? resolved.description : null,
                category: resolved.category,
                tags: resolved.tags,
                status: resolved.status as "active" | "draft" | "archived",
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
              };

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

    // 2. Pricing sync per channel
    for (const channel of activeChannels) {
      if (!this.adapterRegistry.has(channel.provider)) continue;

      try {
        const pricingResult = await this.syncPricingForChannel(channel.id, config);
        result.pricing.push(pricingResult);
      } catch (err: any) {
        result.errors.push(`Pricing sync failed for channel ${channel.name}: ${err.message}`);
      }
    }

    // 3. Listings sync per channel
    for (const channel of activeChannels) {
      if (!this.adapterRegistry.has(channel.provider)) continue;

      try {
        const listingsResult = await this.syncListingsForChannel(channel.id, config);
        result.listings.push(listingsResult);
      } catch (err: any) {
        result.errors.push(`Listings sync failed for channel ${channel.name}: ${err.message}`);
      }
    }

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
   * Log a sync event.
   */
  private async logSync(entry: {
    productVariantId: number;
    channelId: number;
    pushedQty: number;
    status: string;
    errorMessage?: string;
    triggeredBy: string;
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
) {
  return new EchelonSyncOrchestrator(
    db,
    allocationEngine,
    sourceLockService,
    adapterRegistry,
    productPushService,
  );
}

export type { EchelonSyncOrchestrator };
