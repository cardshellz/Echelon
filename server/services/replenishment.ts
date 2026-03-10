import { eq, and, sql, inArray, isNull } from "drizzle-orm";
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
import { notify } from "./notifications";
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
  skipReason?: string | null;
};

type ResolvedReplenParams = {
  triggerValue: number | null;
  maxQty: number | null;
  replenMethod: string;
  priority: number;
  sourceLocationType: string;
  autoReplen: number;
  sourceVariantId: number | null;
  sourcePriority: string;
};

type ReplenEvalResult =
  | { status: "skip"; skipReason: string }
  | { status: "dedup"; existingTaskId: number }
  | {
      status: "needed_with_source" | "needed_stockout";
      level: InventoryLevel;
      location: WarehouseLocation;
      variant: ProductVariant;
      whSettings: WarehouseSettings | null;
      params: ResolvedReplenParams;
      taskNotes: string;
      rule: ReplenRule | null;
      sourceLocation: WarehouseLocation | null;
      resolvedSourceVariantId: number | null;
      sourceVariant: ProductVariant;
      qtySourceUnits: number;
      qtyTargetUnits: number;
      executionMode: string;
      shouldAutoExecute: boolean;
    };

type InventoryCore = {
  getLevel: (productVariantId: number, warehouseLocationId: number) => Promise<InventoryLevel | null>;
  upsertLevel: (productVariantId: number, warehouseLocationId: number, initial?: Partial<InventoryLevel>) => Promise<InventoryLevel>;
  adjustLevel: (levelId: number, deltas: Record<string, number | undefined>) => Promise<InventoryLevel>;
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

/**
 * Replenishment service for the Echelon WMS.
 *
 * Detects low stock in forward-pick locations and creates/executes tasks
 * to move inventory from bulk storage. Manages the full replen task
 * lifecycle: creation, execution (with case-break support), cancellation,
 * and auto-triggering after picks.
 *
 * Design principles:
 * - Receives `db` and `inventoryCore` via constructor -- no global singletons.
 * - Uses replen rules (SKU overrides) and tier defaults (hierarchy-level rules)
 *   to determine replenishment parameters.
 * - Deduplicates tasks: will not create a new pending task for a product+location
 *   pair that already has one in pending/assigned/in_progress state.
 */
class ReplenishmentService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly inventoryCore: InventoryCore,
  ) {}

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
    const sourceVariantId = rule?.sourceProductVariantId ?? await this.resolveSourceVariant(variant, tierDefault);
    const sourcePriority = rule?.sourcePriority ?? tierDefault?.sourcePriority ?? "fifo";

    return { triggerValue, maxQty, replenMethod, priority, sourceLocationType, autoReplen, sourceVariantId, sourcePriority };
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
  ): Promise<ReplenEvalResult> {
    const _tag = `[Replen evaluate] variant=${productVariantId} loc=${warehouseLocationId}`;

    const level = await this.inventoryCore.getLevel(productVariantId, warehouseLocationId);
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

    console.log(`${_tag} variant=${variant.sku} loc=${location.code} onHand=${level.variantQty} hierarchyLevel=${variant.hierarchyLevel}`);

    const whSettings = await this.getSettingsForWarehouse(location.warehouseId ?? undefined);
    const locConfig = await this.loadLocationConfig(warehouseLocationId, productVariantId);
    const params = await this.resolveReplenParams(productVariantId, variant, location.warehouseId ?? undefined, locConfig);

    const { triggerValue, maxQty, replenMethod, sourceLocationType, autoReplen, sourcePriority } = params;
    let resolvedSourceVariantId = params.sourceVariantId;
    let resolvedReplenMethod = replenMethod;

    if (triggerValue == null || triggerValue < 0)
      return { status: "skip", skipReason: "no_trigger_value" };

    const { belowThreshold, taskNotes } = await this.checkThreshold(resolvedReplenMethod, triggerValue, level.variantQty, productVariantId);
    if (!belowThreshold) return { status: "skip", skipReason: "above_threshold" };
    console.log(`${_tag} THRESHOLD MET: method=${resolvedReplenMethod}`);

    const [existingTask] = await this.db
      .select().from(replenTasks)
      .where(and(
        eq(replenTasks.pickProductVariantId, productVariantId),
        eq(replenTasks.toLocationId, warehouseLocationId),
        inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"]),
      )).limit(1);
    if (existingTask)
      return { status: "dedup", existingTaskId: existingTask.id };

    let sourceLocation = await this.findSourceLocation(
      resolvedSourceVariantId ?? productVariantId,
      location.warehouseId ?? undefined,
      sourceLocationType,
      location.parentLocationId,
      sourcePriority,
    );

    if (!sourceLocation && resolvedSourceVariantId == null && variant.productId) {
      const siblings = await this.db.select().from(productVariants)
        .where(and(eq(productVariants.productId, variant.productId), eq(productVariants.isActive, true)));
      const higherSiblings = siblings
        .filter((v: any) => v.id !== productVariantId && v.hierarchyLevel > variant.hierarchyLevel)
        .sort((a: any, b: any) => a.hierarchyLevel - b.hierarchyLevel);

      for (const sib of higherSiblings) {
        sourceLocation = await this.findSourceLocation(
          sib.id, location.warehouseId ?? undefined, sourceLocationType, location.parentLocationId, sourcePriority,
        );
        if (sourceLocation) {
          resolvedSourceVariantId = sib.id;
          if (resolvedReplenMethod === "full_case") resolvedReplenMethod = "case_break";
          console.log(`${_tag} FALLBACK: found case variant ${sib.sku} (id=${sib.id}) at ${sourceLocation.code}`);
          break;
        }
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
        taskNotes, rule, sourceLocation: null,
        resolvedSourceVariantId, sourceVariant: sourceVariant as ProductVariant,
        qtySourceUnits: 0, qtyTargetUnits: 0,
        executionMode, shouldAutoExecute,
      };
    }

    const qtyNeeded = this.calculateQtyNeeded(maxQty, triggerValue!, level.variantQty);
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
      const txCore = this.inventoryCore.withTx(tx);
      let moved = 0;

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

        const sourceLevel = await txCore.getLevel(
          sourceVariant.id,
          task.fromLocationId,
        );
        if (!sourceLevel) {
          throw new Error(
            `No inventory level at location ${task.fromLocationId} for variant ${sourceVariant.id}`,
          );
        }

        const [updated] = await tx
          .update(inventoryLevels)
          .set({
            variantQty: sql`${inventoryLevels.variantQty} - ${task.qtySourceUnits}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(inventoryLevels.id, sourceLevel.id),
              sql`${inventoryLevels.variantQty} >= ${task.qtySourceUnits}`,
            ),
          )
          .returning();

        if (!updated) {
          throw new Error(
            `Insufficient source stock at location ${task.fromLocationId} ` +
            `for variant ${sourceVariant.id} (concurrent claim or qty < ${task.qtySourceUnits})`,
          );
        }

        await txCore.logTransaction({
          productVariantId: sourceVariant.id,
          fromLocationId: task.fromLocationId,
          transactionType: "break",
          variantQtyDelta: -task.qtySourceUnits,
          variantQtyBefore: sourceLevel.variantQty,
          variantQtyAfter: updated.variantQty,
          sourceState: "on_hand",
          targetState: "on_hand",
          referenceType: "replen_task",
          referenceId: String(taskId),
          notes: `Case break: ${task.qtySourceUnits} x ${sourceVariant.name} -> ${pickVariantUnits} x ${pickVariant.name}` +
            (remainder > 0 ? ` (${remainder} base units remainder)` : ""),
          userId: userId ?? null,
        });

        const destLevel = await txCore.upsertLevel(
          pickVariant.id,
          task.toLocationId,
        );

        await txCore.adjustLevel(destLevel.id, {
          variantQty: pickVariantUnits,
        });

        await txCore.logTransaction({
          productVariantId: pickVariant.id,
          fromLocationId: task.fromLocationId,
          toLocationId: task.toLocationId,
          transactionType: "replenish",
          variantQtyDelta: pickVariantUnits,
          variantQtyBefore: destLevel.variantQty,
          variantQtyAfter: destLevel.variantQty + pickVariantUnits,
          sourceState: "on_hand",
          targetState: "on_hand",
          referenceType: "replen_task",
          referenceId: String(taskId),
          notes: `Replen case-break to pick location` +
            (remainder > 0 ? ` (${remainder} base units lost in conversion)` : ""),
          userId: userId ?? null,
        });

        moved = baseUnitsFromSource;
      } else {
        const variantId = task.sourceProductVariantId ?? task.pickProductVariantId!;
        const variant = sourceVariant ?? pickVariant;
        const baseUnits = task.qtySourceUnits * (variant?.unitsPerVariant ?? 1);

        await txCore.transfer({
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
  ): Promise<ReplenTask | null> {
    const _tag = `[Replen checkAndTrigger] variant=${productVariantId} loc=${warehouseLocationId}`;

    const eval_ = await this.evaluateReplenNeed(productVariantId, warehouseLocationId);

    if (eval_.status === "skip") {
      console.log(`${_tag} EXIT: ${eval_.skipReason}`);
      return null;
    }
    if (eval_.status === "dedup") {
      console.log(`${_tag} EXIT: dedup — existing task #${eval_.existingTaskId}`);
      return null;
    }

    const { location, variant, whSettings, params, taskNotes, rule, resolvedSourceVariantId } = eval_;
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
          productId: rule?.productId ?? null,
          replenMethod,
          whSettings,
          taskNotes,
          triggeredBy,
          priority,
          autoReplen,
        });
        if (cascadeResult) return cascadeResult;
      }

      await this.db
        .insert(replenTasks)
        .values({
          replenRuleId: rule?.id ?? null,
          fromLocationId: warehouseLocationId,
          toLocationId: warehouseLocationId,
          productId: rule?.productId ?? null,
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
          warehouseId: location.warehouseId ?? undefined,
          notes: `${taskNotes}\nBlocked: no source stock found in ${sourceLocationType} locations`,
        } satisfies InsertReplenTask)
        .returning();
      console.log(`${_tag} EXIT: created BLOCKED task — no source stock in ${sourceLocationType} locations`);
      notify("stockout", {
        title: `Stockout: ${variant.sku ?? `variant #${productVariantId}`}`,
        message: `No source stock found in ${sourceLocationType} locations for ${location.code}`,
        data: { productVariantId, locationId: warehouseLocationId, locationCode: location.code },
      }).catch(() => {});
      return null;
    }

    const { sourceLocation, sourceVariant, qtySourceUnits, qtyTargetUnits, executionMode } = eval_;

    console.log(`${_tag} CREATING TASK: from=${sourceLocation!.code}(id=${sourceLocation!.id}) to=${location.code} qty=${qtySourceUnits}x${sourceVariant.unitsPerVariant}=${qtyTargetUnits} method=${replenMethod}`);
    const [task] = await this.db
      .insert(replenTasks)
      .values({
        replenRuleId: rule?.id ?? null,
        fromLocationId: sourceLocation!.id,
        toLocationId: warehouseLocationId,
        productId: rule?.productId ?? null,
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
        warehouseId: location.warehouseId ?? undefined,
        notes: taskNotes,
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
  ): Promise<ReplenGuidance> {
    const noReplen = (reason: string): ReplenGuidance => ({
      needed: false, stockout: false, sourceLocationId: null, sourceLocationCode: null,
      sourceVariantId: null, sourceVariantSku: null, sourceVariantName: null,
      pickVariantId: productVariantId, qtySourceUnits: 0, qtyTargetUnits: 0,
      replenMethod: "full_case", executionMode: "queue", taskNotes: "", skipReason: reason,
    });

    const eval_ = await this.evaluateReplenNeed(productVariantId, warehouseLocationId);

    if (eval_.status === "skip") return noReplen(eval_.skipReason);
    if (eval_.status === "dedup") return noReplen(`dedup_existing_task (#${eval_.existingTaskId})`);

    const { sourceLocation, sourceVariant, resolvedSourceVariantId, qtySourceUnits, qtyTargetUnits, params, taskNotes, executionMode } = eval_;

    if (eval_.status === "needed_stockout") {
      return {
        needed: true, stockout: true,
        sourceLocationId: null, sourceLocationCode: null,
        sourceVariantId: null, sourceVariantSku: null, sourceVariantName: null,
        pickVariantId: productVariantId, qtySourceUnits: 0, qtyTargetUnits: 0,
        replenMethod: params.replenMethod, executionMode, taskNotes,
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
      executionMode, taskNotes,
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
  ): Promise<{ task: ReplenTask; moved: number } | null> {
    const _tag = `[Replen createAndExecute] variant=${pickVariantId} loc=${toLocationId}`;

    // Re-derive guidance from current DB state (fresh, not stale)
    const guidance = await this.checkReplenNeeded(pickVariantId, toLocationId);
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
      productId: rule?.productId ?? null,
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
      warehouseId: location.warehouseId ?? undefined,
      notes: `${guidance.taskNotes}\nConfirmed by picker, executing atomically`,
    } satisfies InsertReplenTask).returning();

    console.log(`${_tag} created task ${task.id}, executing immediately...`);

    // Execute the inventory movement
    try {
      const result = await this.executeTask(task.id, userId ?? "picker:confirmed");
      console.log(`${_tag} task ${task.id} executed, moved ${result.moved} units`);
      // Re-read task to get final state
      const [completed] = await this.db.select().from(replenTasks).where(eq(replenTasks.id, task.id)).limit(1);
      return { task: completed as ReplenTask, moved: result.moved };
    } catch (err: any) {
      console.error(`${_tag} executeTask failed for task ${task.id}:`, err?.message);
      // Mark as blocked so it's visible in the queue for manual resolution
      await this.db.update(replenTasks).set({
        status: "blocked",
        notes: `${task.notes}\nExecution failed: ${err?.message || "unknown error"}`,
      }).where(eq(replenTasks.id, task.id));
      // Re-throw so caller gets the real reason (not confused with "no source stock")
      throw new Error(`execute_failed: ${err?.message || "unknown error"}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 5a-NEW3. INFER UNRECORDED REPLEN FROM BIN COUNT SURPLUS
  // ---------------------------------------------------------------------------

  /**
   * When a bin count reveals more inventory than the system expects and the
   * picker did NOT confirm a replen, we infer that an unrecorded case break
   * (or full-case move) happened at some prior point. This method:
   *
   * 1. Resolves the replen source for the variant+location (rule/tier config)
   * 2. Calculates how many whole source units (cases) explain the surplus
   * 3. Creates a completed replen task and executes the source deduction
   * 4. Returns the number of pick-variant units attributed to the inferred replen
   *
   * The caller uses the return value to split the bin count adjustment into
   * "explained by replen" and "unexplained cycle count variance".
   *
   * Returns null if no source is configured or stock is insufficient.
   */
  async inferUnrecordedReplen(
    pickVariantId: number,
    toLocationId: number,
    surplusQty: number,
    userId?: string,
  ): Promise<{ task: ReplenTask; moved: number } | null> {
    const _tag = `[Replen inferUnrecorded] variant=${pickVariantId} loc=${toLocationId} surplus=${surplusQty}`;

    if (surplusQty <= 0) return null;

    // --- Resolve source configuration (same as checkReplenNeeded but NO threshold check) ---

    const [variant] = await this.db.select().from(productVariants).where(eq(productVariants.id, pickVariantId)).limit(1);
    if (!variant) { console.log(`${_tag} EXIT: variant not found`); return null; }

    const [location] = await this.db.select().from(warehouseLocations).where(eq(warehouseLocations.id, toLocationId)).limit(1);
    if (!location) { console.log(`${_tag} EXIT: location not found`); return null; }

    // Only infer for assigned pick locations
    const [assignment] = await this.db.select({ id: productLocations.id }).from(productLocations)
      .where(and(eq(productLocations.productVariantId, pickVariantId), eq(productLocations.warehouseLocationId, toLocationId))).limit(1);
    if (!assignment) { console.log(`${_tag} EXIT: no product_locations assignment`); return null; }

    const rule = await this.findRuleForVariant(pickVariantId);
    const tierDefault = await this.findTierDefaultForVariant(variant.hierarchyLevel, location.warehouseId ?? undefined);

    const replenMethod = rule?.replenMethod ?? tierDefault?.replenMethod ?? "full_case";
    const sourceLocationType = rule?.sourceLocationType ?? tierDefault?.sourceLocationType ?? "reserve";
    const sourceVariantId = rule?.sourceProductVariantId ?? await this.resolveSourceVariant(variant, tierDefault);

    // Find source location
    const sourcePriority = rule?.sourcePriority ?? tierDefault?.sourcePriority ?? "fifo";
    const sourceLocation = await this.findSourceLocation(
      sourceVariantId ?? pickVariantId, location.warehouseId ?? undefined, sourceLocationType, location.parentLocationId, sourcePriority,
    );

    if (!sourceLocation) {
      console.log(`${_tag} no source location found — cannot infer replen`);
      return null;
    }

    // Resolve source variant
    const sourceVariant = sourceVariantId != null
      ? (await this.db.select().from(productVariants).where(eq(productVariants.id, sourceVariantId)).limit(1))[0] ?? variant
      : variant;

    // Calculate how many whole source units explain the surplus
    // e.g., surplus=50 pick units, source case has 100 base units, pick variant has 1 base unit per variant
    //   → 50 pick units = 50 base units → need ceil(50/100) = 1 case, which produces 100 pick units
    // But we should only infer cases that fit within the surplus:
    //   → floor(surplus / unitsPerCase) whole cases
    const pickUnitsPerSourceUnit = replenMethod === "case_break" && sourceVariant.id !== variant.id
      ? Math.floor(sourceVariant.unitsPerVariant / variant.unitsPerVariant)
      : 1;

    if (pickUnitsPerSourceUnit <= 0) {
      console.log(`${_tag} EXIT: cannot compute pick units per source unit`);
      return null;
    }

    // Always break whole cases — ceil because any surplus implies at least one
    // case was broken. The remainder (case units minus what picker counted)
    // gets reconciled as cycle count variance by the caller.
    const wholeCases = Math.ceil(surplusQty / pickUnitsPerSourceUnit);

    const qtySourceUnits = wholeCases;
    const qtyTargetUnits = wholeCases * pickUnitsPerSourceUnit;

    console.log(`${_tag} INFERRED: ${qtySourceUnits} source units from ${sourceLocation.code} → ${qtyTargetUnits} pick units, method=${replenMethod}`);

    // Create task as pending (executeTask will transition to completed)
    const [task] = await this.db.insert(replenTasks).values({
      replenRuleId: rule?.id ?? null,
      fromLocationId: sourceLocation.id,
      toLocationId,
      productId: rule?.productId ?? null,
      sourceProductVariantId: sourceVariant.id,
      pickProductVariantId: pickVariantId,
      qtySourceUnits,
      qtyTargetUnits,
      qtyCompleted: 0,
      status: "pending",
      priority: rule?.priority ?? 5,
      triggeredBy: "inferred_bin_count",
      executionMode: "auto",
      replenMethod,
      autoReplen: rule?.autoReplen ?? 0,
      warehouseId: location.warehouseId ?? undefined,
      notes: `Inferred from bin count: surplus=${surplusQty}, attributed=${qtyTargetUnits} (${qtySourceUnits} source units from ${sourceLocation.code})`,
    } satisfies InsertReplenTask).returning();

    console.log(`${_tag} created inferred task ${task.id}, executing...`);

    try {
      const result = await this.executeTask(task.id, userId ?? "system:inferred_replen");
      console.log(`${_tag} task ${task.id} executed, moved ${result.moved} units`);
      const [completed] = await this.db.select().from(replenTasks).where(eq(replenTasks.id, task.id)).limit(1);
      return { task: completed as ReplenTask, moved: result.moved };
    } catch (err: any) {
      console.error(`${_tag} executeTask failed for task ${task.id}:`, err?.message);
      await this.db.update(replenTasks).set({
        status: "blocked",
        notes: `${task.notes}\nExecution failed: ${err?.message || "unknown error"}`,
      }).where(eq(replenTasks.id, task.id));
      // Don't throw — the caller will still do the cycle count for the full surplus
      return null;
    }
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
   * Cancel replen task when picker confirms replen was NOT needed
   * This handles cases where system thought replen was needed but picker disagrees (drift)
   */
  async cancelPickerReplen(taskId: number): Promise<void> {
    const [task] = await this.db
      .select()
      .from(replenTasks)
      .where(eq(replenTasks.id, taskId))
      .limit(1);

    if (!task) {
      throw new Error(`Replen task ${taskId} not found`);
    }

    // Cancel the task
    await this.db
      .update(replenTasks)
      .set({
        status: "cancelled",
        notes: `${task.notes || ""}\nCancelled by picker - replen not needed (system drift)`,
      })
      .where(eq(replenTasks.id, taskId));
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

    const locConfig = await this.loadLocationConfig(location.id, variant.id);
    const params = await this.resolveReplenParams(variant.id, variant, location.warehouseId ?? undefined, locConfig);

    const sourceLocation = await this.findSourceLocation(
      params.sourceVariantId ?? variant.id,
      location.warehouseId ?? undefined,
      params.sourceLocationType,
      location.parentLocationId,
      params.sourcePriority,
    );

    if (!sourceLocation) return { action: "true_short_pick" };

    if (sourceLocation.isPickable === 1) {
      const sourceLevel = await this.inventoryCore.getLevel(
        params.sourceVariantId ?? variant.id, sourceLocation.id,
      );
      const sourceVariant = params.sourceVariantId
        ? (await this.db.select().from(productVariants).where(eq(productVariants.id, params.sourceVariantId)).limit(1))[0]
        : variant;

      return {
        action: "replen_inline",
        source: {
          locationCode: sourceLocation.code,
          availableQty: sourceLevel?.variantQty ?? 0,
          variantSku: sourceVariant?.sku ?? variant.sku,
          variantName: sourceVariant?.name || sourceVariant?.sku || variant.sku,
        },
      };
    }

    return { action: "short_pick_with_replen" };
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
        warehouseId: opts.warehouseId,
        notes: `Cascade: break ${grandparentVariant.sku || grandparentVariant.name} into ${intermediateVariant.sku || intermediateVariant.name}`,
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

  /**
   * Resolve the source variant for a pick variant.
   * Strategy 1: Walk parentVariantId (per-product packaging hierarchy).
   * Strategy 2: Fall back to tier default sourceHierarchyLevel (legacy).
   *
   * @param productVariantsCache  Optional pre-loaded map of productId → variants
   *                              (optional pre-loaded cache to avoid N+1 queries)
   */
  private async resolveSourceVariant(
    pickVariant: ProductVariant,
    tierDefault: ReplenTierDefault | null,
    productVariantsCache?: Map<number, ProductVariant[]>,
  ): Promise<number | null> {
    if (!tierDefault) return null;
    if (tierDefault.sourceHierarchyLevel === pickVariant.hierarchyLevel) return null;

    // Load siblings for this product
    let siblings: ProductVariant[];
    if (productVariantsCache && pickVariant.productId) {
      siblings = productVariantsCache.get(pickVariant.productId) ?? [];
    } else {
      siblings = pickVariant.productId
        ? await this.db
            .select()
            .from(productVariants)
            .where(eq(productVariants.productId, pickVariant.productId))
        : [];
    }

    // Primary: find variant at the tier default's source hierarchy level
    const sourceByLevel = siblings.find(
      (v) => v.hierarchyLevel === tierDefault.sourceHierarchyLevel && v.isActive,
    );
    if (sourceByLevel) return sourceByLevel.id;

    // Fallback: use parentVariantId only if it points to a HIGHER hierarchy level
    if (pickVariant.parentVariantId) {
      const parentVar = siblings.find((v) => v.id === pickVariant.parentVariantId);
      if (parentVar && parentVar.hierarchyLevel > pickVariant.hierarchyLevel) {
        return parentVar.id;
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // WAREHOUSE SETTINGS + UNIFIED EXECUTION DECISION
  // ---------------------------------------------------------------------------

  /**
   * Get warehouse settings for a given warehouse ID.
   * Falls back to the DEFAULT row if no warehouse-specific settings exist.
   */
  async getSettingsForWarehouse(warehouseId?: number): Promise<WarehouseSettings | null> {
    if (warehouseId != null) {
      // Try by warehouse_id FK first
      const [specific] = await this.db
        .select()
        .from(warehouseSettings)
        .where(eq(warehouseSettings.warehouseId, warehouseId))
        .limit(1);
      if (specific) return specific as WarehouseSettings;

      // Try by warehouse code (settings may be linked by code, not FK)
      const [wh] = await this.db
        .select()
        .from(warehouses)
        .where(eq(warehouses.id, warehouseId))
        .limit(1);
      if (wh) {
        const [byCode] = await this.db
          .select()
          .from(warehouseSettings)
          .where(eq(warehouseSettings.warehouseCode, (wh as any).code))
          .limit(1);
        if (byCode) return byCode as WarehouseSettings;
      }
    }

    // Fall back to DEFAULT row
    const [defaultRow] = await this.db
      .select()
      .from(warehouseSettings)
      .where(eq(warehouseSettings.warehouseCode, "DEFAULT"))
      .limit(1);
    return (defaultRow as WarehouseSettings) ?? null;
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
      const parentLevel = await this.inventoryCore.getLevel(
        productVariantId,
        parentLocationId,
      );
      if (parentLevel && parentLevel.variantQty > 0) {
        const [parentLoc] = await this.db
          .select()
          .from(warehouseLocations)
          .where(eq(warehouseLocations.id, parentLocationId))
          .limit(1);
        if (parentLoc) return parentLoc;
      }
    }

    // --- 2. Fallback: general search (FIFO) ---
    // For pick locations, require the variant to be assigned there via product_locations.
    // Reserve/bulk locations have no assignment constraint.
    const isPick = sourceLocationType === "pick" || sourceLocationType === "forward_pick";
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

    if (isPick) {
      (query as any).innerJoin(
        productLocations,
        and(
          eq(productLocations.warehouseLocationId, inventoryLevels.warehouseLocationId),
          eq(productLocations.productVariantId, inventoryLevels.productVariantId),
        ),
      );
    }

    const levelsWithStock = await query
      .where(
        and(
          eq(inventoryLevels.productVariantId, productVariantId),
          eq(warehouseLocations.locationType, sourceLocationType),
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
export function createReplenishmentService(db: any, inventoryCore: any) {
  return new ReplenishmentService(db, inventoryCore);
}
