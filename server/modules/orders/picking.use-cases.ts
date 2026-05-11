import { eq, and, sql } from "drizzle-orm";
import { IntegrityError, ValidationError } from "../../../shared/errors";
import { AuditLogger } from "../../infrastructure/auditLogger";
import {
  inventoryLevels,
  warehouseLocations,
  warehouseSettings,
  productVariants,
  productLocations,
  orderItems,
  orders,
  allocationExceptions,
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
  adjustInventory: (params: {
    productVariantId: number;
    warehouseLocationId: number;
    qtyDelta: number;
    reason: string;
    userId?: string;
  }) => Promise<void>;
  logTransaction: (txn: any) => Promise<void>;
  pickItem: (params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId?: number;
    userId?: string;
  }) => Promise<boolean>;
  withTx?: (tx: any) => InventoryCore;
};

type ReplenishmentService = {
  checkAndTriggerAfterPick: (productVariantId: number, warehouseLocationId: number) => Promise<any>;
  checkReplenNeeded: (productVariantId: number, warehouseLocationId: number) => Promise<{ needed: boolean; stockout: boolean; sourceLocationCode: string | null; sourceVariantSku: string | null; sourceVariantName: string | null; qtyTargetUnits: number; [key: string]: any }>;
  executeTask: (taskId: number, userId?: string) => Promise<{ moved: number }>;
  createAndExecuteReplen: (pickVariantId: number, toLocationId: number, userId?: string) => Promise<{ task: any; moved: number } | null>;
};

/** Minimal storage interface — only the methods picking needs. */
type Storage = {
  getOrderItemById: (id: number) => Promise<OrderItem | undefined>;
  updateOrderItemStatus: (id: number, status: ItemStatus, pickedQty?: number, shortReason?: string, expectedCurrentStatus?: ItemStatus) => Promise<OrderItem | null>;
  getProductVariantBySku: (sku: string) => Promise<any | undefined>;
  getProductVariantById: (id: number) => Promise<any | undefined>;
  getProductVariantsByProductId: (productId: number) => Promise<any[]>;
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
    autoExecutedMoved: number | null;
    autoExecutedFailed: boolean;
    autoExecuteFailReason: string | null;
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
  replenFailReason: string | null;
  inferredReplen: boolean; // true if system inferred an unrecorded case break from surplus
  inferredReplenMoved: number | null; // units attributed to inferred replen
};

export type ResolveAllocationResult =
  | {
      success: true;
      item: OrderItem;
      exception: any;
      selectedLocation: { id: number; code: string; zone: string | null };
      autoFixedSetup: boolean;
      reviewNeeded: boolean;
    }
  | {
      success: false;
      error: string;
      message: string;
      exception?: any;
    };

export type PickQueueOrder = any; // Pass-through type from storage

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface ChannelSyncLike {
  queueSyncAfterInventoryChange(variantId: number): Promise<void>;
}

export class PickingUseCases {
  constructor(
    private readonly db: DrizzleDb,
    private readonly inventoryCore: InventoryCore,
    private readonly replenishment: ReplenishmentService,
    private readonly storage: Storage,
    private readonly channelSync?: ChannelSyncLike,
  ) {}

  /**
   * Resolve an allocation/setup miss by accepting the bin the picker scanned or
   * typed. This deliberately does not pick inventory. It only turns a physical
   * bin confirmation into a picker-facing assignment and a durable exception
   * trail, with a narrowly scoped auto-fix when product-location setup is
   * clearly missing.
   */
  async resolveAllocationWithBin(orderItemId: number, params: {
    locationCode?: string;
    warehouseLocationId?: number;
    userId?: string;
    deviceType?: string;
    sessionId?: string;
  }): Promise<ResolveAllocationResult> {
    const [row] = await this.db
      .select({
        item: orderItems,
        order: orders,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(eq(orderItems.id, orderItemId))
      .limit(1);

    if (!row) {
      throw new ValidationError(`Order item ${orderItemId} was not found`);
    }

    const item = row.item as OrderItem;
    const order = row.order as Order;
    if (item.requiresShipping !== 1) {
      throw new ValidationError(`Order item ${orderItemId} does not require picking`);
    }

    const typedCode = (params.locationCode || "").trim().toUpperCase();
    if (!typedCode && !params.warehouseLocationId) {
      throw new ValidationError("locationCode or warehouseLocationId is required");
    }

    const variant = await this.storage.getProductVariantBySku(item.sku);
    const requestedQty = Math.max(0, (item.quantity || 0) - (item.pickedQuantity || 0)) || item.quantity || 0;

    const createBlockedException = async (exceptionType: string, message: string, metadata: Record<string, any> = {}) => {
      const [exception] = await this.db.insert(allocationExceptions).values({
        orderId: item.orderId,
        orderItemId: item.id,
        orderNumber: order.orderNumber,
        sku: item.sku,
        productVariantId: variant?.id ?? null,
        exceptionType,
        status: "blocked",
        requestedQty,
        selectedLocationId: metadata.selectedLocationId ?? null,
        selectedLocationCode: metadata.selectedLocationCode ?? null,
        reviewReason: message,
        metadata: {
          ...metadata,
          locationCode: typedCode || null,
          warehouseLocationId: params.warehouseLocationId ?? null,
        },
      }).returning();

      try {
        const { notify } = await import("../notifications/notifications.service");
        await notify("allocation_blocked", {
          title: `Allocation blocked: ${item.sku}`,
          message,
          data: {
            orderId: item.orderId,
            orderNumber: order.orderNumber,
            orderItemId: item.id,
            sku: item.sku,
            exceptionId: exception.id,
          },
        });
      } catch (notifyErr: any) {
        console.warn(`[Allocation] blocked notification failed: ${notifyErr.message}`);
      }

      return exception;
    };

    if (!variant) {
      const message = `No catalog variant found for SKU ${item.sku}`;
      const exception = await createBlockedException("missing_variant", message);
      return { success: false, error: "missing_variant", message, exception };
    }

    const locationWhere = params.warehouseLocationId
      ? eq(warehouseLocations.id, Number(params.warehouseLocationId))
      : order.warehouseId
        ? and(
            sql`upper(${warehouseLocations.code}) = ${typedCode}`,
            eq(warehouseLocations.warehouseId, order.warehouseId),
          )
        : sql`upper(${warehouseLocations.code}) = ${typedCode}`;

    const [location] = await this.db
      .select()
      .from(warehouseLocations)
      .where(locationWhere)
      .limit(1);

    if (!location) {
      const message = params.warehouseLocationId
        ? `Warehouse location ${params.warehouseLocationId} was not found`
        : `Warehouse location ${typedCode} was not found`;
      const exception = await createBlockedException("unknown_location", message);
      return { success: false, error: "unknown_location", message, exception };
    }

    if (order.warehouseId && location.warehouseId && Number(location.warehouseId) !== Number(order.warehouseId)) {
      const message = `Bin ${location.code} belongs to warehouse ${location.warehouseId}, not order warehouse ${order.warehouseId}`;
      const exception = await createBlockedException("wrong_warehouse", message, {
        selectedLocationId: location.id,
        selectedLocationCode: location.code,
      });
      return { success: false, error: "wrong_warehouse", message, exception };
    }

    if (location.isActive !== 1 || location.isPickable !== 1 || location.cycleCountFreezeId) {
      const message = `Bin ${location.code} is not an active pickable bin`;
      const exception = await createBlockedException("not_pickable", message, {
        selectedLocationId: location.id,
        selectedLocationCode: location.code,
        isActive: location.isActive,
        isPickable: location.isPickable,
        cycleCountFreezeId: location.cycleCountFreezeId,
      });
      return { success: false, error: "not_pickable", message, exception };
    }

    const level = await this.inventoryCore.getLevel(variant.id, location.id);
    const availableQty = level?.variantQty ?? 0;
    if (requestedQty > 0 && availableQty < requestedQty) {
      const message = `Bin ${location.code} has ${availableQty} available for ${item.sku}, but ${requestedQty} is needed`;
      const exception = await createBlockedException("insufficient_bin_qty", message, {
        selectedLocationId: location.id,
        selectedLocationCode: location.code,
        availableQty,
        requestedQty,
      });
      return { success: false, error: "insufficient_bin_qty", message, exception };
    }

    const activePrimaryRows = await this.db
      .select()
      .from(productLocations)
      .where(and(
        sql`(${productLocations.productVariantId} = ${variant.id} OR upper(${productLocations.sku}) = ${item.sku.toUpperCase()})`,
        eq(productLocations.status, "active"),
        eq(productLocations.isPrimary, 1),
      ));

    const primaryAtSelectedBin = activePrimaryRows.some((pl: any) =>
      Number(pl.warehouseLocationId) === Number(location.id) || pl.location?.toUpperCase() === location.code.toUpperCase()
    );
    const hasNoPrimary = activePrimaryRows.length === 0;
    const hasCompetingPrimary = activePrimaryRows.length > 0 && !primaryAtSelectedBin;
    const hasMultiplePrimaries = activePrimaryRows.length > 1;
    const autoFixedSetup = hasNoPrimary;
    const reviewNeeded = hasCompetingPrimary || hasMultiplePrimaries;
    const reviewReason = reviewNeeded
      ? `Picker selected ${location.code}, but active primary setup is ${activePrimaryRows.map((pl: any) => pl.location).join(", ")}`
      : autoFixedSetup
        ? `No active primary pick bin existed for ${item.sku}; setup auto-created from picker bin confirmation`
        : null;

    const zone = location.zone || location.code.split("-")[0] || "U";

    const result = await this.db.transaction(async (tx) => {
      if (autoFixedSetup) {
        const [existingAtBin] = await tx
          .select()
          .from(productLocations)
          .where(and(
            sql`(${productLocations.productVariantId} = ${variant.id} OR upper(${productLocations.sku}) = ${item.sku.toUpperCase()})`,
            eq(productLocations.warehouseLocationId, location.id),
          ))
          .limit(1);

        if (existingAtBin) {
          await tx
            .update(productLocations)
            .set({
              productVariantId: variant.id,
              productId: variant.productId,
              sku: item.sku,
              name: variant.name || item.name,
              location: location.code,
              zone,
              isPrimary: 1,
              status: "active",
              updatedAt: new Date(),
            })
            .where(eq(productLocations.id, existingAtBin.id));
        } else {
          await tx.insert(productLocations).values({
            productId: variant.productId,
            productVariantId: variant.id,
            sku: item.sku,
            name: variant.name || item.name,
            location: location.code,
            zone,
            warehouseLocationId: location.id,
            isPrimary: 1,
            status: "active",
            imageUrl: item.imageUrl || null,
            barcode: item.barcode || variant.barcode || null,
          });
        }
      }

      const [updatedItem] = await tx
        .update(orderItems)
        .set({
          location: location.code,
          zone,
        })
        .where(eq(orderItems.id, item.id))
        .returning();

      const [exception] = await tx.insert(allocationExceptions).values({
        orderId: item.orderId,
        orderItemId: item.id,
        orderNumber: order.orderNumber,
        sku: item.sku,
        productVariantId: variant.id,
        exceptionType: "manual_bin_override",
        status: reviewNeeded ? "needs_review" : "resolved_inline",
        requestedQty,
        selectedLocationId: location.id,
        selectedLocationCode: location.code,
        resolution: autoFixedSetup ? "auto_fixed_product_location" : "accepted_picker_bin",
        autoFixedSetup,
        reviewReason,
        resolvedBy: params.userId || null,
        resolvedAt: new Date(),
        metadata: {
          previousLocation: item.location,
          previousZone: item.zone,
          availableQty,
          activePrimaryLocations: activePrimaryRows.map((pl: any) => ({
            id: pl.id,
            location: pl.location,
            warehouseLocationId: pl.warehouseLocationId,
          })),
          enteredLocationCode: typedCode || null,
        },
      }).returning();

      return { updatedItem, exception };
    });

    await this.storage.createPickingLog({
      actionType: "allocation_bin_override",
      pickerId: params.userId || undefined,
      orderId: item.orderId,
      orderNumber: order.orderNumber,
      orderItemId: item.id,
      productId: item.productId || variant.productId,
      sku: item.sku,
      itemName: item.name,
      locationCode: location.code,
      qtyRequested: item.quantity,
      qtyBefore: item.pickedQuantity || 0,
      qtyAfter: item.pickedQuantity || 0,
      qtyDelta: 0,
      reason: reviewReason || "Picker confirmed bin assignment",
      deviceType: params.deviceType || "desktop",
      sessionId: params.sessionId,
      pickMethod: typedCode ? "manual" : "button",
      itemStatusBefore: item.status,
      itemStatusAfter: item.status,
      metadata: {
        exceptionId: result.exception.id,
        autoFixedSetup,
        reviewNeeded,
        selectedLocationId: location.id,
      },
    });

    try {
      const { notify } = await import("../notifications/notifications.service");
      const notificationType = autoFixedSetup
        ? "allocation_auto_fixed"
        : reviewNeeded
          ? "allocation_review_needed"
          : null;
      if (notificationType) {
        await notify(notificationType, {
          title: autoFixedSetup ? `Allocation setup fixed: ${item.sku}` : `Allocation review needed: ${item.sku}`,
          message: reviewReason || `Picker assigned ${item.sku} to ${location.code}`,
          data: {
            orderId: item.orderId,
            orderNumber: order.orderNumber,
            orderItemId: item.id,
            sku: item.sku,
            selectedLocationId: location.id,
            selectedLocationCode: location.code,
            exceptionId: result.exception.id,
          },
        });
      }
    } catch (notifyErr: any) {
      console.warn(`[Allocation] notification failed: ${notifyErr.message}`);
    }

    return {
      success: true,
      item: result.updatedItem as OrderItem,
      exception: result.exception,
      selectedLocation: { id: location.id, code: location.code, zone },
      autoFixedSetup,
      reviewNeeded,
    };
  }

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
      throw new ValidationError(`Status must be one of: ${itemStatusEnum.join(", ")}`);
    }

    // Load item before update
    const beforeItem = await this.storage.getOrderItemById(itemId);
    if (!beforeItem) {
      throw new IntegrityError(`Item ${itemId} not found`);
    }

    // Prevent double-pick — if already completed, treat as success (idempotent)
    if (status === "completed" && beforeItem.status === "completed") {
      console.log(`[Pick] Item ${itemId} already completed — returning success (idempotent)`);
      return { success: true, item: beforeItem as any, inventory: { deducted: false, systemQtyAfter: 0, locationId: null, locationCode: null, sku: beforeItem.sku, binCountNeeded: false, replen: { triggered: false, taskId: null, taskStatus: null, autoExecuted: false, autoExecutedMoved: null, autoExecutedFailed: false, autoExecuteFailReason: null, stockout: false, sourceLocationCode: null, sourceVariantSku: null, sourceVariantName: null, qtyToMove: null } } };
    }

    // Validate pickedQuantity bounds
    if (pickedQuantity !== undefined) {
      const qty = Number(pickedQuantity);
      if (!Number.isInteger(qty) || qty < 0 || qty > beforeItem.quantity) {
        throw new ValidationError(`pickedQuantity must be an integer between 0 and ${beforeItem.quantity}`);
      }
    }

    let completedDeductResult:
      | Awaited<ReturnType<PickingUseCases["_deductInventory"]>>
      | null = null;

    let item: OrderItem | null = null;

    if (status === "completed" && beforeItem.status !== "completed") {
      const atomicResult = await this.db.transaction(async (tx: any) => {
        // Lock the item row before moving inventory so concurrent scanner taps
        // cannot both deduct the same physical stock. The inventory use case is
        // bound to this same transaction below, so the item update and ledgered
        // inventory movement commit or roll back together.
        const locked = await tx.execute(sql`
          SELECT status
          FROM wms.order_items
          WHERE id = ${itemId}
          FOR UPDATE
        `);

        if (!locked.rows?.length) {
          throw new IntegrityError(`Item ${itemId} not found`);
        }

        if (locked.rows[0].status === "completed") {
          return {
            item: beforeItem,
            deductResult: null,
            alreadyCompleted: true,
          };
        }

        const txInventoryCore =
          typeof this.inventoryCore.withTx === "function"
            ? this.inventoryCore.withTx(tx)
            : this.inventoryCore;

        const pickedQtyForCompletion = pickedQuantity ?? beforeItem.quantity;
        const provisionalItem = {
          ...beforeItem,
          status: "completed",
          pickedQuantity: pickedQtyForCompletion,
          shortReason: shortReason ?? beforeItem.shortReason,
        } as OrderItem;

        const deductResult = await this._deductInventory(provisionalItem, beforeItem, {
          warehouseLocationId,
          userId,
          inventoryCore: txInventoryCore,
        });

        if (deductResult.success && !deductResult.noVariant) {
          await this.backfillPlannedShipmentItemPickLocation(tx, {
            orderItemId: itemId,
            productVariantId: deductResult.productVariantId,
            locationId: deductResult.locationId,
          });
        }

        const updates: Record<string, any> = {
          status,
          pickedAt: new Date(),
        };
        if (pickedQuantity !== undefined) updates.pickedQuantity = pickedQuantity;
        if (shortReason !== undefined) updates.shortReason = shortReason;

        const [updatedItem] = await tx
          .update(orderItems)
          .set(updates)
          .where(eq(orderItems.id, itemId))
          .returning();

        return {
          item: updatedItem as OrderItem,
          deductResult,
          alreadyCompleted: false,
        };
      });

      if (atomicResult.alreadyCompleted) {
        console.log(`[Pick] Item ${itemId} completed while waiting for lock - returning success (idempotent)`);
        return { success: true, item: atomicResult.item as any, inventory: { deducted: false, systemQtyAfter: 0, locationId: null, locationCode: null, sku: beforeItem.sku, binCountNeeded: false, replen: { triggered: false, taskId: null, taskStatus: null, autoExecuted: false, autoExecutedMoved: null, autoExecutedFailed: false, autoExecuteFailReason: null, stockout: false, sourceLocationCode: null, sourceVariantSku: null, sourceVariantName: null, qtyToMove: null } } };
      }

      item = atomicResult.item;
      completedDeductResult = atomicResult.deductResult;
    } else {
      // Atomic status update with WHERE guard on expectedCurrentStatus
      item = await this.storage.updateOrderItemStatus(
        itemId, status as ItemStatus, pickedQuantity, shortReason, beforeItem.status as ItemStatus,
      );
    }

    if (!item) {
      // With no status guard on completed transitions, this should only happen
      // for non-completed status updates. Log and return error.
      console.error(`[Pick] status_conflict on item ${itemId}: status='${beforeItem.status}', requested='${status}', pickedQty=${pickedQuantity}`);
      return { success: false, error: "status_conflict", message: `Item ${itemId} status conflict` };
    }

    // Log the action (fire-and-forget)
    const order = await this.storage.getOrderById(item.orderId);
    const pickerId = order?.assignedPickerId;
    const picker = pickerId ? await this.storage.getUser(pickerId) : null;

    let actionType = "item_picked";
    if (status === "completed") actionType = "item_picked";
    else if (status === "short") actionType = "item_shorted";
    else if (pickedQuantity !== undefined && beforeItem.pickedQuantity !== pickedQuantity) actionType = "item_quantity_adjusted";

    await this.storage.createPickingLog({
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
    });

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
        autoExecutedMoved: null,
        autoExecutedFailed: false,
        autoExecuteFailReason: null,
        stockout: false,
        sourceLocationCode: null,
        sourceVariantSku: null,
        sourceVariantName: null,
        qtyToMove: null,
      },
    };

    // If item was just completed, deduct inventory
    if (status === "completed" && beforeItem.status !== "completed") {
      const deductResult = completedDeductResult ?? await this._deductInventory(item, beforeItem, {
        warehouseLocationId,
        userId,
      });

      if (deductResult.success && !deductResult.noVariant) {
        // Deduction succeeded — check replen
        inventoryCtx.deducted = true;
        inventoryCtx.systemQtyAfter = deductResult.systemQtyAfter;
        inventoryCtx.locationId = deductResult.locationId;
        inventoryCtx.locationCode = deductResult.locationCode;

        // Auto-execute replen in background — no picker confirmation needed.
        // Fire-and-forget: returns result to caller so UI can show dismissible notification.
        try {
          const replenResult = await this.replenishment.createAndExecuteReplen(
            deductResult.productVariantId,
            deductResult.locationId,
            userId,
          );

          if (replenResult) {
            // Replen succeeded - notify picker with dismissible success banner
            console.log(`[Replen] Auto-executed replen for variant=${deductResult.productVariantId} loc=${deductResult.locationId}: moved ${replenResult.moved} units`);
            inventoryCtx.replen.triggered = true;
            inventoryCtx.replen.taskId = replenResult.task?.id ?? null;
            inventoryCtx.replen.taskStatus = "completed";
            inventoryCtx.replen.autoExecuted = true;
            inventoryCtx.replen.autoExecutedMoved = replenResult.moved;
            inventoryCtx.replen.autoExecutedFailed = false;
            inventoryCtx.replen.autoExecuteFailReason = null;
            // Source info from the completed task for UI display
            inventoryCtx.replen.qtyToMove = replenResult.moved;
            
            // Fix: The "Zero Collision"
            // If the bin hit zero, it initially flipped binCountNeeded to true.
            // But if auto-replenishment immediately refilled it inline, we MUST suppress the bin count,
            // otherwise the picker receives a redundant count prompt that overlaps and crashes replen!
            if (replenResult.moved > 0) {
              inventoryCtx.binCountNeeded = false;
            }
          } else {
            // createAndExecuteReplen returned null — guidance check says no replen needed
            // (threshold not met, or no source stock). Nothing to do — this is the normal case.
            console.log(`[Replen] No replen needed after pick for variant=${deductResult.productVariantId} loc=${deductResult.locationId}`);
          }
        } catch (replenErr: any) {
          // Replen failed — don't block the picker, but surface a persistent alert
          const failReason = replenErr?.message || "unknown_error";
          console.warn(`[Replen] Auto-execute failed for variant=${deductResult.productVariantId} loc=${deductResult.locationId}: ${failReason}`);

          // Still show replen triggered so UI surfaces the failure alert
          inventoryCtx.replen.triggered = true;
          inventoryCtx.replen.autoExecuted = false;
          inventoryCtx.replen.autoExecutedFailed = true;
          inventoryCtx.replen.autoExecuteFailReason = failReason.startsWith("execute_failed:") ? "execute_failed" : failReason;

          // Log failure for investigation (fire-and-forget)
          this.storage.createPickingLog({
            actionType: "replen_auto_execute_failed",
            pickerId: pickerId || undefined,
            pickerName: picker?.displayName || picker?.username || pickerId || undefined,
            orderId: item.orderId,
            orderNumber: order?.orderNumber,
            orderItemId: item.id,
            sku: item.sku,
            itemName: item.name,
            locationCode: inventoryCtx.locationCode || item.location,
            reason: failReason,
            deviceType: deviceType || "desktop",
            sessionId,
          }).catch((err: any) => console.warn("[PickingLog] replen failure log failed:", err.message));
        }

        // binCountNeeded is only set for inventory discrepancies (deduction failure path).
        // When replen triggers, the UI shows the simple replen-confirm toggle instead.

      } else if (!deductResult.success) {
        // Deduction FAILED — system inventory is wrong.
        // DO NOT revert the pick. Item stays completed.
        inventoryCtx.deducted = false;
        inventoryCtx.systemQtyAfter = deductResult.systemQty;
        inventoryCtx.locationId = deductResult.locationId;
        inventoryCtx.locationCode = deductResult.locationCode;
        inventoryCtx.binCountNeeded = false; // No bin count modal — picker shouldn't count inventory

        // Run the SAME replen check as the success path — picker needs full
        // guidance (source location, qty, method), not just a "no stock" boolean.
        if (deductResult.locationId) {
          const replenGuidance = await this.replenishment
            .checkReplenNeeded(deductResult.productVariantId, deductResult.locationId)
            .catch((err: any) => { console.warn("[Replen] guidance check failed (deduct fail path):", err.message); return null; });

          if (replenGuidance?.needed) {
            inventoryCtx.replen.triggered = true;
            inventoryCtx.replen.stockout = replenGuidance.stockout;
            inventoryCtx.replen.sourceLocationCode = replenGuidance.sourceLocationCode;
            inventoryCtx.replen.sourceVariantSku = replenGuidance.sourceVariantSku;
            inventoryCtx.replen.sourceVariantName = replenGuidance.sourceVariantName;
            inventoryCtx.replen.qtyToMove = replenGuidance.qtyTargetUnits || null;
          } else {
            // Replen not needed or can't be determined — fall back to reserve check
            const hasReserve = await this._hasReserveStock(deductResult.productVariantId);
            inventoryCtx.replen.stockout = !hasReserve;
          }
        } else {
          // No location context — can't check replen, just check reserve
          const hasReserve = await this._hasReserveStock(deductResult.productVariantId);
          inventoryCtx.replen.stockout = !hasReserve;
        }

        // Log discrepancy to picking_logs (fire-and-forget)
        await this.storage.createPickingLog({
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
        });
      }
      // else: noVariant = true (non-inventory item) — no deduction needed, inventoryCtx stays default
    }

    // ALWAYS update order progress (regardless of deduction result)
    const settings = await this.getPickSettings();
    await this.storage.updateOrderProgress(item.orderId, settings.postPickStatus);

    return { success: true, item, inventory: inventoryCtx };
  }

  /**
   * Planned shipment rows can be created before a picker has chosen the real
   * source bin. Once the pick ledger records the actual location, carry that
   * location onto any still-unresolved shipment items so downstream package /
   * ShipStation processing does not treat the early placeholder as final truth.
   */
  private async backfillPlannedShipmentItemPickLocation(
    db: Pick<DrizzleDb, "execute">,
    params: { orderItemId: number; productVariantId: number; locationId: number },
  ): Promise<void> {
    await db.execute(sql`
      UPDATE wms.outbound_shipment_items osi
      SET from_location_id = ${params.locationId}
      FROM wms.outbound_shipments os
      WHERE osi.shipment_id = os.id
        AND osi.order_item_id = ${params.orderItemId}
        AND osi.product_variant_id = ${params.productVariantId}
        AND osi.from_location_id IS NULL
        AND os.status IN ('planned', 'queued')
    `);
  }

  /** Internal: resolve pick location and deduct inventory via inventoryCore. */
  private async _deductInventory(
    item: OrderItem,
    beforeItem: OrderItem,
    opts: { warehouseLocationId?: number; userId?: string; inventoryCore?: InventoryCore },
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
    let actualPickQty = pickedQty;

    const pickablePriority: Record<string, number> = { pick: 0, pallet: 1 };
    const pickableLevels = levels
      .map((l: any) => {
        const loc = allLocations.find(loc => loc.id === l.warehouseLocationId);
        return { level: l, loc };
      })
      .filter(({ loc }) => loc?.isPickable === 1 && !loc.cycleCountFreezeId)
      .sort((a, b) => (pickablePriority[a.loc?.locationType as string] ?? 99) - (pickablePriority[b.loc?.locationType as string] ?? 99));

    // Try the location already assigned to this order item (full qty)
    if (!pickLocationId && assignedLocationId) {
      const assignedLevel = levels.find((l: any) => l.warehouseLocationId === assignedLocationId);
      if (assignedLevel && assignedLevel.variantQty >= pickedQty) {
        pickLocationId = assignedLocationId;
      }
    }

    // Fallback: any pickable location with full qty
    if (!pickLocationId) {
      const fullMatch = pickableLevels.find(({ level: l }) => l.variantQty >= pickedQty);
      if (fullMatch) pickLocationId = fullMatch.level.warehouseLocationId;
    }

    // Partial pick: no location has full qty — take what's available
    if (!pickLocationId) {
      // Prefer assigned bin if it has anything
      if (assignedLocationId) {
        const assignedLevel = levels.find((l: any) => l.warehouseLocationId === assignedLocationId);
        if (assignedLevel && assignedLevel.variantQty > 0) {
          pickLocationId = assignedLocationId;
          actualPickQty = assignedLevel.variantQty;
        }
      }
      // Otherwise take the best pickable bin with any stock
      if (!pickLocationId) {
        const partial = pickableLevels.find(({ level: l }) => l.variantQty > 0);
        if (partial) {
          pickLocationId = partial.level.warehouseLocationId;
          actualPickQty = partial.level.variantQty;
        }
      }
    }

    if (!pickLocationId) {
      // Truly zero stock anywhere — nothing to deduct
      const assignedLevel = assignedLocationId
        ? levels.find((l: any) => l.warehouseLocationId === assignedLocationId)
        : null;
      return {
        success: false,
        error: "no_inventory",
        message: `No pickable location has any stock for ${item.sku}`,
        productVariantId: productVariant.id,
        locationId: assignedLocationId,
        locationCode: assignedLocationCode,
        systemQty: assignedLevel?.variantQty ?? 0,
      };
    }

    if (actualPickQty < pickedQty) {
      console.log(`[Inventory] Partial pick: ${actualPickQty} of ${pickedQty} requested for ${productVariant.sku} at location ${pickLocationId}`);
    }

    const inventoryCore = opts.inventoryCore ?? this.inventoryCore;

    const picked = await inventoryCore.pickItem({
      productVariantId: productVariant.id,
      warehouseLocationId: pickLocationId,
      qty: actualPickQty,
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
        message: `Concurrent pick claimed stock for ${item.sku}`,
        productVariantId: productVariant.id,
        locationId: pickLocationId,
        locationCode: loc?.code || assignedLocationCode,
        systemQty: level?.variantQty ?? 0,
      };
    }

    // Read back updated level for accurate systemQtyAfter
    const updatedLevel = await inventoryCore.getLevel(productVariant.id, pickLocationId);
    const loc = allLocations.find(l => l.id === pickLocationId);

    console.log(`[Inventory] Picked: ${pickedQty} variant units of ${productVariant.id} from location ${pickLocationId}`);
    
    // Trigger channel sync for this variant (fire-and-forget)
    if (this.channelSync) {
      this.channelSync.queueSyncAfterInventoryChange(productVariant.id).catch((err: any) =>
        console.warn(`[ChannelSync] Post-pick sync failed for variant ${productVariant.id}:`, err),
      );
    }

    return {
      success: true,
      productVariantId: productVariant.id,
      locationId: pickLocationId,
      locationCode: loc?.code || assignedLocationCode || "",
      systemQtyAfter: updatedLevel?.variantQty ?? 0,
    };
  }

  /** Check if any non-pick location has stock for this variant OR its fungible source (e.g. case variant) */
  private async _hasReserveStock(productVariantId: number): Promise<boolean> {
    const locations = await this.storage.getAllWarehouseLocations();
    const hasNonPick = (varId: number) =>
      this.inventoryCore.getLevelsByVariant(varId).then(levels =>
        levels.some(l => {
          const loc = locations.find(wl => wl.id === l.warehouseLocationId);
          return loc && loc.locationType !== "pick" && l.variantQty > 0;
        }),
      );

    // Check exact variant first
    if (await hasNonPick(productVariantId)) return true;

    // Check fungible source variants (e.g. C800 case for P25 pack)
    const variant = await this.storage.getProductVariantById(productVariantId);
    if (!variant?.productId) return false;

    const siblings = await this.storage.getProductVariantsByProductId(variant.productId);
    const sources = siblings.filter(v => v.id !== productVariantId && v.hierarchyLevel > variant.hierarchyLevel && v.isActive);
    for (const src of sources) {
      if (await hasNonPick(src.id)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // 2. claimOrder
  // -------------------------------------------------------------------------

  async claimOrder(orderId: number, pickerId: string, deviceType?: string, sessionId?: string): Promise<{ order: Order; items: OrderItem[] }> { 
    if (!pickerId) throw new ValidationError("pickerId is required");

    const orderBefore = await this.storage.getOrderById(orderId);

    const order = await this.storage.claimOrder(orderId, pickerId);
    if (!order) throw new IntegrityError("Order is no longer available");

    // Audit log (fire-and-forget)
    const picker = await this.storage.getUser(pickerId);
    await this.storage.createPickingLog({
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
    });

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
    await this.storage.createPickingLog({
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
    });

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
    await this.storage.createPickingLog({
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
    });

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
      // Use adjustInventory instead of adjustLevel — handles sync triggers,
      // audit trail, negative guards, and lot tracking automatically
      await this.inventoryCore.adjustInventory({
        productVariantId: variant.id,
        warehouseLocationId,
        qtyDelta: adjustment,
        reason: `Picker bin count after case break: system=${systemQty}, actual=${actualBinQty}, adj=${adjustment}`,
        userId: userId || undefined,
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
      replenFailReason: null,
      inferredReplen: false,
      inferredReplenMoved: null,
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

    // Correct inventory if needed — picker's count is source of truth
    if (adjustment !== 0) {
      await this.inventoryCore.adjustInventory({
        productVariantId: variant.id,
        warehouseLocationId,
        qtyDelta: adjustment,
        reason: `Picker skipped replen — bin count correction: system=${systemQty}, actual=${actualBinQty}`,
        userId: userId || undefined,
      });

      // If we found MORE stock than expected, trigger cycle count notification
      // on the source case bin — an unrecorded case break may have occurred
      if (adjustment > 0) {
        try {
          const pendingTasks = await this.storage.getPendingReplenTasksForLocation(warehouseLocationId);
          const matchingTask = pendingTasks.find(
            (t: any) => t.pickProductVariantId === variant.id && t.fromLocationId
          );

          if (matchingTask?.fromLocationId) {
            const { notify } = await import("../notifications/notifications.service");

            await notify("cycle_count_needed", {
              title: `Bin variance: ${variant.sku}`,
              message: `Bin has +${adjustment} more than expected ` +
                `(system: ${systemQty}, actual: ${actualBinQty}). ` +
                `Verify source bin (location ${matchingTask.fromLocationId}) — possible unrecorded case break.`,
              data: {
                sourceLocationId: matchingTask.fromLocationId,
                targetLocationId: warehouseLocationId,
                variantId: variant.id,
                adjustment,
                systemQty,
                actualBinQty,
              },
            });
          }
        } catch (notifyErr: any) {
          console.warn(`[Picking] Cycle count notification failed: ${notifyErr.message}`);
        }
      }
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

    return { success: true, systemQtyBefore: systemQty, actualBinQty, adjustment, replenTriggered: false, replenTaskStatus: null, replenFailReason: null, inferredReplen: false, inferredReplenMoved: null };
  }

  // -------------------------------------------------------------------------
  // 7b. CONSOLIDATED BIN COUNT (replaces separate replen confirm + bin count)
  // -------------------------------------------------------------------------

  /**
   * Handles both replen confirmation and bin count in a single atomic call.
   * If didReplen=true: creates + executes replen task, then reconciles bin count.
   * If didReplen=false: just reconciles bin count, no replen task created.
   */
  async handleBinCount(params: {
    sku: string;
    locationId: number;
    binCount: number;
    didReplen: boolean;
    userId?: string;
  }): Promise<BinCountResult> {
    const { sku, locationId, binCount, didReplen, userId } = params;

    // Guard: reject obviously wrong counts (e.g. barcode scanned into number field)
    const MAX_BIN_COUNT = 10_000;
    if (binCount < 0 || binCount > MAX_BIN_COUNT) {
      throw new Error(
        `Bin count ${binCount} is outside the valid range (0–${MAX_BIN_COUNT}). ` +
        `If a barcode was scanned into the count field, please clear it and type the actual quantity.`,
      );
    }

    const variant = await this.storage.getProductVariantBySku(sku);
    if (!variant) {
      throw new Error(`No variant found for SKU ${sku}`);
    }

    let replenResult: any = null;
    let replenFailReason: string | null = null;

    // Step 1: If picker confirmed replen, create+execute the task atomically
    if (didReplen) {
      try {
        replenResult = await this.replenishment.createAndExecuteReplen(variant.id, locationId, userId);
        if (replenResult) {
          console.log(`[BinCount] replen executed: moved ${replenResult.moved} units`);
        } else {
          replenFailReason = "no_source_stock";
          console.warn(`[BinCount] replen returned null — likely no source stock or threshold no longer met`);
        }
      } catch (err: any) {
        const msg = err?.message || "unknown_error";
        replenFailReason = msg.startsWith("execute_failed:") ? "execute_failed" : msg;
        console.warn(`[BinCount] replen failed (will still do bin count): ${msg}`);
      }
    }

    // Step 2: Re-read current system qty (after pick deduction + replen if it happened)
    const level = await this.inventoryCore.getLevel(variant.id, locationId);
    const systemQty = level?.variantQty ?? 0;

    // Step 3: If there's a surplus and picker didn't explicitly confirm replen,
    // infer that an unrecorded case break / replen occurred. This keeps the
    // source bin accurate instead of dumping everything into a blind cycle count.
    let inferredReplen: any = null;
    const surplus = binCount - systemQty;

    if (!didReplen && surplus > 0) {
      try {
        // [TODO] inferUnrecordedReplen was removed from replen.service.ts
        // inferredReplen = await this.replenishment.inferUnrecordedReplen(variant.id, locationId, surplus, userId);
        // if (inferredReplen) {
        //   console.log(`[BinCount] inferred replen: ${inferredReplen.moved} units attributed to unrecorded case break`);
        //   // Re-read system qty after the inferred replen credited the destination
        //   // (executeTask already adjusted the level)
        // } else {
        //   console.log(`[BinCount] no replen source found — full surplus will be cycle count`);
        // }
        console.log(`[BinCount] inferUnrecordedReplen removed — full surplus will be cycle count`);
      } catch (err: any) {
        console.warn(`[BinCount] inferred replen failed:`, err?.message);
      }
    }

    // Step 4: Re-read system qty again (reflects: pick deduction + explicit replen + inferred replen)
    const postLevel = await this.inventoryCore.getLevel(variant.id, locationId);
    const postSystemQty = postLevel?.variantQty ?? systemQty;
    const adjustment = binCount - postSystemQty;

    if (adjustment !== 0 && postLevel) {
      // Use adjustInventory for bin count corrections — handles sync triggers,
      // audit trail, negative guards, and lot tracking automatically
      const reason = didReplen
        ? `Bin count after replen: system=${postSystemQty}, actual=${binCount}, adjustment=${adjustment}, replen moved=${replenResult?.moved ?? 'failed'}`
        : inferredReplen
          ? `Bin count with inferred replen: system before=${systemQty}, after inferred replen=${postSystemQty}, actual=${binCount}, remaining variance=${adjustment}`
          : `Bin count: system=${postSystemQty}, actual=${binCount}, adjustment=${adjustment}`;

      await this.inventoryCore.adjustInventory({
        productVariantId: variant.id,
        warehouseLocationId: locationId,
        qtyDelta: adjustment,
        reason,
        userId: userId || undefined,
      });

      // If positive adjustment (more stock than expected) and no replen was done,
      // an unrecorded case break may have occurred. Notify leads to verify source bin.
      if (adjustment > 0 && !didReplen) {
        try {
          const { notify } = await import("../notifications/notifications.service");
          await notify("cycle_count_needed", {
            title: `Bin variance: ${variant.sku}`,
            message: `Bin has +${adjustment} more than expected ` +
              `(system: ${postSystemQty}, actual: ${binCount}). ` +
              `Possible unrecorded case break — verify source bins.`,
            data: {
              targetLocationId: locationId,
              variantId: variant.id,
              adjustment,
              systemQty: postSystemQty,
              actualBinQty: binCount,
            },
          });
        } catch (notifyErr: any) {
          console.warn(`[BinCount] Cycle count notification failed: ${notifyErr.message}`);
        }
      }
    } else {
      // No remaining adjustment — log for audit trail
      await this.inventoryCore.logTransaction({
        productVariantId: variant.id,
        toLocationId: locationId,
        transactionType: "cycle_count",
        variantQtyDelta: 0,
        variantQtyBefore: postSystemQty,
        variantQtyAfter: binCount,
        sourceState: "on_hand",
        targetState: "on_hand",
        referenceType: inferredReplen ? "picker_bin_count_inferred_replen" : didReplen ? "picker_bin_count_post_replen" : "picker_bin_count",
        referenceId: `${sku}:${locationId}`,
        notes: inferredReplen
          ? `Bin count verified after inferred replen: system=${postSystemQty}, actual=${binCount} (match). Inferred replen moved ${inferredReplen.moved} units from source.`
          : `Bin count verified: system=${postSystemQty}, actual=${binCount} (match)${didReplen ? `, replen moved=${replenResult?.moved ?? 'failed'}` : ''}`,
        userId: userId || null,
      });
    }

    // Step 5: If picker said NO replen (and no inferred replen), cancel orphaned pending tasks
    if (!didReplen && !inferredReplen) {
      const existingTasks = await this.storage.getPendingReplenTasksForLocation(locationId);
      for (const task of existingTasks) {
        if (task.pickProductVariantId === variant.id && (task.status === "pending" || task.status === "blocked")) {
          await this.storage.updateReplenTask(task.id, {
            status: "cancelled",
            notes: `${task.notes || ""}\nCancelled: picker confirmed no replen needed (actual qty=${binCount})`,
          });
        }
      }
    }

    return {
      success: true,
      systemQtyBefore: systemQty,
      actualBinQty: binCount,
      adjustment,
      replenTriggered: !!replenResult || !!inferredReplen,
      replenTaskStatus: replenResult ? "completed" : inferredReplen ? "completed" : null,
      replenFailReason: didReplen && !replenResult ? replenFailReason : null,
      inferredReplen: !!inferredReplen,
      inferredReplenMoved: inferredReplen?.moved ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // 8. confirmReplen — simplified picker replen confirmation
  // -------------------------------------------------------------------------

  /**
   * Called after auto-replen executes. The picker taps:
   *   confirmed = true  → log it as verified, done
   *   confirmed = false → notify leads, cancel orphaned tasks (flag for cycle count)
   */
  async confirmReplen(params: {
    sku: string;
    locationId: number;
    confirmed: boolean;
    userId?: string;
  }): Promise<{ success: true; action: "confirmed" | "flagged" }> {
    const { sku, locationId, confirmed, userId } = params;

    const variant = await this.storage.getProductVariantBySku(sku);
    if (!variant) {
      throw new Error(`No variant found for SKU ${sku}`);
    }

    if (confirmed) {
      // Picker verified — just write an audit log
      this.storage.createPickingLog({
        actionType: "replen_confirmed",
        pickerId: userId || undefined,
        sku,
        locationCode: String(locationId),
        notes: "Picker confirmed case break replen completed",
      }).catch((e: any) => console.warn("[ReplenConfirm] log failed:", e.message));

      return { success: true, action: "confirmed" };
    } else {
      // Picker flagged issue — notify leads + cancel orphaned replen tasks
      try {
        const { notify } = await import("../notifications/notifications.service");
        await notify("cycle_count_needed", {
          title: `Replen issue flagged: ${sku}`,
          message: `Picker flagged a replen issue at location ${locationId}. Please verify the bin.`,
          data: { targetLocationId: locationId, variantId: variant.id, sku, flaggedBy: userId },
        });
      } catch (notifyErr: any) {
        console.warn(`[ReplenConfirm] Notification failed: ${notifyErr.message}`);
      }

      // Cancel orphaned pending/blocked replen tasks
      const existingTasks = await this.storage.getPendingReplenTasksForLocation(locationId);
      for (const task of existingTasks) {
        if (
          task.pickProductVariantId === variant.id &&
          (task.status === "pending" || task.status === "blocked")
        ) {
          await this.storage.updateReplenTask(task.id, {
            status: "cancelled",
            notes: `${task.notes || ""}\nCancelled: picker flagged replen issue`,
          });
        }
      }

      this.storage.createPickingLog({
        actionType: "replen_issue_flagged",
        pickerId: userId || undefined,
        sku,
        locationCode: String(locationId),
        notes: "Picker flagged replen issue — cycle count needed",
      }).catch((e: any) => console.warn("[ReplenConfirm] log failed:", e.message));

      return { success: true, action: "flagged" };
    }
  }

  // -------------------------------------------------------------------------
  // 9. getPickQueue
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
      // Index rules by pickProductVariantId AND by productId (matching replenishment service)
      const ruleByPickVariant = new Map<number, any>();
      const ruleByProduct = new Map<number, any>();
      for (const r of allRules) {
        if (r.pickProductVariantId) ruleByPickVariant.set(r.pickProductVariantId, r);
        if (r.productId) ruleByProduct.set(r.productId, r);
      }

      const allLocs = await this.storage.getAllWarehouseLocations();

      for (const sku of Array.from(skus)) {
        const variant = await this.storage.getProductVariantBySku(sku);
        if (!variant) continue;

        const levels = await this.storage.getInventoryLevelsByProductVariantId(variant.id);
        const pickLevel = levels.find((l: any) => {
          const loc = allLocs.find(wl => wl.id === l.warehouseLocationId);
          return loc && loc.locationType === "pick" && loc.isPickable === 1 && !loc.cycleCountFreezeId;
        });

        const systemQty = pickLevel?.variantQty ?? 0;

        // Check variant-level rule first, then product-level rule (matches replenishment service)
        const rule = ruleByPickVariant.get(variant.id)
          || (variant.productId ? ruleByProduct.get(variant.productId) : undefined);
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
  channelSync?: ChannelSyncLike,
) {
  return new PickingUseCases(db, inventoryCore, replenishment, storage, channelSync);
}

export type { PickingUseCases as PickingService };
