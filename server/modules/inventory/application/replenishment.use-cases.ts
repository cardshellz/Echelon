import { IntegrityError } from "@shared/errors";
import { classifyReplenishmentExecutionFailure } from "../infrastructure/replenishment-execution-failure";
import { reportReplenishmentException } from "./report-replenishment-exception";
import { changeReplenishmentTask } from "./replenishment-task-command";
import { createManualReplenishmentTask } from "./create-manual-replenishment-task";
import { creditTransferToReplenishment, recordReplenishmentFollowup } from "../infrastructure/replenishment-transfer-credit.repository";
import { eq, and, or, sql, inArray, isNull, asc } from "drizzle-orm";
import { logger } from "../../../platform/observability/logger";
import { validateReplenishmentTrigger } from "../domain/replenishment-trigger";
import { supportsInlineReplenishment, resolveReplenishmentAutoExecution } from "../domain/replenishment-auto-execution";
import { planReplenishmentDemand, ReplenishmentExecutionDomainError } from "../domain/replenishment-execution.domain";
import { readReplenishmentRule, readReplenishmentTierDefault } from "../infrastructure/replenishment-policy.reader";
import { assertReplenishmentTaskTransition } from "@shared/types/replenishment-task-command";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import {
  replenRules,
  replenTasks,
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
  observedVariantQty?: number;
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
  operationKey?: string;
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
  conversionAuthorization: PackageConversionAuthorization | null;
};

const ACTIVE_REPLEN_TASK_STATUSES = ["pending", "assigned", "in_progress", "blocked"];
const EXECUTABLE_REPLEN_TASK_STATUSES = ["pending", "assigned", "in_progress"];
const RECOVERABLE_BLOCKED_REPLEN_REASONS = new Set<string | null>([
  null,
  "no_source_stock",
  "no_source_variant",
  // Execution failures now carry a classified retry decision. Permanent or
  // unclassified failures must not be replaced by an inventory-change event.
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
    unitCostCents?: number;
  }) => Promise<{ orphanedQty: number; consumedCostCents?: number; consumedQty?: number }>;
  transfer: (params: {
    productVariantId: number;
    fromLocationId: number;
    toLocationId: number;
    qty: number;
    userId?: string;
    notes?: string;
  }) => Promise<void>;
  executeReplenishmentMove: (params: {
    taskId: number;
    replenMethod: string;
    sourceVariant: { id: number; productId: number | null; unitsPerVariant: number };
    pickVariant: { id: number; productId: number | null; unitsPerVariant: number };
    fromLocationId: number;
    toLocationId: number;
    qtySourceUnits: number;
    qtyTargetUnits: number;
    userId?: string;
    notes?: string;
    occurredAt?: Date;
    deferUntilCommit?: (effect: () => Promise<void>) => void;
  }) => Promise<{ movedBaseUnits: number; qtyPickUnits: number }>;
  receiveInventory: (params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    referenceId: string;
    notes?: string;
    userId?: string;
  }) => Promise<void>;
  logTransaction: (txn: any) => Promise<void>;
  triggerNotifyChange?: (variantId: number, trigger: string) => void | Promise<void>;
  withTx: (tx: any) => InventoryCore;
};

import { InventoryUseCases } from "./inventory.use-cases";
import type { TransformationExecutionAuthorityPort } from "./transformation-execution-authority.port";
import {
  assertAuthorizedPackageConversionQuantity,
  TransformationExecutionAuthorityError,
  type PackageConversionAuthorization,
  type PackageConversionAuthorizationRequest,
  type TransformationRuntimeEvidence,
} from "../domain/transformation-execution-authority";
import { readReplenishmentTrigger, recordReplenishmentTrigger } from "../infrastructure/replenishment-trigger.repository";

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
    private readonly clock: () => Date = () => new Date(),
    private readonly transformationAuthority: TransformationExecutionAuthorityPort,
  ) {
    if (!transformationAuthority) throw new Error("Replenishment requires an explicit runtime transformation authority.");
  }

  /** Lock only the create/reuse decision. All queries under this lock use the
   * same transaction; execution and publication retain their own owners. */
  private async lockPickBinTaskCreation(tx: DrizzleDb, variantId: number, locationId: number): Promise<void> {
    if (!Number.isSafeInteger(variantId) || variantId < 1 || !Number.isSafeInteger(locationId) || locationId < 1) throw new Error("Invalid replenishment destination identity");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('inventory.replen_tasks.pick_bin'),hashtext(${`${variantId}:${locationId}`}))`);
  }

  /** Optimistic admission of a resolver decision: a task that completed while
   * planning was outside the lock cannot cause a stale second refill. */
  private async assertObservedPickQuantity(tx: DrizzleDb, variantId: number, locationId: number, observed: number): Promise<void> {
    if (!Number.isSafeInteger(observed) || observed < 0) throw new IntegrityError("Replenishment plan has no valid observed physical quantity");
    const current=await tx.execute(sql`SELECT variant_qty FROM inventory.inventory_levels WHERE product_variant_id=${variantId} AND warehouse_location_id=${locationId} FOR SHARE`);
    const quantity=current.rows[0]?.variant_qty ?? 0; // Same declared implicit-zero read as the resolver.
    if (quantity !== observed) throw new IntegrityError("Replenishment stock changed before the task decision; retry the same operation",{reason:"replenishment_plan_changed",variantId,locationId,observed,current:quantity});
  }

  private async priorTriggeredTask(variantId: number, locationId: number, context?: ReplenOrderContext,
    database: DrizzleDb = this.db): Promise<{ task: ReplenTask | null } | undefined> {
    if (!context?.operationKey) return undefined;
    const decision = await readReplenishmentTrigger(database, variantId, locationId, context);
    if (!decision) return undefined;
    if (decision.taskId === null) return { task: null };
    const [task] = await database.select().from(replenTasks).where(eq(replenTasks.id, decision.taskId)).limit(1);
    if (!task || task.pickProductVariantId !== variantId || task.toLocationId !== locationId) {
      throw new Error("Recorded replenishment trigger has no matching task");
    }
    return { task };
  }

  private async rememberTriggeredTask(variantId: number, locationId: number, task: ReplenTask | null,
    context?: ReplenOrderContext, tx: DrizzleDb = this.db): Promise<void> {
    if (context?.operationKey) await recordReplenishmentTrigger(tx, variantId, locationId, context, task?.id ?? null, this.clock());
  }

  private async persistAutomaticTask(owner: DrizzleDb, values: InsertReplenTask): Promise<ReplenTask> {
    const [task] = await owner.insert(replenTasks).values(values).returning();
    if (!task) throw new IntegrityError("Replenishment task insertion returned no task");
    if (task.executionMode !== "inline" || task.operationKey) return task;
    // Persist identity before physical work, including commandless automatic
    // triggers. This affects new plans only; historical keyless tasks stay out
    // of automatic recovery. The primary key supplies a stable replay identity.
    const [keyed] = await owner.update(replenTasks).set({ operationKey: `replen:auto:${task.id}` })
      .where(and(eq(replenTasks.id, task.id), eq(replenTasks.revision, task.revision), isNull(replenTasks.operationKey))).returning();
    if (!keyed) throw new IntegrityError("Automatic replenishment task could not retain its recovery identity", { taskId: task.id });
    return keyed;
  }

  private async insertTriggeredTask(values: InsertReplenTask, observedVariantQty: number, context?: ReplenOrderContext): Promise<ReplenTask> {
    const insert = async (tx: DrizzleDb) => {
      await this.lockPickBinTaskCreation(tx, values.pickProductVariantId!, values.toLocationId!);
      const prior = await this.priorTriggeredTask(values.pickProductVariantId!, values.toLocationId!, context, tx);
      if (prior) {
        if (!prior.task) throw new IntegrityError("Replenishment trigger already has a recorded no-work decision");
        return prior.task;
      }
      const existing = await this.findActiveTaskForPickBin(values.pickProductVariantId!, values.toLocationId!, tx);
      if (existing) {
        await this.rememberTriggeredTask(existing.pickProductVariantId!, existing.toLocationId, existing, context, tx);
        return existing;
      }
      await this.assertObservedPickQuantity(tx,values.pickProductVariantId!,values.toLocationId!,observedVariantQty);
      const task = await this.persistAutomaticTask(tx, values);
      if (task.pickProductVariantId == null || task.toLocationId == null) {
        throw new IntegrityError("Created replenishment task has no exact pick-bin identity", { taskId: task.id });
      }
      await this.rememberTriggeredTask(task.pickProductVariantId, task.toLocationId, task, context, tx);
      return task as ReplenTask;
    };
    return this.db.transaction(insert);
  }

  private async findActiveTaskForPickBin(
    pickVariantId: number,
    toLocationId: number,
    database: DrizzleDb = this.db,
  ): Promise<ReplenTask | null> {
    const [task] = await database
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
        AND il.variant_qty - il.reserved_qty > 0
    `);

    return (result.rows ?? []).some((row: any) => this.blockedTaskSourceMatches(task, {
      isPickable: row.is_pickable,
      locationType: row.location_type,
    }));
  }

  private async recordTaskExecutionFailure(task: ReplenTask, error: unknown, actor: string): Promise<void> {
    const failure = classifyReplenishmentExecutionFailure(error);
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    await this.db.transaction(async tx => {
      const [updated] = await tx.update(replenTasks).set({
        // Temporary failures leave the frozen plan executable. Permanent and
        // unclassified failures require review; no cost/identity guard is waived.
        status: failure.retryable ? task.status : "blocked",
        exceptionReason: failure.retryable ? "execution_retry_pending" : "execute_failed",
      }).where(and(eq(replenTasks.id, task.id), eq(replenTasks.status, task.status),
        eq(replenTasks.revision, task.revision), inArray(replenTasks.status, EXECUTABLE_REPLEN_TASK_STATUSES))).returning();
      // A concurrent completion, source replan or operator transition wins.
      if (!updated) return;
      await persistAuditEvent(tx, { actor, action: "inventory.replen_execution_failed",
        target: `inventory.replen_task:${task.id}`,
        changes: { before: { status: task.status, revision: task.revision, exceptionReason: task.exceptionReason },
          after: { status: updated.status, revision: updated.revision, exceptionReason: updated.exceptionReason } },
        context: { code: failure.code, retryable: failure.retryable, message } }, { timestamp: this.clock() });
    });
    logger.error(JSON.stringify({ event: "replen_execution_failed", taskId: task.id, actor, ...failure, message }));
  }

  private async getAvailableInventoryQty(
    productVariantId: number | null | undefined,
    warehouseLocationId: number | null | undefined,
  ): Promise<number> {
    if (!productVariantId || !warehouseLocationId) return 0;

    const [level] = await this.db
      .select({
        variantQty: inventoryLevels.variantQty,
        reservedQty: inventoryLevels.reservedQty,
      })
      .from(inventoryLevels)
      .where(and(
        eq(inventoryLevels.productVariantId, productVariantId),
        eq(inventoryLevels.warehouseLocationId, warehouseLocationId),
      ))
      .limit(1);

    return Math.max(0, Number(level?.variantQty ?? 0) - Number(level?.reservedQty ?? 0));
  }

  private requiredSourceUnits(task: ReplenTask): number {
    const source = Number(task.qtySourceUnits);
    const target = Number(task.qtyTargetUnits);
    const completed = Number(task.qtyCompleted ?? 0);
    if (!Number.isSafeInteger(source) || source <= 0 || !Number.isSafeInteger(target) || target <= 0
      || target % source !== 0 || completed < 0 || completed > target || completed % (target/source) !== 0) throw new Error("Task quantities have no exact remaining source-unit basis");
    return source - completed/(target/source);
  }

  private async blockTaskNoCurrentSource(task: ReplenTask, reason: string): Promise<void> {
    await this.db.update(replenTasks).set({
      status: "blocked",
      exceptionReason: "no_source_stock",
      notes: `${task.notes || ""}\nBlocked before execution: ${reason}`.trim(),
    }).where(and(eq(replenTasks.id, task.id), eq(replenTasks.status, task.status), eq(replenTasks.revision, task.revision), inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"])));
  }

  private async reResolveTaskSourceBeforeExecute(task: ReplenTask, userId?: string): Promise<ReplenTask> {
    const sourceVariantId = task.sourceProductVariantId ?? task.pickProductVariantId;
    const requiredSourceUnits = this.requiredSourceUnits(task);
    const currentSourceQty = await this.getAvailableInventoryQty(sourceVariantId, task.fromLocationId);
    if (currentSourceQty >= requiredSourceUnits) return task;
    if (task.triggeredBy === "manual" || task.qtyCompleted > 0) {
      await this.blockTaskNoCurrentSource(task, "The frozen source cannot supply the remaining physical work");
      throw new Error("source_stock_unavailable: the frozen task plan requires review before changing its source");
    }

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
      }).where(and(eq(replenTasks.id, task.id), eq(replenTasks.status, task.status), eq(replenTasks.revision, task.revision), inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"])));
      throw new Error(`replen_no_longer_needed: ${reason}`);
    }

    if (eval_.status === "dedup") {
      const reason = `superseded by active replen task #${eval_.existingTaskId}`;
      await this.db.update(replenTasks).set({
        status: "cancelled",
        completedAt: new Date(),
        notes: `${task.notes || ""}\nCancelled before execution: ${reason}`.trim(),
      }).where(and(eq(replenTasks.id, task.id), eq(replenTasks.status, task.status), eq(replenTasks.revision, task.revision), inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"])));
      throw new Error(`replen_superseded: ${reason}`);
    }

    if (eval_.status === "needed_stockout" || !eval_.sourceLocation) {
      const reason = eval_.sourceResolutionIssue?.note
        ?? `no replacement source found after source had ${currentSourceQty}, needs ${requiredSourceUnits}`;
      await this.blockTaskNoCurrentSource(task, reason);
      throw new Error(`source_stock_unavailable: ${reason}`);
    }

    const resolvedSourceVariantId = eval_.resolvedSourceVariantId ?? task.pickProductVariantId;
    const resolvedSourceQty = await this.getAvailableInventoryQty(resolvedSourceVariantId, eval_.sourceLocation.id);
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

    const [replanned] = await this.db.update(replenTasks).set({
      fromLocationId: eval_.sourceLocation.id,
      sourceProductVariantId: resolvedSourceVariantId,
      qtySourceUnits: eval_.qtySourceUnits,
      qtyTargetUnits: eval_.qtyTargetUnits,
      replenMethod: eval_.params.replenMethod,
      exceptionReason: null,
      notes,
    }).where(and(eq(replenTasks.id, task.id), eq(replenTasks.status, task.status), eq(replenTasks.revision, task.revision), inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"]))).returning();

    if (!replanned) throw new Error("replen_task_changed: source re-planning lost its revision guard");
    return replanned;
  }

  private async executeInlineTaskAutomatically(
    task: ReplenTask,
    userId: string | undefined,
    tag: string,
  ): Promise<{ task: ReplenTask; moved: number }> {
    const result = await this.executeTask(task.id, userId ?? "system:auto-replen");
    const finalTask = await this.getTaskById(task.id);
    console.log(`${tag} task ${task.id} executed, moved ${result.moved} units`);
    return { task: finalTask ?? task, moved: result.moved };
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
    database: DrizzleDb = this.db,
  ) {
    const locConfigVariant = await database
      .select().from(locationReplenConfig)
      .where(and(
        eq(locationReplenConfig.warehouseLocationId, warehouseLocationId),
        eq(locationReplenConfig.productVariantId, productVariantId),
        eq(locationReplenConfig.isActive, 1),
      )).limit(1);
    const locConfigWide = locConfigVariant.length > 0 ? null : (await database
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
    database: DrizzleDb = this.db,
  ): Promise<ResolvedReplenParams> {
    const rule = await this.findRuleForVariant(productVariantId, database);
    const tierDefault = await this.findTierDefaultForVariant(
      variant.hierarchyLevel,
      warehouseId,
      database,
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

  private async demandForSource(pickVariant: ProductVariant, sourceVariant: ProductVariant,
    destinationQuantity: number, runtime: TransformationRuntimeEvidence) {
    const authorization = runtime.authority === "canonical" && sourceVariant.id !== pickVariant.id
      ? await this.transformationAuthority.authorizePackageConversion(this.caseBreakAuthorizationRequest(sourceVariant, pickVariant), runtime)
      : null;
    return planReplenishmentDemand({
      destinationVariantQuantity: Math.max(1, destinationQuantity),
      destinationUnitsPerVariant: this.variantUnits(pickVariant),
      sourceUnitsPerVariant: this.variantUnits(sourceVariant),
      sourceBatchQuantity: authorization ? Number(authorization.inputQty) : 1,
    });
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
    const runtime = await this.transformationAuthority.readRuntime();
    let resolvedSourceVariantId = args.configuredSourceVariantId;
    let resolvedReplenMethod = args.replenMethod;
    let sourceResolutionIssue: SourceResolutionIssue | null = null;
    let sourceLocation: WarehouseLocation | null = null;
    let conversionAuthorization: PackageConversionAuthorization | null = null;

    if (resolvedSourceVariantId != null && runtime.authority === "canonical") {
      const [configuredSource] = await this.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, resolvedSourceVariantId))
        .limit(1);
      if (!configuredSource) {
        sourceResolutionIssue = {
          reason: "no_source_variant",
          note: `Configured source variant #${resolvedSourceVariantId} does not exist`,
        };
      } else if (configuredSource.id !== args.pickVariantId
        && !await this.isCanonicalCaseBreakAuthorized(configuredSource, args.pickVariant, runtime)) {
        sourceResolutionIssue = {
          reason: "no_source_variant",
          note: `Configured source variant ${configuredSource.sku ?? `#${resolvedSourceVariantId}`} has no exact allowed active break path to ${args.pickVariant.sku ?? `#${args.pickVariantId}`}`,
        };
      } else {
        if (configuredSource.id !== args.pickVariantId) {
          resolvedReplenMethod = "case_break";
        }
        sourceLocation = await this.findSourceLocation(
          resolvedSourceVariantId,
          args.warehouseId,
          args.sourceLocationType,
          args.parentLocationId,
          args.sourcePriority,
          (await this.demandForSource(args.pickVariant, configuredSource, args.qtyNeeded, runtime)).qtySourceUnits,
        );
      }
    }

    // The legacy branch intentionally retains the pre-cutover configured-source
    // behavior: strategy/direct-parent rules remain the authority and a missing
    // variant is reported through the existing no-stock path below.
    if (resolvedSourceVariantId != null && runtime.authority === "legacy") {
      const [configuredSource] = await this.db.select().from(productVariants)
        .where(eq(productVariants.id, resolvedSourceVariantId)).limit(1);
      if (!configuredSource) return { sourceResolutionIssue: { reason: "no_source_variant",
        note: `Configured source variant #${resolvedSourceVariantId} does not exist` }, sourceLocation: null,
        resolvedSourceVariantId, resolvedReplenMethod, conversionAuthorization: null };
      sourceLocation = await this.findSourceLocation(
        resolvedSourceVariantId,
        args.warehouseId,
        args.sourceLocationType,
        args.parentLocationId,
        args.sourcePriority,
        (await this.demandForSource(args.pickVariant, configuredSource, args.qtyNeeded, runtime)).qtySourceUnits,
      );
    }

    if (!sourceLocation && resolvedSourceVariantId != null && !sourceResolutionIssue) {
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
        runtime,
      });

      if (sourceResolution.status === "found") {
        resolvedSourceVariantId = sourceResolution.variant.id;
        sourceLocation = sourceResolution.location;
        if (resolvedSourceVariantId !== args.pickVariantId && resolvedReplenMethod === "full_case") {
          resolvedReplenMethod = "case_break";
        }
        logger.debug("replenishment.source_evaluated", {
          context: args.tag, note: sourceResolution.note,
          sourceVariantId: sourceResolution.variant.id, sourceLocationId: sourceLocation.id,
        });
      } else {
        sourceResolutionIssue = sourceResolution.issue;
      }
    }

    if (runtime.authority === "canonical" && sourceLocation && resolvedSourceVariantId != null) {
      resolvedReplenMethod = resolvedSourceVariantId === args.pickVariantId ? "full_case" : "case_break";
      if (resolvedSourceVariantId !== args.pickVariantId) {
        const [sourceVariant] = await this.db
          .select()
          .from(productVariants)
          .where(eq(productVariants.id, resolvedSourceVariantId))
          .limit(1);
        if (!sourceVariant) {
          return {
            sourceResolutionIssue: {
              reason: "no_source_variant",
              note: `Resolved source variant #${resolvedSourceVariantId} no longer exists`,
            },
            sourceLocation: null,
            resolvedSourceVariantId,
            resolvedReplenMethod,
            conversionAuthorization: null,
          };
        }
        conversionAuthorization = await this.transformationAuthority.authorizePackageConversion(
          this.caseBreakAuthorizationRequest(sourceVariant, args.pickVariant),
          runtime,
        );
      }
    }

    return {
      sourceResolutionIssue,
      sourceLocation: sourceLocation as WarehouseLocation | null,
      resolvedSourceVariantId,
      resolvedReplenMethod,
      conversionAuthorization,
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
    logger.debug("replenishment.evaluated", {
      productVariantId, warehouseLocationId, onHand: effectiveLevel.variantQty,
      evaluatedQty, hierarchyLevel: variant.hierarchyLevel, implicitZeroLevel,
    });

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
    logger.debug("replenishment.threshold_met", { productVariantId, warehouseLocationId, method: resolvedReplenMethod });

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
      conversionAuthorization,
    } = sourceDecision;
    resolvedSourceVariantId = sourceVariantId;
    resolvedReplenMethod = sourceReplenMethod;

    const rule = await this.findRuleForVariant(productVariantId);

    const sourceVariant = resolvedSourceVariantId != null
      ? (await this.db.select().from(productVariants).where(eq(productVariants.id, resolvedSourceVariantId)).limit(1))[0] ?? variant
      : variant;

    if (!sourceLocation) {
      const { shouldAutoExecute, executionMode } = this.resolveAutoExecute(
        autoReplen === 1 ? 1 : autoReplen === 2 ? 2 : null, null, whSettings, 0, resolvedReplenMethod,
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

    const pathInputQty = conversionAuthorization?.runtime.authority === "canonical"
      ? Number(conversionAuthorization.inputQty)
      : 1;
    const { qtySourceUnits, qtyTargetUnits } = planReplenishmentDemand({
      destinationVariantQuantity: Math.max(1, qtyNeeded),
      destinationUnitsPerVariant: this.variantUnits(variant as ProductVariant),
      sourceUnitsPerVariant: this.variantUnits(sourceVariant as ProductVariant),
      sourceBatchQuantity: pathInputQty,
    });
    if (conversionAuthorization) {
      assertAuthorizedPackageConversionQuantity(
        conversionAuthorization,
        qtySourceUnits,
        qtyTargetUnits / this.variantUnits(variant as ProductVariant),
      );
    }

    const { shouldAutoExecute, executionMode } = this.resolveAutoExecute(
      autoReplen === 1 ? 1 : autoReplen === 2 ? 2 : null, null, whSettings, qtyTargetUnits, resolvedReplenMethod,
    );

    logger.debug("replenishment.preview_resolved", {
      productVariantId, warehouseLocationId, sourceLocationId: sourceLocation.id,
      qtySourceUnits, qtyTargetUnits, method: resolvedReplenMethod,
    });

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

  async checkReplenForLocation(warehouseLocationId: number, operationKey?: string): Promise<void> {
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
          operationKey ? { operationKey: `${operationKey}:source:${warehouseLocationId}:${productVariantId}` } : undefined,
        );
      } catch (err: any) {
        if (operationKey) throw err;
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
            .where(and(eq(replenTasks.id, task.id), eq(replenTasks.status, task.status), eq(replenTasks.revision, task.revision), inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"])));
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
        .where(and(eq(replenTasks.id, task.id), eq(replenTasks.status, task.status), eq(replenTasks.revision, task.revision), inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"])));
      
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

  private async resolveTaskExecutionMethod(_owner: DrizzleDb, task: ReplenTask): Promise<string> {
    if (!["case_break", "full_case", "pallet_drop"].includes(task.replenMethod)) throw new Error("Replenishment task has no supported frozen method");
    return task.replenMethod;
  }

  private async planCanonicalTaskExecution(
    task: ReplenTask,
    runtime: TransformationRuntimeEvidence,
  ): Promise<{
    replenMethod: string;
    request: PackageConversionAuthorizationRequest | null;
    authorization: PackageConversionAuthorization | null;
  }> {
    const replenMethod = await this.resolveTaskExecutionMethod(this.db, task);
    const sourceVariantId = task.sourceProductVariantId;
    const pickVariantId = task.pickProductVariantId;
    if (!sourceVariantId || !pickVariantId) {
      throw new TransformationExecutionAuthorityError(
        "CANONICAL_REPLENISHMENT_TASK_INVALID",
        "Canonical replenishment requires exact source and destination variant identities.",
        { taskId: task.id, sourceVariantId, pickVariantId },
      );
    }

    if (sourceVariantId === pickVariantId) {
      if (replenMethod === "case_break") {
        throw new TransformationExecutionAuthorityError(
          "CANONICAL_REPLENISHMENT_TASK_INVALID",
          "A same-variant canonical replenishment cannot execute as a case break.",
          { taskId: task.id, productVariantId: sourceVariantId },
        );
      }
      return { replenMethod, request: null, authorization: null };
    }
    if (replenMethod !== "case_break") {
      throw new TransformationExecutionAuthorityError(
        "CANONICAL_REPLENISHMENT_TASK_INVALID",
        "A cross-variant canonical replenishment requires an exact case-break path.",
        { taskId: task.id, replenMethod, sourceVariantId, pickVariantId },
      );
    }

    const [sourceRows, pickRows] = await Promise.all([
      this.db.select().from(productVariants).where(eq(productVariants.id, sourceVariantId)).limit(1),
      this.db.select().from(productVariants).where(eq(productVariants.id, pickVariantId)).limit(1),
    ]);
    const sourceVariant = sourceRows[0] as ProductVariant | undefined;
    const pickVariant = pickRows[0] as ProductVariant | undefined;
    if (!sourceVariant || !pickVariant) {
      throw new TransformationExecutionAuthorityError(
        "CANONICAL_REPLENISHMENT_TASK_INVALID",
        "Canonical replenishment variant snapshots are unavailable.",
        { taskId: task.id, sourceVariantId, pickVariantId },
      );
    }

    const request = this.caseBreakAuthorizationRequest(sourceVariant, pickVariant);
    const authorization = await this.transformationAuthority.authorizePackageConversion(request, runtime);
    const destinationQty = Number(task.qtyTargetUnits) / this.variantUnits(pickVariant);
    assertAuthorizedPackageConversionQuantity(authorization, Number(task.qtySourceUnits), destinationQty);
    return { replenMethod, request, authorization };
  }

  private assertCanonicalTaskSnapshotUnchanged(
    planned: ReplenTask,
    current: ReplenTask,
    plannedMethod: string,
    currentMethod: string,
  ): void {
    const fields: Array<keyof ReplenTask> = [
      "sourceProductVariantId",
      "pickProductVariantId",
      "fromLocationId",
      "toLocationId",
      "qtySourceUnits",
      "qtyTargetUnits",
      "qtyCompleted",
      "executionMode",
      "revision",
      "warehouseId",
    ];
    const changedFields = fields.filter((field) => current[field] !== planned[field]);
    if (currentMethod !== plannedMethod) changedFields.push("replenMethod");
    if (changedFields.length > 0) {
      throw new TransformationExecutionAuthorityError(
        "CANONICAL_REPLENISHMENT_TASK_CHANGED",
        "The locked replenishment task no longer matches the canonical conversion that was authorized.",
        { taskId: current.id, changedFields, plannedMethod, currentMethod },
      );
    }
  }

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

    if (task.status === "completed") {
      await this.recoverReplenishmentFollowup(taskId);
      return { moved: Number(task.executionMovedBaseUnits ?? 0) };
    }
    if (!["pending", "assigned", "in_progress"].includes(task.status)) {
      throw new Error(
        `Replen task ${taskId} cannot be executed (status: ${task.status})`,
      );
    }

    let executionSnapshot = task as ReplenTask;
    try {
      const resolvedTask = await this.reResolveTaskSourceBeforeExecute(executionSnapshot, userId);
      executionSnapshot = resolvedTask;
      const plannedRuntime = await this.transformationAuthority.readRuntime();
      const canonicalPlan = plannedRuntime.authority === "canonical"
        ? await this.planCanonicalTaskExecution(resolvedTask, plannedRuntime)
        : null;

      const movedBaseUnits = await this.db.transaction(async (tx: any) => {
        // Canonical ordering is authority -> active head/model/path -> catalog
        // variant snapshots -> operational task -> inventory/cost/lot rows.
        // Legacy pins only the runtime singleton and otherwise keeps its existing
        // task/rule execution behavior.
        if (canonicalPlan?.request && canonicalPlan.authorization) {
          await this.transformationAuthority.pinPackageConversion(
            tx,
            canonicalPlan.request,
            canonicalPlan.authorization,
          );
        } else {
          await this.transformationAuthority.pinRuntime(tx, plannedRuntime);
        }

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

        if (lockedTask.status === "completed") return Number(lockedTask.execution_moved_base_units ?? 0);
        if (!["pending", "assigned", "in_progress"].includes(lockedTask.status)) {
          throw new Error(
            `Replen task ${taskId} cannot be executed (status: ${lockedTask.status})`,
          );
        }

        const [currentTask] = await tx
          .select()
          .from(replenTasks)
          .where(eq(replenTasks.id, taskId))
          .limit(1);
        if (!currentTask) throw new Error(`Replen task ${taskId} not found after lock acquisition`);

        const replenMethod = await this.resolveTaskExecutionMethod(tx, currentTask as ReplenTask);
        this.assertCanonicalTaskSnapshotUnchanged(resolvedTask, currentTask as ReplenTask,
          canonicalPlan?.replenMethod ?? resolvedTask.replenMethod, replenMethod);

        const [sourceVariant] = currentTask.sourceProductVariantId
          ? await tx
              .select()
              .from(productVariants)
              .where(eq(productVariants.id, currentTask.sourceProductVariantId))
              .limit(1)
          : [null];
        const [pickVariant] = currentTask.pickProductVariantId
          ? await tx
              .select()
              .from(productVariants)
              .where(eq(productVariants.id, currentTask.pickProductVariantId))
              .limit(1)
          : [null];

        let moved = 0;
        const invTx = this.inventoryUseCases.withTx(tx);
        if (!sourceVariant || !pickVariant || !currentTask.fromLocationId || !currentTask.toLocationId) {
          throw new Error(`Replen task ${taskId} is missing its frozen source, destination, or variant identity`);
        }
        const occurredAt = this.clock();
        if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
          throw new Error("Replenishment execution clock returned an invalid timestamp");
        }
        const completedBase = Number(currentTask.qtyCompleted ?? 0);
        const remainingBase = Number(currentTask.qtyTargetUnits) - completedBase;
        if (remainingBase <= 0 || completedBase < 0 || completedBase % sourceVariant.unitsPerVariant !== 0) throw new Error("Replenishment completion quantity is inconsistent with its frozen source units");
        const remainingSource = Number(currentTask.qtySourceUnits) - completedBase / sourceVariant.unitsPerVariant;
        const movement = await invTx.executeReplenishmentMove({
          taskId,
          replenMethod,
          sourceVariant: {
            id: sourceVariant.id,
            productId: sourceVariant.productId ?? null,
            unitsPerVariant: sourceVariant.unitsPerVariant,
          },
          pickVariant: {
            id: pickVariant.id,
            productId: pickVariant.productId ?? null,
            unitsPerVariant: pickVariant.unitsPerVariant,
          },
          fromLocationId: currentTask.fromLocationId,
          toLocationId: currentTask.toLocationId,
          qtySourceUnits: remainingSource,
          qtyTargetUnits: remainingBase,
          userId,
          occurredAt,
          notes: `Replen task #${taskId} (${replenMethod})`,
          deferUntilCommit: () => { /* The receipt-backed follow-up below owns these effects. */ },
        });
        moved = movement.movedBaseUnits;

        await tx
          .update(replenTasks)
          .set({
            status: "completed",
            qtyCompleted: completedBase + moved,
            executionMovedBaseUnits: moved,
            exceptionReason: null,
            completedAt: occurredAt,
            assignedTo: userId ?? currentTask.assignedTo,
          })
          .where(eq(replenTasks.id, taskId));

        await recordReplenishmentFollowup(tx, taskId, userId ?? "system:auto-replen", occurredAt);
        return moved;
      });

      await this.recoverReplenishmentFollowup(taskId);

      return { moved: movedBaseUnits };
    } catch (error) {
      if (executionSnapshot.executionMode === "inline") {
        try {
          await this.recordTaskExecutionFailure(executionSnapshot, error, userId ?? "system:auto-replen");
        } catch (persistenceError) {
          // The original task intent already survives. A DB outage must not hide
          // the movement failure or overwrite an uncertain committed outcome.
          logger.error(JSON.stringify({ event: "replen_failure_record_pending", taskId,
            message: persistenceError instanceof Error ? persistenceError.message : String(persistenceError) }));
        }
      }
      throw error;
    }
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
          inArray(replenTasks.status, ["blocked", "pending"]),
        ),
      );

    for (const dep of dependents) {
      if (dep.status === "blocked" && dep.exceptionReason === "execute_failed") continue;
      if (dep.status === "blocked") {
        assertReplenishmentTaskTransition(dep.status, "pending");
        await this.db.transaction(async tx => {
          const [updated] = await tx.update(replenTasks).set({ status: "pending",
            notes: `${dep.notes || ""}\nUnblocked by completed task #${completedTaskId}` })
            .where(and(eq(replenTasks.id, dep.id), eq(replenTasks.status, "blocked"),
              eq(replenTasks.revision, dep.revision), eq(replenTasks.dependsOnTaskId, completedTaskId))).returning();
          if (!updated) throw new IntegrityError("Dependent replenishment task changed before wake-up", { taskId: dep.id, completedTaskId });
          await persistAuditEvent(tx, { actor: userId ?? "system:auto-replen", action: "inventory.replen_dependency_unblocked",
            target: `inventory.replen_task:${dep.id}`, changes: { before: { status: dep.status, revision: dep.revision },
              after: { status: updated.status, revision: updated.revision } }, context: { completedTaskId } }, { timestamp: this.clock() });
        });
      }

      // Resume the execution mode frozen by the rule/resolver owner.
      if (dep.executionMode === "inline" && supportsInlineReplenishment(dep.replenMethod)) {
        // Failure retains the parent follow-up; a pending child survives restart.
        await this.executeTask(dep.id, userId ?? "system:auto-replen");
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
    // A manual plan or partially recorded physical work must keep its original
    // source and unit basis. Health cleanup cannot replace that evidence.
    if (task.operationRequestHash || task.qtyCompleted > 0) return null;

    const activeDemandLines = await this.countActivePendingDemandLines(task);
    const eval_ = await this.evaluateReplenNeed(task.pickProductVariantId, task.toLocationId, {
      ignoreTaskId: task.id,
      forceWhenAtOrBelowZero: activeDemandLines > 0,
    });

    if (eval_.status !== "needed_with_source") return null;
    if (!(eval_.shouldAutoExecute || eval_.executionMode === "inline")) return null;
    if (!eval_.sourceLocation) return null;

    const resolvedSourceVariantId = eval_.resolvedSourceVariantId ?? task.pickProductVariantId;
    const sourceQty = await this.getAvailableInventoryQty(resolvedSourceVariantId, eval_.sourceLocation.id);
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

    const [replanned] = await this.db.update(replenTasks).set({
      fromLocationId: eval_.sourceLocation.id,
      sourceProductVariantId: resolvedSourceVariantId,
      qtySourceUnits: eval_.qtySourceUnits,
      qtyTargetUnits: eval_.qtyTargetUnits,
      replenMethod: eval_.params.replenMethod,
      exceptionReason: null,
      notes,
    }).where(and(eq(replenTasks.id, task.id), eq(replenTasks.status, task.status), eq(replenTasks.revision, task.revision), inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"]))).returning();

    if (!replanned) throw new Error("replen_task_changed: source re-planning lost its revision guard");
    return replanned;
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
          WHERE ril.variant_qty - ril.reserved_qty > 0
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
        SELECT rt.id, rt.revision, rt.status
        FROM inventory.replen_tasks rt
        LEFT JOIN catalog.product_variants pv ON pv.id = rt.pick_product_variant_id
        WHERE rt.status = 'blocked'
          AND rt.blocks_shipment = false
          AND rt.qty_completed = 0 AND rt.operation_request_hash IS NULL
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
      WHERE rt.id = c.id AND rt.revision = c.revision AND rt.status = c.status
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
        SELECT rt.id, rt.revision, rt.status
        FROM inventory.replen_tasks rt
        LEFT JOIN catalog.product_variants pv ON pv.id = rt.pick_product_variant_id
        WHERE rt.status IN ('pending', 'assigned')
          AND rt.blocks_shipment = false
          AND rt.qty_completed = 0 AND rt.operation_request_hash IS NULL
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
      WHERE rt.id = c.id AND rt.revision = c.revision AND rt.status = c.status
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
          rt.revision,
          first_value(rt.id) OVER task_group AS kept_id,
          row_number() OVER task_group AS row_num,
          count(*) OVER (
            PARTITION BY rt.pick_product_variant_id, rt.to_location_id
          ) AS active_count
        FROM inventory.replen_tasks rt
        ${taskJoin}
        WHERE rt.status IN ('pending', 'assigned', 'in_progress', 'blocked')
          AND rt.blocks_shipment = false
          AND rt.qty_completed = 0 AND rt.operation_request_hash IS NULL
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
        SELECT id, kept_id, revision, status
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
      WHERE rt.id = c.id AND rt.revision = c.revision AND rt.status = c.status
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
    validateReplenishmentTrigger(triggeredBy);
    const _tag = `[Replen checkAndTrigger] variant=${productVariantId} loc=${warehouseLocationId}`;
    const prior = await this.priorTriggeredTask(productVariantId, warehouseLocationId, context);
    if (prior) {
      if (prior.task?.executionMode === "inline" && supportsInlineReplenishment(prior.task.replenMethod)
        && EXECUTABLE_REPLEN_TASK_STATUSES.includes(prior.task.status)) {
        return (await this.executeInlineTaskAutomatically(prior.task, "system:auto-replen", _tag)).task;
      }
      return prior.task;
    }

    const eval_ = await this.evaluateReplenNeed(productVariantId, warehouseLocationId, {
      forceWhenAtOrBelowZero: context?.forceWhenAtOrBelowZero === true,
    });

    if (eval_.status === "skip") {
      console.log(`${_tag} EXIT: ${eval_.skipReason}`);
      await this.rememberTriggeredTask(productVariantId, warehouseLocationId, null, context);
      return null;
    }
    if (eval_.status === "dedup") {
      console.log(`${_tag} EXIT: dedup — existing task #${eval_.existingTaskId}`);
      await this.rememberTriggeredTask(productVariantId, warehouseLocationId, eval_.existingTask, context);
      if (
        eval_.existingTask.executionMode === "inline" &&
        supportsInlineReplenishment(eval_.existingTask.replenMethod) &&
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
          observedPickQuantity: eval_.level.variantQty,
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
        await this.rememberTriggeredTask(productVariantId, warehouseLocationId, null, context);
        return null;
      }

      const blockedTask = await this.insertTriggeredTask({ operationKey: context?.operationKey ?? null,
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
        } satisfies InsertReplenTask, eval_.level.variantQty, context);
      console.log(`${_tag} EXIT: created BLOCKED task — no source stock in ${sourceLocationType} locations`);
      notify("stockout", {
        ...notification,
        data: { ...notification.data, taskId: blockedTask.id },
      }).catch(() => {});
      return blockedTask as ReplenTask;
    }

    const { sourceLocation, sourceVariant, qtySourceUnits, qtyTargetUnits, executionMode } = eval_;

    console.log(`${_tag} CREATING TASK: from=${sourceLocation!.code}(id=${sourceLocation!.id}) to=${location.code} qty=${qtySourceUnits}x${sourceVariant.unitsPerVariant}=${qtyTargetUnits} method=${replenMethod}`);
    const task = await this.insertTriggeredTask({ operationKey: context?.operationKey ?? null,
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
      } satisfies InsertReplenTask, eval_.level.variantQty, context);

    if (replenMethod === "pallet_drop" || replenMethod === "case_break") {
      const typeKey = replenMethod === "pallet_drop" ? "pallet_drop_needed" : "case_break_needed";
      notify(typeKey, {
        title: `${replenMethod === "pallet_drop" ? "Pallet Drop" : "Case Break"} Needed`,
        message: `${variant.sku ?? `variant #${productVariantId}`} at ${location.code}`,
        data: { taskId: task.id, productVariantId, locationCode: location.code },
      }).catch(() => {});
    }

    if (task.executionMode === "inline" && supportsInlineReplenishment(task.replenMethod)) {
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
        evaluatedQty, observedVariantQty: eval_.level.variantQty,
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
      evaluatedQty, observedVariantQty: eval_.level.variantQty,
    };
  }

  /**
   * Resolve the SINGLE dedicated replenishment source bin for a pick location,
   * regardless of whether replen is currently NEEDED. This is the exact bin the
   * replen engine would pull from (assigned feeder → configured source variant →
   * source-type + priority), so the gun's pick screen can show a "grab more from
   * BULK-A-02" hint per line item, always — not only when a shortage fires.
   *
   * Returns null when the feature does not apply:
   *   - pallet-pick items (replenMethod 'pallet_drop'): replen there is a
   *     warehouse-manager job spanning multiple reserves, not one picker-facing
   *     bin — intentionally excluded per WMS design.
   *   - no configured/resolvable source, or no source stock currently on hand.
   *
   * Unlike checkReplenNeeded, this deliberately SKIPS the trigger/threshold
   * evaluation — it answers "where is this item's backup?", not "does it need
   * topping up right now?".
   */
  async resolveDedicatedReplenBin(
    productVariantId: number,
    warehouseLocationId: number,
  ): Promise<{ locationId: number; locationCode: string } | null> {
    const contextResult = await this.loadReplenEvaluationContext(productVariantId, warehouseLocationId);
    if (contextResult.status === "skip") return null;
    const { location, variant } = contextResult.context;

    const locConfig = await this.loadLocationConfig(warehouseLocationId, productVariantId);
    const params = await this.resolveReplenParams(
      productVariantId,
      variant,
      location.warehouseId ?? undefined,
      locConfig,
    );

    // Pallet-pick replen is a manager-job workflow across multiple reserves,
    // not a single dedicated picker bin — no gun label for these.
    if (params.replenMethod === "pallet_drop") return null;

    const sourceDecision = await this.resolveReplenSourceForNeed({
      tag: `[Replen dedicated-bin] variant=${productVariantId} loc=${warehouseLocationId}`,
      pickVariant: variant,
      pickVariantId: productVariantId,
      warehouseId: location.warehouseId ?? undefined,
      parentLocationId: location.parentLocationId,
      sourceLocationType: params.sourceLocationType,
      sourcePriority: params.sourcePriority,
      sourceHierarchyLevel: params.sourceHierarchyLevel,
      qtyNeeded: 1,
      configuredSourceVariantId: params.sourceVariantId,
      replenMethod: params.replenMethod,
    });

    if (!sourceDecision.sourceLocation) return null;
    return {
      locationId: sourceDecision.sourceLocation.id,
      locationCode: sourceDecision.sourceLocation.code,
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
      sourceQty = Math.max(0, Number(sourceLevel?.variantQty ?? 0) - Number(sourceLevel?.reservedQty ?? 0));
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
    validateReplenishmentTrigger(context?.triggeredBy ?? "inline_pick");
    const _tag = `[Replen createAndExecute] variant=${pickVariantId} loc=${toLocationId}`;

    const prior = await this.priorTriggeredTask(pickVariantId, toLocationId, context);
    if (prior) {
      if (!prior.task) return null;
      if (prior.task.status === "completed") return { task: prior.task, moved: Number(prior.task.executionMovedBaseUnits ?? 0) };
      if (prior.task.executionMode === "inline" && supportsInlineReplenishment(prior.task.replenMethod) && EXECUTABLE_REPLEN_TASK_STATUSES.includes(prior.task.status)) return this.executeInlineTaskAutomatically(prior.task, userId, _tag);
      return { task: prior.task, moved: 0 };
    }
    const existingTask = await this.findActiveTaskForPickBin(pickVariantId, toLocationId);
    if (existingTask) {
      await this.rememberTriggeredTask(pickVariantId, toLocationId, existingTask, context);
      const currentTask = EXECUTABLE_REPLEN_TASK_STATUSES.includes(existingTask.status)
        ? await this.reResolveTaskSourceBeforeExecute(existingTask, userId)
        : existingTask;
      console.log(`${_tag} reusing active task ${currentTask.id} status=${currentTask.status}`);
      if (
        currentTask.executionMode === "inline" &&
        supportsInlineReplenishment(currentTask.replenMethod) &&
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
      await this.rememberTriggeredTask(pickVariantId, toLocationId, null, context);
      return null;
    }

    const executionMode = guidance.executionMode;

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
    const task = await this.insertTriggeredTask({
      operationKey: context?.operationKey ?? null,
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
      executionMode,
      replenMethod: guidance.replenMethod,
      autoReplen,
      ...this.replenOrderTaskFields(context),
      warehouseId: location.warehouseId ?? undefined,
      notes: this.appendOrderContextNote(
        executionMode === "inline"
          ? `${guidance.taskNotes}\nSystem auto-executed inline replen.`
          : `${guidance.taskNotes}\nSystem queued replen; ${guidance.replenMethod} requires warehouse movement.`,
        context,
      ),
    } satisfies InsertReplenTask, guidance.observedVariantQty!, context);

    let moved = 0;
    if (task.executionMode === "inline") {
      console.log(`${_tag} created task ${task.id}, executing immediately...`);
      return this.executeInlineTaskAutomatically(task as ReplenTask, userId, _tag);
    } else {
      console.log(`${_tag} created task ${task.id}, executionMode is queue. Leaving as pending.`);
    }

    // Re-read task to get final state
    const finalTask = await this.getTaskById(task.id);
    if (!finalTask) throw new Error("Created replenishment task disappeared");
    return { task: finalTask, moved };
  }

  async ensureQueuedReplenForShortPick(
    pickVariantId: number,
    toLocationId: number,
    userId?: string,
    context?: ReplenOrderContext,
  ): Promise<{ task: ReplenTask; moved: number; guidance?: ReplenGuidance } | null> {
    const _tag = `[Replen shortPickQueue] variant=${pickVariantId} loc=${toLocationId}`;

    const prior = await this.priorTriggeredTask(pickVariantId, toLocationId, context);
    if (prior) {
      if (!prior.task) return null;
      return { task: prior.task, moved: Number(prior.task.executionMovedBaseUnits ?? 0) };
    }
    const existingTask = await this.findActiveTaskForPickBin(pickVariantId, toLocationId);
    if (existingTask) {
      await this.rememberTriggeredTask(pickVariantId, toLocationId, existingTask, context);
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
      await this.rememberTriggeredTask(pickVariantId, toLocationId, null, context);
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
    const task = await this.insertTriggeredTask({
      operationKey: context?.operationKey ?? null,
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
    } satisfies InsertReplenTask, guidance.observedVariantQty!, context);

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
  async completeMatchingTransferTask(transferReceiptId: number, userId?: string): Promise<{ completedTaskIds: number[] }> {
    const completedTaskIds = await this.db.transaction(tx => creditTransferToReplenishment(tx, transferReceiptId,
      userId ?? "system:transfer-credit", this.clock()));
    for (const id of completedTaskIds) await this.recoverReplenishmentFollowup(id);
    return { completedTaskIds };
  }

  async markTaskDone(taskId: number, userId?: string, _notes?: string, transferReceiptId?: number): Promise<ReplenTask> {
    if (!transferReceiptId) throw new Error("Link the committed transfer receipt that performed this task before marking it done");
    const task = await this.db.transaction(async tx => {
      await creditTransferToReplenishment(tx, transferReceiptId, userId ?? "system:transfer-credit", this.clock(), taskId);
      const [task] = await tx.select().from(replenTasks).where(eq(replenTasks.id, taskId)).limit(1);
      if (!task || task.status !== "completed") throw new Error("The linked transfer does not supply the task's exact source, SKU, destination and remaining quantity");
      return task as ReplenTask;
    });
    await this.recoverReplenishmentFollowup(taskId);
    return task;
  }

  async changeTask(taskId: number, command: unknown, actor: string) {
    return changeReplenishmentTask(this.db as any, taskId, command, actor, this.clock);
  }

  async createManualTask(input: unknown, actor: string) {
    const task = await createManualReplenishmentTask({ database: this.db as any, authority: this.transformationAuthority,
      settings: (warehouseId, tx) => this.getSettingsForWarehouse(warehouseId, tx as unknown as DrizzleDb),
      decide: async (settings, quantity, method, variant, locationId, tx) => {
        const owner = tx as unknown as DrizzleDb;
        const [location] = await owner.select().from(warehouseLocations).where(eq(warehouseLocations.id, locationId)).limit(1);
        const resolved = await this.resolveReplenParams(variant.id, variant, location.warehouseId ?? undefined,
          await this.loadLocationConfig(locationId, variant.id, owner), owner);
        return this.resolveAutoExecute(resolved.autoReplen, null, settings, quantity, method);
      } }, input, actor, this.clock);
    if (task.executionMode === "inline") {
      try { await this.executeTask(task.id, actor); }
      catch (error) { logger.error(JSON.stringify({ event: "manual_replen_execution_pending", taskId: task.id,
        message: error instanceof Error ? error.message : String(error) })); }
    }
    return await this.getTaskById(task.id) ?? task;
  }

  async recoverReplenishmentFollowups(): Promise<void> {
    // New tasks retain a key before execution. Historical keyless tasks are
    // outside this worker's scope; dependencies require a completed parent.
    const pending = await this.db.execute(sql`SELECT id,created_by FROM inventory.replen_tasks
      WHERE operation_key IS NOT NULL AND execution_mode='inline' AND status IN ('pending','assigned','in_progress')
        AND (depends_on_task_id IS NULL OR EXISTS (SELECT 1 FROM inventory.replen_tasks parent
          WHERE parent.id=replen_tasks.depends_on_task_id AND parent.status='completed'))
      ORDER BY created_at,id LIMIT 20`);
    for (const task of pending.rows) {
      try { await this.executeTask(Number(task.id), String(task.created_by || "system:auto-replen")); }
      catch (error) { logger.error(JSON.stringify({ event: "replen_execution_pending", taskId: task.id, message: error instanceof Error ? error.message : String(error) })); }
    }
    const rows = await this.db.execute(sql`SELECT task_id FROM inventory.replen_followups WHERE completed_at IS NULL ORDER BY created_at,task_id LIMIT 20`);
    for (const row of rows.rows) await this.recoverReplenishmentFollowup(Number(row.task_id));
  }

  private async recoverReplenishmentFollowup(taskId: number): Promise<void> {
    try {
      const rows = await this.db.execute(sql`SELECT * FROM inventory.replen_followups WHERE task_id=${taskId} AND completed_at IS NULL`);
      const followup = rows.rows[0];
      if (!followup) return;
      const task = await this.getTaskById(taskId);
      if (!task || task.status !== "completed") throw new Error("Replenishment follow-up requires completed physical work");
      // Warehouse dependencies must advance even when channel delivery is down.
      await this.unblockDependentTasks(taskId, followup.actor);
      if (task.sourceProductVariantId) await this.inventoryUseCases.publishInventoryChange(task.sourceProductVariantId, "replen");
      if (task.pickProductVariantId && task.pickProductVariantId !== task.sourceProductVariantId) await this.inventoryUseCases.publishInventoryChange(task.pickProductVariantId, "replen");
      await this.db.transaction(async tx => {
        const current = await tx.execute(sql`SELECT task_id FROM inventory.replen_followups WHERE task_id=${taskId} AND completed_at IS NULL FOR UPDATE`);
        if (current.rows.length === 0) return;
        await tx.execute(sql`UPDATE inventory.replen_followups SET completed_at=${this.clock()},last_error=NULL WHERE task_id=${taskId}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.execute(sql`UPDATE inventory.replen_followups SET last_error=${message.slice(0,2000)} WHERE task_id=${taskId} AND completed_at IS NULL`);
      logger.error(JSON.stringify({ event: "replen_followup_pending", taskId, message }));
    }
  }

  private async countActivePendingDemandLines(task: ReplenTask): Promise<number> {
    if (!task.pickProductVariantId) return 0;
    const result = await this.db.execute(sql`
      SELECT COUNT(*)::int AS active_pending_lines
      FROM (
        SELECT oi.id::text AS demand_id
        FROM wms.order_items oi
        JOIN wms.orders o ON o.id = oi.order_id
          AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
        JOIN catalog.product_variants pv ON pv.id = ${task.pickProductVariantId}
        WHERE oi.sku = pv.sku AND oi.status = 'pending' AND oi.requires_shipping = 1
        UNION ALL
        SELECT 'allocation_exception:' || ae.id::text AS demand_id
        FROM wms.allocation_exceptions ae
        JOIN wms.orders o ON o.id = ae.order_id
          AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
        JOIN catalog.product_variants pv ON pv.id = ${task.pickProductVariantId}
        WHERE ae.sku = pv.sku AND ae.status NOT IN ('resolved', 'resolved_inline', 'cancelled')
          AND (ae.status = 'blocked' OR LOWER(COALESCE(ae.metadata->>'shipmentBlocking', 'false')) = 'true')
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
    productVariantId: number,
    warehouseLocationId: number,
  ): Promise<{
    action: "replen_inline" | "short_pick_with_replen" | "true_short_pick";
    source?: { locationCode: string; availableQty: number; variantSku: string; variantName: string };
  }> {
    const [variant] = await this.db
      .select().from(productVariants)
      .where(eq(productVariants.id, productVariantId)).limit(1);
    if (!variant) return { action: "true_short_pick" };

    const [location] = await this.db
      .select().from(warehouseLocations)
      .where(eq(warehouseLocations.id, warehouseLocationId)).limit(1);
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
          availableQty: Math.max(0, Number(sourceLevel?.variantQty ?? 0) - Number(sourceLevel?.reservedQty ?? 0)),
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
        }).where(and(eq(replenTasks.id, task.id), eq(replenTasks.status, task.status), eq(replenTasks.revision, task.revision), inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"])));
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
  async reportException(taskId: number, command: unknown, actor: string) {
    return reportReplenishmentException(this.db as any, taskId, command, actor, this.clock);
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
    database: DrizzleDb = this.db,
  ): Promise<ReplenRule | null> {
    return readReplenishmentRule(database, pickProductVariantId);
  }

  /**
   * Query for the applicable tier default for a hierarchy level and warehouse.
   */
  private async findTierDefaultForVariant(
    hierarchyLevel: number,
    warehouseId?: number,
    database: DrizzleDb = this.db,
  ): Promise<ReplenTierDefault | null> {
    return readReplenishmentTierDefault(database, hierarchyLevel, warehouseId);
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
    observedPickQuantity: number;
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

    // A cascade represents two distinct conversions. Under canonical runtime,
    // both directed edges must exist explicitly; one allowed edge never grants
    // its reverse or an inferred transitive edge.
    const runtime = await this.transformationAuthority.readRuntime();
    let upstreamAuthorization: PackageConversionAuthorization | null = null;
    let downstreamAuthorization: PackageConversionAuthorization | null = null;
    let canonicalPickVariant: ProductVariant | null = null;
    if (runtime.authority === "canonical") {
      const [pickVariant] = await this.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, opts.pickVariantId))
        .limit(1);
      if (!pickVariant) {
        return null;
      }
      canonicalPickVariant = pickVariant as ProductVariant;
      try {
        upstreamAuthorization = await this.transformationAuthority.authorizePackageConversion(
          this.caseBreakAuthorizationRequest(grandparentVariant, intermediateVariant),
          runtime,
        );
        downstreamAuthorization = await this.transformationAuthority.authorizePackageConversion(
          this.caseBreakAuthorizationRequest(intermediateVariant, pickVariant),
          runtime,
        );
      } catch (error) {
        if (error instanceof TransformationExecutionAuthorityError
          && error.code === "PACKAGE_CONVERSION_PATH_NOT_ALLOWED") return null;
        throw error;
      }
    }

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
    const cascadeReplenMethod = runtime.authority === "canonical"
      ? "case_break"
      : cascadeTierDefault.replenMethod ?? "case_break";
    const cascadeAutoReplen = cascadeTierDefault.autoReplen ?? 0;
    const cascadePriority = cascadeTierDefault.priority ?? opts.priority;

    // Calculate upstream qty: 1 grandparent unit → N intermediate units
    const upstreamPathInput = upstreamAuthorization ? Number(upstreamAuthorization.inputQty) : 1;
    const upstreamPathOutput = upstreamAuthorization ? Number(upstreamAuthorization.outputQty) : 1;
    const downstreamPathInput = downstreamAuthorization ? Number(downstreamAuthorization.inputQty) : 1;
    const cascadeQtySource = upstreamAuthorization
      ? upstreamPathInput * Math.ceil(downstreamPathInput / upstreamPathOutput)
      : 1;
    const normalizedCascadeQtyTarget = cascadeQtySource * grandparentVariant.unitsPerVariant;
    if (upstreamAuthorization) {
      assertAuthorizedPackageConversionQuantity(
        upstreamAuthorization,
        cascadeQtySource,
        normalizedCascadeQtyTarget / this.variantUnits(intermediateVariant),
      );
    }
    const downstreamQtySource = downstreamAuthorization ? downstreamPathInput : 1;
    const downstreamQtyTarget = downstreamQtySource * intermediateVariant.unitsPerVariant;
    if (downstreamAuthorization && canonicalPickVariant) {
      assertAuthorizedPackageConversionQuantity(
        downstreamAuthorization,
        downstreamQtySource,
        downstreamQtyTarget / this.variantUnits(canonicalPickVariant),
      );
    }
    const downstreamReplenMethod = runtime.authority === "canonical" ? "case_break" : opts.replenMethod;

    // Resolve auto-execute for the upstream cascade task
    const cascadeExec = this.resolveAutoExecute(
      null,
      cascadeAutoReplen,
      opts.whSettings,
      normalizedCascadeQtyTarget,
      cascadeReplenMethod,
    );

    const downstreamExec = this.resolveAutoExecute(
      opts.autoReplen === 1 ? 1 : opts.autoReplen === 2 ? 2 : null,
      null,
      opts.whSettings,
      downstreamQtyTarget,
      downstreamReplenMethod,
    );

    // Both dependency rows and their trigger association are one transaction.
    // A failed downstream insert cannot strand an unowned upstream operation.
    const { upstreamTask, downstreamTask } = await this.db.transaction(
      async (tx: DrizzleDb) => {
        await this.lockPickBinTaskCreation(
          tx,
          opts.pickVariantId,
          opts.pickLocationId,
        );
        const prior = await this.priorTriggeredTask(
          opts.pickVariantId,
          opts.pickLocationId,
          opts.context,
          tx,
        );
        if (prior) return { upstreamTask: null, downstreamTask: prior.task };
        const existing = await this.findActiveTaskForPickBin(
          opts.pickVariantId,
          opts.pickLocationId,
          tx,
        );
        if (existing) {
          await this.rememberTriggeredTask(
            opts.pickVariantId,
            opts.pickLocationId,
            existing,
            opts.context,
            tx,
          );
          return { upstreamTask: null, downstreamTask: existing };
        }
        await this.assertObservedPickQuantity(
          tx,
          opts.pickVariantId,
          opts.pickLocationId,
          opts.observedPickQuantity,
        );
        const upstreamTask = await this.persistAutomaticTask(tx, {
            operationKey: opts.context?.operationKey
              ? `${opts.context.operationKey}:cascade`
              : null,
            replenRuleId: null,
            fromLocationId: cascadeSourceLocation.id,
            toLocationId: cascadeSourceLocation.id, // in-place break at reserve
            productId: opts.productId,
            sourceProductVariantId: grandparentVariantId,
            pickProductVariantId: opts.sourceVariantId, // intermediate variant
            qtySourceUnits: cascadeQtySource,
            qtyTargetUnits: normalizedCascadeQtyTarget,
            qtyCompleted: 0,
            status: "pending",
            priority: cascadePriority,
            triggeredBy: "cascade",
            executionMode: cascadeExec.executionMode,
            replenMethod: cascadeReplenMethod,
            autoReplen: cascadeAutoReplen,
            ...this.replenOrderTaskFields(
              opts.context
                ? { ...opts.context, blocksShipment: false }
                : undefined,
            ),
            warehouseId: opts.warehouseId,
            notes: this.appendOrderContextNote(
              `Cascade: break ${grandparentVariant.sku || grandparentVariant.name} into ${intermediateVariant.sku || intermediateVariant.name}`,
              opts.context,
            ),
          } satisfies InsertReplenTask);

        // --- Create Task B: downstream (intermediate → pick) blocked until Task A completes ---
        const downstreamTask = await this.persistAutomaticTask(tx, {
            operationKey: opts.context?.operationKey ?? null,
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
          } satisfies InsertReplenTask);
        await this.rememberTriggeredTask(
          opts.pickVariantId,
          opts.pickLocationId,
          downstreamTask,
          opts.context,
          tx,
        );
        return { upstreamTask, downstreamTask };
      },
    );

    // Auto-execute Task A if configured
    if (upstreamTask && cascadeExec.shouldAutoExecute) {
      try {
        await this.executeTask(upstreamTask.id, "system:auto-replen");
      } catch (autoErr: any) {
        console.warn(`[Replen] Cascade auto-execute failed for task ${upstreamTask.id}:`, autoErr?.message);
      }
    }

    return downstreamTask;
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

  private caseBreakAuthorizationRequest(
    sourceVariant: ProductVariant,
    pickVariant: ProductVariant,
  ): PackageConversionAuthorizationRequest {
    if (!sourceVariant.productId || !pickVariant.productId) {
      throw new TransformationExecutionAuthorityError(
        "PACKAGE_CONVERSION_INPUT_INVALID",
        "Case-break source and pick variants must both belong to a product.",
        { sourceVariantId: sourceVariant.id, pickVariantId: pickVariant.id },
      );
    }
    return {
      productId: sourceVariant.productId,
      operation: "break_pack",
      source: {
        variantId: sourceVariant.id,
        productId: sourceVariant.productId,
        unitsPerVariant: this.variantUnits(sourceVariant),
      },
      destination: {
        variantId: pickVariant.id,
        productId: pickVariant.productId,
        unitsPerVariant: this.variantUnits(pickVariant),
      },
    };
  }

  private async isCanonicalCaseBreakAuthorized(
    sourceVariant: ProductVariant,
    pickVariant: ProductVariant,
    runtime: TransformationRuntimeEvidence,
  ): Promise<boolean> {
    try {
      await this.transformationAuthority.authorizePackageConversion(
        this.caseBreakAuthorizationRequest(sourceVariant, pickVariant),
        runtime,
      );
      return true;
    } catch (error) {
      if (error instanceof TransformationExecutionAuthorityError
        && error.code === "PACKAGE_CONVERSION_PATH_NOT_ALLOWED") return false;
      throw error;
    }
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
    runtime: TransformationRuntimeEvidence;
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
      runtime,
    } = params;

    if (sourceHierarchyLevel == null || sourceHierarchyLevel === pickVariant.hierarchyLevel) {
      const location = await this.findSourceLocation(
        pickVariantId,
        warehouseId,
        sourceLocationType,
        parentLocationId,
        sourcePriority,
        (await this.demandForSource(pickVariant, pickVariant, qtyNeeded, runtime)).qtySourceUnits,
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

    const structurallyEligible = (siblings as ProductVariant[])
      .filter((variant) =>
        variant.id !== pickVariantId &&
        variant.hierarchyLevel === sourceHierarchyLevel &&
        this.isActiveVariant(variant) &&
        (runtime.authority === "canonical" || this.isValidCaseBreakSource(variant, pickVariant))
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
    const sourceVariants: ProductVariant[] = [];
    for (const sourceVariant of structurallyEligible) {
      if (runtime.authority === "legacy"
        || await this.isCanonicalCaseBreakAuthorized(sourceVariant, pickVariant, runtime)) {
        sourceVariants.push(sourceVariant);
      }
    }

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
        (await this.demandForSource(pickVariant, pickVariant, qtyNeeded, runtime)).qtySourceUnits,
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
      const demand = await this.demandForSource(pickVariant, sourceVariant, qtyNeeded, runtime);
      const location = await this.findSourceLocation(
        sourceVariant.id,
        warehouseId,
        sourceLocationType,
        parentLocationId,
        sourcePriority,
        demand.qtySourceUnits,
      );
      if (!location) continue;

      eligible.push({
        variant: sourceVariant,
        location,
        slotRank: await this.getSourceSlotRank(sourceVariant.id, location.id),
        overfillUnits: demand.qtyTargetUnits - Math.max(1, qtyNeeded) * this.variantUnits(pickVariant),
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
  async getSettingsForWarehouse(warehouseId?: number, database: DrizzleDb = this.db): Promise<WarehouseSettings | null> {
    // Delegates to the shared resolver so every service gets identical
    // fallback behavior. See server/modules/warehouse/settings.resolver.ts.
    return sharedGetSettingsForWarehouse(warehouseId, database as any);
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
    replenMethod: string,
  ): { shouldAutoExecute: boolean; executionMode: "inline" | "queue" } {
    return resolveReplenishmentAutoExecution(
      autoReplenFromRule, autoReplenFromTierDefault, settings, qtyTargetUnits, replenMethod,
    );
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
    requiredSourceQuantity: number = 1,
  ): Promise<WarehouseLocation | null> {
    if (!Number.isSafeInteger(requiredSourceQuantity) || requiredSourceQuantity <= 0) {
      throw new ReplenishmentExecutionDomainError("INVALID_REPLENISHMENT_SOURCE_QUANTITY",
        "Source selection requires a positive exact SKU quantity.", { requiredSourceQuantity });
    }
    // --- 1. Try dedicated parent location first ---
    if (parentLocationId) {
      const [parentLevel] = await this.db.select().from(inventoryLevels).where(
        and(
          eq(inventoryLevels.productVariantId, productVariantId),
          eq(inventoryLevels.warehouseLocationId, parentLocationId)
        )
      ).limit(1);
      if (parentLevel && parentLevel.variantQty - parentLevel.reservedQty >= requiredSourceQuantity) {
        const [parentLoc] = await this.db
          .select()
          .from(warehouseLocations)
          .where(eq(warehouseLocations.id, parentLocationId))
          .limit(1);
        if (
          parentLoc && (warehouseId == null || parentLoc.warehouseId === warehouseId) &&
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
          sql`${inventoryLevels.variantQty} - ${inventoryLevels.reservedQty} >= ${requiredSourceQuantity}`,
          ...(warehouseId != null
            ? [eq(warehouseLocations.warehouseId, warehouseId)]
            : []),
        ),
      )
      .orderBy(
        sourcePriority === "smallest_first"
          ? sql`${inventoryLevels.variantQty} - ${inventoryLevels.reservedQty}` // ascending = smallest available first
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
 * const replen = createReplenishmentService(db, inventoryCore, clock, transformationAuthority);
 * await replen.checkReplenNeeded(variantId, locationId);
 * ```
 */
export function createReplenishmentService(
  db: any,
  inventoryUseCases: any,
  clock: () => Date = () => new Date(),
  transformationAuthority: TransformationExecutionAuthorityPort,
) {
  return new ReplenishmentUseCases(db, inventoryUseCases, clock, transformationAuthority);
}
