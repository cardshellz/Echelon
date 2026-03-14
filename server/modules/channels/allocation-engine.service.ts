/**
 * Inventory Allocation Engine
 *
 * Calculates per-channel, per-variant allocated inventory using:
 *   1. Total ATP (on_hand - reserved - picked - packed - safety_stock)
 *   2. Channel priority (higher priority channels get inventory first)
 *   3. Channel allocation rules (%, fixed qty, or uncapped)
 *   4. Per-variant per-channel limits (min/max, stop selling, overrides)
 *   5. Product-level gates (isListed, min/max ATP)
 *   6. Product line gates (which channels carry which product lines)
 *
 * Priority drawdown: when stock is scarce, lower-priority channels
 * zero out first. The highest-priority channel gets as much as it can.
 *
 * All operations are atomic and audit-logged.
 */

import { eq, and, sql, inArray } from "drizzle-orm";
import {
  channels,
  channelReservations,
  channelProductAllocation,
  channelFeeds,
  channelProductLines,
  productVariants,
  products,
  productLineProducts,
  allocationAuditLog,
  type Channel,
  type ChannelReservation,
  type ChannelProductAllocation,
  type ChannelFeed,
} from "@shared/schema";

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
};

/** Per-channel allocation result for a single variant */
export interface VariantChannelAllocation {
  channelId: number;
  channelName: string;
  channelProvider: string;
  channelPriority: number;
  productVariantId: number;
  sku: string;
  unitsPerVariant: number;
  /** Allocated sellable units of this variant for this channel */
  allocatedUnits: number;
  /** Allocated base units */
  allocatedBase: number;
  /** Method used: priority, percentage, fixed, override, zero (blocked) */
  method: string;
  /** Why this amount was allocated */
  reason: string;
}

/** Full allocation result for a product across all channels */
export interface ProductAllocationResult {
  productId: number;
  totalAtpBase: number;
  allocations: VariantChannelAllocation[];
  /** Channels that were blocked from this product */
  blocked: Array<{ channelId: number; reason: string }>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class AllocationEngine {
  constructor(
    private readonly db: DrizzleDb,
    private readonly atpService: AtpService,
  ) {}

  // -------------------------------------------------------------------------
  // 1. ALLOCATE — compute allocations for a product across all channels
  // -------------------------------------------------------------------------

  /**
   * Calculate inventory allocation for all active channels for a product.
   * Does NOT push to channels — returns the allocation map for the sync
   * service to consume.
   *
   * Algorithm:
   * 1. Get total ATP in base units
   * 2. Load all active channels sorted by priority (descending = highest first)
   * 3. Check product line gates (which channels carry this product)
   * 4. Check product-level allocation rules (isListed, min/max ATP)
   * 5. For each variant, for each eligible channel (in priority order):
   *    a. Check variant-level overrides (hard override qty)
   *    b. Apply channel allocation (% or fixed qty cap)
   *    c. Apply product floor/cap
   *    d. Apply variant floor/cap
   *    e. Priority drawdown: consume from remaining pool
   */
  async allocateProduct(
    productId: number,
    triggeredBy?: string,
  ): Promise<ProductAllocationResult> {
    const result: ProductAllocationResult = {
      productId,
      totalAtpBase: 0,
      allocations: [],
      blocked: [],
    };

    // 1. Get ATP
    const variantAtp = await this.atpService.getAtpPerVariant(productId);
    if (variantAtp.length === 0) return result;

    const atpBase = variantAtp[0].atpBase;
    result.totalAtpBase = atpBase;

    // 2. Load active channels sorted by priority (higher = first in line)
    const activeChannels: Channel[] = await this.db
      .select()
      .from(channels)
      .where(eq(channels.status, "active"))
      .orderBy(sql`${channels.priority} DESC`);

    if (activeChannels.length === 0) return result;

    const channelIds = activeChannels.map((c) => c.id);

    // 3. Product line gate
    const productLineRows = await this.db
      .select({ productLineId: productLineProducts.productLineId })
      .from(productLineProducts)
      .where(eq(productLineProducts.productId, productId));
    const productLineIds = new Set(productLineRows.map((r: any) => r.productLineId));

    let eligibleChannelIds: Set<number> | null = null;
    if (productLineIds.size > 0) {
      const channelLineRows = await this.db
        .select({
          channelId: channelProductLines.channelId,
          productLineId: channelProductLines.productLineId,
        })
        .from(channelProductLines)
        .where(
          and(
            inArray(channelProductLines.channelId, channelIds),
            eq(channelProductLines.isActive, true),
          ),
        );

      eligibleChannelIds = new Set<number>();
      for (const row of channelLineRows) {
        if (productLineIds.has(row.productLineId)) {
          eligibleChannelIds.add(row.channelId);
        }
      }
    }

    // 4. Load product-level allocation rules
    const productAllocations: ChannelProductAllocation[] = channelIds.length > 0
      ? await this.db
          .select()
          .from(channelProductAllocation)
          .where(
            and(
              eq(channelProductAllocation.productId, productId),
              inArray(channelProductAllocation.channelId, channelIds),
            ),
          )
      : [];
    const productAllocMap = new Map(
      productAllocations.map((pa) => [pa.channelId, pa]),
    );

    // 5. Load variant-level reservation rules
    const variantIds = variantAtp.map((v) => v.productVariantId);
    const reservations: ChannelReservation[] = variantIds.length > 0
      ? await this.db
          .select()
          .from(channelReservations)
          .where(inArray(channelReservations.productVariantId, variantIds))
      : [];
    const reservationMap = new Map<string, ChannelReservation>();
    for (const r of reservations) {
      reservationMap.set(`${r.channelId}:${r.productVariantId}`, r);
    }

    // 6. Priority drawdown allocation for each variant
    for (const variant of variantAtp) {
      // Track remaining pool for this variant (priority drawdown)
      let remainingBase = Math.max(0, atpBase);

      // Process channels in priority order (highest first)
      for (const channel of activeChannels) {
        // Product line gate
        if (eligibleChannelIds !== null && !eligibleChannelIds.has(channel.id)) {
          // Only record block once per channel (not per variant)
          if (variant === variantAtp[0]) {
            result.blocked.push({
              channelId: channel.id,
              reason: "Product line not assigned to this channel",
            });
          }
          continue;
        }

        // Product-level isListed gate
        const prodAlloc = productAllocMap.get(channel.id);
        if (prodAlloc && prodAlloc.isListed === 0) {
          if (variant === variantAtp[0]) {
            result.blocked.push({
              channelId: channel.id,
              reason: "Product unlisted on this channel (isListed=0)",
            });
          }
          result.allocations.push({
            channelId: channel.id,
            channelName: channel.name,
            channelProvider: channel.provider,
            channelPriority: channel.priority,
            productVariantId: variant.productVariantId,
            sku: variant.sku,
            unitsPerVariant: variant.unitsPerVariant,
            allocatedUnits: 0,
            allocatedBase: 0,
            method: "zero",
            reason: "Product unlisted on this channel",
          });
          continue;
        }

        const reservation = reservationMap.get(`${channel.id}:${variant.productVariantId}`);

        // --- Variant hard override ---
        if (reservation && reservation.overrideQty != null) {
          const overrideUnits = Math.floor(reservation.overrideQty / variant.unitsPerVariant);
          result.allocations.push({
            channelId: channel.id,
            channelName: channel.name,
            channelProvider: channel.provider,
            channelPriority: channel.priority,
            productVariantId: variant.productVariantId,
            sku: variant.sku,
            unitsPerVariant: variant.unitsPerVariant,
            allocatedUnits: overrideUnits,
            allocatedBase: reservation.overrideQty,
            method: "override",
            reason: reservation.overrideQty === 0
              ? "Variant override: stop selling"
              : `Variant override: fixed ${reservation.overrideQty} base units`,
          });
          // Overrides don't consume from the shared pool (they're hard-set)
          continue;
        }

        // --- Calculate channel's share of the pool ---
        let channelCap = remainingBase; // Default: can take whatever's left
        let method = "priority";
        let reason = "Priority drawdown";

        // Channel allocation constraint (% or fixed)
        if (channel.allocationFixedQty != null) {
          channelCap = Math.min(channelCap, channel.allocationFixedQty);
          method = "fixed";
          reason = `Fixed allocation: ${channel.allocationFixedQty} base units`;
        } else if (channel.allocationPct != null) {
          const pctCap = Math.floor(atpBase * channel.allocationPct / 100);
          channelCap = Math.min(channelCap, pctCap);
          method = "percentage";
          reason = `${channel.allocationPct}% allocation = ${pctCap} base units`;
        }

        // Product floor: if total ATP below threshold, zero out
        if (prodAlloc?.minAtpBase != null && atpBase < prodAlloc.minAtpBase) {
          result.allocations.push({
            channelId: channel.id,
            channelName: channel.name,
            channelProvider: channel.provider,
            channelPriority: channel.priority,
            productVariantId: variant.productVariantId,
            sku: variant.sku,
            unitsPerVariant: variant.unitsPerVariant,
            allocatedUnits: 0,
            allocatedBase: 0,
            method: "zero",
            reason: `Product floor: ATP ${atpBase} < min ${prodAlloc.minAtpBase}`,
          });
          continue;
        }

        // Product cap
        if (prodAlloc?.maxAtpBase != null) {
          channelCap = Math.min(channelCap, prodAlloc.maxAtpBase);
        }

        // Convert to variant units
        let allocatedUnits = Math.floor(channelCap / variant.unitsPerVariant);

        // Variant floor: if allocated qty below min, zero out
        if (reservation?.minStockBase != null && reservation.minStockBase > 0) {
          const minUnits = Math.floor(reservation.minStockBase / variant.unitsPerVariant);
          if (allocatedUnits < minUnits) {
            result.allocations.push({
              channelId: channel.id,
              channelName: channel.name,
              channelProvider: channel.provider,
              channelPriority: channel.priority,
              productVariantId: variant.productVariantId,
              sku: variant.sku,
              unitsPerVariant: variant.unitsPerVariant,
              allocatedUnits: 0,
              allocatedBase: 0,
              method: "zero",
              reason: `Variant floor: allocated ${allocatedUnits} < min ${minUnits} units`,
            });
            continue;
          }
        }

        // Variant cap
        if (reservation?.maxStockBase != null) {
          const maxUnits = Math.floor(reservation.maxStockBase / variant.unitsPerVariant);
          allocatedUnits = Math.min(allocatedUnits, maxUnits);
        }

        // Ensure non-negative
        allocatedUnits = Math.max(0, allocatedUnits);
        const allocatedBase = allocatedUnits * variant.unitsPerVariant;

        // Consume from remaining pool (priority drawdown)
        remainingBase = Math.max(0, remainingBase - allocatedBase);

        result.allocations.push({
          channelId: channel.id,
          channelName: channel.name,
          channelProvider: channel.provider,
          channelPriority: channel.priority,
          productVariantId: variant.productVariantId,
          sku: variant.sku,
          unitsPerVariant: variant.unitsPerVariant,
          allocatedUnits,
          allocatedBase,
          method,
          reason,
        });
      }
    }

    // Audit log the allocation
    await this.logAllocation(result, triggeredBy);

    return result;
  }

  // -------------------------------------------------------------------------
  // 2. GET ALLOCATED QTY — quick lookup for a specific variant+channel
  // -------------------------------------------------------------------------

  /**
   * Get the allocated quantity for a specific variant on a specific channel.
   * Runs the full allocation and extracts the relevant result.
   *
   * For high-frequency use, consider caching the full allocation result.
   */
  async getAllocatedQty(
    productId: number,
    productVariantId: number,
    channelId: number,
  ): Promise<number> {
    const allocation = await this.allocateProduct(productId);
    const match = allocation.allocations.find(
      (a) => a.productVariantId === productVariantId && a.channelId === channelId,
    );
    return match?.allocatedUnits ?? 0;
  }

  // -------------------------------------------------------------------------
  // 3. ALLOCATE AND SYNC — allocate then trigger channel inventory pushes
  // -------------------------------------------------------------------------

  /**
   * Run allocation for a product and trigger channel sync for any changes.
   * Returns the allocation result and which channels need syncing.
   */
  async allocateAndGetSyncTargets(
    productId: number,
    triggeredBy?: string,
  ): Promise<{
    allocation: ProductAllocationResult;
    syncTargets: Array<{
      channelId: number;
      provider: string;
      variantAllocations: Array<{
        productVariantId: number;
        allocatedUnits: number;
      }>;
    }>;
  }> {
    const allocation = await this.allocateProduct(productId, triggeredBy);

    // Group allocations by channel
    const byChannel = new Map<number, {
      provider: string;
      variants: Array<{ productVariantId: number; allocatedUnits: number }>;
    }>();

    for (const a of allocation.allocations) {
      if (!byChannel.has(a.channelId)) {
        byChannel.set(a.channelId, {
          provider: a.channelProvider,
          variants: [],
        });
      }
      byChannel.get(a.channelId)!.variants.push({
        productVariantId: a.productVariantId,
        allocatedUnits: a.allocatedUnits,
      });
    }

    const syncTargets = Array.from(byChannel.entries()).map(([channelId, data]) => ({
      channelId,
      provider: data.provider,
      variantAllocations: data.variants,
    }));

    return { allocation, syncTargets };
  }

  // -------------------------------------------------------------------------
  // PRIVATE: Audit Logging
  // -------------------------------------------------------------------------

  private async logAllocation(
    result: ProductAllocationResult,
    triggeredBy?: string,
  ): Promise<void> {
    if (result.allocations.length === 0) return;

    try {
      // Batch insert audit entries (one per variant-channel combination)
      const entries = result.allocations.map((a) => ({
        productId: result.productId,
        productVariantId: a.productVariantId,
        channelId: a.channelId,
        totalAtpBase: result.totalAtpBase,
        allocatedQty: a.allocatedUnits,
        previousQty: null as number | null, // Could be loaded from last sync, but adds latency
        allocationMethod: a.method,
        details: {
          reason: a.reason,
          channelPriority: a.channelPriority,
          unitsPerVariant: a.unitsPerVariant,
          allocatedBase: a.allocatedBase,
        },
        triggeredBy: triggeredBy ?? null,
      }));

      // Batch in chunks of 100
      for (let i = 0; i < entries.length; i += 100) {
        const chunk = entries.slice(i, i + 100);
        await this.db.insert(allocationAuditLog).values(chunk);
      }
    } catch (err: any) {
      // Don't let audit logging failures break allocation
      console.warn(`[AllocationEngine] Failed to log allocation audit: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAllocationEngine(db: any, atpService: any) {
  return new AllocationEngine(db, atpService);
}

export type { AllocationEngine };
