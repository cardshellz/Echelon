import { eq, and, sql } from "drizzle-orm";
import {
  orders,
  orderItems,
  shipments,
  shipmentItems,
  productVariants,
  inventoryLevels,
  inventoryTransactions,
} from "@shared/schema";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ReturnResult {
  orderId: number;
  /** Total items processed */
  processed: number;
  /** Items returned in sellable condition */
  sellable: number;
  /** Items returned as damaged or defective */
  damaged: number;
  /** Total base units returned to inventory */
  totalBaseUnitsReturned: number;
  /** Per-item detail */
  items: Array<{
    orderItemId: number;
    productVariantId: number;
    qty: number;
    condition: string;
    baseUnitsReturned: number;
  }>;
}

export interface ReturnItemParams {
  orderItemId: number;
  productVariantId: number;
  qty: number;
  condition: "sellable" | "damaged" | "defective";
  reason?: string;
}

export interface ProcessReturnParams {
  orderId: number;
  items: ReturnItemParams[];
  warehouseLocationId: number;
  userId?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Returns service for the Echelon WMS.
 *
 * Handles returned inventory -- when items come back from customers they are
 * received into inventory with full audit trail.  Sellable items go back to
 * on-hand stock; damaged/defective items are quarantined via an adjustment.
 *
 * Design principles:
 * - Delegates low-level bucket mutations to `InventoryCoreService`.
 * - Individual item failures are collected -- they never block other items.
 * - Every mutation is audited via the inventory transactions ledger.
 */
class ReturnsService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly inventoryCore: any,
  ) {}

  // ---------------------------------------------------------------------------
  // PROCESS RETURN
  // ---------------------------------------------------------------------------

  /**
   * Process a batch of returned items for an order.
   *
   * For each returned item:
   *   - **Sellable**: Adds stock back to `variantQty` at the specified
   *     location via `inventoryCore.receiveInventory()` with
   *     `transactionType = "return"`.
   *   - **Damaged / Defective**: Logs the return transaction but places the
   *     units in a quarantine state by writing a `"return"` receipt followed
   *     immediately by a damage `"adjustment"` to keep them out of
   *     available-to-promise stock.
   *
   * @param params  Return processing parameters.
   * @returns Summary of what was processed.
   */
  async processReturn(params: ProcessReturnParams): Promise<ReturnResult> {
    const result: ReturnResult = {
      orderId: params.orderId,
      processed: 0,
      sellable: 0,
      damaged: 0,
      totalBaseUnitsReturned: 0,
      items: [],
    };

    for (const item of params.items) {
      try {
        // Look up variant for base unit calculation in response
        const [variant] = await this.db
          .select()
          .from(productVariants)
          .where(eq(productVariants.id, item.productVariantId))
          .limit(1);

        const unitsPerVariant = variant?.unitsPerVariant ?? 1;
        const baseUnits = item.qty * unitsPerVariant;

        if (item.condition === "sellable") {
          // ---- SELLABLE: receive back into on-hand inventory ----
          await this.inventoryCore.receiveInventory({
            productVariantId: item.productVariantId,
            warehouseLocationId: params.warehouseLocationId,
            qty: item.qty,
            referenceId: String(params.orderId),
            notes: params.notes
              ? `Return (sellable): ${params.notes}`
              : `Return (sellable) for order ${params.orderId}`,
            userId: params.userId,
          });

          // Log the return-specific transaction for traceability.
          // receiveInventory already logs a "receipt" transaction; we add
          // a separate "return" record referencing the order so return
          // history queries work correctly.
          await this.inventoryCore.logTransaction({
            productVariantId: item.productVariantId,
            toLocationId: params.warehouseLocationId,
            transactionType: "return",
            variantQtyDelta: item.qty,
            variantQtyBefore: null,
            variantQtyAfter: null,
            sourceState: "returned",
            targetState: "on_hand",
            orderId: params.orderId,
            orderItemId: item.orderItemId,
            referenceType: "order",
            referenceId: String(params.orderId),
            notes: item.reason
              ? `Sellable return: ${item.reason}`
              : "Sellable return",
            userId: params.userId ?? null,
          });

          result.sellable++;
        } else {
          // ---- DAMAGED / DEFECTIVE: receive then immediately adjust out ----

          // Step 1: Receive so we have an audit record of the physical receipt
          await this.inventoryCore.receiveInventory({
            productVariantId: item.productVariantId,
            warehouseLocationId: params.warehouseLocationId,
            qty: item.qty,
            referenceId: String(params.orderId),
            notes: `Return (${item.condition}) for order ${params.orderId}`,
            userId: params.userId,
          });

          // Step 2: Immediately adjust out as damaged -- this removes the
          // units from on-hand so they are not available for picking.
          await this.inventoryCore.adjustInventory({
            productVariantId: item.productVariantId,
            warehouseLocationId: params.warehouseLocationId,
            qtyDelta: -item.qty,
            reason: `${item.condition} return${item.reason ? `: ${item.reason}` : ""}`,
            userId: params.userId,
          });

          // Log the return-specific transaction
          await this.inventoryCore.logTransaction({
            productVariantId: item.productVariantId,
            toLocationId: params.warehouseLocationId,
            transactionType: "return",
            variantQtyDelta: item.qty,
            variantQtyBefore: null,
            variantQtyAfter: null,
            sourceState: "returned",
            targetState: item.condition, // "damaged" or "defective"
            orderId: params.orderId,
            orderItemId: item.orderItemId,
            referenceType: "order",
            referenceId: String(params.orderId),
            notes: item.reason
              ? `${item.condition} return: ${item.reason}`
              : `${item.condition} return`,
            userId: params.userId ?? null,
          });

          result.damaged++;
        }

        result.processed++;
        result.totalBaseUnitsReturned += baseUnits;
        result.items.push({
          orderItemId: item.orderItemId,
          productVariantId: item.productVariantId,
          qty: item.qty,
          condition: item.condition,
          baseUnitsReturned: baseUnits,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[RETURNS] Error processing return for order item ${item.orderItemId}:`,
          message,
        );
        // Record partial result even on failure -- don't block other items
        result.items.push({
          orderItemId: item.orderItemId,
          productVariantId: item.productVariantId,
          qty: item.qty,
          condition: item.condition,
          baseUnitsReturned: 0,
        });
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // GET RETURN HISTORY
  // ---------------------------------------------------------------------------

  /**
   * Get the return history for a specific order.
   *
   * Queries the `inventory_transactions` ledger for rows with
   * `transactionType = "return"` linked to the given order.
   *
   * @param orderId  Internal order PK.
   * @returns Array of return records with SKU, quantity, condition, and date.
   */
  async getReturnHistory(
    orderId: number,
  ): Promise<
    Array<{
      orderItemId: number;
      sku: string;
      qty: number;
      condition: string;
      returnedAt: Date;
    }>
  > {
    const transactions = await this.db
      .select({
        orderItemId: inventoryTransactions.orderItemId,
        productVariantId: inventoryTransactions.productVariantId,
        variantQtyDelta: inventoryTransactions.variantQtyDelta,
        targetState: inventoryTransactions.targetState,
        createdAt: inventoryTransactions.createdAt,
      })
      .from(inventoryTransactions)
      .where(
        and(
          eq(inventoryTransactions.orderId, orderId),
          eq(inventoryTransactions.transactionType, "return"),
        ),
      );

    const results: Array<{
      orderItemId: number;
      sku: string;
      qty: number;
      condition: string;
      returnedAt: Date;
    }> = [];

    for (const txn of transactions) {
      // Look up SKU from the product variant
      let sku = "UNKNOWN";
      if (txn.productVariantId) {
        const [variant] = await this.db
          .select({ sku: productVariants.sku })
          .from(productVariants)
          .where(eq(productVariants.id, txn.productVariantId))
          .limit(1);

        if (variant?.sku) {
          sku = variant.sku;
        }
      }

      // Map targetState back to a human-readable condition
      let condition: string;
      switch (txn.targetState) {
        case "on_hand":
          condition = "sellable";
          break;
        case "damaged":
          condition = "damaged";
          break;
        case "defective":
          condition = "defective";
          break;
        default:
          condition = txn.targetState ?? "unknown";
      }

      results.push({
        orderItemId: txn.orderItemId ?? 0,
        sku,
        qty: Math.abs(txn.variantQtyDelta),
        condition,
        returnedAt: txn.createdAt,
      });
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new `ReturnsService` bound to the supplied Drizzle database
 * and inventory core service instances.
 *
 * ```ts
 * import { db } from "../db";
 * import { createInventoryCoreService } from "./inventory-core";
 * import { createReturnsService } from "./returns";
 *
 * const inventoryCore = createInventoryCoreService(db);
 * const returns = createReturnsService(db, inventoryCore);
 * await returns.processReturn({ orderId, items: [...], warehouseLocationId });
 * ```
 */
export function createReturnsService(db: any, inventoryCore: any) {
  return new ReturnsService(db, inventoryCore);
}
