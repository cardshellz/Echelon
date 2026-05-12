import { eq, and, or, sql, inArray, isNull } from "drizzle-orm";
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
      ))
      .limit(1);

    return (task as ReplenTask | undefined) ?? null;
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

  private async executeInlineTaskForPicker(
    task: ReplenTask,
    userId: string | undefined,
    tag: string,
  ): Promise<{ task: ReplenTask; moved: number }> {
    try {
      const result = await this.executeTask(task.id, userId ?? "picker:confirmed");
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

  // ---------------------------------------------------------------------------
  // CORE EVALUATION — single source of truth for "does this bin need replen?"
  // ---------------------------------------------------------------------------

  private async evaluateReplenNeed(
    productVariantId: number,
    warehouseLocationId: number,
    options?: { currentQtyOverride?: number },
  ): Promise<ReplenEvalResult> {
    const _tag = `[Replen evaluate] variant=${productVariantId} loc=${warehouseLocationId}`;

    // Here we query the level directly since InventoryUseCases doesn't expose getLevel anymore
    const { inventoryLevels } = await import("@shared/schema");
    const [level] = await this.db.select().from(inventoryLevels)
      .where(and(eq(inventoryLevels.productVariantId, productVariantId), eq(inventoryLevels.warehouseLocationId, warehouseLocationId))).limit(1);
    if (!level) return { status: "skip", skipReason: "no_inventory_level" };

    const [location] = await this.db
      .select().from(warehouseLocations)
      .where(eq(warehouseLocations.id, warehouseLocationId)).limit(1);
    if (!location || location.isPickable !== 1)
      return { status: "skip", skipReason: "location_not_pickable" };

    const [assignment] = await this.db
      .select({ id: productLocations.id }).from(productLocations)
      .where(and(
        eq(productLocations.productVariantId, productVariantId),
        eq(productLocations.warehouseLocationId, warehouseLocationId),
      )).limit(1);
    if (!assignment) return { status: "skip", skipReason: "no_bin_assignment" };

    const [variant] = await this.db
      .select().from(productVariants)
      .where(eq(productVariants.id, productVariantId)).limit(1);
    if (!variant) return { status: "skip", skipReason: "variant_not_found" };

    const evaluatedQty = options?.currentQtyOverride ?? level.variantQty;
    console.log(`${_tag} variant=${variant.sku} loc=${location.code} onHand=${level.variantQty} evaluatedQty=${evaluatedQty} hierarchyLevel=${variant.hierarchyLevel}`);

    const whSettings = await this.getSettingsForWarehouse(location.warehouseId ?? undefined);
    const locConfig = await this.loadLocationConfig(warehouseLocationId, productVariantId);
    const params = await this.resolveReplenParams(productVariantId, variant, location.warehouseId ?? undefined, locConfig);

    const { triggerValue, maxQty, replenMethod, sourceLocationType, autoReplen, sourcePriority } = params;
    let resolvedSourceVariantId = params.sourceVariantId;
    let resolvedReplenMethod = replenMethod;

    const existingTask = await this.findActiveTaskForPickBin(productVariantId, warehouseLocationId);
    if (existingTask)
      return { status: "dedup", existingTaskId: existingTask.id, existingTask, params, triggerValue, evaluatedQty };

    if (triggerValue == null || triggerValue < 0)
      return { status: "skip", skipReason: "no_trigger_value", params, triggerValue, evaluatedQty };

    const { belowThreshold, taskNotes } = await this.checkThreshold(resolvedReplenMethod, triggerValue, evaluatedQty, productVariantId);
    if (!belowThreshold) return { status: "skip", skipReason: "above_threshold", params, triggerValue, evaluatedQty };
    console.log(`${_tag} THRESHOLD MET: method=${resolvedReplenMethod}`);

    const qtyNeeded = this.calculateQtyNeeded(maxQty, triggerValue!, evaluatedQty);
    let sourceResolutionIssue: SourceResolutionIssue | null = null;
    let sourceLocation = resolvedSourceVariantId != null
      ? await this.findSourceLocation(
          resolvedSourceVariantId,
          location.warehouseId ?? undefined,
          sourceLocationType,
          location.parentLocationId,
          sourcePriority,
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
        note: `Configured source variant ${configuredSource?.sku ?? `#${resolvedSourceVariantId}`} has no stock in ${sourceLocationType} locations`,
      };
    }

    if (!sourceLocation && resolvedSourceVariantId == null) {
      const sourceResolution = await this.resolveEligibleSourceCandidate({
        pickVariant: variant as ProductVariant,
        pickVariantId: productVariantId,
        warehouseId: location.warehouseId ?? undefined,
        sourceLocationType,
        parentLocationId: location.parentLocationId,
        sourcePriority,
        sourceHierarchyLevel: params.sourceHierarchyLevel,
        qtyNeeded,
      });

      if (sourceResolution.status === "found") {
        resolvedSourceVariantId = sourceResolution.variant.id;
        sourceLocation = sourceResolution.location;
        if (resolvedSourceVariantId !== productVariantId && resolvedReplenMethod === "full_case") {
          resolvedReplenMethod = "case_break";
        }
        console.log(
          `${_tag} SOURCE: ${sourceResolution.note}; selected ${sourceResolution.variant.sku} ` +
          `(id=${sourceResolution.variant.id}) at ${sourceLocation.code}`,
        );
      } else {
        sourceResolutionIssue = sourceResolution.issue;
      }
    }

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
        level, location: location as WarehouseLocation, variant: variant as ProductVariant,
        whSettings, params: { ...params, replenMethod: resolvedReplenMethod, sourceVariantId: resolvedSourceVariantId },
        taskNotes,
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
      level, location: location as WarehouseLocation, variant: variant as ProductVariant,
      whSettings, params: { ...params, replenMethod: resolvedReplenMethod, sourceVariantId: resolvedSourceVariantId },
      taskNotes, rule, sourceLocation: sourceLocation as WarehouseLocation,
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

    // Load source and pick variants
    const [sourceVariant] = task.sourceProductVariantId
      ? await this.db
          .select()
          .from(productVariants)
          .where(eq(productVariants.id, task.sourceProductVariantId))
          .limit(1)
      : [null];

    const [pickVariant] = task.pickProductVariantId
      ? await this.db
          .select()
          .from(productVariants)
          .where(eq(productVariants.id, task.pickProductVariantId))
          .limit(1)
      : [null];

    // Read replen method from the task itself (persisted at creation).
    // Fall back to rule lookup for legacy tasks that predate the column.
    let replenMethod = (task as any).replenMethod || "full_case";
    if (replenMethod === "full_case" && task.replenRuleId) {
      // Legacy fallback: task didn't have replenMethod, try the linked rule
      const [rule] = await this.db
        .select()
        .from(replenRules)
        .where(eq(replenRules.id, task.replenRuleId))
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
        const baseUnitsFromSource = task.qtySourceUnits * sourceVariant.unitsPerVariant;
        const pickVariantUnits = Math.floor(baseUnitsFromSource / pickVariant.unitsPerVariant);
        const remainder = baseUnitsFromSource - (pickVariantUnits * pickVariant.unitsPerVariant);

        if (pickVariantUnits <= 0) {
          throw new Error(
            `Case break would produce 0 pick units: ${task.qtySourceUnits} x ${sourceVariant.unitsPerVariant} ` +
            `base units / ${pickVariant.unitsPerVariant} per pick unit`,
          );
        }

        const breakNotes = `Case break: ${task.qtySourceUnits} x ${sourceVariant.name} -> ${pickVariantUnits} x ${pickVariant.name}` +
          (remainder > 0 ? ` (${remainder} base units remainder)` : "");

        // Decrement source variant via inventoryUseCases.adjustInventory()
        // (routes through audit trail, lot tracking, negative guards, and notifyChange)
        await invTx.adjustInventory({
          productVariantId: sourceVariant.id,
          warehouseLocationId: task.fromLocationId,
          qtyDelta: -task.qtySourceUnits,
          reason: breakNotes,
          userId: userId ?? undefined,
        });

        // Increment target variant via inventoryUseCases.adjustInventory()
        // (routes through audit trail, lot tracking, and notifyChange)
        await invTx.adjustInventory({
          productVariantId: pickVariant.id,
          warehouseLocationId: task.toLocationId,
          qtyDelta: pickVariantUnits,
          reason: `Replen case-break to pick location` +
            (remainder > 0 ? ` (${remainder} base units lost in conversion)` : ""),
          userId: userId ?? undefined,
        });

        moved = baseUnitsFromSource;
      } else {
        const variantId = task.sourceProductVariantId ?? task.pickProductVariantId!;
        const variant = sourceVariant ?? pickVariant;
        const baseUnits = task.qtySourceUnits * (variant?.unitsPerVariant ?? 1);

        await invTx.transfer({
          productVariantId: variantId,
          fromLocationId: task.fromLocationId,
          toLocationId: task.toLocationId,
          qty: task.qtySourceUnits,
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
          assignedTo: userId ?? task.assignedTo,
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

  // ---------------------------------------------------------------------------
  // 5. CHECK AND TRIGGER AFTER PICK -- inline auto-trigger
  // ---------------------------------------------------------------------------

  async checkAndTriggerAfterPick(
    productVariantId: number,
    warehouseLocationId: number,
    triggeredBy: string = "inline_pick",
    context?: ReplenOrderContext,
  ): Promise<ReplenTask | null> {
    const _tag = `[Replen checkAndTrigger] variant=${productVariantId} loc=${warehouseLocationId}`;

    const eval_ = await this.evaluateReplenNeed(productVariantId, warehouseLocationId);

    if (eval_.status === "skip") {
      console.log(`${_tag} EXIT: ${eval_.skipReason}`);
      return null;
    }
    if (eval_.status === "dedup") {
      console.log(`${_tag} EXIT: dedup — existing task #${eval_.existingTaskId}`);
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
        title: `Stockout: ${variant.sku ?? `variant #${productVariantId}`}`,
        message: `No source stock found in ${sourceLocationType} locations for ${location.code}`,
        data: { productVariantId, locationId: warehouseLocationId, locationCode: location.code },
      }).catch(() => {});
      return context?.blocksShipment ? blockedTask as ReplenTask : null;
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
    options?: { currentQtyOverride?: number },
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
    const _tag = `[Replen createAndExecute] variant=${pickVariantId} loc=${toLocationId}`;

    const existingTask = await this.findActiveTaskForPickBin(pickVariantId, toLocationId);
    if (existingTask) {
      console.log(`${_tag} reusing active task ${existingTask.id} status=${existingTask.status}`);
      if (
        existingTask.executionMode === "inline" &&
        EXECUTABLE_REPLEN_TASK_STATUSES.includes(existingTask.status)
      ) {
        return this.executeInlineTaskForPicker(existingTask, userId, _tag);
      }
      return { task: existingTask, moved: 0 };
    }

    // Re-derive guidance from current DB state (fresh, not stale)
    const guidance = await this.checkReplenNeeded(pickVariantId, toLocationId);
    if (guidance.needed && guidance.stockout && context?.blocksShipment) {
      const blockedTask = await this.checkAndTriggerAfterPick(
        pickVariantId,
        toLocationId,
        "inline_pick",
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

    // Create task as completed (the picker already physically did the replen)
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
      triggeredBy: "inline_pick",
      executionMode: guidance.executionMode,
      replenMethod: guidance.replenMethod,
      autoReplen,
      ...this.replenOrderTaskFields(context),
      warehouseId: location.warehouseId ?? undefined,
      notes: this.appendOrderContextNote(
        `${guidance.taskNotes}\nConfirmed by picker, executing atomically`,
        context,
      ),
    } satisfies InsertReplenTask).returning();

    let moved = 0;
    if (guidance.executionMode === "inline") {
      console.log(`${_tag} created task ${task.id}, executing immediately...`);
      return this.executeInlineTaskForPicker(task as ReplenTask, userId, _tag);
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
    const _tag = `[Replen shortPickQueue] variant=${pickVariantId} loc=${toLocationId}`;

    const existingTask = await this.findActiveTaskForPickBin(pickVariantId, toLocationId);
    if (existingTask) {
      console.log(`${_tag} reusing active task ${existingTask.id} status=${existingTask.status}`);
      return { task: existingTask, moved: 0 };
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

  /**
   * @deprecated Use checkReplenNeeded() + createAndExecuteReplen() instead.
   */
  async confirmPickerReplen(
    taskId: number,
    userId?: string
  ): Promise<ReplenTask> {
    // Get the task
    const [task] = await this.db
      .select()
      .from(replenTasks)
      .where(eq(replenTasks.id, taskId))
      .limit(1);

    if (!task) {
      throw new Error(`Replen task ${taskId} not found`);
    }

    if (!["pending", "assigned", "in_progress"].includes(task.status)) {
      throw new Error(`Task ${taskId} is ${task.status}, cannot confirm`);
    }

    // Execute the task (moves inventory)
    await this.executeTask(taskId, userId ?? "picker:confirmed");

    // Return updated task
    const [updated] = await this.db
      .select()
      .from(replenTasks)
      .where(eq(replenTasks.id, taskId))
      .limit(1);

    return updated as ReplenTask;
  }

  /**
   * Cancel replen task when picker confirms replen was NOT needed.
   * 
   * CRITICAL: Before cancelling, this method reconciles the target bin
   * to the picker's actual count. The picker is the source of truth for
   * physical stock — if they say there's 49 units and the system says 1,
   * the system updates to 49.
   *
   * If the actual count reveals a variance from the system, a cycle count
   * is automatically triggered on the source case bin to verify whether
   * an unrecorded case break occurred.
   *
   * @param taskId - The replen task to cancel
   * @param actualCount - The picker's actual bin count (source of truth)
   * @param userId - Who performed the count
   */
  async cancelPickerReplen(taskId: number, actualCount: number, userId?: string): Promise<void> {
    const [task] = await this.db
      .select()
      .from(replenTasks)
      .where(eq(replenTasks.id, taskId))
      .limit(1);

    if (!task) {
      throw new Error(`Replen task ${taskId} not found`);
    }

    if (task.status === "completed" || task.status === "cancelled") {
      return; // Already handled
    }

    const targetVariantId = task.pickProductVariantId ?? task.sourceProductVariantId;
    const targetLocationId = task.toLocationId;

    if (targetVariantId && targetLocationId) {
      // Get current system qty at the target bin
      // Assume we need some level info - we fetch it
      const { inventoryLevels } = await import("@shared/schema");
      const [sourceLevel] = await this.db.select().from(inventoryLevels)
        .where(and(eq(inventoryLevels.productVariantId, task.sourceProductVariantId!), eq(inventoryLevels.warehouseLocationId, task.fromLocationId!))).limit(1);
      const systemQty = sourceLevel?.variantQty ?? 0;
      const variance = actualCount - systemQty;

      // Reconcile: picker's count is the source of truth
      if (variance !== 0) {
        await this.inventoryUseCases.adjustInventory({
          productVariantId: targetVariantId,
          warehouseLocationId: targetLocationId,
          qtyDelta: variance,
          reason: `Bin count reconciliation during replen cancel: system=${systemQty}, actual=${actualCount}, variance=${variance}`,
          userId: userId ?? undefined,
        });

        // If we found MORE stock than expected, a case break may have happened unrecorded.
        // Auto-trigger cycle count on the source case bin to verify.
        if (variance > 0 && task.fromLocationId) {
          await this.autoCreateCycleCountForVariance(
            task.fromLocationId,
            targetLocationId,
            targetVariantId,
            variance,
            systemQty,
            actualCount,
            userId,
          );
        }

        console.log(
          `[Replen] Reconciled bin during cancel: target=${targetLocationId} variant=${targetVariantId} ` +
          `system=${systemQty} actual=${actualCount} variance=${variance}`
        );
      }
    }

    // Cancel the task
    await this.db
      .update(replenTasks)
      .set({
        status: "cancelled",
        notes: `${task.notes || ""}\nCancelled by picker (actual count: ${actualCount})` +
          (userId ? ` by ${userId}` : ""),
      })
      .where(eq(replenTasks.id, taskId));
  }

  /**
   * Auto-create a cycle count task for a source bin when a target bin variance is detected.
   * This notifies the lead/admin to verify the source case bin.
   */
  private async autoCreateCycleCountForVariance(
    sourceLocationId: number,
    targetLocationId: number,
    targetVariantId: number,
    variance: number,
    systemQty: number,
    actualCount: number,
    userId?: string,
  ): Promise<void> {
    try {
      // Look up source variant (the case) from the replen task
      const [sourceLoc] = await this.db
        .select({ code: warehouseLocations.code })
        .from(warehouseLocations)
        .where(eq(warehouseLocations.id, sourceLocationId))
        .limit(1);

      const [targetLoc] = await this.db
        .select({ code: warehouseLocations.code })
        .from(warehouseLocations)
        .where(eq(warehouseLocations.id, targetLocationId))
        .limit(1);

      const [variant] = await this.db
        .select({ sku: productVariants.sku, name: productVariants.name })
        .from(productVariants)
        .where(eq(productVariants.id, targetVariantId))
        .limit(1);

      // Fire notification to leads/admins
      const { notify } = await import("../../notifications/notifications.service");
      await notify("cycle_count_needed", {
        title: `Bin variance detected: ${variant?.sku ?? 'unknown'}`,
        message: `${targetLoc?.code ?? 'target bin'} has ${variance} more units than expected ` +
          `(system: ${systemQty}, actual: ${actualCount}). ` +
          `Verify source bin ${sourceLoc?.code ?? 'unknown'} — possible unrecorded case break.`,
        data: {
          sourceLocationId,
          targetLocationId,
          targetVariantId,
          variance,
          systemQty,
          actualCount,
          triggeredBy: userId ?? "picker_replen_cancel",
        },
      });

      console.log(
        `[Replen] Cycle count notification sent for source bin ${sourceLoc?.code} ` +
        `(variance: +${variance} at ${targetLoc?.code})`
      );
    } catch (err: any) {
      // Non-blocking — notification failure shouldn't fail the reconciliation
      console.warn(`[Replen] Failed to send cycle count notification: ${err.message}`);
    }
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
