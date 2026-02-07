import { eq, and } from "drizzle-orm";
import {
  productVariants,
  inventoryLevels,
  inventoryTransactions,
  type ProductVariant,
  type InventoryLevel,
  type InsertInventoryTransaction,
} from "@shared/schema";

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
class BreakAssemblyService {
  constructor(
    private db: any,
    private inventoryCore: {
      adjustLevel: Function;
      getLevel: Function;
      upsertLevel: Function;
      logTransaction: Function;
    }
  ) {}

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
    sourceVariantId: number;
    targetVariantId: number;
    warehouseLocationId: number;
    sourceQty: number;
    userId?: string;
    notes?: string;
  }): Promise<BreakResult> {
    const { sourceVariantId, targetVariantId, warehouseLocationId, sourceQty, userId, notes } = params;

    // ----- Load & validate -----
    const [sourceVariant, targetVariant] = await Promise.all([
      this.fetchVariant(sourceVariantId),
      this.fetchVariant(targetVariantId),
    ]);

    this.validateSameProduct(sourceVariant, targetVariant);

    if (sourceVariant.unitsPerVariant <= targetVariant.unitsPerVariant) {
      throw new Error(
        `Cannot break: source variant "${sourceVariant.name}" (${sourceVariant.unitsPerVariant} units) ` +
        `must have MORE units per variant than target "${targetVariant.name}" (${targetVariant.unitsPerVariant} units).`
      );
    }

    const { targetQty, baseUnits } = this.calculateConversion(
      sourceQty,
      sourceVariant.unitsPerVariant,
      targetVariant.unitsPerVariant
    );

    // ----- Execute inside a transaction -----
    const batchId = this.generateBatchId("break");

    await this.db.transaction(async (tx: any) => {
      // Validate source stock within the transaction
      const sourceLevel = await this.fetchLevel(tx, sourceVariantId, warehouseLocationId);
      if (!sourceLevel || sourceLevel.variantQty < sourceQty) {
        const available = sourceLevel?.variantQty ?? 0;
        throw new Error(
          `Insufficient stock: need ${sourceQty} of "${sourceVariant.sku ?? sourceVariant.name}" ` +
          `at location but only ${available} available.`
        );
      }

      // Decrement source variant
      await this.adjustWithinTx(tx, sourceLevel.id, {
        variantQty: -sourceQty,
        onHandBase: -baseUnits,
      });

      // Increment target variant (upsert if no level row exists yet)
      const targetLevel = await this.fetchLevel(tx, targetVariantId, warehouseLocationId);
      if (targetLevel) {
        await this.adjustWithinTx(tx, targetLevel.id, {
          variantQty: targetQty,
          onHandBase: baseUnits,
        });
      } else {
        await this.insertLevel(tx, {
          productVariantId: targetVariantId,
          warehouseLocationId,
          variantQty: targetQty,
          onHandBase: baseUnits,
          reservedBase: 0,
          pickedBase: 0,
          packedBase: 0,
          backorderBase: 0,
        });
      }

      // Log both sides of the conversion
      await this.logTx(tx, {
        productVariantId: sourceVariantId,
        fromLocationId: warehouseLocationId,
        transactionType: "break",
        variantQtyDelta: -sourceQty,
        variantQtyBefore: sourceLevel.variantQty,
        variantQtyAfter: sourceLevel.variantQty - sourceQty,
        batchId,
        sourceState: "on_hand",
        targetState: "on_hand",
        notes: notes ?? `Break ${sourceQty} x ${sourceVariant.sku ?? sourceVariant.name} into ${targetQty} x ${targetVariant.sku ?? targetVariant.name}`,
        userId,
        isImplicit: 0,
      });

      const targetQtyBefore = targetLevel?.variantQty ?? 0;
      await this.logTx(tx, {
        productVariantId: targetVariantId,
        toLocationId: warehouseLocationId,
        transactionType: "break",
        variantQtyDelta: targetQty,
        variantQtyBefore: targetQtyBefore,
        variantQtyAfter: targetQtyBefore + targetQty,
        batchId,
        sourceState: "on_hand",
        targetState: "on_hand",
        notes: notes ?? `Break ${sourceQty} x ${sourceVariant.sku ?? sourceVariant.name} into ${targetQty} x ${targetVariant.sku ?? targetVariant.name}`,
        userId,
        isImplicit: 0,
      });
    });

    return { sourceQtyRemoved: sourceQty, targetQtyAdded: targetQty, baseUnitsConverted: baseUnits, batchId };
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
    sourceVariantId: number;
    targetVariantId: number;
    warehouseLocationId: number;
    targetQty: number;
    userId?: string;
    notes?: string;
  }): Promise<AssembleResult> {
    const { sourceVariantId, targetVariantId, warehouseLocationId, targetQty, userId, notes } = params;

    // ----- Load & validate -----
    const [sourceVariant, targetVariant] = await Promise.all([
      this.fetchVariant(sourceVariantId),
      this.fetchVariant(targetVariantId),
    ]);

    this.validateSameProduct(sourceVariant, targetVariant);

    if (sourceVariant.unitsPerVariant >= targetVariant.unitsPerVariant) {
      throw new Error(
        `Cannot assemble: source variant "${sourceVariant.name}" (${sourceVariant.unitsPerVariant} units) ` +
        `must have FEWER units per variant than target "${targetVariant.name}" (${targetVariant.unitsPerVariant} units).`
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
    const batchId = this.generateBatchId("assemble");

    await this.db.transaction(async (tx: any) => {
      const sourceLevel = await this.fetchLevel(tx, sourceVariantId, warehouseLocationId);
      if (!sourceLevel || sourceLevel.variantQty < sourceQtyNeeded) {
        const available = sourceLevel?.variantQty ?? 0;
        throw new Error(
          `Insufficient stock: need ${sourceQtyNeeded} of "${sourceVariant.sku ?? sourceVariant.name}" ` +
          `at location but only ${available} available.`
        );
      }

      // Decrement source
      await this.adjustWithinTx(tx, sourceLevel.id, {
        variantQty: -sourceQtyNeeded,
        onHandBase: -baseUnits,
      });

      // Increment target
      const targetLevel = await this.fetchLevel(tx, targetVariantId, warehouseLocationId);
      if (targetLevel) {
        await this.adjustWithinTx(tx, targetLevel.id, {
          variantQty: targetQty,
          onHandBase: baseUnits,
        });
      } else {
        await this.insertLevel(tx, {
          productVariantId: targetVariantId,
          warehouseLocationId,
          variantQty: targetQty,
          onHandBase: baseUnits,
          reservedBase: 0,
          pickedBase: 0,
          packedBase: 0,
          backorderBase: 0,
        });
      }

      // Log both sides
      await this.logTx(tx, {
        productVariantId: sourceVariantId,
        fromLocationId: warehouseLocationId,
        transactionType: "assemble",
        variantQtyDelta: -sourceQtyNeeded,
        variantQtyBefore: sourceLevel.variantQty,
        variantQtyAfter: sourceLevel.variantQty - sourceQtyNeeded,
        batchId,
        sourceState: "on_hand",
        targetState: "on_hand",
        notes: notes ?? `Assemble ${targetQty} x ${targetVariant.sku ?? targetVariant.name} from ${sourceQtyNeeded} x ${sourceVariant.sku ?? sourceVariant.name}`,
        userId,
        isImplicit: 0,
      });

      const targetQtyBefore = targetLevel?.variantQty ?? 0;
      await this.logTx(tx, {
        productVariantId: targetVariantId,
        toLocationId: warehouseLocationId,
        transactionType: "assemble",
        variantQtyDelta: targetQty,
        variantQtyBefore: targetQtyBefore,
        variantQtyAfter: targetQtyBefore + targetQty,
        batchId,
        sourceState: "on_hand",
        targetState: "on_hand",
        notes: notes ?? `Assemble ${targetQty} x ${targetVariant.sku ?? targetVariant.name} from ${sourceQtyNeeded} x ${sourceVariant.sku ?? sourceVariant.name}`,
        userId,
        isImplicit: 0,
      });
    });

    return {
      sourceQtyRemoved: sourceQtyNeeded,
      targetQtyAdded: targetQty,
      baseUnitsConverted: baseUnits,
      batchId,
    };
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

    const baseSku = (v: ProductVariant) => v.sku ?? v.name;

    // Validate same product
    if (sourceVariant.productId !== targetVariant.productId) {
      return {
        sourceVariantSku: baseSku(sourceVariant),
        targetVariantSku: baseSku(targetVariant),
        sourceQtyToRemove: 0,
        targetQtyToAdd: 0,
        baseUnitsInvolved: 0,
        isValid: false,
        validationError: "Source and target variants must belong to the same product.",
      };
    }

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

      // Find smaller variants this can break into
      const canBreakInto: BreakableVariantInfo["canBreakInto"] = [];
      for (const target of allVariants) {
        if (target.id === variant.id) continue;
        if (target.unitsPerVariant >= variant.unitsPerVariant) continue;

        // Check divisibility
        const ratio = variant.unitsPerVariant / target.unitsPerVariant;
        if (!Number.isInteger(ratio)) continue;

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

  private generateBatchId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    const baseUnits = sourceQty * sourceUnitsPerVariant;
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

  /**
   * Fetch an inventory level row within a transaction context.
   */
  private async fetchLevel(
    tx: any,
    productVariantId: number,
    warehouseLocationId: number
  ): Promise<InventoryLevel | null> {
    const rows: InventoryLevel[] = await tx
      .select()
      .from(inventoryLevels)
      .where(
        and(
          eq(inventoryLevels.productVariantId, productVariantId),
          eq(inventoryLevels.warehouseLocationId, warehouseLocationId)
        )
      );
    return rows[0] ?? null;
  }

  /**
   * Delta-based adjustment within a transaction context.
   * Mirrors storage.adjustInventoryLevel but operates on the tx handle.
   */
  private async adjustWithinTx(
    tx: any,
    levelId: number,
    deltas: { variantQty?: number; onHandBase?: number }
  ): Promise<void> {
    const { sql } = await import("drizzle-orm");
    const updates: Record<string, any> = { updatedAt: new Date() };

    if (deltas.variantQty !== undefined) {
      updates.variantQty = sql`${inventoryLevels.variantQty} + ${deltas.variantQty}`;
    }
    if (deltas.onHandBase !== undefined) {
      updates.onHandBase = sql`${inventoryLevels.onHandBase} + ${deltas.onHandBase}`;
    }

    await tx
      .update(inventoryLevels)
      .set(updates)
      .where(eq(inventoryLevels.id, levelId));
  }

  /**
   * Insert a new inventory level row within a transaction context.
   */
  private async insertLevel(
    tx: any,
    data: {
      productVariantId: number;
      warehouseLocationId: number;
      variantQty: number;
      onHandBase: number;
      reservedBase: number;
      pickedBase: number;
      packedBase: number;
      backorderBase: number;
    }
  ): Promise<void> {
    await tx.insert(inventoryLevels).values(data);
  }

  /**
   * Log an inventory transaction within a transaction context.
   */
  private async logTx(tx: any, data: InsertInventoryTransaction): Promise<void> {
    await tx.insert(inventoryTransactions).values(data);
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createBreakAssemblyService(db: any, inventoryCore: any) {
  return new BreakAssemblyService(db, inventoryCore);
}
