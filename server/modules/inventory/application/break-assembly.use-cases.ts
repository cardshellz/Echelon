import { lockInventoryCostGraph } from "../infrastructure/cost-evidence.repository";
import { createHash } from "node:crypto";
import { z } from "zod";
import { openOperationalQuantityPosting, type OperationalQuantityPosting } from "../infrastructure/operational-quantity-posting";
import type { db } from "../../../db";
import { InventoryUseCases } from "./inventory.use-cases";
import { eq, and, sql } from "drizzle-orm";
import {
  products,
  productVariants,
  inventoryLevels,
  productLocations,
  warehouseLocations,
  type ProductVariant,
  type InventoryLevel,
} from "@shared/schema";
import {
  allowsDirectPackageConversion,
  type ProductInventoryStrategy,
} from "@shared/catalog/inventory-strategy";

type PackageConversionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class InventoryConversionStrategyError extends Error {
  readonly code = "DIRECT_CONVERSION_NOT_ALLOWED";

  constructor(
    readonly productId: number,
    readonly inventoryStrategy: ProductInventoryStrategy,
  ) {
    super(
      inventoryStrategy === "recipe_managed"
        ? "This product is build managed. Use a versioned recipe and build order instead of direct break/assemble."
        : "This product tracks each variant physically and does not allow inventory conversion.",
    );
    this.name = "InventoryConversionStrategyError";
  }
}

// ============================================================================
// Interfaces
// ============================================================================

export interface BreakResult {
  sourceQtyRemoved: number;
  targetQtyAdded: number;
  baseUnitsConverted: number;
  batchId: string;
}

export interface AssembleResult {
  sourceQtyRemoved: number;
  targetQtyAdded: number;
  baseUnitsConverted: number;
  batchId: string;
}

export interface ConversionPreview {
  sourceVariantSku: string;
  targetVariantSku: string;
  sourceQtyToRemove: number;
  targetQtyToAdd: number;
  baseUnitsInvolved: number;
  isValid: boolean;
  validationError?: string;
}

interface BreakableVariantInfo {
  variant: ProductVariant;
  currentQty: number;
  canBreakInto: Array<{
    targetVariant: ProductVariant;
    resultQty: number;
  }>;
}

// ============================================================================
// BreakAssemblyService
// ============================================================================

/**
 * Handles UOM conversion in the warehouse: breaking cases into packs, or
 * assembling packs into cases.
 *
 * Every operation runs inside a single DB transaction and produces a linked
 * pair of inventory transactions sharing the same batchId.
 */
export class BreakAssemblyUseCases {
  private onChangeCallback: ((variantId: number, trigger: string) => void) | null = null;

  constructor(
    private db: any,
    private inventoryUseCases: InventoryUseCases,
    private readonly clock: () => Date = () => new Date(),
  ) { }

  /** Register a callback to fire after break/assembly changes inventory */
  onInventoryChange(cb: (variantId: number, trigger: string) => void): void {
    this.onChangeCallback = cb;
  }

  private notifyChange(variantId: number, trigger: string): void {
    if (this.onChangeCallback) {
      try {
        this.onChangeCallback(variantId, trigger);
      } catch (err: any) {
        console.warn(`[BreakAssembly] onChange callback error: ${err.message}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Break `sourceQty` units of sourceVariant into equivalent targetVariant units.
   *
   * Example: break 1 case (unitsPerVariant=100) into 100 packs (unitsPerVariant=1)
   *   sourceQtyRemoved = 1
   *   targetQtyAdded   = 100
   *   baseUnitsConverted = 100
   */
  async breakVariant(params: {
    commandKey?: string;
    sourceVariantId: number;
    targetVariantId: number;
    warehouseLocationId: number;    // source (case) location
    targetLocationId?: number;      // destination pick bin — auto-resolved from bin assignment if omitted
    sourceQty: number;
    userId?: string;
    notes?: string;
  }): Promise<BreakResult> {
    return this.runConversion("break", params, async (tx, quantityPosting, effects) => {
      const { sourceVariantId, targetVariantId, warehouseLocationId, sourceQty, userId, notes } = params;

      // ----- Load & validate -----
      const [sourceVariant, targetVariant] = await Promise.all([
        this.fetchVariant(sourceVariantId),
        this.fetchVariant(targetVariantId),
      ]);

      this.validateSameProduct(sourceVariant, targetVariant);
      await this.assertDirectConversionAllowed(sourceVariant.productId);

      if (sourceVariant.unitsPerVariant <= targetVariant.unitsPerVariant) {
        throw new Error(
          `Cannot break: source variant "${sourceVariant.name}" (${sourceVariant.unitsPerVariant} units) ` +
          `must have MORE units per variant than target "${targetVariant.name}" (${targetVariant.unitsPerVariant} units).`
        );
      }

      // Enforce direct parent-child: target's parentVariantId must point to source
      if (sourceVariant.parentVariantId !== targetVariant.id) {
        throw new Error(
          `Cannot break: "${sourceVariant.sku ?? sourceVariant.name}" does not break directly into ` +
          `"${targetVariant.sku ?? targetVariant.name}". Only direct parent→child breaks are allowed.`
        );
      }

      const { targetQty, baseUnits } = this.calculateConversion(
        sourceQty,
        sourceVariant.unitsPerVariant,
        targetVariant.unitsPerVariant
      );

      // Resolve destination: explicit > bin assignment > fall back to source
      let resolvedTargetLocationId: number = params.targetLocationId ?? warehouseLocationId;
      if (!params.targetLocationId) {
        const assignment = await this.db
          .select({ warehouseLocationId: productLocations.warehouseLocationId })
          .from(productLocations)
          .innerJoin(warehouseLocations, eq(productLocations.warehouseLocationId, warehouseLocations.id))
          .where(
            and(
              eq(sql`UPPER(${productLocations.sku})`, targetVariant.sku?.toUpperCase() ?? ""),
              eq(warehouseLocations.isPickable, 1)
            )
          )
          .limit(1);
        if (assignment[0]?.warehouseLocationId) {
          resolvedTargetLocationId = assignment[0].warehouseLocationId;
        }
      }

      // ----- Execute inside a transaction -----
      const batchId = this.generateBatchId("break", params.commandKey);

      await lockInventoryCostGraph(tx);
      await this.assertConversionSnapshot(tx, sourceVariant, targetVariant);

      if (quantityPosting) await this.lockConversionLevels(tx, sourceVariantId, warehouseLocationId,
        targetVariantId, resolvedTargetLocationId);

      // Validate source stock within the transaction
      const { inventoryLevels } = await import("@shared/schema");
      const inventoryTx = this.inventoryUseCases.withTx(tx);
      const [sourceLevel] = await tx.select().from(inventoryLevels)
        .where(and(eq(inventoryLevels.productVariantId, sourceVariantId), eq(inventoryLevels.warehouseLocationId, warehouseLocationId))).limit(1);
      if (!sourceLevel || sourceLevel.variantQty < sourceQty) {
        const available = sourceLevel?.variantQty ?? 0;
        throw new Error(
          `Insufficient stock: need ${sourceQty} of "${sourceVariant.sku ?? sourceVariant.name}" ` +
          `at location but only ${available} available.`
        );
      }

      const noteText = notes ?? `Break ${sourceQty} x ${sourceVariant.sku ?? sourceVariant.name} into ${targetQty} x ${targetVariant.sku ?? targetVariant.name}`;

      // Decrement source variant — captures the total cost of consumed lots
      const sourceResult = await inventoryTx.adjustInventory({
        productVariantId: sourceVariantId,
        warehouseLocationId,
        qtyDelta: -sourceQty,
        includeConsumedCostEvidence: true,
        reason: noteText,
        userId: userId ?? undefined,
        deferUntilCommit: effect => effects.push(effect),
      }, quantityPosting ?? undefined);

      if (!sourceResult.consumedLots?.length || sourceResult.consumedPoCostMills === undefined || sourceResult.consumedPackagingCostMills === undefined || sourceResult.consumedLandedCostMills === undefined) {
        throw new Error("Conversion requires exact consumed FIFO component and lot evidence");
      }

      // Increment target variant with propagated cost
      await inventoryTx.adjustInventory({
        productVariantId: targetVariantId,
        warehouseLocationId: resolvedTargetLocationId,
        qtyDelta: targetQty,
        reason: noteText,
        userId: userId ?? undefined,
        deferUntilCommit: effect => effects.push(effect),
        conversion: {
          sourceLots: sourceResult.consumedLots,
          productMills: BigInt(sourceResult.consumedPoCostMills), packagingMills: BigInt(sourceResult.consumedPackagingCostMills),
          landedMills: BigInt(sourceResult.consumedLandedCostMills), provisional: sourceResult.consumedCostProvisional ?? true,
          operationKey: batchId, occurredAt: this.clock()
        },
      }, quantityPosting ?? undefined);

      return { sourceQtyRemoved: sourceQty, targetQtyAdded: targetQty, baseUnitsConverted: baseUnits, batchId };
    });
  }

  /**
   * Assemble `targetQty` units of targetVariant FROM sourceVariant units.
   *
   * Example: assemble 1 case (unitsPerVariant=100) from 100 packs (unitsPerVariant=1)
   *   sourceQtyRemoved = 100
   *   targetQtyAdded   = 1
   *   baseUnitsConverted = 100
   */
  async assembleVariant(params: {
    commandKey?: string;
    sourceVariantId: number;
    targetVariantId: number;
    warehouseLocationId: number;
    targetQty: number;
    userId?: string;
    notes?: string;
  }): Promise<AssembleResult> {
    return this.runConversion("assemble", params, async (tx, quantityPosting, effects) => {
      const { sourceVariantId, targetVariantId, warehouseLocationId, targetQty, userId, notes } = params;

      // ----- Load & validate -----
      const [sourceVariant, targetVariant] = await Promise.all([
        this.fetchVariant(sourceVariantId),
        this.fetchVariant(targetVariantId),
      ]);

      this.validateSameProduct(sourceVariant, targetVariant);
      await this.assertDirectConversionAllowed(sourceVariant.productId);

      if (sourceVariant.unitsPerVariant >= targetVariant.unitsPerVariant) {
        throw new Error(
          `Cannot assemble: source variant "${sourceVariant.name}" (${sourceVariant.unitsPerVariant} units) ` +
          `must have FEWER units per variant than target "${targetVariant.name}" (${targetVariant.unitsPerVariant} units).`
        );
      }

      // Enforce direct parent-child: source's parentVariantId must point to target
      if (sourceVariant.parentVariantId !== targetVariant.id) {
        throw new Error(
          `Cannot assemble: "${sourceVariant.sku ?? sourceVariant.name}" is not a direct child of ` +
          `"${targetVariant.sku ?? targetVariant.name}". Only direct child→parent assembly is allowed.`
        );
      }

      // How many source units do we need to produce targetQty of the target?
      const baseUnits = targetQty * targetVariant.unitsPerVariant;
      const sourceQtyNeeded = baseUnits / sourceVariant.unitsPerVariant;

      if (!Number.isInteger(sourceQtyNeeded)) {
        throw new Error(
          `Conversion produces fractional source quantity (${sourceQtyNeeded}). ` +
          `${targetQty} x ${targetVariant.sku ?? targetVariant.name} (${targetVariant.unitsPerVariant} ea) ` +
          `requires ${baseUnits} base units, which is not evenly divisible by ` +
          `${sourceVariant.sku ?? sourceVariant.name}'s ${sourceVariant.unitsPerVariant} units per variant.`
        );
      }

      // ----- Execute inside a transaction -----
      const batchId = this.generateBatchId("assemble", params.commandKey);

      await lockInventoryCostGraph(tx);
      await this.assertConversionSnapshot(tx, sourceVariant, targetVariant);

      if (quantityPosting) await this.lockConversionLevels(tx, sourceVariantId, warehouseLocationId,
        targetVariantId, warehouseLocationId);

      const { inventoryLevels } = await import("@shared/schema");
      const inventoryTx = this.inventoryUseCases.withTx(tx);
      const [sourceLevel] = await tx.select().from(inventoryLevels)
        .where(and(eq(inventoryLevels.productVariantId, sourceVariantId), eq(inventoryLevels.warehouseLocationId, warehouseLocationId))).limit(1);
      if (!sourceLevel || sourceLevel.variantQty < sourceQtyNeeded) {
        const available = sourceLevel?.variantQty ?? 0;
        throw new Error(
          `Insufficient stock: need ${sourceQtyNeeded} of "${sourceVariant.sku ?? sourceVariant.name}" ` +
          `at location but only ${available} available.`
        );
      }

      const noteText = notes ?? `Assemble ${targetQty} x ${targetVariant.sku ?? targetVariant.name} from ${sourceQtyNeeded} x ${sourceVariant.sku ?? sourceVariant.name}`;

      // Decrement source variant — captures the total cost of consumed lots
      const sourceResult = await inventoryTx.adjustInventory({
        productVariantId: sourceVariantId,
        warehouseLocationId,
        qtyDelta: -sourceQtyNeeded,
        includeConsumedCostEvidence: true,
        reason: noteText,
        userId: userId ?? undefined,
        deferUntilCommit: effect => effects.push(effect),
      }, quantityPosting ?? undefined);

      if (!sourceResult.consumedLots?.length || sourceResult.consumedPoCostMills === undefined || sourceResult.consumedPackagingCostMills === undefined || sourceResult.consumedLandedCostMills === undefined) {
        throw new Error("Conversion requires exact consumed FIFO component and lot evidence");
      }

      // Increment target variant with propagated cost
      await inventoryTx.adjustInventory({
        productVariantId: targetVariantId,
        warehouseLocationId,
        qtyDelta: targetQty,
        reason: noteText,
        userId: userId ?? undefined,
        deferUntilCommit: effect => effects.push(effect),
        conversion: {
          sourceLots: sourceResult.consumedLots,
          productMills: BigInt(sourceResult.consumedPoCostMills), packagingMills: BigInt(sourceResult.consumedPackagingCostMills),
          landedMills: BigInt(sourceResult.consumedLandedCostMills), provisional: sourceResult.consumedCostProvisional ?? true,
          operationKey: batchId, occurredAt: this.clock()
        },
      }, quantityPosting ?? undefined);

      return {
        sourceQtyRemoved: sourceQtyNeeded,
        targetQtyAdded: targetQty,
        baseUnitsConverted: baseUnits,
        batchId,
      };
    });
  }

  /**
   * Preview what a break or assemble operation would produce, without executing it.
   */
  async getConversionPreview(params: {
    sourceVariantId: number;
    targetVariantId: number;
    qty: number;
    direction: "break" | "assemble";
  }): Promise<ConversionPreview> {
    const { sourceVariantId, targetVariantId, qty, direction } = params;

    let sourceVariant: ProductVariant;
    let targetVariant: ProductVariant;

    try {
      [sourceVariant, targetVariant] = await Promise.all([
        this.fetchVariant(sourceVariantId),
        this.fetchVariant(targetVariantId),
      ]);
    } catch (err: any) {
      return {
        sourceVariantSku: "",
        targetVariantSku: "",
        sourceQtyToRemove: 0,
        targetQtyToAdd: 0,
        baseUnitsInvolved: 0,
        isValid: false,
        validationError: err.message,
      };
    }

    try {
      this.validateSameProduct(sourceVariant, targetVariant);
      await this.assertDirectConversionAllowed(sourceVariant.productId);
    } catch (err: any) {
      return {
        sourceVariantSku: sourceVariant.sku ?? sourceVariant.name,
        targetVariantSku: targetVariant.sku ?? targetVariant.name,
        sourceQtyToRemove: 0,
        targetQtyToAdd: 0,
        baseUnitsInvolved: 0,
        isValid: false,
        validationError: err.message,
      };
    }

    const baseSku = (v: ProductVariant) => v.sku ?? v.name;

    if (direction === "break") {
      if (sourceVariant.unitsPerVariant <= targetVariant.unitsPerVariant) {
        return {
          sourceVariantSku: baseSku(sourceVariant),
          targetVariantSku: baseSku(targetVariant),
          sourceQtyToRemove: 0,
          targetQtyToAdd: 0,
          baseUnitsInvolved: 0,
          isValid: false,
          validationError: `Source (${sourceVariant.unitsPerVariant} units) must have more units per variant than target (${targetVariant.unitsPerVariant} units) for a break operation.`,
        };
      }

      // Enforce direct parent-child relationship
      if (targetVariant.parentVariantId !== sourceVariant.id) {
        return {
          sourceVariantSku: baseSku(sourceVariant),
          targetVariantSku: baseSku(targetVariant),
          sourceQtyToRemove: 0,
          targetQtyToAdd: 0,
          baseUnitsInvolved: 0,
          isValid: false,
          validationError: `"${baseSku(targetVariant)}" is not a direct child of "${baseSku(sourceVariant)}". Only direct parent→child breaks are allowed.`,
        };
      }

      const baseUnits = qty * sourceVariant.unitsPerVariant;
      const targetQty = baseUnits / targetVariant.unitsPerVariant;

      if (!Number.isInteger(targetQty)) {
        return {
          sourceVariantSku: baseSku(sourceVariant),
          targetVariantSku: baseSku(targetVariant),
          sourceQtyToRemove: qty,
          targetQtyToAdd: 0,
          baseUnitsInvolved: baseUnits,
          isValid: false,
          validationError: `Conversion produces fractional target quantity (${targetQty}). The base units (${baseUnits}) are not evenly divisible by target's units per variant (${targetVariant.unitsPerVariant}).`,
        };
      }

      return {
        sourceVariantSku: baseSku(sourceVariant),
        targetVariantSku: baseSku(targetVariant),
        sourceQtyToRemove: qty,
        targetQtyToAdd: targetQty,
        baseUnitsInvolved: baseUnits,
        isValid: true,
      };
    } else {
      // assemble: qty is the target quantity we want to produce
      if (sourceVariant.unitsPerVariant >= targetVariant.unitsPerVariant) {
        return {
          sourceVariantSku: baseSku(sourceVariant),
          targetVariantSku: baseSku(targetVariant),
          sourceQtyToRemove: 0,
          targetQtyToAdd: 0,
          baseUnitsInvolved: 0,
          isValid: false,
          validationError: `Source (${sourceVariant.unitsPerVariant} units) must have fewer units per variant than target (${targetVariant.unitsPerVariant} units) for an assemble operation.`,
        };
      }

      // Enforce direct parent-child relationship
      if (sourceVariant.parentVariantId !== targetVariant.id) {
        return {
          sourceVariantSku: baseSku(sourceVariant),
          targetVariantSku: baseSku(targetVariant),
          sourceQtyToRemove: 0,
          targetQtyToAdd: 0,
          baseUnitsInvolved: 0,
          isValid: false,
          validationError: `"${baseSku(sourceVariant)}" is not a direct child of "${baseSku(targetVariant)}". Only direct child→parent assembly is allowed.`,
        };
      }

      const baseUnits = qty * targetVariant.unitsPerVariant;
      const sourceQtyNeeded = baseUnits / sourceVariant.unitsPerVariant;

      if (!Number.isInteger(sourceQtyNeeded)) {
        return {
          sourceVariantSku: baseSku(sourceVariant),
          targetVariantSku: baseSku(targetVariant),
          sourceQtyToRemove: 0,
          targetQtyToAdd: qty,
          baseUnitsInvolved: baseUnits,
          isValid: false,
          validationError: `Conversion requires fractional source quantity (${sourceQtyNeeded}). The base units (${baseUnits}) are not evenly divisible by source's units per variant (${sourceVariant.unitsPerVariant}).`,
        };
      }

      return {
        sourceVariantSku: baseSku(sourceVariant),
        targetVariantSku: baseSku(targetVariant),
        sourceQtyToRemove: sourceQtyNeeded,
        targetQtyToAdd: qty,
        baseUnitsInvolved: baseUnits,
        isValid: true,
      };
    }
  }

  /**
   * For a given product at a warehouse location, list every variant that has
   * stock and show what it could be broken into (only larger -> smaller).
   */
  async getBreakableVariants(
    productId: number,
    warehouseLocationId: number
  ): Promise<BreakableVariantInfo[]> {
    try {
      await this.assertDirectConversionAllowed(productId);
    } catch (error) {
      if (error instanceof InventoryConversionStrategyError) return [];
      throw error;
    }
    // Get all variants for this product
    const allVariants: ProductVariant[] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.productId, productId));

    // Get inventory levels at this location for all variants
    const levels: InventoryLevel[] = await this.db
      .select()
      .from(inventoryLevels)
      .where(eq(inventoryLevels.warehouseLocationId, warehouseLocationId));

    const levelMap = new Map<number, InventoryLevel>();
    for (const level of levels) {
      levelMap.set(level.productVariantId, level);
    }

    const results: BreakableVariantInfo[] = [];

    for (const variant of allVariants) {
      const level = levelMap.get(variant.id);
      const currentQty = level?.variantQty ?? 0;

      // Only include variants that have stock
      if (currentQty <= 0) continue;

      // Find direct children this can break into (parentVariantId must point to this variant)
      const canBreakInto: BreakableVariantInfo["canBreakInto"] = [];
      for (const target of allVariants) {
        if (target.id === variant.id) continue;
        if (target.parentVariantId !== variant.id) continue;

        const ratio = variant.unitsPerVariant / target.unitsPerVariant;
        if (!Number.isInteger(ratio) || ratio <= 0) continue;

        canBreakInto.push({
          targetVariant: target,
          resultQty: currentQty * ratio,
        });
      }

      // Only include if there are valid break targets
      if (canBreakInto.length > 0) {
        results.push({ variant, currentQty, canBreakInto });
      }
    }

    // Sort by hierarchy level descending (largest packs first)
    results.sort((a, b) => b.variant.unitsPerVariant - a.variant.unitsPerVariant);

    return results;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async runConversion(
    kind: "break" | "assemble",
    params: Record<string, unknown> & { commandKey?: string; userId?: string; notes?: string },
    execute: (tx: PackageConversionTransaction, posting: OperationalQuantityPosting | null, effects: Array<() => Promise<void>>) => Promise<BreakResult>,
  ): Promise<BreakResult> {
    const effects: Array<() => Promise<void>> = [];
    const result = await this.db.transaction(async (tx: PackageConversionTransaction) => {
      const posting = await openOperationalQuantityPosting(tx);
      const key = params.commandKey ? `package_${kind}:${params.commandKey}` : undefined;
      const replay = posting && await posting.beginOperation(key, { operation: kind, ...params });
      if (replay) return packageConversionResultSchema.parse(replay.result);
      const converted = packageConversionResultSchema.parse(await execute(tx, posting, effects));
      if (posting) {
        await posting.post({
          idempotencyKey: key!, kind: "transform", actor: params.userId ?? "system:package_conversion",
          reason: params.notes ?? `${kind} exact physical package units`, occurredAt: this.clock().toISOString(),
          reference: { type: "package_conversion", id: converted.batchId }
        });
        await posting.finishOperation({ ...converted });
      }
      return converted;
    });
    for (const effect of effects) await effect();
    return result;
  }

  private generateBatchId(prefix: string, commandKey?: string): string {
    if (commandKey) return `${prefix}_${createHash("sha256").update(`${prefix}:${commandKey}`).digest("hex").slice(0, 40)}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Acquire the complete existing cell set before either FIFO owner locks lots. */
  private async lockConversionLevels(tx: PackageConversionTransaction, sourceVariantId: number,
    sourceLocationId: number, targetVariantId: number, targetLocationId: number): Promise<void> {
    await tx.execute(sql`SELECT id FROM inventory.inventory_levels
      WHERE (product_variant_id = ${sourceVariantId} AND warehouse_location_id = ${sourceLocationId})
         OR (product_variant_id = ${targetVariantId} AND warehouse_location_id = ${targetLocationId})
      ORDER BY warehouse_location_id, product_variant_id, id FOR UPDATE`);
  }

  private async assertConversionSnapshot(tx: any, source: ProductVariant, target: ProductVariant): Promise<void> {
    const product = (await tx.select({ inventoryStrategy: products.inventoryStrategy }).from(products)
      .where(eq(products.id, source.productId)).for("share"))[0];
    if (!product) throw new Error("Conversion product no longer exists");
    if (!allowsDirectPackageConversion(product.inventoryStrategy)) throw new InventoryConversionStrategyError(source.productId, product.inventoryStrategy);
    for (const expected of [source, target].sort((left, right) => left.id - right.id)) {
      const current = (await tx.select().from(productVariants).where(eq(productVariants.id, expected.id)).for("share"))[0];
      if (!current || current.productId !== expected.productId || current.unitsPerVariant !== expected.unitsPerVariant || current.parentVariantId !== expected.parentVariantId) {
        throw new Error("Conversion unit or product changed. Refresh the conversion before posting.");
      }
    }
  }

  private async fetchVariant(variantId: number): Promise<ProductVariant> {
    const rows: ProductVariant[] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, variantId));
    if (!rows[0]) {
      throw new Error(`Product variant ${variantId} not found.`);
    }
    return rows[0];
  }

  private async assertDirectConversionAllowed(productId: number): Promise<void> {
    const rows: Array<{ inventoryStrategy: ProductInventoryStrategy }> = await this.db
      .select({ inventoryStrategy: products.inventoryStrategy })
      .from(products)
      .where(eq(products.id, productId));
    const product = rows[0];
    if (!product) {
      throw new Error(`Product ${productId} not found.`);
    }
    if (!allowsDirectPackageConversion(product.inventoryStrategy)) {
      throw new InventoryConversionStrategyError(productId, product.inventoryStrategy);
    }
  }

  private validateSameProduct(a: ProductVariant, b: ProductVariant): void {
    if (a.productId !== b.productId) {
      throw new Error(
        `Variants must belong to the same product. ` +
        `"${a.sku ?? a.name}" (product ${a.productId}) vs ` +
        `"${b.sku ?? b.name}" (product ${b.productId}).`
      );
    }
  }

  /**
   * Calculate how many target units result from converting `sourceQty` source
   * variant units, and the total base units involved.
   * Throws if the conversion produces a fractional target quantity.
   */
  private calculateConversion(
    sourceQty: number,
    sourceUnitsPerVariant: number,
    targetUnitsPerVariant: number
  ): { targetQty: number; baseUnits: number } {
    for (const value of [sourceQty, sourceUnitsPerVariant, targetUnitsPerVariant]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Conversion quantity and units must be positive safe integers");
    }
    const exactBaseUnits = BigInt(sourceQty) * BigInt(sourceUnitsPerVariant);
    if (exactBaseUnits > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Conversion exceeds the supported quantity range");
    const baseUnits = Number(exactBaseUnits);
    const targetQty = baseUnits / targetUnitsPerVariant;

    if (!Number.isInteger(targetQty)) {
      throw new Error(
        `Conversion produces fractional target quantity (${targetQty}). ` +
        `${sourceQty} source units x ${sourceUnitsPerVariant} = ${baseUnits} base units, ` +
        `which is not evenly divisible by target's ${targetUnitsPerVariant} units per variant.`
      );
    }

    return { targetQty, baseUnits };
  }

}

const packageConversionResultSchema = z.object({
  sourceQtyRemoved: z.number().int().positive().max(2_147_483_647),
  targetQtyAdded: z.number().int().positive().max(2_147_483_647),
  baseUnitsConverted: z.number().int().positive().safe(), batchId: z.string().min(1).max(50),
}).strict();

// ============================================================================
// Factory
// ============================================================================

export function createBreakAssemblyService(db: any, inventoryUseCases: any) {
  return new BreakAssemblyUseCases(db, inventoryUseCases);
}
