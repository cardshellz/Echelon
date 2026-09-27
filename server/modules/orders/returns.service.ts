import { eq, and, sql } from "drizzle-orm";
import {
  productVariants,
  inventoryLevels,
  inventoryTransactions,
} from "@shared/schema";
import { resolveReturnCost } from "../inventory/cost-resolver";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: (query: any) => Promise<any>;
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
 * - The source fence and all inventory/audit effects share one transaction.
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
    if (!Number.isSafeInteger(params.orderId) || params.orderId <= 0
      || !Number.isSafeInteger(params.warehouseLocationId) || params.warehouseLocationId <= 0 || !Array.isArray(params.items)
      || params.items.length === 0 || params.items.length > 200
      || new Set(params.items.map(item => item.orderItemId)).size !== params.items.length
      || params.items.some(item => !Number.isSafeInteger(item.orderItemId) || item.orderItemId <= 0
        || !Number.isSafeInteger(item.productVariantId) || item.productVariantId <= 0
        || !Number.isSafeInteger(item.qty) || item.qty <= 0
        || !["sellable","damaged","defective"].includes(item.condition))) {
      throw new Error("RETURN_LEGACY_INPUT_INVALID: Return item quantities and identities must be valid.");
    }
    if (typeof this.inventoryCore.withTx !== "function") {
      throw new Error("RETURN_LEGACY_TRANSACTION_REQUIRED: Inventory return processing requires the transaction-bound inventory service.");
    }
    return this.db.transaction(async (tx: DrizzleDb) => {
      const initial = sqlRows(await tx.execute(sql`SELECT id,oms_fulfillment_order_id FROM wms.orders WHERE id=${params.orderId}`))[0];
      if (!initial) throw new Error("RETURN_LEGACY_SOURCE_MISSING: The source order was not found.");
      const omsId = typeof initial.oms_fulfillment_order_id === "string" && /^[1-9][0-9]*$/.test(initial.oms_fulfillment_order_id)
        ? Number(initial.oms_fulfillment_order_id) : null;
      if (omsId !== null) {
        if (!Number.isSafeInteger(omsId)) throw new Error("RETURN_LEGACY_SOURCE_INVALID: The source order needs verification.");
        if (omsId <= 2_147_483_647) await tx.execute(sql`SELECT pg_advisory_xact_lock(918413,${omsId})`);
        await tx.execute(sql`SELECT id FROM oms.oms_orders WHERE id=${omsId} FOR UPDATE`);
      }
      const locked = sqlRows(await tx.execute(sql`SELECT id,oms_fulfillment_order_id FROM wms.orders WHERE id=${params.orderId} FOR UPDATE`))[0];
      if (!locked || locked.oms_fulfillment_order_id !== initial.oms_fulfillment_order_id) {
        throw new Error("RETURN_LEGACY_SOURCE_CHANGED: The source order changed. Reload it.");
      }
      // A different purchased line remains on its existing receiving path. A
      // split WMS partition of a portal-owned purchased line cannot bypass its
      // canonical receipt by choosing the other partition's item id.
      const roots = sqlRows(await tx.execute(sql`SELECT 1 FROM returns.customer_return_authorizations a
        JOIN returns.customer_return_authorization_lines al ON al.authorization_id=a.id
        JOIN wms.order_items requested ON requested.oms_order_line_id=al.oms_order_line_id
        WHERE requested.order_id=${params.orderId}
          AND requested.id IN (${sql.join(params.items.map(item=>sql`${item.orderItemId}`),sql`, `)}) LIMIT 1`));
      if (roots.length > 0) {
        throw new Error("RETURN_CANONICAL_RECEIVING_REQUIRED: Receive portal returns through their linked Return Case.");
      }
      const items = sqlRows(await tx.execute(sql`SELECT wi.id,wi.oms_order_line_id,ol.product_variant_id FROM wms.order_items wi
        LEFT JOIN oms.oms_order_lines ol ON ol.id=wi.oms_order_line_id
        WHERE wi.order_id=${params.orderId} FOR UPDATE OF wi`));
      // WMS items have no variant-id column. An exact OMS line owns that link;
      // legacy non-OMS items retain the existing caller-supplied variant path.
      if (params.items.some(item => !items.some(source => Number(source.id) === item.orderItemId
        && (source.oms_order_line_id == null || Number(source.product_variant_id) === item.productVariantId)))) {
        throw new Error("RETURN_LEGACY_ITEM_MISMATCH: Return items must belong to the source order and catalog variant.");
      }
      return new ReturnsService(tx, this.inventoryCore.withTx(tx)).processItems(params);
    });
  }

  /** Called only while the shared source-order lock and inventory transaction are held. */
  private async processItems(params: ProcessReturnParams): Promise<ReturnResult> {
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
          // Look up the original COGS so the returned lot carries the cost
          // the unit was sold at, not $0 (COGS Phase 2).
          const returnCost = await resolveReturnCost(
            this.db,
            item.productVariantId,
            params.orderId,
          );
          await this.inventoryCore.receiveInventory({
            productVariantId: item.productVariantId,
            warehouseLocationId: params.warehouseLocationId,
            qty: item.qty,
            referenceId: String(params.orderId),
            notes: params.notes
              ? `Return (sellable): ${params.notes}`
              : `Return (sellable) for order ${params.orderId}`,
            userId: params.userId,
            unitCostCents: returnCost.costCents,
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
          // Both operations MUST be atomic — if the adjust fails after
          // receiving, damaged stock would sit in sellable inventory.
          // Even damaged returns carry original COGS for write-off valuation.
          const damagedCost = await resolveReturnCost(
            this.db,
            item.productVariantId,
            params.orderId,
          );
          {
            const tx = this.db;
            const txCore = this.inventoryCore.withTx
              ? this.inventoryCore.withTx(tx)
              : this.inventoryCore;

            // Step 1: Receive so we have an audit record of the physical receipt
            await txCore.receiveInventory({
              productVariantId: item.productVariantId,
              warehouseLocationId: params.warehouseLocationId,
              qty: item.qty,
              referenceId: String(params.orderId),
              notes: `Return (${item.condition}) for order ${params.orderId}`,
              userId: params.userId,
              unitCostCents: damagedCost.costCents,
            });

            // Step 2: Immediately adjust out as damaged -- this removes the
            // units from on-hand so they are not available for picking.
            await txCore.adjustInventory({
              productVariantId: item.productVariantId,
              warehouseLocationId: params.warehouseLocationId,
              qtyDelta: -item.qty,
              reason: `${item.condition} return${item.reason ? `: ${item.reason}` : ""}`,
              userId: params.userId,
            });
          }

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
        // The batch is now transaction-bound to its entitlement fence. Any
        // inventory/audit failure must roll back the batch, not commit a prefix.
        throw err;
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

function sqlRows(result: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) throw new Error("RETURN_LEGACY_DATA_INVALID: Invalid return source rows.");
  return rows as Record<string, unknown>[];
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
