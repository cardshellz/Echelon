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

type GenerateTasksResult = {
  success: boolean;
  tierDefaultsEvaluated: number;
  productsScanned: number;
  tasksCreated: number;
  skipped: number;
  details: { tasksCreated: any[]; skipped: any[] };
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
  // 1. CHECK THRESHOLDS -- scan pick locations and generate tasks
  // ---------------------------------------------------------------------------

  /**
   * Scan all forward-pick locations that have a triggerValue threshold configured
   * (via replen rules or tier defaults) and create replen tasks for any
   * location where variantQty has dropped below the threshold.
   *
   * Existing pending/assigned/in_progress tasks for the same product+location
   * are skipped to avoid duplicate work.
   *
   * @param warehouseId  Optional -- limit the scan to a single warehouse.
   * @returns Array of newly created replen tasks.
   */
  async checkThresholds(warehouseId?: number): Promise<ReplenTask[]> {
    // --- 1. Get all pickable locations (any type with is_pickable=1) ---
    const pickLocationQuery = this.db
      .select()
      .from(warehouseLocations)
      .where(
        and(
          eq(warehouseLocations.isPickable, 1),
          ...(warehouseId != null
            ? [eq(warehouseLocations.warehouseId, warehouseId)]
            : []),
        ),
      );
    const pickLocations: WarehouseLocation[] = await pickLocationQuery;

    if (pickLocations.length === 0) return [];

    const pickLocationIds = pickLocations.map((l) => l.id);
    const pickLocationMap = new Map(pickLocations.map((l) => [l.id, l]));

    // --- 1b. Load warehouse settings for unified execution decision ---
    const whSettings = await this.getSettingsForWarehouse(warehouseId);

    // --- 2. Get inventory levels at those locations ---
    const levels: InventoryLevel[] = await this.db
      .select()
      .from(inventoryLevels)
      .where(inArray(inventoryLevels.warehouseLocationId, pickLocationIds));

    // Also load product_locations to find assigned bins with no inventory level
    // Filter by warehouse_location_id being in our pick locations (source of truth)
    const assignedBins = await this.db
      .select()
      .from(productLocations)
      .where(
        and(
          inArray(productLocations.warehouseLocationId, pickLocationIds),
          eq(productLocations.status, "active"),
        ),
      );

    if (levels.length === 0 && assignedBins.length === 0) return [];

    // --- 3. Load replen rules, tier defaults, and location overrides ---
    const rules: ReplenRule[] = await this.db
      .select()
      .from(replenRules)
      .where(eq(replenRules.isActive, 1));

    const tierDefaults: ReplenTierDefault[] = await this.db
      .select()
      .from(replenTierDefaults)
      .where(eq(replenTierDefaults.isActive, 1));

    // Load location-level overrides (most-specific-wins)
    const locConfigs = await this.db
      .select()
      .from(locationReplenConfig)
      .where(
        and(
          eq(locationReplenConfig.isActive, 1),
          inArray(locationReplenConfig.warehouseLocationId, pickLocationIds),
        ),
      );
    // Index: key = "locationId" or "locationId:variantId"
    const locConfigMap = new Map<string, typeof locConfigs[0]>();
    for (const lc of locConfigs) {
      if (lc.productVariantId != null) {
        locConfigMap.set(`${lc.warehouseLocationId}:${lc.productVariantId}`, lc);
      } else {
        // location-wide default (lower priority than variant-specific)
        const key = `${lc.warehouseLocationId}`;
        if (!locConfigMap.has(key)) locConfigMap.set(key, lc);
      }
    }

    // Index rules by pickProductVariantId for fast lookup
    const ruleByPickVariant = new Map<number, ReplenRule>();
    for (const rule of rules) {
      if (rule.pickProductVariantId != null) {
        ruleByPickVariant.set(rule.pickProductVariantId, rule);
      }
    }

    // --- 4. Load variant metadata for hierarchy levels ---
    const existingLevelKeys = new Set(levels.map((l) => `${l.warehouseLocationId}:${l.productVariantId}`));

    // Load initial variants from existing inventory levels
    const variantIds = Array.from(new Set(levels.map((l) => l.productVariantId)));
    const variants: ProductVariant[] = variantIds.length > 0
      ? await this.db
          .select()
          .from(productVariants)
          .where(inArray(productVariants.id, variantIds))
      : [];
    const variantMap = new Map(variants.map((v) => [v.id, v]));

    // Pre-load all variants for the relevant products so resolveSourceVariant
    // can find case/pallet variants by product + hierarchy level without N+1 queries
    const productIds = Array.from(new Set(variants.map((v) => v.productId).filter(Boolean))) as number[];
    const allProductVariantsArr: ProductVariant[] = productIds.length > 0
      ? await this.db
          .select()
          .from(productVariants)
          .where(inArray(productVariants.productId, productIds))
      : [];
    const productVariantsCache = new Map<number, ProductVariant[]>();
    for (const v of allProductVariantsArr) {
      if (!v.productId) continue;
      const arr = productVariantsCache.get(v.productId) ?? [];
      arr.push(v);
      productVariantsCache.set(v.productId, arr);
    }

    // Add synthetic zero-qty levels for assigned bins with no inventory level
    // Build lowest-level variant per product for assigned bin resolution
    const lowestVariantByProduct = new Map<number, ProductVariant>();
    for (const v of allProductVariantsArr) {
      if (!v.productId) continue;
      const existing = lowestVariantByProduct.get(v.productId);
      if (!existing || v.hierarchyLevel < existing.hierarchyLevel) {
        lowestVariantByProduct.set(v.productId, v);
      }
    }

    for (const ab of assignedBins) {
      if (!ab.warehouseLocationId || !ab.productId) continue;
      if (!pickLocationMap.has(ab.warehouseLocationId)) continue; // Not a pick location we're scanning

      // Find the pick variant (lowest hierarchy level) for this product
      const pickVariant = lowestVariantByProduct.get(ab.productId);
      if (!pickVariant) continue;

      const key = `${ab.warehouseLocationId}:${pickVariant.id}`;
      if (existingLevelKeys.has(key)) continue; // Already have a real inventory level
      existingLevelKeys.add(key);

      // Ensure variantMap has the pick variant for threshold check
      if (!variantMap.has(pickVariant.id)) variantMap.set(pickVariant.id, pickVariant);

      // Create synthetic zero-qty level so the threshold check finds it
      levels.push({
        id: -1, // synthetic
        productVariantId: pickVariant.id,
        warehouseLocationId: ab.warehouseLocationId,
        variantQty: 0,
        reservedQty: 0,
        allocatedQty: 0,
        damagedQty: 0,
        updatedAt: new Date(),
      } as any);
    }

    // --- 5. Load existing active tasks to avoid duplicates ---
    const activeTasks: ReplenTask[] = await this.db
      .select()
      .from(replenTasks)
      .where(inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"]));

    const activeTaskKeys = new Set(
      activeTasks.map((t) => `${t.pickProductVariantId}:${t.toLocationId}`),
    );

    // --- 5b. Re-evaluate blocked tasks — unblock if source stock now available ---
    const blockedTasks = activeTasks.filter((t) => t.status === "blocked");
    for (const task of blockedTasks) {
      if (!task.sourceProductVariantId || !task.toLocationId) continue;

      const destLocation = pickLocationMap.get(task.toLocationId);
      if (!destLocation) continue;

      const pickVariant = task.pickProductVariantId != null
        ? variantMap.get(task.pickProductVariantId)
        : undefined;
      const rule = task.pickProductVariantId != null
        ? ruleByPickVariant.get(task.pickProductVariantId)
        : undefined;
      const tierDefault = pickVariant
        ? this.findTierDefault(tierDefaults, pickVariant.hierarchyLevel, destLocation.warehouseId ?? undefined)
        : undefined;

      const sourceLocationType = rule?.sourceLocationType ?? tierDefault?.sourceLocationType ?? "reserve";
      const sourcePriority = rule?.sourcePriority ?? tierDefault?.sourcePriority ?? "fifo";

      // Try to find source stock now (exclude destination to prevent self-replen)
      const sourceLocation = await this.findSourceLocation(
        task.sourceProductVariantId,
        destLocation.warehouseId ?? undefined,
        sourceLocationType,
        destLocation.parentLocationId,
        sourcePriority,
        task.toLocationId,
      );

      if (sourceLocation) {
        // Source stock is available — calculate qty and unblock
        const currentLevel = levels.find(
          (l) => l.productVariantId === task.pickProductVariantId && l.warehouseLocationId === task.toLocationId,
        );
        const currentQty = currentLevel?.variantQty ?? 0;
        const maxQty = rule?.maxQty ?? tierDefault?.maxQty ?? null;
        const triggerValue = rule?.triggerValue ?? tierDefault?.triggerValue ?? 0;
        const qtyNeeded = (maxQty ?? triggerValue * 2) - currentQty;

        const sourceVariant = variantMap.get(task.sourceProductVariantId) ?? pickVariant;
        const unitsPerSource = sourceVariant?.unitsPerVariant ?? 1;
        const qtySourceUnits = Math.max(1, Math.ceil(qtyNeeded / unitsPerSource));
        const qtyTargetUnits = qtySourceUnits * unitsPerSource;

        const { shouldAutoExecute, executionMode } = this.resolveAutoExecute(
          rule?.autoReplen ?? null,
          tierDefault?.autoReplen ?? null,
          whSettings,
          qtyTargetUnits,
        );

        await this.db
          .update(replenTasks)
          .set({
            fromLocationId: sourceLocation.id,
            qtySourceUnits,
            qtyTargetUnits,
            status: "pending",
            executionMode,
            notes: `${task.notes || ""}\nUnblocked: source stock found at ${sourceLocation.code}`,
          })
          .where(eq(replenTasks.id, task.id));

        // Auto-execute if settings allow
        if (shouldAutoExecute) {
          try {
            await this.executeTask(task.id, "system:auto-replen");
          } catch (autoErr: any) {
            console.warn(`[Replen] Auto-execute unblocked task ${task.id} failed:`, autoErr?.message);
          }
        }
      }
    }

    // --- 6. For each level, check threshold and create task if needed ---
    const newTasks: ReplenTask[] = [];

    for (const level of levels) {
      const variant = variantMap.get(level.productVariantId);
      if (!variant) continue;

      const location = pickLocationMap.get(level.warehouseLocationId);
      if (!location) continue;

      // Resolve replen parameters: location config > SKU rule > tier default
      const locConfig = locConfigMap.get(`${level.warehouseLocationId}:${level.productVariantId}`)
        || locConfigMap.get(`${level.warehouseLocationId}`);
      const rule = ruleByPickVariant.get(level.productVariantId);
      const tierDefault = this.findTierDefault(
        tierDefaults,
        variant.hierarchyLevel,
        location.warehouseId ?? undefined,
      );

      const triggerValue = (locConfig?.triggerValue != null ? parseFloat(locConfig.triggerValue) : null)
        ?? rule?.triggerValue ?? tierDefault?.triggerValue ?? null;
      if (triggerValue == null || triggerValue < 0) continue; // No threshold configured

      // Determine replen parameters (resolved early for threshold branching)
      const maxQty = locConfig?.maxQty ?? rule?.maxQty ?? tierDefault?.maxQty ?? null;
      const replenMethod = locConfig?.replenMethod ?? rule?.replenMethod ?? tierDefault?.replenMethod ?? "full_case";
      const priority = rule?.priority ?? tierDefault?.priority ?? 5;
      const sourceLocationType = rule?.sourceLocationType ?? tierDefault?.sourceLocationType ?? "reserve";
      const autoReplen = rule?.autoReplen ?? tierDefault?.autoReplen ?? 0;
      const sourceVariantId = rule?.sourceProductVariantId ?? await this.resolveSourceVariant(variant, tierDefault, productVariantsCache);

      // --- Threshold check: branching by replenMethod ---
      let taskNotes: string;

      if (replenMethod === "pallet_drop") {
        // triggerValue = coverage days — compare (currentQty / velocity) against it
        const velocity = await this.computeVariantVelocity(level.productVariantId);
        if (velocity === 0) continue; // No picks → infinite coverage, skip

        const coverageDays = level.variantQty / velocity;
        if (coverageDays >= triggerValue) continue; // Coverage still sufficient

        taskNotes = `Auto-generated (pallet_drop): velocity=${velocity.toFixed(1)}/day, coverage=${coverageDays.toFixed(1)}d, trigger=${triggerValue}d`;
      } else {
        // case_break / full_case: triggerValue = min units threshold
        // Use <= so that currentQty == triggerValue still triggers replen
        // (e.g., triggerValue=0 and bin is empty → 0 <= 0 → replen fires)
        if (level.variantQty > triggerValue) continue;

        taskNotes = `Auto-generated: onHand=${level.variantQty}, triggerValue=${triggerValue}`;
      }

      // Skip if a task already exists for this product+location
      const key = `${level.productVariantId}:${level.warehouseLocationId}`;
      if (activeTaskKeys.has(key)) continue;

      // Resolve unified execution decision
      const sourcePriority = rule?.sourcePriority ?? tierDefault?.sourcePriority ?? "fifo";
      const { shouldAutoExecute, executionMode } = this.resolveAutoExecute(
        rule?.autoReplen ?? null,
        tierDefault?.autoReplen ?? null,
        whSettings,
        0, // qtyTargetUnits not known yet for blocked tasks — recalculated below
      );

      // Find a source location with stock (exclude pick bin to prevent self-replen)
      const sourceLocation = await this.findSourceLocation(
        sourceVariantId ?? level.productVariantId,
        location.warehouseId ?? undefined,
        sourceLocationType,
        location.parentLocationId,
        sourcePriority,
        level.warehouseLocationId,
      );
      if (!sourceLocation) {
        // No stock at immediate parent — try cascade (walk up one more level)
        if (sourceVariantId) {
          const cascadeResult = await this.tryCascadeReplen({
            sourceVariantId,
            pickVariantId: level.productVariantId,
            pickLocationId: level.warehouseLocationId,
            warehouseId: location.warehouseId ?? undefined,
            sourceLocationType,
            sourcePriority,
            rule,
            tierDefault,
            whSettings,
            taskNotes,
            triggeredBy: "min_max",
            priority,
            autoReplen,
          });
          if (cascadeResult) {
            newTasks.push(cascadeResult);
            continue;
          }
        }

        // No cascade possible — create a blocked task so it's visible
        const [blockedTask] = await this.db
          .insert(replenTasks)
          .values({
            replenRuleId: rule?.id ?? null,
            fromLocationId: location.id, // placeholder — no actual source
            toLocationId: level.warehouseLocationId,
            productId: rule?.productId ?? null,
            sourceProductVariantId: sourceVariantId ?? level.productVariantId,
            pickProductVariantId: level.productVariantId,
            qtySourceUnits: 0,
            qtyTargetUnits: 0,
            qtyCompleted: 0,
            status: "blocked",
            priority,
            triggeredBy: "min_max",
            executionMode,
            replenMethod,
            autoReplen,
            warehouseId: location.warehouseId ?? undefined,
            notes: `${taskNotes}\nBlocked: no source stock found in ${sourceLocationType} locations`,
          } satisfies InsertReplenTask)
          .returning();
        newTasks.push(blockedTask as ReplenTask);
        continue;
      }

      // Calculate target quantity (how many base units to move)
      const qtyNeeded = (maxQty ?? triggerValue * 2) - level.variantQty;
      const sourceVariant = sourceVariantId != null
        ? variantMap.get(sourceVariantId) ?? variant
        : variant;
      const qtySourceUnits = Math.max(1, Math.ceil(qtyNeeded / sourceVariant.unitsPerVariant));
      const qtyTargetUnits = qtySourceUnits * sourceVariant.unitsPerVariant;

      // Re-resolve with actual qtyTargetUnits (matters for hybrid mode)
      const execDecision = this.resolveAutoExecute(
        rule?.autoReplen ?? null,
        tierDefault?.autoReplen ?? null,
        whSettings,
        qtyTargetUnits,
      );

      // Create the task — persist replenMethod and resolved execution mode
      const [task] = await this.db
        .insert(replenTasks)
        .values({
          replenRuleId: rule?.id ?? null,
          fromLocationId: sourceLocation.id,
          toLocationId: level.warehouseLocationId,
          productId: rule?.productId ?? null,
          sourceProductVariantId: sourceVariantId ?? level.productVariantId,
          pickProductVariantId: level.productVariantId,
          qtySourceUnits,
          qtyTargetUnits,
          qtyCompleted: 0,
          status: "pending",
          priority,
          triggeredBy: "min_max",
          executionMode: execDecision.executionMode,
          replenMethod,
          autoReplen,
          warehouseId: location.warehouseId ?? undefined,
          notes: taskNotes,
        } satisfies InsertReplenTask)
        .returning();

      // Unified auto-execute: immediately execute if resolved decision says so
      if (execDecision.shouldAutoExecute) {
        try {
          await this.executeTask(task.id, "system:auto-replen");
        } catch (autoErr: any) {
          console.warn(`[Replen] Auto-replen failed for task ${task.id}:`, autoErr?.message);
          await this.db
            .update(replenTasks)
            .set({
              status: "blocked",
              notes: `${taskNotes}\nAuto-replen failed: ${autoErr?.message || "unknown error"}`,
            })
            .where(eq(replenTasks.id, task.id));
        }
      }

      newTasks.push(task as ReplenTask);
      activeTaskKeys.add(key); // Prevent duplicates within this run
    }

    // --- 7. Sweep existing pending tasks and auto-execute if settings now allow ---
    const pendingTasks = activeTasks.filter((t) => t.status === "pending");
    for (const task of pendingTasks) {
      const rule = task.pickProductVariantId != null
        ? ruleByPickVariant.get(task.pickProductVariantId)
        : undefined;
      const variant = task.pickProductVariantId != null
        ? variantMap.get(task.pickProductVariantId)
        : undefined;
      const location = task.toLocationId != null
        ? pickLocationMap.get(task.toLocationId)
        : undefined;
      const tierDefault = variant && location
        ? this.findTierDefault(tierDefaults, variant.hierarchyLevel, location.warehouseId ?? undefined)
        : undefined;

      const { shouldAutoExecute } = this.resolveAutoExecute(
        rule?.autoReplen ?? null,
        tierDefault?.autoReplen ?? null,
        whSettings,
        task.qtyTargetUnits ?? 0,
      );

      if (shouldAutoExecute) {
        try {
          await this.executeTask(task.id, "system:auto-replen");
        } catch (autoErr: any) {
          console.warn(`[Replen] Auto-execute sweep failed for task ${task.id}:`, autoErr?.message);
          try {
            await this.db.update(replenTasks).set({
              status: "blocked",
              notes: `${task.notes || ""}\nAuto-replen sweep failed: ${autoErr?.message || "unknown error"}`,
            }).where(eq(replenTasks.id, task.id));
          } catch (updateErr: any) {
            console.error(`[Replen] CRITICAL: Failed to mark task ${task.id} as blocked:`, updateErr?.message);
          }
        }
      }
    }

    return newTasks;
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

    let movedBaseUnits = 0;

    if (
      replenMethod === "case_break" &&
      sourceVariant &&
      pickVariant &&
      sourceVariant.id !== pickVariant.id
    ) {
      // --- CASE BREAK: consume source variant, produce pick-variant base units ---

      const baseUnitsFromSource = task.qtySourceUnits * sourceVariant.unitsPerVariant;
      const pickVariantUnits = Math.floor(baseUnitsFromSource / pickVariant.unitsPerVariant);
      const remainder = baseUnitsFromSource - (pickVariantUnits * pickVariant.unitsPerVariant);

      if (pickVariantUnits <= 0) {
        throw new Error(
          `Case break would produce 0 pick units: ${task.qtySourceUnits} x ${sourceVariant.unitsPerVariant} ` +
          `base units / ${pickVariant.unitsPerVariant} per pick unit`,
        );
      }

      // 1. Snapshot source level for audit log, then atomic guarded decrement
      const sourceLevel = await this.inventoryCore.getLevel(
        sourceVariant.id,
        task.fromLocationId,
      );
      if (!sourceLevel) {
        throw new Error(
          `No inventory level at location ${task.fromLocationId} for variant ${sourceVariant.id}`,
        );
      }

      // Atomic UPDATE with WHERE guard — prevents concurrent tasks from
      // over-decrementing (same pattern as pickItem optimistic lock).
      const [updated] = await this.db
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

      // Log the break transaction
      await this.inventoryCore.logTransaction({
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

      // 2. Increment pick variant at toLocation
      const destLevel = await this.inventoryCore.upsertLevel(
        pickVariant.id,
        task.toLocationId,
      );

      await this.inventoryCore.adjustLevel(destLevel.id, {
        variantQty: pickVariantUnits,
      });

      // Log the replenish transaction
      await this.inventoryCore.logTransaction({
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

      movedBaseUnits = baseUnitsFromSource;
    } else {
      // --- FULL CASE or default: direct transfer of source variant ---

      const variantId = task.sourceProductVariantId ?? task.pickProductVariantId!;
      const variant = sourceVariant ?? pickVariant;
      const baseUnits = task.qtySourceUnits * (variant?.unitsPerVariant ?? 1);

      await this.inventoryCore.transfer({
        productVariantId: variantId,
        fromLocationId: task.fromLocationId,
        toLocationId: task.toLocationId,
        qty: task.qtySourceUnits,
        userId,
        notes: `Replen task #${taskId} (full_case)`,
      });

      movedBaseUnits = baseUnits;
    }

    // Update task to completed
    await this.db
      .update(replenTasks)
      .set({
        status: "completed",
        qtyCompleted: movedBaseUnits,
        completedAt: new Date(),
        assignedTo: userId ?? task.assignedTo,
      })
      .where(eq(replenTasks.id, taskId));

    // Unblock dependent cascade tasks
    await this.unblockDependentTasks(taskId, userId);

    return { moved: movedBaseUnits };
  }

  /**
   * After a task completes, check for blocked tasks that depend on it.
   * Unblock them and auto-execute if configured.
   */
  private async unblockDependentTasks(completedTaskId: number, userId?: string): Promise<void> {
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

  /**
   * Called after every pick operation to check whether the pick location
   * now needs replenishment. If the on-hand quantity has dropped below the
   * configured triggerValue threshold and no active task already exists for this
   * product+location, a new pending replen task is created and returned.
   *
   * This is the "auto-trigger" that runs inline after picks so the warehouse
   * can proactively replenish before a stockout occurs.
   *
   * @param productVariantId     The variant that was just picked.
   * @param warehouseLocationId  The location it was picked from.
   * @returns The newly created replen task, or `null` if no replenishment
   *          is needed or a task already exists.
   */
  async checkAndTriggerAfterPick(
    productVariantId: number,
    warehouseLocationId: number,
  ): Promise<ReplenTask | null> {
    // Get current level at the pick location
    const level = await this.inventoryCore.getLevel(
      productVariantId,
      warehouseLocationId,
    );
    if (!level) return null;

    // Get the location metadata
    const [location] = await this.db
      .select()
      .from(warehouseLocations)
      .where(eq(warehouseLocations.id, warehouseLocationId))
      .limit(1);

    if (!location || location.isPickable !== 1) return null;

    // Only replenish variants that are assigned to this pick location
    const [assignment] = await this.db
      .select({ id: productLocations.id })
      .from(productLocations)
      .where(
        and(
          eq(productLocations.productVariantId, productVariantId),
          eq(productLocations.warehouseLocationId, warehouseLocationId),
        ),
      )
      .limit(1);
    if (!assignment) return null;

    // Get variant for hierarchy level
    const [variant] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, productVariantId))
      .limit(1);

    if (!variant) return null;

    // Load warehouse settings for unified execution decision
    const whSettings = await this.getSettingsForWarehouse(location.warehouseId ?? undefined);

    // Resolve triggerValue threshold -- location config > SKU rule > tier default
    // Check location-specific override first (most specific wins)
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
    const locConfig = locConfigVariant[0] || locConfigWide;

    const rule = await this.findRuleForVariant(productVariantId);
    const tierDefault = await this.findTierDefaultForVariant(
      variant.hierarchyLevel,
      location.warehouseId ?? undefined,
    );

    const triggerValue = (locConfig?.triggerValue != null ? parseFloat(locConfig.triggerValue) : null)
      ?? rule?.triggerValue ?? tierDefault?.triggerValue ?? null;
    if (triggerValue == null || triggerValue < 0) return null;

    // Determine replen parameters (resolved early for threshold branching)
    const maxQty = locConfig?.maxQty ?? rule?.maxQty ?? tierDefault?.maxQty ?? null;
    const replenMethod = locConfig?.replenMethod ?? rule?.replenMethod ?? tierDefault?.replenMethod ?? "full_case";
    const priority = rule?.priority ?? tierDefault?.priority ?? 5;
    const sourceLocationType = rule?.sourceLocationType ?? tierDefault?.sourceLocationType ?? "reserve";
    const autoReplen = rule?.autoReplen ?? tierDefault?.autoReplen ?? 0;
    const sourceVariantId = rule?.sourceProductVariantId ?? await this.resolveSourceVariant(variant, tierDefault);

    // --- Threshold check: branching by replenMethod ---
    let taskNotes: string;

    if (replenMethod === "pallet_drop") {
      // triggerValue = coverage days — compare (currentQty / velocity) against it
      const velocity = await this.computeVariantVelocity(productVariantId);
      if (velocity === 0) return null; // No picks → infinite coverage, skip

      const coverageDays = level.variantQty / velocity;
      if (coverageDays >= triggerValue) return null; // Coverage still sufficient

      taskNotes = `Auto-triggered after pick (pallet_drop): velocity=${velocity.toFixed(1)}/day, coverage=${coverageDays.toFixed(1)}d, trigger=${triggerValue}d`;
    } else {
      // case_break / full_case: use <= so triggerValue=0 with empty bin fires
      if (level.variantQty > triggerValue) return null;

      taskNotes = `Auto-triggered after pick: onHand=${level.variantQty}, triggerValue=${triggerValue}`;
    }

    // Check for existing active or blocked task (avoid duplicates)
    const [existingTask] = await this.db
      .select()
      .from(replenTasks)
      .where(
        and(
          eq(replenTasks.pickProductVariantId, productVariantId),
          eq(replenTasks.toLocationId, warehouseLocationId),
          inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"]),
        ),
      )
      .limit(1);

    if (existingTask) return null; // Already queued or blocked

    // Resolve unified execution decision + source priority
    const sourcePriority = rule?.sourcePriority ?? tierDefault?.sourcePriority ?? "fifo";
    const { shouldAutoExecute, executionMode } = this.resolveAutoExecute(
      rule?.autoReplen ?? null,
      tierDefault?.autoReplen ?? null,
      whSettings,
      0, // qtyTargetUnits not known yet — recalculated below
    );

    // Find source location with stock (exclude pick bin to prevent self-replen)
    const sourceLocation = await this.findSourceLocation(
      sourceVariantId ?? productVariantId,
      location.warehouseId ?? undefined,
      sourceLocationType,
      location.parentLocationId,
      sourcePriority,
      warehouseLocationId,
    );
    if (!sourceLocation) {
      // No stock at immediate parent — try cascade (walk up one more level)
      if (sourceVariantId) {
        const cascadeResult = await this.tryCascadeReplen({
          sourceVariantId,
          pickVariantId: productVariantId,
          pickLocationId: warehouseLocationId,
          warehouseId: location.warehouseId ?? undefined,
          sourceLocationType,
          sourcePriority,
          rule,
          tierDefault,
          whSettings,
          taskNotes,
          triggeredBy: "inline_pick",
          priority,
          autoReplen,
        });
        if (cascadeResult) return cascadeResult;
      }

      // No cascade possible — create a blocked task so it's visible
      const [blockedTask] = await this.db
        .insert(replenTasks)
        .values({
          replenRuleId: rule?.id ?? null,
          fromLocationId: warehouseLocationId, // placeholder — no actual source
          toLocationId: warehouseLocationId,
          productId: rule?.productId ?? null,
          sourceProductVariantId: sourceVariantId ?? productVariantId,
          pickProductVariantId: productVariantId,
          qtySourceUnits: 0,
          qtyTargetUnits: 0,
          qtyCompleted: 0,
          status: "blocked",
          priority,
          triggeredBy: "inline_pick",
          executionMode,
          replenMethod,
          autoReplen,
          warehouseId: location.warehouseId ?? undefined,
          notes: `${taskNotes}\nBlocked: no source stock found in ${sourceLocationType} locations`,
        } satisfies InsertReplenTask)
        .returning();
      return blockedTask as ReplenTask;
    }

    // Calculate quantities
    const sourceVariant = sourceVariantId != null
      ? (await this.db
          .select()
          .from(productVariants)
          .where(eq(productVariants.id, sourceVariantId))
          .limit(1))[0] ?? variant
      : variant;

    const qtyNeeded = (maxQty ?? triggerValue * 2) - level.variantQty;
    const qtySourceUnits = Math.max(1, Math.ceil(qtyNeeded / sourceVariant.unitsPerVariant));
    const qtyTargetUnits = qtySourceUnits * sourceVariant.unitsPerVariant;

    // Re-resolve with actual qtyTargetUnits (matters for hybrid mode)
    console.log(`[Replen DEBUG] resolveAutoExecute inputs:`, {
      ruleAutoReplen: rule?.autoReplen ?? null,
      tierDefaultAutoReplen: tierDefault?.autoReplen ?? null,
      tierDefaultId: tierDefault?.id ?? null,
      whSettingsId: whSettings?.id ?? null,
      whReplenMode: whSettings?.replenMode ?? null,
      locationWarehouseId: location.warehouseId,
      qtyTargetUnits,
    });
    const execDecision = this.resolveAutoExecute(
      rule?.autoReplen ?? null,
      tierDefault?.autoReplen ?? null,
      whSettings,
      qtyTargetUnits,
    );
    console.log(`[Replen DEBUG] execDecision:`, execDecision);

    // Create the task — persist replenMethod and resolved execution mode
    const [task] = await this.db
      .insert(replenTasks)
      .values({
        replenRuleId: rule?.id ?? null,
        fromLocationId: sourceLocation.id,
        toLocationId: warehouseLocationId,
        productId: rule?.productId ?? null,
        sourceProductVariantId: sourceVariantId ?? productVariantId,
        pickProductVariantId: productVariantId,
        qtySourceUnits,
        qtyTargetUnits,
        qtyCompleted: 0,
        status: "pending",
        priority,
        triggeredBy: "inline_pick",
        executionMode: execDecision.executionMode,
        replenMethod,
        autoReplen,
        warehouseId: location.warehouseId ?? undefined,
        notes: taskNotes,
      } satisfies InsertReplenTask)
      .returning();

    // Unified auto-execute: immediately execute if resolved decision says so
    console.log(`[Replen DEBUG] Task ${task.id} shouldAutoExecute=${execDecision.shouldAutoExecute}, executionMode=${execDecision.executionMode}`);
    if (execDecision.shouldAutoExecute) {
      try {
        console.log(`[Replen DEBUG] Calling executeTask(${task.id})...`);
        await this.executeTask(task.id, "system:auto-replen");
        console.log(`[Replen DEBUG] executeTask(${task.id}) completed successfully`);
      } catch (autoErr: any) {
        console.warn(`[Replen] Auto-replen after pick failed for task ${task.id}:`, autoErr?.message);
        // Mark as blocked so it doesn't prevent future task creation (dedup skips blocked)
        try {
          await this.db
            .update(replenTasks)
            .set({
              status: "blocked",
              notes: `${taskNotes}\nAuto-replen failed: ${autoErr?.message || "unknown error"}`,
            })
            .where(eq(replenTasks.id, task.id));
        } catch (updateErr: any) {
          console.error(`[Replen] CRITICAL: Failed to mark task ${task.id} as blocked:`, updateErr?.message);
        }
      }
    }

    return task as ReplenTask;
  }

  // ---------------------------------------------------------------------------
  // 6. GENERATE TASKS -- auto-generate replen tasks for all pick locations
  // ---------------------------------------------------------------------------

  /**
   * Auto-generate replen tasks by scanning all pick locations that are below
   * their configured trigger threshold. Handles cube capacity limits and
   * overflow bin routing.
   *
   * This is the main "Auto-Generate" algorithm invoked from the UI or
   * scheduler. It batch-loads all needed data upfront for efficiency, then
   * iterates through every pick-location inventory level to find locations
   * below threshold.
   *
   * @param warehouseId  Optional -- limit the scan to a single warehouse.
   * @returns Diagnostic result with counts and details of created/skipped tasks.
   */
  async generateTasks(warehouseId?: number): Promise<GenerateTasksResult> {
    // --- 1. Batch-load all needed data ---
    const allTierDefaults: ReplenTierDefault[] = await this.db
      .select().from(replenTierDefaults).where(eq(replenTierDefaults.isActive, 1));
    const allRules: ReplenRule[] = await this.db
      .select().from(replenRules).where(eq(replenRules.isActive, 1));
    const allLevels: InventoryLevel[] = await this.db.select().from(inventoryLevels);
    const allLocations: WarehouseLocation[] = await this.db.select().from(warehouseLocations);
    const allVariants: ProductVariant[] = await this.db.select().from(productVariants);
    const allProducts = await this.db.select().from(products);
    const allWarehouses = await this.db.select().from(warehouses);
    const allSettings = await this.db.select().from(warehouseSettings);
    const allProductLocs = await this.db.select().from(productLocations);

    // --- 2. Build lookup maps ---
    const locationMap = new Map(allLocations.map((l) => [l.id, l]));
    const productMap = new Map(allProducts.map((p: any) => [p.id, p]));
    const variantMap = new Map(allVariants.map((v) => [v.id, v]));
    const warehouseMap = new Map(allWarehouses.map((w: any) => [w.id, w]));

    // Warehouse settings: warehouseCode -> settings, with DEFAULT fallback
    const settingsByWarehouseCode = new Map(allSettings.map((s: any) => [s.warehouseCode, s]));
    const defaultSettings = allSettings.find((s: any) => s.warehouseCode === "DEFAULT") || {
      replenMode: "queue",
      inlineReplenMaxUnits: 50,
    } as any;
    const getLocationSettings = (loc: WarehouseLocation) => {
      if (!loc.warehouseId) return defaultSettings;
      const wh = warehouseMap.get(loc.warehouseId);
      if (!wh) return defaultSettings;
      return settingsByWarehouseCode.get((wh as any).code) || defaultSettings;
    };

    // Group variants by product + hierarchy level
    const variantsByProduct = new Map<number, Map<number, ProductVariant>>();
    for (const v of allVariants) {
      if (!v.productId) continue;
      if (!variantsByProduct.has(v.productId)) variantsByProduct.set(v.productId, new Map());
      variantsByProduct.get(v.productId)!.set(v.hierarchyLevel, v);
    }

    // Map variant ID -> product ID for override lookup
    const productIdByVariantId = new Map<number, number>();
    for (const v of allVariants) {
      if (v.productId) productIdByVariantId.set(v.id, v.productId);
    }

    // Index SKU overrides by product ID
    const overridesByProduct = new Map<number, ReplenRule>();
    for (const rule of allRules) {
      if (rule.productId) overridesByProduct.set(rule.productId, rule);
    }

    // --- 3. Build inventory index: variantId-locationType -> locations with stock ---
    const inventoryByVariantAndType = this.buildInventoryIndex(allLevels, locationMap);

    // --- 4. Find all pick locations below threshold ---
    // Build assignment set for quick lookup — only replenish assigned bins
    const assignedSet = new Set<string>();
    for (const pl of allProductLocs) {
      if ((pl as any).productVariantId && (pl as any).warehouseLocationId) {
        assignedSet.add(`${(pl as any).warehouseLocationId}:${(pl as any).productVariantId}`);
      }
    }

    const pickLocationsNeedingReplen = new Map<number, Array<{
      locationId: number;
      variantId: number;
      currentQty: number;
      hierarchyLevel: number;
    }>>();
    const seenPickLocVariant = new Set<string>();

    for (const level of allLevels) {
      const location = locationMap.get(level.warehouseLocationId);
      if (!location || location.isPickable !== 1) continue;
      if (warehouseId != null && location.warehouseId !== warehouseId) continue;

      const variant = variantMap.get(level.productVariantId);
      if (!variant || !variant.productId) continue;

      // Skip stray inventory — only replenish variants assigned to this bin
      if (!assignedSet.has(`${level.warehouseLocationId}:${level.productVariantId}`)) continue;

      seenPickLocVariant.add(`${level.warehouseLocationId}:${level.productVariantId}`);
      const arr = pickLocationsNeedingReplen.get(variant.productId) ?? [];
      arr.push({
        locationId: level.warehouseLocationId,
        variantId: level.productVariantId,
        currentQty: level.variantQty || 0,
        hierarchyLevel: variant.hierarchyLevel,
      });
      pickLocationsNeedingReplen.set(variant.productId, arr);
    }

    // Also check product_locations for assigned bins with no inventory level
    // Use warehouse_locations (via locationMap) as source of truth for pickable status
    for (const pl of allProductLocs) {
      if ((pl as any).status !== "active") continue;
      if (!(pl as any).warehouseLocationId || !(pl as any).productId) continue;
      const loc = locationMap.get((pl as any).warehouseLocationId);
      if (!loc || loc.isPickable !== 1) continue;
      if (warehouseId != null && loc.warehouseId !== warehouseId) continue;

      const productId = (pl as any).productId;
      if (!productId) continue;

      const productVars = variantsByProduct.get(productId);
      if (!productVars) continue;
      const lowestLevel = Math.min(...Array.from(productVars.keys()));
      const variant = productVars.get(lowestLevel);
      if (!variant) continue;

      const key = `${(pl as any).warehouseLocationId}:${variant.id}`;
      if (seenPickLocVariant.has(key)) continue;
      seenPickLocVariant.add(key);

      const arr = pickLocationsNeedingReplen.get(productId) ?? [];
      arr.push({
        locationId: (pl as any).warehouseLocationId,
        variantId: variant.id,
        currentQty: 0,
        hierarchyLevel: variant.hierarchyLevel,
      });
      pickLocationsNeedingReplen.set(productId, arr);
    }

    // --- 5. Process each product with pick-location inventory ---
    const tasksCreated: any[] = [];
    const skipped: any[] = [];
    const sortedTierDefaults = [...allTierDefaults].sort((a, b) => a.priority - b.priority);

    for (const [productId, pickLocs] of Array.from(pickLocationsNeedingReplen.entries())) {
      const product = productMap.get(productId) as any;
      if (!product) continue;

      const prodVariants = variantsByProduct.get(productId);
      if (!prodVariants) continue;

      for (const pickLoc of pickLocs) {
        // Find the matching tier default
        let matchedDefault: ReplenTierDefault | null = null;
        let sourceVariant: ProductVariant | null = null;
        const pickVariant = variantMap.get(pickLoc.variantId);
        if (!pickVariant) continue;

        // Look up SKU override via product mapping
        const pickProductId = productIdByVariantId.get(pickLoc.variantId);
        const override = pickProductId ? overridesByProduct.get(pickProductId) : undefined;

        for (const tierDefault of sortedTierDefaults) {
          if (tierDefault.hierarchyLevel !== pickLoc.hierarchyLevel) continue;
          // Primary: find variant at the tier default's source hierarchy level
          const sourceByLevel = prodVariants.get(tierDefault.sourceHierarchyLevel);
          if (sourceByLevel) {
            matchedDefault = tierDefault;
            sourceVariant = sourceByLevel;
            break;
          }
          // Fallback: use parentVariantId only if it points to a HIGHER hierarchy level
          const parentId = pickVariant.parentVariantId;
          const parentVar = parentId ? variantMap.get(parentId) : null;
          if (parentVar && parentVar.hierarchyLevel > pickLoc.hierarchyLevel) {
            matchedDefault = tierDefault;
            sourceVariant = parentVar;
            break;
          }
        }

        if (!matchedDefault || !sourceVariant) continue;

        // Resolve effective settings (SKU override > tier default)
        const effectiveTriggerValue = override?.triggerValue ?? matchedDefault.triggerValue;
        const effectiveMaxQty = override?.maxQty ?? matchedDefault.maxQty;
        const effectiveSourcePriority = override?.sourcePriority ?? matchedDefault.sourcePriority;
        const effectiveReplenMethod = override?.replenMethod ?? matchedDefault.replenMethod;
        const effectivePriority = override?.priority ?? matchedDefault.priority;
        const effectiveSourceLocationType = override?.sourceLocationType ?? matchedDefault.sourceLocationType;

        // Threshold check
        if (pickLoc.currentQty > effectiveTriggerValue) continue;

        // Get destination location for warehouse context
        const destLocation = locationMap.get(pickLoc.locationId);
        const locWarehouseId = destLocation?.warehouseId ?? null;

        // Resolve unified execution decision (for blocked tasks, use qty=0)
        const whSettings = getLocationSettings(destLocation ?? {} as any);
        const { executionMode } = this.resolveAutoExecute(
          override?.autoReplen ?? null,
          matchedDefault.autoReplen ?? null,
          whSettings as WarehouseSettings,
          0,
        );

        // Find source locations with the source variant
        const sourceKey = `${sourceVariant.id}-${effectiveSourceLocationType}`;
        let sourceLocations = inventoryByVariantAndType.get(sourceKey) || [];

        if (sourceLocations.length === 0) {
          // Blocked: no source stock available
          const [blockedTask] = await this.db.insert(replenTasks).values({
            replenRuleId: override?.id ?? null,
            fromLocationId: pickLoc.locationId,
            toLocationId: pickLoc.locationId,
            productId: pickProductId ?? null,
            sourceProductVariantId: sourceVariant.id,
            pickProductVariantId: pickLoc.variantId,
            qtySourceUnits: 0,
            qtyTargetUnits: 0,
            qtyCompleted: 0,
            status: "blocked",
            priority: effectivePriority,
            triggeredBy: "min_max",
            executionMode,
            replenMethod: effectiveReplenMethod,
            autoReplen: override?.autoReplen ?? matchedDefault.autoReplen ?? 0,
            warehouseId: locWarehouseId,
            notes: `Blocked: no ${effectiveSourceLocationType} stock for ${sourceVariant.sku || sourceVariant.name}`,
          } satisfies InsertReplenTask).returning();
          skipped.push({
            product: product.sku || product.name,
            reason: "no_source_stock",
            sourceVariant: sourceVariant.sku || sourceVariant.name,
            sourceLocationType: effectiveSourceLocationType,
            tierDefaultId: matchedDefault.id,
            blockedTaskId: blockedTask.id,
          });
          continue;
        }

        // Sort source locations by priority
        if (effectiveSourcePriority === "smallest_first") {
          sourceLocations = [...sourceLocations].sort((a, b) => a.qty - b.qty);
        } else {
          sourceLocations = [...sourceLocations].sort((a, b) => {
            const aTime = a.updatedAt?.getTime() || 0;
            const bTime = b.updatedAt?.getTime() || 0;
            return aTime - bTime;
          });
        }

        const unitsPerSource = sourceVariant.unitsPerVariant || 1;

        // Find best source with available stock (needed for both new tasks and unblocking)
        // IMPORTANT: exclude the destination (pick) location — never replen from/to same bin
        let selectedSource: { locationId: number; availableQty: number } | null = null;
        for (const src of sourceLocations) {
          if (src.qty > 0 && src.locationId !== pickLoc.locationId) {
            selectedSource = { locationId: src.locationId, availableQty: src.qty };
            break;
          }
        }

        // Check for existing pending task (dedup)
        const [existingTask] = await this.db.select().from(replenTasks)
          .where(and(
            eq(replenTasks.toLocationId, pickLoc.locationId),
            eq(replenTasks.pickProductVariantId, pickLoc.variantId),
            inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"]),
          )).limit(1);

        if (existingTask) {
          if (existingTask.status === "blocked" && selectedSource) {
            const qtyNeeded = (effectiveMaxQty ?? effectiveTriggerValue * 2) - pickLoc.currentQty;
            const qtySource = Math.max(1, Math.ceil(qtyNeeded / unitsPerSource));
            const qtyTarget = qtySource * unitsPerSource;
            const wh = getLocationSettings(destLocation ?? {} as any);
            const { shouldAutoExecute, executionMode } = this.resolveAutoExecute(
              override?.autoReplen ?? null,
              matchedDefault.autoReplen ?? null,
              wh as WarehouseSettings,
              qtyTarget,
            );
            await this.db.update(replenTasks).set({
              fromLocationId: selectedSource.locationId,
              qtySourceUnits: qtySource,
              qtyTargetUnits: qtyTarget,
              status: "pending",
              executionMode,
              notes: `${existingTask.notes || ""}\nUnblocked: source stock now available`,
            }).where(eq(replenTasks.id, existingTask.id));
            tasksCreated.push({
              id: existingTask.id,
              action: "unblocked",
              product: product.sku || product.name,
              from: selectedSource.locationId,
              to: pickLoc.locationId,
            });
            if (shouldAutoExecute) {
              try {
                await this.executeTask(existingTask.id, "system:auto-replen");
              } catch (autoErr: any) {
                console.warn(`[Replen] Auto-execute unblocked task ${existingTask.id} failed:`, autoErr?.message);
              }
            }
          } else {
            skipped.push({
              pickLocation: destLocation?.code,
              product: product.sku || product.name,
              reason: "pending_task_exists",
              currentQty: pickLoc.currentQty,
              triggerValue: effectiveTriggerValue,
            });
          }
          continue;
        }

        if (!selectedSource) {
          // All source locations empty
          const [blockedTask] = await this.db.insert(replenTasks).values({
            replenRuleId: override?.id ?? null,
            fromLocationId: pickLoc.locationId,
            toLocationId: pickLoc.locationId,
            productId: pickProductId ?? null,
            sourceProductVariantId: sourceVariant.id,
            pickProductVariantId: pickLoc.variantId,
            qtySourceUnits: 0,
            qtyTargetUnits: 0,
            qtyCompleted: 0,
            status: "blocked",
            priority: effectivePriority,
            triggeredBy: "min_max",
            executionMode,
            replenMethod: effectiveReplenMethod,
            autoReplen: override?.autoReplen ?? matchedDefault.autoReplen ?? 0,
            warehouseId: locWarehouseId,
            notes: `Blocked: source locations found but all empty (${effectiveSourceLocationType})`,
          } satisfies InsertReplenTask).returning();
          skipped.push({
            pickLocation: destLocation?.code,
            product: product.sku || product.name,
            reason: "no_source_available",
            currentQty: pickLoc.currentQty,
            blockedTaskId: blockedTask.id,
          });
          continue;
        }

        // Calculate qty to replen
        let qtySourceUnits: number;
        let qtyTargetUnits: number;

        if (effectiveMaxQty === null) {
          qtySourceUnits = 1;
          qtyTargetUnits = unitsPerSource;
        } else {
          const qtyNeeded = Math.max(0, effectiveMaxQty - pickLoc.currentQty);
          if (qtyNeeded <= 0) continue;
          qtySourceUnits = Math.ceil(qtyNeeded / unitsPerSource);
          qtyTargetUnits = qtySourceUnits * unitsPerSource;
        }

        // Cap at source available
        if (qtySourceUnits > selectedSource.availableQty) {
          qtySourceUnits = selectedSource.availableQty;
          qtyTargetUnits = qtySourceUnits * unitsPerSource;
        }
        if (qtySourceUnits <= 0) continue;

        // Check destination cube capacity
        let capacityNote = "";
        let overflowQtyTargetUnits = 0;
        let overflowQtySourceUnits = 0;
        const isFullCaseMethod = effectiveReplenMethod === "full_case" || effectiveReplenMethod === "pallet_drop";

        if (destLocation && pickVariant) {
          const capacity = calculateRemainingCapacity(
            destLocation as any,
            pickVariant as any,
            allLevels,
            variantMap,
          );

          if (capacity !== null) {
            if (capacity.maxUnits <= 0) {
              overflowQtyTargetUnits = qtyTargetUnits;
              overflowQtySourceUnits = qtySourceUnits;
              qtyTargetUnits = 0;
              qtySourceUnits = 0;
              capacityNote = "Destination full, routed to overflow";
            } else if (capacity.maxUnits < qtyTargetUnits) {
              if (isFullCaseMethod) {
                overflowQtyTargetUnits = qtyTargetUnits;
                overflowQtySourceUnits = qtySourceUnits;
                qtyTargetUnits = 0;
                qtySourceUnits = 0;
                capacityNote = `${effectiveReplenMethod}: full unit doesn't fit, routed to overflow`;
              } else {
                overflowQtyTargetUnits = qtyTargetUnits - capacity.maxUnits;
                overflowQtySourceUnits = Math.ceil(overflowQtyTargetUnits / unitsPerSource);
                qtyTargetUnits = capacity.maxUnits;
                qtySourceUnits = Math.ceil(qtyTargetUnits / unitsPerSource);
                capacityNote = `Split due to capacity: ${qtyTargetUnits} to bin, ${overflowQtyTargetUnits} to overflow`;
              }
            }
          }
        }

        // Handle overflow bin
        let actualOverflowQty = 0;
        let actualOverflowSourceUnits = 0;
        let overflowBinId: number | null = null;

        if (overflowQtyTargetUnits > 0) {
          const minUnitsRequired = isFullCaseMethod ? overflowQtyTargetUnits : undefined;
          const overflowBin = findOverflowBin(
            locWarehouseId,
            pickVariant! as any,
            overflowQtyTargetUnits,
            allLevels,
            variantMap,
            allLocations as any,
            minUnitsRequired,
          );

          if (overflowBin) {
            if (isFullCaseMethod) {
              actualOverflowQty = overflowQtyTargetUnits;
              actualOverflowSourceUnits = overflowQtySourceUnits;
              overflowBinId = overflowBin.locationId;
            } else {
              actualOverflowQty = Math.min(overflowQtyTargetUnits, overflowBin.maxUnits);
              actualOverflowSourceUnits = Math.ceil(actualOverflowQty / unitsPerSource);
              overflowBinId = overflowBin.locationId;
              if (actualOverflowQty < overflowQtyTargetUnits) {
                skipped.push({
                  tierDefaultId: matchedDefault.id,
                  pickLocation: destLocation?.code,
                  product: product.sku || product.name,
                  reason: "overflow_capacity_partial",
                  overflowQty: actualOverflowQty,
                  excessQty: overflowQtyTargetUnits - actualOverflowQty,
                });
              }
            }
          } else {
            skipped.push({
              tierDefaultId: matchedDefault.id,
              pickLocation: destLocation?.code,
              product: product.sku || product.name,
              reason: isFullCaseMethod ? "no_overflow_for_full_unit" : "no_overflow_capacity",
              overflowQty: overflowQtyTargetUnits,
              replenMethod: effectiveReplenMethod,
            });
          }
        }

        // Validate total source usage with actual overflow
        let totalSourceUsed = qtySourceUnits + actualOverflowSourceUnits;
        if (totalSourceUsed > selectedSource.availableQty) {
          const excess = totalSourceUsed - selectedSource.availableQty;
          if (actualOverflowSourceUnits >= excess) {
            actualOverflowSourceUnits -= excess;
            actualOverflowQty = actualOverflowSourceUnits * unitsPerSource;
          } else {
            const remainingExcess = excess - actualOverflowSourceUnits;
            actualOverflowSourceUnits = 0;
            actualOverflowQty = 0;
            overflowBinId = null;
            qtySourceUnits = Math.max(0, qtySourceUnits - remainingExcess);
            qtyTargetUnits = qtySourceUnits * unitsPerSource;
          }
        }

        // Create main task if any units fit
        if (qtySourceUnits > 0 && qtyTargetUnits > 0) {
          // Re-resolve with actual qtyTargetUnits (matters for hybrid mode)
          const execDecision = this.resolveAutoExecute(
            override?.autoReplen ?? null,
            matchedDefault.autoReplen ?? null,
            whSettings as WarehouseSettings,
            qtyTargetUnits,
          );

          const [task] = await this.db.insert(replenTasks).values({
            replenRuleId: override?.id ?? null,
            fromLocationId: selectedSource.locationId,
            toLocationId: pickLoc.locationId,
            productId: pickProductId ?? null,
            sourceProductVariantId: sourceVariant.id,
            pickProductVariantId: pickLoc.variantId,
            qtySourceUnits,
            qtyTargetUnits,
            qtyCompleted: 0,
            status: "pending",
            priority: effectivePriority,
            triggeredBy: "min_max",
            executionMode: execDecision.executionMode,
            replenMethod: effectiveReplenMethod,
            autoReplen: override?.autoReplen ?? matchedDefault.autoReplen ?? 0,
            warehouseId: locWarehouseId,
            notes: capacityNote || `Auto-generated: current qty ${pickLoc.currentQty} <= trigger ${effectiveTriggerValue}`,
          } satisfies InsertReplenTask).returning();

          // Unified auto-execute
          let autoCompleted = false;
          if (execDecision.shouldAutoExecute) {
            try {
              await this.executeTask(task.id, "system:auto-replen");
              autoCompleted = true;
            } catch (autoErr: any) {
              console.warn(`[Replen] Auto-replen failed for task ${task.id}:`, autoErr?.message);
              await this.db.update(replenTasks).set({
                status: "blocked",
                notes: `Auto-replen failed: ${autoErr?.message || "unknown error"}`,
              }).where(eq(replenTasks.id, task.id));
            }
          }

          tasksCreated.push({
            taskId: task.id,
            tierDefaultId: matchedDefault.id,
            overrideId: override?.id,
            pickLocation: destLocation?.code,
            sourceLocation: locationMap.get(selectedSource.locationId)?.code,
            product: product.sku || product.name,
            currentQty: pickLoc.currentQty,
            triggerValue: effectiveTriggerValue,
            qtySourceUnits,
            qtyTargetUnits,
            executionMode: execDecision.executionMode,
            warehouseId: locWarehouseId,
            autoReplen: execDecision.shouldAutoExecute,
            autoCompleted,
          });
        }

        // Create overflow task if needed
        if (actualOverflowQty > 0 && overflowBinId) {
          const overflowExec = this.resolveAutoExecute(
            null, null, // overflow tasks don't inherit SKU/tier autoReplen
            whSettings as WarehouseSettings,
            actualOverflowQty,
          );

          const [overflowTask] = await this.db.insert(replenTasks).values({
            replenRuleId: override?.id ?? null,
            fromLocationId: selectedSource.locationId,
            toLocationId: overflowBinId,
            productId: pickProductId ?? null,
            sourceProductVariantId: sourceVariant.id,
            pickProductVariantId: pickLoc.variantId,
            qtySourceUnits: actualOverflowSourceUnits,
            qtyTargetUnits: actualOverflowQty,
            qtyCompleted: 0,
            status: "pending",
            priority: effectivePriority + 1,
            triggeredBy: "min_max",
            executionMode: overflowExec.executionMode,
            replenMethod: effectiveReplenMethod,
            autoReplen: 0, // Overflow tasks always go to worker queue
            warehouseId: locWarehouseId,
            notes: `Overflow from ${destLocation?.code}: capacity exceeded`,
          } satisfies InsertReplenTask).returning();

          tasksCreated.push({
            taskId: overflowTask.id,
            tierDefaultId: matchedDefault.id,
            overrideId: override?.id,
            pickLocation: locationMap.get(overflowBinId)?.code,
            sourceLocation: locationMap.get(selectedSource.locationId)?.code,
            product: product.sku || product.name,
            currentQty: 0,
            triggerValue: 0,
            qtySourceUnits: actualOverflowSourceUnits,
            qtyTargetUnits: actualOverflowQty,
            isOverflow: true,
            executionMode: overflowExec.executionMode,
            warehouseId: locWarehouseId,
          });
        }
      }
    }

    return {
      success: true,
      tierDefaultsEvaluated: allTierDefaults.length,
      productsScanned: pickLocationsNeedingReplen.size,
      tasksCreated: tasksCreated.length,
      skipped: skipped.length,
      details: { tasksCreated, skipped },
    };
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

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Build an index of variant+locationType -> list of {locationId, qty, updatedAt}
   * for all inventory levels with positive stock. Used by generateTasks for
   * efficient source location lookup.
   */
  private buildInventoryIndex(
    levels: InventoryLevel[],
    locationMap: Map<number, WarehouseLocation>,
  ): Map<string, Array<{ locationId: number; qty: number; updatedAt: Date | null }>> {
    const index = new Map<string, Array<{ locationId: number; qty: number; updatedAt: Date | null }>>();
    for (const level of levels) {
      const qty = level.variantQty || 0;
      if (qty <= 0) continue;
      const location = locationMap.get(level.warehouseLocationId);
      if (!location) continue;
      const key = `${level.productVariantId}-${location.locationType}`;
      const arr = index.get(key) || [];
      arr.push({ locationId: level.warehouseLocationId, qty, updatedAt: level.updatedAt });
      index.set(key, arr);
    }
    return index;
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
   * Find the tier default that applies for a given hierarchy level and
   * warehouse. Warehouse-specific defaults take precedence over global
   * (warehouseId=null) defaults.
   */
  private findTierDefault(
    defaults: ReplenTierDefault[],
    hierarchyLevel: number,
    warehouseId?: number,
  ): ReplenTierDefault | null {
    // Prefer warehouse-specific, fall back to global (null warehouseId)
    const warehouseSpecific = defaults.find(
      (d) =>
        d.hierarchyLevel === hierarchyLevel &&
        d.warehouseId != null &&
        d.warehouseId === warehouseId,
    );
    if (warehouseSpecific) return warehouseSpecific;

    const global = defaults.find(
      (d) => d.hierarchyLevel === hierarchyLevel && d.warehouseId == null,
    );
    return global ?? null;
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
    rule: any;
    tierDefault: ReplenTierDefault | null;
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
      opts.pickLocationId, // never source from the pick bin itself
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
        productId: opts.rule?.productId ?? null,
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
    // Qty for the downstream task: 1 intermediate unit → N pick units
    const downstreamQtySource = 1;
    const downstreamQtyTarget = intermediateVariant.unitsPerVariant;
    const downstreamReplenMethod = opts.tierDefault?.replenMethod ?? "case_break";

    const downstreamExec = this.resolveAutoExecute(
      opts.rule?.autoReplen ?? null,
      opts.tierDefault?.autoReplen ?? null,
      opts.whSettings,
      downstreamQtyTarget,
    );

    const [downstreamTask] = await this.db
      .insert(replenTasks)
      .values({
        replenRuleId: opts.rule?.id ?? null,
        fromLocationId: cascadeSourceLocation.id, // boxes will appear here after Task A
        toLocationId: opts.pickLocationId,
        productId: opts.rule?.productId ?? null,
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
   *                              (used by batch checkThresholds to avoid N+1 queries)
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
    excludeLocationId?: number | null,
  ): Promise<WarehouseLocation | null> {
    // --- 1. Try dedicated parent location first (but never the destination itself) ---
    if (parentLocationId && parentLocationId !== excludeLocationId) {
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

    // --- 2. Fallback: general search (FIFO), excluding destination location ---
    const levelsWithStock: Array<InventoryLevel & { location?: WarehouseLocation }> =
      await this.db
        .select({
          level: inventoryLevels,
          location: warehouseLocations,
        })
        .from(inventoryLevels)
        .innerJoin(
          warehouseLocations,
          eq(inventoryLevels.warehouseLocationId, warehouseLocations.id),
        )
        .where(
          and(
            eq(inventoryLevels.productVariantId, productVariantId),
            eq(warehouseLocations.locationType, sourceLocationType),
            sql`${inventoryLevels.variantQty} > 0`,
            ...(warehouseId != null
              ? [eq(warehouseLocations.warehouseId, warehouseId)]
              : []),
            ...(excludeLocationId != null
              ? [sql`${warehouseLocations.id} != ${excludeLocationId}`]
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
 * await replen.checkThresholds();
 * ```
 */
export function createReplenishmentService(db: any, inventoryCore: any) {
  return new ReplenishmentService(db, inventoryCore);
}
