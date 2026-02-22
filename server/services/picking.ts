import { eq, and, sql } from "drizzle-orm";
import {
  inventoryLevels,
  warehouseLocations,
  warehouseSettings,
  productVariants,
  productLocations,
  orderItems,
  orders,
  itemStatusEnum,
} from "@shared/schema";
import type {
  InventoryLevel,
  WarehouseLocation,
  WarehouseSettings,
  OrderItem,
  Order,
  ItemStatus,
  OrderStatus,
} from "@shared/schema";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: (query: any) => Promise<any>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

type InventoryCore = {
  getLevel: (productVariantId: number, warehouseLocationId: number) => Promise<InventoryLevel | null>;
  getLevelsByVariant: (productVariantId: number) => Promise<InventoryLevel[]>;
  upsertLevel: (productVariantId: number, warehouseLocationId: number) => Promise<InventoryLevel>;
  adjustLevel: (levelId: number, deltas: Record<string, number | undefined>) => Promise<InventoryLevel>;
  logTransaction: (txn: any) => Promise<void>;
  pickItem: (params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId?: number;
    userId?: string;
  }) => Promise<boolean>;
};

type ReplenishmentService = {
  checkAndTriggerAfterPick: (productVariantId: number, warehouseLocationId: number) => Promise<any>;
  executeTask: (taskId: number, userId?: string) => Promise<{ moved: number }>;
};

/** Minimal storage interface — only the methods picking needs. */
type Storage = {
  getOrderItemById: (id: number) => Promise<OrderItem | undefined>;
  updateOrderItemStatus: (id: number, status: ItemStatus, pickedQty?: number, shortReason?: string, expectedCurrentStatus?: ItemStatus) => Promise<OrderItem | null>;
  getProductVariantBySku: (sku: string) => Promise<any | undefined>;
  getProductVariantById: (id: number) => Promise<any | undefined>;
  getBinLocationFromInventoryBySku: (sku: string) => Promise<{ location: string; zone: string; barcode: string | null; imageUrl: string | null } | undefined>;
  createPickingLog: (log: any) => Promise<any>;
  updateOrderProgress: (orderId: number, postPickStatus?: string) => Promise<Order | null>;
  claimOrder: (orderId: number, pickerId: string) => Promise<Order | null>;
  releaseOrder: (orderId: number, resetProgress?: boolean) => Promise<Order | null>;
  updateOrderStatus: (orderId: number, status: OrderStatus) => Promise<Order | null>;
  getOrderById: (id: number) => Promise<Order | undefined>;
  getOrderItems: (orderId: number) => Promise<OrderItem[]>;
  getUser: (id: string) => Promise<any | undefined>;
  getInventoryLevelsByProductVariantId: (id: number) => Promise<any[]>;
  getAllWarehouseLocations: () => Promise<WarehouseLocation[]>;
  getPendingReplenTasksForLocation: (locationId: number) => Promise<any[]>;
  updateReplenTask: (id: number, updates: any) => Promise<any | null>;
  getPickQueueOrders: () => Promise<any[]>;
  getActiveReplenTierDefaults: () => Promise<any[]>;
  getActiveReplenRules: () => Promise<any[]>;
  getChannelById: (id: number) => Promise<any | undefined>;
  getAllWarehouseSettings: () => Promise<WarehouseSettings[]>;
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type PickInventoryContext = {
  deducted: boolean;
  systemQtyAfter: number;
  locationId: number | null;
  locationCode: string | null;
  sku: string;
  binCountNeeded: boolean;
  replen: {
    triggered: boolean;
    taskId: number | null;
    taskStatus: string | null;
    autoExecuted: boolean;
    stockout: boolean;
    sourceLocationCode: string | null;
    sourceVariantSku: string | null;
    sourceVariantName: string | null;
    qtyToMove: number | null;
  };
};

export type PickItemResult =
  | { success: true; item: OrderItem; inventory: PickInventoryContext }
  | { success: false; error: string; message: string };

export type CaseBreakResult =
  | { success: true; taskId: number; moved: number; action: string }
  | { success: false; error: string; taskId?: number };

export type BinCountResult = {
  success: true;
  systemQtyBefore: number;
  actualBinQty: number;
  adjustment: number;
  replenTriggered: boolean;
  replenTaskStatus: string | null;
};

export type PickQueueOrder = any; // Pass-through type from storage

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class PickingService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly inventoryCore: InventoryCore,
    private readonly replenishment: ReplenishmentService,
    private readonly storage: Storage,
  ) {}

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /** Resolve warehouse pick settings. Returns first warehouse-linked row or first row as fallback. */
  private async getPickSettings(warehouseId?: number): Promise<{
    postPickStatus: string;
    pickMode: string;
    requireScanConfirm: number;
  }> {
    const all = await this.storage.getAllWarehouseSettings();
    const settings = warehouseId
      ? all.find(s => s.warehouseId === warehouseId) || all[0]
      : all.find(s => s.warehouseId != null) || all[0];

    return {
      postPickStatus: (settings as any)?.postPickStatus || "ready_to_ship",
      pickMode: (settings as any)?.pickMode || "single_order",
      requireScanConfirm: (settings as any)?.requireScanConfirm ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // 1. pickItem — THE CORE METHOD
  // -------------------------------------------------------------------------

  async pickItem(itemId: number, params: {
    status: string;
    pickedQuantity?: number;
    shortReason?: string;
    pickMethod?: string;
    warehouseLocationId?: number;
    userId?: string;
    deviceType?: string;
    sessionId?: string;
  }): Promise<PickItemResult> {
    const { status, pickedQuantity, shortReason, pickMethod, warehouseLocationId, userId, deviceType, sessionId } = params;

    // Validate status enum
    if (!itemStatusEnum.includes(status as any)) {
      return { success: false, error: "invalid_status", message: `Status must be one of: ${itemStatusEnum.join(", ")}` };
    }

    // Load item before update
    const beforeItem = await this.storage.getOrderItemById(itemId);
    if (!beforeItem) {
      return { success: false, error: "not_found", message: `Item ${itemId} not found` };
    }

    // Prevent double-pick
    if (status === "completed" && beforeItem.status === "completed") {
      return { success: false, error: "already_picked", message: `Item ${itemId} is already completed` };
    }

    // Validate pickedQuantity bounds
    if (pickedQuantity !== undefined) {
      const qty = Number(pickedQuantity);
      if (!Number.isInteger(qty) || qty < 0 || qty > beforeItem.quantity) {
        return { success: false, error: "invalid_quantity", message: `pickedQuantity must be an integer between 0 and ${beforeItem.quantity}` };
      }
    }

    // Atomic status update with WHERE guard on expectedCurrentStatus
    const item = await this.storage.updateOrderItemStatus(
      itemId, status as ItemStatus, pickedQuantity, shortReason, beforeItem.status as ItemStatus,
    );

    if (!item) {
      return { success: false, error: "status_conflict", message: `Item ${itemId} status was changed by another request` };
    }

    // Log the action (fire-and-forget)
    const order = await this.storage.getOrderById(item.orderId);
    const pickerId = order?.assignedPickerId;
    const picker = pickerId ? await this.storage.getUser(pickerId) : null;

    let actionType = "item_picked";
    if (status === "completed") actionType = "item_picked";
    else if (status === "short") actionType = "item_shorted";
    else if (pickedQuantity !== undefined && beforeItem.pickedQuantity !== pickedQuantity) actionType = "item_quantity_adjusted";

    this.storage.createPickingLog({
      actionType,
      pickerId: pickerId || undefined,
      pickerName: picker?.displayName || picker?.username || pickerId || undefined,
      pickerRole: picker?.role,
      orderId: item.orderId,
      orderNumber: order?.orderNumber,
      orderItemId: item.id,
      sku: item.sku,
      itemName: item.name,
      locationCode: item.location,
      qtyRequested: item.quantity,
      qtyBefore: beforeItem.pickedQuantity || 0,
      qtyAfter: item.pickedQuantity,
      qtyDelta: item.pickedQuantity - (beforeItem.pickedQuantity || 0),
      reason: shortReason,
      itemStatusBefore: beforeItem.status,
      itemStatusAfter: item.status,
      deviceType: deviceType || "desktop",
      sessionId,
      pickMethod: pickMethod || "manual",
    }).catch((err: any) => console.warn("[PickingLog] Failed to log item action:", err.message));

    // Build inventory context for picker UI
    const inventoryCtx: PickInventoryContext = {
      deducted: false,
      systemQtyAfter: 0,
      locationId: null,
      locationCode: null,
      sku: item.sku,
      binCountNeeded: false,
      replen: {
        triggered: false,
        taskId: null,
        taskStatus: null,
        autoExecuted: false,
        stockout: false,
        sourceLocationCode: null,
        sourceVariantSku: null,
        sourceVariantName: null,
        qtyToMove: null,
      },
    };

    // If item was just completed, deduct inventory
    if (status === "completed" && beforeItem.status !== "completed") {
      const deductResult = await this._deductInventory(item, beforeItem, {
        warehouseLocationId,
        userId,
      });

      if (deductResult.success && !deductResult.noVariant) {
        // Deduction succeeded — check replen
        inventoryCtx.deducted = true;
        inventoryCtx.systemQtyAfter = deductResult.systemQtyAfter;
        inventoryCtx.locationId = deductResult.locationId;
        inventoryCtx.locationCode = deductResult.locationCode;

        // Await replen check (need result for picker UI — no longer fire-and-forget)
        const replenTask = await this.replenishment
          .checkAndTriggerAfterPick(deductResult.productVariantId, deductResult.locationId)
          .catch((err: any) => { console.warn("[Replen] trigger failed:", err.message); return null; });

        if (replenTask) {
          inventoryCtx.replen.triggered = true;
          inventoryCtx.replen.taskId = replenTask.id;
          inventoryCtx.replen.taskStatus = replenTask.status;
          inventoryCtx.replen.autoExecuted = replenTask.status === "completed";
          inventoryCtx.replen.stockout = replenTask.status === "blocked";
          inventoryCtx.binCountNeeded = true;

          // Populate replen guidance info for picker
          if (replenTask.fromLocationId) {
            const allLocs = await this.storage.getAllWarehouseLocations();
            const sourceLoc = allLocs.find(l => l.id === replenTask.fromLocationId);
            inventoryCtx.replen.sourceLocationCode = sourceLoc?.code || null;
          }
          if (replenTask.sourceProductVariantId) {
            const sourceVariant = await this.storage.getProductVariantById(replenTask.sourceProductVariantId);
            if (sourceVariant) {
              inventoryCtx.replen.sourceVariantSku = sourceVariant.sku;
              inventoryCtx.replen.sourceVariantName = sourceVariant.name || sourceVariant.sku;
            }
          }
          inventoryCtx.replen.qtyToMove = replenTask.qtyTargetUnits || replenTask.qtySourceUnits || null;

          // If replen auto-executed, re-read inventory to show actual post-replen quantity
          if (replenTask.status === "completed") {
            const updatedLevel = await this.inventoryCore.getLevel(deductResult.productVariantId, deductResult.locationId);
            inventoryCtx.systemQtyAfter = updatedLevel?.variantQty ?? 0;
          }
        }

      } else if (!deductResult.success) {
        // Deduction FAILED — system inventory is wrong.
        // DO NOT revert the pick. Item stays completed.
        inventoryCtx.deducted = false;
        inventoryCtx.systemQtyAfter = deductResult.systemQty;
        inventoryCtx.locationId = deductResult.locationId;
        inventoryCtx.locationCode = deductResult.locationCode;
        inventoryCtx.binCountNeeded = true;

        // Check if reserve has stock (for stockout indicator)
        const hasReserve = await this._hasReserveStock(deductResult.productVariantId);
        inventoryCtx.replen.stockout = !hasReserve;

        // Log discrepancy to picking_logs (fire-and-forget)
        this.storage.createPickingLog({
          actionType: "inventory_discrepancy",
          pickerId: pickerId || undefined,
          pickerName: picker?.displayName || picker?.username || pickerId || undefined,
          orderId: item.orderId,
          orderNumber: order?.orderNumber,
          orderItemId: item.id,
          sku: item.sku,
          itemName: item.name,
          locationCode: inventoryCtx.locationCode || item.location,
          qtyRequested: item.pickedQuantity || item.quantity,
          qtyBefore: deductResult.systemQty,
          qtyAfter: deductResult.systemQty,
          reason: deductResult.message,
          deviceType: deviceType || "desktop",
          sessionId,
        }).catch((err: any) => console.warn("[PickingLog] discrepancy log failed:", err.message));
      }
      // else: noVariant = true (non-inventory item) — no deduction needed, inventoryCtx stays default
    }

    // ALWAYS update order progress (regardless of deduction result)
    const settings = await this.getPickSettings();
    await this.storage.updateOrderProgress(item.orderId, settings.postPickStatus);

    return { success: true, item, inventory: inventoryCtx };
  }

  /** Internal: resolve pick location and deduct inventory via inventoryCore. */
  private async _deductInventory(
    item: OrderItem,
    beforeItem: OrderItem,
    opts: { warehouseLocationId?: number; userId?: string },
  ): Promise<
    | { success: true; noVariant?: undefined; productVariantId: number; locationId: number; locationCode: string; systemQtyAfter: number }
    | { success: false; error: string; message: string; productVariantId: number; locationId: number | null; locationCode: string | null; systemQty: number }
    | { success: true; noVariant: true; productVariantId: 0; locationId: 0; locationCode: null; systemQtyAfter: 0 }
  > {
    const pickedQty = item.pickedQuantity || item.quantity;
    const productVariant = await this.storage.getProductVariantBySku(item.sku);
    if (!productVariant) {
      // No variant mapping — can't deduct, but this is non-fatal for non-inventory items
      return { success: true, noVariant: true, productVariantId: 0, locationId: 0, locationCode: null, systemQtyAfter: 0 };
    }

    console.log(`[Inventory] Picking ${pickedQty} x ${productVariant.sku} (${productVariant.unitsPerVariant} units each)`);

    const levels = await this.storage.getInventoryLevelsByProductVariantId(productVariant.id);
    const allLocations = await this.storage.getAllWarehouseLocations();

    // Resolve assigned bin info for context (even if deduction fails)
    let assignedLocationId: number | null = null;
    let assignedLocationCode: string | null = null;
    if (item.location && item.location !== "UNASSIGNED") {
      const assignedLoc = allLocations.find(loc => loc.code === item.location);
      if (assignedLoc) {
        assignedLocationId = assignedLoc.id;
        assignedLocationCode = assignedLoc.code;
      }
    }

    // Resolve pick location: explicit ID > assigned bin > auto-select
    let pickLocationId: number | null = opts.warehouseLocationId ? Number(opts.warehouseLocationId) : null;

    // Try the location already assigned to this order item
    if (!pickLocationId && assignedLocationId) {
      const hasStock = levels.some((l: any) =>
        l.warehouseLocationId === assignedLocationId && l.variantQty >= pickedQty
      );
      if (hasStock) {
        pickLocationId = assignedLocationId;
      }
    }

    // Fallback: auto-select by location type priority
    if (!pickLocationId) {
      const priorityOrder: Record<string, number> = { pick: 0, pallet: 1, reserve: 2, receiving: 3 };
      const sortedLevels = levels
        .filter((l: any) => l.variantQty >= pickedQty)
        .sort((a: any, b: any) => {
          const locA = allLocations.find(loc => loc.id === a.warehouseLocationId);
          const locB = allLocations.find(loc => loc.id === b.warehouseLocationId);
          const priorityA = priorityOrder[locA?.locationType as string] ?? 99;
          const priorityB = priorityOrder[locB?.locationType as string] ?? 99;
          return priorityA - priorityB;
        });
      pickLocationId = sortedLevels[0]?.warehouseLocationId || null;
    }

    if (!pickLocationId) {
      // Resolve system qty at assigned bin for context
      const assignedLevel = assignedLocationId
        ? levels.find((l: any) => l.warehouseLocationId === assignedLocationId)
        : null;
      return {
        success: false,
        error: "no_inventory",
        message: `No location has sufficient stock for ${pickedQty} of ${item.sku}`,
        productVariantId: productVariant.id,
        locationId: assignedLocationId,
        locationCode: assignedLocationCode,
        systemQty: assignedLevel?.variantQty ?? 0,
      };
    }

    const picked = await this.inventoryCore.pickItem({
      productVariantId: productVariant.id,
      warehouseLocationId: pickLocationId,
      qty: pickedQty,
      orderId: item.orderId,
      orderItemId: item.id,
      userId: opts.userId,
    });

    if (!picked) {
      const level = levels.find((l: any) => l.warehouseLocationId === pickLocationId);
      const loc = allLocations.find(l => l.id === pickLocationId);
      return {
        success: false,
        error: "insufficient_inventory",
        message: `Not enough stock to pick ${pickedQty} of ${item.sku}`,
        productVariantId: productVariant.id,
        locationId: pickLocationId,
        locationCode: loc?.code || assignedLocationCode,
        systemQty: level?.variantQty ?? 0,
      };
    }

    // Read back updated level for accurate systemQtyAfter
    const updatedLevel = await this.inventoryCore.getLevel(productVariant.id, pickLocationId);
    const loc = allLocations.find(l => l.id === pickLocationId);

    console.log(`[Inventory] Picked: ${pickedQty} variant units of ${productVariant.id} from location ${pickLocationId}`);

    return {
      success: true,
      productVariantId: productVariant.id,
      locationId: pickLocationId,
      locationCode: loc?.code || assignedLocationCode || "",
      systemQtyAfter: updatedLevel?.variantQty ?? 0,
    };
  }

  /** Check if any non-pick location has stock for this variant */
  private async _hasReserveStock(productVariantId: number): Promise<boolean> {
    const levels = await this.inventoryCore.getLevelsByVariant(productVariantId);
    const locations = await this.storage.getAllWarehouseLocations();
    return levels.some(l => {
      const loc = locations.find(wl => wl.id === l.warehouseLocationId);
      return loc && loc.locationType !== "pick" && l.variantQty > 0;
    });
  }

  // -------------------------------------------------------------------------
  // 2. claimOrder
  // -------------------------------------------------------------------------

  async claimOrder(orderId: number, pickerId: string, deviceType?: string, sessionId?: string): Promise<{ order: Order; items: OrderItem[] } | null> {
    if (!pickerId) return null;

    const orderBefore = await this.storage.getOrderById(orderId);

    const order = await this.storage.claimOrder(orderId, pickerId);
    if (!order) return null;

    // Audit log (fire-and-forget)
    const picker = await this.storage.getUser(pickerId);
    this.storage.createPickingLog({
      actionType: "order_claimed",
      pickerId,
      pickerName: picker?.displayName || picker?.username || pickerId,
      pickerRole: picker?.role,
      orderId,
      orderNumber: order.orderNumber,
      orderStatusBefore: orderBefore?.warehouseStatus,
      orderStatusAfter: order.warehouseStatus,
      deviceType: deviceType || "desktop",
      sessionId,
    }).catch((err: any) => console.warn("[PickingLog] Failed to log order_claimed:", err.message));

    const items = await this.storage.getOrderItems(orderId);
    return { order, items };
  }

  // -------------------------------------------------------------------------
  // 3. releaseOrder
  // -------------------------------------------------------------------------

  async releaseOrder(orderId: number, options?: {
    resetProgress?: boolean;
    reason?: string;
    deviceType?: string;
    sessionId?: string;
  }): Promise<Order | null> {
    const resetProgress = options?.resetProgress ?? true;

    const orderBefore = await this.storage.getOrderById(orderId);
    const order = await this.storage.releaseOrder(orderId, resetProgress);
    if (!order) return null;

    // Audit log
    const pickerId = orderBefore?.assignedPickerId;
    const picker = pickerId ? await this.storage.getUser(pickerId) : null;
    this.storage.createPickingLog({
      actionType: "order_released",
      pickerId: pickerId || undefined,
      pickerName: picker?.displayName || picker?.username || pickerId || undefined,
      pickerRole: picker?.role,
      orderId,
      orderNumber: order.orderNumber,
      orderStatusBefore: orderBefore?.warehouseStatus,
      orderStatusAfter: order.warehouseStatus,
      reason: options?.reason || (resetProgress ? "Progress reset" : "Progress preserved"),
      deviceType: options?.deviceType || "desktop",
      sessionId: options?.sessionId,
    }).catch((err: any) => console.warn("[PickingLog] Failed to log order_released:", err.message));

    return order;
  }

  // -------------------------------------------------------------------------
  // 4. markReadyToShip
  // -------------------------------------------------------------------------

  async markReadyToShip(orderId: number, userId?: string, deviceType?: string, sessionId?: string): Promise<Order | null> {
    const orderBefore = await this.storage.getOrderById(orderId);
    const order = await this.storage.updateOrderStatus(orderId, "ready_to_ship");
    if (!order) return null;

    const pickerId = order.assignedPickerId;
    const picker = pickerId ? await this.storage.getUser(pickerId) : null;
    this.storage.createPickingLog({
      actionType: "order_completed",
      pickerId: pickerId || undefined,
      pickerName: picker?.displayName || picker?.username || pickerId || undefined,
      pickerRole: picker?.role,
      orderId,
      orderNumber: order.orderNumber,
      orderStatusBefore: orderBefore?.warehouseStatus,
      orderStatusAfter: order.warehouseStatus,
      deviceType: deviceType || "desktop",
      sessionId,
    }).catch((err: any) => console.warn("[PickingLog] Failed to log order_completed:", err.message));

    return order;
  }

  // -------------------------------------------------------------------------
  // 5. initiateCaseBreak
  // -------------------------------------------------------------------------

  async initiateCaseBreak(sku: string, warehouseLocationId: number, userId?: string): Promise<CaseBreakResult> {
    const variant = await this.storage.getProductVariantBySku(sku);
    if (!variant) {
      return { success: false, error: `No variant found for SKU ${sku}` };
    }

    // Check for existing pending/blocked task
    const existingTasks = await this.storage.getPendingReplenTasksForLocation(warehouseLocationId);
    const existing = existingTasks.find((t: any) => t.pickProductVariantId === variant.id);

    if (existing) {
      try {
        if (existing.status === "blocked") {
          await this.storage.updateReplenTask(existing.id, { status: "pending" });
        }
        const result = await this.replenishment.executeTask(existing.id, userId || "picker");
        return { success: true, taskId: existing.id, moved: result.moved, action: "executed_existing" };
      } catch (err: any) {
        return { success: false, error: err.message, taskId: existing.id };
      }
    }

    // No existing task — trigger replen check
    const task = await this.replenishment.checkAndTriggerAfterPick(variant.id, warehouseLocationId);
    if (!task) {
      return { success: false, error: "Could not create replen task — no source stock or no threshold configured" };
    }

    // If auto-executed, already done
    if (task.status === "completed") {
      return { success: true, taskId: task.id, moved: task.qtyCompleted, action: "auto_completed" };
    }

    // Otherwise execute it now (picker requested)
    try {
      const result = await this.replenishment.executeTask(task.id, userId || "picker");
      return { success: true, taskId: task.id, moved: result.moved, action: "executed" };
    } catch (err: any) {
      return { success: false, error: err.message, taskId: task.id };
    }
  }

  // -------------------------------------------------------------------------
  // 6. confirmCaseBreak
  // -------------------------------------------------------------------------

  async confirmCaseBreak(sku: string, warehouseLocationId: number, actualBinQty: number, userId?: string): Promise<BinCountResult> {
    const variant = await this.storage.getProductVariantBySku(sku);
    if (!variant) {
      throw new Error(`No variant found for SKU ${sku}`);
    }

    const level = await this.inventoryCore.getLevel(variant.id, warehouseLocationId);
    const systemQty = level?.variantQty ?? 0;
    const adjustment = actualBinQty - systemQty;

    if (adjustment !== 0) {
      if (!level) {
        const newLevel = await this.inventoryCore.upsertLevel(variant.id, warehouseLocationId);
        if (actualBinQty > 0) {
          await this.inventoryCore.adjustLevel(newLevel.id, { variantQty: actualBinQty });
        }
      } else {
        await this.inventoryCore.adjustLevel(level.id, { variantQty: adjustment });
      }

      await this.inventoryCore.logTransaction({
        productVariantId: variant.id,
        toLocationId: warehouseLocationId,
        transactionType: "cycle_count",
        variantQtyDelta: adjustment,
        variantQtyBefore: systemQty,
        variantQtyAfter: actualBinQty,
        sourceState: "on_hand",
        targetState: "on_hand",
        referenceType: "picker_case_break",
        referenceId: `${sku}:${warehouseLocationId}`,
        notes: `Picker bin count after case break: system=${systemQty}, actual=${actualBinQty}, adj=${adjustment}`,
        userId: userId || null,
      });
    } else {
      // Log verification even when count matches system (audit trail)
      await this.inventoryCore.logTransaction({
        productVariantId: variant.id,
        toLocationId: warehouseLocationId,
        transactionType: "cycle_count",
        variantQtyDelta: 0,
        variantQtyBefore: systemQty,
        variantQtyAfter: actualBinQty,
        sourceState: "on_hand",
        targetState: "on_hand",
        referenceType: "picker_verification",
        referenceId: `${sku}:${warehouseLocationId}`,
        notes: `Picker verified bin count matches system: qty=${systemQty}`,
        userId: userId || null,
      });
    }

    // Evaluate replen on corrected qty
    const replenTask = await this.replenishment
      .checkAndTriggerAfterPick(variant.id, warehouseLocationId)
      .catch((err: any) => { console.warn("[Replen] post-count trigger failed:", err.message); return null; });

    return {
      success: true,
      systemQtyBefore: systemQty,
      actualBinQty,
      adjustment,
      replenTriggered: !!replenTask,
      replenTaskStatus: replenTask?.status || null,
    };
  }

  // -------------------------------------------------------------------------
  // 7. skipReplen
  // -------------------------------------------------------------------------

  async skipReplen(sku: string, warehouseLocationId: number, actualBinQty: number, userId?: string): Promise<BinCountResult> {
    const variant = await this.storage.getProductVariantBySku(sku);
    if (!variant) {
      throw new Error(`No variant found for SKU ${sku}`);
    }

    const level = await this.inventoryCore.getLevel(variant.id, warehouseLocationId);
    const systemQty = level?.variantQty ?? 0;
    const adjustment = actualBinQty - systemQty;

    // Correct inventory if needed
    if (adjustment !== 0 && level) {
      await this.inventoryCore.adjustLevel(level.id, { variantQty: adjustment });
      await this.inventoryCore.logTransaction({
        productVariantId: variant.id,
        toLocationId: warehouseLocationId,
        transactionType: "cycle_count",
        variantQtyDelta: adjustment,
        variantQtyBefore: systemQty,
        variantQtyAfter: actualBinQty,
        sourceState: "on_hand",
        targetState: "on_hand",
        referenceType: "picker_replen_skip",
        referenceId: `${sku}:${warehouseLocationId}`,
        notes: `Picker skipped replen — bin count correction: system=${systemQty}, actual=${actualBinQty}`,
        userId: userId || null,
      });
    }

    // Cancel pending/blocked replen tasks for this SKU+location
    const existingTasks = await this.storage.getPendingReplenTasksForLocation(warehouseLocationId);
    for (const task of existingTasks) {
      if (task.pickProductVariantId === variant.id && (task.status === "pending" || task.status === "blocked")) {
        await this.storage.updateReplenTask(task.id, {
          status: "cancelled",
          notes: `${task.notes || ""}\nCancelled: picker confirmed no replen needed (actual qty=${actualBinQty})`,
        });
      }
    }

    return { success: true, systemQtyBefore: systemQty, actualBinQty, adjustment, replenTriggered: false, replenTaskStatus: null };
  }

  // -------------------------------------------------------------------------
  // 8. getPickQueue
  // -------------------------------------------------------------------------

  async getPickQueue(warehouseId?: number): Promise<PickQueueOrder[]> {
    const allOrders = await this.storage.getPickQueueOrders();

    // Filter to orders with shippable items
    const filteredOrders = allOrders.filter((order: any) => {
      return order.items.some((item: any) => item.requiresShipping === 1);
    });

    // Batch resolve picker names
    const pickerIds = Array.from(new Set(filteredOrders.map((o: any) => o.assignedPickerId).filter(Boolean))) as string[];
    const pickerMap = new Map<string, string>();
    for (const pickerId of pickerIds) {
      const picker = await this.storage.getUser(pickerId);
      if (picker) pickerMap.set(pickerId, picker.displayName || picker.username);
    }

    // Batch resolve channel info
    const channelIds = Array.from(new Set(filteredOrders.map((o: any) => o.channelId).filter(Boolean))) as number[];
    const channelMap = new Map<number, { name: string; provider: string }>();
    for (const channelId of channelIds) {
      const channel = await this.storage.getChannelById(channelId);
      if (channel) channelMap.set(channelId, { name: channel.name, provider: channel.provider });
    }

    // Collect unique pending SKUs for fresh location lookup
    const skusNeedingLookup = new Set<string>();
    for (const order of filteredOrders) {
      for (const item of (order as any).items) {
        if (item.sku && item.requiresShipping === 1 && item.status === "pending") {
          skusNeedingLookup.add(item.sku);
        }
      }
    }

    // Batch lookup current bin locations
    const freshLocationMap = new Map<string, { location: string; zone: string; barcode: string | null; imageUrl: string | null }>();
    for (const sku of Array.from(skusNeedingLookup)) {
      const freshLocation = await this.storage.getBinLocationFromInventoryBySku(sku);
      if (freshLocation) freshLocationMap.set(sku, freshLocation);
    }

    // Replen predictions
    const replenPredictionMap = await this._buildReplenPredictions(skusNeedingLookup);

    // Assemble response with metadata
    return filteredOrders.map((order: any) => {
      let c2pMs: number | null = null;
      if (order.completedAt && order.shopifyCreatedAt) {
        c2pMs = new Date(order.completedAt).getTime() - new Date(order.shopifyCreatedAt).getTime();
      }

      const channelInfo = order.channelId ? channelMap.get(order.channelId) : null;
      const shippableItems = order.items.filter((item: any) => item.requiresShipping === 1);

      const itemsWithFreshLocations = shippableItems.map((item: any) => {
        let updatedItem = { ...item };

        // For pending items, always use freshest location
        if (item.status === "pending" && item.sku) {
          const freshLocation = freshLocationMap.get(item.sku);
          if (freshLocation) {
            updatedItem = {
              ...updatedItem,
              location: freshLocation.location,
              zone: freshLocation.zone,
              barcode: freshLocation.barcode || item.barcode,
              imageUrl: freshLocation.imageUrl || item.imageUrl,
            };
          }
        }

        // Fallback imageUrl
        if (!updatedItem.imageUrl && item.sku) {
          const freshLocation = freshLocationMap.get(item.sku);
          if (freshLocation?.imageUrl) updatedItem.imageUrl = freshLocation.imageUrl;
        }

        // Replen prediction
        if (item.status === "pending" && item.sku) {
          const prediction = replenPredictionMap.get(item.sku);
          if (prediction) {
            const postPickQty = prediction.systemQty - item.quantity;
            const replenNeeded = postPickQty <= prediction.triggerValue;
            updatedItem.replenPrediction = {
              systemQty: prediction.systemQty,
              postPickQty: Math.max(0, postPickQty),
              triggerValue: prediction.triggerValue,
              replenNeeded,
              replenMethod: prediction.replenMethod,
              autoReplen: prediction.autoReplen,
              sourceLocationCode: replenNeeded ? prediction.sourceLocationCode : null,
              sourceQty: replenNeeded ? prediction.sourceQty : 0,
              sourceVariantName: replenNeeded ? prediction.sourceVariantName : null,
            };
          }
        }

        return updatedItem;
      });

      return {
        ...order,
        items: itemsWithFreshLocations,
        pickerName: order.assignedPickerId ? pickerMap.get(order.assignedPickerId) || null : null,
        c2pMs,
        channelName: channelInfo?.name || null,
        channelProvider: channelInfo?.provider || order.source || null,
      };
    });
  }

  /** Build replen predictions for pending SKUs. Non-fatal — returns empty map on failure. */
  private async _buildReplenPredictions(skus: Set<string>): Promise<Map<string, any>> {
    const map = new Map<string, any>();
    try {
      const tierDefaults = await this.storage.getActiveReplenTierDefaults();
      const allRules = await this.storage.getActiveReplenRules();
      const ruleByPickVariant = new Map<number, any>();
      for (const r of allRules) {
        if (r.pickProductVariantId) ruleByPickVariant.set(r.pickProductVariantId, r);
      }

      const allLocs = await this.storage.getAllWarehouseLocations();

      for (const sku of Array.from(skus)) {
        const variant = await this.storage.getProductVariantBySku(sku);
        if (!variant) continue;

        const levels = await this.storage.getInventoryLevelsByProductVariantId(variant.id);
        const pickLevel = levels.find((l: any) => {
          const loc = allLocs.find(wl => wl.id === l.warehouseLocationId);
          return loc && loc.locationType === "pick" && loc.isPickable === 1;
        });

        const systemQty = pickLevel?.variantQty ?? 0;

        const rule = ruleByPickVariant.get(variant.id);
        const tierDefault = tierDefaults.find((td: any) =>
          td.hierarchyLevel === variant.hierarchyLevel && td.isActive === 1
        );

        const triggerValue = rule?.triggerValue ?? tierDefault?.triggerValue ?? null;
        if (triggerValue == null) continue;

        const replenMethod = rule?.replenMethod ?? tierDefault?.replenMethod ?? "full_case";
        const autoReplen = rule?.autoReplen ?? tierDefault?.autoReplen ?? 0;
        const sourceLocationType = rule?.sourceLocationType ?? tierDefault?.sourceLocationType ?? "reserve";

        // Find source location
        let sourceLocationCode: string | null = null;
        let sourceQty = 0;
        let sourceVariantName: string | null = null;

        const sourceHierarchyLevel = tierDefault?.sourceHierarchyLevel ?? variant.hierarchyLevel;
        let sourceVariantId = rule?.sourceProductVariantId;
        if (!sourceVariantId && sourceHierarchyLevel !== variant.hierarchyLevel) {
          const siblings = await this.db.select().from(productVariants)
            .where(and(
              eq(productVariants.productId, variant.productId),
              eq(productVariants.hierarchyLevel, sourceHierarchyLevel),
            ));
          if (siblings.length > 0) sourceVariantId = siblings[0].id;
        }

        const lookupVariantId = sourceVariantId ?? variant.id;
        const sourceLevels = await this.storage.getInventoryLevelsByProductVariantId(lookupVariantId);
        for (const sl of sourceLevels) {
          if (sl.variantQty <= 0) continue;
          const loc = allLocs.find(wl => wl.id === sl.warehouseLocationId);
          if (!loc || loc.locationType !== sourceLocationType) continue;
          sourceLocationCode = loc.code;
          sourceQty = sl.variantQty;
          break;
        }

        if (sourceVariantId && sourceVariantId !== variant.id) {
          const sv = await this.storage.getProductVariantById(sourceVariantId);
          sourceVariantName = sv ? `${sv.name || sv.sku} (${sv.unitsPerVariant} units)` : null;
        }

        map.set(sku, {
          systemQty,
          triggerValue,
          replenMethod,
          autoReplen,
          sourceLocationCode,
          sourceQty,
          sourceVariantName,
        });
      }
    } catch (err: any) {
      console.warn("[PickQueue] Replen prediction failed (non-fatal):", err?.message);
    }
    return map;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPickingService(
  db: DrizzleDb,
  inventoryCore: InventoryCore,
  replenishment: ReplenishmentService,
  storage: Storage,
) {
  return new PickingService(db, inventoryCore, replenishment, storage);
}

export type { PickingService };
