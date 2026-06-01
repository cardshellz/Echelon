import { eq, and, or, sql, inArray, isNull, asc } from "drizzle-orm";
import {
  replenRules,
  replenTasks,
  replenTierDefaults,
  inventoryLevels,
  inventoryTransactions,
  warehouseLocations,
  productVariants,

  locationReplenConfig,
  productLocations,
  warehouseSettings,
  warehouses,
  products,
  cycleCounts,
  cycleCountItems,
} from "@shared/schema";
import { calculateRemainingCapacity, findOverflowBin } from "../inventory-utils";
import { notify } from "../../notifications/notifications.service";
import { getSettingsForWarehouse as sharedGetSettingsForWarehouse } from "../../warehouse/settings.resolver";
import type {
  ReplenTask,
  InsertReplenTask,
  ReplenRule,
  ReplenTierDefault,
  InventoryLevel,
  WarehouseLocation,
  WarehouseSettings,
  ProductVariant,
} from "@shared/schema";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: (query: any) => Promise<any>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

export type ReplenGuidance = {
  needed: boolean;
  stockout: boolean;
  sourceLocationId: number | null;
  sourceLocationCode: string | null;
  sourceVariantId: number | null;
  sourceVariantSku: string | null;
  sourceVariantName: string | null;
  pickVariantId: number;
  qtySourceUnits: number;
  qtyTargetUnits: number;
  replenMethod: string;
  executionMode: string;
  taskNotes: string;
  triggerValue: number | null;
  autoReplen: number;
  evaluatedQty: number | null;
  existingTaskId?: number | null;
  existingTaskStatus?: string | null;
  existingTaskExecutionMode?: string | null;
  existingTaskBlocksShipment?: boolean;
  skipReason?: string | null;
};

export type ReplenPickPrediction = {
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
};

export type ReplenOrderContext = {
  orderId?: number | null;
  orderItemId?: number | null;
  orderNumber?: string | null;
  blocksShipment?: boolean;
  forceWhenAtOrBelowZero?: boolean;
  triggeredBy?: string;
};

export type ReplenSourceEmptyReport = {
  pickVariantId: number;
  pickLocationId: number;
  orderId: number;
  orderItemId: number;
  orderNumber?: string | null;
  sku?: string | null;
  sourceLocationCode?: string | null;
  userId?: string;
};

export type ReplenHealthCleanupMode = "all" | "stale_no_demand" | "duplicates" | "inline_execution";

export type ReplenHealthCleanupResult = {
  mode: ReplenHealthCleanupMode;
  executedInline: number;
  failedInline: number;
  skippedInline: number;
  cancelledStaleNoDemand: number;
  cancelledStaleBacklog: number;
  cancelledDuplicates: number;
  executedInlineTaskIds: number[];
  failedInlineTaskIds: number[];
  skippedInlineTaskIds: number[];
  cancelledStaleNoDemandTaskIds: number[];
  cancelledStaleBacklogTaskIds: number[];
  cancelledDuplicateTaskIds: number[];
  keptDuplicateTaskIds: number[];
};

export type MissingPickBinReplenQueueResult = {
  mode: "queue_replen" | "queue_missing_replen";
  scannedPickBins: number;
  queuedReplen: number;
  queuedTaskIds: number[];
  existingTaskIds: number[];
  skippedPickBins: number;
  skipped: Array<{
    variantId: number;
    locationId: number;
    sku: string | null;
    locationCode: string | null;
    reason: string;
  }>;
};

type ResolvedReplenParams = {
  triggerValue: number | null;
  maxQty: number | null;
  replenMethod: string;
  priority: number;
  sourceLocationType: string;
  autoReplen: number;
  sourceVariantId: number | null;
  sourceHierarchyLevel: number | null;
  sourcePriority: string;
};

type SourceResolutionIssue = {
  reason: "no_source_stock" | "no_source_variant";
  note: string;
};

type SourceCandidateResolution =
  | {
      status: "found";
      variant: ProductVariant;
      location: WarehouseLocation;
      candidateCount: number;
      note: string;
    }
  | {
      status: "not_found";
      issue: SourceResolutionIssue;
    };

type ReplenEvalResult =
  | {
      status: "skip";
      skipReason: string;
      params?: ResolvedReplenParams;
      triggerValue?: number | null;
      evaluatedQty?: number | null;
    }
  | {
      status: "dedup";
      existingTaskId: number;
      existingTask: ReplenTask;
      params: ResolvedReplenParams;
      triggerValue: number | null;
      evaluatedQty: number;
    }
  | {
      status: "needed_with_source" | "needed_stockout";
      level: InventoryLevel;
      location: WarehouseLocation;
      variant: ProductVariant;
      whSettings: WarehouseSettings | null;
      params: ResolvedReplenParams;
      taskNotes: string;
      sourceResolutionIssue?: SourceResolutionIssue | null;
      rule: ReplenRule | null;
      sourceLocation: WarehouseLocation | null;
      resolvedSourceVariantId: number | null;
      sourceVariant: ProductVariant;
      qtySourceUnits: number;
      qtyTargetUnits: number;
      executionMode: string;
      shouldAutoExecute: boolean;
      triggerValue: number;
      evaluatedQty: number;
    };

type ReplenEvaluationOptions = {
  currentQtyOverride?: number;
  ignoreTaskId?: number;
  forceWhenAtOrBelowZero?: boolean;
};

type ReplenEvaluationContext = {
  level: InventoryLevel | null;
  effectiveLevel: InventoryLevel;
  implicitZeroLevel: boolean;
  location: WarehouseLocation;
  variant: ProductVariant;
  evaluatedQty: number;
};

type ReplenEvaluationContextResult =
  | { status: "ready"; context: ReplenEvaluationContext }
  | { status: "skip"; result: Extract<ReplenEvalResult, { status: "skip" }> };

type ReplenThresholdDecision = {
  thresholdMet: boolean;
  taskNotes: string;
};

type ReplenSourceDecision = {
  sourceResolutionIssue: SourceResolutionIssue | null;
  sourceLocation: WarehouseLocation | null;
  resolvedSourceVariantId: number | null;
  resolvedReplenMethod: string;
};

const ACTIVE_REPLEN_TASK_STATUSES = ["pending", "assigned", "in_progress", "blocked"];
const EXECUTABLE_REPLEN_TASK_STATUSES = ["pending", "assigned", "in_progress"];
const RECOVERABLE_BLOCKED_REPLEN_REASONS = new Set<string | null>([
  null,
  "no_source_stock",
  "no_source_variant",
  "execute_failed",
]);

type InventoryCore = {
  getLevel: (productVariantId: number, warehouseLocationId: number) => Promise<InventoryLevel | null>;
  upsertLevel: (productVariantId: number, warehouseLocationId: number, initial?: Partial<InventoryLevel>) => Promise<InventoryLevel>;
  adjustLevel: (levelId: number, deltas: Record<string, number | undefined>) => Promise<InventoryLevel>;
  adjustInventory: (params: {
    productVariantId: number;
    warehouseLocationId: number;
    qtyDelta: number;
    reason: string;
    reasonId?: number;
    cycleCountId?: number;
    userId?: string;
    allowNegative?: boolean;
  }) => Promise<void>;
  transfer: (params: {
    productVariantId: number;
    fromLocationId: number;
    toLocationId: number;
    qty: number;
    userId?: string;
    notes?: string;
  }) => Promise<void>;
  receiveInventory: (params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    referenceId: string;
    notes?: string;
    userId?: string;
  }) => Promise<void>;
  logTransaction: (txn: any) => Promise<void>;
  withTx: (tx: any) => InventoryCore;
};

import { InventoryUseCases } from "./inventory.use-cases";

/**
 * Replenishment use cases for the Echelon WMS.
 *
 * Detects low stock in forward-pick locations and creates/executes tasks
 * to move inventory from bulk storage. Manages the full replen task
 * lifecycle: creation, execution (with case-break support), cancellation,
 * and auto-triggering after picks.
 */
export class ReplenishmentUseCases {
  constructor(
    private readonly db: DrizzleDb,
    private readonly inventoryUseCases: InventoryUseCases,
  ) {}

  private async withPickBinTaskLock<T>(
    pickVariantId: number,
    toLocationId: number,
    action: () => Promise<T>,
  ): Promise<T> {
    // Serialize cooperating replen creation paths for the same pick bin/SKU.
    // The action continues through the service's normal DB handle so existing
    // task execution/rollback behavior is unchanged; this transaction only
    // holds the advisory lock until the create/reuse decision completes.
    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('inventory.replen_tasks.pick_bin'),
          hashtext(${`${pickVariantId}:${toLocationId}`})
        )
      `);
      return action();
    });
  }

  private async findActiveTaskForPickBin(
    pickVariantId: number,
    toLocationId: number,
  ): Promise<ReplenTask | null> {
    const [task] = await this.db
      .select()
      .from(replenTasks)
      .where(and(
        eq(replenTasks.pickProductVariantId, pickVariantId),
        eq(replenTasks.toLocationId, toLocationId),
        inArray(replenTasks.status, ACTIVE_REPLEN_TASK_STATUSES),
        sql`NOT (
          ${replenTasks.status} = 'blocked'
          AND ${replenTasks.blocksShipment} = false
          AND ${replenTasks.dependsOnTaskId} IS NULL
          AND COALESCE(${replenTasks.qtySourceUnits}, 0) = 0
          AND COALESCE(${replenTasks.qtyTargetUnits}, 0) = 0
          AND ${replenTasks.exceptionReason} IN ('no_source_stock', 'no_source_variant')
        )`,
      ))
      .limit(1);

    const activeTask = task as ReplenTask | undefined;
    return activeTask && !this.isNoSourceReviewOnlyTask(activeTask) ? activeTask : null;
  }

  private async getTaskById(taskId: number): Promise<ReplenTask | null> {
    const [task] = await this.db
      .select()
      .from(replenTasks)
      .where(eq(replenTasks.id, taskId))
      .limit(1);

    return (task as ReplenTask | undefined) ?? null;
  }

  private async buildExistingTaskGuidance(
    productVariantId: number,
    task: ReplenTask,
    eval_: Extract<ReplenEvalResult, { status: "dedup" }>,
  ): Promise<ReplenGuidance> {
    const sourceLocationId =
      task.fromLocationId && task.fromLocationId !== task.toLocationId
        ? task.fromLocationId
        : null;
    const [sourceLocation] = sourceLocationId
      ? await this.db
          .select()
          .from(warehouseLocations)
          .where(eq(warehouseLocations.id, sourceLocationId))
          .limit(1)
      : [];
    const sourceVariantId = task.sourceProductVariantId ?? productVariantId;
    const [sourceVariant] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, sourceVariantId))
      .limit(1);

    return {
      needed: true,
      stockout: task.status === "blocked" && task.qtyTargetUnits === 0,
      sourceLocationId,
      sourceLocationCode: sourceLocation?.code ?? null,
      sourceVariantId,
      sourceVariantSku: sourceVariant?.sku ?? null,
      sourceVariantName: sourceVariant?.name || sourceVariant?.sku || null,
      pickVariantId: productVariantId,
      qtySourceUnits: task.qtySourceUnits ?? 0,
      qtyTargetUnits: task.qtyTargetUnits ?? 0,
      replenMethod: task.replenMethod ?? eval_.params.replenMethod,
      executionMode: task.executionMode ?? "queue",
      taskNotes: task.notes ?? "",
      triggerValue: eval_.triggerValue,
      autoReplen: task.autoReplen ?? eval_.params.autoReplen,
      evaluatedQty: eval_.evaluatedQty,
      existingTaskId: task.id,
      existingTaskStatus: task.status,
      existingTaskExecutionMode: task.executionMode ?? null,
      existingTaskBlocksShipment: task.blocksShipment === true,
      skipReason: `dedup_existing_task (#${task.id})`,
    };
  }

  private isRecoverableBlockedTask(task: ReplenTask): boolean {
    if (task.status !== "blocked") return false;
    if (task.blocksShipment === true) return false;
    if (task.dependsOnTaskId != null) return false;
    return RECOVERABLE_BLOCKED_REPLEN_REASONS.has(task.exceptionReason ?? null);
  }

  private isNoSourceReviewOnlyTask(task: ReplenTask): boolean {
    if (task.status !== "blocked") return false;
    if (task.blocksShipment === true) return false;
    if ((task.qtySourceUnits ?? 0) > 0 || (task.qtyTargetUnits ?? 0) > 0) return false;
    return task.exceptionReason === "no_source_stock" || task.exceptionReason === "no_source_variant";
  }

  private blockedTaskSourceMatches(task: ReplenTask, location: { isPickable?: unknown; locationType?: unknown }): boolean {
    const notes = (task.notes ?? "").toLowerCase();
    const isPickable = location.isPickable === true || location.isPickable === 1 || location.isPickable === "1";
    const locationType = String(location.locationType ?? "").toLowerCase();

    if (notes.includes("reserve locations")) {
      return !isPickable || locationType === "reserve" || locationType === "pallet";
    }
    if (notes.includes("pick locations")) {
      return isPickable || locationType === "pick";
    }
    if (task.replenMethod === "pallet_drop") {
      return !isPickable || locationType === "reserve" || locationType === "pallet";
    }
    if (task.replenMethod === "case_break") {
      return isPickable || locationType === "pick";
    }
    return true;
  }

  private async hasPositiveSourceStock(task: ReplenTask): Promise<boolean> {
    const sourceVariantId = task.sourceProductVariantId ?? task.pickProductVariantId;
    if (!sourceVariantId) return false;

    const result = await this.db.execute(sql`
      SELECT wl.is_pickable, wl.location_type
      FROM inventory.inventory_levels il
      JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
      WHERE il.product_variant_id = ${sourceVariantId}
        AND il.variant_qty > 0
    `);

    return (result.rows ?? []).some((row: any) => this.blockedTaskSourceMatches(task, {
      isPickable: row.is_pickable,
      locationType: row.location_type,
    }));
  }

  private async blockTaskExecutionFailure(task: ReplenTask, error: any): Promise<void> {
    const message = error?.message || String(error || "unknown_error");
    await this.db.update(replenTasks).set({
      status: "blocked",
      exceptionReason: "execute_failed",
      notes: `${task.notes || ""}\nExecute failed: ${message}`.trim(),
    }).where(eq(replenTasks.id, task.id));
  }

  private async getInventoryQty(
    productVariantId: number | null | undefined,
    warehouseLocationId: number | null | undefined,
  ): Promise<number> {
    if (!productVariantId || !warehouseLocationId) return 0;

    const [level] = await this.db
      .select({ variantQty: inventoryLevels.variantQty })
      .from(inventoryLevels)
      .where(and(
        eq(inventoryLevels.productVariantId, productVariantId),
        eq(inventoryLevels.warehouseLocationId, warehouseLocationId),
      ))
      .limit(1);

    return Number(level?.variantQty ?? 0);
  }

  private requiredSourceUnits(task: ReplenTask): number {
    return Math.max(1, Number(task.qtySourceUnits ?? 0));
  }

  private async blockTaskNoCurrentSource(task: ReplenTask, reason: string): Promise<void> {
    await this.db.update(replenTasks).set({
      status: "blocked",
      exceptionReason: "no_source_stock",
      notes: `${task.notes || ""}\nBlocked before execution: ${reason}`.trim(),
    }).where(eq(replenTasks.id, task.id));
  }

  private async reResolveTaskSourceBeforeExecute(task: ReplenTask, userId?: string): Promise<ReplenTask> {
    const sourceVariantId = task.sourceProductVariantId ?? task.pickProductVariantId;
    const requiredSourceUnits = this.requiredSourceUnits(task);
    const currentSourceQty = await this.getInventoryQty(sourceVariantId, task.fromLocationId);
    if (currentSourceQty >= requiredSourceUnits) return task;

    if (!task.pickProductVariantId || !task.toLocationId) {
      const reason = `current source has ${currentSourceQty}, needs ${requiredSourceUnits}, and task has no pick bin to re-resolve`;
      await this.blockTaskNoCurrentSource(task, reason);
      throw new Error(`source_stock_unavailable: ${reason}`);
    }

    const eval_ = await this.evaluateReplenNeed(task.pickProductVariantId, task.toLocationId, {
      ignoreTaskId: task.id,
    });

    if (eval_.status === "skip") {
      const reason = `re-evaluation skipped (${eval_.skipReason}) after source had ${currentSourceQty}, needs ${requiredSourceUnits}`;
      await this.db.update(replenTasks).set({
        status: "cancelled",
        completedAt: new Date(),
        notes: `${task.notes || ""}\nCancelled before execution: ${reason}`.trim(),
      }).where(eq(replenTasks.id, task.id));
      throw new Error(`replen_no_longer_needed: ${reason}`);
    }

    if (eval_.status === "dedup") {
      const reason = `superseded by active replen task #${eval_.existingTaskId}`;
      await this.db.update(replenTasks).set({
        status: "cancelled",
        completedAt: new Date(),
        notes: `${task.notes || ""}\nCancelled before execution: ${reason}`.trim(),
      }).where(eq(replenTasks.id, task.id));
      throw new Error(`replen_superseded: ${reason}`);
    }

    if (eval_.status === "needed_stockout" || !eval_.sourceLocation) {
      const reason = eval_.sourceResolutionIssue?.note
        ?? `no replacement source found after source had ${currentSourceQty}, needs ${requiredSourceUnits}`;
      await this.blockTaskNoCurrentSource(task, reason);
      throw new Error(`source_stock_unavailable: ${reason}`);
    }

    const resolvedSourceVariantId = eval_.resolvedSourceVariantId ?? task.pickProductVariantId;
    const resolvedSourceQty = await this.getInventoryQty(resolvedSourceVariantId, eval_.sourceLocation.id);
    if (resolvedSourceQty < Math.max(1, eval_.qtySourceUnits)) {
      const reason = `resolved source ${eval_.sourceVariant.sku ?? `#${resolvedSourceVariantId}`} at ${eval_.sourceLocation.code} has ${resolvedSourceQty}, needs ${eval_.qtySourceUnits}`;
      await this.blockTaskNoCurrentSource(task, reason);
      throw new Error(`source_stock_unavailable: ${reason}`);
    }

    const notes = [
      task.notes || "",
      `Re-resolved source before execution${userId ? ` by ${userId}` : ""}: ` +
        `from location #${task.fromLocationId} variant #${sourceVariantId} ` +
        `to ${eval_.sourceLocation.code} / ${eval_.sourceVariant.sku ?? `#${resolvedSourceVariantId}`}.`,
    ].filter(Boolean).join("\n");

    await this.db.update(replenTasks).set({
      fromLocationId: eval_.sourceLocation.id,
      sourceProductVariantId: resolvedSourceVariantId,
      qtySourceUnits: eval_.qtySourceUnits,
      qtyTargetUnits: eval_.qtyTargetUnits,
      replenMethod: eval_.params.replenMethod,
      exceptionReason: null,
      notes,
    }).where(eq(replenTasks.id, task.id));

    return await this.getTaskById(task.id) ?? {
      ...task,
      fromLocationId: eval_.sourceLocation.id,
      sourceProductVariantId: resolvedSourceVariantId,
      qtySourceUnits: eval_.qtySourceUnits,
      qtyTargetUnits: eval_.qtyTargetUnits,
      replenMethod: eval_.params.replenMethod,
      exceptionReason: null,
      notes,
    };
  }

  private async executeInlineTaskAutomatically(
    task: ReplenTask,
    userId: string | undefined,
    tag: string,
  ): Promise<{ task: ReplenTask; moved: number }> {
    try {
      const result = await this.executeTask(task.id, userId ?? "system:auto-replen");
      const finalTask = await this.getTaskById(task.id);
      console.log(`${tag} task ${task.id} executed, moved ${result.moved} units`);
      return { task: finalTask ?? task, moved: result.moved };
    } catch (err: any) {
      console.error(`${tag} executeTask failed for task ${task.id}:`, err?.message);
      await this.blockTaskExecutionFailure(task, err);
      throw err;
    }
  }

  private replenOrderTaskFields(context?: ReplenOrderContext): Pick<InsertReplenTask, "orderId" | "orderItemId" | "blocksShipment"> {
    return {
      orderId: context?.orderId ?? null,
      orderItemId: context?.orderItemId ?? null,
      blocksShipment: context?.blocksShipment === true,
    };
  }

  private appendOrderContextNote(notes: string, context?: ReplenOrderContext): string {
    if (!context?.orderId && !context?.orderItemId && !context?.orderNumber) {
      return notes;
    }
    const orderRef = context.orderNumber || (context.orderId ? `order #${context.orderId}` : "order");
    const itemRef = context.orderItemId ? ` item #${context.orderItemId}` : "";
    return `${notes}\nOrder link: ${orderRef}${itemRef}`;
  }

  // ---------------------------------------------------------------------------
  // SHARED RESOLUTION HELPERS
  // ---------------------------------------------------------------------------

  async loadLocationConfig(
    warehouseLocationId: number,
    productVariantId: number,
  ) {
    const locConfigVariant = await this.db
      .select().from(locationReplenConfig)
      .where(and(
        eq(locationReplenConfig.warehouseLocationId, warehouseLocationId),
        eq(locationReplenConfig.productVariantId, productVariantId),
        eq(locationReplenConfig.isActive, 1),
      )).limit(1);
    const locConfigWide = locConfigVariant.length > 0 ? null : (await this.db
      .select().from(locationReplenConfig)
      .where(and(
        eq(locationReplenConfig.warehouseLocationId, warehouseLocationId),
        isNull(locationReplenConfig.productVariantId),
        eq(locationReplenConfig.isActive, 1),
      )).limit(1))[0] || null;
    return locConfigVariant[0] || locConfigWide;
  }

  async resolveReplenParams(
    productVariantId: number,
    variant: ProductVariant,
    warehouseId: number | undefined,
    locConfig: any,
  ): Promise<ResolvedReplenParams> {
    const rule = await this.findRuleForVariant(productVariantId);
    const tierDefault = await this.findTierDefaultForVariant(
      variant.hierarchyLevel,
      warehouseId,
    );

    const triggerValue = (locConfig?.triggerValue != null ? parseFloat(locConfig.triggerValue) : null)
      ?? rule?.triggerValue ?? tierDefault?.triggerValue ?? null;
    const maxQty = locConfig?.maxQty ?? rule?.maxQty ?? tierDefault?.maxQty ?? null;
    const replenMethod = locConfig?.replenMethod ?? rule?.replenMethod ?? tierDefault?.replenMethod ?? "full_case";
    const priority = rule?.priority ?? tierDefault?.priority ?? 5;
    const sourceLocationType = rule?.sourceLocationType ?? tierDefault?.sourceLocationType ?? "reserve";
    const autoReplen = rule?.autoReplen ?? tierDefault?.autoReplen ?? 0;
    const sourceVariantId = rule?.sourceProductVariantId ?? null;
    const sourceHierarchyLevel = tierDefault?.sourceHierarchyLevel ?? null;
    const sourcePriority = rule?.sourcePriority ?? tierDefault?.sourcePriority ?? "fifo";

    return { triggerValue, maxQty, replenMethod, priority, sourceLocationType, autoReplen, sourceVariantId, sourceHierarchyLevel, sourcePriority };
  }

  private buildImplicitZeroLevel(
    productVariantId: number,
    warehouseLocationId: number,
  ): InventoryLevel {
    return {
      id: 0,
      warehouseLocationId,
      productVariantId,
      variantQty: 0,
      reservedQty: 0,
      pickedQty: 0,
      packedQty: 0,
      backorderQty: 0,
      updatedAt: new Date(0),
    } as InventoryLevel;
  }

  private async loadReplenEvaluationContext(
    productVariantId: number,
    warehouseLocationId: number,
    options?: ReplenEvaluationOptions,
  ): Promise<ReplenEvaluationContextResult> {
    const [level] = await this.db
      .select()
      .from(inventoryLevels)
      .where(and(
        eq(inventoryLevels.productVariantId, productVariantId),
        eq(inventoryLevels.warehouseLocationId, warehouseLocationId),
      ))
      .limit(1);

    const [location] = await this.db
      .select()
      .from(warehouseLocations)
      .where(eq(warehouseLocations.id, warehouseLocationId))
      .limit(1);
    if (!location || location.isPickable !== 1) {
      return { status: "skip", result: { status: "skip", skipReason: "location_not_pickable" } };
    }

    const [assignment] = await this.db
      .select({ id: productLocations.id })
      .from(productLocations)
      .where(and(
        eq(productLocations.productVariantId, productVariantId),
        eq(productLocations.warehouseLocationId, warehouseLocationId),
      ))
      .limit(1);
    if (!assignment) {
      return { status: "skip", result: { status: "skip", skipReason: "no_bin_assignment" } };
    }

    const [variant] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, productVariantId))
      .limit(1);
    if (!variant) {
      return { status: "skip", result: { status: "skip", skipReason: "variant_not_found" } };
    }

    const effectiveLevel = (level ?? this.buildImplicitZeroLevel(productVariantId, warehouseLocationId)) as InventoryLevel;
    const evaluatedQty = options?.currentQtyOverride ?? effectiveLevel.variantQty;

    return {
      status: "ready",
      context: {
        level: (level as InventoryLevel | undefined) ?? null,
        effectiveLevel,
        implicitZeroLevel: !level,
        location: location as WarehouseLocation,
        variant: variant as ProductVariant,
        evaluatedQty,
      },
    };
  }

  calculateQtyNeeded(maxQty: number | null, triggerValue: number, currentQty: number): number {
    return (maxQty ?? triggerValue * 2) - currentQty;
  }

  async checkThreshold(
    replenMethod: string,
    triggerValue: number,
    currentQty: number,
    productVariantId: number,
  ): Promise<{ belowThreshold: boolean; taskNotes: string }> {
    if (replenMethod === "pallet_drop") {
      const velocity = await this.computeVariantVelocity(productVariantId);
      if (velocity === 0) return { belowThreshold: false, taskNotes: "" };
      const coverageDays = currentQty / velocity;
      if (coverageDays >= triggerValue) return { belowThreshold: false, taskNotes: "" };
      return {
        belowThreshold: true,
        taskNotes: `Auto-triggered (pallet_drop): velocity=${velocity.toFixed(1)}/day, coverage=${coverageDays.toFixed(1)}d, trigger=${triggerValue}d`,
      };
    }
    if (currentQty > triggerValue) return { belowThreshold: false, taskNotes: "" };
    return {
      belowThreshold: true,
      taskNotes: `Auto-triggered: onHand=${currentQty}, triggerValue=${triggerValue}`,
    };
  }

  private async evaluateThresholdDecision(
    replenMethod: string,
    triggerValue: number,
    evaluatedQty: number,
    productVariantId: number,
    options?: ReplenEvaluationOptions,
  ): Promise<ReplenThresholdDecision> {
    const threshold = await this.checkThreshold(replenMethod, triggerValue, evaluatedQty, productVariantId);
    const forceThreshold = options?.forceWhenAtOrBelowZero === true && evaluatedQty <= 0;
    const taskNotes = forceThreshold && !threshold.belowThreshold
      ? `Auto-triggered: active demand exists and pick bin is empty (onHand=${evaluatedQty}, triggerValue=${triggerValue})`
      : threshold.taskNotes;

    return {
      thresholdMet: threshold.belowThreshold || forceThreshold,
      taskNotes,
    };
  }

  private async resolveReplenSourceForNeed(args: {
    tag: string;
    pickVariant: ProductVariant;
    pickVariantId: number;
    warehouseId: number | undefined;
    parentLocationId: number | null | undefined;
    sourceLocationType: string;
    sourcePriority: string;
    sourceHierarchyLevel: number | null;
    qtyNeeded: number;
    configuredSourceVariantId: number | null;
    replenMethod: string;
  }): Promise<ReplenSourceDecision> {
    let resolvedSourceVariantId = args.configuredSourceVariantId;
    let resolvedReplenMethod = args.replenMethod;
    let sourceResolutionIssue: SourceResolutionIssue | null = null;
    let sourceLocation = resolvedSourceVariantId != null
      ? await this.findSourceLocation(
          resolvedSourceVariantId,
          args.warehouseId,
          args.sourceLocationType,
          args.parentLocationId,
          args.sourcePriority,
        )
      : null;

    if (!sourceLocation && resolvedSourceVariantId != null) {
      const [configuredSource] = await this.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, resolvedSourceVariantId))
        .limit(1);
      sourceResolutionIssue = {
        reason: "no_source_stock",
        note: `Configured source variant ${configuredSource?.sku ?? `#${resolvedSourceVariantId}`} has no stock in ${args.sourceLocationType} locations`,
      };
    }

    if (!sourceLocation && resolvedSourceVariantId == null) {
      const sourceResolution = await this.resolveEligibleSourceCandidate({
        pickVariant: args.pickVariant,
        pickVariantId: args.pickVariantId,
        warehouseId: args.warehouseId,
        sourceLocationType: args.sourceLocationType,
        parentLocationId: args.parentLocationId,
        sourcePriority: args.sourcePriority,
        sourceHierarchyLevel: args.sourceHierarchyLevel,
        qtyNeeded: args.qtyNeeded,
      });

      if (sourceResolution.status === "found") {
        resolvedSourceVariantId = sourceResolution.variant.id;
        sourceLocation = sourceResolution.location;
        if (resolvedSourceVariantId !== args.pickVariantId && resolvedReplenMethod === "full_case") {
          resolvedReplenMethod = "case_break";
        }
        console.log(
          `${args.tag} SOURCE: ${sourceResolution.note}; selected ${sourceResolution.variant.sku} ` +
          `(id=${sourceResolution.variant.id}) at ${sourceLocation.code}`,
        );
      } else {
        sourceResolutionIssue = sourceResolution.issue;
      }
    }

    return {
      sourceResolutionIssue,
      sourceLocation: sourceLocation as WarehouseLocation | null,
      resolvedSourceVariantId,
      resolvedReplenMethod,
    };
  }

  // ---------------------------------------------------------------------------
  // CORE EVALUATION — single source of truth for "does this bin need replen?"
  // ---------------------------------------------------------------------------

  private async evaluateReplenNeed(
    productVariantId: number,
    warehouseLocationId: number,
    options?: ReplenEvaluationOptions,
  ): Promise<ReplenEvalResult> {
    const _tag = `[Replen evaluate] variant=${productVariantId} loc=${warehouseLocationId}`;

    const contextResult = await this.loadReplenEvaluationContext(productVariantId, warehouseLocationId, options);
    if (contextResult.status === "skip") return contextResult.result;

    const { effectiveLevel, implicitZeroLevel, location, variant, evaluatedQty } = contextResult.context;
    console.log(`${_tag} variant=${variant.sku} loc=${location.code} onHand=${effectiveLevel.variantQty} evaluatedQty=${evaluatedQty} hierarchyLevel=${variant.hierarchyLevel}${implicitZeroLevel ? " implicitZeroLevel=true" : ""}`);

    const whSettings = await this.getSettingsForWarehouse(location.warehouseId ?? undefined);
    const locConfig = await this.loadLocationConfig(warehouseLocationId, productVariantId);
    const params = await this.resolveReplenParams(productVariantId, variant, location.warehouseId ?? undefined, locConfig);

    const { triggerValue, maxQty, replenMethod, sourceLocationType, autoReplen, sourcePriority } = params;
    let resolvedSourceVariantId = params.sourceVariantId;
    let resolvedReplenMethod = replenMethod;

    const existingTask = await this.findActiveTaskForPickBin(productVariantId, warehouseLocationId);
    if (existingTask && existingTask.id !== options?.ignoreTaskId)
      return { status: "dedup", existingTaskId: existingTask.id, existingTask, params, triggerValue, evaluatedQty };

    if (triggerValue == null || triggerValue < 0)
      return { status: "skip", skipReason: "no_trigger_value", params, triggerValue, evaluatedQty };

    const threshold = await this.evaluateThresholdDecision(
      resolvedReplenMethod,
      triggerValue,
      evaluatedQty,
      productVariantId,
      options,
    );
    if (!threshold.thresholdMet) return { status: "skip", skipReason: "above_threshold", params, triggerValue, evaluatedQty };
    console.log(`${_tag} THRESHOLD MET: method=${resolvedReplenMethod}`);

    const qtyNeeded = this.calculateQtyNeeded(maxQty, triggerValue!, evaluatedQty);
    const sourceDecision = await this.resolveReplenSourceForNeed({
      tag: _tag,
      pickVariant: variant,
      pickVariantId: productVariantId,
      warehouseId: location.warehouseId ?? undefined,
      parentLocationId: location.parentLocationId,
      sourceLocationType,
      sourcePriority,
      sourceHierarchyLevel: params.sourceHierarchyLevel,
      qtyNeeded,
      configuredSourceVariantId: resolvedSourceVariantId,
      replenMethod: resolvedReplenMethod,
    });
    const {
      sourceResolutionIssue,
      sourceLocation,
      resolvedSourceVariantId: sourceVariantId,
      resolvedReplenMethod: sourceReplenMethod,
    } = sourceDecision;
    resolvedSourceVariantId = sourceVariantId;
    resolvedReplenMethod = sourceReplenMethod;

    const rule = await this.findRuleForVariant(productVariantId);

    const sourceVariant = resolvedSourceVariantId != null
      ? (await this.db.select().from(productVariants).where(eq(productVariants.id, resolvedSourceVariantId)).limit(1))[0] ?? variant
      : variant;

    if (!sourceLocation) {
      const { shouldAutoExecute, executionMode } = this.resolveAutoExecute(
        autoReplen === 1 ? 1 : autoReplen === 2 ? 2 : null, null, whSettings, 0,
      );
      return {
        status: "needed_stockout",
        level: effectiveLevel, location: location as WarehouseLocation, variant: variant as ProductVariant,
        whSettings, params: { ...params, replenMethod: resolvedReplenMethod, sourceVariantId: resolvedSourceVariantId },
        taskNotes: threshold.taskNotes,
        sourceResolutionIssue, rule, sourceLocation: null,
        resolvedSourceVariantId, sourceVariant: sourceVariant as ProductVariant,
        qtySourceUnits: 0, qtyTargetUnits: 0,
        executionMode, shouldAutoExecute,
        triggerValue, evaluatedQty,
      };
    }

    const qtySourceUnits = Math.max(1, Math.ceil(qtyNeeded / sourceVariant.unitsPerVariant));
    const qtyTargetUnits = qtySourceUnits * sourceVariant.unitsPerVariant;

    const { shouldAutoExecute, executionMode } = this.resolveAutoExecute(
      autoReplen === 1 ? 1 : autoReplen === 2 ? 2 : null, null, whSettings, qtyTargetUnits,
    );

    console.log(`${_tag} RESULT: from=${sourceLocation.code} qty=${qtySourceUnits}x${sourceVariant.unitsPerVariant}=${qtyTargetUnits} method=${resolvedReplenMethod}`);

    return {
      status: "needed_with_source",
      level: effectiveLevel, location: location as WarehouseLocation, variant: variant as ProductVariant,
      whSettings, params: { ...params, replenMethod: resolvedReplenMethod, sourceVariantId: resolvedSourceVariantId },
      taskNotes: threshold.taskNotes, rule, sourceLocation: sourceLocation as WarehouseLocation,
      resolvedSourceVariantId, sourceVariant: sourceVariant as ProductVariant,
      qtySourceUnits, qtyTargetUnits,
      executionMode, shouldAutoExecute,
      triggerValue, evaluatedQty,
    };
  }

  // ---------------------------------------------------------------------------
  // EVENT-DRIVEN REPLEN CHECK — call after any inventory change on a pickable bin
  // ---------------------------------------------------------------------------

  async checkReplenForLocation(warehouseLocationId: number): Promise<void> {
    const [location] = await this.db
      .select()
      .from(warehouseLocations)
      .where(eq(warehouseLocations.id, warehouseLocationId))
      .limit(1);
    if (!location || location.isPickable !== 1) return;

    const assignments = await this.db
      .select({ productVariantId: productLocations.productVariantId })
      .from(productLocations)
      .where(eq(productLocations.warehouseLocationId, warehouseLocationId));

    for (const { productVariantId } of assignments) {
      try {
        await this.checkAndTriggerAfterPick(
          productVariantId,
          warehouseLocationId,
          "event_driven",
        );
      } catch (err: any) {
        console.warn(`[Replen] checkReplenForLocation: variant=${productVariantId} loc=${warehouseLocationId} error:`, err?.message);
      }
    }
  }

  /**
   * Called globally when inventory for a product changes (e.g. newly received).
   * It clears any stalled stockout blocks and checks if downstream pick bins
   * are now eligible for auto-replenishment from this new source stock.
   */
  async reevaluateReplenForProduct(productId: number): Promise<void> {
    const variants = await this.db.select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.productId, productId));

    const variantIds = variants.map((v: any) => v.id).filter((id: unknown): id is number => typeof id === "number");

    if (variantIds.length > 0) {
      await this.db
        .update(replenTasks)
        .set({
          productId,
          notes: sql`TRIM(BOTH E'\n' FROM COALESCE(${replenTasks.notes}, '') || E'\nBackfilled product_id during replen re-evaluation.')`,
        })
        .where(and(
          isNull(replenTasks.productId),
          or(
            inArray(replenTasks.pickProductVariantId, variantIds),
            inArray(replenTasks.sourceProductVariantId, variantIds),
          ),
        ));
    }

    const productMatch = variantIds.length > 0
      ? or(
          eq(replenTasks.productId, productId),
          inArray(replenTasks.pickProductVariantId, variantIds),
          inArray(replenTasks.sourceProductVariantId, variantIds),
        )
      : eq(replenTasks.productId, productId);

    const blockedTasks = await this.db.select().from(replenTasks)
      .where(
        and(
          productMatch,
          eq(replenTasks.status, "blocked"),
          isNull(replenTasks.dependsOnTaskId)
        )
      );

    for (const task of blockedTasks) {
      if (!this.isRecoverableBlockedTask(task as ReplenTask)) {
        continue;
      }

      const sourceNowAvailable = await this.hasPositiveSourceStock(task as ReplenTask);
      if (!sourceNowAvailable) {
        if (!task.exceptionReason) {
          await this.db
            .update(replenTasks)
            .set({
              exceptionReason: "no_source_stock",
              notes: `${task.notes || ""}\nClassified during replen re-evaluation: still no source stock.`.trim(),
            })
            .where(eq(replenTasks.id, task.id));
        }
        continue;
      }

      await this.db
        .update(replenTasks)
        .set({
          status: "cancelled",
          exceptionReason: task.exceptionReason ?? "no_source_stock",
          notes: `${task.notes || ""}\nCancelled to re-evaluate due to inventory change.`.trim()
        })
        .where(eq(replenTasks.id, task.id));
      
      // Also call checkReplenForLocation on the target destination, because we just cancelled a task for it
      try {
        await this.checkReplenForLocation(task.toLocationId);
      } catch (err: any) {
        console.warn(`[Replen] Failed to re-evaluate task target loc ${task.toLocationId}:`, err?.message);
      }
    }

    // 2. Find all variants of this product and their pick bins, and re-evaluate
    if (variantIds.length === 0) return;

    const assignments = await this.db.select({ warehouseLocationId: productLocations.warehouseLocationId })
      .from(productLocations)
      .where(inArray(productLocations.productVariantId, variantIds));

    const locIds = Array.from(new Set(assignments.map((a: any) => a.warehouseLocationId)));
    for (const locId of locIds) {
      try {
        await this.checkReplenForLocation(locId as number);
      } catch (err: any) {
         console.warn(`[Replen] Failed to re-evaluate product pick loc ${locId}:`, err?.message);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. EXECUTE TASK -- move stock from bulk to pick location
  // ---------------------------------------------------------------------------

  /**
   * Execute a pending replen task by moving inventory from the source (bulk)
   * location to the destination (pick) location.
   *
   * Supports two replenishment methods:
   * - **case_break**: The source variant (e.g., a case of 12) is broken into
   *   the pick variant (e.g., individual eaches). The source unit is consumed
   *   and the equivalent base units appear at the pick location.
   * - **full_case** / default: The source variant is transferred directly to
   *   the pick location without conversion.
   *
   * On success the task status is set to "completed" and qtyCompleted is
   * updated with the number of base units actually moved.
   *
   * @param taskId  Primary key of the replen task.
   * @param userId  Optional -- who performed the execution (for audit).
   * @returns Object with the count of base units moved.
   * @throws If the task is not found or is not in a pending/assigned state.
   */
  async executeTask(
    taskId: number,
    userId?: string,
  ): Promise<{ moved: number }> {
    // Get task details
    const [task] = await this.db
      .select()
      .from(replenTasks)
      .where(eq(replenTasks.id, taskId))
      .limit(1);

    if (!task) {
      throw new Error(`Replen task ${taskId} not found`);
    }

    if (!["pending", "assigned", "in_progress"].includes(task.status)) {
      throw new Error(
        `Replen task ${taskId} cannot be executed (status: ${task.status})`,
      );
    }

    const executableTask = await this.reResolveTaskSourceBeforeExecute(task as ReplenTask, userId);

    // Load source and pick variants
    const [sourceVariant] = executableTask.sourceProductVariantId
      ? await this.db
          .select()
          .from(productVariants)
          .where(eq(productVariants.id, executableTask.sourceProductVariantId))
          .limit(1)
      : [null];

    const [pickVariant] = executableTask.pickProductVariantId
      ? await this.db
          .select()
          .from(productVariants)
          .where(eq(productVariants.id, executableTask.pickProductVariantId))
          .limit(1)
      : [null];

    // Read replen method from the task itself (persisted at creation).
    // Fall back to rule lookup for legacy tasks that predate the column.
    let replenMethod = (executableTask as any).replenMethod || "full_case";
    if (replenMethod === "full_case" && executableTask.replenRuleId) {
      // Legacy fallback: task didn't have replenMethod, try the linked rule
      const [rule] = await this.db
        .select()
        .from(replenRules)
        .where(eq(replenRules.id, executableTask.replenRuleId))
        .limit(1);
      if (rule?.replenMethod) replenMethod = rule.replenMethod;
    }

    const movedBaseUnits = await this.db.transaction(async (tx: any) => {
      const lockedTaskResult = await tx.execute(sql`
        SELECT *
        FROM inventory.replen_tasks
        WHERE id = ${taskId}
        FOR UPDATE
      `);

      const lockedTask = lockedTaskResult.rows?.[0];
      if (!lockedTask) {
        throw new Error(`Replen task ${taskId} not found`);
      }

      if (!["pending", "assigned", "in_progress"].includes(lockedTask.status)) {
        throw new Error(
          `Replen task ${taskId} cannot be executed (status: ${lockedTask.status})`,
        );
      }

      let moved = 0;
      const invTx = this.inventoryUseCases.withTx(tx);

      if (
        replenMethod === "case_break" &&
        sourceVariant &&
        pickVariant &&
        sourceVariant.id !== pickVariant.id
      ) {
        const baseUnitsFromSource = executableTask.qtySourceUnits * sourceVariant.unitsPerVariant;
        const pickVariantUnits = Math.floor(baseUnitsFromSource / pickVariant.unitsPerVariant);
        const remainder = baseUnitsFromSource - (pickVariantUnits * pickVariant.unitsPerVariant);

        if (pickVariantUnits <= 0) {
          throw new Error(
            `Case break would produce 0 pick units: ${executableTask.qtySourceUnits} x ${sourceVariant.unitsPerVariant} ` +
            `base units / ${pickVariant.unitsPerVariant} per pick unit`,
          );
        }

        const breakNotes = `Case break: ${executableTask.qtySourceUnits} x ${sourceVariant.name} -> ${pickVariantUnits} x ${pickVariant.name}` +
          (remainder > 0 ? ` (${remainder} base units remainder credited back to source)` : "");

        if (remainder > 0 && pickVariant.unitsPerVariant > 1) {
          // The source units don't divide evenly into pick units. Find the
          // product's base variant (unitsPerVariant=1) to credit the remainder.
          const baseVariantRows = await tx.execute(sql`
            SELECT id, name, sku, units_per_variant
            FROM catalog.product_variants
            WHERE product_id = ${pickVariant.productId}
              AND units_per_variant = 1
              AND is_active = true
            LIMIT 1
          `);
          const baseVariant = (baseVariantRows.rows as any[])[0];
          if (!baseVariant) {
            throw new Error(
              `Case break produces ${remainder} indivisible base units (no base-unit variant found for product ${pickVariant.productId}). ` +
              `Create a variant with unitsPerVariant=1, or choose a divisible break quantity.`,
            );
          }
        }

        // Decrement source variant
        await invTx.adjustInventory({
          productVariantId: sourceVariant.id,
          warehouseLocationId: executableTask.fromLocationId,
          qtyDelta: -executableTask.qtySourceUnits,
          reason: breakNotes,
          userId: userId ?? undefined,
        });

        // Increment target variant
        await invTx.adjustInventory({
          productVariantId: pickVariant.id,
          warehouseLocationId: executableTask.toLocationId,
          qtyDelta: pickVariantUnits,
          reason: `Replen case-break to pick location` +
            (remainder > 0 ? ` (${remainder} base units remainder credited back to source)` : ""),
          userId: userId ?? undefined,
        });

        // Credit remainder back to source — conservation of units.
        // If breaking 1 case of 12 into packs of 10, the 2 leftover base
        // units stay at the source as the smallest sellable variant.
        if (remainder > 0) {
          if (pickVariant.unitsPerVariant === 1) {
            // Pick variant IS the base unit — credit directly
            await invTx.adjustInventory({
              productVariantId: pickVariant.id,
              warehouseLocationId: executableTask.fromLocationId,
              qtyDelta: remainder,
              reason: `Case-break remainder: ${remainder} x ${pickVariant.name} at source`,
              userId: userId ?? undefined,
            });
          } else {
            // Remainder can't form complete pick units — credit as base variant
            const baseVariantRows = await tx.execute(sql`
              SELECT id, name FROM catalog.product_variants
              WHERE product_id = ${pickVariant.productId}
                AND units_per_variant = 1 AND is_active = true
              LIMIT 1
            `);
            const baseVariant = (baseVariantRows.rows as any[])[0];
            await invTx.adjustInventory({
              productVariantId: baseVariant.id,
              warehouseLocationId: executableTask.fromLocationId,
              qtyDelta: remainder,
              reason: `Case-break remainder: ${remainder} base units credited as ${baseVariant.name}`,
              userId: userId ?? undefined,
            });
          }
        }

        moved = baseUnitsFromSource;
      } else {
        const variantId = executableTask.sourceProductVariantId ?? executableTask.pickProductVariantId!;
        const variant = sourceVariant ?? pickVariant;
        const baseUnits = executableTask.qtySourceUnits * (variant?.unitsPerVariant ?? 1);

        await invTx.transfer({
          productVariantId: variantId,
          fromLocationId: executableTask.fromLocationId,
          toLocationId: executableTask.toLocationId,
          qty: executableTask.qtySourceUnits,
          userId,
          notes: `Replen task #${taskId} (full_case)`,
        });

        moved = baseUnits;
      }

      await tx
        .update(replenTasks)
        .set({
          status: "completed",
          qtyCompleted: moved,
          completedAt: new Date(),
          assignedTo: userId ?? executableTask.assignedTo,
        })
        .where(eq(replenTasks.id, taskId));

      return moved;
    });

    await this.unblockDependentTasks(taskId, userId);

    return { moved: movedBaseUnits };
  }

  /**
   * After a task completes, check for blocked tasks that depend on it.
   * Unblock them and auto-execute if configured.
   */
  async unblockDependentTasks(completedTaskId: number, userId?: string): Promise<void> {
    const dependents = await this.db
      .select()
      .from(replenTasks)
      .where(
        and(
          eq(replenTasks.dependsOnTaskId, completedTaskId),
          eq(replenTasks.status, "blocked"),
        ),
      );

    for (const dep of dependents) {
      await this.db
        .update(replenTasks)
        .set({
          status: "pending",
          dependsOnTaskId: null,
          notes: `${dep.notes || ""}\nUnblocked by completed task #${completedTaskId}`,
        })
        .where(eq(replenTasks.id, dep.id));

      // Auto-execute if the dependent task has autoReplen=1
      if (dep.autoReplen === 1) {
        try {
          await this.executeTask(dep.id, userId ?? "system:auto-replen");
        } catch (err: any) {
          console.warn(`[Replen] Auto-execute of unblocked task ${dep.id} failed:`, err?.message);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. GET ACTIVE TASKS -- filtered query
  // ---------------------------------------------------------------------------

  /**
   * Retrieve replen tasks filtered by warehouse and/or status.
   *
   * @param warehouseId  Optional -- filter to a single warehouse.
   * @param status       Optional -- filter to a specific task status
   *                     (pending, assigned, in_progress, completed, cancelled, blocked).
   * @returns Array of matching replen tasks, ordered by priority then creation date.
   */
  async getActiveTasks(
    warehouseId?: number,
    status?: string,
  ): Promise<ReplenTask[]> {
    const conditions: any[] = [];

    if (warehouseId != null) {
      conditions.push(eq(replenTasks.warehouseId, warehouseId));
    }

    if (status != null) {
      conditions.push(eq(replenTasks.status, status));
    }

    const query = conditions.length > 0
      ? this.db
          .select()
          .from(replenTasks)
          .where(and(...conditions))
          .orderBy(replenTasks.priority, replenTasks.createdAt)
      : this.db
          .select()
          .from(replenTasks)
          .orderBy(replenTasks.priority, replenTasks.createdAt);

    return query;
  }

  // ---------------------------------------------------------------------------
  // 4. CANCEL TASK
  // ---------------------------------------------------------------------------

  /**
   * Cancel a replen task by setting its status to "cancelled".
   *
   * Only tasks that are not already completed or cancelled can be cancelled.
   *
   * @param taskId  Primary key of the replen task.
   * @param userId  Optional -- who cancelled the task (for audit trail).
   * @throws If the task is not found or is already completed/cancelled.
   */
  async cancelTask(taskId: number, userId?: string): Promise<void> {
    const [task] = await this.db
      .select()
      .from(replenTasks)
      .where(eq(replenTasks.id, taskId))
      .limit(1);

    if (!task) {
      throw new Error(`Replen task ${taskId} not found`);
    }

    if (task.status === "completed" || task.status === "cancelled") {
      throw new Error(
        `Replen task ${taskId} cannot be cancelled (status: ${task.status})`,
      );
    }

    await this.db
      .update(replenTasks)
      .set({
        status: "cancelled",
        completedAt: new Date(),
        notes: task.notes
          ? `${task.notes}\nCancelled${userId ? ` by ${userId}` : ""}`
          : `Cancelled${userId ? ` by ${userId}` : ""}`,
      })
      .where(eq(replenTasks.id, taskId));
  }

  async cleanupHealthIssues(params: {
    mode?: ReplenHealthCleanupMode;
    taskId?: number | null;
    warehouseId?: number | null;
    limit?: number;
    userId?: string;
  } = {}): Promise<ReplenHealthCleanupResult> {
    const mode = params.mode ?? "all";
    if (!["all", "stale_no_demand", "duplicates", "inline_execution"].includes(mode)) {
      throw new Error(`Unsupported replen cleanup mode: ${mode}`);
    }

    const result: ReplenHealthCleanupResult = {
      mode,
      executedInline: 0,
      failedInline: 0,
      skippedInline: 0,
      cancelledStaleNoDemand: 0,
      cancelledStaleBacklog: 0,
      cancelledDuplicates: 0,
      executedInlineTaskIds: [],
      failedInlineTaskIds: [],
      skippedInlineTaskIds: [],
      cancelledStaleNoDemandTaskIds: [],
      cancelledStaleBacklogTaskIds: [],
      cancelledDuplicateTaskIds: [],
      keptDuplicateTaskIds: [],
    };

    if (mode === "all" || mode === "stale_no_demand") {
      const taskIds = await this.cancelStaleNoDemandTasks(params);
      const backlogTaskIds = await this.cancelStaleNoDemandBacklogTasks(params);
      result.cancelledStaleNoDemand = taskIds.length;
      result.cancelledStaleBacklog = backlogTaskIds.length;
      result.cancelledStaleNoDemandTaskIds = taskIds;
      result.cancelledStaleBacklogTaskIds = backlogTaskIds;
    }

    if (mode === "all" || mode === "duplicates") {
      const duplicateResult = await this.cancelDuplicateActiveTasks(params);
      result.cancelledDuplicates = duplicateResult.cancelledTaskIds.length;
      result.cancelledDuplicateTaskIds = duplicateResult.cancelledTaskIds;
      result.keptDuplicateTaskIds = duplicateResult.keptTaskIds;
    }

    if (mode === "all" || mode === "inline_execution") {
      const inlineResult = await this.executePendingInlineTasks(params);
      result.executedInline = inlineResult.executedTaskIds.length;
      result.failedInline = inlineResult.failedTaskIds.length;
      result.skippedInline = inlineResult.skippedTaskIds.length;
      result.executedInlineTaskIds = inlineResult.executedTaskIds;
      result.failedInlineTaskIds = inlineResult.failedTaskIds;
      result.skippedInlineTaskIds = inlineResult.skippedTaskIds;
    }

    return result;
  }

  private cleanupLimit(limit?: number): number {
    return Math.min(250, Math.max(1, Number.isFinite(limit) ? Math.floor(limit as number) : 50));
  }

  private async executePendingInlineTasks(params: {
    taskId?: number | null;
    warehouseId?: number | null;
    limit?: number;
    userId?: string;
  }): Promise<{ executedTaskIds: number[]; failedTaskIds: number[]; skippedTaskIds: number[] }> {
    const conditions = [
      inArray(replenTasks.status, EXECUTABLE_REPLEN_TASK_STATUSES),
      eq(replenTasks.executionMode, "inline"),
      isNull(replenTasks.dependsOnTaskId),
    ];

    if (params.taskId) {
      conditions.push(eq(replenTasks.id, params.taskId));
    }
    if (params.warehouseId != null) {
      conditions.push(eq(replenTasks.warehouseId, params.warehouseId));
    }

    const tasks = await this.db
      .select()
      .from(replenTasks)
      .where(and(...conditions))
      .orderBy(asc(replenTasks.createdAt), asc(replenTasks.id))
      .limit(this.cleanupLimit(params.limit));

    const executedTaskIds: number[] = [];
    const failedTaskIds: number[] = [];
    const skippedTaskIds: number[] = [];
    const userId = params.userId ?? "system:auto-replen-recovery";

    for (const task of tasks as ReplenTask[]) {
      try {
        const revalidatedTask = await this.revalidateInlineTaskForRecovery(task, userId);
        if (!revalidatedTask) {
          skippedTaskIds.push(task.id);
          continue;
        }

        await this.executeInlineTaskAutomatically(revalidatedTask, userId, "[Replen inlineRecovery]");
        executedTaskIds.push(revalidatedTask.id);
      } catch {
        failedTaskIds.push(task.id);
      }
    }

    return { executedTaskIds, failedTaskIds, skippedTaskIds };
  }

  private async revalidateInlineTaskForRecovery(
    task: ReplenTask,
    userId: string,
  ): Promise<ReplenTask | null> {
    if (!task.pickProductVariantId || !task.toLocationId) return null;

    const activeDemandLines = await this.countActivePendingDemandLines(task);
    const eval_ = await this.evaluateReplenNeed(task.pickProductVariantId, task.toLocationId, {
      ignoreTaskId: task.id,
      forceWhenAtOrBelowZero: activeDemandLines > 0,
    });

    if (eval_.status !== "needed_with_source") return null;
    if (!(eval_.shouldAutoExecute || eval_.executionMode === "inline")) return null;
    if (!eval_.sourceLocation) return null;

    const resolvedSourceVariantId = eval_.resolvedSourceVariantId ?? task.pickProductVariantId;
    const sourceQty = await this.getInventoryQty(resolvedSourceVariantId, eval_.sourceLocation.id);
    if (sourceQty < Math.max(1, eval_.qtySourceUnits)) {
      await this.blockTaskNoCurrentSource(
        task,
        `revalidated source ${eval_.sourceLocation.code} has ${sourceQty}, needs ${eval_.qtySourceUnits}`,
      );
      throw new Error("source_stock_unavailable");
    }

    const notes = [
      task.notes || "",
      `Revalidated inline recovery${userId ? ` by ${userId}` : ""}: ` +
        `${activeDemandLines} active demand line${activeDemandLines === 1 ? "" : "s"}, ` +
        `source ${eval_.sourceLocation.code}, qty ${eval_.qtySourceUnits}.`,
    ].filter(Boolean).join("\n");

    await this.db.update(replenTasks).set({
      fromLocationId: eval_.sourceLocation.id,
      sourceProductVariantId: resolvedSourceVariantId,
      qtySourceUnits: eval_.qtySourceUnits,
      qtyTargetUnits: eval_.qtyTargetUnits,
      replenMethod: eval_.params.replenMethod,
      exceptionReason: null,
      notes,
    }).where(eq(replenTasks.id, task.id));

    return await this.getTaskById(task.id) ?? {
      ...task,
      fromLocationId: eval_.sourceLocation.id,
      sourceProductVariantId: resolvedSourceVariantId,
      qtySourceUnits: eval_.qtySourceUnits,
      qtyTargetUnits: eval_.qtyTargetUnits,
      replenMethod: eval_.params.replenMethod,
      exceptionReason: null,
      notes,
    };
  }

  async queueMissingPickBinReplen(params: {
    mode?: MissingPickBinReplenQueueResult["mode"];
    variantId?: number | null;
    locationId?: number | null;
    warehouseId?: number | null;
    limit?: number;
  } = {}): Promise<MissingPickBinReplenQueueResult> {
    const limit = this.cleanupLimit(params.limit);
    const variantFilter = params.variantId ? sql`AND pv.id = ${params.variantId}` : sql``;
    const locationFilter = params.locationId ? sql`AND wl.id = ${params.locationId}` : sql``;
    const warehouseFilter = params.warehouseId ? sql`AND wl.warehouse_id = ${params.warehouseId}` : sql``;

    const candidatesResult = await this.db.execute(sql`
      SELECT
        pv.id AS variant_id,
        pv.sku,
        wl.id AS location_id,
        wl.code AS location_code,
        COALESCE(demand.active_pending_lines, 0)::int AS active_pending_lines
      FROM warehouse.product_locations pl
      JOIN warehouse.warehouse_locations wl ON wl.id = pl.warehouse_location_id
      JOIN catalog.product_variants pv ON pv.id = pl.product_variant_id
      LEFT JOIN inventory.inventory_levels il
        ON il.warehouse_location_id = wl.id
       AND il.product_variant_id = pv.id
      LEFT JOIN LATERAL (
        SELECT *
        FROM inventory.location_replen_config lrc
        WHERE lrc.warehouse_location_id = wl.id
          AND (lrc.product_variant_id = pv.id OR lrc.product_variant_id IS NULL)
          AND lrc.is_active = 1
        ORDER BY CASE WHEN lrc.product_variant_id = pv.id THEN 0 ELSE 1 END
        LIMIT 1
      ) loc_config ON true
      LEFT JOIN LATERAL (
        SELECT *
        FROM inventory.replen_rules rr
        WHERE rr.pick_product_variant_id = pv.id
          AND rr.is_active = 1
        LIMIT 1
      ) rule_config ON true
      LEFT JOIN LATERAL (
        SELECT *
        FROM inventory.replen_tier_defaults rtd
        WHERE rtd.hierarchy_level = pv.hierarchy_level
          AND (rtd.warehouse_id = wl.warehouse_id OR rtd.warehouse_id IS NULL)
          AND rtd.is_active = 1
        ORDER BY CASE WHEN rtd.warehouse_id = wl.warehouse_id THEN 0 ELSE 1 END
        LIMIT 1
      ) tier_config ON true
      CROSS JOIN LATERAL (
        SELECT
          COALESCE(loc_config.replen_method, rule_config.replen_method, tier_config.replen_method, 'full_case') AS replen_method,
          COALESCE(loc_config.trigger_value::numeric, rule_config.trigger_value::numeric, tier_config.trigger_value::numeric) AS trigger_value,
          COALESCE(rule_config.source_location_type, tier_config.source_location_type, 'reserve') AS source_location_type,
          rule_config.source_product_variant_id AS source_variant_id,
          tier_config.source_hierarchy_level AS source_hierarchy_level
      ) effective
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(ABS(it.variant_qty_delta)), 0)::numeric / 14 AS daily_velocity
        FROM inventory.inventory_transactions it
        WHERE it.product_variant_id = pv.id
          AND it.transaction_type = 'pick'
          AND it.created_at > NOW() - MAKE_INTERVAL(days => 14)
      ) velocity ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS active_pending_lines
        FROM (
          SELECT oi.id::text AS demand_id
          FROM wms.order_items oi
          JOIN wms.orders o
            ON o.id = oi.order_id
           AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
          WHERE oi.sku = pv.sku
            AND oi.status = 'pending'
            AND oi.requires_shipping = 1

          UNION ALL

          SELECT 'allocation_exception:' || ae.id::text AS demand_id
          FROM wms.allocation_exceptions ae
          JOIN wms.orders o
            ON o.id = ae.order_id
           AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
          WHERE ae.sku = pv.sku
            AND ae.status NOT IN ('resolved', 'resolved_inline', 'cancelled')
            AND (
              ae.status = 'blocked'
              OR LOWER(COALESCE(ae.metadata->>'shipmentBlocking', 'false')) = 'true'
            )
        ) demand_line
      ) demand ON true
      WHERE pl.status = 'active'
        AND pl.is_primary = 1
        AND wl.is_pickable = 1
        AND wl.location_type = 'pick'
        AND COALESCE(il.variant_qty, 0) <= 0
        AND effective.trigger_value IS NOT NULL
        AND (
          effective.replen_method <> 'pallet_drop'
          OR COALESCE(demand.active_pending_lines, 0) > 0
          OR (
            COALESCE(velocity.daily_velocity, 0) > 0
            AND (COALESCE(il.variant_qty, 0)::numeric / velocity.daily_velocity) < effective.trigger_value
          )
        )
        ${variantFilter}
        ${locationFilter}
        ${warehouseFilter}
        AND EXISTS (
          SELECT 1
          FROM inventory.inventory_levels ril
          JOIN warehouse.warehouse_locations rwl ON rwl.id = ril.warehouse_location_id
            JOIN catalog.product_variants source_pv ON source_pv.id = ril.product_variant_id
          WHERE ril.variant_qty > 0
            AND source_pv.product_id = pv.product_id
            AND rwl.location_type = effective.source_location_type
            AND (wl.warehouse_id IS NULL OR rwl.warehouse_id = wl.warehouse_id)
            AND (
              (effective.source_variant_id IS NOT NULL AND source_pv.id = effective.source_variant_id)
              OR (
                effective.source_variant_id IS NULL
                AND (
                  source_pv.id = pv.id
                  OR (
                    effective.source_hierarchy_level IS NOT NULL
                    AND source_pv.hierarchy_level = effective.source_hierarchy_level
                    AND source_pv.id <> pv.id
                    AND source_pv.is_active = true
                    AND source_pv.units_per_variant > pv.units_per_variant
                    AND MOD(source_pv.units_per_variant, pv.units_per_variant) = 0
                  )
                )
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM inventory.replen_tasks rt
          WHERE rt.to_location_id = wl.id
            AND rt.pick_product_variant_id = pv.id
            AND rt.status IN ('pending', 'assigned', 'in_progress', 'blocked')
            AND NOT (
              rt.status = 'blocked'
              AND rt.blocks_shipment = false
              AND rt.depends_on_task_id IS NULL
              AND COALESCE(rt.qty_source_units, 0) = 0
              AND COALESCE(rt.qty_target_units, 0) = 0
              AND COALESCE(rt.exception_reason, 'no_source_stock') IN ('no_source_stock', 'no_source_variant')
            )
        )
      ORDER BY COALESCE(il.variant_qty, 0) ASC, wl.code ASC, pv.sku ASC
      LIMIT ${limit}
    `);

    const queuedTaskIds = new Set<number>();
    const existingTaskIds = new Set<number>();
    const skipped: MissingPickBinReplenQueueResult["skipped"] = [];

    for (const row of candidatesResult.rows as Array<{
      variant_id: number | string;
      location_id: number | string;
      active_pending_lines?: number | string | null;
      sku: string | null;
      location_code: string | null;
    }>) {
      const variantId = Number(row.variant_id);
      const locationId = Number(row.location_id);
      if (!Number.isInteger(variantId) || !Number.isInteger(locationId)) {
        continue;
      }

      const existingBefore = await this.findActiveTaskForPickBin(variantId, locationId);
      if (existingBefore) {
        existingTaskIds.add(Number(existingBefore.id));
        continue;
      }

      try {
        const created = await this.createAndExecuteReplen(variantId, locationId, "system:health-replen", {
          blocksShipment: false,
          forceWhenAtOrBelowZero: Number(row.active_pending_lines ?? 0) > 0,
          triggeredBy: "health_queue",
        });

        if (created?.task) {
          queuedTaskIds.add(Number(created.task.id));
        } else {
          skipped.push({
            variantId,
            locationId,
            sku: row.sku ?? null,
            locationCode: row.location_code ?? null,
            reason: "replen resolver did not create an active task",
          });
        }
      } catch (error) {
        skipped.push({
          variantId,
          locationId,
          sku: row.sku ?? null,
          locationCode: row.location_code ?? null,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      mode: params.mode ?? (params.variantId || params.locationId ? "queue_replen" : "queue_missing_replen"),
      scannedPickBins: candidatesResult.rows.length,
      queuedReplen: queuedTaskIds.size,
      queuedTaskIds: Array.from(queuedTaskIds),
      existingTaskIds: Array.from(existingTaskIds),
      skippedPickBins: skipped.length,
      skipped,
    };
  }

  private async cancelStaleNoDemandTasks(params: {
    taskId?: number | null;
    limit?: number;
    userId?: string;
  }): Promise<number[]> {
    const taskFilter = params.taskId ? sql`AND rt.id = ${params.taskId}` : sql``;
    const limit = this.cleanupLimit(params.limit);
    const auditNote = `Cancelled by replen health cleanup${params.userId ? ` by ${params.userId}` : ""}: no active demand and no executable replen work remains`;

    const result = await this.db.execute(sql`
      WITH candidates AS (
        SELECT rt.id
        FROM inventory.replen_tasks rt
        LEFT JOIN catalog.product_variants pv ON pv.id = rt.pick_product_variant_id
        WHERE rt.status = 'blocked'
          AND rt.blocks_shipment = false
          AND rt.depends_on_task_id IS NULL
          AND COALESCE(rt.qty_source_units, 0) = 0
          AND COALESCE(rt.qty_target_units, 0) = 0
          AND COALESCE(rt.exception_reason, 'no_source_stock') IN ('no_source_stock', 'no_source_variant')
          ${taskFilter}
          AND NOT EXISTS (
            SELECT 1
            FROM wms.order_items oi
            JOIN wms.orders o
              ON o.id = oi.order_id
             AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
            WHERE oi.sku = pv.sku
              AND oi.status = 'pending'
              AND oi.requires_shipping = 1
            UNION ALL
            SELECT 1
            FROM wms.allocation_exceptions ae
            JOIN wms.orders o
              ON o.id = ae.order_id
             AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
            WHERE ae.sku = pv.sku
              AND ae.status NOT IN ('resolved', 'resolved_inline', 'cancelled')
              AND (
                ae.status = 'blocked'
                OR LOWER(COALESCE(ae.metadata->>'shipmentBlocking', 'false')) = 'true'
              )
          )
        ORDER BY rt.created_at ASC, rt.id ASC
        LIMIT ${limit}
      )
      UPDATE inventory.replen_tasks rt
      SET status = 'cancelled',
          completed_at = NOW(),
          notes = trim(both E'\n' from COALESCE(rt.notes, '') || E'\n' || ${auditNote})
      FROM candidates c
      WHERE rt.id = c.id
      RETURNING rt.id
    `);

    return (result.rows as Array<{ id: number | string }>).map((row) => Number(row.id));
  }

  private async cancelStaleNoDemandBacklogTasks(params: {
    taskId?: number | null;
    limit?: number;
    userId?: string;
  }): Promise<number[]> {
    const taskFilter = params.taskId ? sql`AND rt.id = ${params.taskId}` : sql``;
    const ageFilter = params.taskId ? sql`` : sql`AND rt.created_at < NOW() - INTERVAL '4 hours'`;
    const limit = this.cleanupLimit(params.limit);
    const auditNote = `Cancelled by replen health cleanup${params.userId ? ` by ${params.userId}` : ""}: no active demand; stale queued replen can be recreated from current rules when needed`;

    const result = await this.db.execute(sql`
      WITH candidates AS (
        SELECT rt.id
        FROM inventory.replen_tasks rt
        LEFT JOIN catalog.product_variants pv ON pv.id = rt.pick_product_variant_id
        WHERE rt.status IN ('pending', 'assigned')
          AND rt.blocks_shipment = false
          AND rt.depends_on_task_id IS NULL
          ${taskFilter}
          ${ageFilter}
          AND NOT EXISTS (
            SELECT 1
            FROM wms.order_items oi
            JOIN wms.orders o
              ON o.id = oi.order_id
             AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
            WHERE oi.sku = pv.sku
              AND oi.status = 'pending'
              AND oi.requires_shipping = 1
            UNION ALL
            SELECT 1
            FROM wms.allocation_exceptions ae
            JOIN wms.orders o
              ON o.id = ae.order_id
             AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
            WHERE ae.sku = pv.sku
              AND ae.status NOT IN ('resolved', 'resolved_inline', 'cancelled')
              AND (
                ae.status = 'blocked'
                OR LOWER(COALESCE(ae.metadata->>'shipmentBlocking', 'false')) = 'true'
              )
          )
        ORDER BY rt.created_at ASC, rt.id ASC
        LIMIT ${limit}
      )
      UPDATE inventory.replen_tasks rt
      SET status = 'cancelled',
          completed_at = NOW(),
          notes = trim(both E'\n' from COALESCE(rt.notes, '') || E'\n' || ${auditNote})
      FROM candidates c
      WHERE rt.id = c.id
      RETURNING rt.id
    `);

    return (result.rows as Array<{ id: number | string }>).map((row) => Number(row.id));
  }

  private async cancelDuplicateActiveTasks(params: {
    taskId?: number | null;
    limit?: number;
    userId?: string;
  }): Promise<{ cancelledTaskIds: number[]; keptTaskIds: number[] }> {
    const taskJoin = params.taskId
      ? sql`JOIN target_groups tg ON tg.pick_product_variant_id = rt.pick_product_variant_id AND tg.to_location_id = rt.to_location_id`
      : sql``;
    const targetGroupFilter = params.taskId ? sql`WHERE id = ${params.taskId}` : sql``;
    const limit = this.cleanupLimit(params.limit);
    const auditNote = `Cancelled by replen health cleanup${params.userId ? ` by ${params.userId}` : ""}: duplicate active replen task`;

    const result = await this.db.execute(sql`
      WITH target_groups AS (
        SELECT DISTINCT pick_product_variant_id, to_location_id
        FROM inventory.replen_tasks
        ${targetGroupFilter}
      ),
      active_tasks AS (
        SELECT
          rt.id,
          rt.status,
          first_value(rt.id) OVER task_group AS kept_id,
          row_number() OVER task_group AS row_num,
          count(*) OVER (
            PARTITION BY rt.pick_product_variant_id, rt.to_location_id
          ) AS active_count
        FROM inventory.replen_tasks rt
        ${taskJoin}
        WHERE rt.status IN ('pending', 'assigned', 'in_progress', 'blocked')
          AND rt.blocks_shipment = false
          AND rt.pick_product_variant_id IS NOT NULL
          AND rt.to_location_id IS NOT NULL
          AND NOT (
            rt.status = 'blocked'
            AND rt.depends_on_task_id IS NULL
            AND COALESCE(rt.qty_source_units, 0) = 0
            AND COALESCE(rt.qty_target_units, 0) = 0
            AND COALESCE(rt.exception_reason, 'no_source_stock') IN ('no_source_stock', 'no_source_variant')
          )
        WINDOW task_group AS (
          PARTITION BY rt.pick_product_variant_id, rt.to_location_id
          ORDER BY
            CASE rt.status
              WHEN 'in_progress' THEN 1
              WHEN 'assigned' THEN 2
              WHEN 'pending' THEN 3
              WHEN 'blocked' THEN 4
              ELSE 9
            END,
            rt.created_at ASC,
            rt.id ASC
        )
      ),
      candidates AS (
        SELECT id, kept_id
        FROM active_tasks
        WHERE active_count > 1
          AND row_num > 1
          AND status <> 'in_progress'
        ORDER BY id ASC
        LIMIT ${limit}
      )
      UPDATE inventory.replen_tasks rt
      SET status = 'cancelled',
          completed_at = NOW(),
          notes = trim(both E'\n' from COALESCE(rt.notes, '') || E'\n' || ${auditNote} || ' kept #' || c.kept_id::text)
      FROM candidates c
      WHERE rt.id = c.id
      RETURNING rt.id, c.kept_id
    `);

    const rows = result.rows as Array<{ id: number | string; kept_id: number | string }>;
    return {
      cancelledTaskIds: rows.map((row) => Number(row.id)),
      keptTaskIds: Array.from(new Set(rows.map((row) => Number(row.kept_id)))),
    };
  }

  // ---------------------------------------------------------------------------
  // 5. CHECK AND TRIGGER AFTER PICK -- inline auto-trigger
  // ---------------------------------------------------------------------------

  async checkAndTriggerAfterPick(
    productVariantId: number,
    warehouseLocationId: number,
    triggeredBy: string = "inline_pick",
    context?: ReplenOrderContext,
  ): Promise<ReplenTask | null> {
    return this.withPickBinTaskLock(productVariantId, warehouseLocationId, () =>
      this.checkAndTriggerAfterPickLocked(productVariantId, warehouseLocationId, triggeredBy, context),
    );
  }

  private async checkAndTriggerAfterPickLocked(
    productVariantId: number,
    warehouseLocationId: number,
    triggeredBy: string = "inline_pick",
    context?: ReplenOrderContext,
  ): Promise<ReplenTask | null> {
    const _tag = `[Replen checkAndTrigger] variant=${productVariantId} loc=${warehouseLocationId}`;

    const eval_ = await this.evaluateReplenNeed(productVariantId, warehouseLocationId, {
      forceWhenAtOrBelowZero: context?.forceWhenAtOrBelowZero === true,
    });

    if (eval_.status === "skip") {
      console.log(`${_tag} EXIT: ${eval_.skipReason}`);
      return null;
    }
    if (eval_.status === "dedup") {
      console.log(`${_tag} EXIT: dedup — existing task #${eval_.existingTaskId}`);
      if (
        eval_.existingTask.executionMode === "inline" &&
        EXECUTABLE_REPLEN_TASK_STATUSES.includes(eval_.existingTask.status)
      ) {
        return (await this.executeInlineTaskAutomatically(eval_.existingTask, "system:auto-replen", _tag)).task;
      }
      return eval_.existingTask;
    }

    const { location, variant, whSettings, params, taskNotes, sourceResolutionIssue, rule, resolvedSourceVariantId } = eval_;
    const { replenMethod, priority, sourceLocationType, autoReplen, sourcePriority } = params;

    if (eval_.status === "needed_stockout") {
      console.log(`${_tag} no source location found — trying cascade`);
      if (resolvedSourceVariantId) {
        const cascadeResult = await this.tryCascadeReplen({
          sourceVariantId: resolvedSourceVariantId,
          pickVariantId: productVariantId,
          pickLocationId: warehouseLocationId,
          warehouseId: location.warehouseId ?? undefined,
          sourceLocationType,
          sourcePriority,
          ruleId: rule?.id ?? null,
          productId: rule?.productId ?? variant.productId ?? null,
          replenMethod,
          whSettings,
          taskNotes,
          triggeredBy,
          priority,
          autoReplen,
          context,
        });
        if (cascadeResult) return cascadeResult;
      }

      const notification = {
        title: `Stockout: ${variant.sku ?? `variant #${productVariantId}`}`,
        message: `No source stock found in ${sourceLocationType} locations for ${location.code}`,
        data: { productVariantId, locationId: warehouseLocationId, locationCode: location.code },
      };

      if (context?.blocksShipment !== true) {
        notify("stockout", notification).catch(() => {});
        console.log(`${_tag} EXIT: no source stock; routed to review notification without creating a fake replen task`);
        return null;
      }

      const [blockedTask] = await this.db
        .insert(replenTasks)
        .values({
          replenRuleId: rule?.id ?? null,
          fromLocationId: warehouseLocationId,
          toLocationId: warehouseLocationId,
          productId: rule?.productId ?? variant.productId ?? null,
          sourceProductVariantId: resolvedSourceVariantId ?? productVariantId,
          pickProductVariantId: productVariantId,
          qtySourceUnits: 0,
          qtyTargetUnits: 0,
          qtyCompleted: 0,
          status: "blocked",
          priority,
          triggeredBy,
          executionMode: eval_.executionMode,
          replenMethod,
          autoReplen,
          exceptionReason: sourceResolutionIssue?.reason ?? "no_source_stock",
          ...this.replenOrderTaskFields(context),
          warehouseId: location.warehouseId ?? undefined,
          notes: this.appendOrderContextNote(
            `${taskNotes}\nBlocked: ${sourceResolutionIssue?.note ?? `no source stock found in ${sourceLocationType} locations`}`,
            context,
          ),
        } satisfies InsertReplenTask)
        .returning();
      console.log(`${_tag} EXIT: created BLOCKED task — no source stock in ${sourceLocationType} locations`);
      notify("stockout", {
        ...notification,
        data: { ...notification.data, taskId: blockedTask.id },
      }).catch(() => {});
      return blockedTask as ReplenTask;
    }

    const { sourceLocation, sourceVariant, qtySourceUnits, qtyTargetUnits, executionMode } = eval_;

    console.log(`${_tag} CREATING TASK: from=${sourceLocation!.code}(id=${sourceLocation!.id}) to=${location.code} qty=${qtySourceUnits}x${sourceVariant.unitsPerVariant}=${qtyTargetUnits} method=${replenMethod}`);
    const [task] = await this.db
      .insert(replenTasks)
      .values({
        replenRuleId: rule?.id ?? null,
        fromLocationId: sourceLocation!.id,
        toLocationId: warehouseLocationId,
        productId: rule?.productId ?? variant.productId ?? null,
        sourceProductVariantId: resolvedSourceVariantId ?? productVariantId,
        pickProductVariantId: productVariantId,
        qtySourceUnits,
        qtyTargetUnits,
        qtyCompleted: 0,
        status: "pending",
        priority,
        triggeredBy,
        executionMode,
        replenMethod,
        autoReplen,
        ...this.replenOrderTaskFields(context),
        warehouseId: location.warehouseId ?? undefined,
        notes: this.appendOrderContextNote(taskNotes, context),
      } satisfies InsertReplenTask)
      .returning();

    if (replenMethod === "pallet_drop" || replenMethod === "case_break") {
      const typeKey = replenMethod === "pallet_drop" ? "pallet_drop_needed" : "case_break_needed";
      notify(typeKey, {
        title: `${replenMethod === "pallet_drop" ? "Pallet Drop" : "Case Break"} Needed`,
        message: `${variant.sku ?? `variant #${productVariantId}`} at ${location.code}`,
        data: { taskId: task.id, productVariantId, locationCode: location.code },
      }).catch(() => {});
    }

    if (eval_.shouldAutoExecute || executionMode === "inline") {
      return (await this.executeInlineTaskAutomatically(task as ReplenTask, "system:auto-replen", _tag)).task;
    }

    if (sourceLocation!.isPickable !== 1) {
      console.log(`[Replen] Task ${task.id} source ${sourceLocation!.code} is non-pickable — queued for warehouse associate, not returned to picker`);
      return null;
    }

    return task as ReplenTask;
  }

  // ---------------------------------------------------------------------------
  // 5a-NEW. GUIDANCE-ONLY REPLEN CHECK (no task creation)
  // ---------------------------------------------------------------------------

  async checkReplenNeeded(
    productVariantId: number,
    warehouseLocationId: number,
    options?: ReplenEvaluationOptions,
  ): Promise<ReplenGuidance> {
    const noReplen = (reason: string, eval_?: Extract<ReplenEvalResult, { status: "skip" }>): ReplenGuidance => ({
      needed: false, stockout: false, sourceLocationId: null, sourceLocationCode: null,
      sourceVariantId: null, sourceVariantSku: null, sourceVariantName: null,
      pickVariantId: productVariantId, qtySourceUnits: 0, qtyTargetUnits: 0,
      replenMethod: eval_?.params?.replenMethod ?? "full_case",
      executionMode: "queue",
      taskNotes: "",
      triggerValue: eval_?.triggerValue ?? null,
      autoReplen: eval_?.params?.autoReplen ?? 0,
      evaluatedQty: eval_?.evaluatedQty ?? null,
      skipReason: reason,
    });

    const eval_ = await this.evaluateReplenNeed(productVariantId, warehouseLocationId, options);

    if (eval_.status === "skip") return noReplen(eval_.skipReason, eval_);
    if (eval_.status === "dedup") {
      return this.buildExistingTaskGuidance(productVariantId, eval_.existingTask, eval_);
    }

    const { sourceLocation, sourceVariant, resolvedSourceVariantId, qtySourceUnits, qtyTargetUnits, params, taskNotes, sourceResolutionIssue, executionMode, triggerValue, evaluatedQty } = eval_;

    if (eval_.status === "needed_stockout") {
      return {
        needed: true, stockout: true,
        sourceLocationId: null, sourceLocationCode: null,
        sourceVariantId: null, sourceVariantSku: null, sourceVariantName: null,
        pickVariantId: productVariantId, qtySourceUnits: 0, qtyTargetUnits: 0,
        replenMethod: params.replenMethod,
        executionMode,
        taskNotes: sourceResolutionIssue?.note ? `${taskNotes}\n${sourceResolutionIssue.note}` : taskNotes,
        triggerValue,
        autoReplen: params.autoReplen,
        evaluatedQty,
        skipReason: sourceResolutionIssue?.reason ?? "no_source_stock",
      };
    }

    return {
      needed: true, stockout: false,
      sourceLocationId: sourceLocation!.id,
      sourceLocationCode: sourceLocation!.code,
      sourceVariantId: resolvedSourceVariantId ?? null,
      sourceVariantSku: sourceVariant.sku,
      sourceVariantName: sourceVariant.name || sourceVariant.sku || null,
      pickVariantId: productVariantId,
      qtySourceUnits, qtyTargetUnits,
      replenMethod: params.replenMethod,
      executionMode,
      taskNotes,
      triggerValue,
      autoReplen: params.autoReplen,
      evaluatedQty,
    };
  }

  async predictReplenAfterPick(
    productVariantId: number,
    warehouseLocationId: number,
    pickedQty: number,
  ): Promise<ReplenPickPrediction | null> {
    const [level] = await this.db
      .select()
      .from(inventoryLevels)
      .where(and(
        eq(inventoryLevels.productVariantId, productVariantId),
        eq(inventoryLevels.warehouseLocationId, warehouseLocationId),
      ))
      .limit(1);
    if (!level) return null;

    const systemQty = level.variantQty ?? 0;
    const postPickQty = Math.max(0, systemQty - Math.max(0, pickedQty));
    const guidance = await this.checkReplenNeeded(productVariantId, warehouseLocationId, {
      currentQtyOverride: postPickQty,
    });

    let sourceQty = 0;
    if (guidance.sourceLocationId) {
      const [sourceLevel] = await this.db
        .select()
        .from(inventoryLevels)
        .where(and(
          eq(inventoryLevels.productVariantId, guidance.sourceVariantId ?? productVariantId),
          eq(inventoryLevels.warehouseLocationId, guidance.sourceLocationId),
        ))
        .limit(1);
      sourceQty = sourceLevel?.variantQty ?? 0;
    }

    return {
      systemQty,
      postPickQty,
      triggerValue: guidance.triggerValue,
      replenNeeded: guidance.needed,
      replenMethod: guidance.replenMethod,
      autoReplen: guidance.autoReplen,
      stockout: guidance.stockout,
      executionMode: guidance.executionMode,
      sourceLocationCode: guidance.needed ? guidance.sourceLocationCode : null,
      sourceQty: guidance.needed ? sourceQty : 0,
      sourceVariantName: guidance.needed ? guidance.sourceVariantName : null,
      existingTaskId: guidance.existingTaskId ?? null,
      existingTaskStatus: guidance.existingTaskStatus ?? null,
      existingTaskExecutionMode: guidance.existingTaskExecutionMode ?? null,
      existingTaskBlocksShipment: guidance.existingTaskBlocksShipment === true,
    };
  }

  // ---------------------------------------------------------------------------
  // 5a-NEW2. ATOMIC CREATE + EXECUTE REPLEN (called after picker confirms)
  // ---------------------------------------------------------------------------

  /**
   * Re-derive replen guidance from current state, create task as completed,
   * and execute inventory movement — all in one shot.
   * Returns null if replen is no longer needed or source stock is gone.
   */
  async createAndExecuteReplen(
    pickVariantId: number,
    toLocationId: number,
    userId?: string,
    context?: ReplenOrderContext,
  ): Promise<{ task: ReplenTask; moved: number } | null> {
    return this.withPickBinTaskLock(pickVariantId, toLocationId, () =>
      this.createAndExecuteReplenLocked(pickVariantId, toLocationId, userId, context),
    );
  }

  private async createAndExecuteReplenLocked(
    pickVariantId: number,
    toLocationId: number,
    userId?: string,
    context?: ReplenOrderContext,
  ): Promise<{ task: ReplenTask; moved: number } | null> {
    const _tag = `[Replen createAndExecute] variant=${pickVariantId} loc=${toLocationId}`;

    const existingTask = await this.findActiveTaskForPickBin(pickVariantId, toLocationId);
    if (existingTask) {
      const currentTask = EXECUTABLE_REPLEN_TASK_STATUSES.includes(existingTask.status)
        ? await this.reResolveTaskSourceBeforeExecute(existingTask, userId)
        : existingTask;
      console.log(`${_tag} reusing active task ${currentTask.id} status=${currentTask.status}`);
      if (
        currentTask.executionMode === "inline" &&
        EXECUTABLE_REPLEN_TASK_STATUSES.includes(currentTask.status)
      ) {
        return this.executeInlineTaskAutomatically(currentTask, userId, _tag);
      }
      return { task: currentTask, moved: 0 };
    }

    // Re-derive guidance from current DB state (fresh, not stale)
    const triggeredBy = context?.triggeredBy ?? "inline_pick";
    const guidance = await this.checkReplenNeeded(pickVariantId, toLocationId, {
      forceWhenAtOrBelowZero: context?.forceWhenAtOrBelowZero === true,
    });
    if (guidance.needed && guidance.stockout && context?.blocksShipment) {
      const blockedTask = await this.checkAndTriggerAfterPick(
        pickVariantId,
        toLocationId,
        triggeredBy,
        context,
      );
      return blockedTask ? { task: blockedTask, moved: 0 } : null;
    }
    if (!guidance.needed || guidance.stockout || !guidance.sourceLocationId) {
      console.log(`${_tag} guidance says no replen needed or stockout — skipping`);
      return null;
    }

    // Load required data for movement
    const [variant] = await this.db.select().from(productVariants).where(eq(productVariants.id, pickVariantId)).limit(1);
    if (!variant) return null;

    const sourceVariant = guidance.sourceVariantId
      ? (await this.db.select().from(productVariants).where(eq(productVariants.id, guidance.sourceVariantId)).limit(1))[0] ?? variant
      : variant;

    const [location] = await this.db.select().from(warehouseLocations).where(eq(warehouseLocations.id, toLocationId)).limit(1);
    if (!location) return null;

    const rule = await this.findRuleForVariant(pickVariantId);
    const priority = rule?.priority ?? 5;
    const autoReplen = rule?.autoReplen ?? 0;

    // Create the task, then let the replenishment service post the movement.
    const [task] = await this.db.insert(replenTasks).values({
      replenRuleId: rule?.id ?? null,
      fromLocationId: guidance.sourceLocationId,
      toLocationId,
      productId: rule?.productId ?? variant.productId ?? null,
      sourceProductVariantId: guidance.sourceVariantId ?? pickVariantId,
      pickProductVariantId: pickVariantId,
      qtySourceUnits: guidance.qtySourceUnits,
      qtyTargetUnits: guidance.qtyTargetUnits,
      qtyCompleted: 0, // will be updated by executeTask
      status: "pending", // executeTask transitions to completed
      priority,
      triggeredBy,
      executionMode: guidance.executionMode,
      replenMethod: guidance.replenMethod,
      autoReplen,
      ...this.replenOrderTaskFields(context),
      warehouseId: location.warehouseId ?? undefined,
      notes: this.appendOrderContextNote(
        `${guidance.taskNotes}\nSystem auto-executed inline replen.`,
        context,
      ),
    } satisfies InsertReplenTask).returning();

    let moved = 0;
    if (guidance.executionMode === "inline") {
      console.log(`${_tag} created task ${task.id}, executing immediately...`);
      return this.executeInlineTaskAutomatically(task as ReplenTask, userId, _tag);
    } else {
      console.log(`${_tag} created task ${task.id}, executionMode is queue. Leaving as pending.`);
    }

    // Re-read task to get final state
    const [finalTask] = await this.db.select().from(replenTasks).where(eq(replenTasks.id, task.id)).limit(1);
    return { task: finalTask as ReplenTask, moved };
  }

  async ensureQueuedReplenForShortPick(
    pickVariantId: number,
    toLocationId: number,
    userId?: string,
    context?: ReplenOrderContext,
  ): Promise<{ task: ReplenTask; moved: number; guidance?: ReplenGuidance } | null> {
    return this.withPickBinTaskLock(pickVariantId, toLocationId, () =>
      this.ensureQueuedReplenForShortPickLocked(pickVariantId, toLocationId, userId, context),
    );
  }

  private async ensureQueuedReplenForShortPickLocked(
    pickVariantId: number,
    toLocationId: number,
    userId?: string,
    context?: ReplenOrderContext,
  ): Promise<{ task: ReplenTask; moved: number; guidance?: ReplenGuidance } | null> {
    const _tag = `[Replen shortPickQueue] variant=${pickVariantId} loc=${toLocationId}`;

    const existingTask = await this.findActiveTaskForPickBin(pickVariantId, toLocationId);
    if (existingTask) {
      const currentTask = EXECUTABLE_REPLEN_TASK_STATUSES.includes(existingTask.status)
        ? await this.reResolveTaskSourceBeforeExecute(existingTask, userId)
        : existingTask;
      console.log(`${_tag} reusing active task ${currentTask.id} status=${currentTask.status}`);
      return { task: currentTask, moved: 0 };
    }

    const guidance = await this.checkReplenNeeded(pickVariantId, toLocationId, {
      currentQtyOverride: 0,
    });
    if (!guidance.needed || guidance.stockout || !guidance.sourceLocationId) {
      console.log(`${_tag} no queueable source found`);
      return null;
    }

    const [sourceLocation] = await this.db
      .select()
      .from(warehouseLocations)
      .where(eq(warehouseLocations.id, guidance.sourceLocationId))
      .limit(1);
    if (!sourceLocation || sourceLocation.isPickable === 1) {
      console.log(`${_tag} source is pickable; inline/source-empty flow owns this`);
      return null;
    }

    const [variant] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, pickVariantId))
      .limit(1);
    if (!variant) return null;

    const [location] = await this.db
      .select()
      .from(warehouseLocations)
      .where(eq(warehouseLocations.id, toLocationId))
      .limit(1);
    if (!location) return null;

    const rule = await this.findRuleForVariant(pickVariantId);
    const [task] = await this.db.insert(replenTasks).values({
      replenRuleId: rule?.id ?? null,
      fromLocationId: guidance.sourceLocationId,
      toLocationId,
      productId: rule?.productId ?? variant.productId ?? null,
      sourceProductVariantId: guidance.sourceVariantId ?? pickVariantId,
      pickProductVariantId: pickVariantId,
      qtySourceUnits: guidance.qtySourceUnits,
      qtyTargetUnits: guidance.qtyTargetUnits,
      qtyCompleted: 0,
      status: "pending",
      priority: rule?.priority ?? 5,
      triggeredBy: "short_pick",
      executionMode: "queue",
      replenMethod: guidance.replenMethod,
      autoReplen: guidance.autoReplen,
      ...this.replenOrderTaskFields(context),
      warehouseId: location.warehouseId ?? undefined,
      createdBy: userId ?? undefined,
      notes: this.appendOrderContextNote(
        `${guidance.taskNotes}\nQueued from confirmed short pick; picker continues without inline replen.`,
        context,
      ),
    } satisfies InsertReplenTask).returning();

    console.log(`${_tag} created queued task ${task.id} from short-pick report`);
    return { task: task as ReplenTask, moved: 0, guidance };
  }

  // ---------------------------------------------------------------------------
  // 5b. COMPLETE MATCHING REPLEN TASKS AFTER MANUAL TRANSFER
  // ---------------------------------------------------------------------------

  /**
   * After a manual inventory transfer, find and complete any matching pending
   * replen tasks WITHOUT re-moving inventory (it's already been moved).
   *
   * Matches on: fromLocationId + toLocationId + variant (pickProductVariantId).
   * Partial matches (same variant+dest but different source) are also handled
   * since the destination is fulfilled regardless of which source was used.
   */
  async completeMatchingTransferTask(
    fromLocationId: number,
    toLocationId: number,
    variantId: number,
    userId?: string,
  ): Promise<{ completedTaskIds: number[] }> {
    // Find pending/assigned/in_progress replen tasks that match this transfer
    const matchingTasks = await this.db
      .select()
      .from(replenTasks)
      .where(
        and(
          eq(replenTasks.toLocationId, toLocationId),
          eq(replenTasks.pickProductVariantId, variantId),
          inArray(replenTasks.status, ["pending", "assigned", "in_progress"]),
        ),
      );

    const completedIds: number[] = [];

    for (const task of matchingTasks) {
      // Mark completed without moving inventory
      await this.db
        .update(replenTasks)
        .set({
          status: "completed",
          qtyCompleted: task.qtyTargetUnits,
          completedAt: new Date(),
          assignedTo: userId ?? task.assignedTo,
          notes: `${task.notes || ""}\nAuto-completed: manual transfer from loc ${fromLocationId} to loc ${toLocationId} fulfilled this task`.trim(),
        })
        .where(eq(replenTasks.id, task.id));

      // Unblock any dependent cascade tasks
      await this.unblockDependentTasks(task.id, userId);
      completedIds.push(task.id);

      console.log(`[Replen] Auto-completed task #${task.id} — manual transfer matched (variant ${variantId}, to loc ${toLocationId})`);
    }

    return { completedTaskIds: completedIds };
  }

  /**
   * Mark a replen task as done WITHOUT moving inventory.
   * For manual reconciliation when the physical work was already done
   * but the system didn't capture it (e.g. transfer done outside replen flow).
   */
  async markTaskDone(
    taskId: number,
    userId?: string,
    notes?: string,
  ): Promise<ReplenTask> {
    const [task] = await this.db
      .select()
      .from(replenTasks)
      .where(eq(replenTasks.id, taskId))
      .limit(1);

    if (!task) {
      throw new Error(`Replen task ${taskId} not found`);
    }

    if (!["pending", "assigned", "in_progress", "blocked"].includes(task.status)) {
      throw new Error(`Task ${taskId} is ${task.status}, cannot mark done`);
    }

    if (this.isNoSourceReviewOnlyTask(task as ReplenTask)) {
      throw new Error(`Task ${taskId} has no valid source stock and no replen quantity; cancel or resolve source stock instead of marking done`);
    }

    if (["pending", "assigned", "in_progress"].includes(task.status)) {
      const activeDemandLines = await this.countActivePendingDemandLines(task as ReplenTask);
      if (activeDemandLines > 0) {
        throw new Error(
          `Task ${taskId} has ${activeDemandLines} active demand line${activeDemandLines === 1 ? "" : "s"}; complete the replen so inventory moves instead of marking done`,
        );
      }
    }

    await this.db
      .update(replenTasks)
      .set({
        status: "completed",
        qtyCompleted: task.qtyTargetUnits,
        completedAt: new Date(),
        assignedTo: userId ?? task.assignedTo,
        notes: `${task.notes || ""}\nManually marked done${notes ? `: ${notes}` : ""} — inventory not re-moved`.trim(),
      })
      .where(eq(replenTasks.id, taskId));

    // Unblock dependent tasks
    await this.unblockDependentTasks(taskId, userId);

    const [updated] = await this.db
      .select()
      .from(replenTasks)
      .where(eq(replenTasks.id, taskId))
      .limit(1);

    console.log(`[Replen] Task #${taskId} manually marked done by ${userId || "unknown"}`);
    return updated as ReplenTask;
  }

  private async countActivePendingDemandLines(task: ReplenTask): Promise<number> {
    if (!task.pickProductVariantId) return 0;

    const result = await this.db.execute(sql`
      SELECT COUNT(*)::int AS active_pending_lines
      FROM (
        SELECT oi.id::text AS demand_id
        FROM wms.order_items oi
        JOIN wms.orders o
          ON o.id = oi.order_id
         AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
        JOIN catalog.product_variants pv
          ON pv.id = ${task.pickProductVariantId}
        WHERE oi.sku = pv.sku
          AND oi.status = 'pending'
          AND oi.requires_shipping = 1

        UNION ALL

        SELECT 'allocation_exception:' || ae.id::text AS demand_id
        FROM wms.allocation_exceptions ae
        JOIN wms.orders o
          ON o.id = ae.order_id
         AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
        JOIN catalog.product_variants pv
          ON pv.id = ${task.pickProductVariantId}
        WHERE ae.sku = pv.sku
          AND ae.status NOT IN ('resolved', 'resolved_inline', 'cancelled')
          AND (
            ae.status = 'blocked'
            OR LOWER(COALESCE(ae.metadata->>'shipmentBlocking', 'false')) = 'true'
          )
      ) demand_line
    `);

    return Number(result.rows?.[0]?.active_pending_lines ?? 0);
  }

  // ---------------------------------------------------------------------------
  // 5c. REPLEN GUIDANCE — check if pickable replen source exists for a location
  // ---------------------------------------------------------------------------

  /**
   * Check whether a pick location has a pickable replen source with system stock.
   * Used by short pick flow to guide picker to replen before allowing short pick.
   *
   * Returns:
   * - replen_inline: pickable source has stock → picker should go replen first
   * - short_pick_with_replen: only reserve source has stock → short pick OK, replen queued for WH associate
   * - true_short_pick: no stock anywhere → short pick, order to exception queue
   */
  async getReplenGuidance(
    sku: string,
    locationCode: string,
  ): Promise<{
    action: "replen_inline" | "short_pick_with_replen" | "true_short_pick";
    source?: { locationCode: string; availableQty: number; variantSku: string; variantName: string };
  }> {
    const [variant] = await this.db
      .select().from(productVariants)
      .where(eq(productVariants.sku, sku)).limit(1);
    if (!variant) return { action: "true_short_pick" };

    const [location] = await this.db
      .select().from(warehouseLocations)
      .where(eq(warehouseLocations.code, locationCode)).limit(1);
    if (!location || location.isPickable !== 1) return { action: "true_short_pick" };

    const guidance = await this.checkReplenNeeded(variant.id, location.id, {
      currentQtyOverride: 0,
    });
    if (!guidance.needed || guidance.stockout || !guidance.sourceLocationId) {
      return { action: "true_short_pick" };
    }

    const [sourceLocation] = await this.db
      .select()
      .from(warehouseLocations)
      .where(eq(warehouseLocations.id, guidance.sourceLocationId))
      .limit(1);
    if (!sourceLocation) return { action: "true_short_pick" };

    if (sourceLocation.isPickable === 1) {
      const [sourceLevel] = await this.db.select().from(inventoryLevels)
        .where(and(eq(inventoryLevels.productVariantId, guidance.sourceVariantId ?? variant.id), eq(inventoryLevels.warehouseLocationId, sourceLocation.id))).limit(1);
      const sourceVariant = guidance.sourceVariantId
        ? (await this.db.select().from(productVariants).where(eq(productVariants.id, guidance.sourceVariantId)).limit(1))[0]
        : variant;

      return {
        action: "replen_inline",
        source: {
          locationCode: sourceLocation.code,
          availableQty: sourceLevel?.variantQty ?? 0,
          variantSku: guidance.sourceVariantSku ?? sourceVariant?.sku ?? variant.sku,
          variantName: (guidance.sourceVariantName ?? sourceVariant?.name) || sourceVariant?.sku || variant.sku,
        },
      };
    }

    return { action: "short_pick_with_replen" };
  }

  async recordSourceEmptyBlocker(params: ReplenSourceEmptyReport): Promise<ReplenTask> {
    const [existing] = await this.db
      .select()
      .from(replenTasks)
      .where(and(
        eq(replenTasks.orderItemId, params.orderItemId),
        eq(replenTasks.blocksShipment, true),
        eq(replenTasks.exceptionReason, "source_empty"),
        inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"]),
      ))
      .limit(1);

    if (existing) {
      if (!existing.linkedCycleCountId) {
        const cycleCountId = await this.createSourceEmptyCycleCount({
          taskId: existing.id,
          sourceLocationId: existing.fromLocationId,
          sourceVariantId: existing.sourceProductVariantId ?? params.pickVariantId,
          productId: existing.productId,
          warehouseId: existing.warehouseId,
          orderNumber: params.orderNumber ?? null,
          sourceLabel: params.sourceLocationCode ?? `location #${existing.fromLocationId}`,
          userId: params.userId,
        });
        if (cycleCountId) {
          await this.db.update(replenTasks).set({
            linkedCycleCountId: cycleCountId,
            notes: `${existing.notes || ""}\nLinked source-empty cycle count #${cycleCountId}`,
          }).where(eq(replenTasks.id, existing.id));
          return { ...existing, linkedCycleCountId: cycleCountId } as ReplenTask;
        }
      }
      return existing as ReplenTask;
    }

    const [variant] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, params.pickVariantId))
      .limit(1);
    if (!variant) {
      throw new Error(`Product variant ${params.pickVariantId} not found`);
    }

    const [pickLocation] = await this.db
      .select()
      .from(warehouseLocations)
      .where(eq(warehouseLocations.id, params.pickLocationId))
      .limit(1);
    if (!pickLocation) {
      throw new Error(`Pick location ${params.pickLocationId} not found`);
    }

    const locConfig = await this.loadLocationConfig(params.pickLocationId, params.pickVariantId);
    const resolved = await this.resolveReplenParams(
      params.pickVariantId,
      variant,
      pickLocation.warehouseId ?? undefined,
      locConfig,
    );
    const rule = await this.findRuleForVariant(params.pickVariantId);

    const sourceVariantId = resolved.sourceVariantId ?? params.pickVariantId;
    const sourceLocationFromReport = params.sourceLocationCode
      ? (await this.db
          .select()
          .from(warehouseLocations)
          .where(eq(warehouseLocations.code, params.sourceLocationCode))
          .limit(1))[0] ?? null
      : null;
    const sourceLocation = sourceLocationFromReport ?? await this.findSourceLocation(
      sourceVariantId,
      pickLocation.warehouseId ?? undefined,
      resolved.sourceLocationType,
      pickLocation.parentLocationId,
      resolved.sourcePriority,
    );

    const sourceLabel = sourceLocation?.code ?? params.sourceLocationCode ?? "unknown source";
    const context: ReplenOrderContext = {
      orderId: params.orderId,
      orderItemId: params.orderItemId,
      orderNumber: params.orderNumber ?? null,
      blocksShipment: true,
    };

    const [task] = await this.db
      .insert(replenTasks)
      .values({
        replenRuleId: rule?.id ?? null,
        fromLocationId: sourceLocation?.id ?? params.pickLocationId,
        toLocationId: params.pickLocationId,
        productId: rule?.productId ?? variant.productId ?? null,
        sourceProductVariantId: sourceVariantId,
        pickProductVariantId: params.pickVariantId,
        qtySourceUnits: 0,
        qtyTargetUnits: 0,
        qtyCompleted: 0,
        status: "blocked",
        priority: resolved.priority,
        triggeredBy: "inline_pick",
        executionMode: "inline",
        replenMethod: resolved.replenMethod,
        autoReplen: resolved.autoReplen,
        ...this.replenOrderTaskFields(context),
        warehouseId: pickLocation.warehouseId ?? undefined,
        createdBy: params.userId ?? undefined,
        exceptionReason: "source_empty",
        notes: this.appendOrderContextNote(
          `Picker reported replen source empty at ${sourceLabel}; target pick bin ${pickLocation.code}`,
          context,
        ),
      } satisfies InsertReplenTask)
      .returning();

    let linkedCycleCountId: number | null = null;
    if (sourceLocation) {
      linkedCycleCountId = await this.createSourceEmptyCycleCount({
        taskId: task.id,
        sourceLocationId: sourceLocation.id,
        sourceVariantId,
        productId: rule?.productId ?? variant.productId ?? null,
        warehouseId: pickLocation.warehouseId ?? undefined,
        orderNumber: params.orderNumber ?? null,
        sourceLabel,
        userId: params.userId,
      });
      if (linkedCycleCountId) {
        await this.db.update(replenTasks).set({
          linkedCycleCountId,
          notes: `${task.notes || ""}\nLinked source-empty cycle count #${linkedCycleCountId}`,
        }).where(eq(replenTasks.id, task.id));
      }
    }

    notify("stockout", {
      title: `Replen source empty: ${params.sku ?? variant.sku ?? `variant #${params.pickVariantId}`}`,
      message: `Picker reported ${sourceLabel} empty while replenishing ${pickLocation.code}`,
      data: {
        taskId: task.id,
        orderId: params.orderId,
        orderItemId: params.orderItemId,
        productVariantId: params.pickVariantId,
        cycleCountId: linkedCycleCountId,
        pickLocationCode: pickLocation.code,
        sourceLocationCode: sourceLocation?.code ?? params.sourceLocationCode ?? null,
      },
    }).catch(() => {});

    return { ...task, linkedCycleCountId } as ReplenTask;
  }

  private async createSourceEmptyCycleCount(params: {
    taskId: number;
    sourceLocationId: number;
    sourceVariantId: number;
    productId: number | null;
    warehouseId: number | null | undefined;
    orderNumber?: string | null;
    sourceLabel: string;
    userId?: string;
  }): Promise<number | null> {
    const [sourceVariant] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, params.sourceVariantId))
      .limit(1);

    const [inventoryLevel] = await this.db
      .select()
      .from(inventoryLevels)
      .where(and(
        eq(inventoryLevels.warehouseLocationId, params.sourceLocationId),
        eq(inventoryLevels.productVariantId, params.sourceVariantId),
      ))
      .limit(1);

    const [cycleCount] = await this.db.insert(cycleCounts).values({
      name: `Replen Source Empty - Task #${params.taskId}`,
      description: `Picker reported replen source empty at ${params.sourceLabel}${params.orderNumber ? ` for ${params.orderNumber}` : ""}`,
      status: "in_progress",
      warehouseId: params.warehouseId ?? null,
      totalBins: 1,
      countedBins: 0,
      varianceCount: 0,
      approvedVariances: 0,
      createdBy: params.userId || "system",
    }).returning();

    if (!cycleCount?.id) return null;

    await this.db.insert(cycleCountItems).values({
      cycleCountId: cycleCount.id,
      warehouseLocationId: params.sourceLocationId,
      productVariantId: sourceVariant?.id ?? params.sourceVariantId,
      productId: params.productId,
      expectedSku: sourceVariant?.sku || null,
      expectedQty: inventoryLevel?.variantQty ?? 0,
      countedSku: sourceVariant?.sku || null,
      countedQty: 0,
      status: "pending",
      countedBy: params.userId || "system",
    });

    return cycleCount.id;
  }


  // ---------------------------------------------------------------------------
  // 7. REPORT EXCEPTION -- create cycle count and block task
  // ---------------------------------------------------------------------------

  /**
   * Report an exception on a replen task (e.g., short pick, wrong product,
   * empty source). Creates a spot cycle count for the source location and
   * blocks the task.
   *
   * @param taskId   Primary key of the replen task.
   * @param reason   Exception reason: "short" | "wrong_product" | "empty" | "other"
   * @param userId   Who reported the exception (for audit).
   * @param actualQty  Optional actual counted qty at source.
   * @param actualSku  Optional actual SKU found (for wrong_product).
   * @param notes      Optional freeform notes.
   * @returns Object with taskId, cycleCountId, status, and reason.
   */
  async reportException(params: {
    taskId: number;
    reason: string;
    userId?: string;
    actualQty?: number;
    actualSku?: string;
    notes?: string;
  }): Promise<{ taskId: number; cycleCountId: number; status: string; exceptionReason: string }> {
    const { taskId, reason, userId, actualQty, actualSku, notes } = params;

    if (!["short", "wrong_product", "empty", "other"].includes(reason)) {
      throw new Error("Invalid exception reason. Must be: short, wrong_product, empty, or other");
    }

    // Get task
    const [task] = await this.db.select().from(replenTasks)
      .where(eq(replenTasks.id, taskId)).limit(1);
    if (!task) throw new Error(`Replen task ${taskId} not found`);
    if (!["pending", "assigned", "in_progress"].includes(task.status)) {
      throw new Error(`Cannot report exception on task with status '${task.status}'`);
    }

    // Get source variant info
    const sourceVariant = task.sourceProductVariantId
      ? (await this.db.select().from(productVariants)
          .where(eq(productVariants.id, task.sourceProductVariantId)).limit(1))[0]
      : null;

    // Get current inventory at source location
    const inventoryLevel = sourceVariant
      ? (await this.db.select().from(inventoryLevels)
          .where(and(
            eq(inventoryLevels.warehouseLocationId, task.fromLocationId),
            eq(inventoryLevels.productVariantId, sourceVariant.id),
          )).limit(1))[0]
      : null;

    // Create spot cycle count for the source location
    const [cycleCount] = await this.db.insert(cycleCounts).values({
      name: `Replen Exception - Task #${taskId}`,
      description: `Auto-created from replen task #${taskId} exception: ${reason}${notes ? ` - ${notes}` : ""}`,
      status: "in_progress",
      warehouseId: task.warehouseId,
      totalBins: 1,
      countedBins: 0,
      varianceCount: 0,
      approvedVariances: 0,
      createdBy: userId || "system",
    }).returning();

    // Create cycle count item for the expected product at source location
    await this.db.insert(cycleCountItems).values({
      cycleCountId: cycleCount.id,
      warehouseLocationId: task.fromLocationId,
      productVariantId: sourceVariant?.id || null,
      productId: task.productId,
      expectedSku: sourceVariant?.sku || null,
      expectedQty: inventoryLevel?.variantQty ?? 0,
      countedSku: reason === "wrong_product" ? (actualSku || null) : (sourceVariant?.sku || null),
      countedQty: reason === "empty" ? 0 : (actualQty ?? null),
      status: "pending",
      countedBy: userId || "system",
    });

    // Block the task and link the cycle count
    const exceptionNote = `[Exception: ${reason}${notes ? ` - ${notes}` : ""}]`;
    await this.db.update(replenTasks).set({
      status: "blocked",
      exceptionReason: reason,
      linkedCycleCountId: cycleCount.id,
      notes: task.notes ? `${task.notes}\n${exceptionNote}` : exceptionNote,
    }).where(eq(replenTasks.id, taskId));

    return {
      taskId,
      cycleCountId: cycleCount.id,
      status: "blocked",
      exceptionReason: reason,
    };
  }

  /**
   * Compute the average daily pick velocity for a variant over the last N days.
   * Queries inventory_transactions for pick-type outbound and returns the daily
   * average (total picked / lookbackDays). Returns 0 if no picks occurred.
   */
  private async computeVariantVelocity(
    productVariantId: number,
    lookbackDays: number = 14,
  ): Promise<number> {
    const result = await this.db.execute(
      sql`SELECT COALESCE(SUM(ABS(${inventoryTransactions.variantQtyDelta})), 0) AS total_picked
          FROM ${inventoryTransactions}
          WHERE ${inventoryTransactions.productVariantId} = ${productVariantId}
            AND ${inventoryTransactions.transactionType} = 'pick'
            AND ${inventoryTransactions.createdAt} > NOW() - MAKE_INTERVAL(days => ${lookbackDays})`,
    );

    const totalPicked = Number(result.rows?.[0]?.total_picked ?? 0);
    return totalPicked / lookbackDays;
  }

  /**
   * Query for a replen rule that applies to a specific pick variant.
   */
  private async findRuleForVariant(
    pickProductVariantId: number,
  ): Promise<ReplenRule | null> {
    const [rule] = await this.db
      .select()
      .from(replenRules)
      .where(
        and(
          eq(replenRules.pickProductVariantId, pickProductVariantId),
          eq(replenRules.isActive, 1),
        ),
      )
      .limit(1);
    return (rule as ReplenRule) ?? null;
  }

  /**
   * Query for the applicable tier default for a hierarchy level and warehouse.
   */
  private async findTierDefaultForVariant(
    hierarchyLevel: number,
    warehouseId?: number,
  ): Promise<ReplenTierDefault | null> {
    // Try warehouse-specific first
    if (warehouseId != null) {
      const [specific] = await this.db
        .select()
        .from(replenTierDefaults)
        .where(
          and(
            eq(replenTierDefaults.hierarchyLevel, hierarchyLevel),
            eq(replenTierDefaults.warehouseId, warehouseId),
            eq(replenTierDefaults.isActive, 1),
          ),
        )
        .limit(1);
      if (specific) return specific as ReplenTierDefault;
    }

    // Fall back to global default
    const [global] = await this.db
      .select()
      .from(replenTierDefaults)
      .where(
        and(
          eq(replenTierDefaults.hierarchyLevel, hierarchyLevel),
          isNull(replenTierDefaults.warehouseId),
          eq(replenTierDefaults.isActive, 1),
        ),
      )
      .limit(1);

    return (global as ReplenTierDefault) ?? null;
  }

  /**
   * Try to create a cascade chain of replen tasks when the immediate source
   * variant has no stock. Walks up the parentVariantId chain to find an
   * ancestor with stock, then creates an upstream task (ancestor→intermediate)
   * and a blocked downstream task (intermediate→pick) linked by dependsOnTaskId.
   *
   * Returns the blocked downstream task if cascade was created, null otherwise.
   */
  private async tryCascadeReplen(opts: {
    sourceVariantId: number;
    pickVariantId: number;
    pickLocationId: number;
    warehouseId: number | undefined;
    sourceLocationType: string;
    sourcePriority: string;
    ruleId: number | null;
    productId: number | null;
    replenMethod: string;
    whSettings: any;
    taskNotes: string;
    triggeredBy: string;
    priority: number;
    autoReplen: number;
    context?: ReplenOrderContext;
  }): Promise<ReplenTask | null> {
    // Load the intermediate variant (the source we couldn't find stock for)
    const [intermediateVariant] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, opts.sourceVariantId))
      .limit(1);
    if (!intermediateVariant?.productId) return null;

    // Find the tier default for the intermediate variant's level to determine ITS source
    const cascadeTierDefault = await this.findTierDefaultForVariant(
      intermediateVariant.hierarchyLevel,
      opts.warehouseId,
    );
    if (!cascadeTierDefault) return null;
    if (cascadeTierDefault.sourceHierarchyLevel <= intermediateVariant.hierarchyLevel) return null;

    // Find the grandparent variant by tier default's source hierarchy level
    const grandparentVariants = await this.db
      .select()
      .from(productVariants)
      .where(
        and(
          eq(productVariants.productId, intermediateVariant.productId),
          eq(productVariants.hierarchyLevel, cascadeTierDefault.sourceHierarchyLevel),
          eq(productVariants.isActive, true),
        ),
      )
      .limit(1);
    const grandparentVariant = grandparentVariants[0];
    if (!grandparentVariant) return null; // No variant at the cascade source level

    const grandparentVariantId = grandparentVariant.id;

    // Find stock at the grandparent level using the CASCADE tier default's source location type
    const cascadeSourceLocationType = cascadeTierDefault.sourceLocationType;
    const cascadeSourceLocation = await this.findSourceLocation(
      grandparentVariantId,
      opts.warehouseId,
      cascadeSourceLocationType,
      null, // no parent location hint for cascade
      opts.sourcePriority,
    );
    if (!cascadeSourceLocation) return null; // No stock at grandparent either

    // Resolve cascade replen settings from the intermediate variant's tier default
    const cascadeReplenMethod = cascadeTierDefault.replenMethod ?? "case_break";
    const cascadeAutoReplen = cascadeTierDefault.autoReplen ?? 0;
    const cascadePriority = cascadeTierDefault.priority ?? opts.priority;

    // Calculate upstream qty: 1 grandparent unit → N intermediate units
    const cascadeQtySource = 1;
    const cascadeQtyTarget = grandparentVariant.unitsPerVariant;

    // Resolve auto-execute for the upstream cascade task
    const cascadeExec = this.resolveAutoExecute(
      null,
      cascadeAutoReplen,
      opts.whSettings,
      cascadeQtyTarget,
    );

    // --- Create Task A: upstream (grandparent → intermediate) at source location (in-place break) ---
    const [upstreamTask] = await this.db
      .insert(replenTasks)
      .values({
        replenRuleId: null,
        fromLocationId: cascadeSourceLocation.id,
        toLocationId: cascadeSourceLocation.id, // in-place break at reserve
        productId: opts.productId,
        sourceProductVariantId: grandparentVariantId,
        pickProductVariantId: opts.sourceVariantId, // intermediate variant
        qtySourceUnits: cascadeQtySource,
        qtyTargetUnits: cascadeQtyTarget,
        qtyCompleted: 0,
        status: "pending",
        priority: cascadePriority,
        triggeredBy: "cascade",
        executionMode: cascadeExec.executionMode,
        replenMethod: cascadeReplenMethod,
        autoReplen: cascadeAutoReplen,
        ...this.replenOrderTaskFields(opts.context ? { ...opts.context, blocksShipment: false } : undefined),
        warehouseId: opts.warehouseId,
        notes: this.appendOrderContextNote(
          `Cascade: break ${grandparentVariant.sku || grandparentVariant.name} into ${intermediateVariant.sku || intermediateVariant.name}`,
          opts.context,
        ),
      } satisfies InsertReplenTask)
      .returning();

    // --- Create Task B: downstream (intermediate → pick) blocked until Task A completes ---
    const downstreamQtySource = 1;
    const downstreamQtyTarget = intermediateVariant.unitsPerVariant;
    const downstreamReplenMethod = opts.replenMethod;

    const downstreamExec = this.resolveAutoExecute(
      opts.autoReplen === 1 ? 1 : opts.autoReplen === 2 ? 2 : null,
      null,
      opts.whSettings,
      downstreamQtyTarget,
    );

    const [downstreamTask] = await this.db
      .insert(replenTasks)
      .values({
        replenRuleId: opts.ruleId,
        fromLocationId: cascadeSourceLocation.id, // boxes will appear here after Task A
        toLocationId: opts.pickLocationId,
        productId: opts.productId,
        sourceProductVariantId: opts.sourceVariantId, // intermediate variant
        pickProductVariantId: opts.pickVariantId,
        qtySourceUnits: downstreamQtySource,
        qtyTargetUnits: downstreamQtyTarget,
        qtyCompleted: 0,
        status: "blocked",
        priority: opts.priority,
        triggeredBy: opts.triggeredBy,
        executionMode: downstreamExec.executionMode,
        replenMethod: downstreamReplenMethod,
        autoReplen: opts.autoReplen,
        ...this.replenOrderTaskFields(opts.context),
        warehouseId: opts.warehouseId,
        dependsOnTaskId: upstreamTask.id,
        notes: `${opts.taskNotes}\nBlocked: waiting on cascade task #${upstreamTask.id} (${grandparentVariant.sku} → ${intermediateVariant.sku})`,
      } satisfies InsertReplenTask)
      .returning();

    // Auto-execute Task A if configured
    if (cascadeExec.shouldAutoExecute) {
      try {
        await this.executeTask(upstreamTask.id, "system:auto-replen");
      } catch (autoErr: any) {
        console.warn(`[Replen] Cascade auto-execute failed for task ${upstreamTask.id}:`, autoErr?.message);
      }
    }

    return downstreamTask as ReplenTask;
  }

  private isActiveVariant(variant: ProductVariant): boolean {
    return variant.isActive === true || (variant as any).isActive === 1;
  }

  private variantUnits(variant: ProductVariant): number {
    return Math.max(1, Number(variant.unitsPerVariant ?? 1));
  }

  private formatSourceCandidates(candidates: ProductVariant[]): string {
    if (candidates.length === 0) return "none";
    return candidates
      .map((variant) => `${variant.sku ?? variant.name ?? `#${variant.id}`}(id=${variant.id})`)
      .join(", ");
  }

  private isValidCaseBreakSource(sourceVariant: ProductVariant, pickVariant: ProductVariant): boolean {
    const sourceUnits = this.variantUnits(sourceVariant);
    const pickUnits = this.variantUnits(pickVariant);
    return sourceUnits > pickUnits && sourceUnits % pickUnits === 0;
  }

  private async getSourceSlotRank(sourceVariantId: number, sourceLocationId: number): Promise<number> {
    const [slot] = await this.db
      .select({
        isPrimary: productLocations.isPrimary,
        status: productLocations.status,
      })
      .from(productLocations)
      .where(and(
        eq(productLocations.productVariantId, sourceVariantId),
        eq(productLocations.warehouseLocationId, sourceLocationId),
      ))
      .limit(1);

    if (!slot) return 2;
    if (slot.status === "active" && slot.isPrimary === 1) return 0;
    if (slot.status === "active") return 1;
    return 3;
  }

  private async resolveEligibleSourceCandidate(params: {
    pickVariant: ProductVariant;
    pickVariantId: number;
    warehouseId: number | undefined;
    sourceLocationType: string;
    parentLocationId?: number | null;
    sourcePriority: string;
    sourceHierarchyLevel: number | null;
    qtyNeeded: number;
  }): Promise<SourceCandidateResolution> {
    const {
      pickVariant,
      pickVariantId,
      warehouseId,
      sourceLocationType,
      parentLocationId,
      sourcePriority,
      sourceHierarchyLevel,
      qtyNeeded,
    } = params;

    if (sourceHierarchyLevel == null || sourceHierarchyLevel === pickVariant.hierarchyLevel) {
      const location = await this.findSourceLocation(
        pickVariantId,
        warehouseId,
        sourceLocationType,
        parentLocationId,
        sourcePriority,
      );
      if (location) {
        return {
          status: "found",
          variant: pickVariant,
          location,
          candidateCount: 1,
          note: `same-variant source stock found in ${sourceLocationType} locations`,
        };
      }
      return {
        status: "not_found",
        issue: {
          reason: "no_source_stock",
          note: `No source stock found for ${pickVariant.sku ?? `variant #${pickVariantId}`} in ${sourceLocationType} locations`,
        },
      };
    }

    if (!pickVariant.productId) {
      return {
        status: "not_found",
        issue: {
          reason: "no_source_variant",
          note: `Cannot resolve source variant for ${pickVariant.sku ?? `variant #${pickVariantId}`}: missing product_id`,
        },
      };
    }

    const siblings = await this.db
      .select()
      .from(productVariants)
      .where(and(
        eq(productVariants.productId, pickVariant.productId),
        eq(productVariants.isActive, true),
      ));

    const sourceVariants = (siblings as ProductVariant[])
      .filter((variant) =>
        variant.id !== pickVariantId &&
        variant.hierarchyLevel === sourceHierarchyLevel &&
        this.isActiveVariant(variant) &&
        this.isValidCaseBreakSource(variant, pickVariant)
      )
      .sort((a, b) => {
        const aParent = a.id === pickVariant.parentVariantId ? 0 : 1;
        const bParent = b.id === pickVariant.parentVariantId ? 0 : 1;
        return (
          aParent - bParent ||
          this.variantUnits(a) - this.variantUnits(b) ||
          (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
          a.id - b.id
        );
      });

    if (sourceVariants.length === 0) {
      const activeAtLevel = (siblings as ProductVariant[])
        .filter((variant) =>
          variant.id !== pickVariantId &&
          variant.hierarchyLevel === sourceHierarchyLevel &&
          this.isActiveVariant(variant)
        );
      const sameVariantLocation = await this.findSourceLocation(
        pickVariantId,
        warehouseId,
        sourceLocationType,
        parentLocationId,
        sourcePriority,
      );
      if (sameVariantLocation) {
        return {
          status: "found",
          variant: pickVariant,
          location: sameVariantLocation,
          candidateCount: 1,
          note:
            `no valid level ${sourceHierarchyLevel} source variant exists; ` +
            `falling back to same-variant source stock in ${sourceLocationType} locations`,
        };
      }
      return {
        status: "not_found",
        issue: {
          reason: "no_source_variant",
          note:
            `No valid source variant for ${pickVariant.sku ?? `variant #${pickVariantId}`} at hierarchy level ${sourceHierarchyLevel}. ` +
            `Active level candidates: ${this.formatSourceCandidates(activeAtLevel)}`,
        },
      };
    }

    const eligible: Array<{
      variant: ProductVariant;
      location: WarehouseLocation;
      slotRank: number;
      overfillUnits: number;
    }> = [];

    for (const sourceVariant of sourceVariants) {
      const location = await this.findSourceLocation(
        sourceVariant.id,
        warehouseId,
        sourceLocationType,
        parentLocationId,
        sourcePriority,
      );
      if (!location) continue;

      const sourceUnits = this.variantUnits(sourceVariant);
      eligible.push({
        variant: sourceVariant,
        location,
        slotRank: await this.getSourceSlotRank(sourceVariant.id, location.id),
        overfillUnits: (Math.ceil(Math.max(1, qtyNeeded) / sourceUnits) * sourceUnits) - Math.max(1, qtyNeeded),
      });
    }

    if (eligible.length === 0) {
      return {
        status: "not_found",
        issue: {
          reason: "no_source_stock",
          note:
            `No source stock found for valid level ${sourceHierarchyLevel} variants of ` +
            `${pickVariant.sku ?? `variant #${pickVariantId}`} in ${sourceLocationType} locations. ` +
            `Checked: ${this.formatSourceCandidates(sourceVariants)}`,
        },
      };
    }

    eligible.sort((a, b) => (
      a.slotRank - b.slotRank ||
      a.overfillUnits - b.overfillUnits ||
      this.variantUnits(a.variant) - this.variantUnits(b.variant) ||
      (a.location.pickSequence ?? Number.MAX_SAFE_INTEGER) - (b.location.pickSequence ?? Number.MAX_SAFE_INTEGER) ||
      a.variant.id - b.variant.id
    ));

    const best = eligible[0];
    return {
      status: "found",
      variant: best.variant,
      location: best.location,
      candidateCount: eligible.length,
      note:
        `eligibility-aware source resolution checked ${sourceVariants.length} active level ${sourceHierarchyLevel} variant(s), ` +
        `${eligible.length} had valid ${sourceLocationType} stock`,
    };
  }

  // ---------------------------------------------------------------------------
  // WAREHOUSE SETTINGS + UNIFIED EXECUTION DECISION
  // ---------------------------------------------------------------------------

  /**
   * Get warehouse settings for a given warehouse ID.
   * Falls back to the DEFAULT row if no warehouse-specific settings exist.
   */
  async getSettingsForWarehouse(warehouseId?: number): Promise<WarehouseSettings | null> {
    // Delegates to the shared resolver so every service gets identical
    // fallback behavior. See server/modules/warehouse/settings.resolver.ts.
    return sharedGetSettingsForWarehouse(warehouseId, this.db as any);
  }

  /**
   * Unified execution decision. Replaces scattered autoReplen/replenMode checks.
   *
   * autoReplen values:
   *   - null / 0 = defer to next layer (no opinion)
   *   - 1 = force auto-complete
   *   - 2 = force manual (queue)
   *
   * Resolution hierarchy (most specific wins):
   *   1. SKU rule autoReplen (if 1 or 2)
   *   2. Tier default autoReplen (if 1 or 2)
   *   3. Warehouse settings replenMode (fallback):
   *      - "inline"  → auto-execute
   *      - "queue"   → don't auto-execute
   *      - "hybrid"  → auto-execute if qty <= inlineReplenMaxUnits
   */
  resolveAutoExecute(
    autoReplenFromRule: number | null | undefined,
    autoReplenFromTierDefault: number | null | undefined,
    settings: WarehouseSettings | null,
    qtyTargetUnits: number,
  ): { shouldAutoExecute: boolean; executionMode: "inline" | "queue" } {
    // Layer 1: SKU rule override (only 1=force-auto or 2=force-manual are overrides; 0/null = defer)
    if (autoReplenFromRule === 1) {
      return { shouldAutoExecute: true, executionMode: "inline" };
    }
    if (autoReplenFromRule === 2) {
      return { shouldAutoExecute: false, executionMode: "queue" };
    }

    // Layer 2: Tier default override (only 1=force-auto or 2=force-manual are overrides; 0/null = defer)
    if (autoReplenFromTierDefault === 1) {
      return { shouldAutoExecute: true, executionMode: "inline" };
    }
    if (autoReplenFromTierDefault === 2) {
      return { shouldAutoExecute: false, executionMode: "queue" };
    }

    // Layer 3: Warehouse settings fallback
    const mode = settings?.replenMode || "queue";
    if (mode === "inline") {
      return { shouldAutoExecute: true, executionMode: "inline" };
    }
    if (mode === "hybrid") {
      const threshold = settings?.inlineReplenMaxUnits || 50;
      const auto = qtyTargetUnits <= threshold;
      return { shouldAutoExecute: auto, executionMode: auto ? "inline" : "queue" };
    }

    // "queue" or anything else
    return { shouldAutoExecute: false, executionMode: "queue" };
  }

  /**
   * Find a source (bulk) location that has on-hand stock for the given variant.
   *
   * Resolution order (hybrid approach):
   * 1. Dedicated parent -- if the pick location has `parentLocationId` set and
   *    the parent has stock for the source variant, use it immediately.
   * 2. General search -- scan all locations of `sourceLocationType` in the
   *    same warehouse, ordered by sourcePriority (FIFO or smallest_first).
   */
  private async findSourceLocation(
    productVariantId: number,
    warehouseId: number | undefined,
    sourceLocationType: string,
    parentLocationId?: number | null,
    sourcePriority?: string,
  ): Promise<WarehouseLocation | null> {
    // --- 1. Try dedicated parent location first ---
    if (parentLocationId) {
      const [parentLevel] = await this.db.select().from(inventoryLevels).where(
        and(
          eq(inventoryLevels.productVariantId, productVariantId),
          eq(inventoryLevels.warehouseLocationId, parentLocationId)
        )
      ).limit(1);
      if (parentLevel && parentLevel.variantQty > 0) {
        const [parentLoc] = await this.db
          .select()
          .from(warehouseLocations)
          .where(eq(warehouseLocations.id, parentLocationId))
          .limit(1);
        if (
          parentLoc &&
          parentLoc.locationType === sourceLocationType &&
          parentLoc.isActive === 1 &&
          parentLoc.cycleCountFreezeId == null
        ) {
          return parentLoc;
        }
      }
    }

    // --- 2. Fallback: general search (FIFO) ---
    // Source lookup: if inventory_levels shows stock at a location of the right type, it's valid.
    // product_locations assignment is for slotting (where SKU lives permanently), not for
    // sourcing (where stock physically IS right now). Stock can end up at unassigned locations
    // via transfers, receives, etc. — if it's there and pickable, it's a valid source.
    const query = this.db
      .select({
        level: inventoryLevels,
        location: warehouseLocations,
      })
      .from(inventoryLevels)
      .innerJoin(
        warehouseLocations,
        eq(inventoryLevels.warehouseLocationId, warehouseLocations.id),
      );

    const levelsWithStock = await query
      .where(
        and(
          eq(inventoryLevels.productVariantId, productVariantId),
          eq(warehouseLocations.locationType, sourceLocationType),
          eq(warehouseLocations.isActive, 1),
          isNull(warehouseLocations.cycleCountFreezeId),
          sql`${inventoryLevels.variantQty} > 0`,
          ...(warehouseId != null
            ? [eq(warehouseLocations.warehouseId, warehouseId)]
            : []),
        ),
      )
      .orderBy(
        sourcePriority === "smallest_first"
          ? inventoryLevels.variantQty       // ascending = smallest first
          : inventoryLevels.updatedAt        // ascending = FIFO (oldest first)
      );

    if (levelsWithStock.length === 0) return null;

    // Return the first matching location
    const first = levelsWithStock[0] as any;
    return first.location as WarehouseLocation;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new `ReplenishmentService` bound to the supplied Drizzle
 * database instance and inventory core service.
 *
 * ```ts
 * import { db } from "../db";
 * import { createInventoryCoreService } from "./inventory-core";
 * import { createReplenishmentService } from "./replenishment";
 *
 * const inventoryCore = createInventoryCoreService(db);
 * const replen = createReplenishmentService(db, inventoryCore);
 * await replen.checkReplenNeeded(variantId, locationId);
 * ```
 */
export function createReplenishmentService(db: any, inventoryUseCases: any) {
  return new ReplenishmentUseCases(db, inventoryUseCases);
}
