/**
 * Receipt Reversal service (Spec D, 2026-08-07).
 *
 * Posted (closed) receipts are immutable. Corrections happen via a reversal:
 * a compensating transaction linked to the original receiving order/line.
 * Closed receiving_orders / receiving_lines rows are NEVER mutated except for
 * the additive `reversed_qty` tally (migration 187).
 *
 * One reversal = ONE DB transaction (Rule #7) that:
 *   1. Inserts a procurement.receipt_reversals row (idempotency_key unique —
 *      a retried reversal returns the existing row, Rule #6).
 *   2. Decrements the lot(s) created by that receiving line at the ORIGINAL
 *      lot cost (exact mills round-trip — never re-costed). Insufficient
 *      on-hand blocks with REVERSAL_INSUFFICIENT_ON_HAND unless the caller
 *      passes allowNegative (elevated-permission override, audited on the
 *      reversal row).
 *   3. Decrements purchase_order_lines.received_qty by qty × units_per_variant
 *      (variant looked up live — same discipline as
 *      purchase-order-receipt-reconciliation.service.ts) and re-evaluates the
 *      PO line status + PO header status (received → partially_received when
 *      warranted).
 *   4. Re-opens AP invoice matching on the PO line when invoice lines were
 *      already matched (match_status → 'pending') and flags the reversal row.
 *   5. Writes inventory_transactions audit rows (transaction_type
 *      'receipt_reversal') referencing the original receipt + reversal id.
 *
 * Money discipline (Rule #3): integer mills only; no floats anywhere.
 */

import { sql } from "drizzle-orm";

// ── Minimal dependency interfaces (same style as receiving.service.ts) ──────

type DrizzleDb = {
  execute: (query: any) => Promise<{ rows: any[] }>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

/**
 * The inventory module's public reversal API (writer-ratchet P2.1:
 * procurement NEVER writes inventory.inventory_lots / inventory_levels /
 * inventory_transactions directly — it calls this).
 */
export interface ReversalInventoryCore {
  reverseReceiptInventory(params: {
    receivingLineId: number;
    receivingOrderId: number;
    productVariantId: number;
    warehouseLocationId: number | null;
    qty: number;
    reversalId: number;
    reason: string;
    userId?: string | null;
    allowNegative?: boolean;
  }, tx?: any): Promise<{ lotUnitCostMills: number | null }>;
}

export class ReceiptReversalError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public details?: any,
  ) {
    super(message);
    this.name = "ReceiptReversalError";
  }
}

export type ReversalLineResult = {
  reversalId: number;
  receivingLineId: number;
  qty: number;
  baseUnitsReversed: number;
  lotUnitCostMills: number | null;
  apReconciliationReopened: boolean;
  idempotentReplay: boolean;
};

export type ReversalResult = {
  receivingOrderId: number;
  reversals: ReversalLineResult[];
  poStatusUpdate: {
    purchaseOrderId: number;
    legacyStatus: string;
    physicalStatus: string;
  } | null;
};

// ── Pure helpers (exported for unit tests) ──────────────────────────────────

/**
 * Re-evaluate a PO line's receipt status after a decrement. Mirrors the
 * forward direction in purchase-order-receipt-reconciliation.service.ts:
 * remaining <= 0 → 'received'; some received → 'partially_received';
 * nothing received → back to 'open' (poLineStatusEnum has no 'expected').
 */
export function reevaluatePoLineStatusAfterReversal(params: {
  orderQty: number;
  receivedQty: number;
  cancelledQty: number;
  currentStatus: string;
}): string {
  const { orderQty, receivedQty, cancelledQty, currentStatus } = params;
  if (currentStatus === "cancelled" || currentStatus === "closed") return currentStatus;
  const remaining = orderQty - receivedQty - cancelledQty;
  if (remaining <= 0 && receivedQty > 0) return "received";
  if (receivedQty > 0) return "partially_received";
  return "open";
}

/**
 * Re-evaluate the PO header status after one or more line reversals.
 * Mirror-image of updatePurchaseOrderReceiptStatus in the reconciliation
 * service, deliberately conservative:
 *   - all lines received → received/received (same as forward path);
 *   - some received → partially_received/receiving (the spec's core case:
 *     'received' → 'partially_received' when warranted);
 *   - none received → partially_received/receiving when the PO is currently
 *     in a received-ish state. We never guess the pre-receiving track
 *     (draft/sent/acknowledged is unknowable from here), and never touch
 *     closed/cancelled POs.
 */
export function reevaluatePoStatusAfterReversal(params: {
  poStatus: string;
  physicalStatus: string | null;
  lines: Array<{ status: string; lineType?: string }>;
}): { legacyStatus: string; physicalStatus: string } | null {
  const { poStatus, physicalStatus, lines } = params;
  if (["closed", "cancelled"].includes(poStatus)) return null;

  const activeLines = lines.filter(
    (line) => line.status !== "cancelled" && (line.lineType ?? "product") === "product",
  );
  if (activeLines.length === 0) return null;

  const allReceived = activeLines.every((line) => line.status === "received");
  const someReceived = activeLines.some(
    (line) => line.status === "received" || line.status === "partially_received",
  );

  if (allReceived) {
    if (poStatus !== "received" || physicalStatus !== "received") {
      return { legacyStatus: "received", physicalStatus: "received" };
    }
    return null;
  }

  // Some or none received: the PO is not fully received anymore.
  if (poStatus !== "partially_received" || !["receiving"].includes(physicalStatus ?? "")) {
    // Only downgrade from a received-ish state; a PO that was never marked
    // received/partially_received keeps its current track.
    if (["received", "partially_received"].includes(poStatus) || physicalStatus === "received") {
      return { legacyStatus: "partially_received", physicalStatus: "receiving" };
    }
  }
  return null;
}

export const __testing__ = {
  reevaluatePoLineStatusAfterReversal,
  reevaluatePoStatusAfterReversal,
};

// ── Service ─────────────────────────────────────────────────────────────────

export class ReceiptReversalService {
  constructor(
    private db: DrizzleDb,
    private inventoryCore: ReversalInventoryCore | null = null,
  ) {}

  /**
   * Reverse a single receiving line (partial qty allowed).
   *
   * @param params.qty Quantity in the line's VARIANT units (same unit as
   *   receiving_lines.received_qty). Must be a positive safe integer and
   *   <= received_qty - reversed_qty.
   * @param params.idempotencyKey Required. Unique across all reversals; a
   *   retry with the same key returns the original reversal (no double-apply).
   * @param params.allowNegative Elevated-permission override: when the lot's
   *   on-hand is insufficient (qty already consumed/sold), post the decrement
   *   anyway and flag the reversal row. Default: block.
   */
  async reverseReceivingLine(params: {
    receivingLineId: number;
    qty: number;
    reason: string;
    idempotencyKey: string;
    allowNegative?: boolean;
    userId?: string | null;
  }): Promise<ReversalLineResult> {
    const { receivingLineId, qty, reason, idempotencyKey, userId } = params;
    const allowNegative = params.allowNegative === true;

    // ── Input validation (Rule #3 — validate at boundaries) ──────────────
    if (!Number.isSafeInteger(receivingLineId) || receivingLineId <= 0) {
      throw new ReceiptReversalError("receivingLineId must be a positive integer", 400, {
        code: "INVALID_RECEIVING_LINE_ID",
        receivingLineId,
      });
    }
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new ReceiptReversalError("qty must be a positive integer", 400, {
        code: "INVALID_REVERSAL_QTY",
        qty,
      });
    }
    const normalizedReason = typeof reason === "string" ? reason.trim() : "";
    if (!normalizedReason) {
      throw new ReceiptReversalError("reason is required", 400, {
        code: "REVERSAL_REASON_REQUIRED",
      });
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0 || idempotencyKey.length > 100) {
      throw new ReceiptReversalError("idempotencyKey is required (max 100 chars)", 400, {
        code: "INVALID_IDEMPOTENCY_KEY",
      });
    }

    // ── Idempotency pre-check (fast path; the unique index is the real
    //    guard inside the transaction) ─────────────────────────────────────
    const existing = await this.db.execute(sql`
      SELECT id, receiving_line_id, qty, base_units_reversed, lot_unit_cost_mills,
             ap_reconciliation_reopened
      FROM procurement.receipt_reversals
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `);
    if (existing.rows?.[0]) {
      const row = existing.rows[0];
      return {
        reversalId: Number(row.id),
        receivingLineId: Number(row.receiving_line_id),
        qty: Number(row.qty),
        baseUnitsReversed: Number(row.base_units_reversed ?? 0),
        lotUnitCostMills: row.lot_unit_cost_mills === null ? null : Number(row.lot_unit_cost_mills),
        apReconciliationReopened: Number(row.ap_reconciliation_reopened) === 1,
        idempotentReplay: true,
      };
    }

    return await this.db.transaction(async (tx) => {
      const result = await this.applyLineReversal(tx, {
        receivingLineId,
        qty,
        reason: normalizedReason,
        idempotencyKey,
        allowNegative,
        userId: userId ?? null,
        reversalScope: "line",
        orderReversalId: null,
      });
      // Idempotent replays must not re-run PO re-evaluation (nothing changed).
      if (!result.idempotentReplay && result.purchaseOrderId) {
        await this.reevaluatePo(tx, result.purchaseOrderId, userId ?? null, normalizedReason);
      }
      const { purchaseOrderId: _poId, ...lineResult } = result;
      return lineResult;
    });
  }

  /**
   * Reverse an entire closed receiving order — every line with remaining
   * reversible qty, each for its full remaining amount. One transaction;
   * one order_reversal_id group linking the per-line reversal rows.
   */
  async reverseReceivingOrder(params: {
    receivingOrderId: number;
    reason: string;
    idempotencyKey: string;
    allowNegative?: boolean;
    userId?: string | null;
  }): Promise<ReversalResult> {
    const { receivingOrderId, reason, idempotencyKey, userId } = params;
    const allowNegative = params.allowNegative === true;

    if (!Number.isSafeInteger(receivingOrderId) || receivingOrderId <= 0) {
      throw new ReceiptReversalError("receivingOrderId must be a positive integer", 400, {
        code: "INVALID_RECEIVING_ORDER_ID",
        receivingOrderId,
      });
    }
    const normalizedReason = typeof reason === "string" ? reason.trim() : "";
    if (!normalizedReason) {
      throw new ReceiptReversalError("reason is required", 400, {
        code: "REVERSAL_REASON_REQUIRED",
      });
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0 || idempotencyKey.length > 100) {
      throw new ReceiptReversalError("idempotencyKey is required (max 100 chars)", 400, {
        code: "INVALID_IDEMPOTENCY_KEY",
      });
    }

    // Idempotency pre-check: whole-order reversals store per-line rows with
    // keys `${idempotencyKey}:line:${lineId}`. If the group already exists,
    // return it.
    const existing = await this.db.execute(sql`
      SELECT id, receiving_order_id, receiving_line_id, qty, base_units_reversed,
             lot_unit_cost_mills, ap_reconciliation_reopened
      FROM procurement.receipt_reversals
      WHERE receiving_order_id = ${receivingOrderId}
        AND idempotency_key LIKE ${idempotencyKey + ":%"}
      ORDER BY id
    `);
    if (existing.rows?.length > 0) {
      return {
        receivingOrderId,
        reversals: existing.rows.map((row: any) => ({
          reversalId: Number(row.id),
          receivingLineId: Number(row.receiving_line_id),
          qty: Number(row.qty),
          baseUnitsReversed: Number(row.base_units_reversed ?? 0),
          lotUnitCostMills: row.lot_unit_cost_mills === null ? null : Number(row.lot_unit_cost_mills),
          apReconciliationReopened: Number(row.ap_reconciliation_reopened) === 1,
          idempotentReplay: true,
        })),
        poStatusUpdate: null,
      };
    }

    return await this.db.transaction(async (tx) => {
      // Lock the order; must be closed.
      const orderRows = await tx.execute(sql`
        SELECT id, status, purchase_order_id
        FROM procurement.receiving_orders
        WHERE id = ${receivingOrderId}
        FOR UPDATE
      `);
      const order = orderRows.rows?.[0];
      if (!order) throw new ReceiptReversalError("Receiving order not found", 404);
      if (order.status !== "closed") {
        throw new ReceiptReversalError("Only closed receiving orders can be reversed", 409, {
          code: "RECEIPT_NOT_CLOSED",
          receivingOrderId,
          status: order.status,
        });
      }

      const lineRows = await tx.execute(sql`
        SELECT id, received_qty, reversed_qty
        FROM procurement.receiving_lines
        WHERE receiving_order_id = ${receivingOrderId}
        ORDER BY id
        FOR UPDATE
      `);
      const reversible = lineRows.rows.filter(
        (row: any) => (Number(row.received_qty) || 0) - (Number(row.reversed_qty) || 0) > 0,
      );
      if (reversible.length === 0) {
        throw new ReceiptReversalError("No lines have remaining reversible quantity", 409, {
          code: "NOTHING_TO_REVERSE",
          receivingOrderId,
        });
      }

      const reversals: ReversalLineResult[] = [];
      let orderReversalGroupId: number | null = null;
      const touchedPoIds = new Set<number>();

      for (const row of reversible) {
        const lineId = Number(row.id);
        const remaining = (Number(row.received_qty) || 0) - (Number(row.reversed_qty) || 0);
        const result = await this.applyLineReversal(tx, {
          receivingLineId: lineId,
          qty: remaining,
          reason: normalizedReason,
          idempotencyKey: `${idempotencyKey}:line:${lineId}`,
          allowNegative,
          userId: userId ?? null,
          reversalScope: "order",
          orderReversalId: orderReversalGroupId,
        });
        // The first line's reversal id becomes the group id for the rest.
        if (orderReversalGroupId === null) {
          orderReversalGroupId = result.reversalId;
          await tx.execute(sql`
            UPDATE procurement.receipt_reversals
            SET order_reversal_id = ${orderReversalGroupId}
            WHERE id = ${orderReversalGroupId}
          `);
        }
        if (result.purchaseOrderId) touchedPoIds.add(result.purchaseOrderId);
        reversals.push(result);
      }

      // Re-evaluate PO status for each touched PO (usually one).
      let poStatusUpdate: ReversalResult["poStatusUpdate"] = null;
      for (const poId of Array.from(touchedPoIds).sort((a, b) => a - b)) {
        const update = await this.reevaluatePo(tx, poId, userId ?? null, normalizedReason);
        if (update) poStatusUpdate = update;
      }

      return { receivingOrderId, reversals, poStatusUpdate };
    });
  }

  /** Reversal history for one receiving order (newest first). */
  async getReversalsForOrder(receivingOrderId: number) {
    const result = await this.db.execute(sql`
      SELECT id, receiving_order_id, receiving_line_id, qty, reason, reversal_scope,
             order_reversal_id, base_units_reversed, lot_unit_cost_mills,
             allow_negative, ap_reconciliation_reopened, idempotency_key,
             created_by, created_at
      FROM procurement.receipt_reversals
      WHERE receiving_order_id = ${receivingOrderId}
      ORDER BY created_at DESC, id DESC
    `);
    return result.rows.map((row: any) => ({
      id: Number(row.id),
      receivingOrderId: Number(row.receiving_order_id),
      receivingLineId: Number(row.receiving_line_id),
      qty: Number(row.qty),
      reason: row.reason,
      reversalScope: row.reversal_scope,
      orderReversalId: row.order_reversal_id === null ? null : Number(row.order_reversal_id),
      baseUnitsReversed: row.base_units_reversed === null ? null : Number(row.base_units_reversed),
      lotUnitCostMills: row.lot_unit_cost_mills === null ? null : Number(row.lot_unit_cost_mills),
      allowNegative: Number(row.allow_negative) === 1,
      apReconciliationReopened: Number(row.ap_reconciliation_reopened) === 1,
      idempotencyKey: row.idempotency_key,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Apply one line reversal inside an existing transaction. Returns the
   * reversal row plus the touched PO id (for header re-evaluation by the
   * caller).
   */
  private async applyLineReversal(
    tx: any,
    params: {
      receivingLineId: number;
      qty: number;
      reason: string;
      idempotencyKey: string;
      allowNegative: boolean;
      userId: string | null;
      reversalScope: "line" | "order";
      orderReversalId: number | null;
    },
  ): Promise<ReversalLineResult & { purchaseOrderId: number | null }> {
    const { receivingLineId, qty, reason, idempotencyKey, allowNegative, userId } = params;

    // 1. Lock the line + its order. Order must be closed.
    const lineRows = await tx.execute(sql`
      SELECT rl.id, rl.receiving_order_id, rl.received_qty, rl.reversed_qty,
             rl.product_variant_id, rl.purchase_order_line_id, rl.putaway_location_id,
             ro.status AS order_status, ro.purchase_order_id AS order_po_id,
             ro.receipt_number
      FROM procurement.receiving_lines rl
      JOIN procurement.receiving_orders ro ON ro.id = rl.receiving_order_id
      WHERE rl.id = ${receivingLineId}
      FOR UPDATE OF rl
    `);
    const line = lineRows.rows?.[0];
    if (!line) throw new ReceiptReversalError("Receiving line not found", 404);
    if (line.order_status !== "closed") {
      throw new ReceiptReversalError("Only lines on closed receiving orders can be reversed", 409, {
        code: "RECEIPT_NOT_CLOSED",
        receivingLineId,
        status: line.order_status,
      });
    }

    const receivedQty = Number(line.received_qty) || 0;
    const reversedQty = Number(line.reversed_qty) || 0;
    const remainingReversible = receivedQty - reversedQty;
    if (qty > remainingReversible) {
      throw new ReceiptReversalError(
        `Cannot reverse ${qty}; only ${remainingReversible} remaining (received ${receivedQty}, already reversed ${reversedQty})`,
        409,
        {
          code: "REVERSAL_QTY_EXCEEDS_REMAINING",
          receivingLineId,
          qty,
          receivedQty,
          reversedQty,
          remainingReversible,
        },
      );
    }

    const productVariantId = Number(line.product_variant_id);
    if (!Number.isSafeInteger(productVariantId) || productVariantId <= 0) {
      throw new ReceiptReversalError("Receiving line has no product variant; cannot reverse inventory", 409, {
        code: "REVERSAL_MISSING_VARIANT",
        receivingLineId,
      });
    }

    // 2. Live variant lookup for units_per_variant (same discipline as the
    //    forward reconciliation path).
    const variantRows = await tx.execute(sql`
      SELECT id, units_per_variant
      FROM catalog.product_variants
      WHERE id = ${productVariantId}
    `);
    const unitsPerVariant = Math.max(1, Number(variantRows.rows?.[0]?.units_per_variant) || 1);
    const baseUnits = qty * unitsPerVariant;
    if (!Number.isSafeInteger(baseUnits)) {
      throw new ReceiptReversalError("Reversal quantity overflows safe integer range", 400, {
        code: "REVERSAL_QTY_OVERFLOW",
        receivingLineId,
        qty,
        unitsPerVariant,
      });
    }

    // 3. Increment reversed_qty on the line (additive tally; the only
    //    mutation allowed on a closed line). The CHECK constraint
    //    (reversed_qty <= received_qty) is the DB-level backstop.
    await tx.execute(sql`
      UPDATE procurement.receiving_lines
      SET reversed_qty = reversed_qty + ${qty},
          updated_at = NOW()
      WHERE id = ${receivingLineId}
    `);

    // 4. Insert the reversal record first — the inventory ledger row
    //    references its id. Idempotency: unique key; a concurrent retry that
    //    passed the pre-check loses the unique race and is re-read below.
    //    lot_unit_cost_mills / ap flags are backfilled after the inventory +
    //    AP steps (same transaction, so readers never see a partial state).
    let reversalId: number;
    try {
      const inserted = await tx.execute(sql`
        INSERT INTO procurement.receipt_reversals
          (receiving_order_id, receiving_line_id, qty, reason, reversal_scope,
           order_reversal_id, base_units_reversed, lot_unit_cost_mills,
           allow_negative, ap_reconciliation_reopened, idempotency_key, created_by)
        VALUES (
          ${Number(line.receiving_order_id)}, ${receivingLineId}, ${qty}, ${reason},
          ${params.reversalScope}, ${params.orderReversalId}, ${baseUnits},
          ${null}, ${allowNegative ? 1 : 0}, ${0},
          ${idempotencyKey}, ${userId}
        )
        RETURNING id
      `);
      reversalId = Number(inserted.rows?.[0]?.id);
    } catch (error: any) {
      if (error?.code === "23505" || error?.cause?.code === "23505") {
        // Lost the idempotency race — read the winner and return it. The
        // transaction rolls back, so no double-apply.
        const winner = await this.db.execute(sql`
          SELECT id, receiving_line_id, qty, base_units_reversed, lot_unit_cost_mills,
                 ap_reconciliation_reopened
          FROM procurement.receipt_reversals
          WHERE idempotency_key = ${idempotencyKey}
          LIMIT 1
        `);
        const row = winner.rows?.[0];
        if (row) {
          return {
            reversalId: Number(row.id),
            receivingLineId: Number(row.receiving_line_id),
            qty: Number(row.qty),
            baseUnitsReversed: Number(row.base_units_reversed ?? 0),
            lotUnitCostMills: row.lot_unit_cost_mills === null ? null : Number(row.lot_unit_cost_mills),
            apReconciliationReopened: Number(row.ap_reconciliation_reopened) === 1,
            idempotentReplay: true,
            purchaseOrderId: null,
          };
        }
      }
      throw error;
    }

    // 5. Inventory: decrement lot(s) at the ORIGINAL cost + location level +
    //    ledger row — via the inventory module's public API (writer-ratchet:
    //    procurement never writes inventory.* tables directly). Throws
    //    InsufficientOnHandForReversalError when consumed/sold, unless
    //    allowNegative. The whole transaction rolls back on failure.
    if (!this.inventoryCore) {
      throw new ReceiptReversalError("Inventory reversal service is unavailable", 500, {
        code: "REVERSAL_INVENTORY_UNAVAILABLE",
        receivingLineId,
      });
    }
    const locationId = Number(line.putaway_location_id);
    let inventoryResult: { lotUnitCostMills: number | null };
    try {
      inventoryResult = await this.inventoryCore.reverseReceiptInventory({
        receivingLineId,
        receivingOrderId: Number(line.receiving_order_id),
        productVariantId,
        warehouseLocationId: Number.isSafeInteger(locationId) && locationId > 0 ? locationId : null,
        qty,
        reversalId,
        reason: `Reversal #${reversalId} of receipt ${line.receipt_number ?? line.receiving_order_id}: ${reason}`,
        userId,
        allowNegative,
      }, tx);
    } catch (error: any) {
      if (error?.code === "REVERSAL_INSUFFICIENT_ON_HAND") {
        throw new ReceiptReversalError(error.message, 409, {
          code: "REVERSAL_INSUFFICIENT_ON_HAND",
          receivingLineId,
          qty,
          ...(error.context ?? {}),
        });
      }
      throw error;
    }
    const lotUnitCostMills = inventoryResult.lotUnitCostMills;

    // 6. PO line: decrement received_qty by qty × units_per_variant and
    //    re-evaluate the line status.
    let purchaseOrderId: number | null = null;
    let apReopened = false;
    const poLineId = Number(line.purchase_order_line_id);
    if (Number.isSafeInteger(poLineId) && poLineId > 0) {
      const poLineRows = await tx.execute(sql`
        SELECT id, purchase_order_id, order_qty, received_qty, damaged_qty,
               cancelled_qty, status
        FROM procurement.purchase_order_lines
        WHERE id = ${poLineId}
        FOR UPDATE
      `);
      const poLine = poLineRows.rows?.[0];
      if (poLine) {
        purchaseOrderId = Number(poLine.purchase_order_id);
        const currentReceived = Number(poLine.received_qty) || 0;
        const newReceivedQty = Math.max(0, currentReceived - baseUnits);
        const newStatus = reevaluatePoLineStatusAfterReversal({
          orderQty: Number(poLine.order_qty) || 0,
          receivedQty: newReceivedQty,
          cancelledQty: Number(poLine.cancelled_qty) || 0,
          currentStatus: String(poLine.status),
        });
        await tx.execute(sql`
          UPDATE procurement.purchase_order_lines
          SET received_qty = ${newReceivedQty},
              status = ${newStatus},
              fully_received_date = CASE WHEN ${newStatus} = 'received' THEN fully_received_date ELSE NULL END,
              updated_at = NOW()
          WHERE id = ${poLineId}
        `);

        // 7. AP reconciliation: if any vendor invoice lines linked to this PO
        //    line are already matched, re-open them (match_status → pending)
        //    and flag the reversal row.
        const apRows = await tx.execute(sql`
          UPDATE procurement.vendor_invoice_lines
          SET match_status = 'pending',
              updated_at = NOW()
          WHERE purchase_order_line_id = ${poLineId}
            AND match_status = 'matched'
          RETURNING id
        `);
        apReopened = (apRows.rows?.length ?? 0) > 0;
      }
    }

    // 8. Backfill the reversal row with the lot cost snapshot + AP flag.
    await tx.execute(sql`
      UPDATE procurement.receipt_reversals
      SET lot_unit_cost_mills = ${lotUnitCostMills},
          ap_reconciliation_reopened = ${apReopened ? 1 : 0}
      WHERE id = ${reversalId}
    `);

    return {
      reversalId,
      receivingLineId,
      qty,
      baseUnitsReversed: baseUnits,
      lotUnitCostMills,
      apReconciliationReopened: apReopened,
      idempotentReplay: false,
      purchaseOrderId,
    };
  }

  /**
   * Re-evaluate the PO header status after line reversals and write the
   * status-history audit row when a transition is warranted.
   */
  private async reevaluatePo(
    tx: any,
    poId: number,
    userId: string | null,
    reason: string,
  ): Promise<ReversalResult["poStatusUpdate"]> {
    const poRows = await tx.execute(sql`
      SELECT id, status, physical_status
      FROM procurement.purchase_orders
      WHERE id = ${poId}
      FOR UPDATE
    `);
    const po = poRows.rows?.[0];
    if (!po) return null;

    const lineRows = await tx.execute(sql`
      SELECT status, line_type
      FROM procurement.purchase_order_lines
      WHERE purchase_order_id = ${poId}
    `);
    const update = reevaluatePoStatusAfterReversal({
      poStatus: String(po.status),
      physicalStatus: po.physical_status === null ? null : String(po.physical_status),
      lines: lineRows.rows.map((row: any) => ({
        status: String(row.status),
        lineType: row.line_type ?? "product",
      })),
    });
    if (!update) return null;

    await tx.execute(sql`
      UPDATE procurement.purchase_orders
      SET status = ${update.legacyStatus},
          physical_status = ${update.physicalStatus},
          actual_delivery_date = CASE
            WHEN ${update.legacyStatus} = 'received' THEN actual_delivery_date
            ELSE NULL
          END,
          updated_at = NOW()
      WHERE id = ${poId}
    `);
    await tx.execute(sql`
      INSERT INTO procurement.po_status_history
        (purchase_order_id, from_status, to_status, changed_by, notes)
      VALUES (
        ${poId},
        ${String(po.status)},
        ${update.legacyStatus},
        ${userId},
        ${`Receipt reversal re-evaluated PO status: ${reason}`}
      )
    `);
    return { purchaseOrderId: poId, ...update };
  }
}

export function createReceiptReversalService(
  db: DrizzleDb,
  inventoryCore?: ReversalInventoryCore | null,
) {
  return new ReceiptReversalService(db, inventoryCore ?? null);
}
