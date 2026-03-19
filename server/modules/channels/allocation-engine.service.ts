/**
 * Inventory Allocation Engine — Parallel Percentage Model
 *
 * Three-layer parallel allocation:
 *
 *   Layer 1: Warehouse → Channel Assignment
 *     Each channel sees ATP only from its assigned warehouses.
 *     If no assignments exist, all fulfillment warehouses are used.
 *
 *   Layer 2: Channel Allocation Rules
 *     Three modes: mirror (100%), share (X%), fixed (N units)
 *     Rules are scoped: channel default → product override → variant override
 *     Most-specific rule wins. Includes floor/ceiling/eligible controls.
 *
 *   Layer 3: ATP Calculation (parallel, not serial)
 *     Each channel computes its ATP independently — no drawdown.
 *     Channels see independent parallel views of inventory.
 *
 * All operations are idempotent and audit-logged.
 */

import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import {
  channels,
  channelWarehouseAssignments,
  channelAllocationRules,
  channelProductLines,
  productVariants,
  productLineProducts,
  allocationAuditLog,
  warehouses,
  type Channel,
  type ChannelAllocationRule,
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
  getAtpBaseByWarehouse?(productId: number, warehouseId: number): Promise<number>;
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
  /** Method used: mirror, share, fixed, zero (blocked/floor/ineligible) */
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

/** Resolved allocation rule after scope resolution */
interface ResolvedRule {
  mode: "mirror" | "share" | "fixed";
  sharePct: number | null;
  fixedQty: number | null;
  floorAtp: number;
  ceilingQty: number | null;
  eligible: boolean;
  scope: "channel" | "product" | "variant";
}

/** Default rule when no rules exist for a channel */
const DEFAULT_RULE: ResolvedRule = {
  mode: "mirror",
  sharePct: null,
  fixedQty: null,
  floorAtp: 0,
  ceilingQty: null,
  eligible: true,
  scope: "channel",
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class AllocationEngine {
  constructor(
    private readonly db: DrizzleDb,
    private readonly atpService: AtpService,
  ) {}

  // -------------------------------------------------------------------------
  // 1. ALLOCATE — compute parallel allocations for a product
  // -------------------------------------------------------------------------

  /**
   * Calculate inventory allocation for all active channels for a product.
   *
   * Algorithm (parallel — each channel independently):
   * 1. Load active channels
   * 2. For each channel:
   *    a. Determine assigned warehouses (or all fulfillment warehouses)
   *    b. Sum ATP across assigned warehouses → base_atp
   *    c. Load allocation rules (channel default, product override, variant override)
   *    d. For each variant, resolve most-specific rule and compute channel ATP
   * 3. Audit log all decisions
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

    // 1. Get global ATP (for the result summary)
    const globalVariantAtp = await this.atpService.getAtpPerVariant(productId);
    if (globalVariantAtp.length === 0) return result;

    result.totalAtpBase = globalVariantAtp[0].atpBase;

    // 2. Load active channels
    const activeChannels: Channel[] = await this.db
      .select()
      .from(channels)
      .where(eq(channels.status, "active"))
      .orderBy(sql`${channels.priority} DESC`);

    if (activeChannels.length === 0) return result;

    const channelIds = activeChannels.map((c) => c.id);

    // 3. Product line gate check
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

    // 4. Load warehouse assignments for all channels
    const warehouseAssignments = await this.db
      .select()
      .from(channelWarehouseAssignments)
      .where(
        and(
          inArray(channelWarehouseAssignments.channelId, channelIds),
          eq(channelWarehouseAssignments.enabled, true),
        ),
      );

    // Group warehouse IDs by channel
    const warehousesByChannel = new Map<number, number[]>();
    for (const wa of warehouseAssignments) {
      const list = warehousesByChannel.get(wa.channelId) ?? [];
      list.push(wa.warehouseId);
      warehousesByChannel.set(wa.channelId, list);
    }

    // 5. Load all fulfillment warehouses (fallback when no assignments)
    let allFulfillmentWarehouseIds: number[] | null = null;
    const channelsNeedingDefault = activeChannels.filter(
      (c) => !warehousesByChannel.has(c.id),
    );
    if (channelsNeedingDefault.length > 0) {
      const fulfillmentWarehouses = await this.db
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(
          and(
            eq(warehouses.isActive, 1),
            inArray(warehouses.warehouseType, ["operations", "3pl"]),
          ),
        );
      allFulfillmentWarehouseIds = fulfillmentWarehouses.map((w: any) => w.id);
    }

    // 6. Load allocation rules for all channels
    const allRules: ChannelAllocationRule[] = await this.db
      .select()
      .from(channelAllocationRules)
      .where(inArray(channelAllocationRules.channelId, channelIds));

    // Index rules by channel for fast lookup
    const rulesByChannel = new Map<number, ChannelAllocationRule[]>();
    for (const rule of allRules) {
      const list = rulesByChannel.get(rule.channelId) ?? [];
      list.push(rule);
      rulesByChannel.set(rule.channelId, list);
    }

    // 7. For each channel, compute ATP independently (parallel model)
    for (const channel of activeChannels) {
      // Product line gate
      if (eligibleChannelIds !== null && !eligibleChannelIds.has(channel.id)) {
        result.blocked.push({
          channelId: channel.id,
          reason: "Product line not assigned to this channel",
        });
        continue;
      }

      // Determine assigned warehouses
      const assignedWarehouseIds = warehousesByChannel.get(channel.id)
        ?? allFulfillmentWarehouseIds
        ?? [];

      // Calculate base ATP summed across assigned warehouses
      let channelBaseAtp = 0;
      for (const whId of assignedWarehouseIds) {
        if (this.atpService.getAtpBaseByWarehouse) {
          channelBaseAtp += await this.atpService.getAtpBaseByWarehouse(productId, whId);
        } else {
          // Fallback: use per-variant-by-warehouse (first variant's atpBase)
          const whVariants = await this.atpService.getAtpPerVariantByWarehouse(productId, whId);
          if (whVariants.length > 0) {
            channelBaseAtp += whVariants[0].atpBase;
          }
        }
      }

      // Get channel's rules
      const channelRules = rulesByChannel.get(channel.id) ?? [];

      // Resolve channel-level default rule
      const channelDefaultRule = channelRules.find(
        (r) => r.productId === null && r.productVariantId === null,
      );

      // Resolve product-level rule
      const productRule = channelRules.find(
        (r) => r.productId === productId && r.productVariantId === null,
      );

      // Check product-level eligibility first
      const productResolvedRule = this.resolveRule(channelDefaultRule, productRule, undefined);
      if (!productResolvedRule.eligible) {
        result.blocked.push({
          channelId: channel.id,
          reason: "Product ineligible for this channel",
        });
        // Push zero allocations for all variants
        for (const variant of globalVariantAtp) {
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
            reason: "Product ineligible for this channel",
          });
        }
        continue;
      }

      // Per-variant allocation
      for (const variant of globalVariantAtp) {
        // Find variant-level rule (productId may be null on variant-scoped rules)
        const variantRule = channelRules.find(
          (r) => r.productVariantId === variant.productVariantId,
        );

        const resolved = this.resolveRule(channelDefaultRule, productRule, variantRule);
        const allocation = this.computeAllocation(
          channelBaseAtp,
          variant,
          resolved,
          channel,
          assignedWarehouseIds,
        );

        result.allocations.push(allocation);
      }
    }

    // Audit log
    await this.logAllocation(result, triggeredBy);

    return result;
  }

  // -------------------------------------------------------------------------
  // Rule Resolution — most specific wins
  // -------------------------------------------------------------------------

  /**
   * Resolve the most specific rule. Variant > Product > Channel default.
   * If no rules exist at all, returns the DEFAULT_RULE (mirror, 100%).
   */
  private resolveRule(
    channelDefault?: ChannelAllocationRule | null,
    productOverride?: ChannelAllocationRule | null,
    variantOverride?: ChannelAllocationRule | null,
  ): ResolvedRule {
    // Most specific wins
    const rule = variantOverride ?? productOverride ?? channelDefault;
    if (!rule) return { ...DEFAULT_RULE };

    const scope = variantOverride ? "variant"
      : productOverride ? "product"
      : "channel";

    return {
      mode: rule.mode as "mirror" | "share" | "fixed",
      sharePct: rule.sharePct,
      fixedQty: rule.fixedQty,
      floorAtp: rule.floorAtp ?? 0,
      ceilingQty: rule.ceilingQty,
      eligible: rule.eligible,
      scope,
    };
  }

  // -------------------------------------------------------------------------
  // ATP Computation — single variant, single channel
  // -------------------------------------------------------------------------

  private computeAllocation(
    channelBaseAtp: number,
    variant: { productVariantId: number; sku: string; name: string; unitsPerVariant: number },
    rule: ResolvedRule,
    channel: Channel,
    assignedWarehouseIds: number[],
  ): VariantChannelAllocation {
    const base = {
      channelId: channel.id,
      channelName: channel.name,
      channelProvider: channel.provider,
      channelPriority: channel.priority,
      productVariantId: variant.productVariantId,
      sku: variant.sku,
      unitsPerVariant: variant.unitsPerVariant,
    };

    // Step 1: Eligibility check
    if (!rule.eligible) {
      return {
        ...base,
        allocatedUnits: 0,
        allocatedBase: 0,
        method: "zero",
        reason: "Variant ineligible for this channel",
      };
    }

    // Step 2: Floor check — if base ATP below threshold, zero out
    if (channelBaseAtp < rule.floorAtp) {
      return {
        ...base,
        allocatedUnits: 0,
        allocatedBase: 0,
        method: "zero",
        reason: `Floor triggered: ATP ${channelBaseAtp} < floor ${rule.floorAtp}`,
      };
    }

    // Step 3: Apply allocation mode
    let atpBase: number;
    let method: string;
    let reason: string;

    switch (rule.mode) {
      case "mirror":
        atpBase = channelBaseAtp;
        method = "mirror";
        reason = `Mirror: 100% of ${channelBaseAtp} base ATP (warehouses: [${assignedWarehouseIds.join(",")}])`;
        break;

      case "share":
        const pct = rule.sharePct ?? 100;
        atpBase = Math.floor(channelBaseAtp * pct / 100);
        method = "share";
        reason = `Share: ${pct}% of ${channelBaseAtp} = ${atpBase} base units (warehouses: [${assignedWarehouseIds.join(",")}])`;
        break;

      case "fixed":
        atpBase = Math.min(rule.fixedQty ?? 0, channelBaseAtp);
        method = "fixed";
        reason = `Fixed: ${rule.fixedQty} base units (capped by ATP ${channelBaseAtp}, warehouses: [${assignedWarehouseIds.join(",")}])`;
        break;

      default:
        atpBase = channelBaseAtp;
        method = "mirror";
        reason = `Default mirror: 100% of ${channelBaseAtp}`;
    }

    // Step 4: Apply ceiling
    if (rule.ceilingQty != null) {
      if (atpBase > rule.ceilingQty) {
        reason += ` → ceiling capped from ${atpBase} to ${rule.ceilingQty}`;
        atpBase = rule.ceilingQty;
      }
    }

    // Step 5: Convert to variant units
    const allocatedUnits = Math.max(0, Math.floor(atpBase / variant.unitsPerVariant));
    const allocatedBase = allocatedUnits * variant.unitsPerVariant;

    return {
      ...base,
      allocatedUnits,
      allocatedBase,
      method,
      reason,
    };
  }

  // -------------------------------------------------------------------------
  // 2. GET ALLOCATED QTY — quick lookup for a specific variant+channel
  // -------------------------------------------------------------------------

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
  // 3. ALLOCATE AND GET SYNC TARGETS
  // -------------------------------------------------------------------------

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
      const entries = result.allocations.map((a) => ({
        productId: result.productId,
        productVariantId: a.productVariantId,
        channelId: a.channelId,
        totalAtpBase: result.totalAtpBase,
        allocatedQty: a.allocatedUnits,
        previousQty: null as number | null,
        allocationMethod: a.method,
        details: {
          reason: a.reason,
          channelPriority: a.channelPriority,
          unitsPerVariant: a.unitsPerVariant,
          allocatedBase: a.allocatedBase,
        },
        triggeredBy: triggeredBy ?? null,
      }));

      for (let i = 0; i < entries.length; i += 100) {
        const chunk = entries.slice(i, i + 100);
        await this.db.insert(allocationAuditLog).values(chunk);
      }
    } catch (err: any) {
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
