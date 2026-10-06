import { eq, and, sql } from "drizzle-orm";
import {
  productVariants,
  inventoryTransactions,
} from "@shared/schema";
import { randomUUID } from "node:crypto";
import { applyReturnedStock, quarantineReturnedStock, lockInventoryCostGraph, costFingerprint,
  loadReturnCommand, recordReturnCommand, ReturnRestockError, readPhysicalReturnQuantities } from "../inventory/return-inventory.api";
import { returnCommandResultSchema } from "@shared/inventory/return-command";

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
  /** Optional for older clients; current UI reuses this key on every retry. */
  commandKey?: string;
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
 * - Delegates physical stock and costing to the published Inventory return owner.
 * - The source fence and all inventory/audit effects share one transaction.
 * - Every mutation is audited via the inventory transactions ledger.
 */
class ReturnsService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: () => Date = () => new Date(),
    private readonly newCommandKey: () => string = randomUUID,
  ) {}

  // ---------------------------------------------------------------------------
  // PROCESS RETURN
  // ---------------------------------------------------------------------------

  /**
   * Process a batch of returned items for an order.
   *
   * For each returned item:
   *   - **Sellable**: Adds stock back to `variantQty` at the specified
   *     location through the shared Inventory return application.
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
      || typeof params.userId !== "string" || !params.userId.trim()
      || (params.notes !== undefined && typeof params.notes !== "string")
      || params.items.length === 0 || params.items.length > 200
      || params.items.some(item=>!item || typeof item !== "object")
      || new Set(params.items.map(item => item.orderItemId)).size !== params.items.length
      || params.items.some(item => !Number.isSafeInteger(item.orderItemId) || item.orderItemId <= 0
        || !Number.isSafeInteger(item.productVariantId) || item.productVariantId <= 0
        || !Number.isSafeInteger(item.qty) || item.qty <= 0
        || !["sellable","damaged","defective"].includes(item.condition)
        || (item.reason !== undefined && typeof item.reason !== "string"))) {
      throw new Error("RETURN_LEGACY_INPUT_INVALID: Return item quantities and identities must be valid.");
    }
    if (params.commandKey !== undefined && (typeof params.commandKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(params.commandKey))) {
      throw new Error("RETURN_LEGACY_IDEMPOTENCY_INVALID: Return command key must be a supported stable inventory key.");
    }
    // The optional key preserves old-client compatibility. Without a client key,
    // this is a new physical command as before, not a claim of safe request replay.
    const commandKey = params.commandKey ?? this.newCommandKey();
    const requestHash = costFingerprint(params);
    return this.db.transaction(async (tx: DrizzleDb) => {
      await lockInventoryCostGraph(tx);
      const replay = await loadReturnCommand(tx,commandKey,requestHash);
      if (replay) return replay;
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
      const items = sqlRows(await tx.execute(sql`SELECT wi.id,wi.quantity,wi.oms_order_line_id,ol.product_variant_id FROM wms.order_items wi
        LEFT JOIN oms.oms_order_lines ol ON ol.id=wi.oms_order_line_id
        WHERE wi.order_id=${params.orderId} FOR UPDATE OF wi`));
      // WMS items have no variant-id column. An exact OMS line owns that link;
      // legacy non-OMS items retain the existing caller-supplied variant path.
      if (params.items.some(item => !items.some(source => Number(source.id) === item.orderItemId
        && (source.oms_order_line_id == null || Number(source.product_variant_id) === item.productVariantId)))) {
        throw new Error("RETURN_LEGACY_ITEM_MISMATCH: Return items must belong to the source order and catalog variant.");
      }
      // Physical entitlement comes from the locked WMS item and prior physical
      // return audit, independently of whether sold cost evidence exists.
      const priorReturns = await readPhysicalReturnQuantities(tx,params.orderId,params.items.map(item=>item.orderItemId));
      for (const item of params.items) {
        const ordered = items.find(source=>Number(source.id)===item.orderItemId)!.quantity;
        if (!Number.isSafeInteger(ordered) || Number(ordered)<=0) {
          throw new ReturnRestockError("RETURN_SOURCE_QUANTITY_INVALID", "The original order quantity needs verification.", { orderItemId: item.orderItemId });
        }
        const returned = priorReturns.get(item.orderItemId) ?? BigInt(0);
        if (returned + BigInt(item.qty)>BigInt(Number(ordered))) {
          throw new ReturnRestockError("RETURN_QUANTITY_EXCEEDED", "The return exceeds this order item's remaining quantity.", { orderItemId: item.orderItemId });
        }
      }
      const now = this.clock();
      if (!Number.isFinite(now.getTime())) throw new Error("RETURN_LEGACY_CLOCK_INVALID");
      const result = await this.processItems(tx,params,commandKey,now);
      await recordReturnCommand(tx,{ key: commandKey,hash: requestHash,result: returnCommandResultSchema.parse(result),
        actor: params.userId!,now });
      return result;
    });
  }

  /** Called only while the shared source-order lock and inventory transaction are held. */
  private async processItems(tx: DrizzleDb, params: ProcessReturnParams, commandKey: string, now: Date): Promise<ReturnResult> {
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
        const [variant] = await tx
          .select()
          .from(productVariants)
          .where(eq(productVariants.id, item.productVariantId))
          .limit(1);

        const unitsPerVariant = variant?.unitsPerVariant;
        if (!Number.isSafeInteger(unitsPerVariant) || unitsPerVariant<=0) throw new Error("RETURN_VARIANT_UNIT_BASIS_INVALID");
        const baseUnits = item.qty * unitsPerVariant;
        if (!Number.isSafeInteger(baseUnits)) throw new Error("RETURN_QUANTITY_OVERFLOW");

        const actor = params.userId!;
        const notes = `${item.condition} return${item.reason ? `: ${item.reason}` : ""}${params.notes ? `; ${params.notes}` : ""}`;
        const restock = await applyReturnedStock(tx,{
          productVariantId: item.productVariantId,warehouseLocationId: params.warehouseLocationId,quantity: item.qty,
          wmsOrderId: params.orderId,wmsOrderItemId: item.orderItemId,actor,notes,now,
          condition: item.condition,
          operationKey: `legacy_return:${commandKey}:${item.orderItemId}`,
          referenceType: "order_return_command",referenceId: `${commandKey}:${item.orderItemId}`,
          lotNumberPrefix: `RET-${costFingerprint(commandKey).slice(0,16)}-${item.orderItemId}`,
        });
        if (item.condition === "sellable") result.sellable++;
        else {
          await quarantineReturnedStock(tx,{
            inventoryLotIds: restock.inventoryLotIds,productVariantId: item.productVariantId,
            warehouseLocationId: params.warehouseLocationId,quantity: item.qty,actor,
            reason: item.reason ?? `${item.condition} return`,
            operationKey: `legacy_return_quarantine:${commandKey}:${item.orderItemId}`,occurredAt: now,
          });
          result.damaged++;
        }

        result.processed++;
        if (!Number.isSafeInteger(result.totalBaseUnitsReturned + baseUnits)) throw new Error("RETURN_QUANTITY_OVERFLOW");
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
 * and optional injected clock/command identity. The legacy core parameter is
 * accepted for existing callers; stock posting has one Inventory owner.
 *
 * ```ts
 * import { db } from "../db";
 * import { createReturnsService } from "./returns";
 *
 * const returns = createReturnsService(db);
 * await returns.processReturn({ orderId, items: [...], warehouseLocationId, userId, commandKey });
 * ```
 */
export function createReturnsService(db: any, _legacyInventoryCore?: any, options: { clock?: () => Date; newCommandKey?: () => string } = {}) {
  // Keep the existing factory call contract. The return owner now receives the
  // actual transaction directly; no unused transaction-bound service is created.
  return new ReturnsService(db,options.clock,options.newCommandKey);
}
