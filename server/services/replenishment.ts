import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import {
  replenRules,
  replenTasks,
  replenTierDefaults,
  inventoryLevels,
  inventoryTransactions,
  warehouseLocations,
  productVariants,
  catalogProducts,
  locationReplenConfig,
  productLocations,
} from "@shared/schema";
import type {
  ReplenTask,
  InsertReplenTask,
  ReplenRule,
  ReplenTierDefault,
  InventoryLevel,
  WarehouseLocation,
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
    // --- 1. Get all pick locations ---
    const pickLocationQuery = this.db
      .select()
      .from(warehouseLocations)
      .where(
        and(
          eq(warehouseLocations.locationType, "pick"),
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

    // --- 2. Get inventory levels at those locations ---
    const levels: InventoryLevel[] = await this.db
      .select()
      .from(inventoryLevels)
      .where(inArray(inventoryLevels.warehouseLocationId, pickLocationIds));

    // Also load product_locations to find assigned bins with no inventory level
    const assignedBins = await this.db
      .select()
      .from(productLocations)
      .where(
        and(
          eq(productLocations.locationType, "pick"),
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
    // Load catalog products to resolve product IDs for assigned bins
    const allCatalogProducts = await this.db.select().from(catalogProducts);
    const catalogProductMap = new Map(allCatalogProducts.map((cp: any) => [cp.id, cp]));

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
      if (!ab.warehouseLocationId || !ab.catalogProductId) continue;
      if (!pickLocationMap.has(ab.warehouseLocationId)) continue; // Not a pick location we're scanning

      const cp = catalogProductMap.get(ab.catalogProductId) as any;
      if (!cp?.productId) continue;

      // Find the pick variant (lowest hierarchy level) for this product
      const pickVariant = lowestVariantByProduct.get(cp.productId);
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
      .where(inArray(replenTasks.status, ["pending", "assigned", "in_progress"]));

    const activeTaskKeys = new Set(
      activeTasks.map((t) => `${t.pickProductVariantId}:${t.toLocationId}`),
    );

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
        ?? rule?.triggerValue ?? tierDefault?.triggerValue ?? 0;
      if (triggerValue <= 0) continue; // No threshold configured

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
        if (level.variantQty >= triggerValue) continue;

        taskNotes = `Auto-generated: onHand=${level.variantQty}, triggerValue=${triggerValue}`;
      }

      // Skip if a task already exists for this product+location
      const key = `${level.productVariantId}:${level.warehouseLocationId}`;
      if (activeTaskKeys.has(key)) continue;

      // Find a source location with stock (try dedicated parent first)
      const sourceLocation = await this.findSourceLocation(
        sourceVariantId ?? level.productVariantId,
        location.warehouseId ?? undefined,
        sourceLocationType,
        location.parentLocationId,
      );
      if (!sourceLocation) continue; // No stock to replenish from

      // Calculate target quantity (how many base units to move)
      const qtyNeeded = (maxQty ?? triggerValue * 2) - level.variantQty;
      const sourceVariant = sourceVariantId != null
        ? variantMap.get(sourceVariantId) ?? variant
        : variant;
      const qtySourceUnits = Math.max(1, Math.ceil(qtyNeeded / sourceVariant.unitsPerVariant));
      const qtyTargetUnits = qtySourceUnits * sourceVariant.unitsPerVariant;

      // Create the task
      const [task] = await this.db
        .insert(replenTasks)
        .values({
          replenRuleId: rule?.id ?? null,
          fromLocationId: sourceLocation.id,
          toLocationId: level.warehouseLocationId,
          catalogProductId: rule?.catalogProductId ?? null,
          sourceProductVariantId: sourceVariantId ?? level.productVariantId,
          pickProductVariantId: level.productVariantId,
          qtySourceUnits,
          qtyTargetUnits,
          qtyCompleted: 0,
          status: "pending",
          priority,
          triggeredBy: "min_max",
          executionMode: "queue",
          warehouseId: location.warehouseId ?? undefined,
          notes: taskNotes,
        } satisfies InsertReplenTask)
        .returning();

      // Auto-replen: immediately execute if configured (e.g., pick-to-pick)
      if (autoReplen === 1) {
        try {
          await this.executeTask(task.id, "system:auto-replen");
        } catch (autoErr: any) {
          console.warn(`[Replen] Auto-replen failed for task ${task.id}:`, autoErr?.message);
          // Task stays pending for manual handling
        }
      }

      newTasks.push(task as ReplenTask);
      activeTaskKeys.add(key); // Prevent duplicates within this run
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

    // Determine replen method from the rule (if linked)
    let replenMethod = "full_case";
    if (task.replenRuleId) {
      const [rule] = await this.db
        .select()
        .from(replenRules)
        .where(eq(replenRules.id, task.replenRuleId))
        .limit(1);
      replenMethod = rule?.replenMethod ?? "full_case";
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

    return { moved: movedBaseUnits };
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

    if (!location || location.locationType !== "pick") return null;

    // Get variant for hierarchy level
    const [variant] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, productVariantId))
      .limit(1);

    if (!variant) return null;

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
      ?? rule?.triggerValue ?? tierDefault?.triggerValue ?? 0;
    if (triggerValue <= 0) return null;

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
      // case_break / full_case: triggerValue = min units threshold
      if (level.variantQty >= triggerValue) return null;

      taskNotes = `Auto-triggered after pick: onHand=${level.variantQty}, triggerValue=${triggerValue}`;
    }

    // Check for existing active task
    const [existingTask] = await this.db
      .select()
      .from(replenTasks)
      .where(
        and(
          eq(replenTasks.pickProductVariantId, productVariantId),
          eq(replenTasks.toLocationId, warehouseLocationId),
          inArray(replenTasks.status, ["pending", "assigned", "in_progress"]),
        ),
      )
      .limit(1);

    if (existingTask) return null; // Already queued

    // Find source location with stock (try dedicated parent first)
    const sourceLocation = await this.findSourceLocation(
      sourceVariantId ?? productVariantId,
      location.warehouseId ?? undefined,
      sourceLocationType,
      location.parentLocationId,
    );
    if (!sourceLocation) return null;

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

    // Create the task
    const [task] = await this.db
      .insert(replenTasks)
      .values({
        replenRuleId: rule?.id ?? null,
        fromLocationId: sourceLocation.id,
        toLocationId: warehouseLocationId,
        catalogProductId: rule?.catalogProductId ?? null,
        sourceProductVariantId: sourceVariantId ?? productVariantId,
        pickProductVariantId: productVariantId,
        qtySourceUnits,
        qtyTargetUnits,
        qtyCompleted: 0,
        status: "pending",
        priority,
        triggeredBy: "inline_pick",
        executionMode: "queue",
        warehouseId: location.warehouseId ?? undefined,
        notes: taskNotes,
      } satisfies InsertReplenTask)
      .returning();

    // Auto-replen: immediately execute if configured (e.g., pick-to-pick)
    if (autoReplen === 1) {
      try {
        await this.executeTask(task.id, "system:auto-replen");
      } catch (autoErr: any) {
        console.warn(`[Replen] Auto-replen after pick failed for task ${task.id}:`, autoErr?.message);
        // Task stays pending for manual handling
      }
    }

    return task as ReplenTask;
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

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
   * Resolve the source variant ID from the tier default. If the tier default
   * specifies a different sourceHierarchyLevel, find the variant in the same
   * product at that hierarchy level.
   *
   * Always resolves by product_id + sourceHierarchyLevel (NOT parentVariantId).
   * parentVariantId is the packaging chain pointer (L1→L2→L3) which may point
   * to the wrong hierarchy level for replen (e.g., L1's parent is L2, but tier
   * default says source from L3).
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

    // Always resolve by product + target hierarchy level
    let siblings: ProductVariant[];
    if (productVariantsCache && pickVariant.productId) {
      siblings = productVariantsCache.get(pickVariant.productId) ?? [];
    } else {
      siblings = await this.db
        .select()
        .from(productVariants)
        .where(
          and(
            eq(productVariants.productId, pickVariant.productId),
            eq(productVariants.hierarchyLevel, tierDefault.sourceHierarchyLevel),
          ),
        );
    }

    const sourceVariant = siblings.find(
      (v) => v.hierarchyLevel === tierDefault.sourceHierarchyLevel,
    );
    return sourceVariant?.id ?? null;
  }

  /**
   * Find a source (bulk) location that has on-hand stock for the given variant.
   *
   * Resolution order (hybrid approach):
   * 1. Dedicated parent -- if the pick location has `parentLocationId` set and
   *    the parent has stock for the source variant, use it immediately.
   * 2. General search -- scan all locations of `sourceLocationType` in the
   *    same warehouse, ordered FIFO (earliest updatedAt first).
   */
  private async findSourceLocation(
    productVariantId: number,
    warehouseId: number | undefined,
    sourceLocationType: string,
    parentLocationId?: number | null,
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
          ),
        )
        .orderBy(inventoryLevels.updatedAt);

    if (levelsWithStock.length === 0) return null;

    // Return the first matching location (FIFO)
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
