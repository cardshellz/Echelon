import { eq, and, sql } from "drizzle-orm";
import { IntegrityError, ValidationError } from "../../../shared/errors";
import { AuditLogger } from "../../infrastructure/auditLogger";
import {
  inventoryLevels,
  warehouseLocations,
  warehouseSettings,
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
  checkAndTriggerAfterPick: (productVariantId: number, warehouseLocationId: number, triggeredBy?: string, context?: ReplenOrderContext) => Promise<any>;
  checkReplenNeeded: (productVariantId: number, warehouseLocationId: number) => Promise<{ needed: boolean; stockout: boolean; sourceLocationCode: string | null; sourceVariantSku: string | null; sourceVariantName: string | null; qtyTargetUnits: number; [key: string]: any }>;
  predictReplenAfterPick: (productVariantId: number, warehouseLocationId: number, pickedQty: number) => Promise<{
    systemQty: number;
    postPickQty: number;
    triggerValue: number | null;
    replenNeeded: boolean;
    replenMethod: string;
    autoReplen: number;
    stockout: boolean;
    executionMode: string;
    sourceLocationCode: string | null;
    sourceQty: number;
    sourceVariantName: string | null;
    existingTaskId: number | null;
    existingTaskStatus: string | null;
    existingTaskExecutionMode: string | null;
    existingTaskBlocksShipment: boolean;
  } | null>;
  executeTask: (taskId: number, userId?: string) => Promise<{ moved: number }>;
  createAndExecuteReplen: (pickVariantId: number, toLocationId: number, userId?: string, context?: ReplenOrderContext) => Promise<{ task: any; moved: number } | null>;
  ensureQueuedReplenForShortPick: (pickVariantId: number, toLocationId: number, userId?: string, context?: ReplenOrderContext) => Promise<{ task: any; moved: number; guidance?: any } | null>;
  recordSourceEmptyBlocker: (params: {
    pickVariantId: number;
    pickLocationId: number;
    orderId: number;
    orderItemId: number;
    orderNumber?: string | null;
    sku?: string | null;
    sourceLocationCode?: string | null;
    userId?: string;
  }) => Promise<any>;
};

type ReplenOrderContext = {
  orderId?: number | null;
  orderItemId?: number | null;
  orderNumber?: string | null;
  blocksShipment?: boolean;
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
  resolution: {
    autoResolved: boolean;
    code: string | null;
    reviewRequired: boolean;
    pickerBlocking: boolean;
    shipmentBlocking: boolean;
    message: string | null;
  };
  replen: {
    triggered: boolean;
    taskId: number | null;
    taskStatus: string | null;
    autoExecuted: boolean;
    autoExecutedMoved: number | null;
    autoExecutedMovedBaseUnits: number | null;
    autoExecutedMovedUom: string | null;
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
  inferredReplen: boolean; // legacy response field; picker bin counts no longer infer replen
  inferredReplenMoved: number | null;
};

type ScanAutoResolvedInventory = {
  code: "picker_scan_bin_shortage";
  adjustment: number;
  systemQtyBefore: number;
  pickedQty: number;
  message: string;
};

type DeductInventoryResult =
  | {
      success: true;
      noVariant?: undefined;
      productVariantId: number;
      locationId: number;
      locationCode: string;
      systemQtyAfter: number;
      autoResolved?: ScanAutoResolvedInventory;
    }
  | {
      success: false;
      error: string;
      message: string;
      productVariantId: number;
      locationId: number | null;
      locationCode: string | null;
      systemQty: number;
      pickerBlocking?: boolean;
      shipmentBlocking?: boolean;
    }
  | {
      success: true;
      noVariant: true;
      productVariantId: 0;
      locationId: 0;
      locationCode: null;
      systemQtyAfter: 0;
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

export type ReplenSourceEmptyResult = {
  success: true;
  orderItemId: number;
  taskId: number;
  status: string;
};

export type CloseShipmentBlockersResult = {
  allocationExceptionsClosed: number;
  replenTasksClosed: number;
};

export type PickQueueOrder = any; // Pass-through type from storage

function emptyPickInventoryContext(sku: string): PickInventoryContext {
  return {
    deducted: false,
    systemQtyAfter: 0,
    locationId: null,
    locationCode: null,
    sku,
    binCountNeeded: false,
    resolution: {
      autoResolved: false,
      code: null,
      reviewRequired: false,
      pickerBlocking: false,
      shipmentBlocking: false,
      message: null,
    },
    replen: {
      triggered: false,
      taskId: null,
      taskStatus: null,
      autoExecuted: false,
      autoExecutedMoved: null,
      autoExecutedMovedBaseUnits: null,
      autoExecutedMovedUom: null,
      autoExecutedFailed: false,
      autoExecuteFailReason: null,
      stockout: false,
      sourceLocationCode: null,
      sourceVariantSku: null,
      sourceVariantName: null,
      qtyToMove: null,
    },
  };
}

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

  private countUomLabel(variant: any | null | undefined): string {
    const unitsPerVariant = Math.max(1, Number(variant?.unitsPerVariant ?? variant?.units_per_variant ?? 1));
    const hierarchyLevel = Number(variant?.hierarchyLevel ?? variant?.hierarchy_level ?? 0);
    const text = `${variant?.sku ?? ""} ${variant?.name ?? ""}`.toLowerCase();

    if (/\bpack\b/.test(text) || /(^|[-_\s])p\d+($|[-_\s])/.test(text)) return "packs";
    if (/\bbox\b/.test(text) || /(^|[-_\s])b\d+($|[-_\s])/.test(text)) return "boxes";
    if (/\bcase\b/.test(text) || /(^|[-_\s])c\d+($|[-_\s])/.test(text)) return "cases";
    if (hierarchyLevel === 1 && unitsPerVariant > 1) return "packs";
    if (hierarchyLevel === 2) return "boxes";
    if (hierarchyLevel >= 3) return "cases";
    return "units";
  }

  private async describeInlineReplenMove(
    task: any,
    fallbackPickVariantId: number,
    movedBaseUnits: number,
  ): Promise<{ pickQty: number; baseUnits: number; uom: string }> {
    const pickVariantId = Number(task?.pickProductVariantId ?? task?.pick_product_variant_id ?? fallbackPickVariantId);
    const sourceVariantId = Number(task?.sourceProductVariantId ?? task?.source_product_variant_id ?? 0);
    const replenMethod = task?.replenMethod ?? task?.replen_method ?? null;
    const qtySourceUnits = task?.qtySourceUnits ?? task?.qty_source_units ?? null;
    const pickVariant = pickVariantId
      ? await this.storage.getProductVariantById(pickVariantId).catch(() => null)
      : null;
    const pickUnits = Math.max(1, Number(pickVariant?.unitsPerVariant ?? pickVariant?.units_per_variant ?? 1));
    const isCaseBreak = replenMethod === "case_break" && sourceVariantId > 0 && sourceVariantId !== pickVariantId;

    const rawPickQty = isCaseBreak
      ? Math.floor(movedBaseUnits / pickUnits)
      : Number(qtySourceUnits ?? Math.floor(movedBaseUnits / pickUnits));
    const pickQty = Number.isFinite(rawPickQty) && rawPickQty >= 0 ? rawPickQty : 0;

    return {
      pickQty,
      baseUnits: movedBaseUnits,
      uom: this.countUomLabel(pickVariant),
    };
  }

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

  async reportReplenSourceEmpty(orderItemId: number, params: {
    sourceLocationCode?: string | null;
    userId?: string;
    deviceType?: string;
    sessionId?: string;
  }): Promise<ReplenSourceEmptyResult> {
    const item = await this.storage.getOrderItemById(orderItemId);
    if (!item) {
      throw new IntegrityError(`Item ${orderItemId} not found`);
    }
    if (!item.location || item.location === "UNASSIGNED") {
      throw new ValidationError(`Item ${orderItemId} has no pick bin`);
    }

    const variant = await this.storage.getProductVariantBySku(item.sku);
    if (!variant) {
      throw new ValidationError(`No variant found for SKU ${item.sku}`);
    }

    const [pickLocation] = await this.db
      .select()
      .from(warehouseLocations)
      .where(eq(warehouseLocations.code, item.location))
      .limit(1);
    if (!pickLocation) {
      throw new ValidationError(`Pick bin ${item.location} was not found`);
    }

    const order = await this.storage.getOrderById(item.orderId);
    const pickerId = order?.assignedPickerId || params.userId;
    const picker = pickerId ? await this.storage.getUser(pickerId) : null;

    const task = await this.replenishment.recordSourceEmptyBlocker({
      pickVariantId: variant.id,
      pickLocationId: pickLocation.id,
      orderId: item.orderId,
      orderItemId: item.id,
      orderNumber: order?.orderNumber ?? null,
      sku: item.sku,
      sourceLocationCode: params.sourceLocationCode ?? null,
      userId: params.userId,
    });

    await this.storage.createPickingLog({
      actionType: "replen_source_empty_reported",
      pickerId: pickerId || undefined,
      pickerName: picker?.displayName || picker?.username || pickerId || undefined,
      pickerRole: picker?.role,
      orderId: item.orderId,
      orderNumber: order?.orderNumber,
      orderItemId: item.id,
      sku: item.sku,
      itemName: item.name,
      locationCode: item.location,
      reason: "source_empty",
      notes: `Picker reported replen source empty${params.sourceLocationCode ? ` at ${params.sourceLocationCode}` : ""}; replen task #${task.id} blocks shipment`,
      itemStatusBefore: item.status,
      itemStatusAfter: item.status,
      deviceType: params.deviceType || "desktop",
      sessionId: params.sessionId,
      pickMethod: "short",
    });

    return {
      success: true,
      orderItemId: item.id,
      taskId: task.id,
      status: task.status,
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
    const orderForPick = await this.storage.getOrderById(beforeItem.orderId);

    // Prevent double-pick — if already completed, treat as success (idempotent)
    if (status === "completed" && beforeItem.status === "completed") {
      console.log(`[Pick] Item ${itemId} already completed — returning success (idempotent)`);
      return { success: true, item: beforeItem as any, inventory: emptyPickInventoryContext(beforeItem.sku) };
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
    let forcePostPickStatus: string | null = null;

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
          warehouseId: orderForPick?.warehouseId ?? null,
          userId,
          inventoryCore: txInventoryCore,
          pickMethod,
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
        return { success: true, item: atomicResult.item as any, inventory: emptyPickInventoryContext(beforeItem.sku) };
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
    const order = orderForPick ?? await this.storage.getOrderById(item.orderId);
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
    const inventoryCtx: PickInventoryContext = emptyPickInventoryContext(item.sku);

    if (status === "short" && beforeItem.status !== "short") {
      try {
        const queued = await this.queueShortPickReplen({
          item,
          order,
          warehouseLocationId,
          userId,
        });

        if (queued) {
          const taskStatus = queued.result.task?.status ?? null;
          inventoryCtx.locationId = queued.location.id;
          inventoryCtx.locationCode = queued.location.code;
          inventoryCtx.replen.triggered = true;
          inventoryCtx.replen.taskId = queued.result.task?.id ?? null;
          inventoryCtx.replen.taskStatus = taskStatus;
          inventoryCtx.replen.autoExecuted = false;
          inventoryCtx.replen.autoExecutedMoved = null;
          inventoryCtx.replen.autoExecutedFailed = taskStatus === "blocked";
          inventoryCtx.replen.autoExecuteFailReason = taskStatus === "blocked"
            ? queued.result.task?.exceptionReason || "blocked"
            : null;
          inventoryCtx.replen.stockout = false;
          inventoryCtx.replen.sourceLocationCode = queued.result.guidance?.sourceLocationCode ?? null;
          inventoryCtx.replen.sourceVariantSku = queued.result.guidance?.sourceVariantSku ?? null;
          inventoryCtx.replen.sourceVariantName = queued.result.guidance?.sourceVariantName ?? null;
          inventoryCtx.replen.qtyToMove = queued.result.task?.qtyTargetUnits ?? queued.result.guidance?.qtyTargetUnits ?? null;
        }
      } catch (replenErr: any) {
        const failReason = replenErr?.message || "unknown_error";
        console.warn(`[Replen] Short-pick queue failed for item=${item.id} sku=${item.sku}: ${failReason}`);
        inventoryCtx.replen.triggered = true;
        inventoryCtx.replen.autoExecuted = false;
        inventoryCtx.replen.autoExecutedFailed = true;
        inventoryCtx.replen.autoExecuteFailReason = failReason;
        this.storage.createPickingLog({
          actionType: "short_pick_replen_queue_failed",
          pickerId: pickerId || undefined,
          pickerName: picker?.displayName || picker?.username || pickerId || undefined,
          orderId: item.orderId,
          orderNumber: order?.orderNumber,
          orderItemId: item.id,
          sku: item.sku,
          itemName: item.name,
          locationCode: item.location,
          reason: failReason,
          deviceType: deviceType || "desktop",
          sessionId,
        }).catch((err: any) => console.warn("[PickingLog] short-pick replen failure log failed:", err.message));
      }
    }

    // If item was just completed, deduct inventory
    if (status === "completed" && beforeItem.status !== "completed") {
      const deductResult = completedDeductResult ?? await this._deductInventory(item, beforeItem, {
        warehouseLocationId,
        warehouseId: order?.warehouseId ?? null,
        userId,
        pickMethod,
      });

      if (deductResult.success && !deductResult.noVariant) {
        // Deduction succeeded — check replen
        inventoryCtx.deducted = true;
        inventoryCtx.systemQtyAfter = deductResult.systemQtyAfter;
        inventoryCtx.locationId = deductResult.locationId;
        inventoryCtx.locationCode = deductResult.locationCode;

        if (deductResult.autoResolved) {
          inventoryCtx.resolution = {
            autoResolved: true,
            code: deductResult.autoResolved.code,
            reviewRequired: true,
            pickerBlocking: false,
            shipmentBlocking: false,
            message: deductResult.autoResolved.message,
          };

          this.recordInlineInventoryReview({
            item,
            order,
            productVariantId: deductResult.productVariantId,
            locationId: deductResult.locationId,
            locationCode: deductResult.locationCode,
            resolution: deductResult.autoResolved,
            userId,
            deviceType,
            sessionId,
          }).catch((err: any) =>
            console.warn("[Pick] failed to record inline inventory review:", err?.message || err),
          );
        }

        // Auto-execute replen in background — no picker confirmation needed.
        // Fire-and-forget: returns result to caller so UI can show dismissible notification.
        try {
          const replenResult = await this.replenishment.createAndExecuteReplen(
            deductResult.productVariantId,
            deductResult.locationId,
            userId,
            {
              orderId: item.orderId,
              orderItemId: item.id,
              orderNumber: order?.orderNumber ?? null,
              blocksShipment: false,
            },
          );

          if (replenResult) {
            const taskStatus = replenResult.task?.status ?? null;
            const moved = Number(replenResult.moved ?? 0);
            const autoExecuted = taskStatus === "completed";
            const movedForPickBin = autoExecuted
              ? await this.describeInlineReplenMove(replenResult.task, deductResult.productVariantId, moved)
              : null;
            console.log(
              `[Replen] Replen task for variant=${deductResult.productVariantId} loc=${deductResult.locationId}: ` +
              `status=${taskStatus ?? "none"} moved=${moved} base units`,
            );
            inventoryCtx.replen.triggered = true;
            inventoryCtx.replen.taskId = replenResult.task?.id ?? null;
            inventoryCtx.replen.taskStatus = taskStatus;
            inventoryCtx.replen.autoExecuted = autoExecuted;
            inventoryCtx.replen.autoExecutedMoved = movedForPickBin?.pickQty ?? null;
            inventoryCtx.replen.autoExecutedMovedBaseUnits = movedForPickBin?.baseUnits ?? null;
            inventoryCtx.replen.autoExecutedMovedUom = movedForPickBin?.uom ?? null;
            inventoryCtx.replen.autoExecutedFailed = taskStatus === "blocked";
            inventoryCtx.replen.autoExecuteFailReason = taskStatus === "blocked"
              ? replenResult.task?.exceptionReason || "blocked"
              : null;
            inventoryCtx.replen.qtyToMove = autoExecuted
              ? movedForPickBin?.pickQty ?? null
              : replenResult.task?.qtyTargetUnits ?? null;
            
            // Fix: The "Zero Collision"
            // If the bin hit zero, it initially flipped binCountNeeded to true.
            // But if auto-replenishment immediately refilled it inline, we MUST suppress the bin count,
            // otherwise the picker receives a redundant count prompt that overlaps and crashes replen!
            if (autoExecuted && (movedForPickBin?.pickQty ?? 0) > 0) {
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
        inventoryCtx.resolution = {
          autoResolved: false,
          code: deductResult.error,
          reviewRequired: true,
          pickerBlocking: deductResult.pickerBlocking ?? false,
          shipmentBlocking: deductResult.shipmentBlocking ?? true,
          message: deductResult.message,
        };
        if (inventoryCtx.resolution.shipmentBlocking) {
          forcePostPickStatus = "exception";
          await this.recordShipmentBlockingInventoryException({
            item,
            order,
            productVariantId: deductResult.productVariantId,
            locationId: deductResult.locationId,
            locationCode: deductResult.locationCode,
            systemQty: deductResult.systemQty,
            requestedQty: item.pickedQuantity || item.quantity,
            error: deductResult.error,
            message: deductResult.message,
            userId,
            deviceType,
            sessionId,
          });
        }

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
    const postPickStatus = forcePostPickStatus
      ?? await this.resolvePostPickStatusForOrder(item.orderId, settings.postPickStatus);
    await this.storage.updateOrderProgress(item.orderId, postPickStatus);

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

  private async queueShortPickReplen(params: {
    item: OrderItem;
    order: Order | undefined;
    warehouseLocationId?: number;
    userId?: string;
  }): Promise<{ result: { task: any; moved: number; guidance?: any }; location: WarehouseLocation } | null> {
    const { item, order, warehouseLocationId, userId } = params;
    if (!item.sku) return null;

    const variant = await this.storage.getProductVariantBySku(item.sku);
    if (!variant) return null;

    let pickLocation: WarehouseLocation | undefined;
    if (warehouseLocationId) {
      [pickLocation] = await this.db
        .select()
        .from(warehouseLocations)
        .where(eq(warehouseLocations.id, warehouseLocationId))
        .limit(1);
    } else {
      const locationCode = (item.location || "").trim().toUpperCase();
      if (!locationCode || locationCode === "U" || locationCode === "UNASSIGNED") {
        return null;
      }

      const locationWhere = order?.warehouseId
        ? and(
            sql`upper(${warehouseLocations.code}) = ${locationCode}`,
            eq(warehouseLocations.warehouseId, order.warehouseId),
          )
        : sql`upper(${warehouseLocations.code}) = ${locationCode}`;

      [pickLocation] = await this.db
        .select()
        .from(warehouseLocations)
        .where(locationWhere)
        .limit(1);
    }

    if (!pickLocation || pickLocation.isPickable !== 1) {
      return null;
    }

    const result = await this.replenishment.ensureQueuedReplenForShortPick(
      variant.id,
      pickLocation.id,
      userId,
      {
        orderId: item.orderId,
        orderItemId: item.id,
        orderNumber: order?.orderNumber ?? null,
        blocksShipment: false,
      },
    );

    return result ? { result, location: pickLocation } : null;
  }

  private async recordInlineInventoryReview(params: {
    item: OrderItem;
    order: Order | undefined;
    productVariantId: number;
    locationId: number;
    locationCode: string;
    resolution: ScanAutoResolvedInventory;
    userId?: string;
    deviceType?: string;
    sessionId?: string;
  }): Promise<void> {
    const [exception] = await this.db.insert(allocationExceptions).values({
      orderId: params.item.orderId,
      orderItemId: params.item.id,
      orderNumber: params.order?.orderNumber ?? null,
      sku: params.item.sku,
      productVariantId: params.productVariantId,
      exceptionType: "inventory_auto_resolved",
      status: "needs_review",
      requestedQty: params.resolution.pickedQty,
      selectedLocationId: params.locationId,
      selectedLocationCode: params.locationCode,
      resolution: "picker_scan_count_correction",
      autoFixedSetup: false,
      reviewReason: params.resolution.message,
      resolvedBy: params.userId || null,
      resolvedAt: new Date(),
      metadata: {
        pickerNonBlocking: true,
        shipmentBlocking: false,
        observation: "validated_item_scan",
        adjustment: params.resolution.adjustment,
        systemQtyBefore: params.resolution.systemQtyBefore,
        pickedQty: params.resolution.pickedQty,
        deviceType: params.deviceType || null,
        sessionId: params.sessionId || null,
      },
    }).returning();

    await this.storage.createPickingLog({
      actionType: "inventory_auto_resolved",
      pickerId: params.userId || undefined,
      orderId: params.item.orderId,
      orderNumber: params.order?.orderNumber,
      orderItemId: params.item.id,
      productId: params.item.productId,
      sku: params.item.sku,
      itemName: params.item.name,
      locationCode: params.locationCode,
      qtyRequested: params.resolution.pickedQty,
      qtyBefore: params.resolution.systemQtyBefore,
      qtyAfter: Math.max(0, params.resolution.systemQtyBefore + params.resolution.adjustment - params.resolution.pickedQty),
      qtyDelta: params.resolution.adjustment,
      reason: params.resolution.message,
      deviceType: params.deviceType || "desktop",
      sessionId: params.sessionId,
      pickMethod: "scan",
      itemStatusBefore: params.item.status,
      itemStatusAfter: params.item.status,
      metadata: {
        exceptionId: exception.id,
        pickerNonBlocking: true,
        shipmentBlocking: false,
      },
    });

    try {
      const { notify } = await import("../notifications/notifications.service");
      await notify("allocation_review_needed", {
        title: `Inventory review needed: ${params.item.sku}`,
        message: params.resolution.message,
        data: {
          orderId: params.item.orderId,
          orderNumber: params.order?.orderNumber,
          orderItemId: params.item.id,
          sku: params.item.sku,
          selectedLocationId: params.locationId,
          selectedLocationCode: params.locationCode,
          exceptionId: exception.id,
          pickerNonBlocking: true,
        },
      });
    } catch (notifyErr: any) {
      console.warn(`[Pick] inline inventory review notification failed: ${notifyErr.message}`);
    }
  }

  private async recordShipmentBlockingInventoryException(params: {
    item: OrderItem;
    order: Order | undefined;
    productVariantId: number;
    locationId: number | null;
    locationCode: string | null;
    systemQty: number;
    requestedQty: number;
    error: string;
    message: string;
    userId?: string;
    deviceType?: string;
    sessionId?: string;
  }): Promise<void> {
    const [exception] = await this.db.insert(allocationExceptions).values({
      orderId: params.item.orderId,
      orderItemId: params.item.id,
      orderNumber: params.order?.orderNumber ?? null,
      sku: params.item.sku,
      productVariantId: params.productVariantId,
      exceptionType: "inventory_deduction_failed",
      status: "blocked",
      requestedQty: params.requestedQty,
      selectedLocationId: params.locationId,
      selectedLocationCode: params.locationCode,
      resolution: null,
      autoFixedSetup: false,
      reviewReason: params.message,
      resolvedBy: null,
      resolvedAt: null,
      metadata: {
        pickerNonBlocking: true,
        shipmentBlocking: true,
        error: params.error,
        systemQty: params.systemQty,
        requestedQty: params.requestedQty,
        deviceType: params.deviceType || null,
        sessionId: params.sessionId || null,
        observedBy: params.userId || null,
      },
    }).returning();

    await this.storage.createPickingLog({
      actionType: "inventory_shipment_blocked",
      pickerId: params.userId || undefined,
      orderId: params.item.orderId,
      orderNumber: params.order?.orderNumber,
      orderItemId: params.item.id,
      productId: params.item.productId,
      sku: params.item.sku,
      itemName: params.item.name,
      locationCode: params.locationCode || params.item.location,
      qtyRequested: params.requestedQty,
      qtyBefore: params.systemQty,
      qtyAfter: params.systemQty,
      qtyDelta: 0,
      reason: params.message,
      deviceType: params.deviceType || "desktop",
      sessionId: params.sessionId,
      itemStatusBefore: params.item.status,
      itemStatusAfter: params.item.status,
      metadata: {
        exceptionId: exception.id,
        pickerNonBlocking: true,
        shipmentBlocking: true,
      },
    });
  }

  /** Internal: resolve pick location and deduct inventory via inventoryCore. */
  private async _deductInventory(
    item: OrderItem,
    beforeItem: OrderItem,
    opts: { warehouseLocationId?: number; warehouseId?: number | null; userId?: string; inventoryCore?: InventoryCore; pickMethod?: string },
  ): Promise<DeductInventoryResult> {
    const pickedQty = item.pickedQuantity || item.quantity;
    const productVariant = await this.storage.getProductVariantBySku(item.sku);
    if (!productVariant) {
      // No variant mapping — can't deduct, but this is non-fatal for non-inventory items
      return { success: true, noVariant: true, productVariantId: 0, locationId: 0, locationCode: null, systemQtyAfter: 0 };
    }

    console.log(`[Inventory] Picking ${pickedQty} x ${productVariant.sku} (${productVariant.unitsPerVariant} units each)`);

    const levels = await this.storage.getInventoryLevelsByProductVariantId(productVariant.id);
    const allLocations = await this.storage.getAllWarehouseLocations();
    const warehouseId = opts.warehouseId != null ? Number(opts.warehouseId) : null;
    const belongsToOrderWarehouse = (loc: WarehouseLocation | undefined): boolean => {
      if (!loc || warehouseId == null || loc.warehouseId == null) return true;
      return Number(loc.warehouseId) === warehouseId;
    };

    // Resolve assigned bin info for context (even if deduction fails)
    let assignedLocationId: number | null = null;
    let assignedLocationCode: string | null = null;
    if (item.location && item.location !== "UNASSIGNED") {
      const assignedCode = item.location.trim().toUpperCase();
      const assignedMatches = allLocations.filter(loc => loc.code?.toUpperCase() === assignedCode);
      const qtyAtLocation = (loc: WarehouseLocation | undefined): number => {
        if (!loc) return 0;
        const level = levels.find((l: any) => Number(l.warehouseLocationId) === Number(loc.id));
        return Number(level?.variantQty ?? 0);
      };
      const isActivePickableLocation = (loc: WarehouseLocation | undefined): boolean =>
        loc?.isPickable === 1 && loc?.isActive === 1 && !loc?.cycleCountFreezeId;
      const assignedLoc = warehouseId != null
        ? assignedMatches.find(loc => loc.warehouseId != null && Number(loc.warehouseId) === warehouseId)
          ?? assignedMatches.find(loc => loc.warehouseId == null)
        : assignedMatches.find(loc => isActivePickableLocation(loc) && qtyAtLocation(loc) > 0)
          ?? assignedMatches.find(loc => isActivePickableLocation(loc) && loc.locationType === "pick")
          ?? assignedMatches[0];
      if (assignedLoc) {
        assignedLocationId = assignedLoc.id;
        assignedLocationCode = assignedLoc.code;
      }
    }

    // Resolve pick location: explicit ID > assigned bin > auto-select only when
    // there is no picker-facing assignment. A valid item scan proves the SKU,
    // not that a different fallback bin was physically used.
    let pickLocationId: number | null = opts.warehouseLocationId ? Number(opts.warehouseLocationId) : null;
    let locationResolution: "explicit" | "assigned" | "fallback" | null = pickLocationId ? "explicit" : null;

    const pickablePriority: Record<string, number> = { pick: 0, pallet: 1 };
    const pickableLevels = levels
      .map((l: any) => {
        const loc = allLocations.find(loc => loc.id === l.warehouseLocationId);
        return { level: l, loc };
      })
      .filter(({ loc }) => loc?.isPickable === 1 && !loc.cycleCountFreezeId)
      .filter(({ loc }) => belongsToOrderWarehouse(loc))
      .sort((a, b) => (pickablePriority[a.loc?.locationType as string] ?? 99) - (pickablePriority[b.loc?.locationType as string] ?? 99));

    // Try the location already assigned to this order item.
    if (!pickLocationId && assignedLocationId) {
      pickLocationId = assignedLocationId;
      locationResolution = "assigned";
    }

    // Fallback: any pickable location with full qty, but only if the order line
    // did not already carry a picker-facing bin.
    if (!pickLocationId) {
      const fullMatch = pickableLevels.find(({ level: l }) => l.variantQty >= pickedQty);
      if (fullMatch) {
        pickLocationId = fullMatch.level.warehouseLocationId;
        locationResolution = "fallback";
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
        pickerBlocking: false,
        shipmentBlocking: true,
      };
    }

    const inventoryCore = opts.inventoryCore ?? this.inventoryCore;

    const pickLocation = allLocations.find(l => l.id === pickLocationId);
    if (!belongsToOrderWarehouse(pickLocation)) {
      return {
        success: false,
        error: "wrong_warehouse_location",
        message: `Bin ${pickLocation?.code || pickLocationId} belongs to warehouse ${pickLocation?.warehouseId}, not order warehouse ${warehouseId}`,
        productVariantId: productVariant.id,
        locationId: pickLocationId,
        locationCode: pickLocation?.code || assignedLocationCode,
        systemQty: 0,
        pickerBlocking: false,
        shipmentBlocking: true,
      };
    }
    const currentLevel = levels.find((l: any) => l.warehouseLocationId === pickLocationId);
    const systemQtyBeforePick = currentLevel?.variantQty ?? 0;
    let scanAutoResolved: ScanAutoResolvedInventory | undefined;

    if (systemQtyBeforePick < pickedQty) {
      const isScanVerified = opts.pickMethod === "scan";
      const canTrustLocation = locationResolution === "assigned" || locationResolution === "explicit";
      const locationIsPickerSafe =
        pickLocation?.isPickable === 1 &&
        pickLocation?.isActive === 1 &&
        !pickLocation?.cycleCountFreezeId;

      if (isScanVerified && canTrustLocation && locationIsPickerSafe) {
        const adjustment = pickedQty - systemQtyBeforePick;
        const locationCode = pickLocation?.code || assignedLocationCode || String(pickLocationId);
        const message =
          `Picker scan found ${pickedQty} ${productVariant.sku} at ${locationCode}; ` +
          `system had ${systemQtyBeforePick}. Added ${adjustment} before pick and queued review.`;

        await inventoryCore.adjustInventory({
          productVariantId: productVariant.id,
          warehouseLocationId: pickLocationId,
          qtyDelta: adjustment,
          reason: message,
          userId: opts.userId,
        });

        scanAutoResolved = {
          code: "picker_scan_bin_shortage",
          adjustment,
          systemQtyBefore: systemQtyBeforePick,
          pickedQty,
          message,
        };
      } else {
        const locationCode = pickLocation?.code || assignedLocationCode || null;
        return {
          success: false,
          error: "insufficient_inventory",
          message: `Bin ${locationCode || pickLocationId} has ${systemQtyBeforePick} for ${item.sku}, but ${pickedQty} is needed`,
          productVariantId: productVariant.id,
          locationId: pickLocationId,
          locationCode,
          systemQty: systemQtyBeforePick,
          pickerBlocking: false,
          shipmentBlocking: true,
        };
      }
    }

    const picked = await inventoryCore.pickItem({
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
        message: `Concurrent pick claimed stock for ${item.sku}`,
        productVariantId: productVariant.id,
        locationId: pickLocationId,
        locationCode: loc?.code || assignedLocationCode,
        systemQty: level?.variantQty ?? 0,
        pickerBlocking: false,
        shipmentBlocking: true,
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
      autoResolved: scanAutoResolved,
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
    if (!orderBefore) return null;

    const blockers = await this.getReadyToShipBlockers(orderId);
    if (blockers.length > 0) {
      throw new ValidationError(`Order cannot be marked ready to ship: ${blockers.join("; ")}`);
    }

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

  async closeResolvedShipmentBlockers(orderId: number, params: {
    resolution: string;
    userId?: string;
    notes?: string;
  }): Promise<CloseShipmentBlockersResult> {
    if (params.resolution === "hold") {
      return { allocationExceptionsClosed: 0, replenTasksClosed: 0 };
    }

    const closedStatus = params.resolution === "cancelled" ? "cancelled" : "resolved";
    const resolutionLabel = `order_exception_${params.resolution}`;
    const blockerNote = `Closed by order exception resolution '${params.resolution}'${params.userId ? ` by ${params.userId}` : ""}${params.notes ? `: ${params.notes}` : ""}`;

    const allocationResult = await this.db.execute(sql`
      UPDATE wms.allocation_exceptions
      SET
        status = ${closedStatus},
        resolution = ${resolutionLabel},
        resolved_by = ${params.userId ?? null},
        resolved_at = NOW(),
        updated_at = NOW()
      WHERE order_id = ${orderId}
        AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
        AND (
          status = 'blocked'
          OR COALESCE(metadata->>'shipmentBlocking', 'false') = 'true'
        )
      RETURNING id
    `);

    const replenResult = await this.db.execute(sql`
      UPDATE inventory.replen_tasks
      SET
        status = 'cancelled',
        blocks_shipment = FALSE,
        notes = CONCAT(COALESCE(notes, ''), CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE E'\n' END, ${blockerNote})
      WHERE order_id = ${orderId}
        AND blocks_shipment = TRUE
        AND status NOT IN ('completed', 'cancelled')
      RETURNING id
    `);

    return {
      allocationExceptionsClosed: allocationResult.rows?.length ?? 0,
      replenTasksClosed: replenResult.rows?.length ?? 0,
    };
  }

  private async resolvePostPickStatusForOrder(orderId: number, desiredStatus: string): Promise<string> {
    if (desiredStatus !== "ready_to_ship") return desiredStatus;
    const blockers = await this.getReadyToShipBlockers(orderId);
    return blockers.length > 0 ? "exception" : desiredStatus;
  }

  private async getReadyToShipBlockers(orderId: number): Promise<string[]> {
    const blockers: string[] = [];
    const items = await this.storage.getOrderItems(orderId);
    const shippableItems = items.filter(item => item.requiresShipping === 1);

    if (shippableItems.length === 0) {
      blockers.push("order has no shippable items");
    }

    for (const item of shippableItems) {
      if (item.status === "short") {
        blockers.push(`${item.sku} is short-picked`);
        continue;
      }
      if (item.status !== "completed") {
        blockers.push(`${item.sku} is ${item.status}`);
      }
      if ((item.pickedQuantity || 0) !== item.quantity) {
        blockers.push(`${item.sku} picked ${item.pickedQuantity || 0}/${item.quantity}`);
      }
      if (!item.location || item.location === "UNASSIGNED") {
        blockers.push(`${item.sku} has no pick bin`);
      }
    }

    const exceptionRows = await this.db.execute(sql`
      SELECT id, sku, exception_type, status, review_reason
      FROM wms.allocation_exceptions
      WHERE order_id = ${orderId}
        AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
        AND (
          status = 'blocked'
          OR COALESCE(metadata->>'shipmentBlocking', 'false') = 'true'
        )
      ORDER BY created_at DESC
    `);

    for (const row of exceptionRows.rows ?? []) {
      blockers.push(
        `${row.sku || "item"} has ${row.exception_type || "exception"} #${row.id}: ${row.review_reason || row.status}`,
      );
    }

    const replenRows = await this.db.execute(sql`
      SELECT
        rt.id,
        rt.status,
        rt.exception_reason,
        rt.notes,
        pv.sku
      FROM inventory.replen_tasks rt
      LEFT JOIN catalog.product_variants pv
        ON pv.id = rt.pick_product_variant_id
      WHERE rt.order_id = ${orderId}
        AND rt.blocks_shipment = TRUE
        AND rt.status NOT IN ('completed', 'cancelled')
      ORDER BY rt.created_at DESC
    `);

    for (const row of replenRows.rows ?? []) {
      blockers.push(
        `${row.sku || "item"} has replen task #${row.id}: ${row.exception_reason || row.status}`,
      );
    }

    return blockers;
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

    return { success: true, systemQtyBefore: systemQty, actualBinQty, adjustment, replenTriggered: false, replenTaskStatus: null, replenFailReason: null, inferredReplen: false, inferredReplenMoved: null };
  }

  // -------------------------------------------------------------------------
  // 7b. CONSOLIDATED BIN COUNT
  // -------------------------------------------------------------------------

  /**
   * Reconciles a picker-entered bin count.
   * Picker input is evidence, not replen authority: this method never creates,
   * executes, or cancels replen tasks based only on a picker yes/no answer.
   */
  async handleBinCount(params: {
    sku: string;
    locationId: number;
    binCount: number;
    didReplen: boolean;
    replenAlreadyRecorded?: boolean;
    userId?: string;
  }): Promise<BinCountResult> {
    const { sku, locationId, binCount, didReplen, replenAlreadyRecorded = false, userId } = params;

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

    const replenResult: any = didReplen && replenAlreadyRecorded
      ? { task: null, moved: null, alreadyRecorded: true }
      : null;

    if (didReplen && replenAlreadyRecorded) {
      console.log(`[BinCount] verifying already-recorded replen for ${sku} at location ${locationId}`);
    } else if (didReplen) {
      console.log(`[BinCount] picker reported replen for ${sku} at location ${locationId}; recording count only`);
    }

    // Step 1: Re-read current system qty. Any replen movement must already be system-recorded.
    const level = await this.inventoryCore.getLevel(variant.id, locationId);
    const systemQty = level?.variantQty ?? 0;

    // Step 2: Reconcile the entered count. Any surplus becomes a count/review
    // signal; this path does not infer or post replen movements.
    const postLevel = level;
    const postSystemQty = systemQty;
    const adjustment = binCount - postSystemQty;

    if (adjustment !== 0 && postLevel) {
      // Use adjustInventory for bin count corrections — handles sync triggers,
      // audit trail, negative guards, and lot tracking automatically
      const reason = didReplen
        ? `Bin count after picker-reported replen: system=${postSystemQty}, actual=${binCount}, adjustment=${adjustment}, replen moved=${replenResult?.alreadyRecorded ? 'already_recorded' : 'not_system_recorded'}`
        : `Bin count: system=${postSystemQty}, actual=${binCount}, adjustment=${adjustment}`;

      await this.inventoryCore.adjustInventory({
        productVariantId: variant.id,
        warehouseLocationId: locationId,
        qtyDelta: adjustment,
        reason,
        userId: userId || undefined,
      });

      // If positive adjustment (more stock than expected), an unrecorded case
      // break may have occurred. Notify leads to verify source bins.
      if (adjustment > 0) {
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
        referenceType: didReplen ? "picker_bin_count_reported_replen" : "picker_bin_count",
        referenceId: `${sku}:${locationId}`,
        notes: `Bin count verified: system=${postSystemQty}, actual=${binCount} (match)${didReplen ? `, replen moved=${replenResult?.alreadyRecorded ? 'already_recorded' : 'not_system_recorded'}` : ''}`,
        userId: userId || null,
      });
    }

    return {
      success: true,
      systemQtyBefore: systemQty,
      actualBinQty: binCount,
      adjustment,
      replenTriggered: !!replenResult,
      replenTaskStatus: replenResult?.alreadyRecorded ? "completed" : null,
      replenFailReason: null,
      inferredReplen: false,
      inferredReplenMoved: null,
    };
  }

  // -------------------------------------------------------------------------
  // 8. confirmReplen — simplified picker replen confirmation
  // -------------------------------------------------------------------------

  /**
   * Called after auto-replen executes. The picker taps:
   *   confirmed = true  → log it as verified, done
   *   confirmed = false -> notify leads (flag for cycle count)
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
      // Picker flagged issue; replen task lifecycle remains system/review-owned.
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
    const pendingReplenItems = filteredOrders.flatMap((order: any) =>
      (order.items ?? [])
        .filter((item: any) => item.sku && item.requiresShipping === 1 && item.status === "pending")
        .map((item: any) => ({
          id: item.id,
          sku: item.sku,
          quantity: item.quantity,
          location: item.location,
        })),
    );
    const replenPredictionMap = await this._buildReplenPredictions(pendingReplenItems, freshLocationMap);

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
          const prediction = replenPredictionMap.get(item.id);
          if (prediction) {
            updatedItem.replenPrediction = {
              systemQty: prediction.systemQty,
              postPickQty: prediction.postPickQty,
              triggerValue: prediction.triggerValue,
              replenNeeded: prediction.replenNeeded,
              replenMethod: prediction.replenMethod,
              autoReplen: prediction.autoReplen,
              sourceLocationCode: prediction.replenNeeded ? prediction.sourceLocationCode : null,
              sourceQty: prediction.replenNeeded ? prediction.sourceQty : 0,
              sourceVariantName: prediction.replenNeeded ? prediction.sourceVariantName : null,
              existingTaskId: prediction.existingTaskId ?? null,
              existingTaskStatus: prediction.existingTaskStatus ?? null,
              existingTaskExecutionMode: prediction.existingTaskExecutionMode ?? null,
              existingTaskBlocksShipment: prediction.existingTaskBlocksShipment === true,
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

  /** Build replen predictions for pending items. Non-fatal: returns empty map on failure. */
  private async _buildReplenPredictions(
    items: Array<{ id: number; sku: string; quantity: number; location?: string | null }>,
    freshLocationMap: Map<string, { location: string; zone: string; barcode: string | null; imageUrl: string | null }>,
  ): Promise<Map<number, any>> {
    const map = new Map<number, any>();
    try {
      const allLocs = await this.storage.getAllWarehouseLocations();
      const locByCode = new Map(allLocs.map(loc => [loc.code, loc]));

      for (const item of items) {
        if (!item.sku) continue;

        const variant = await this.storage.getProductVariantBySku(item.sku);
        if (!variant) continue;

        const locationCode = freshLocationMap.get(item.sku)?.location ?? item.location ?? null;
        if (!locationCode || locationCode === "UNASSIGNED" || locationCode === "U") continue;

        const location = locByCode.get(locationCode);
        if (!location) continue;

        const prediction = await this.replenishment.predictReplenAfterPick(
          variant.id,
          location.id,
          Number(item.quantity ?? 0),
        );
        if (prediction) map.set(item.id, prediction);
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
