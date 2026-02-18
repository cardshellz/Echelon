/**
 * CycleCountService — Inventory reconciliation through physical bin counting.
 *
 * Extracted from routes.ts to follow the service extraction pattern used by
 * picking and order-combining services.
 *
 * Workflow: draft → initialize (snapshot bins) → count items → approve/reject
 * variances → complete.
 *
 * Key concepts:
 *   - SKU mismatch pairs: when a counter finds a different SKU than expected,
 *     two linked items are created (expected_missing + unexpected_found).
 *   - Auto-approve tolerance: small variances can be auto-committed.
 *   - Bin reconciliation: after approval, product_locations (bin assignments)
 *     are synced with physical reality.
 */

import { sql, eq } from "drizzle-orm";
import type { CycleCountItem, InsertCycleCount, CycleCount } from "@shared/schema";

// ---------------------------------------------------------------------------
// Dependency interfaces (minimal — only methods actually called)
// ---------------------------------------------------------------------------

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: (...args: any[]) => any;
};

type InventoryCore = {
  adjustInventory(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qtyDelta: number;
    reason: string;
    cycleCountId: number;
    userId: string | undefined;
    allowNegative: boolean;
  }): Promise<any>;
};

type ChannelSync = {
  queueSyncAfterInventoryChange(variantId: number): Promise<void>;
};

type Replenishment = {
  checkAndTriggerAfterPick(variantId: number, locationId: number): Promise<any>;
};

type Storage = {
  // Cycle counts
  getAllCycleCounts(): Promise<CycleCount[]>;
  getCycleCountById(id: number): Promise<CycleCount | undefined>;
  createCycleCount(data: InsertCycleCount): Promise<CycleCount>;
  updateCycleCount(id: number, updates: Partial<InsertCycleCount>): Promise<CycleCount | null>;
  deleteCycleCount(id: number): Promise<boolean>;
  // Cycle count items
  getCycleCountItems(cycleCountId: number): Promise<CycleCountItem[]>;
  getCycleCountItemById(id: number): Promise<CycleCountItem | undefined>;
  updateCycleCountItem(id: number, updates: Partial<any>): Promise<CycleCountItem | null>;
  deleteCycleCountItem(id: number): Promise<boolean>;
  bulkCreateCycleCountItems(items: any[]): Promise<CycleCountItem[]>;
  // Warehouse locations
  getAllWarehouseLocations(): Promise<any[]>;
  getWarehouseLocationById(id: number): Promise<any | undefined>;
  // Product locations (bin assignments)
  getProductLocationByComposite(productId: number, warehouseLocationId: number): Promise<any | undefined>;
  deleteProductLocation(id: number): Promise<boolean>;
  createProductLocation(data: any): Promise<any>;
  getProductById(id: number): Promise<any | undefined>;
  // Products & variants
  getProductVariantBySku(sku: string): Promise<any | undefined>;
  getProductVariantById(id: number): Promise<any | undefined>;
  getProductById(id: number): Promise<any | undefined>;
  getProductBySku(sku: string): Promise<any | undefined>;
  createProduct(data: any): Promise<any>;
  createProductVariant(data: any): Promise<any>;
  // Settings
  getSetting(key: string): Promise<string | null>;
};

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class CycleCountError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "CycleCountError";
  }
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ApprovalAdjustment {
  sku: string | null;
  type: string | null;
  qtyChange: number;
  locationId: number;
}

export interface ApproveResult {
  success: boolean;
  adjustmentsMade: ApprovalAdjustment[];
  linkedItemsApproved: number;
}

export interface BulkApproveResult {
  success: boolean;
  approved: number;
  skipped: number;
  adjustmentsMade: number;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class CycleCountService {
  constructor(
    private db: DrizzleDb,
    private inventoryCore: InventoryCore,
    private channelSync: ChannelSync,
    private replenishment: Replenishment,
    private storage: Storage,
  ) {}

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * After cycle count approval, sync product_locations (bin assignments)
   * to match physical reality. Only acts on pick-type locations.
   */
  private async reconcileBinAssignment(item: CycleCountItem): Promise<void> {
    if (!item.varianceType) return;

    const loc = await this.storage.getWarehouseLocationById(item.warehouseLocationId);
    if (!loc || loc.locationType !== "pick") return;

    // EXPECTED_MISSING: old SKU no longer in this bin → remove assignment
    if (item.mismatchType === "expected_missing") {
      if (!item.productId) return;
      const existing = await this.storage.getProductLocationByComposite(item.productId, item.warehouseLocationId);
      if (existing) await this.storage.deleteProductLocation(existing.id);
      return;
    }

    // UNEXPECTED_FOUND or standalone UNEXPECTED_ITEM: new SKU lives here → create assignment
    if (item.mismatchType === "unexpected_found" ||
        (item.varianceType === "unexpected_item" && !item.mismatchType)) {
      if (!item.productId) return;
      const existing = await this.storage.getProductLocationByComposite(item.productId, item.warehouseLocationId);
      if (existing) return; // idempotent

      const product = await this.storage.getProductById(item.productId);
      if (!product) return;

      await this.storage.createProductLocation({
        productId: item.productId,
        sku: item.countedSku?.toUpperCase() || product.sku || null,
        name: product.name || item.countedSku || "Unknown",
        location: loc.code,
        zone: loc.zone || "U",
        warehouseLocationId: item.warehouseLocationId,
        locationType: loc.locationType,
        isPrimary: 1,
        status: "active",
      });
    }
    // quantity_over, quantity_under: no bin assignment changes needed
  }

  /**
   * Compute bin-level stats from cycle count items.
   * A bin is "counted" if at least one item is not pending.
   * A bin has a "variance" if counted AND has any item with varianceType.
   */
  private computeBinStats(items: { warehouseLocationId: number; status: string; varianceType: string | null }[]) {
    const bins = new Map<number, typeof items>();
    for (const item of items) {
      const arr = bins.get(item.warehouseLocationId);
      if (arr) arr.push(item);
      else bins.set(item.warehouseLocationId, [item]);
    }
    let countedBins = 0;
    let varianceBins = 0;
    for (const binItems of bins.values()) {
      const allPending = binItems.every(i => i.status === "pending");
      if (!allPending) countedBins++;
      if (!allPending && binItems.some(i => i.varianceType)) varianceBins++;
    }
    return { countedBins, varianceCount: varianceBins };
  }

  /**
   * Lookup product_variants and products by SKU (case-insensitive).
   */
  private async lookupVariantAndProductBySku(sku: string): Promise<{ productVariantId: number | null; productId: number | null }> {
    const variantResult = await this.db.execute<{ id: number }>(sql`
      SELECT id FROM product_variants WHERE UPPER(sku) = ${sku.toUpperCase()} LIMIT 1
    `);
    const productVariantId = variantResult.rows[0]?.id || null;

    const productResult = await this.db.execute<{ id: number }>(sql`
      SELECT id FROM products WHERE UPPER(sku) = ${sku.toUpperCase()} LIMIT 1
    `);
    const productId = productResult.rows[0]?.id || null;

    return { productVariantId, productId };
  }

  /**
   * Clean up mismatch linked items when re-counting or resetting.
   * Deletes forward-linked and reverse-linked items that aren't approved.
   */
  private async cleanupMismatchLinks(itemId: number, item: CycleCountItem): Promise<void> {
    // Delete forward-linked item
    if (item.relatedItemId) {
      const linkedItem = await this.storage.getCycleCountItemById(item.relatedItemId);
      if (linkedItem && linkedItem.status !== "approved") {
        await this.storage.deleteCycleCountItem(item.relatedItemId);
      }
    }
    // Delete reverse-linked items
    const reverseResult = await this.db.execute<{ id: number; status: string }>(sql`
      SELECT id, status FROM cycle_count_items
      WHERE related_item_id = ${itemId} AND status != 'approved'
    `);
    for (const rev of reverseResult.rows) {
      await this.storage.deleteCycleCountItem(rev.id);
    }
  }

  /**
   * Core approval logic for a single item. Shared by approveVariance and bulkApprove.
   * Returns the adjustment info if inventory was changed.
   */
  private async approveItemCore(
    item: CycleCountItem,
    reasonCode: string,
    notes: string | undefined,
    approvedBy: string | undefined,
  ): Promise<ApprovalAdjustment | null> {
    let adjustment: ApprovalAdjustment | null = null;

    // Apply inventory adjustment if item has a variant and non-zero variance
    if (item.productVariantId && item.varianceQty !== null && item.varianceQty !== 0) {
      await this.inventoryCore.adjustInventory({
        productVariantId: item.productVariantId,
        warehouseLocationId: item.warehouseLocationId,
        qtyDelta: item.varianceQty,
        reason: `Cycle count adjustment: ${item.expectedSku || item.countedSku}. ${notes || ''}`.trim(),
        cycleCountId: item.cycleCountId,
        userId: approvedBy,
        allowNegative: true,
      });
      adjustment = {
        sku: item.expectedSku || item.countedSku,
        type: item.mismatchType || item.varianceType,
        qtyChange: item.varianceQty,
        locationId: item.warehouseLocationId,
      };
    }

    // Mark as approved
    await this.storage.updateCycleCountItem(item.id, {
      status: "approved",
      approvedBy,
      approvedAt: new Date(),
      varianceReason: reasonCode,
    });
    await this.reconcileBinAssignment(item);

    return adjustment;
  }

  /**
   * Fire channel sync + replen checks for adjustments (fire-and-forget).
   */
  private async firePostApprovalSideEffects(adjustments: ApprovalAdjustment[]): Promise<void> {
    if (adjustments.length === 0) return;

    // Channel sync for all adjusted variants
    const syncedVariants = new Set<number>();
    for (const adj of adjustments) {
      if (!adj.sku) continue;
      const variant = await this.storage.getProductVariantBySku(adj.sku);
      if (variant && !syncedVariants.has(variant.id)) {
        syncedVariants.add(variant.id);
        this.channelSync.queueSyncAfterInventoryChange(variant.id).catch((err: any) =>
          console.warn(`[ChannelSync] Post-cycle-count sync failed for ${adj.sku}:`, err)
        );
      }
    }

    // Replen checks for negative adjustments only
    for (const adj of adjustments) {
      if (adj.qtyChange >= 0 || !adj.sku) continue;
      const variant = await this.storage.getProductVariantBySku(adj.sku);
      if (variant) {
        this.replenishment.checkAndTriggerAfterPick(variant.id, adj.locationId).catch((err: any) =>
          console.warn(`[Replen] Post-cycle-count threshold check failed for ${adj.sku}:`, err)
        );
      }
    }
  }

  /**
   * Refresh bin stats on the cycle count header after any item change.
   */
  private async refreshBinStats(cycleCountId: number): Promise<void> {
    const cycleCount = await this.storage.getCycleCountById(cycleCountId);
    if (cycleCount) {
      const allItems = await this.storage.getCycleCountItems(cycleCountId);
      const binStats = this.computeBinStats(allItems);
      await this.storage.updateCycleCount(cycleCountId, binStats);
    }
  }

  // =========================================================================
  // Public methods
  // =========================================================================

  async getAll(): Promise<CycleCount[]> {
    return this.storage.getAllCycleCounts();
  }

  async getById(id: number) {
    const cycleCount = await this.storage.getCycleCountById(id);
    if (!cycleCount) throw new CycleCountError("Cycle count not found", 404);

    const items = await this.storage.getCycleCountItems(id);

    // Enrich items with location details
    const enrichedItems = await Promise.all(items.map(async (item) => {
      const location = await this.storage.getWarehouseLocationById(item.warehouseLocationId);
      return { ...item, locationCode: location?.code, zone: location?.zone };
    }));

    return { ...cycleCount, items: enrichedItems };
  }

  async getVarianceSummary(id: number) {
    const items = await this.storage.getCycleCountItems(id);

    const variantMap = new Map<number, { sku: string; productVariantId: number; locations: any[]; totalVariance: number }>();

    for (const item of items) {
      if (!item.varianceType || !item.productVariantId) continue;

      const sku = item.expectedSku || item.countedSku || "Unknown";
      const existing = variantMap.get(item.productVariantId);
      const location = await this.storage.getWarehouseLocationById(item.warehouseLocationId);

      const locEntry = {
        locationId: item.warehouseLocationId,
        locationCode: location?.code || "?",
        zone: location?.zone,
        varianceQty: item.varianceQty ?? 0,
        varianceType: item.varianceType,
        mismatchType: item.mismatchType,
        status: item.status,
        itemId: item.id,
      };

      if (existing) {
        existing.locations.push(locEntry);
        existing.totalVariance += item.varianceQty ?? 0;
      } else {
        variantMap.set(item.productVariantId, {
          sku,
          productVariantId: item.productVariantId,
          locations: [locEntry],
          totalVariance: item.varianceQty ?? 0,
        });
      }
    }

    const skuSummaries = Array.from(variantMap.values()).map(entry => ({
      ...entry,
      netVariance: entry.totalVariance,
      classification: entry.totalVariance === 0
        ? "misplacement"
        : entry.totalVariance > 0
          ? "surplus"
          : "shortage",
    }));

    return { skuSummaries };
  }

  async create(data: { name: string; description?: string; warehouseId?: number; zoneFilter?: string; locationTypeFilter?: string; binTypeFilter?: string }, createdBy?: string) {
    if (!data.name) throw new CycleCountError("Name is required");

    return this.storage.createCycleCount({
      name: data.name,
      description: data.description,
      warehouseId: data.warehouseId || null,
      zoneFilter: data.zoneFilter || null,
      locationTypeFilter: data.locationTypeFilter || null,
      binTypeFilter: data.binTypeFilter || null,
      status: "draft",
      createdBy,
    });
  }

  async initialize(id: number) {
    const cycleCount = await this.storage.getCycleCountById(id);
    if (!cycleCount) throw new CycleCountError("Cycle count not found", 404);
    if (cycleCount.status !== "draft") throw new CycleCountError("Can only initialize draft cycle counts");

    // Filter locations by cycle count scope
    let locations = await this.storage.getAllWarehouseLocations();
    if (cycleCount.zoneFilter) {
      locations = locations.filter((l: any) => l.zone === cycleCount.zoneFilter);
    }
    if (cycleCount.warehouseId) {
      locations = locations.filter((l: any) => l.warehouseId === cycleCount.warehouseId);
    }
    if (cycleCount.locationTypeFilter) {
      const allowedTypes = cycleCount.locationTypeFilter.split(",").map((t: string) => t.trim());
      locations = locations.filter((l: any) => allowedTypes.includes(l.locationType));
    }
    if (cycleCount.binTypeFilter) {
      const allowedBinTypes = cycleCount.binTypeFilter.split(",").map((t: string) => t.trim());
      locations = locations.filter((l: any) => allowedBinTypes.includes(l.binType));
    }

    // Snapshot current inventory for each location
    const items: any[] = [];
    for (const location of locations) {
      const result = await this.db.execute<{
        product_variant_id: number;
        variant_qty: number;
        product_id: number | null;
        sku: string | null;
      }>(sql`
        SELECT
          il.product_variant_id,
          il.variant_qty,
          p.id as product_id,
          COALESCE(pv.sku, p.sku) as sku
        FROM inventory_levels il
        LEFT JOIN product_variants pv ON il.product_variant_id = pv.id
        LEFT JOIN products p ON pv.product_id = p.id
        WHERE il.warehouse_location_id = ${location.id}
          AND il.variant_qty > 0
      `);

      if (result.rows.length > 0) {
        for (const row of result.rows) {
          items.push({
            cycleCountId: id,
            warehouseLocationId: location.id,
            productVariantId: row.product_variant_id,
            productId: row.product_id,
            expectedSku: row.sku,
            expectedQty: row.variant_qty,
            status: "pending",
          });
        }
      } else {
        // Empty bin — still create item to verify it's empty
        items.push({
          cycleCountId: id,
          warehouseLocationId: location.id,
          productVariantId: null,
          productId: null,
          expectedSku: null,
          expectedQty: 0,
          status: "pending",
        });
      }
    }

    if (items.length > 0) {
      await this.storage.bulkCreateCycleCountItems(items);
    }

    await this.storage.updateCycleCount(id, {
      status: "in_progress",
      totalBins: locations.length,
      countedBins: 0,
      startedAt: new Date(),
    });

    return { success: true, binsCreated: locations.length, itemsCreated: items.length };
  }

  async recordCount(
    id: number,
    itemId: number,
    params: { countedSku?: string; countedQty: number; notes?: string },
    userId?: string,
  ) {
    const countedSku = params.countedSku?.trim() || null;
    const { countedQty, notes } = params;

    const item = await this.storage.getCycleCountItemById(itemId);
    if (!item) throw new CycleCountError("Item not found", 404);

    // Clean up existing mismatch pairs when re-counting
    if (item.status !== "pending" && (item.relatedItemId || item.mismatchType)) {
      await this.cleanupMismatchLinks(itemId, item);
      await this.storage.updateCycleCountItem(itemId, {
        mismatchType: null,
        relatedItemId: null,
      });
      Object.assign(item, { mismatchType: null, relatedItemId: null });
    }

    const varianceQty = (countedQty ?? 0) - (item.expectedQty ?? 0);
    let varianceType: string | null = null;
    let createdFoundItem = false;

    // Only treat different SKUs as mismatch for pick locations.
    // Reserve/staging locations hold changing inventory — SKU differences are normal quantity variances.
    const warehouseLoc = await this.storage.getWarehouseLocationById(item.warehouseLocationId);
    const isPickLocation = warehouseLoc?.locationType === "pick";

    const isSkuMismatch = isPickLocation
      && countedSku && item.expectedSku
      && countedSku.toUpperCase() !== item.expectedSku.toUpperCase();

    if (isSkuMismatch) {
      // SKU MISMATCH: create two linked items
      varianceType = "sku_mismatch";

      // Mark original as expected_missing
      await this.storage.updateCycleCountItem(itemId, {
        countedSku: null,
        countedQty: 0,
        varianceQty: -(item.expectedQty ?? 0),
        varianceType: "quantity_under",
        varianceNotes: `Expected ${item.expectedSku} not found. Different SKU (${countedSku}) was in bin. ${notes || ''}`.trim(),
        status: "variance",
        requiresApproval: 1,
        mismatchType: "expected_missing",
        countedBy: userId,
        countedAt: new Date(),
      });

      // Lookup variant + product for the found SKU
      const { productVariantId: foundProductVariantId, productId: foundProductId } =
        await this.lookupVariantAndProductBySku(countedSku!);

      // Create new item for the FOUND product
      const foundItemResult = await this.db.execute<{ id: number }>(sql`
        INSERT INTO cycle_count_items (
          cycle_count_id, warehouse_location_id, product_variant_id, product_id,
          expected_sku, expected_qty, counted_sku, counted_qty,
          variance_qty, variance_type, variance_notes, status,
          requires_approval, mismatch_type, related_item_id,
          counted_by, counted_at, created_at
        ) VALUES (
          ${item.cycleCountId}, ${item.warehouseLocationId}, ${foundProductVariantId}, ${foundProductId},
          NULL, 0, ${countedSku}, ${countedQty},
          ${countedQty}, 'unexpected_item', ${`Found in bin where ${item.expectedSku} was expected. ${notes || ''}`.trim()}, 'variance',
          1, 'unexpected_found', ${itemId},
          ${userId}, NOW(), NOW()
        ) RETURNING id
      `);

      const foundItemId = foundItemResult.rows[0]?.id;
      if (foundItemId) {
        await this.storage.updateCycleCountItem(itemId, { relatedItemId: foundItemId });
        createdFoundItem = true;
      }

    } else if (countedQty > 0 && !item.expectedSku) {
      // Unexpected item in empty bin
      varianceType = "unexpected_item";

      let foundProductVariantId: number | null = null;
      let foundProductId: number | null = null;
      if (countedSku) {
        const lookup = await this.lookupVariantAndProductBySku(countedSku);
        foundProductVariantId = lookup.productVariantId;
        foundProductId = lookup.productId;
      }

      await this.storage.updateCycleCountItem(itemId, {
        countedSku: countedSku || null,
        countedQty,
        varianceQty,
        varianceType,
        varianceNotes: notes || null,
        status: "variance",
        requiresApproval: isPickLocation ? 1 : 0, // Reserve bins: auto-approvable, no assignment impact
        mismatchType: isPickLocation ? "unexpected_found" : null,
        ...(foundProductVariantId && { productVariantId: foundProductVariantId }),
        ...(foundProductId && { productId: foundProductId }),
        countedBy: userId,
        countedAt: new Date(),
      });

    } else {
      // Normal count (same SKU or empty bin)
      if (varianceQty > 0) varianceType = "quantity_over";
      else if (varianceQty < 0) varianceType = "quantity_under";

      // Configurable tolerance and threshold
      const toleranceSetting = await this.storage.getSetting("cycle_count_auto_approve_tolerance");
      const thresholdSetting = await this.storage.getSetting("cycle_count_approval_threshold");
      const autoApproveTolerance = parseInt(toleranceSetting || "0", 10);
      const approvalThreshold = parseInt(thresholdSetting || "10", 10);

      const absVariance = Math.abs(varianceQty);
      const withinTolerance = autoApproveTolerance > 0 && absVariance > 0 && absVariance <= autoApproveTolerance;
      const requiresApproval = absVariance > approvalThreshold;

      if (withinTolerance && varianceType && item.productVariantId) {
        // Auto-approve: apply adjustment immediately
        await this.inventoryCore.adjustInventory({
          productVariantId: item.productVariantId,
          warehouseLocationId: item.warehouseLocationId,
          qtyDelta: varianceQty,
          reason: `Cycle count auto-approved (within tolerance ±${autoApproveTolerance}): ${item.expectedSku || countedSku}`,
          cycleCountId: item.cycleCountId,
          userId,
          allowNegative: true,
        });

        await this.storage.updateCycleCountItem(itemId, {
          countedSku: countedSku || null,
          countedQty,
          varianceQty,
          varianceType,
          varianceNotes: notes || null,
          status: "approved",
          varianceReason: "within_tolerance",
          requiresApproval: 0,
          approvedBy: userId,
          approvedAt: new Date(),
          countedBy: userId,
          countedAt: new Date(),
        });
        await this.reconcileBinAssignment({ ...item, varianceType, mismatchType: item.mismatchType } as CycleCountItem);
      } else {
        await this.storage.updateCycleCountItem(itemId, {
          countedSku: countedSku || null,
          countedQty,
          varianceQty,
          varianceType,
          varianceNotes: notes || null,
          status: varianceType ? "variance" : "counted",
          requiresApproval: requiresApproval ? 1 : 0,
          countedBy: userId,
          countedAt: new Date(),
        });
      }
    }

    // Refresh bin stats
    await this.refreshBinStats(item.cycleCountId);

    return {
      success: true,
      varianceType,
      varianceQty,
      requiresApproval: true,
      skuMismatch: !!isSkuMismatch,
      createdFoundItem,
    };
  }

  async resetItem(id: number, itemId: number) {
    const item = await this.storage.getCycleCountItemById(itemId);
    if (!item) throw new CycleCountError("Item not found", 404);
    if (item.status === "approved" || item.status === "adjusted") {
      throw new CycleCountError("Cannot reset an approved/adjusted item");
    }

    // Clean up linked mismatch items
    await this.cleanupMismatchLinks(itemId, item);

    // Reset to pending
    await this.storage.updateCycleCountItem(itemId, {
      countedSku: null,
      countedQty: null,
      varianceQty: null,
      varianceType: null,
      varianceNotes: null,
      varianceReason: null,
      mismatchType: null,
      relatedItemId: null,
      requiresApproval: 0,
      countedBy: null,
      countedAt: null,
      status: "pending",
    });

    await this.refreshBinStats(item.cycleCountId);
    return { success: true };
  }

  async investigateItem(id: number, itemId: number, notes?: string) {
    const item = await this.storage.getCycleCountItemById(itemId);
    if (!item) throw new CycleCountError("Item not found", 404);
    if (item.status === "approved" || item.status === "adjusted") {
      throw new CycleCountError("Cannot investigate an already approved item");
    }

    await this.storage.updateCycleCountItem(itemId, {
      status: "investigate",
      varianceNotes: notes ? `${item.varianceNotes || ''}\n[Investigation] ${notes}`.trim() : item.varianceNotes,
    });

    await this.refreshBinStats(item.cycleCountId);
    return { success: true };
  }

  async addFoundItem(
    id: number,
    params: { sku: string; quantity: number; warehouseLocationId: number; notes?: string },
    userId?: string,
  ) {
    const sku = params.sku?.trim() || null;
    if (!sku || params.quantity === undefined || !params.warehouseLocationId) {
      throw new CycleCountError("SKU, quantity, and location are required");
    }

    const cycleCount = await this.storage.getCycleCountById(id);
    if (!cycleCount) throw new CycleCountError("Cycle count not found", 404);
    if (cycleCount.status !== "in_progress") {
      throw new CycleCountError("Can only add items to in-progress cycle counts");
    }

    const { productVariantId, productId } = await this.lookupVariantAndProductBySku(sku);

    const result = await this.db.execute<{ id: number }>(sql`
      INSERT INTO cycle_count_items (
        cycle_count_id, warehouse_location_id, product_variant_id, product_id,
        expected_sku, expected_qty, counted_sku, counted_qty,
        variance_qty, variance_type, variance_notes, status,
        requires_approval, mismatch_type,
        counted_by, counted_at, created_at
      ) VALUES (
        ${id}, ${params.warehouseLocationId}, ${productVariantId}, ${productId},
        NULL, 0, ${sku}, ${params.quantity},
        ${params.quantity}, 'unexpected_item', ${params.notes || `Unexpected item found during count: ${sku} x ${params.quantity}`}, 'variance',
        1, 'unexpected_found',
        ${userId}, NOW(), NOW()
      ) RETURNING id
    `);

    await this.refreshBinStats(id);

    return {
      success: true,
      itemId: result.rows[0]?.id,
      message: `Added unexpected item: ${sku} x ${params.quantity}`,
    };
  }

  async approveVariance(
    id: number,
    itemId: number,
    params: { reasonCode: string; notes?: string; approvedBy?: string },
  ): Promise<ApproveResult> {
    const item = await this.storage.getCycleCountItemById(itemId);
    if (!item) throw new CycleCountError("Item not found", 404);
    if (!item.varianceType) throw new CycleCountError("No variance to approve");

    const adjustmentsMade: ApprovalAdjustment[] = [];
    const { reasonCode, notes, approvedBy } = params;

    // Approve the primary item
    const adj = await this.approveItemCore(item, reasonCode, notes, approvedBy);
    if (adj) adjustmentsMade.push(adj);

    let linkedItemsApproved = 0;

    // Forward link: approve related item
    if (item.relatedItemId) {
      const relatedItem = await this.storage.getCycleCountItemById(item.relatedItemId);
      if (relatedItem && relatedItem.status !== "approved") {
        const relAdj = await this.approveItemCore(relatedItem, reasonCode, notes, approvedBy);
        if (relAdj) adjustmentsMade.push(relAdj);
        linkedItemsApproved++;
      }
    }

    // Reverse link: approve any item pointing TO this one
    const reverseResult = await this.db.execute<{ id: number }>(sql`
      SELECT id FROM cycle_count_items
      WHERE related_item_id = ${itemId}
      AND status != 'approved'
      LIMIT 1
    `);

    if (reverseResult.rows.length > 0) {
      const reverseItem = await this.storage.getCycleCountItemById(reverseResult.rows[0].id);
      if (reverseItem && reverseItem.status !== "approved") {
        const revAdj = await this.approveItemCore(reverseItem, reasonCode, notes, approvedBy);
        if (revAdj) adjustmentsMade.push(revAdj);
        linkedItemsApproved++;
      }
    }

    // Update approved count on cycle count header
    const allItems = await this.storage.getCycleCountItems(item.cycleCountId);
    const approvedCount = allItems.filter(i => i.status === "approved" || i.status === "adjusted").length;
    await this.storage.updateCycleCount(item.cycleCountId, { approvedVariances: approvedCount });

    // Fire channel sync + replen (fire-and-forget)
    await this.firePostApprovalSideEffects(adjustmentsMade);

    return { success: true, adjustmentsMade, linkedItemsApproved };
  }

  async bulkApprove(
    cycleCountId: number,
    params: { itemIds: number[]; reasonCode: string; notes?: string; approvedBy?: string },
  ): Promise<BulkApproveResult> {
    const { itemIds, reasonCode, notes, approvedBy } = params;

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      throw new CycleCountError("itemIds array is required");
    }
    if (!reasonCode) {
      throw new CycleCountError("reasonCode is required");
    }

    let approved = 0;
    let skipped = 0;
    let adjustmentCount = 0;
    const errors: string[] = [];
    const processedIds = new Set<number>();
    const allAdjustments: ApprovalAdjustment[] = [];

    for (const rawId of itemIds) {
      const itemId = parseInt(String(rawId));
      if (isNaN(itemId) || processedIds.has(itemId)) continue;
      processedIds.add(itemId);

      try {
        const item = await this.storage.getCycleCountItemById(itemId);
        if (!item || item.cycleCountId !== cycleCountId) { skipped++; continue; }
        if (item.status === "approved" || item.status === "adjusted") { skipped++; continue; }
        if (!item.varianceType) { skipped++; continue; }

        // Approve primary item
        const adj = await this.approveItemCore(item, reasonCode, notes, approvedBy);
        if (adj) { allAdjustments.push(adj); adjustmentCount++; }
        approved++;

        // Handle linked items (mismatch pairs)
        const linkedIds: number[] = [];
        if (item.relatedItemId) linkedIds.push(item.relatedItemId);
        const reverseResult = await this.db.execute<{ id: number }>(sql`
          SELECT id FROM cycle_count_items
          WHERE related_item_id = ${itemId} AND status != 'approved'
        `);
        for (const row of reverseResult.rows) {
          linkedIds.push(row.id);
        }

        for (const linkedId of linkedIds) {
          if (processedIds.has(linkedId)) continue;
          processedIds.add(linkedId);

          const linked = await this.storage.getCycleCountItemById(linkedId);
          if (!linked || linked.status === "approved") continue;

          const linkAdj = await this.approveItemCore(linked, reasonCode, notes, approvedBy);
          if (linkAdj) { allAdjustments.push(linkAdj); adjustmentCount++; }
          approved++;
        }
      } catch (e: any) {
        errors.push(`Item ${itemId}: ${e.message}`);
      }
    }

    // Update cycle count approved count
    const allItems = await this.storage.getCycleCountItems(cycleCountId);
    const approvedCount = allItems.filter(i => i.status === "approved" || i.status === "adjusted").length;
    await this.storage.updateCycleCount(cycleCountId, { approvedVariances: approvedCount });

    // BUG FIX: Fire channel sync + replen for ALL adjustments (was missing channelSync)
    await this.firePostApprovalSideEffects(allAdjustments);

    return {
      success: true,
      approved,
      skipped,
      adjustmentsMade: adjustmentCount,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async createVariant(cycleCountId: number, itemId: number) {
    const item = await this.storage.getCycleCountItemById(itemId);
    if (!item) throw new CycleCountError("Cycle count item not found", 404);
    if (item.cycleCountId !== cycleCountId) {
      throw new CycleCountError("Item does not belong to this cycle count");
    }

    const sku = item.countedSku?.trim();
    if (!sku) throw new CycleCountError("Item has no counted SKU to create a variant from");

    // Already linked — idempotent return
    if (item.productVariantId) {
      const existingVariant = await this.storage.getProductVariantById(item.productVariantId);
      const product = existingVariant ? await this.storage.getProductById(existingVariant.productId) : null;
      return {
        item,
        product: product ? { id: product.id, sku: product.sku, name: product.name } : null,
        variant: existingVariant ? { id: existingVariant.id, sku: existingVariant.sku, name: existingVariant.name, unitsPerVariant: existingVariant.unitsPerVariant } : null,
        alreadyExisted: true,
        siblingItemsLinked: 0,
      };
    }

    // Race condition check: variant may now exist
    const existingVariant = await this.storage.getProductVariantBySku(sku.toUpperCase());
    if (existingVariant) {
      await this.storage.updateCycleCountItem(itemId, { productVariantId: existingVariant.id });
      const product = await this.storage.getProductById(existingVariant.productId);
      return {
        item: await this.storage.getCycleCountItemById(itemId),
        product: product ? { id: product.id, sku: product.sku, name: product.name } : null,
        variant: { id: existingVariant.id, sku: existingVariant.sku, name: existingVariant.name, unitsPerVariant: existingVariant.unitsPerVariant },
        alreadyExisted: true,
        siblingItemsLinked: 0,
      };
    }

    // Parse SKU pattern (P=Pack, B=Box, C=Case)
    const variantPattern = /^(.+)-(P|B|C)(\d+)$/i;
    const match = sku.match(variantPattern);

    let baseSku: string;
    let unitsPerVariant: number;
    let hierarchyLevel: number;
    let variantName: string;

    if (match) {
      baseSku = match[1].toUpperCase();
      const variantType = match[2].toUpperCase();
      unitsPerVariant = parseInt(match[3], 10);
      hierarchyLevel = variantType === "P" ? 1 : variantType === "B" ? 2 : 3;
      const typeName = variantType === "P" ? "Pack" : variantType === "B" ? "Box" : "Case";
      variantName = `${typeName} of ${unitsPerVariant}`;
    } else {
      baseSku = sku.toUpperCase();
      unitsPerVariant = 1;
      hierarchyLevel = 1;
      variantName = "Each";
    }

    // Find or create parent product
    let product = await this.storage.getProductBySku(baseSku);
    if (!product) {
      product = await this.storage.createProduct({
        sku: baseSku,
        name: baseSku,
        baseUnit: "EA",
      });
      console.log(`[CycleCount] Created product ${product.id} for base SKU ${baseSku}`);
    }

    // Create variant
    const variant = await this.storage.createProductVariant({
      productId: product.id,
      sku: sku.toUpperCase(),
      name: variantName,
      unitsPerVariant,
      hierarchyLevel,
    });
    console.log(`[CycleCount] Created variant ${variant.id} (${variant.sku}) under product ${product.id}`);

    // Link to this cycle count item
    await this.storage.updateCycleCountItem(itemId, { productVariantId: variant.id });

    // Auto-link siblings with same unknown SKU
    const allItems = await this.storage.getCycleCountItems(cycleCountId);
    const siblings = allItems.filter(i =>
      i.id !== itemId &&
      i.countedSku?.toUpperCase() === sku.toUpperCase() &&
      !i.productVariantId
    );
    for (const sibling of siblings) {
      await this.storage.updateCycleCountItem(sibling.id, { productVariantId: variant.id });
    }

    return {
      item: await this.storage.getCycleCountItemById(itemId),
      product: { id: product.id, sku: product.sku, name: product.name },
      variant: { id: variant.id, sku: variant.sku, name: variant.name, unitsPerVariant: variant.unitsPerVariant },
      alreadyExisted: false,
      siblingItemsLinked: siblings.length,
    };
  }

  async complete(id: number) {
    const cycleCount = await this.storage.getCycleCountById(id);
    if (!cycleCount) throw new CycleCountError("Cycle count not found", 404);

    const items = await this.storage.getCycleCountItems(id);
    const pendingItems = items.filter(i => i.status === "pending");
    if (pendingItems.length > 0) {
      throw new CycleCountError(`${pendingItems.length} items still pending`);
    }

    const investigatingItems = items.filter(i => i.status === "investigate");
    if (investigatingItems.length > 0) {
      throw new CycleCountError(`${investigatingItems.length} items still under investigation`);
    }

    const unapprovedVariances = items.filter(i => i.varianceType && i.status !== "approved" && i.status !== "adjusted");
    if (unapprovedVariances.length > 0) {
      throw new CycleCountError(`${unapprovedVariances.length} variances not approved`);
    }

    await this.storage.updateCycleCount(id, {
      status: "completed",
      completedAt: new Date(),
    });

    return { success: true };
  }

  async delete(id: number) {
    const deleted = await this.storage.deleteCycleCount(id);
    if (!deleted) throw new CycleCountError("Cycle count not found", 404);
    return { success: true };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCycleCountService(
  db: DrizzleDb,
  inventoryCore: InventoryCore,
  channelSync: ChannelSync,
  replenishment: Replenishment,
  storage: Storage,
) {
  return new CycleCountService(db, inventoryCore, channelSync, replenishment, storage);
}

export type { CycleCountService };
