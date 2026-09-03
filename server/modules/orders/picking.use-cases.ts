import { createHash } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { IntegrityError, NotFoundError, ValidationError } from "../../../shared/errors";
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
import {
  ensurePackPlan,
  isWmsCartonizationShadowEnabled,
} from "../cartonization";
import {
  persistWmsOrderItemPickProgress,
  setWmsOrderItemLocation,
} from "../wms/order-item-commands";
import type {
  CanonicalClaimCursor,
  InventoryAvailabilityRuntimeClaimContext,
  InventoryAvailabilityRuntimeClaimExecutor,
} from "../inventory-planning/application/inventory-availability-runtime-claim.service";
import { canonicalJson } from "@shared/utils/canonical-json";

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
  unpickItem?: (params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId?: number;
    userId?: string;
    reason?: string;
  }) => Promise<boolean>;
  withTx?: (tx: any) => InventoryCore;
};

type ReplenishmentService = {
  checkAndTriggerAfterPick: (productVariantId: number, warehouseLocationId: number, triggeredBy?: string, context?: ReplenOrderContext) => Promise<any>;
  checkReplenNeeded: (productVariantId: number, warehouseLocationId: number, options?: { forceWhenAtOrBelowZero?: boolean; currentQtyOverride?: number }) => Promise<{ needed: boolean; stockout: boolean; sourceLocationCode: string | null; sourceVariantSku: string | null; sourceVariantName: string | null; qtyTargetUnits: number; [key: string]: any }>;
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
  forceWhenAtOrBelowZero?: boolean;
  triggeredBy?: string;
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

export type UnpickItemResult =
  | { success: true; item: OrderItem; inventory: PickInventoryContext }
  | { success: false; error: string; message: string };

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

type InventoryAutoResolved = {
  code: "picker_scan_bin_shortage" | "picker_confirmed_bin_shortage";
  adjustment: number;
  systemQtyBefore: number;
  pickedQty: number;
  message: string;
};

type PrePickReplenResult = {
  task: any;
  moved: number;
};

type DeductInventoryResult =
  | {
      success: true;
      noVariant?: undefined;
      productVariantId: number;
      locationId: number;
      locationCode: string;
      systemQtyAfter: number;
      autoResolved?: InventoryAutoResolved;
      prePickReplen?: PrePickReplenResult;
      authority?: "legacy" | "canonical";
      reviewRecorded?: boolean;
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

type CompletedPickAtomicResult = {
  item: OrderItem;
  deductResult: DeductInventoryResult | null;
  alreadyCompleted: boolean;
};

type CanonicalPickTarget = {
  productVariantId: number;
  locationId: number;
  locationCode: string;
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

type BlockingAllocationExceptionInput = {
  item: OrderItem;
  order?: Order;
  productVariantId: number | null;
  exceptionType: string;
  requestedQty: number;
  selectedLocationId?: number | null;
  selectedLocationCode?: string | null;
  reviewReason: string;
  metadata?: Record<string, any>;
};

type BlockingAllocationExceptionResult = {
  exception: any;
  created: boolean;
};

export type PickQueueOrder = any; // Pass-through type from storage

/**
 * The pickable bin holding the most stock, for the no-bin failure report.
 * Ties keep the caller's order (pickable levels arrive sorted pick > pallet).
 * Returns null when no pickable bin has any stock.
 */
function findBestStockedPickableLevel<T extends { level: { variantQty: number }; loc?: WarehouseLocation }>(
  candidates: readonly T[],
): (T & { loc: WarehouseLocation }) | null {
  let best: (T & { loc: WarehouseLocation }) | null = null;
  for (const candidate of candidates) {
    if (!candidate.loc) continue;
    const qty = Number(candidate.level.variantQty ?? 0);
    if (qty <= 0) continue;
    if (!best || qty > Number(best.level.variantQty ?? 0)) {
      best = candidate as T & { loc: WarehouseLocation };
    }
  }
  return best;
}

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

function canonicalPickerActor(userId?: string): string {
  const actor = String(userId ?? "").trim();
  return actor || "system:inventory-picker-runtime";
}

function canonicalPickerCommandKey(
  operation: string,
  evidence: Readonly<Record<string, unknown>>,
): string {
  const digest = createHash("sha256")
    .update(canonicalJson({ operation, evidence }), "utf8")
    .digest("hex");
  return `inventory-picker-runtime:${operation}:${digest}`;
}

function structuredErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface ChannelSyncLike {
  queueSyncAfterInventoryChange(variantId: number): Promise<void>;
}

interface CartonizationLike {
  ensurePackPlan(request: { wmsOrderId: number }): Promise<{ complete: boolean } | null>;
}

const PACKING_HANDOFF_STATUSES = new Set(["ready_to_ship", "picked", "staged"]);

export class PickingUseCases {
  constructor(
    private readonly db: DrizzleDb,
    private readonly inventoryCore: InventoryCore,
    private readonly replenishment: ReplenishmentService,
    private readonly storage: Storage,
    private readonly channelSync?: ChannelSyncLike,
    private readonly cartonization?: CartonizationLike,
    private readonly cartonizationShadowEnabled = false,
    private readonly runtimeClaimExecutor?: InventoryAvailabilityRuntimeClaimExecutor,
  ) {}

  private async logRejectedPickCommand(params: {
    beforeItem: OrderItem;
    order?: Order;
    status: string;
    pickedQuantity?: number;
    shortReason?: string;
    pickMethod?: string;
    userId?: string;
    deviceType?: string;
    sessionId?: string;
    rejectionCode: string;
    message: string;
  }): Promise<void> {
    const currentPickedQuantity = params.beforeItem.pickedQuantity || 0;
    const actorId = params.userId || params.order?.assignedPickerId || undefined;

    try {
      const actor = actorId ? await this.storage.getUser(actorId) : null;

      await this.storage.createPickingLog({
        actionType: "pick_command_rejected",
        pickerId: actorId,
        pickerName: actor?.displayName || actor?.username || actorId,
        pickerRole: actor?.role,
        orderId: params.beforeItem.orderId,
        orderNumber: params.order?.orderNumber,
        orderItemId: params.beforeItem.id,
        productId: params.beforeItem.productId,
        sku: params.beforeItem.sku,
        itemName: params.beforeItem.name,
        locationCode: params.beforeItem.location,
        qtyRequested: params.beforeItem.quantity,
        qtyBefore: currentPickedQuantity,
        qtyAfter: currentPickedQuantity,
        qtyDelta: 0,
        reason: params.rejectionCode,
        notes: params.message,
        deviceType: params.deviceType || "desktop",
        sessionId: params.sessionId,
        pickMethod: params.pickMethod || "manual",
        itemStatusBefore: params.beforeItem.status,
        itemStatusAfter: params.beforeItem.status,
        metadata: {
          requested: {
            status: params.status,
            pickedQuantity: params.pickedQuantity ?? null,
            shortReason: params.shortReason ?? null,
            pickMethod: params.pickMethod ?? null,
          },
          before: {
            status: params.beforeItem.status,
            pickedQuantity: currentPickedQuantity,
            quantity: params.beforeItem.quantity,
            shortReason: params.beforeItem.shortReason ?? null,
          },
          rejectionCode: params.rejectionCode,
          message: params.message,
          commandUserId: params.userId ?? null,
        },
      });
    } catch (error: any) {
      console.warn(`[Pick] failed to log rejected pick command for item ${params.beforeItem.id}: ${error?.message || error}`);
    }
  }

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

  private isOpenBlockerUniqueViolation(error: any): boolean {
    return error?.code === "23505"
      && String(error?.constraint || error?.detail || error?.message || "").includes("allocation_exceptions_one_open_blocker_per_item_idx");
  }

  private readJsonb(value: any): Record<string, any> {
    if (!value) return {};
    if (typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  }

  private async findCurrentBlockingAllocationException(orderItemId: number): Promise<any | null> {
    const result = await this.db.execute(sql`
      SELECT *
      FROM wms.allocation_exceptions
      WHERE order_item_id = ${orderItemId}
        AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
        AND (
          status = 'blocked'
          OR LOWER(COALESCE(metadata->>'shipmentBlocking', 'false')) = 'true'
        )
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
    return result.rows?.[0] ?? null;
  }

  private async createBlockingAllocationException(
    params: BlockingAllocationExceptionInput,
  ): Promise<BlockingAllocationExceptionResult> {
    const now = new Date();
    const metadata = {
      ...(params.metadata ?? {}),
      shipmentBlocking: true,
    };
    const selectedLocationId = params.selectedLocationId ?? null;
    const selectedLocationCode = params.selectedLocationCode ?? null;

    try {
      return await this.db.transaction(async (tx) => {
        const exactResult = await tx.execute(sql`
          SELECT id, metadata
          FROM wms.allocation_exceptions
          WHERE order_item_id = ${params.item.id}
            AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
            AND (
              status = 'blocked'
              OR LOWER(COALESCE(metadata->>'shipmentBlocking', 'false')) = 'true'
            )
            AND exception_type = ${params.exceptionType}
            AND COALESCE(selected_location_id, -1) = COALESCE(${selectedLocationId}::integer, -1)
            AND COALESCE(selected_location_code, '') = COALESCE(${selectedLocationCode}::text, '')
            AND COALESCE(review_reason, '') = ${params.reviewReason}::text
          ORDER BY created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE
        `);

        const exact = exactResult.rows?.[0];
        if (exact) {
          const mergedMetadata = {
            ...this.readJsonb(exact.metadata),
            ...metadata,
            duplicateObservedAt: now.toISOString(),
          };
          const updated = await tx.execute(sql`
            UPDATE wms.allocation_exceptions
            SET
              requested_qty = ${params.requestedQty},
              metadata = ${JSON.stringify(mergedMetadata)}::jsonb,
              updated_at = ${now}
            WHERE id = ${Number(exact.id)}
            RETURNING *
          `);
          return { exception: updated.rows?.[0] ?? exact, created: false };
        }

        await tx.execute(sql`
          UPDATE wms.allocation_exceptions
          SET
            status = 'cancelled',
            resolution = 'superseded_by_new_blocker',
            resolved_at = ${now},
            updated_at = ${now},
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'supersededBy', 'newer_blocking_exception',
              'supersededAt', ${now}::timestamptz,
              'supersededExceptionType', ${params.exceptionType}::text
            )
          WHERE order_item_id = ${params.item.id}
            AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
            AND (
              status = 'blocked'
              OR LOWER(COALESCE(metadata->>'shipmentBlocking', 'false')) = 'true'
            )
        `);

        const [exception] = await tx.insert(allocationExceptions).values({
          orderId: params.item.orderId,
          orderItemId: params.item.id,
          orderNumber: params.order?.orderNumber ?? null,
          sku: params.item.sku,
          productVariantId: params.productVariantId,
          exceptionType: params.exceptionType,
          status: "blocked",
          requestedQty: params.requestedQty,
          selectedLocationId,
          selectedLocationCode,
          resolution: null,
          autoFixedSetup: false,
          reviewReason: params.reviewReason,
          resolvedBy: null,
          resolvedAt: null,
          metadata,
        }).returning();

        return { exception, created: true };
      });
    } catch (error: any) {
      if (this.isOpenBlockerUniqueViolation(error)) {
        const existing = await this.findCurrentBlockingAllocationException(params.item.id);
        if (existing) return { exception: existing, created: false };
      }
      throw error;
    }
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
      const result = await this.createBlockingAllocationException({
        item,
        order,
        productVariantId: variant?.id ?? null,
        exceptionType,
        requestedQty,
        selectedLocationId: metadata.selectedLocationId ?? null,
        selectedLocationCode: metadata.selectedLocationCode ?? null,
        reviewReason: message,
        metadata: {
          ...metadata,
          locationCode: typedCode || null,
          warehouseLocationId: params.warehouseLocationId ?? null,
        },
      });

      if (result.created) {
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
              exceptionId: result.exception.id,
            },
          });
        } catch (notifyErr: any) {
          console.warn(`[Allocation] blocked notification failed: ${notifyErr.message}`);
        }
      }

      return result.exception;
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

      const updatedItem = await setWmsOrderItemLocation(tx, {
        itemId: item.id,
        location: location.code,
        zone,
      });

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

  private async completeLegacyPickTransaction(
    tx: any,
    input: {
      itemId: number;
      beforeItem: OrderItem;
      status: ItemStatus;
      effectivePickedQuantity: number;
      shortReason?: string;
      warehouseLocationId?: number;
      warehouseId?: number | null;
      userId?: string;
      pickMethod?: string;
      inventoryCore: InventoryCore;
    },
  ): Promise<CompletedPickAtomicResult> {
    const lockedOrder = await tx.execute(sql`
      SELECT warehouse_status, on_hold
      FROM wms.orders
      WHERE id = ${input.beforeItem.orderId}
      FOR UPDATE
    `);
    if (!lockedOrder.rows?.length) {
      throw new IntegrityError(`Order ${input.beforeItem.orderId} not found`);
    }
    const orderState = lockedOrder.rows[0];
    if (["cancelled", "shipped"].includes(orderState.warehouse_status)) {
      throw new IntegrityError(
        `Cannot pick item ${input.itemId}: order ${input.beforeItem.orderId} is ${orderState.warehouse_status}`,
      );
    }
    if (Number(orderState.on_hold) === 1) {
      throw new IntegrityError(
        `Cannot pick item ${input.itemId}: order ${input.beforeItem.orderId} is on hold`,
        { reason: "order_on_hold", orderId: input.beforeItem.orderId, orderItemId: input.itemId },
      );
    }

    const locked = await tx.execute(sql`
      SELECT status, picked_quantity, quantity
      FROM wms.order_items
      WHERE id = ${input.itemId}
      FOR UPDATE
    `);
    if (!locked.rows?.length) throw new IntegrityError(`Item ${input.itemId} not found`);
    const lockedPickedQuantity = Number(locked.rows[0].picked_quantity ?? 0);
    const lockedQuantity = Number(locked.rows[0].quantity ?? 0);
    if (locked.rows[0].status === "completed"
      || (lockedQuantity > 0 && lockedPickedQuantity >= lockedQuantity)) {
      return { item: input.beforeItem, deductResult: null, alreadyCompleted: true };
    }

    const provisionalItem = {
      ...input.beforeItem,
      status: "completed",
      pickedQuantity: input.effectivePickedQuantity,
      shortReason: input.shortReason ?? input.beforeItem.shortReason,
    } as OrderItem;
    const deductResult = await this._deductInventory(provisionalItem, input.beforeItem, {
      warehouseLocationId: input.warehouseLocationId,
      warehouseId: input.warehouseId,
      userId: input.userId,
      inventoryCore: input.inventoryCore,
      pickMethod: input.pickMethod,
    });

    if (deductResult.success && !deductResult.noVariant) {
      await this.backfillPlannedShipmentItemPickLocation(tx, {
        orderItemId: input.itemId,
        productVariantId: deductResult.productVariantId,
        locationId: deductResult.locationId,
      });
    }
    const updatedItem = await persistWmsOrderItemPickProgress(tx, {
      itemId: input.itemId,
      status: deductResult.success ? input.status : input.beforeItem.status as ItemStatus,
      pickedQuantity: deductResult.success ? input.effectivePickedQuantity : undefined,
      shortReason: deductResult.success && input.shortReason !== undefined ? input.shortReason : undefined,
      pickedAt: deductResult.success ? new Date() : input.beforeItem.pickedAt,
    });
    if (!updatedItem) throw new IntegrityError(`Item ${input.itemId} not found`);
    return { item: updatedItem as OrderItem, deductResult, alreadyCompleted: false };
  }

  private async persistNonInventoryPickProgress(input: {
    itemId: number;
    beforeItem: OrderItem;
    effectivePickedQuantity: number;
    shortReason?: string;
  }): Promise<CompletedPickAtomicResult> {
    return this.db.transaction(async (tx: any) => {
      const lockedOrder = await tx.execute(sql`
        SELECT warehouse_status, on_hold
        FROM wms.orders
        WHERE id = ${input.beforeItem.orderId}
        FOR UPDATE
      `);
      if (!lockedOrder.rows?.length) {
        throw new IntegrityError(`Order ${input.beforeItem.orderId} not found`);
      }
      const orderState = lockedOrder.rows[0];
      if (["cancelled", "shipped"].includes(orderState.warehouse_status)) {
        throw new IntegrityError(
          `Cannot pick item ${input.itemId}: order ${input.beforeItem.orderId} is ${orderState.warehouse_status}`,
        );
      }
      if (Number(orderState.on_hold) === 1) {
        throw new IntegrityError(
          `Cannot pick item ${input.itemId}: order ${input.beforeItem.orderId} is on hold`,
          { reason: "order_on_hold", orderId: input.beforeItem.orderId, orderItemId: input.itemId },
        );
      }

      const locked = await tx.execute(sql`
        SELECT status
        FROM wms.order_items
        WHERE id = ${input.itemId}
        FOR UPDATE
      `);
      if (!locked.rows?.length) throw new IntegrityError(`Item ${input.itemId} not found`);
      if (locked.rows[0].status === "completed") {
        return { item: input.beforeItem, deductResult: null, alreadyCompleted: true };
      }
      const updatedItem = await persistWmsOrderItemPickProgress(tx, {
        itemId: input.itemId,
        status: "completed",
        pickedQuantity: input.effectivePickedQuantity,
        shortReason: input.shortReason,
        pickedAt: new Date(),
      });
      if (!updatedItem) throw new IntegrityError(`Item ${input.itemId} not found`);
      return {
        item: updatedItem as OrderItem,
        deductResult: {
          success: true,
          noVariant: true,
          productVariantId: 0,
          locationId: 0,
          locationCode: null,
          systemQtyAfter: 0,
        },
        alreadyCompleted: false,
      };
    });
  }

  private async resolveCanonicalPickTarget(
    item: OrderItem,
    pickedQty: number,
    options: { warehouseLocationId?: number; warehouseId?: number | null },
  ): Promise<{ target: CanonicalPickTarget | null; nonInventory: boolean }> {
    const productVariant = await this.storage.getProductVariantBySku(item.sku);
    if (!productVariant?.id) {
      if (item.requiresShipping === 1) {
        throw new IntegrityError(`Tracked picker SKU ${item.sku} has no active catalog variant`, {
          reason: "canonical_picker_variant_missing",
          orderId: item.orderId,
          orderItemId: item.id,
          sku: item.sku,
        });
      }
      return { target: null, nonInventory: true };
    }
    if (productVariant.requiresShipping === false
      || productVariant.trackInventory === false) {
      return { target: null, nonInventory: true };
    }

    const levels = await this.storage.getInventoryLevelsByProductVariantId(productVariant.id);
    const allLocations = await this.storage.getAllWarehouseLocations();
    const warehouseId = options.warehouseId == null ? null : Number(options.warehouseId);
    const inOrderWarehouse = (location: WarehouseLocation | undefined): boolean =>
      Boolean(location)
      && (warehouseId == null
        || location!.warehouseId == null
        || Number(location!.warehouseId) === warehouseId);
    const isAvailablePickLocation = (location: WarehouseLocation | undefined): boolean =>
      Boolean(location)
      && location!.isPickable === 1
      && location!.isActive === 1
      && !location!.cycleCountFreezeId
      && inOrderWarehouse(location);

    let location: WarehouseLocation | undefined;
    if (options.warehouseLocationId != null) {
      location = allLocations.find((candidate) => candidate.id === Number(options.warehouseLocationId));
    } else if (item.location && !["U", "UNASSIGNED"].includes(item.location.trim().toUpperCase())) {
      const code = item.location.trim().toUpperCase();
      const matches = allLocations.filter((candidate) => candidate.code?.trim().toUpperCase() === code);
      location = warehouseId == null
        ? matches.find(isAvailablePickLocation) ?? matches[0]
        : matches.find((candidate) => candidate.warehouseId != null
          && Number(candidate.warehouseId) === warehouseId)
          ?? matches.find((candidate) => candidate.warehouseId == null);
    } else {
      const priority: Record<string, number> = { pick: 0, pallet: 1 };
      location = levels
        .map((level: any) => ({
          level,
          location: allLocations.find((candidate) => candidate.id === Number(level.warehouseLocationId)),
        }))
        .filter((candidate) => isAvailablePickLocation(candidate.location))
        .filter((candidate) => Number(candidate.level.variantQty ?? 0) >= pickedQty)
        .sort((left, right) =>
          (priority[left.location?.locationType as string] ?? 99)
          - (priority[right.location?.locationType as string] ?? 99))[0]?.location;
    }

    if (!location) {
      throw new IntegrityError(`No pick location is available for ${item.sku}`, {
        reason: "pick_location_missing",
        orderId: item.orderId,
        orderItemId: item.id,
      });
    }
    if (!isAvailablePickLocation(location)) {
      throw new IntegrityError(`Bin ${location.code || location.id} is not an active pickable location for this order`, {
        reason: "pick_location_unavailable",
        orderId: item.orderId,
        orderItemId: item.id,
        warehouseLocationId: location.id,
      });
    }
    return {
      nonInventory: false,
      target: {
        productVariantId: Number(productVariant.id),
        locationId: location.id,
        locationCode: location.code,
      },
    };
  }

  private async completeCanonicalPick(
    context: InventoryAvailabilityRuntimeClaimContext,
    input: {
      itemId: number;
      beforeItem: OrderItem;
      effectivePickedQuantity: number;
      shortReason?: string;
      warehouseLocationId?: number;
      warehouseId?: number | null;
      userId?: string;
      deviceType?: string;
      sessionId?: string;
      pickMethod?: string;
    },
  ): Promise<CompletedPickAtomicResult> {
    const resolved = await this.resolveCanonicalPickTarget(
      input.beforeItem,
      input.effectivePickedQuantity,
      { warehouseLocationId: input.warehouseLocationId, warehouseId: input.warehouseId },
    );
    if (resolved.nonInventory) {
      return this.persistNonInventoryPickProgress(input);
    }
    const target = resolved.target!;
    const claim = await context.getLatestClaim(input.beforeItem.orderId);
    if (!claim || claim.status !== "active") {
      throw new IntegrityError("The order has no active canonical availability claim to pick", {
        reason: "active_canonical_claim_missing",
        orderId: input.beforeItem.orderId,
        orderItemId: input.itemId,
      });
    }
    if (!context.getClaimLinePickMovementCursor) {
      throw new IntegrityError("Canonical claim pick-movement cursor lookup is not configured", {
        reason: "canonical_pick_movement_cursor_lookup_missing",
        orderId: input.beforeItem.orderId,
        orderItemId: input.itemId,
      });
    }
    const pickMovementCursor = await context.getClaimLinePickMovementCursor(claim.claimId, input.itemId);

    const actor = canonicalPickerActor(input.userId);
    const reason = `Picker completed order item ${input.itemId} from ${target.locationCode}`;
    const wmsProgress = {
      expectedStatus: input.beforeItem.status as "pending" | "in_progress" | "short",
      expectedPickedQuantity: Number(input.beforeItem.pickedQuantity ?? 0),
      targetStatus: "completed" as const,
      targetPickedQuantity: input.effectivePickedQuantity,
    };
    const baseEvidence = {
      claimId: claim.claimId,
      orderId: input.beforeItem.orderId,
      orderItemId: input.itemId,
      warehouseLocationId: target.locationId,
      quantity: input.effectivePickedQuantity,
      actor,
      wmsProgress,
      pickMovementCursor,
    };
    const run = (locationStrategy: "strict" | "reconcile_recorded_stock" | "reconcile_picker_observation") =>
      context.canonical.pickClaimLine({
        claimId: claim.claimId,
        orderItemId: input.itemId,
        warehouseLocationId: target.locationId,
        quantity: String(input.effectivePickedQuantity),
        locationStrategy,
        ...(locationStrategy === "reconcile_picker_observation" ? {
          observation: {
            kind: input.pickMethod === "scan"
              ? "validated_item_scan" as const
              : "picker_confirmed_physical_stock" as const,
            observedPhysicalQty: String(input.effectivePickedQuantity),
            locationCode: target.locationCode,
            ...(input.deviceType ? { deviceType: input.deviceType } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          },
        } : {}),
        wmsProgress,
        idempotencyKey: canonicalPickerCommandKey(`pick-${locationStrategy}`, baseEvidence),
        actor,
        reason,
      });

    let canonicalResult;
    try {
      canonicalResult = await run("strict");
    } catch (strictError) {
      if (structuredErrorCode(strictError) !== "CLAIM_PICK_LOCATION_SHORTFALL") throw strictError;
      try {
        canonicalResult = await run("reconcile_recorded_stock");
      } catch (recordedError) {
        const observationEligibleCodes = new Set([
          "CLAIM_PICK_LOCATION_INVENTORY_MISSING",
          "CLAIM_RESOURCE_CONFLICT",
          "CLAIM_LOT_SHORTFALL",
          "CLAIM_LEVEL_CONFLICT",
          "CLAIM_LOT_CONFLICT",
        ]);
        if (!observationEligibleCodes.has(structuredErrorCode(recordedError) ?? "")) throw recordedError;
        canonicalResult = await run("reconcile_picker_observation");
      }
    }

    const item = await this.storage.getOrderItemById(input.itemId);
    if (!item || item.status !== "completed" || item.pickedQuantity !== input.effectivePickedQuantity) {
      throw new IntegrityError("Canonical pick committed but its WMS progress projection could not be verified", {
        reason: "canonical_wms_pick_readback_failed",
        orderId: input.beforeItem.orderId,
        orderItemId: input.itemId,
      });
    }
    const updatedLevel = await this.inventoryCore.getLevel(target.productVariantId, target.locationId);
    const systemQtyAfter = Number(updatedLevel?.variantQty ?? 0);
    const observedRelocated = canonicalResult.outcome === "picked_with_observation"
      ? Number(canonicalResult.observedRelocatedQuantity)
      : 0;
    return {
      item,
      alreadyCompleted: false,
      deductResult: {
        success: true,
        productVariantId: target.productVariantId,
        locationId: target.locationId,
        locationCode: target.locationCode,
        systemQtyAfter,
        authority: "canonical",
        reviewRecorded: canonicalResult.outcome === "picked_with_observation",
        ...(canonicalResult.outcome === "picked_with_observation" ? {
          autoResolved: {
            code: input.pickMethod === "scan"
              ? "picker_scan_bin_shortage" as const
              : "picker_confirmed_bin_shortage" as const,
            adjustment: observedRelocated,
            systemQtyBefore: Math.max(0, systemQtyAfter + input.effectivePickedQuantity - observedRelocated),
            pickedQty: input.effectivePickedQuantity,
            message: `Picker observation reconciled ${observedRelocated} claim-owned unit(s) into ${target.locationCode} before pick.`,
          },
        } : {}),
      },
    };
  }

  private async completeInventoryPick(
    input: {
      itemId: number;
      beforeItem: OrderItem;
      status: ItemStatus;
      effectivePickedQuantity: number;
      shortReason?: string;
      warehouseLocationId?: number;
      warehouseId?: number | null;
      userId?: string;
      deviceType?: string;
      sessionId?: string;
      pickMethod?: string;
    },
  ): Promise<CompletedPickAtomicResult> {
    if (!this.runtimeClaimExecutor) {
      return this.db.transaction((tx: any) => this.completeLegacyPickTransaction(tx, {
        ...input,
        inventoryCore: typeof this.inventoryCore.withTx === "function"
          ? this.inventoryCore.withTx(tx)
          : this.inventoryCore,
      }));
    }
    return this.runtimeClaimExecutor.execute((context) => {
      if (context.authority === "canonical") return this.completeCanonicalPick(context, input);
      if (!context.legacyDb) {
        throw new IntegrityError("Legacy picker authority transaction is unavailable", {
          reason: "legacy_picker_transaction_missing",
          orderId: input.beforeItem.orderId,
          orderItemId: input.itemId,
        });
      }
      return this.completeLegacyPickTransaction(context.legacyDb, {
        ...input,
        inventoryCore: typeof this.inventoryCore.withTx === "function"
          ? this.inventoryCore.withTx(context.legacyDb)
          : this.inventoryCore,
      });
    });
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
    // Held lines (line-item hold) live in their own held shipment and must not be
    // picked until released (LINE-ITEM-HOLD-DESIGN.md P2). Refuse a pick attempt.
    if (beforeItem.onHold && status !== "pending") {
      throw new IntegrityError(`Item ${itemId} is on hold and cannot be picked`, {
        reason: "line_on_hold",
        itemId,
      });
    }
    const orderForPick = await this.storage.getOrderById(beforeItem.orderId);

    if (orderForPick?.onHold === 1) {
      const message = `Cannot pick item ${itemId}: order ${beforeItem.orderId} is on hold`;
      await this.logRejectedPickCommand({
        beforeItem,
        order: orderForPick,
        status,
        pickedQuantity,
        shortReason,
        pickMethod,
        userId,
        deviceType,
        sessionId,
        rejectionCode: "order_on_hold",
        message,
      });
      return { success: false, error: "order_on_hold", message };
    }

    if (orderForPick && ["cancelled", "shipped"].includes(orderForPick.warehouseStatus)) {
      const message = `Cannot pick item ${itemId}: order ${beforeItem.orderId} is ${orderForPick.warehouseStatus}`;
      await this.logRejectedPickCommand({
        beforeItem,
        order: orderForPick,
        status,
        pickedQuantity,
        shortReason,
        pickMethod,
        userId,
        deviceType,
        sessionId,
        rejectionCode: "order_not_pickable",
        message,
      });
      return { success: false, error: "order_not_pickable", message };
    }

    const currentPickedQuantity = beforeItem.pickedQuantity || 0;

    // A completed status is an idempotent terminal state under both authorities.
    // A stale active row with a full picked quantity is resolved under the
    // selected authority below: legacy preserves its deployed no-op, while
    // canonical requires the claim ledger to prove whether physical stock moved.
    if (status === "completed" && (
      beforeItem.status === "completed"
      || (!this.runtimeClaimExecutor && currentPickedQuantity >= beforeItem.quantity)
    )) {
      console.log(`[Pick] Item ${itemId} is already fully picked - returning success (idempotent)`);
      return { success: true, item: beforeItem as any, inventory: emptyPickInventoryContext(beforeItem.sku) };
    }

    let requestedPickedQuantity: number | undefined;

    // Validate pickedQuantity bounds
    if (pickedQuantity !== undefined) {
      const qty = Number(pickedQuantity);
      if (!Number.isInteger(qty) || qty < 0 || qty > beforeItem.quantity) {
        throw new ValidationError(`pickedQuantity must be an integer between 0 and ${beforeItem.quantity}`);
      }
      requestedPickedQuantity = qty;
    }

    if (status === "completed" && requestedPickedQuantity !== undefined && requestedPickedQuantity !== beforeItem.quantity) {
      const message = `Completed picks must set pickedQuantity to the full item quantity (${beforeItem.quantity})`;
      await this.logRejectedPickCommand({
        beforeItem,
        order: orderForPick,
        status,
        pickedQuantity: requestedPickedQuantity,
        shortReason,
        pickMethod,
        userId,
        deviceType,
        sessionId,
        rejectionCode: "completion_requires_full_quantity",
        message,
      });
      return {
        success: false,
        error: "completion_requires_full_quantity",
        message,
      };
    }

    if (status === "in_progress" && requestedPickedQuantity === 0) {
      const message = "In-progress picks must have a positive pickedQuantity";
      await this.logRejectedPickCommand({
        beforeItem,
        order: orderForPick,
        status,
        pickedQuantity: requestedPickedQuantity,
        shortReason,
        pickMethod,
        userId,
        deviceType,
        sessionId,
        rejectionCode: "in_progress_requires_positive_quantity",
        message,
      });
      return {
        success: false,
        error: "in_progress_requires_positive_quantity",
        message,
      };
    }

    const effectivePickedQuantity = status === "completed"
      ? beforeItem.quantity
      : requestedPickedQuantity ?? currentPickedQuantity;
    const effectiveShortReason = shortReason !== undefined ? shortReason : beforeItem.shortReason;

    if (
      status === beforeItem.status &&
      effectivePickedQuantity === currentPickedQuantity &&
      effectiveShortReason === beforeItem.shortReason
    ) {
      const message = `Pick request did not change item ${itemId}`;
      await this.logRejectedPickCommand({
        beforeItem,
        order: orderForPick,
        status,
        pickedQuantity: requestedPickedQuantity,
        shortReason,
        pickMethod,
        userId,
        deviceType,
        sessionId,
        rejectionCode: "no_pick_progress",
        message,
      });
      return {
        success: false,
        error: "no_pick_progress",
        message,
      };
    }

    let completedDeductResult:
      | Awaited<ReturnType<PickingUseCases["_deductInventory"]>>
      | null = null;

    let item: OrderItem | null = null;
    let forcePostPickStatus: string | null = null;

    if (status === "completed" && beforeItem.status !== "completed") {
      const atomicResult = await this.completeInventoryPick({
        itemId,
        beforeItem,
        status: status as ItemStatus,
        effectivePickedQuantity,
        shortReason,
        warehouseLocationId,
        warehouseId: orderForPick?.warehouseId ?? null,
        userId,
        deviceType,
        sessionId,
        pickMethod,
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
        itemId, status as ItemStatus, requestedPickedQuantity, shortReason, beforeItem.status as ItemStatus,
      );
    }

    if (!item) {
      // With no status guard on completed transitions, this should only happen
      // for non-completed status updates. Log and return error.
      console.error(`[Pick] status_conflict on item ${itemId}: status='${beforeItem.status}', requested='${status}', pickedQty=${requestedPickedQuantity}`);
      return { success: false, error: "status_conflict", message: `Item ${itemId} status conflict` };
    }

    // Log the action (fire-and-forget)
    const order = orderForPick ?? await this.storage.getOrderById(item.orderId);
    const pickerId = order?.assignedPickerId;
    const picker = pickerId ? await this.storage.getUser(pickerId) : null;

    let actionType = "item_picked";
    if (status === "completed") actionType = "item_picked";
    else if (status === "short") actionType = "item_shorted";
    else if (requestedPickedQuantity !== undefined && currentPickedQuantity !== requestedPickedQuantity) actionType = "item_quantity_adjusted";

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

          if (!deductResult.reviewRecorded) {
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
        }

        // Auto-execute replen in background — no picker confirmation needed.
        // Fire-and-forget: returns result to caller so UI can show dismissible notification.
        if (deductResult.authority !== "canonical") {
          try {
            const replenResult = deductResult.prePickReplen ?? await this.replenishment.createAndExecuteReplen(
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
    resolution: InventoryAutoResolved;
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
      resolution: params.resolution.code === "picker_scan_bin_shortage"
        ? "picker_scan_count_correction"
        : "picker_confirmed_count_correction",
      autoFixedSetup: false,
      reviewReason: params.resolution.message,
      resolvedBy: params.userId || null,
      resolvedAt: new Date(),
      metadata: {
        pickerNonBlocking: true,
        shipmentBlocking: false,
        observation: params.resolution.code === "picker_scan_bin_shortage"
          ? "validated_item_scan"
          : "picker_confirmed_physical_stock",
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
      pickMethod: params.resolution.code === "picker_scan_bin_shortage" ? "scan" : "manual",
      itemStatusBefore: params.item.status,
      itemStatusAfter: params.item.status,
      metadata: {
        exceptionId: exception.id,
        pickerNonBlocking: true,
        shipmentBlocking: false,
        resolutionCode: params.resolution.code,
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
    const { exception } = await this.createBlockingAllocationException({
      item: params.item,
      order: params.order,
      productVariantId: params.productVariantId,
      exceptionType: "inventory_deduction_failed",
      requestedQty: params.requestedQty,
      selectedLocationId: params.locationId,
      selectedLocationCode: params.locationCode,
      reviewReason: params.message,
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
    });

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

    // Non-stock item (standard WMS exception flow): track_inventory=false
    // means "we sell and ship this, but do not inventory-manage it" — one-off
    // goods, inserts, occasional stock. The pick is confirmation-only: the
    // picking log keeps the audit trail; no level/lot/reservation writes.
    if (productVariant.requiresShipping === false || productVariant.trackInventory === false) {
      console.log(`[Inventory] ${productVariant.sku} is not warehouse-managed — confirmation-only pick, no deduction`);
      return { success: true, noVariant: true, productVariantId: productVariant.id, locationId: 0, locationCode: null, systemQtyAfter: 0 };
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
      // Nothing to deduct from. Only reachable when the line carries no
      // picker-facing bin (an assigned bin is always trusted above), so the
      // exception must describe the real shelf state. The previous message
      // said "no stock" and reported systemQty 0 whenever stock existed but no
      // single bin held the full quantity, which sent operators hunting for a
      // bin-assignment fault instead of a shortfall (2026-09). Reporting only:
      // the pick still fails and nothing moves. The picker-side fix is a bin
      // confirmation, which also repairs the slot setup.
      const bestStocked = findBestStockedPickableLevel(pickableLevels);
      const bestQty = bestStocked ? Number(bestStocked.level.variantQty ?? 0) : 0;
      const message = bestStocked
        ? `${item.sku} has no assigned pick bin on this line and no single pickable bin holds ${pickedQty}: `
          + `best is ${bestStocked.loc.code} with ${bestQty}. Confirm the bin on the gun to pick from it.`
        : `No pickable location has any stock for ${item.sku}`;
      return {
        success: false,
        error: "no_inventory",
        message,
        productVariantId: productVariant.id,
        locationId: bestStocked?.loc.id ?? assignedLocationId,
        locationCode: bestStocked?.loc.code ?? assignedLocationCode,
        systemQty: bestQty,
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
    let systemQtyAvailableForPick = systemQtyBeforePick;
    let autoResolvedInventory: InventoryAutoResolved | undefined;
    let prePickReplen: PrePickReplenResult | undefined;

    if (systemQtyAvailableForPick < pickedQty) {
      const isScanVerified = opts.pickMethod === "scan";
      const canTrustLocation = locationResolution === "assigned" || locationResolution === "explicit";
      const locationIsPickerSafe =
        pickLocation?.isPickable === 1 &&
        pickLocation?.isActive === 1 &&
        !pickLocation?.cycleCountFreezeId;

      if (canTrustLocation && locationIsPickerSafe) {
        prePickReplen = await this.tryInlineCaseBreakReplenBeforePick({
          productVariantId: productVariant.id,
          locationId: pickLocationId,
          item,
          order: await this.storage.getOrderById(item.orderId),
          userId: opts.userId,
        });

        if (prePickReplen) {
          const afterReplenLevel = await inventoryCore.getLevel(productVariant.id, pickLocationId);
          systemQtyAvailableForPick = afterReplenLevel?.variantQty ?? systemQtyAvailableForPick;
        }
      }

      if (systemQtyAvailableForPick < pickedQty) {
        if (canTrustLocation && locationIsPickerSafe) {
          const adjustment = pickedQty - systemQtyAvailableForPick;
          const resolutionCode = isScanVerified ? "picker_scan_bin_shortage" : "picker_confirmed_bin_shortage";
          const locationCode = pickLocation?.code || assignedLocationCode || String(pickLocationId);
          const observation = isScanVerified ? "Picker scan" : "Picker confirmation";
          const message =
            `${observation} found ${pickedQty} ${productVariant.sku} at ${locationCode}; ` +
            `system had ${systemQtyAvailableForPick}. Added ${adjustment} before pick and queued review.`;

          await inventoryCore.adjustInventory({
            productVariantId: productVariant.id,
            warehouseLocationId: pickLocationId,
            qtyDelta: adjustment,
            reason: message,
            userId: opts.userId,
          });

          autoResolvedInventory = {
            code: resolutionCode,
            adjustment,
            systemQtyBefore: systemQtyAvailableForPick,
            pickedQty,
            message,
          };
          systemQtyAvailableForPick += adjustment;
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
      const level = await inventoryCore.getLevel(productVariant.id, pickLocationId);
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
      autoResolved: autoResolvedInventory,
      prePickReplen,
    };
  }

  private async tryInlineCaseBreakReplenBeforePick(params: {
    productVariantId: number;
    locationId: number;
    item: OrderItem;
    order: Order | undefined;
    userId?: string;
  }): Promise<PrePickReplenResult | undefined> {
    const guidance = await this.replenishment.checkReplenNeeded(params.productVariantId, params.locationId, {
      forceWhenAtOrBelowZero: true,
    }).catch((err: any) => {
      console.warn(`[Replen] pre-pick guidance failed for item=${params.item.id} sku=${params.item.sku}:`, err?.message || err);
      return null;
    });

    if (
      !guidance?.needed ||
      guidance.stockout ||
      guidance.replenMethod !== "case_break" ||
      guidance.executionMode !== "inline" ||
      !guidance.sourceLocationCode
    ) {
      return undefined;
    }

    const replenResult = await this.replenishment.createAndExecuteReplen(
      params.productVariantId,
      params.locationId,
      params.userId,
      {
        orderId: params.item.orderId,
        orderItemId: params.item.id,
        orderNumber: params.order?.orderNumber ?? null,
        blocksShipment: false,
        forceWhenAtOrBelowZero: true,
        triggeredBy: "pick_shortage_case_break",
      },
    );

    if (!replenResult || replenResult.task?.status !== "completed") {
      return undefined;
    }

    return replenResult;
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

  private async completeCanonicalUnpick(
    context: InventoryAvailabilityRuntimeClaimContext,
    input: {
      beforeItem: OrderItem;
      claim: CanonicalClaimCursor;
      variantId?: number;
      requestedQty: number;
      userId?: string;
      reason?: string;
    },
  ): Promise<{
    item: OrderItem;
    inventory: PickInventoryContext;
    qtyBefore: number;
    qtyAfter: number;
    qtyDelta: number;
  }> {
    if (!context.getClaimLinePickMovementCursor) {
      throw new IntegrityError("Canonical claim pick-movement cursor lookup is not configured", {
        reason: "canonical_pick_movement_cursor_lookup_missing",
        orderId: input.beforeItem.orderId,
        orderItemId: input.beforeItem.id,
      });
    }
    const pickMovementCursor = await context.getClaimLinePickMovementCursor(
      input.claim.claimId,
      input.beforeItem.id,
    );
    const qtyBefore = Number(input.beforeItem.pickedQuantity ?? 0);
    const quantity = Math.min(input.requestedQty, qtyBefore);
    const qtyAfter = qtyBefore - quantity;
    const actor = canonicalPickerActor(input.userId);
    const reason = input.reason?.trim() || "Picker unpick";
    const wmsProgress = {
      expectedStatus: input.beforeItem.status as "completed" | "in_progress",
      expectedPickedQuantity: qtyBefore,
      targetStatus: qtyAfter === 0 ? "pending" as const : "in_progress" as const,
      targetPickedQuantity: qtyAfter,
    };
    const canonicalResult = await context.canonical.unpickClaimLine({
      claimId: input.claim.claimId,
      orderItemId: input.beforeItem.id,
      quantity: String(quantity),
      wmsProgress,
      idempotencyKey: canonicalPickerCommandKey("unpick", {
        claimId: input.claim.claimId,
        orderId: input.beforeItem.orderId,
        orderItemId: input.beforeItem.id,
        quantity,
        actor,
        wmsProgress,
        pickMovementCursor,
      }),
      actor,
      reason,
    });

    const item = await this.storage.getOrderItemById(input.beforeItem.id);
    if (!item || item.status !== wmsProgress.targetStatus || item.pickedQuantity !== qtyAfter) {
      throw new IntegrityError("Canonical unpick committed but its WMS progress projection could not be verified", {
        reason: "canonical_wms_unpick_readback_failed",
        orderId: input.beforeItem.orderId,
        orderItemId: input.beforeItem.id,
      });
    }
    const locations = await this.storage.getAllWarehouseLocations();
    const restoredLocationIds = new Set(canonicalResult.warehouseLocationIds);
    const assignedLocationCode = input.beforeItem.location?.trim().toUpperCase() ?? "";
    const location = locations.find((candidate) =>
      restoredLocationIds.has(candidate.id)
      && candidate.code?.trim().toUpperCase() === assignedLocationCode)
      ?? locations.find((candidate) => restoredLocationIds.has(candidate.id));
    const inventory = emptyPickInventoryContext(input.beforeItem.sku);
    if (location && input.variantId != null) {
      const level = await this.inventoryCore.getLevel(input.variantId, location.id);
      inventory.locationId = location.id;
      inventory.locationCode = location.code;
      inventory.systemQtyAfter = Number(level?.variantQty ?? 0);
      inventory.resolution.autoResolved = true;
      inventory.resolution.code = "unpick_reversed";
      inventory.resolution.message = "Canonical picked inventory was returned through exact claim lineage";
    }
    return { item, inventory, qtyBefore, qtyAfter, qtyDelta: -quantity };
  }

  async unpickItem(itemId: number, params: {
    qty: number;
    userId?: string;
    reason?: string;
    deviceType?: string;
    sessionId?: string;
  }): Promise<UnpickItemResult> {
    const requestedQty = Number(params.qty);
    if (!Number.isInteger(requestedQty) || requestedQty <= 0) {
      throw new ValidationError("qty must be a positive integer");
    }

    const beforeItem = await this.storage.getOrderItemById(itemId);
    if (!beforeItem) {
      throw new IntegrityError(`Item ${itemId} not found`);
    }

    const orderBefore = await this.storage.getOrderById(beforeItem.orderId);
    if (!orderBefore) {
      throw new IntegrityError(`Order ${beforeItem.orderId} not found`);
    }

    if (orderBefore.onHold === 1) {
      return {
        success: false,
        error: "order_on_hold",
        message: `Cannot unpick item ${itemId}: order ${beforeItem.orderId} is on hold`,
      };
    }

    if (!["ready", "in_progress"].includes(orderBefore.warehouseStatus)) {
      return {
        success: false,
        error: "order_not_unpickable",
        message: `Cannot unpick item ${itemId}: order ${beforeItem.orderId} is ${orderBefore.warehouseStatus}`,
      };
    }

    const beforePickedQty = beforeItem.pickedQuantity || 0;
    if (beforePickedQty <= 0) {
      return { success: true, item: beforeItem, inventory: emptyPickInventoryContext(beforeItem.sku) };
    }

    let variant: any | undefined;
    let location: WarehouseLocation | undefined;
    let inventoryTracked = false;

    if (["completed", "in_progress"].includes(beforeItem.status)) {
      variant = await this.storage.getProductVariantBySku(beforeItem.sku);
      inventoryTracked = beforeItem.requiresShipping === 1
        && variant?.requiresShipping !== false
        && variant?.trackInventory !== false;
      if (inventoryTracked && variant?.id && beforeItem.status === "completed") {
        const locations = await this.storage.getAllWarehouseLocations();
        const locationCode = (beforeItem.location || "").trim().toUpperCase();
        location = locations.find(loc => loc.code.toUpperCase() === locationCode);
        if (!location) {
          throw new ValidationError(`Pick bin ${beforeItem.location || "(blank)"} was not found`);
        }
      }
    }

    const executeLegacyUnpick = async (tx: any) => {
      const lockedOrder = await tx.execute(sql`
        SELECT warehouse_status, on_hold
        FROM wms.orders
        WHERE id = ${beforeItem.orderId}
        FOR UPDATE
      `);

      if (!lockedOrder.rows?.length) {
        throw new IntegrityError(`Order ${beforeItem.orderId} not found`);
      }

      const orderState = lockedOrder.rows[0];
      if (Number(orderState.on_hold) === 1) {
        throw new IntegrityError(
          `Cannot unpick item ${itemId}: order ${beforeItem.orderId} is on hold`,
          { reason: "order_on_hold", orderId: beforeItem.orderId, orderItemId: itemId },
        );
      }
      if (!["ready", "in_progress"].includes(orderState.warehouse_status)) {
        throw new IntegrityError(
          `Cannot unpick item ${itemId}: order ${beforeItem.orderId} is ${orderState.warehouse_status}`,
          { reason: "order_not_unpickable", orderId: beforeItem.orderId, orderItemId: itemId },
        );
      }

      const lockedItem = await tx.execute(sql`
        SELECT id, status, picked_quantity, quantity
        FROM wms.order_items
        WHERE id = ${itemId}
        FOR UPDATE
      `);

      if (!lockedItem.rows?.length) {
        throw new IntegrityError(`Item ${itemId} not found`);
      }

      const itemState = lockedItem.rows[0];
      const lockedPickedQty = Number(itemState.picked_quantity || 0);
      if (lockedPickedQty <= 0) {
        return {
          item: beforeItem,
          inventory: emptyPickInventoryContext(beforeItem.sku),
          qtyBefore: beforePickedQty,
          qtyAfter: beforePickedQty,
          qtyDelta: 0,
        };
      }

      const lockedActualUnpickQty = Math.min(requestedQty, lockedPickedQty);

      if (itemState.status === "completed" && inventoryTracked) {
        if (!variant?.id) {
          throw new IntegrityError(`Tracked picker SKU ${beforeItem.sku} has no active catalog variant`, {
            reason: "legacy_picker_variant_missing",
            orderId: beforeItem.orderId,
            orderItemId: beforeItem.id,
            sku: beforeItem.sku,
          });
        }
        const txInventoryCore =
          typeof this.inventoryCore.withTx === "function"
            ? this.inventoryCore.withTx(tx)
            : this.inventoryCore;

        if (typeof txInventoryCore.unpickItem !== "function") {
          throw new IntegrityError("Inventory unpick service is not configured");
        }

        const reversed = await txInventoryCore.unpickItem({
          productVariantId: variant!.id,
          warehouseLocationId: location!.id,
          qty: lockedActualUnpickQty,
          orderId: beforeItem.orderId,
          orderItemId: beforeItem.id,
          userId: params.userId,
          reason: params.reason || "Picker unpick",
        });

        if (!reversed) {
          throw new IntegrityError(
            `Cannot unpick item ${itemId}: picked inventory was not available to reverse`,
            { reason: "picked_inventory_unavailable", orderId: beforeItem.orderId, orderItemId: itemId },
          );
        }
      }

      const newPickedQty = lockedPickedQty - lockedActualUnpickQty;
      const newStatus: ItemStatus = newPickedQty <= 0 ? "pending" : "in_progress";
      const itemUpdates: Record<string, any> = {
        status: newStatus,
        pickedQuantity: newPickedQty,
      };
      if (newStatus === "pending") {
        itemUpdates.pickedAt = null;
      }

      const updatedItem = await persistWmsOrderItemPickProgress(tx, {
        itemId,
        status: itemUpdates.status as ItemStatus,
        pickedQuantity: itemUpdates.pickedQuantity,
        pickedAt: itemUpdates.pickedAt,
      });

      const siblingItems = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, beforeItem.orderId));

      const shippableItems = siblingItems.filter((item: OrderItem) => item.requiresShipping === 1);
      const pickedCount = shippableItems.reduce((sum: number, item: OrderItem) => sum + (item.pickedQuantity || 0), 0);
      const itemCount = siblingItems.length;
      const unitCount = siblingItems.reduce((sum: number, item: OrderItem) => sum + item.quantity, 0);
      const allShippableDone = shippableItems.length === 0 ||
        shippableItems.every((item: OrderItem) => item.status === "completed" || item.status === "short");

      const orderUpdates: Record<string, any> = {
        pickedCount,
        itemCount,
        unitCount,
      };
      if (!allShippableDone) {
        orderUpdates.warehouseStatus = "in_progress" as OrderStatus;
        orderUpdates.completedAt = null;
        orderUpdates.exceptionAt = null;
      }

      await tx
        .update(orders)
        .set(orderUpdates)
        .where(eq(orders.id, beforeItem.orderId));

      const inventory = emptyPickInventoryContext(beforeItem.sku);
      if (variant?.id && location?.id) {
        inventory.locationId = location.id;
        inventory.locationCode = location.code;
        inventory.resolution.autoResolved = true;
        inventory.resolution.code = "unpick_reversed";
        inventory.resolution.message = "Picked inventory was returned to on-hand";
      }

      return {
        item: updatedItem as OrderItem,
        inventory,
        qtyBefore: lockedPickedQty,
        qtyAfter: newPickedQty,
        qtyDelta: -lockedActualUnpickQty,
      };
    };

    const result = ["completed", "in_progress"].includes(beforeItem.status) && this.runtimeClaimExecutor
      ? await this.runtimeClaimExecutor.execute(async (context) => {
          if (context.authority === "canonical" && inventoryTracked) {
            if (!context.getClaimOwningPickedLine) {
              throw new IntegrityError("Canonical picked-claim lookup is not configured", {
                reason: "canonical_pick_claim_lookup_missing",
                orderId: beforeItem.orderId,
                orderItemId: beforeItem.id,
              });
            }
            const claim = await context.getClaimOwningPickedLine(beforeItem.orderId, beforeItem.id);
            if (!claim) {
              if (beforeItem.status === "in_progress") {
                return this.db.transaction(executeLegacyUnpick);
              }
              throw new IntegrityError("The completed WMS item has no canonical picked claim line to reverse", {
                reason: "canonical_picked_claim_missing",
                orderId: beforeItem.orderId,
                orderItemId: beforeItem.id,
              });
            }
            return this.completeCanonicalUnpick(context, {
              beforeItem,
              claim,
              variantId: variant?.id == null ? undefined : Number(variant.id),
              requestedQty,
              userId: params.userId,
              reason: params.reason,
            });
          }
          if (context.authority === "canonical") {
              return this.db.transaction(executeLegacyUnpick);
          }
          if (!context.legacyDb) {
            throw new IntegrityError("Legacy picker authority transaction is unavailable", {
              reason: "legacy_picker_transaction_missing",
              orderId: beforeItem.orderId,
              orderItemId: itemId,
            });
          }
          return executeLegacyUnpick(context.legacyDb);
        })
      : await this.db.transaction(executeLegacyUnpick);

    const actorId = params.userId || orderBefore.assignedPickerId || undefined;
    const actor = actorId ? await this.storage.getUser(actorId) : null;
    await this.storage.createPickingLog({
      actionType: "item_unpicked",
      pickerId: actorId,
      pickerName: actor?.displayName || actor?.username || actorId,
      pickerRole: actor?.role,
      orderId: beforeItem.orderId,
      orderNumber: orderBefore.orderNumber,
      orderItemId: beforeItem.id,
      sku: beforeItem.sku,
      itemName: beforeItem.name,
      locationCode: beforeItem.location,
      qtyRequested: beforeItem.quantity,
      qtyBefore: result.qtyBefore,
      qtyAfter: result.qtyAfter,
      qtyDelta: result.qtyDelta,
      reason: params.reason || "Picker unpick",
      itemStatusBefore: beforeItem.status,
      itemStatusAfter: result.item.status,
      deviceType: params.deviceType || "desktop",
      sessionId: params.sessionId,
      pickMethod: "unpick",
    });

    return { success: true, item: result.item, inventory: result.inventory };
  }

  async claimOrder(
    orderId: number,
    pickerId: string,
    deviceType?: string,
    sessionId?: string,
    claimSource?: string,
  ): Promise<{ order: Order; items: OrderItem[] }> {
    if (!pickerId) throw new ValidationError("pickerId is required");

    const orderBefore = await this.storage.getOrderById(orderId);

    const order = await this.storage.claimOrder(orderId, pickerId);
    if (!order) {
      // Claim was rejected by the guarded UPDATE. Classify WHY so the UI can
      // tell the picker the truth instead of always blaming "another picker".
      const current = orderBefore ?? (await this.storage.getOrderById(orderId));
      if (!current) {
        throw new NotFoundError(`Order ${orderId} not found`, { reason: "not_found", orderId });
      }
      if (current.onHold === 1) {
        throw new IntegrityError("Order is on hold and cannot be picked", {
          reason: "on_hold",
          orderId,
        });
      }
      if (
        current.warehouseStatus === "in_progress" &&
        current.assignedPickerId &&
        current.assignedPickerId !== pickerId
      ) {
        const holder = await this.storage.getUser(current.assignedPickerId);
        const holderName = holder?.displayName || holder?.username || "another picker";
        throw new IntegrityError(`Order is currently being picked by ${holderName}`, {
          reason: "in_progress_other",
          orderId,
          assignedPickerId: current.assignedPickerId,
          pickerName: holderName,
        });
      }
      throw new IntegrityError(
        `Order is not available to pick (status: ${current.warehouseStatus})`,
        { reason: "not_claimable", orderId, warehouseStatus: current.warehouseStatus },
      );
    }

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
      metadata: claimSource ? { claimSource } : undefined,
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
    userId?: string;
    deviceType?: string;
    sessionId?: string;
  }): Promise<Order | null> {
    const resetProgress = options?.resetProgress ?? false;
    if (resetProgress) {
      throw new ValidationError("Picker release cannot reset pick progress; use the admin repair reset workflow");
    }

    const orderBefore = await this.storage.getOrderById(orderId);
    const order = await this.storage.releaseOrder(orderId, false);
    if (!order) return null;

    // Audit log
    const pickerId = options?.userId || orderBefore?.assignedPickerId;
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
      reason: options?.reason || "Progress preserved",
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

    this.triggerCartonizationShadow(orderId);

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
    if (!PACKING_HANDOFF_STATUSES.has(desiredStatus)) return desiredStatus;

    if (desiredStatus !== "ready_to_ship") {
      this.triggerCartonizationShadow(orderId);
      return desiredStatus;
    }

    const blockers = await this.getReadyToShipBlockers(orderId);
    if (blockers.length === 0) this.triggerCartonizationShadow(orderId);
    return blockers.length > 0 ? "exception" : desiredStatus;
  }

  private async getReadyToShipBlockers(orderId: number): Promise<string[]> {
    const blockers: string[] = [];
    const items = await this.storage.getOrderItems(orderId);
    // Held lines (line-item hold) live in their own held shipment and are not
    // picked until released — they must NOT block the rest of the order from
    // reaching ready_to_ship (LINE-ITEM-HOLD-DESIGN.md P2).
    const shippableItems = items.filter(item => item.requiresShipping === 1 && !item.onHold);

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

  /**
   * Observe the common WMS packing handoff without participating in it.
   * This is deliberately fire-and-forget: even a stalled planner must never
   * delay, change, or block an order status transition.
   */
  private triggerCartonizationShadow(orderId: number): void {
    if (!this.cartonizationShadowEnabled || !this.cartonization) return;

    void this.cartonization.ensurePackPlan({ wmsOrderId: orderId })
      .then((plan) => {
        if (!plan?.complete) {
          console.warn(
            `[CartonizationShadow] order ${orderId}: no verified plan; WMS handoff unchanged`,
          );
        }
      })
      .catch((error) => {
        console.warn(
          `[CartonizationShadow] order ${orderId}: execution failed; WMS handoff unchanged`,
          error,
        );
      });
  }

  // -------------------------------------------------------------------------
  // 5. CONSOLIDATED BIN COUNT
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

    if (didReplen) {
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
        ? `Bin count after picker-reported replen: system=${postSystemQty}, actual=${binCount}, adjustment=${adjustment}`
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
        notes: `Bin count verified: system=${postSystemQty}, actual=${binCount} (match)${didReplen ? ", picker reported replen" : ""}`,
        userId: userId || null,
      });
    }

    return {
      success: true,
      systemQtyBefore: systemQty,
      actualBinQty: binCount,
      adjustment,
      replenTriggered: false,
      replenTaskStatus: null,
      replenFailReason: null,
      inferredReplen: false,
      inferredReplenMoved: null,
    };
  }

  // -------------------------------------------------------------------------
  // 6. getPickQueue
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
  cartonization: CartonizationLike = { ensurePackPlan },
  cartonizationShadowEnabled = isWmsCartonizationShadowEnabled(),
  runtimeClaimExecutor?: InventoryAvailabilityRuntimeClaimExecutor,
) {
  return new PickingUseCases(
    db,
    inventoryCore,
    replenishment,
    storage,
    channelSync,
    cartonization,
    cartonizationShadowEnabled,
    runtimeClaimExecutor,
  );
}

export type { PickingUseCases as PickingService };
