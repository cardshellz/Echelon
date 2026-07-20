/**
 * Receiving service for Echelon WMS.
 *
 * Handles PO close (atomic inventory receipt via inventoryCore + channelSync),
 * bulk CSV import with fuzzy location matching, SKU hierarchy variant creation,
 * and receiving order state transitions.
 */

// ── Minimal dependency interfaces ───────────────────────────────────

type DrizzleDb = {
  execute: (query: any) => Promise<{ rows: any[] }>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

// Import sql tagged template for raw queries
import { sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import {
  millsToCents,
  centsToMills,
  dollarsToMills,
  perUnitMills,
} from "@shared/utils/money";
import {
  type ReceivingCloseReconciliation,
  type ReceivingReconciliationFailureReporter,
  reconcileLinkedPurchaseOrder,
} from "./receiving-orchestration.service";
import type { ReceiptReconciliationResult } from "./purchase-order-receipt-reconciliation.service";

interface InventoryCore {
  receiveInventory(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    referenceId: string;
    notes?: string;
    userId?: string;
    unitCostCents?: number;
    productCostCents?: number;
    packagingCostCents?: number;
    unitCostMills?: number;
    packagingCostMills?: number;
    landedCostMills?: number;
    receivingOrderId?: number;
    receivingLineId?: number;
    purchaseOrderId?: number;
    purchaseOrderLineId?: number;
    inboundShipmentId?: number;
    costProvisional?: number;
  }, tx?: any): Promise<void>;
  adjustInventory(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qtyDelta: number;
    reason: string;
    userId?: string;
  }): Promise<{ orphanedQty: number }>;
  withTx(tx: any): InventoryCore;
}

interface ChannelSync {
  queueSyncAfterInventoryChange(variantId: number): Promise<void>;
}

interface Purchasing {
  onReceivingOrderClosed(receivingOrderId: number, receivingLines: Array<{
    receivingLineId: number;
    purchaseOrderLineId?: number;
    receivedQty: number;
    damagedQty?: number;
    unitCost?: number;
    unitCostMills?: number;
  }>): Promise<ReceiptReconciliationResult | void>;
  // Typed-lines allocator (Option C, 2026-04-28). Returns per-product-line
  // landed unit cost after spreading non-product line totals
  // (discount / fee / tax / rebate / adjustment) across the product lines.
  // Used at receive time so inventory lots are stamped with the true
  // cost-per-unit, not the raw line cost. Returns null if the PO has no
  // typed-line allocation to apply (no non-product lines, or no products).
  getAllocatedLineCostsForPo?(poId: number): Promise<{
    perLine: Array<{
      purchaseOrderLineId: number;
      lineTotalCents: number;
      allocatedCents: number;
      landedLineTotalCents: number;
      landedUnitCostMills: number;
      landedUnitCostCents: number;
    }>;
    pooledCents: number;
    productSubtotalCents: number;
    unallocatedCents: number;
  }>;
}

interface ShipmentTracking {
  getLandedCostForPoLine(purchaseOrderLineId: number): Promise<number | null>;
  getLandedCostMillsForPoLine?(purchaseOrderLineId: number): Promise<number | null>;
}

interface Storage {
  // Receiving orders
  getReceivingOrderById(id: number, tx?: any): Promise<any>;
  getReceivingLines(orderId: number, tx?: any): Promise<any[]>;
  getReceivingLineById(lineId: number, tx?: any): Promise<any>;
  createReceivingLine(data: any, tx?: any): Promise<any>;
  deleteReceivingLine(lineId: number, tx?: any): Promise<boolean>;
  deleteReceivingOrder(orderId: number, tx?: any): Promise<boolean>;
  updateReceivingOrder(id: number, updates: any, tx?: any): Promise<any>;
  updateReceivingLine(lineId: number, updates: any, tx?: any): Promise<any>;
  bulkCreateReceivingLines(lines: any[], tx?: any): Promise<any[]>;
  // PO line lookup — used to pull the 4-decimal unit_cost_mills when
  // stamping per-unit cost on lots/receipts, so receive-time precision
  // matches the PO line (spec 2026-04-22).
  getPurchaseOrderLineById?(id: number, tx?: any): Promise<any>;
  getVendorById(id: number): Promise<any>;
  // Inventory lookups
  getProductVariantBySku(sku: string): Promise<any>;
  getProductVariantById(id: number): Promise<any>;
  getProductVariantsByProductId(productId: number): Promise<any[]>;
  getAllProductVariants(): Promise<any[]>;
  getProductBySku(sku: string): Promise<any>;
  createProduct(data: any): Promise<any>;
  createProductVariant(data: any): Promise<any>;
  // Location lookups
  getAllWarehouseLocations(): Promise<any[]>;
  getAllProductLocations(): Promise<any[]>;
  // Products
  getAllProducts(): Promise<any[]>;
  // Settings
  getSetting(key: string): Promise<string | null>;
}

// ── Error class ─────────────────────────────────────────────────────

export class ReceivingError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public details?: any,
  ) {
    super(message);
    this.name = "ReceivingError";
  }
}

export class ReceivingReconciliationError extends ReceivingError {
  constructor(message: string, details?: any) {
    super(message, 409, details);
    this.name = "ReceivingReconciliationError";
  }
}

const RECEIVING_ORDER_EDITABLE_FIELDS = new Set([
  "warehouseId",
  "receivingLocationId",
  "expectedDate",
  "notes",
]);

const RECEIVING_LINE_EDITABLE_FIELDS = new Set([
  "sku",
  "productName",
  "expectedQty",
  "receivedQty",
  "damagedQty",
  "productVariantId",
  "productId",
  "barcode",
  "unitCost",
  "unitCostMills",
  "putawayLocationId",
  "notes",
]);

function assertOnlyAllowedFields(
  input: Record<string, unknown>,
  allowed: Set<string>,
  subject: string,
): void {
  const rejected = Object.keys(input).filter((key) => !allowed.has(key));
  if (rejected.length > 0) {
    throw new ReceivingError(
      `${subject} contains fields that cannot be changed: ${rejected.join(", ")}`,
      400,
      { code: "INVALID_RECEIVING_MUTATION_FIELDS", rejectedFields: rejected },
    );
  }
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ReceivingError(`${field} must be a non-negative integer`, 400, {
      code: "INVALID_RECEIVING_QUANTITY",
      field,
      value,
    });
  }
  return parsed;
}

function normalizeOptionalPositiveId(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ReceivingError(`${field} must be a positive integer or null`, 400, {
      code: "INVALID_RECEIVING_REFERENCE",
      field,
      value,
    });
  }
  return parsed;
}

// ── Helper: resolve receiving-line unit cost (mills authoritative) ──

/**
 * Resolve a receiving line's per-unit cost to a (cents, mills) pair.
 *
 * Invariants (coding-standards.md Rule #3 — integer math only, no floats):
 *   * Mills is authoritative when present. Cents mirror is derived via
 *     `millsToCents` (half-up at the sub-cent boundary).
 *   * Never fabricates a value. Returns `{ cents: undefined, mills: undefined }`
 *     when no source is available, so the caller can decide whether to
 *     proceed (e.g. inventoryCore accepts undefined unitCostCents).
 *
 * Source priority:
 *   1. `line.unitCostMills` set on the receiving line → authoritative.
 *   2. `line.unitCost` (cents) set on the receiving line → derive mills
 *      exactly via `centsToMills` (1 cent = 100 mills, no rounding).
 *   3. Linked PO line (`purchase_order_lines`) — prefer `unitCostMills`,
 *      fall back to `unitCostCents`. Same derivation rules.
 *
 * Any thrown error from the storage lookup is swallowed and the pair
 * returns undefined/undefined so the caller can apply its own fallback
 * (landed cost, inventoryCore default). This matches the prior behavior.
 */
async function resolveReceivingLineCost(
  line: { unitCost?: number | null; unitCostMills?: number | null; purchaseOrderLineId?: number | null },
  storage: { getPurchaseOrderLineById?(id: number): Promise<any> },
): Promise<{ cents: number | undefined; mills: number | undefined; productCostCents?: number; packagingCostCents?: number }> {
  // 1. Explicit mills on the receiving line.
  if (
    typeof line.unitCostMills === "number" &&
    Number.isInteger(line.unitCostMills) &&
    line.unitCostMills >= 0
  ) {
    return { cents: millsToCents(line.unitCostMills), mills: line.unitCostMills };
  }

  // 2. Explicit cents on the receiving line — derive mills exactly.
  if (
    typeof line.unitCost === "number" &&
    Number.isInteger(line.unitCost) &&
    line.unitCost >= 0
  ) {
    return { cents: line.unitCost, mills: centsToMills(line.unitCost) };
  }

  // 3. Linked PO line — pull the 4-decimal mills (authoritative) or cents.
  //    Also extract per-unit product and packaging cost components so the
  //    lot can store them separately for full cost breakdown visibility.
  //    Defensive: only resolve against PRODUCT PO lines. Non-product lines
  //    (discount/fee/tax/rebate/adjustment, migration 0563) cannot be
  //    physically received; if a receipt line accidentally references one
  //    we'd rather return undefined and fall through to the caller's
  //    fallback than stamp bogus cost onto inventory.
  if (line.purchaseOrderLineId && typeof storage.getPurchaseOrderLineById === "function") {
    try {
      const poLine = await storage.getPurchaseOrderLineById(line.purchaseOrderLineId);
      if (poLine && ((poLine.lineType ?? "product") === "product")) {
        const qty = Number(poLine.orderQty) || 1;
        const productCostCents = qty > 0
          ? Math.round(Number(poLine.totalProductCostCents || 0) / qty)
          : 0;
        const packagingCostCents = qty > 0
          ? Math.round(Number(poLine.packagingCostCents || 0) / qty)
          : 0;

        if (
          typeof poLine.unitCostMills === "number" &&
          Number.isInteger(poLine.unitCostMills) &&
          poLine.unitCostMills >= 0
        ) {
          return {
            cents: millsToCents(poLine.unitCostMills),
            mills: poLine.unitCostMills,
            productCostCents,
            packagingCostCents,
          };
        }
        if (
          typeof poLine.unitCostCents === "number" &&
          Number.isInteger(poLine.unitCostCents) &&
          poLine.unitCostCents >= 0
        ) {
          return {
            cents: poLine.unitCostCents,
            mills: centsToMills(poLine.unitCostCents),
            productCostCents,
            packagingCostCents,
          };
        }
      }
    } catch {
      // Non-fatal — fall through so the caller can use its own fallback.
    }
  }

  return { cents: undefined, mills: undefined };
}

// Exported for unit tests.
export const __testing__ = { resolveReceivingLineCost };

// ── Helper: fuzzy location code matching ────────────────────────────

function normalizeLocationCode(input: string): string[] {
  const clean = input.trim().toUpperCase();
  const candidates = new Set<string>();
  candidates.add(clean);

  // Strip all hyphens
  candidates.add(clean.replace(/-/g, ""));

  // Zero-pad single-digit numeric segments
  const segments = clean.split("-");
  const padded = segments.map((seg) => {
    const num = parseInt(seg, 10);
    if (!isNaN(num) && seg === num.toString()) return num.toString().padStart(2, "0");
    return seg;
  });
  candidates.add(padded.join("-"));
  candidates.add(padded.join(""));

  // If no hyphens, insert at letter↔digit transitions: H6 → H-6, J1A → J-1-A
  if (!clean.includes("-")) {
    const withHyphens = clean
      .replace(/([A-Z])(\d)/g, "$1-$2")
      .replace(/(\d)([A-Z])/g, "$1-$2");
    candidates.add(withHyphens);
    // Also pad the hyphenated version
    const hSegments = withHyphens.split("-");
    const hPadded = hSegments.map((seg) => {
      const num = parseInt(seg, 10);
      if (!isNaN(num) && seg === num.toString()) return num.toString().padStart(2, "0");
      return seg;
    });
    candidates.add(hPadded.join("-"));
    candidates.add(hPadded.join(""));
  }

  return Array.from(candidates);
}

// ── Service class ───────────────────────────────────────────────────

export class ReceivingService {
  constructor(
    private db: DrizzleDb,
    private inventoryCore: InventoryCore,
    private channelSync: ChannelSync,
    private storage: Storage,
    private purchasing: Purchasing | null = null,
    private shipmentTracking: ShipmentTracking | null = null,
    private reconciliationFailureReporter: ReceivingReconciliationFailureReporter | null = null,
  ) {}

  private async lockReceivingOrder(tx: any, orderId: number): Promise<any> {
    const lockResult = await tx.execute(sql`
      SELECT id
      FROM procurement.receiving_orders
      WHERE id = ${orderId}
      FOR UPDATE
    `);
    if (!lockResult.rows?.[0]) {
      throw new ReceivingError("Receiving order not found", 404);
    }

    const order = await this.storage.getReceivingOrderById(orderId, tx);
    if (!order) {
      throw new ReceivingError("Receiving order not found", 404);
    }
    return order;
  }

  private assertReceivingOrderMutable(order: any): void {
    if (order.status === "closed" || order.status === "cancelled") {
      throw new ReceivingError(
        `Receiving order in '${order.status}' status is immutable`,
        409,
        { code: "RECEIVING_ORDER_IMMUTABLE", receivingOrderId: order.id, status: order.status },
      );
    }
  }

  private async lockReceivingLineAndOrder(tx: any, lineId: number): Promise<{ line: any; order: any }> {
    const identityResult = await tx.execute(sql`
      SELECT receiving_order_id
      FROM procurement.receiving_lines
      WHERE id = ${lineId}
    `);
    const receivingOrderId = Number(identityResult.rows?.[0]?.receiving_order_id);
    if (!Number.isInteger(receivingOrderId) || receivingOrderId <= 0) {
      throw new ReceivingError("Receiving line not found", 404);
    }

    const order = await this.lockReceivingOrder(tx, receivingOrderId);
    this.assertReceivingOrderMutable(order);
    const lineLockResult = await tx.execute(sql`
      SELECT id
      FROM procurement.receiving_lines
      WHERE id = ${lineId}
        AND receiving_order_id = ${receivingOrderId}
      FOR UPDATE
    `);
    if (!lineLockResult.rows?.[0]) {
      throw new ReceivingError("Receiving line not found", 404);
    }
    const line = await this.storage.getReceivingLineById(lineId, tx);
    if (!line) {
      throw new ReceivingError("Receiving line not found", 404);
    }
    return { line, order };
  }

  private async updateReceivingOrderTotals(orderId: number, tx: any): Promise<any[]> {
    const lines = await this.storage.getReceivingLines(orderId, tx);
    await this.storage.updateReceivingOrder(orderId, {
      expectedLineCount: lines.length,
      receivedLineCount: lines.filter((line: any) => (Number(line.receivedQty) || 0) > 0).length,
      expectedTotalUnits: lines.reduce(
        (sum: number, line: any) => sum + (Number(line.expectedQty) || 0),
        0,
      ),
      receivedTotalUnits: lines.reduce(
        (sum: number, line: any) => sum + (Number(line.receivedQty) || 0),
        0,
      ),
    }, tx);
    return lines;
  }

  private async reconcileLinkedPurchaseOrder(orderId: number, order: any, lines: any[], userId?: string | null) {
    return await reconcileLinkedPurchaseOrder({
      receivingOrderId: orderId,
      receivingOrder: order,
      receivingLines: lines,
      purchasing: this.purchasing,
      userId,
      recordReconciliationFailure: this.reconciliationFailureReporter,
    });
  }

  private buildCloseResult(
    order: any,
    lines: any[],
    putawayLocationIds?: number[],
    poReconciliation?: ReceivingCloseReconciliation,
  ) {
    const receivedLines = lines.filter((line: any) => (line.receivedQty || 0) > 0);
    const locationIds = putawayLocationIds ?? Array.from(new Set(
      receivedLines
        .map((line: any) => line.putawayLocationId)
        .filter((id: any) => typeof id === "number"),
    ));

    return {
      success: true,
      order,
      linesProcessed: order.receivedLineCount ?? receivedLines.length,
      unitsReceived: order.receivedTotalUnits ?? receivedLines.reduce(
        (sum: number, line: any) => sum + (line.receivedQty || 0),
        0,
      ),
      putawayLocationIds: locationIds,
      poReconciliation,
    };
  }

  private getClosedReceivingLineStatus(line: any): "complete" | "overage" | "short" {
    const expectedQty = Number(line.expectedQty) || 0;
    const receivedQty = Number(line.receivedQty) || 0;

    if (expectedQty > 0 && receivedQty < expectedQty) return "short";
    if (expectedQty > 0 && receivedQty > expectedQty) return "overage";
    return "complete";
  }

  private async getZeroPostSummary(receivingOrderId: number, executor: { execute: (query: any) => Promise<{ rows: any[] }> }) {
    const result = await executor.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM procurement.receiving_lines WHERE receiving_order_id = ${receivingOrderId}) AS line_count,
        (SELECT COALESCE(SUM(expected_qty), 0)::int FROM procurement.receiving_lines WHERE receiving_order_id = ${receivingOrderId}) AS expected_qty,
        (SELECT COALESCE(SUM(received_qty), 0)::int FROM procurement.receiving_lines WHERE receiving_order_id = ${receivingOrderId}) AS received_qty,
        (SELECT COUNT(*)::int FROM procurement.po_receipts WHERE receiving_order_id = ${receivingOrderId}) AS po_receipt_count,
        (SELECT COUNT(*)::int FROM inventory.inventory_lots WHERE receiving_order_id = ${receivingOrderId}) AS inventory_lot_count,
        (
          SELECT COUNT(*)::int
          FROM inventory.inventory_transactions
          WHERE receiving_order_id = ${receivingOrderId}
            AND voided_at IS NULL
        ) AS inventory_transaction_count
    `);
    const row = result.rows?.[0] ?? {};
    return {
      lineCount: Number(row.line_count ?? 0),
      expectedQty: Number(row.expected_qty ?? 0),
      receivedQty: Number(row.received_qty ?? 0),
      poReceiptCount: Number(row.po_receipt_count ?? 0),
      inventoryLotCount: Number(row.inventory_lot_count ?? 0),
      inventoryTransactionCount: Number(row.inventory_transaction_count ?? 0),
    };
  }

  // ─── Discard Draft ──────────────────────────────────────────

  /**
   * Permanently discard a draft receiving order before any receive activity.
   *
   * Business rules (Rule #7 — single transaction):
   *   1. Order must be in 'draft' status — 409 otherwise.
   *   2. No receiving line may have receivedQty > 0 — 409 otherwise.
   *   3. Delete lines + order atomically.
   *   4. If linked to a PO, append an audit row to po_status_history
   *      (Rule #8 — who/what/when, fromStatus = toStatus = current physical
   *      status so the track does not change, only the notes document the
   *      discard event).
   */
  async discardDraftReceivingOrder(
    receivingOrderId: number,
    userId?: string,
  ): Promise<void> {
    // Lock, validate, delete, and audit as one transaction so a concurrent
    // open or line receipt cannot pass the checks and then be deleted.
    await this.db.transaction(async (tx) => {
      const order = await this.lockReceivingOrder(tx, receivingOrderId);
      if (order.status !== "draft") {
        throw new ReceivingError("Cannot discard a started receipt", 409);
      }

      const lines = await this.storage.getReceivingLines(receivingOrderId, tx);
      if (lines.some((line: any) => (Number(line.receivedQty) || 0) > 0)) {
        throw new ReceivingError(
          "Receipt has received quantities; cannot discard",
          409,
        );
      }

      // Explicit line deletion before order (defense-in-depth; the DB
      // schema also has ON DELETE CASCADE but we make the intent clear).
      await tx.execute(sql`
        DELETE FROM procurement.receiving_lines
        WHERE receiving_order_id = ${receivingOrderId}
      `);

      await tx.execute(sql`
        DELETE FROM procurement.receiving_orders
        WHERE id = ${receivingOrderId}
      `);

      // Audit: write a po_status_history row so PO history shows the
      // receipt was created and discarded (Rule #8).
      if ((order as any).purchaseOrderId) {
        const poId: number = (order as any).purchaseOrderId;
        const poRows = await tx.execute(sql`
          SELECT physical_status, status
          FROM procurement.purchase_orders
          WHERE id = ${poId}
        `);
        const po = poRows.rows[0];
        if (po) {
          const physicalStatus: string =
            (po as any).physical_status ?? (po as any).status ?? "draft";
          const receiptNumber: string =
            (order as any).receiptNumber ?? `RCV-${receivingOrderId}`;
          await tx.execute(sql`
            INSERT INTO procurement.po_status_history
              (purchase_order_id, from_status, to_status, changed_by, notes)
            VALUES (
              ${poId},
              ${physicalStatus},
              ${physicalStatus},
              ${userId ?? null},
              ${`Receipt ${receiptNumber} discarded before save`}
            )
          `);
        }
      }
    });
  }

  /**
   * Void a closed receipt only when it has no operational or financial posting.
   *
   * This is deliberately narrower than reopening any closed receipt: once
   * inventory lots, inventory transactions, or PO receipt ledger rows exist,
   * corrections must happen through explicit adjustment documents.
   */
  async voidZeroPostClosedReceivingOrder(
    receivingOrderId: number,
    userId?: string,
  ): Promise<{
    success: true;
    receivingOrderId: number;
    receiptNumber: string | null;
    previousStatus: string;
    status: "cancelled";
    lineCount: number;
    expectedQty: number;
  }> {
    if (!Number.isInteger(receivingOrderId) || receivingOrderId <= 0) {
      throw new ReceivingError("Invalid receiving order id", 400, {
        code: "INVALID_RECEIVING_ORDER_ID",
        receivingOrderId,
      });
    }

    return await this.db.transaction(async (tx) => {
      const orderRows = await tx.execute(sql`
        SELECT id, receipt_number, status, purchase_order_id
        FROM procurement.receiving_orders
        WHERE id = ${receivingOrderId}
        FOR UPDATE
      `);
      const order = orderRows.rows?.[0];
      if (!order) throw new ReceivingError("Receiving order not found", 404);
      if (order.status !== "closed") {
        throw new ReceivingError("Only closed zero-post receipts can be voided by this recovery action", 409, {
          code: "RECEIPT_NOT_CLOSED",
          receivingOrderId,
          status: order.status,
        });
      }

      const summary = await this.getZeroPostSummary(receivingOrderId, tx);
      const hasPostedEffects =
        summary.receivedQty > 0 ||
        summary.poReceiptCount > 0 ||
        summary.inventoryLotCount > 0 ||
        summary.inventoryTransactionCount > 0;
      if (summary.lineCount === 0 || hasPostedEffects) {
        throw new ReceivingError("Receipt has posted receiving activity and cannot be voided by zero-post recovery", 409, {
          code: "RECEIPT_HAS_POSTED_EFFECTS",
          receivingOrderId,
          summary,
        });
      }

      await tx.execute(sql`
        UPDATE procurement.receiving_lines
        SET status = 'cancelled',
            updated_at = NOW()
        WHERE receiving_order_id = ${receivingOrderId}
      `);

      const note = `Zero-post closed receipt voided${userId ? ` by ${userId}` : ""}; no inventory lots, inventory transactions, or PO receipts existed.`;
      const updatedRows = await tx.execute(sql`
        UPDATE procurement.receiving_orders
        SET status = 'cancelled',
            notes = CASE
              WHEN notes IS NULL OR notes = '' THEN ${note}
              ELSE notes || E'\n' || ${note}
            END,
            updated_at = NOW()
        WHERE id = ${receivingOrderId}
        RETURNING id, receipt_number, status
      `);

      const poId = Number(order.purchase_order_id);
      if (Number.isInteger(poId) && poId > 0) {
        const poRows = await tx.execute(sql`
          SELECT physical_status, status
          FROM procurement.purchase_orders
          WHERE id = ${poId}
        `);
        const po = poRows.rows?.[0];
        const physicalStatus = String(po?.physical_status ?? po?.status ?? "draft");
        await tx.execute(sql`
          INSERT INTO procurement.po_status_history
            (purchase_order_id, from_status, to_status, changed_by, notes)
          VALUES (
            ${poId},
            ${physicalStatus},
            ${physicalStatus},
            ${userId ?? null},
            ${`Receipt ${order.receipt_number ?? receivingOrderId} voided as zero-post closed recovery`}
          )
        `);
      }

      const updated = updatedRows.rows?.[0] ?? {};
      return {
        success: true,
        receivingOrderId,
        receiptNumber: updated.receipt_number ?? order.receipt_number ?? null,
        previousStatus: "closed",
        status: "cancelled",
        lineCount: summary.lineCount,
        expectedQty: summary.expectedQty,
      };
    });
  }

  // ─── Open ─────────────────────────────────────────────────────

  async updateOrderDetails(orderId: number, input: Record<string, unknown>) {
    assertOnlyAllowedFields(input, RECEIVING_ORDER_EDITABLE_FIELDS, "Receiving order update");
    if (Object.keys(input).length === 0) {
      throw new ReceivingError("Receiving order update requires at least one field", 400);
    }

    const updates: Record<string, unknown> = { ...input };
    if ("warehouseId" in updates) {
      updates.warehouseId = normalizeOptionalPositiveId(updates.warehouseId, "warehouseId");
    }
    if ("receivingLocationId" in updates) {
      updates.receivingLocationId = normalizeOptionalPositiveId(
        updates.receivingLocationId,
        "receivingLocationId",
      );
    }
    if (typeof updates.expectedDate === "string") {
      const expectedDate = new Date(updates.expectedDate);
      if (Number.isNaN(expectedDate.getTime())) {
        throw new ReceivingError("expectedDate must be a valid date", 400);
      }
      updates.expectedDate = expectedDate;
    }

    return await this.db.transaction(async (tx) => {
      const order = await this.lockReceivingOrder(tx, orderId);
      this.assertReceivingOrderMutable(order);
      return await this.storage.updateReceivingOrder(orderId, updates, tx);
    });
  }

  async addLine(orderId: number, input: Record<string, unknown>) {
    assertOnlyAllowedFields(input, RECEIVING_LINE_EDITABLE_FIELDS, "Receiving line create");
    const lineData = this.normalizeLineMutation(input, null);

    const result = await this.db.transaction(async (tx) => {
      const order = await this.lockReceivingOrder(tx, orderId);
      this.assertReceivingOrderMutable(order);
      const line = await this.storage.createReceivingLine({
        ...lineData,
        receivingOrderId: orderId,
        status: this.receivingLineStatus(
          Number(lineData.receivedQty) || 0,
          Number(lineData.expectedQty) || 0,
        ),
      }, tx);
      const lines = await this.updateReceivingOrderTotals(orderId, tx);
      const updatedOrder = await this.storage.getReceivingOrderById(orderId, tx);
      return { order: updatedOrder, lines, line };
    });

    const vendor = result.order?.vendorId
      ? await this.storage.getVendorById(result.order.vendorId)
      : null;
    return { ...result.order, lines: result.lines, vendor };
  }

  async updateLine(lineId: number, input: Record<string, unknown>) {
    assertOnlyAllowedFields(input, RECEIVING_LINE_EDITABLE_FIELDS, "Receiving line update");
    if (Object.keys(input).length === 0) {
      throw new ReceivingError("Receiving line update requires at least one field", 400);
    }

    return await this.db.transaction(async (tx) => {
      const { line } = await this.lockReceivingLineAndOrder(tx, lineId);
      const updates = this.normalizeLineMutation(input, line);
      if ("receivedQty" in updates || "expectedQty" in updates) {
        updates.status = this.receivingLineStatus(
          Number(updates.receivedQty ?? line.receivedQty) || 0,
          Number(updates.expectedQty ?? line.expectedQty) || 0,
        );
      }
      const updated = await this.storage.updateReceivingLine(lineId, updates, tx);
      await this.updateReceivingOrderTotals(line.receivingOrderId, tx);
      return updated;
    });
  }

  async deleteLine(lineId: number): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      const { line } = await this.lockReceivingLineAndOrder(tx, lineId);
      const deleted = await this.storage.deleteReceivingLine(lineId, tx);
      if (deleted) {
        await this.updateReceivingOrderTotals(line.receivingOrderId, tx);
      }
      return deleted;
    });
  }

  async deleteOrder(orderId: number): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      const order = await this.lockReceivingOrder(tx, orderId);
      this.assertReceivingOrderMutable(order);
      return await this.storage.deleteReceivingOrder(orderId, tx);
    });
  }

  private normalizeLineMutation(
    input: Record<string, unknown>,
    existing: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = { ...input };
    for (const field of ["expectedQty", "receivedQty", "damagedQty"] as const) {
      if (field in normalized) {
        normalized[field] = requireNonNegativeInteger(normalized[field], field);
      }
    }
    for (const field of ["productVariantId", "productId", "putawayLocationId"] as const) {
      if (field in normalized) {
        normalized[field] = normalizeOptionalPositiveId(normalized[field], field);
      }
    }
    for (const field of ["unitCost", "unitCostMills"] as const) {
      if (field in normalized && normalized[field] !== null) {
        normalized[field] = requireNonNegativeInteger(normalized[field], field);
      }
    }
    if (existing && "productVariantId" in normalized && existing.putawayComplete === 1) {
      throw new ReceivingError("A put-away receiving line cannot change its product variant", 409, {
        code: "PUTAWAY_RECEIVING_LINE_IMMUTABLE",
        receivingLineId: existing.id,
      });
    }
    return normalized;
  }

  private receivingLineStatus(receivedQty: number, expectedQty: number): string {
    if (receivedQty === 0) return "pending";
    if (receivedQty < expectedQty) return "partial";
    if (receivedQty === expectedQty) return "complete";
    return "overage";
  }

  async open(orderId: number, userId: string | null) {
    const { order, updated } = await this.db.transaction(async (tx) => {
      const lockedOrder = await this.lockReceivingOrder(tx, orderId);
      if (lockedOrder.status !== "draft") {
        throw new ReceivingError("Can only open orders in draft status");
      }
      const opened = await this.storage.updateReceivingOrder(orderId, {
        status: "open",
        receivedBy: userId,
        receivedDate: new Date(),
      }, tx);
      return { order: lockedOrder, updated: opened };
    });

    const lines = await this.storage.getReceivingLines(orderId);
    const vendor = order.vendorId ? await this.storage.getVendorById(order.vendorId) : null;
    return { ...updated, lines, vendor };
  }

  // ─── Close ────────────────────────────────────────────────────

  async close(orderId: number, userId: string | null, options: { allowOverReceipt?: boolean } = {}) {
    let order = await this.storage.getReceivingOrderById(orderId);
    if (!order) throw new ReceivingError("Receiving order not found", 404);
    if (order.status === "cancelled") {
      throw new ReceivingError("Order already cancelled");
    }

    if (order.status === "closed") {
      const closedLines = await this.storage.getReceivingLines(orderId);
      const poReconciliation = await this.reconcileLinkedPurchaseOrder(orderId, order, closedLines, userId);
      return this.buildCloseResult(order, closedLines, undefined, poReconciliation);
    }

    let lines = await this.storage.getReceivingLines(orderId);
    if (
      order.sourceType === "shipment" &&
      lines.length > 0 &&
      lines.every((line: any) => (Number(line.receivedQty) || 0) <= 0)
    ) {
      throw new ReceivingError(
        "Shipment receipts cannot be finalized with zero received quantity. Enter received quantities or void the zero-post receipt.",
        409,
        {
          code: "ZERO_SHIPMENT_RECEIPT_NOT_CLOSABLE",
          receivingOrderId: orderId,
          expectedLineCount: lines.length,
          expectedTotalUnits: lines.reduce((sum: number, line: any) => sum + (Number(line.expectedQty) || 0), 0),
        },
      );
    }

    // Over-receipt guard (shipment receipts): receiving more than a shipment
    // line expects usually means the overage belongs to ANOTHER PO on the same
    // shipment, or the PO quantity itself was entered wrong. Warn-with-override:
    // the client shows the discrepancy and retries with allowOverReceipt once
    // the operator confirms. Blind/PO-direct receipts are exempt — their
    // expected quantities are advisory.
    if (order.sourceType === "shipment" && !options.allowOverReceipt) {
      const overLines = lines
        .filter((line: any) => (Number(line.receivedQty) || 0) > (Number(line.expectedQty) || 0))
        .map((line: any) => ({
          lineId: line.id,
          sku: line.sku ?? null,
          expectedQty: Number(line.expectedQty) || 0,
          receivedQty: Number(line.receivedQty) || 0,
        }));
      if (overLines.length > 0) {
        throw new ReceivingError(
          "Received quantity exceeds what this shipment expects for this PO. The overage may belong to another PO on this shipment, or the PO quantity is wrong. Confirm to close anyway.",
          409,
          {
            code: "SHIPMENT_OVER_RECEIPT_CONFIRMATION_REQUIRED",
            receivingOrderId: orderId,
            overLines,
          },
        );
      }
    }

    // Auto-resolve missing productVariantId from SKU before processing
    for (const line of lines) {
      if (line.receivedQty > 0 && !line.productVariantId && line.sku) {
        const variant = await this.storage.getProductVariantBySku(line.sku);
        if (variant) {
          await this.updateLine(line.id, { productVariantId: variant.id });
          (line as any).productVariantId = variant.id;
        }
      }
    }

    // Auto-resolution above may have changed line identity. Refresh the close
    // snapshot before entering the transaction so the locked comparison below
    // can detect only genuinely concurrent edits.
    order = await this.storage.getReceivingOrderById(orderId);
    lines = await this.storage.getReceivingLines(orderId);

    // Block close if any received lines are still missing required data
    const unresolvable = lines.filter((l: any) => l.receivedQty > 0 && (!l.productVariantId || !l.putawayLocationId));
    if (unresolvable.length > 0) {
      const issues = unresolvable.map((l: any) => ({
        lineId: l.id,
        sku: l.sku || "(no SKU)",
        missingVariant: !l.productVariantId,
        missingLocation: !l.putawayLocationId,
      }));
      throw new ReceivingError(
        `${unresolvable.length} received line(s) cannot be processed`,
        400,
        { issues, hint: "Link SKUs to product variants and assign putaway locations before closing." },
      );
    }

    // Process each line using inventoryCore (atomic, transaction-wrapped)
    const batchId = `RCV-${orderId}-${Date.now()}`;
    let totalReceived = 0;
    let linesReceived = 0;
    const receivedVariantIds = new Set<number>();
    const putawayLocationIds = new Set<number>();

    const closeResult = await this.db.transaction(async (tx) => {
      const lockedOrder = await this.lockReceivingOrder(tx, orderId);
      if (lockedOrder.status === "cancelled") {
        throw new ReceivingError("Order already cancelled");
      }
      if (lockedOrder.status === "closed") {
        return { updated: lockedOrder, replayed: true };
      }
      if (new Date(order.updatedAt).getTime() !== new Date(lockedOrder.updatedAt).getTime()) {
        throw new ReceivingError(
          "Receiving order changed while close was starting. Review the current receipt and retry.",
          409,
          { code: "RECEIVING_CLOSE_SNAPSHOT_CHANGED", receivingOrderId: orderId },
        );
      }
      order = lockedOrder;

      const lockedLines = await this.storage.getReceivingLines(orderId, tx);
      const snapshotVersion = lines.map((line: any) => `${line.id}:${new Date(line.updatedAt).getTime()}`).join("|");
      const lockedVersion = lockedLines.map((line: any) => `${line.id}:${new Date(line.updatedAt).getTime()}`).join("|");
      if (snapshotVersion !== lockedVersion) {
        throw new ReceivingError(
          "Receiving lines changed while close was starting. Review the current receipt and retry.",
          409,
          { code: "RECEIVING_CLOSE_SNAPSHOT_CHANGED", receivingOrderId: orderId },
        );
      }
      lines = lockedLines;

      for (const line of lines) {
      if (line.receivedQty > 0 && line.productVariantId && line.putawayLocationId) {
        const qtyToAdd = line.receivedQty;

        // Determine unit cost: landed cost (if finalized) > receiving line
        // override > PO line cost.
        //
        // Precision: mills (4-decimal) is authoritative whenever present —
        // from either the receiving_line itself (manual override) or the
        // linked PO line. Cents is derived via millsToCents (half-up) so
        // downstream consumers that only speak cents stay correct.
        //
        // We resolve BOTH cents and mills up front so we can also persist
        // the mills value back on the receiving_line row after successful
        // receive. Today (pre-0562) only cents was stamped; mills makes
        // $0.0375 survive round-trip for damaged-unit / freight-allocation
        // overrides where the PO line isn't the right source.
        const resolved = await resolveReceivingLineCost(line, this.storage as any);
        let unitCostCents = resolved.cents;
        let unitCostMills = resolved.mills;
        const packagingCostCents = resolved.packagingCostCents ?? 0;
        let costProvisional = 0;
        const parsedInboundShipmentId = Number(order.inboundShipmentId);
        const inboundShipmentId =
          Number.isInteger(parsedInboundShipmentId) && parsedInboundShipmentId > 0
            ? parsedInboundShipmentId
            : undefined;

        if (line.purchaseOrderLineId && this.shipmentTracking) {
          try {
            const landedCostCents = await this.shipmentTracking.getLandedCostForPoLine(line.purchaseOrderLineId);
            const landedCostMills =
              this.shipmentTracking.getLandedCostMillsForPoLine
                ? await this.shipmentTracking.getLandedCostMillsForPoLine(line.purchaseOrderLineId)
                : null;
            if (landedCostCents !== null || landedCostMills !== null) {
              // Keep the legacy cents mirror when shipment tracking has it,
              // and preserve exact mills when finalized allocation data can reconstruct it.
              unitCostMills =
                landedCostMills !== null
                  ? landedCostMills
                  : centsToMills(landedCostCents!);
              unitCostCents =
                landedCostCents !== null
                  ? landedCostCents
                  : millsToCents(unitCostMills);
            } else if (inboundShipmentId) {
              // Shipment exists but costs not finalized - mark provisional.
              costProvisional = 1;
            }
          } catch {
            // Landed-cost lookup failure should not make a shipment-linked
            // receipt look final. Keep the PO/line cost, but mark it provisional.
            if (inboundShipmentId) {
              costProvisional = 1;
            }
          }
        } else if (inboundShipmentId) {
          // Receiving order linked to shipment but no tracking service - mark provisional.
          costProvisional = 1;
        }

        // Typed-lines allocator (Option C, 2026-04-28).
        //
        // If shipment-tracking didn't supply a landed cost AND the linked
        // PO has typed non-product lines (discount / fee / tax / rebate /
        // adjustment), spread those across the product lines and use the
        // resulting landed unit cost. This makes COGS, margin, and
        // inventory valuation correct for domestic POs that don't run
        // through a formal inbound shipment.
        //
        // Skip if shipment-tracking already wrote a landed cost (its
        // freight/duty allocation is more authoritative for international
        // POs that run through a real shipment). Skip if there's no
        // purchasing service, no PO line link, or no PO id known.
        if (
          line.purchaseOrderLineId &&
          costProvisional === 0 &&
          this.purchasing?.getAllocatedLineCostsForPo &&
          (!this.shipmentTracking ||
            // No shipment landed cost was applied above. We re-resolve here
            // by checking whether the cost we have right now matches the
            // shipment-tracking output — simpler: just always run if no
            // shipment is linked.
            !order.inboundShipmentId)
        ) {
          try {
            const poLine =
              typeof (this.storage as any).getPurchaseOrderLineById === "function"
                ? await (this.storage as any).getPurchaseOrderLineById(
                    line.purchaseOrderLineId,
                  )
                : null;
            const poId = poLine?.purchaseOrderId;
            if (poId) {
              const allocation = await this.purchasing.getAllocatedLineCostsForPo(poId);
              const match = allocation.perLine.find(
                (p) => p.purchaseOrderLineId === line.purchaseOrderLineId,
              );
              // Only override when the allocation actually changed the cost
              // (i.e. the PO has non-zero pooledCents). Avoids unnecessary
              // writes on simple product-only POs.
              if (
                match &&
                allocation.pooledCents !== 0 &&
                allocation.unallocatedCents === 0
              ) {
                unitCostCents = match.landedUnitCostCents;
                unitCostMills = match.landedUnitCostMills;
              }
            }
          } catch {
            // Non-critical — leave existing PO/line cost in place.
          }
        }

        // Lots store quantity in the receiving variant's OWN units (e.g. cases), so the
        // cost booked on the lot is per that unit. Cost is carried in MILLS so the
        // per-unit × pack-size scale never amplifies cent rounding (the old cents × upv
        // turned a sub-cent per-piece rounding into real dollars on large packs).
        const upvRow = await tx.execute(sql`
          SELECT units_per_variant FROM catalog.product_variants WHERE id = ${line.productVariantId}
        `);
        const unitsPerVariant = Math.max(1, Number((upvRow.rows?.[0] as any)?.units_per_variant) || 1);

        // Pull the PO line so we can cost the lot EXACTLY from its totals when this is a
        // plain PO receipt (no receiving-line override, no landed/typed adjustment).
        let lotPoLine: any = null;
        if (line.purchaseOrderLineId && typeof (this.storage as any).getPurchaseOrderLineById === "function") {
          try { lotPoLine = await (this.storage as any).getPurchaseOrderLineById(line.purchaseOrderLineId); }
          catch { lotPoLine = null; }
        }
        const lineQty = Number(lotPoLine?.orderQty) || 0;
        const lineProductCents = Number(lotPoLine?.totalProductCostCents || 0);
        const linePackagingCents = Number(lotPoLine?.packagingCostCents || 0);
        const isProductPoLine = (lotPoLine?.lineType ?? "product") === "product";
        // The per-unit mills the PO line itself implies. If the resolved blend equals
        // this, nothing overrode the PO cost, so we can decompose straight from totals.
        const poDerivedMills = (lineQty > 0 && isProductPoLine)
          ? perUnitMills((lineProductCents + linePackagingCents) * 100, lineQty)
          : undefined;

        let lotUnitCostMills: number | undefined;
        let lotPackagingCostMills = 0;
        if (poDerivedMills != null && typeof unitCostMills === "number" && unitCostMills === poDerivedMills) {
          // EXACT path: derive the lot's per-variant-unit cost from PO line TOTALS, so a
          // 150-piece, $118 line received as 3 Cases-of-50 values to exactly $118 once
          // valuation reads mills — no per-piece pre-rounding amplified by the pack size.
          lotPackagingCostMills = perUnitMills(linePackagingCents * 100 * unitsPerVariant, lineQty);
          const lotProductMills = perUnitMills(lineProductCents * 100 * unitsPerVariant, lineQty);
          lotUnitCostMills = lotProductMills + lotPackagingCostMills;
        } else if (typeof unitCostMills === "number") {
          // Receiving-line override, finalized landed cost, typed-line allocation, or a
          // manual receipt: scale the resolved per-unit mills by the pack size. Still
          // mills (not cents), so no rounding amplification.
          lotUnitCostMills = unitCostMills * unitsPerVariant;
          lotPackagingCostMills = (typeof packagingCostCents === "number" ? centsToMills(packagingCostCents) : 0) * unitsPerVariant;
        }
        const lotUnitCostCents = lotUnitCostMills != null ? millsToCents(lotUnitCostMills) : undefined;

        await this.inventoryCore.receiveInventory({
          productVariantId: line.productVariantId,
          warehouseLocationId: line.putawayLocationId,
          qty: qtyToAdd,
          referenceId: batchId,
          notes: `Received from ${order.sourceType === "po" ? `PO ${order.poNumber}` : order.receiptNumber}`,
          userId: userId || undefined,
          unitCostCents: lotUnitCostCents,
          unitCostMills: lotUnitCostMills,
          packagingCostMills: lotPackagingCostMills,
          receivingOrderId: orderId,
          receivingLineId: line.id,
          purchaseOrderId: order.purchaseOrderId || undefined,
          purchaseOrderLineId: line.purchaseOrderLineId || undefined,
          inboundShipmentId,
          costProvisional,
        }, tx);

        // Mark line as put away and persist the resolved PER-PIECE (base-unit) cost
        // on the receiving_line — that's the PO/AP unit, so the line still reconciles
        // against the PO line cost (unchanged from before this fix). The LOT above is
        // stamped per VARIANT unit (× units_per_variant) for valuation/COGS; line and
        // lot are intentionally in different units. Only write when resolved
        // (don't overwrite null → 0 on a costless receipt).
        const lineUpdates: Record<string, unknown> = {
          putawayComplete: 1,
          status: this.getClosedReceivingLineStatus(line),
        };
        if (typeof unitCostCents === "number") {
          lineUpdates.unitCost = unitCostCents;
        }
        if (typeof unitCostMills === "number") {
          lineUpdates.unitCostMills = unitCostMills;
        }
        await this.storage.updateReceivingLine(line.id, lineUpdates, tx);

        totalReceived += qtyToAdd;
        linesReceived++;
        receivedVariantIds.add(line.productVariantId);
        putawayLocationIds.add(line.putawayLocationId);
      }
    }

    for (const line of lines) {
      if ((Number(line.receivedQty) || 0) > 0) continue;
      const status = this.getClosedReceivingLineStatus(line);
      if (line.status !== status) {
        await this.storage.updateReceivingLine(line.id, { status }, tx);
      }
    }

    // NOTE: cases are intentionally NOT auto-broken into base units on receipt.
    // ATP already pools every variant of a product into one fungible base-unit
    // quantity at query time (atp.service.ts getTotalBaseUnits:
    // SUM(variant_qty * units_per_variant)), then derives each variant's
    // sellable qty as floor(atpBase / unitsPerVariant). So receiving 10 cases
    // makes both 10 cases AND 100 eaches sellable from the same pool without
    // any physical break. Auto-breaking would zero the case level (destroying
    // case-level granularity we actually use), churn extra ledger rows, and
    // smear case cost to per-each at receive time. Real breaks are deliberate
    // physical events driven through break-assembly.use-cases.ts, not a side
    // effect of receiving.

      // Update order totals and close
      const updated = await this.storage.updateReceivingOrder(orderId, {
        status: "closed",
        closedDate: new Date(),
        closedBy: userId,
        receivedLineCount: linesReceived,
        receivedTotalUnits: totalReceived,
      }, tx);
      return { updated, replayed: false };
    });

    const updated = closeResult.updated;

    // Queue channel publication only after the inventory/receiving transaction
    // commits. The durable inventory ledger remains authoritative if a channel
    // enqueue fails and the operator-visible sync monitor can retry it.
    for (const variantId of Array.from(receivedVariantIds)) {
      this.channelSync.queueSyncAfterInventoryChange(variantId).catch((err: any) =>
        console.warn(`[ChannelSync] Post-receive sync failed for variant ${variantId}:`, err),
      );
    }

    const closedLines = await this.storage.getReceivingLines(orderId);
    const poReconciliation = await this.reconcileLinkedPurchaseOrder(orderId, updated, closedLines, userId);

    return this.buildCloseResult(
      updated,
      closedLines,
      Array.from(putawayLocationIds),
      poReconciliation,
    );
  }

  // ─── Complete All Lines ───────────────────────────────────────

  async completeAllLines(orderId: number) {
    const { updated, updatedLines, order } = await this.db.transaction(async (tx) => {
      const lockedOrder = await this.lockReceivingOrder(tx, orderId);
      this.assertReceivingOrderMutable(lockedOrder);
      const lines = await this.storage.getReceivingLines(orderId, tx);
      if (!lines || lines.length === 0) {
        throw new ReceivingError("No lines found for this order", 404);
      }

      let updatedCount = 0;
      for (const line of lines) {
        if (line.status !== "complete") {
          const effectiveQty = (line.receivedQty != null && line.receivedQty > 0)
            ? line.receivedQty
            : (line.expectedQty || 0);
          await this.storage.updateReceivingLine(line.id, {
            receivedQty: effectiveQty,
            status: "complete",
          }, tx);
          updatedCount++;
        }
      }

      const currentLines = await this.updateReceivingOrderTotals(orderId, tx);
      const currentOrder = await this.storage.getReceivingOrderById(orderId, tx);
      return { updated: updatedCount, updatedLines: currentLines, order: currentOrder };
    });

    // Return enriched order
    const vendor = order?.vendorId ? await this.storage.getVendorById(order.vendorId) : null;
    return { message: `Completed ${updated} lines`, updated, order: { ...order, lines: updatedLines, vendor } };
  }

  // ─── Create Variant From Line ─────────────────────────────────

  async createVariantFromLine(lineId: number) {
    const line = await this.db.transaction(async (tx) => {
      const locked = await this.lockReceivingLineAndOrder(tx, lineId);
      return locked.line;
    });
    if (!line) throw new ReceivingError("Receiving line not found", 404);
    if (!line.sku) throw new ReceivingError("Line has no SKU");
    if (line.productVariantId) throw new ReceivingError("Line already has a linked product variant");

    const variantPattern = /^(.+)-(P|B|C)(\d+)$/i;
    const match = line.sku.match(variantPattern);

    let baseSku: string;
    let variantType: string;
    let unitsPerVariant: number;
    let hierarchyLevel: number;
    let variantName: string;

    if (match) {
      baseSku = match[1].toUpperCase();
      variantType = match[2].toUpperCase();
      unitsPerVariant = parseInt(match[3], 10);
      hierarchyLevel = variantType === "P" ? 1 : variantType === "B" ? 2 : 3;
      const typeName = variantType === "P" ? "Pack" : variantType === "B" ? "Box" : "Case";
      variantName = `${typeName} of ${unitsPerVariant}`;
    } else {
      // Standalone SKU — single unit
      baseSku = line.sku.toUpperCase();
      variantType = "EA";
      unitsPerVariant = 1;
      hierarchyLevel = 1;
      variantName = "Each";
    }

    // Find or create the parent product
    let product = await this.storage.getProductBySku(baseSku);
    if (!product) {
      product = await this.storage.createProduct({
        sku: baseSku,
        name: baseSku,
        baseUnit: "EA",
      });
    }

    // Create the variant
    let variant;
    try {
      variant = await this.storage.createProductVariant({
        productId: product.id,
        sku: line.sku.toUpperCase(),
        name: variantName,
        unitsPerVariant,
        hierarchyLevel,
      });
    } catch (error: any) {
      if (error.code === "23505" || error.message?.includes("unique")) {
        throw new ReceivingError("A variant with this SKU already exists. Use the search to link it instead.", 409);
      }
      throw error;
    }

    // Link the variant to the receiving line
    const updatedLine = await this.updateLine(lineId, {
      productVariantId: variant.id,
      productName: `${product.name} — ${variantName}`,
    });

    return {
      line: updatedLine,
      product: { id: product.id, sku: product.sku, name: product.name },
      variant: { id: variant.id, sku: variant.sku, name: variant.name, unitsPerVariant: variant.unitsPerVariant },
    };
  }

  // ─── Bulk Import Lines (CSV) ──────────────────────────────────

  async bulkImportLines(
    orderId: number,
    lines: Array<{
      sku?: string;
      qty?: string | number;
      location?: string;
      damaged_qty?: string | number;
      unit_cost?: string | number;
      barcode?: string;
      notes?: string;
    }>,
    userId: string | null,
  ) {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new ReceivingError("Lines array is required");
    }

    // Check setting for multiple SKUs per bin
    const allowMultipleSkusSetting = await this.storage.getSetting("allow_multiple_skus_per_bin");
    const allowMultipleSkus = allowMultipleSkusSetting !== "false"; // Default to true

    // Pre-fetch product locations if we need to validate bin occupancy
    let existingProductLocations: any[] = [];
    if (!allowMultipleSkus) {
      existingProductLocations = await this.storage.getAllProductLocations();
    }

    // Fetch existing lines for this order to enable idempotent imports (update vs create)
    const existingLines = await this.storage.getReceivingLines(orderId);
    const existingBySkuLocation = new Map(
      existingLines
        .filter((l: any) => l.sku)
        .map((l: any) => {
          const locationId = l.putawayLocationId || "none";
          return [`${l.sku!.toUpperCase()}|${locationId}`, l];
        }),
    );

    const linesToCreate: any[] = [];
    const linesToUpdate: { id: number; updates: any }[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    // Get the receipt's warehouseId to filter locations
    const receipt = await this.storage.getReceivingOrderById(orderId);
    if (!receipt) {
      throw new ReceivingError("Receiving order not found", 404);
    }
    this.assertReceivingOrderMutable(receipt);
    const receiptWarehouseId = receipt?.warehouseId ?? null;

    // Pre-fetch warehouse locations — filter by receipt's warehouse when set
    const allWarehouseLocations = await this.storage.getAllWarehouseLocations();
    const filteredLocations = receiptWarehouseId
      ? allWarehouseLocations.filter((l: any) => l.warehouseId === receiptWarehouseId)
      : allWarehouseLocations;
    const locationByCode = new Map(filteredLocations.map((l: any) => [l.code.toUpperCase().trim(), l]));
    const locationByName = new Map(
      filteredLocations
        .filter((l: any) => l.name)
        .map((l: any) => [l.name!.toUpperCase().trim(), l]),
    );
    // Normalized index: stripped hyphens → location (for fuzzy matching)
    const locationByNormalized = new Map<string, any>();
    for (const loc of filteredLocations) {
      const stripped = (loc as any).code.toUpperCase().replace(/-/g, "");
      if (!locationByNormalized.has(stripped)) {
        locationByNormalized.set(stripped, loc);
      }
    }

    // Pre-fetch products for efficient lookup
    const allProducts = await this.storage.getAllProducts();
    const productBySku = new Map(
      allProducts
        .filter((p: any) => p.sku)
        .map((p: any) => [p.sku!.toUpperCase(), p]),
    );

    // Pre-fetch product_variants for efficient lookup (source of truth)
    const allProductVariants = await this.storage.getAllProductVariants();
    const productVariantBySku = new Map(
      allProductVariants
        .filter((v: any) => v.sku)
        .map((v: any) => [v.sku!.toUpperCase(), v]),
    );

    for (const line of lines) {
      const { sku, qty, location, damaged_qty, unit_cost, barcode, notes } = line;

      if (!sku) {
        errors.push("Missing SKU in line");
        continue;
      }

      // Source of truth: product_variants (sellable SKUs with product linkage)
      const lookupKey = sku.toUpperCase();
      const productVariant = productVariantBySku.get(lookupKey);
      const product = productBySku.get(lookupKey);

      let productVariantId: number | null = null;
      let productId: number | null = null;
      let productName = sku;
      let productBarcode = barcode || null;

      if (productVariant) {
        productVariantId = productVariant.id;
        productName = productVariant.name;
        if (!productBarcode && productVariant.barcode) {
          productBarcode = productVariant.barcode;
        }
        if (product) productId = product.id;
      } else if (product) {
        productId = product.id;
        productName = product.name;
        warnings.push(`SKU ${sku} found in products but not in product_variants - please set up variant hierarchy`);
      } else {
        warnings.push(`SKU ${sku} not found in products - inventory will not be updated on close`);
      }

      // Look up location: exact code → exact name → normalized/fuzzy
      let putawayLocationId = null;
      let csvLocationRaw: string | null = null;
      if (location) {
        const cleanLocation = location.trim().toUpperCase();
        csvLocationRaw = location.trim();
        let loc = locationByCode.get(cleanLocation);
        let matchMethod = "exact";

        if (!loc) {
          loc = locationByName.get(cleanLocation);
          if (loc) matchMethod = "name";
        }

        // Fuzzy matching: try normalized candidate codes
        if (!loc) {
          const candidates = normalizeLocationCode(cleanLocation);
          for (const candidate of candidates) {
            loc = locationByCode.get(candidate);
            if (loc) {
              matchMethod = "normalized";
              break;
            }
            const stripped = candidate.replace(/-/g, "");
            loc = locationByNormalized.get(stripped);
            if (loc) {
              matchMethod = "fuzzy";
              break;
            }
          }
        }

        if (loc) {
          putawayLocationId = loc.id;
          if (matchMethod !== "exact") {
            warnings.push(`Location "${location}" auto-matched to "${loc.code}" (${matchMethod})`);
          }

          // Check if bin is already occupied by a different SKU
          if (!allowMultipleSkus) {
            const existingInBin = existingProductLocations.find(
              (pl: any) =>
                pl.location?.trim().toUpperCase() === loc!.code.toUpperCase() &&
                pl.sku?.toUpperCase() !== sku.toUpperCase(),
            );
            if (existingInBin) {
              errors.push(`Bin ${loc.code} already contains SKU ${existingInBin.sku} - cannot add ${sku} (multiple SKUs per bin is disabled)`);
              continue;
            }
          }
        } else {
          warnings.push(`Location "${location}" not found for SKU ${sku} - needs manual resolution`);
        }
      }

      // Parse numeric values.
      //
      // Unit cost is parsed at 4-decimal (mills) precision and then mirrored
      // to cents via millsToCents (half-up). Integer math throughout (Rule
      // #3: no floating point on the money path). `dollarsToMills` rejects
      // negatives and non-numeric input — we fall back to null on parse
      // error rather than failing the whole CSV row, and surface it as a
      // warning; the Decimal path is kept as a defensive fallback for cents
      // so we preserve prior behavior if mills parsing somehow rejects a
      // value that Decimal accepts.
      const parsedQty = parseInt(String(qty)) || 0;
      const parsedDamagedQty = parseInt(String(damaged_qty)) || 0;
      let parsedUnitCostMills: number | null = null;
      let parsedUnitCost: number | null = null;
      if (unit_cost !== undefined && unit_cost !== null && String(unit_cost).trim() !== "") {
        try {
          parsedUnitCostMills = dollarsToMills(String(unit_cost));
          parsedUnitCost = millsToCents(parsedUnitCostMills);
        } catch (err: any) {
          warnings.push(`SKU ${sku}: invalid unit_cost "${unit_cost}" — ignored (${err?.message || "parse error"})`);
          parsedUnitCostMills = null;
          // Defensive: try the cents-only Decimal path as a last resort so
          // we don't regress CSVs that worked pre-mills. Still no floats:
          // Decimal.times(100).round() returns an integer.
          try {
            parsedUnitCost = new Decimal(String(unit_cost)).times(100).round().toNumber();
            if (!Number.isInteger(parsedUnitCost) || parsedUnitCost < 0) parsedUnitCost = null;
          } catch {
            parsedUnitCost = null;
          }
        }
      }

      // Build notes: append CSV location if unmatched for resolution UI
      let lineNotes = notes || null;
      if (csvLocationRaw && !putawayLocationId) {
        lineNotes = lineNotes ? `${lineNotes} | CSV location: ${csvLocationRaw}` : `CSV location: ${csvLocationRaw}`;
      }

      // Check if line with same SKU + Location already exists in this order (idempotent import)
      const uniqueKey = `${sku.toUpperCase()}|${putawayLocationId || "none"}`;
      const existingLine = existingBySkuLocation.get(uniqueKey);
      if (existingLine) {
        linesToUpdate.push({
          id: existingLine.id,
          updates: {
            productName,
            barcode: productBarcode,
            expectedQty: parsedQty,
            receivedQty: parsedQty,
            damagedQty: parsedDamagedQty,
            unitCost: parsedUnitCost,
            unitCostMills: parsedUnitCostMills,
            productVariantId,
            productId,
            putawayLocationId,
            notes: lineNotes,
            status: putawayLocationId ? "complete" : "pending",
            receivedBy: userId,
            receivedAt: new Date(),
          },
        });
      } else {
        linesToCreate.push({
          receivingOrderId: orderId,
          sku: sku.toUpperCase(),
          productName,
          barcode: productBarcode,
          expectedQty: parsedQty,
          receivedQty: parsedQty,
          damagedQty: parsedDamagedQty,
          unitCost: parsedUnitCost,
          unitCostMills: parsedUnitCostMills,
          productVariantId,
          productId,
          putawayLocationId,
          notes: lineNotes,
          status: putawayLocationId ? "complete" : "pending",
          receivedBy: userId,
          receivedAt: new Date(),
        });
      }
    }

    const created = await this.db.transaction(async (tx) => {
      const lockedOrder = await this.lockReceivingOrder(tx, orderId);
      this.assertReceivingOrderMutable(lockedOrder);
      if (new Date(lockedOrder.updatedAt).getTime() !== new Date(receipt.updatedAt).getTime()) {
        throw new ReceivingError(
          "Receiving order changed while the import was being prepared. Review the current receipt and retry.",
          409,
          { code: "RECEIVING_IMPORT_SNAPSHOT_CHANGED", receivingOrderId: orderId },
        );
      }

      for (const item of linesToUpdate) {
        await this.storage.updateReceivingLine(item.id, item.updates, tx);
      }
      const inserted = await this.storage.bulkCreateReceivingLines(linesToCreate, tx);
      await this.updateReceivingOrderTotals(orderId, tx);
      return inserted;
    });

    return {
      success: true,
      created: created.length,
      updated: linesToUpdate.length,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}

// ── Factory function ────────────────────────────────────────────────

export function createReceivingService(
  db: DrizzleDb,
  inventoryCore: InventoryCore,
  channelSync: ChannelSync,
  storage: Storage,
  purchasing?: Purchasing | null,
  shipmentTracking?: ShipmentTracking | null,
  reconciliationFailureReporter?: ReceivingReconciliationFailureReporter | null,
) {
  return new ReceivingService(
    db,
    inventoryCore,
    channelSync,
    storage,
    purchasing ?? null,
    shipmentTracking ?? null,
    reconciliationFailureReporter ?? null,
  );
}
