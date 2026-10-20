import { enqueueReceiptCostRequests, processReceiptCostRequests } from "./receipt-cost-queue.service";
import { RECEIPT_COST_RECOVERY_ACTOR } from "./receipt-cost-recovery.domain";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { readReceivingSourceResolution, validateReceivingLocations, type ReceivingIntegrityTransaction } from "./receiving-close-integrity.repository";
import {
  assertNoReceivingCustodyHistory, assertReceivingQuarantineLineEditable,
  readReceiptCustodyPresence, completeReceivingQuarantineAcceptances,
} from "./receiving-quarantine.repository";
import { lockReceivingCustodyFence } from "./receiving-custody-public";
import { receivingQuarantineSourceVersion } from "./receiving-quarantine-receiving.port";
import { ReceivingQuarantineError } from "./domain/receiving-quarantine";
import type {
  ReviewQuarantineIntakeInput, ReviewedQuarantineIntake, PrepareReceivingQuarantineAcceptanceInput,
  PreparedReceivingQuarantineAcceptance,
} from "./receiving-quarantine-receiving.port";
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
import { receivingLineStatus } from "./domain/receiving-line-status";
import { receivingImportRowSchema } from "@shared/procurement/receiving-import";
import { planReceivingImportIdentities } from "./domain/receiving-import-identity";
import { canonicalJson } from "@shared/utils/canonical-json";
import { convertReceiptCounts, receiptInteger, receivingUnitVersion, withReceivingUnitVersion } from "./receiving-unit-contract";
import { Decimal } from "decimal.js";
import { resolveReceiptCostEvidence } from "./receipt-cost-evidence.service";
import {
  millsToCents,
  centsToMills,
  dollarsToMills,
  perUnitMills,
} from "@shared/utils/money";
import {
  type ReceivingCloseReconciliation,
  type ReceivingReconciliationFailureReporter,
  type ReceivingOrchestrationPurchasing,
  reconcileLinkedPurchaseOrder,
} from "./receiving-orchestration.service";

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
    unitsPerVariantSnapshot?: number;
    inboundShipmentLineId?: number;
    costRecordedAt?: Date;
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

interface Purchasing extends ReceivingOrchestrationPurchasing {
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

interface ApprovedInvoiceCostReconciler {
  reconcilePurchaseOrderLine(
    purchaseOrderLineId: number,
    tx: any,
    actorId?: string,
  ): Promise<unknown>;
}

// Spec D, Part 2: receive-time validation warnings. Evaluated after a
// successful close; the reporter persists them (PO exceptions pattern).
// Evaluation failures must never fail the close — warnings are advisory.
export interface ReceiveWarningEvaluator {
  evaluateOrder(receivingOrderId: number): Promise<Array<{
    kind: string;
    severity: "warn" | "error";
    receivingLineId: number;
    purchaseOrderLineId?: number;
    title: string;
    detail: string;
    payload: Record<string, unknown>;
  }>>;
}

export type ReceiveWarningReporter = (input: {
  receivingOrderId: number;
  purchaseOrderId: number | null;
  warnings: Array<{
    kind: string;
    severity: "warn" | "error";
    receivingLineId: number;
    purchaseOrderLineId?: number;
    title: string;
    detail: string;
    payload: Record<string, unknown>;
  }>;
  userId?: string | null;
}) => Promise<unknown>;

interface Storage {
  // Receiving orders
  getReceivingOrderById(id: number, tx?: any): Promise<any>;
  getReceivingLines(orderId: number, tx?: any): Promise<any[]>;
  generateReceiptNumber(tx?: any): Promise<string>;
  createReceivingOrder(data: any, tx?: any): Promise<any>;
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
  getProductVariantById(id: number, tx?: any): Promise<any>;
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

const RECEIVING_ORDER_CREATE_FIELDS = new Set([
  "sourceType",
  "vendorId",
  "warehouseId",
  "poNumber",
  "asnNumber",
  "expectedDate",
  "notes",
]);

const RECEIVING_SOURCE_TYPES = new Set(["po", "asn", "blind", "initial_load"]);

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

/** Include every persisted field: equal timestamps do not prove equal state. */
function receivingLinesSnapshot(lines: readonly { id: number }[]): string {
  return canonicalJson([...lines].sort((left, right) => left.id - right.id));
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

function normalizeOptionalString(value: unknown, field: string, maxLength?: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new ReceivingError(`${field} must be a string or null`, 400, {
      code: "INVALID_RECEIVING_TEXT",
      field,
      value,
    });
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (maxLength !== undefined && normalized.length > maxLength) {
    throw new ReceivingError(`${field} cannot exceed ${maxLength} characters`, 400, {
      code: "INVALID_RECEIVING_TEXT",
      field,
      maxLength,
    });
  }
  return normalized;
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
    private approvedInvoiceCostReconciler: ApprovedInvoiceCostReconciler | null = null,
    private receiveWarningEvaluator: ReceiveWarningEvaluator | null = null,
    private receiveWarningReporter: ReceiveWarningReporter | null = null,
    private readonly clock: () => Date = () => new Date(),
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
    if (order.purchaseOrderId) {
      await tx.execute(sql`SELECT id FROM procurement.purchase_orders WHERE id = ${order.purchaseOrderId} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM procurement.purchase_order_lines WHERE purchase_order_id = ${order.purchaseOrderId} ORDER BY id FOR UPDATE`);
    }
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

  private async reconcileLinkedPurchaseOrder(orderId: number, order: any, lines: any[], userId?: string | null,
    transaction?: { executor: ReceivingIntegrityTransaction; recordedAt: Date }) {
    return await reconcileLinkedPurchaseOrder({
      receivingOrderId: orderId,
      receivingOrder: order,
      receivingLines: lines,
      purchasing: this.purchasing,
      userId,
      recordReconciliationFailure: this.reconciliationFailureReporter,
      transaction,
    });
  }

  private async validateLocations(tx: ReceivingIntegrityTransaction, order: { id: number; warehouseId?: number | null; receivingLocationId?: number | null },
    lines: readonly { id?: number; putawayLocationId?: number | null }[]): Promise<void> {
    const references = lines.filter((line) => line.putawayLocationId != null)
      .map((line) => ({ receivingLineId: line.id, locationId: line.putawayLocationId! }));
    await validateReceivingLocations(tx, { receivingOrderId: order.id, warehouseId: order.warehouseId ?? null,
      references: [...references, ...(order.receivingLocationId ? [{ locationId: order.receivingLocationId }] : [])] });
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
   *   2. No counts, putaway activity, or custody history — 409 otherwise.
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
    if (!Number.isSafeInteger(receivingOrderId) || receivingOrderId <= 0) {
      throw new ReceivingError("A positive receiving order ID is required", 400, {
        code: "RECEIVING_ORDER_ID_INVALID",
      });
    }
    // Both deletion endpoints use this owner. The header lock is also taken by
    // open/count/close commands, so validation and deletion cannot race them.
    await this.db.transaction(async (tx) => {
      const order = await this.lockReceivingOrder(tx, receivingOrderId);
      this.assertReceivingOrderMutable(order);
      if (order.status !== "draft") {
        throw new ReceivingError("Cannot discard a started receipt", 409, {
          code: "RECEIVING_DISCARD_STARTED", receivingOrderId, status: order.status,
        });
      }
      await assertNoReceivingCustodyHistory(tx, { receivingOrderId });

      const lines = await this.storage.getReceivingLines(receivingOrderId, tx);
      // Null is the pre-count value on legacy rows. Any nonzero or malformed
      // count must remain reviewable rather than disappearing with the draft.
      const hasCount = (value: unknown): boolean => value != null && value !== 0;
      if (lines.some((line: { receivedQty: unknown; damagedQty: unknown; putawayComplete: unknown }) =>
        hasCount(line.receivedQty) || hasCount(line.damagedQty) || hasCount(line.putawayComplete))) {
        throw new ReceivingError(
          "Receipt has received or damaged quantities or putaway activity; cannot discard",
          409,
          { code: "RECEIVING_DISCARD_ACTIVITY_EXISTS", receivingOrderId },
        );
      }
      const discardedAt = this.clock();
      await tx.execute(sql`
        INSERT INTO public.audit_events (timestamp, level, actor, action, target, changes, context)
        VALUES (${discardedAt}, 'AUDIT', ${userId ?? null}, 'procurement.receiving.discard', ${`receiving-order:${receivingOrderId}`},
          ${JSON.stringify({ before: { order, lines }, after: null })}::jsonb,
          ${JSON.stringify({ receivingOrderId, purchaseOrderId: order.purchaseOrderId ?? null })}::jsonb)
      `);

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
          // Match Drizzle's UTC timestamp-without-zone mapping; binding a raw
          // Date through pg would otherwise use the host's local wall clock.
          await tx.execute(sql`
            INSERT INTO procurement.po_status_history
              (purchase_order_id, from_status, to_status, changed_by, changed_at, notes)
            VALUES (
              ${poId},
              ${physicalStatus},
              ${physicalStatus},
              ${userId ?? null},
              ${discardedAt.toISOString()}::timestamp,
              ${`Unused draft receipt ${receiptNumber} discarded`}
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

      await assertNoReceivingCustodyHistory(tx, { receivingOrderId });

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

  // ─── Create and edit ──────────────────────────────────────────

  /** Internal composition boundary: the custody owner already owns the cost
   * graph and commits the observation together with this explicit recount. */
  async reviewQuarantineIntakeInTransaction(tx: ReceivingIntegrityTransaction, input: ReviewQuarantineIntakeInput,
    actorId: string, recordedAt: Date): Promise<ReviewedQuarantineIntake> {
    this.assertQuarantineAuditContext(actorId, recordedAt);
    receiptInteger(input.receivingOrderId, "Receiving order ID", true);
    receiptInteger(input.receivingLineId, "Receiving line ID", true);
    receiptInteger(input.acceptedQty, "Accepted quantity");
    receiptInteger(input.heldQty, "Held quantity", true);
    const { line, order } = await this.lockReceivingLineAndOrder(tx, input.receivingLineId);
    if (order.id !== input.receivingOrderId) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_SOURCE_MISMATCH",
      "The receiving line does not belong to this receipt.");
    await assertReceivingQuarantineLineEditable(tx, line.id, ["receivedQty", "damagedQty"]);
    if (receivingUnitVersion(line) !== input.expectedUnitVersion) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_STALE",
      "Receipt counts or units changed. Refresh and review accepted and held quantities again.");
    if (!line.productVariantId || line.unitsPerVariantSnapshot == null) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_UNIT_REQUIRED",
      "Confirm the recorded receive unit before separating accepted and held goods.");
    // Resolve legacy source links before making the observation immutable.
    // Held goods are physical evidence even when acceptedQty is zero.
    if (order.purchaseOrderId) {
      await tx.execute(sql`SELECT id FROM procurement.purchase_orders WHERE id=${order.purchaseOrderId} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM procurement.purchase_order_lines WHERE purchase_order_id=${order.purchaseOrderId} ORDER BY id FOR UPDATE`);
    }
    const variant = await this.loadReceiveVariant(tx, line.productVariantId, line.productId);
    if (variant.unitsPerVariant !== line.unitsPerVariantSnapshot) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_UNIT_CHANGED",
      "The catalog pack changed. Review the receive unit before recording quarantine.");
    this.validateReceiptBaseCounts({ ...line, receivedQty: input.acceptedQty, damagedQty: input.heldQty }, variant.unitsPerVariant);
    await this.validateLocations(tx, order, [{ putawayLocationId: input.holdingLocationId }]);
    await this.assertReceiptSourceProduct(tx, line, order, variant.productId);
    const sources = await readReceivingSourceResolution(tx, { receivingOrderId: order.id,
      purchaseOrderId: order.purchaseOrderId ?? null, inboundShipmentId: order.inboundShipmentId ?? null,
      lines: [{ id: line.id, productId: variant.productId, purchaseOrderLineId: line.purchaseOrderLineId ?? null,
        inboundShipmentLineId: line.inboundShipmentLineId ?? null, receivedQty: input.acceptedQty, damagedQty: input.heldQty }] });
    const resolved = sources.find(source => source.receivingLineId === line.id);
    const updated = await this.storage.updateReceivingLine(line.id, {
      productId: variant.productId, receivedQty: input.acceptedQty, damagedQty: 0, updatedAt: recordedAt,
      purchaseOrderLineId: resolved?.purchaseOrderLineId ?? line.purchaseOrderLineId ?? null,
      inboundShipmentLineId: resolved?.inboundShipmentLineId ?? line.inboundShipmentLineId ?? null,
      status: this.receivingLineStatus(input.acceptedQty, line.expectedQty),
    }, tx);
    await this.updateReceivingOrderTotals(order.id, tx);
    await tx.execute(sql`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
      VALUES(${recordedAt},'AUDIT',${actorId},'procurement.receiving.quarantine_recount',${`receiving-line:${line.id}`},
        ${JSON.stringify({ before: line, after: updated })}::jsonb,
        ${JSON.stringify({ receivingOrderId: order.id, reviewedAcceptedQty: input.acceptedQty, reviewedHeldQty: input.heldQty })}::jsonb)`);
    return { order, lineBefore: line, lineAfter: updated, productId: variant.productId,
      productVariantId: variant.id, unitsPerVariantSnapshot: variant.unitsPerVariant };
  }

  /** Prepare a dedicated, protected normal receipt line. No quantity, lot,
   * valuation, PO receipt, supplier credit or publication is posted here. */
  async prepareQuarantineAcceptanceInTransaction(tx: ReceivingIntegrityTransaction, input: PrepareReceivingQuarantineAcceptanceInput,
    actorId: string, recordedAt: Date): Promise<PreparedReceivingQuarantineAcceptance> {
    this.assertQuarantineAuditContext(actorId, recordedAt);
    receiptInteger(input.sourceReceivingOrderId, "Source receiving order ID", true);
    receiptInteger(input.acceptedVariantQty, "Accepted receive quantity", true);
    receiptInteger(input.expectedUnitsPerVariant, "Reviewed receive pack size", true);
    receiptInteger(input.observationId, "Quarantine observation ID", true);
    const orderIds = [...new Set([input.sourceReceivingOrderId, input.targetReceivingOrderId].filter((id): id is number => id !== null))].sort((a, b) => a-b);
    const orders = new Map<number, any>();
    for (const id of orderIds) {
      receiptInteger(id, "Receiving order ID", true);
      orders.set(id, await this.lockReceivingOrder(tx, id));
    }
    const source = orders.get(input.sourceReceivingOrderId)!;
    if (source.status === "cancelled") throw new ReceivingQuarantineError("RECEIVING_CUSTODY_SOURCE_CANCELLED",
      "The quarantine source receipt is cancelled. Review its history before accepting goods.");
    let target = input.targetReceivingOrderId === null ? source : orders.get(input.targetReceivingOrderId)!;
    if (input.targetReceivingOrderId !== null) this.assertReceivingOrderMutable(target);
    const createsReceipt = input.targetReceivingOrderId === null && source.status === "closed";
    if (!createsReceipt) this.assertReceivingOrderMutable(target);
    receiptInteger(input.targetSourceReceivingLineId, "Reviewed source receiving line ID", true);
    await tx.execute(sql`SELECT id FROM procurement.receiving_lines WHERE id=${input.targetSourceReceivingLineId}
      AND receiving_order_id=${target.id} FOR UPDATE`);
    const templateLine = await this.storage.getReceivingLineById(input.targetSourceReceivingLineId, tx);
    if (!templateLine || templateLine.receivingOrderId !== target.id ||
      receivingQuarantineSourceVersion(templateLine) !== input.expectedTargetUnitVersion) {
      throw new ReceivingQuarantineError("RECEIVING_CUSTODY_TARGET_CHANGED",
        "The selected receiving source changed. Refresh and review its exact line and units before accepting quarantine.");
    }
    const priorAcceptance = await tx.execute(sql`SELECT id FROM procurement.receiving_quarantine_acceptances
      WHERE receiving_line_id=${templateLine.id} LIMIT 1`);
    if (priorAcceptance.rows.length > 0) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_TARGET_PROTECTED",
      "This line already records a quarantine acceptance. Select an original reviewed receiving source instead.");
    if (templateLine.productVariantId !== input.productVariantId ||
      templateLine.unitsPerVariantSnapshot !== input.expectedUnitsPerVariant ||
      (templateLine.purchaseOrderLineId ?? null) !== input.purchaseOrderLineId ||
      (templateLine.inboundShipmentLineId ?? null) !== input.inboundShipmentLineId) {
      throw new ReceivingQuarantineError("RECEIVING_CUSTODY_TARGET_CHANGED",
        "The reviewed receive unit and purchase/shipment source must match the selected receiving line.");
    }
    if (!source.warehouseId || target.warehouseId !== source.warehouseId) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_WAREHOUSE_MISMATCH",
      "Accept quarantined goods into a receipt in their recorded warehouse. A warehouse transfer is a separate action.");
    if (target.purchaseOrderId && input.purchaseOrderLineId === null) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_PURCHASE_SOURCE_REQUIRED",
      "Select the exact purchase line before accepting quarantined goods into this receipt.");
    if ((!target.purchaseOrderId && input.purchaseOrderLineId !== null) ||
      (!target.inboundShipmentId && input.inboundShipmentLineId !== null) ||
      (target.inboundShipmentId && input.inboundShipmentLineId === null)) {
      throw new ReceivingQuarantineError("RECEIVING_CUSTODY_SOURCE_MISMATCH",
        "Select a receipt and exact purchase/shipment lines that belong to the same source.");
    }
    if (target.purchaseOrderId) {
      await tx.execute(sql`SELECT id FROM procurement.purchase_orders WHERE id=${target.purchaseOrderId} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM procurement.purchase_order_lines WHERE purchase_order_id=${target.purchaseOrderId} ORDER BY id FOR UPDATE`);
    }
    const variant = await this.loadReceiveVariant(tx, input.productVariantId);
    if (variant.unitsPerVariant !== input.expectedUnitsPerVariant) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_UNIT_CHANGED",
      "The selected catalog pack changed. Review the acceptance conversion again.");
    const counts = { expectedQty: input.acceptedVariantQty, receivedQty: input.acceptedVariantQty, damagedQty: 0 };
    this.validateReceiptBaseCounts(counts, variant.unitsPerVariant);
    await this.validateLocations(tx, target, [{ putawayLocationId: input.putawayLocationId }]);
    const sourceLine = { id: 0, productId: variant.productId, purchaseOrderLineId: input.purchaseOrderLineId,
      inboundShipmentLineId: input.inboundShipmentLineId, ...counts };
    await this.assertReceiptSourceProduct(tx, sourceLine, target, variant.productId);
    await readReceivingSourceResolution(tx, { receivingOrderId: target.id, purchaseOrderId: target.purchaseOrderId ?? null,
      inboundShipmentId: target.inboundShipmentId ?? null, lines: [sourceLine] });
    if (createsReceipt) {
      if (target.inboundShipmentId && target.purchaseOrderId) {
        const active = await tx.execute(sql`SELECT id FROM procurement.receiving_orders
          WHERE inbound_shipment_id=${target.inboundShipmentId} AND purchase_order_id=${target.purchaseOrderId}
            AND status IN ('draft','open','receiving','verified') ORDER BY id`);
        if (active.rows.length > 0) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_TARGET_REQUIRED",
          "An active receipt already exists for this shipment. Select that receipt before preparing acceptance.", 409,
          { receivingOrderIds: active.rows.map((row) => (row as { id: number }).id) });
      }
      target = await this.storage.createReceivingOrder({
        receiptNumber: await this.storage.generateReceiptNumber(tx), sourceType: source.sourceType,
        vendorId: source.vendorId ?? null, warehouseId: source.warehouseId,
        poNumber: source.poNumber ?? null, purchaseOrderId: source.purchaseOrderId ?? null,
        inboundShipmentId: source.inboundShipmentId ?? null, asnNumber: source.asnNumber ?? null,
        status: "draft", createdBy: actorId, createdAt: recordedAt, updatedAt: recordedAt,
        notes: `Acceptance from quarantine observation ${input.observationId}. ${input.reason}`,
      }, tx);
    }
    const catalogVariant = await this.storage.getProductVariantById(variant.id, tx);
    const unitCostMills = templateLine.unitCostMills == null ? null : requireNonNegativeInteger(templateLine.unitCostMills, "Reviewed unit cost mills");
    const unitCost = templateLine.unitCost == null ? null : requireNonNegativeInteger(templateLine.unitCost, "Reviewed unit cost cents");
    if (unitCostMills !== null && unitCost !== null && millsToCents(unitCostMills) !== unitCost) {
      throw new ReceivingQuarantineError("RECEIVING_CUSTODY_COST_REVIEW_REQUIRED",
        "The selected receipt line's cost amounts disagree. Correct its source cost before preparing acceptance.");
    }
    const line = await this.storage.createReceivingLine({
      receivingOrderId: target.id, productId: variant.productId, productVariantId: variant.id,
      sku: catalogVariant?.sku ?? null, productName: catalogVariant?.name ?? null,
      unitsPerVariantSnapshot: variant.unitsPerVariant, ...counts,
      purchaseOrderLineId: input.purchaseOrderLineId, inboundShipmentLineId: input.inboundShipmentLineId,
      putawayLocationId: input.putawayLocationId, putawayComplete: 0, status: "complete",
      // Copy reviewed per-piece evidence exactly. The ordinary close owner
      // resolves confirmed PO sources; manual/legacy evidence stays provisional.
      unitCost, unitCostMills, costSourceKind: templateLine.costSourceKind ?? null,
      costSourceEvidence: templateLine.costSourceEvidence ?? null,
      notes: `Prepared from quarantine observation ${input.observationId}. ${input.reason}`,
      createdAt: recordedAt, updatedAt: recordedAt,
    }, tx);
    await this.updateReceivingOrderTotals(target.id, tx);
    await tx.execute(sql`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
      VALUES(${recordedAt},'AUDIT',${actorId},'procurement.receiving.quarantine_acceptance_prepared',${`receiving-line:${line.id}`},
        ${JSON.stringify({ before: null, after: line })}::jsonb,
        ${JSON.stringify({ observationId: input.observationId, sourceReceivingOrderId: source.id, receivingOrderId: target.id })}::jsonb)`);
    return { receivingOrderId: target.id, receivingLineId: line.id, productId: variant.productId,
      productVariantId: variant.id, unitsPerVariantSnapshot: variant.unitsPerVariant, acceptedVariantQty: input.acceptedVariantQty };
  }

  /** Only the custody owner may cancel its locked, unposted acceptance. Keep
   * the source line and FK history; a zero count cannot become available stock. */
  async cancelQuarantineAcceptanceInTransaction(tx: ReceivingIntegrityTransaction,
    input: { receivingOrderId: number; receivingLineId: number; acceptanceId: number }, actorId: string, recordedAt: Date): Promise<void> {
    this.assertQuarantineAuditContext(actorId, recordedAt);
    const { line, order } = await this.lockReceivingLineAndOrder(tx, input.receivingLineId);
    if (order.id !== input.receivingOrderId || line.putawayComplete === 1) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_ACCEPTANCE_POSTED",
      "This acceptance has already been posted or changed source. Use the recorded receipt correction workflow.");
    const acceptance = await tx.execute(sql`SELECT id FROM procurement.receiving_quarantine_acceptances
      WHERE id=${input.acceptanceId} AND receiving_order_id=${order.id} AND receiving_line_id=${line.id}
        AND status='awaiting_receipt' FOR UPDATE`);
    if (acceptance.rows.length !== 1) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_ACCEPTANCE_CHANGED",
      "The prepared acceptance changed. Refresh quarantine before cancelling it.");
    const updated = await this.storage.updateReceivingLine(line.id, {
      receivedQty: 0, expectedQty: 0, damagedQty: 0, status: "pending", updatedAt: recordedAt,
    }, tx);
    await this.updateReceivingOrderTotals(order.id, tx);
    await tx.execute(sql`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
      VALUES(${recordedAt},'AUDIT',${actorId},'procurement.receiving.quarantine_acceptance_cancelled',${`receiving-line:${line.id}`},
        ${JSON.stringify({ before: line, after: updated })}::jsonb,
        ${JSON.stringify({ acceptanceId: input.acceptanceId, receivingOrderId: order.id })}::jsonb)`);
  }

  private assertQuarantineAuditContext(actorId: string, recordedAt: Date): void {
    if (!actorId?.trim() || actorId !== actorId.trim() || actorId.length > 100 ||
      !(recordedAt instanceof Date) || !Number.isFinite(recordedAt.getTime())) {
      throw new ReceivingQuarantineError("RECEIVING_CUSTODY_AUDIT_REQUIRED", "A verified actor and valid time are required for custody changes.", 400);
    }
  }

  async createOrder(input: Record<string, unknown>, userId?: string | null) {
    assertOnlyAllowedFields(input, RECEIVING_ORDER_CREATE_FIELDS, "Receiving order create");

    const sourceType = normalizeOptionalString(input.sourceType, "sourceType", 20) ?? "blind";
    if (!RECEIVING_SOURCE_TYPES.has(sourceType)) {
      throw new ReceivingError(`Unsupported receiving source type: ${sourceType}`, 400, {
        code: "INVALID_RECEIVING_SOURCE_TYPE",
        sourceType,
      });
    }

    const expectedDate = input.expectedDate === null || input.expectedDate === undefined || input.expectedDate === ""
      ? null
      : new Date(input.expectedDate as any);
    if (expectedDate && Number.isNaN(expectedDate.getTime())) {
      throw new ReceivingError("expectedDate must be a valid date", 400);
    }

    const normalized = {
      sourceType,
      vendorId: normalizeOptionalPositiveId(input.vendorId, "vendorId"),
      warehouseId: normalizeOptionalPositiveId(input.warehouseId, "warehouseId"),
      poNumber: normalizeOptionalString(input.poNumber, "poNumber", 100),
      asnNumber: normalizeOptionalString(input.asnNumber, "asnNumber", 100),
      expectedDate,
      notes: normalizeOptionalString(input.notes, "notes"),
      status: "draft",
      createdBy: userId ?? null,
    };

    let receiptNumber: string | null = null;
    try {
      return await this.db.transaction(async (tx) => {
        receiptNumber = await this.storage.generateReceiptNumber(tx);
        return await this.storage.createReceivingOrder({
          receiptNumber,
          ...normalized,
        }, tx);
      });
    } catch (error: any) {
      if (error?.code === "23505" || error?.cause?.code === "23505") {
        throw new ReceivingError("Receiving order creation conflicted with an existing active receipt", 409, {
          code: "RECEIVING_ORDER_CREATE_CONFLICT",
          receiptNumber,
        });
      }
      throw error;
    }
  }

  async updateOrderDetails(orderId: number, input: Record<string, unknown>, actorId?: string | null) {
    const { applyDefaultToUnassigned, ...fields } = input;
    if (applyDefaultToUnassigned !== undefined && typeof applyDefaultToUnassigned !== "boolean") {
      throw new ReceivingError("applyDefaultToUnassigned must be a boolean", 400);
    }
    assertOnlyAllowedFields(fields, RECEIVING_ORDER_EDITABLE_FIELDS, "Receiving order update");
    if (Object.keys(fields).length === 0) {
      throw new ReceivingError("Receiving order update requires at least one field", 400);
    }

    const updates: Record<string, unknown> = { ...fields };
    if ("warehouseId" in updates) {
      updates.warehouseId = normalizeOptionalPositiveId(updates.warehouseId, "warehouseId");
    }
    if ("receivingLocationId" in updates) {
      updates.receivingLocationId = normalizeOptionalPositiveId(
        updates.receivingLocationId,
        "receivingLocationId",
      );
    }
    if (applyDefaultToUnassigned === true && !updates.receivingLocationId) {
      throw new ReceivingError("Applying a default requires an explicit receiving location", 400);
    }
    if (applyDefaultToUnassigned === true && !actorId?.trim()) {
      throw new ReceivingError("An authenticated actor is required to apply receipt locations", 401);
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
      if ("warehouseId" in updates && updates.warehouseId !== order.warehouseId) {
        await assertNoReceivingCustodyHistory(tx, { receivingOrderId: orderId });
      }
      const changesDestination = "warehouseId" in updates || "receivingLocationId" in updates;
      if (changesDestination) {
        await tx.execute(sql`SELECT id FROM procurement.receiving_lines WHERE receiving_order_id=${orderId} ORDER BY id FOR UPDATE`);
      }
      const lines = changesDestination ? await this.storage.getReceivingLines(orderId, tx) : [];
      if (changesDestination) {
        const next = { ...order, ...updates };
        if (next.warehouseId || next.receivingLocationId || lines.some((line: any) => line.putawayLocationId)) {
          await this.validateLocations(tx, next, lines);
        }
      }
      const assigned: Array<{ receivingLineId: number; before: null; after: number }> = [];
      if (applyDefaultToUnassigned === true) {
        for (const line of lines) {
          if (line.putawayLocationId != null) continue;
          await this.storage.updateReceivingLine(line.id, { putawayLocationId: updates.receivingLocationId }, tx);
          assigned.push({ receivingLineId: line.id, before: null, after: Number(updates.receivingLocationId) });
        }
      }
      const previousFields = Object.fromEntries(Object.keys(updates).map((key) => [key, order[key]]));
      if (applyDefaultToUnassigned === true && assigned.length === 0 && canonicalJson(previousFields) === canonicalJson(updates)) {
        return order;
      }
      const updated = await this.storage.updateReceivingOrder(orderId, updates, tx);
      if (applyDefaultToUnassigned === true) {
        await tx.execute(sql`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
          VALUES(${this.clock()},'AUDIT',${actorId},'procurement.receiving.default_location_applied',${`receiving-order:${orderId}`},
            ${JSON.stringify({ before: previousFields, after: Object.fromEntries(Object.keys(updates).map((key) => [key, updated[key]])), lines: assigned })}::jsonb,
            ${JSON.stringify({ receivingOrderId: orderId })}::jsonb)`);
      }
      return updated;
    });
  }

  async addLine(orderId: number, input: Record<string, unknown>) {
    const { expectedUnitsPerVariant, ...fields } = input;
    assertOnlyAllowedFields(fields, RECEIVING_LINE_EDITABLE_FIELDS, "Receiving line create");
    const lineData = this.normalizeLineMutation(fields, null);
    const expectedFactor = lineData.productVariantId
      ? receiptInteger(expectedUnitsPerVariant, "Reviewed receive pack size", true)
      : null;
    if (!lineData.productVariantId && expectedUnitsPerVariant !== undefined) {
      throw new ReceivingError("A reviewed pack size requires a selected receive variant.", 400);
    }

    const result = await this.db.transaction(async (tx) => {
      const order = await this.lockReceivingOrder(tx, orderId);
      this.assertReceivingOrderMutable(order);
      const productVariantId = lineData.productVariantId;
      const unitData = productVariantId
        ? await this.loadReceiveVariant(tx, Number(productVariantId), lineData.productId)
        : null;
      if (unitData && unitData.unitsPerVariant !== expectedFactor) {
        throw new ReceivingError("The selected catalog pack changed. Select the receive unit again and review its counts before adding the line.", 409, {
          code: "RECEIVING_UNIT_CHANGED", productVariantId,
        });
      }
      const unitsPerVariantSnapshot = unitData?.unitsPerVariant ?? null;
      if (lineData.putawayLocationId) await this.validateLocations(tx, order, [{ putawayLocationId: Number(lineData.putawayLocationId) }]);
      const counts = { expectedQty: 0, receivedQty: 0, damagedQty: 0, ...lineData };
      for (const field of ["expectedQty", "receivedQty", "damagedQty"] as const) receiptInteger(counts[field], field);
      if (unitsPerVariantSnapshot !== null) this.validateReceiptBaseCounts(counts, unitsPerVariantSnapshot);
      const line = await this.storage.createReceivingLine({
        ...lineData,
        productId: unitData?.productId ?? lineData.productId,
        unitsPerVariantSnapshot,
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
    return { ...result.order, lines: result.lines.map(withReceivingUnitVersion), vendor };
  }

  private async loadReceiveVariant(tx: any, variantId: number, expectedProductId?: unknown): Promise<{ id: number; productId: number; unitsPerVariant: number }> {
    receiptInteger(variantId, "Receive variant ID", true);
    const rows = await tx.execute(sql`
      SELECT id, product_id, units_per_variant, is_active
      FROM catalog.product_variants WHERE id = ${variantId} FOR SHARE
    `);
    const variant = rows.rows?.[0];
    if (!variant || variant.is_active === false) {
      throw new ReceivingError("Select an active receive variant before saving quantities.", 409, { code: "RECEIVING_VARIANT_REVIEW_REQUIRED", productVariantId: variantId });
    }
    const productId = receiptInteger(variant.product_id, "Receive product ID", true);
    const unitsPerVariant = receiptInteger(variant.units_per_variant, "Receive pack size", true);
    if (expectedProductId != null && Number(expectedProductId) !== productId) {
      throw new ReceivingError("The receive variant belongs to a different product than this receipt line.", 409, { code: "RECEIVING_VARIANT_PRODUCT_MISMATCH", productVariantId: variantId });
    }
    return { id: variantId, productId, unitsPerVariant };
  }

  private validateReceiptBaseCounts(line: Record<string, unknown>, factor: number): void {
    receiptInteger(factor, "Recorded receive pack size", true);
    for (const field of ["expectedQty", "receivedQty", "damagedQty"] as const) {
      const count = receiptInteger(line[field], field);
      receiptInteger(count * factor, `${field} in pieces`);
    }
  }

  private async assertReceiptSourceProduct(tx: any, line: any, order: any, productId: number): Promise<void> {
    if (line.inboundShipmentLineId != null && (!line.purchaseOrderLineId || !order.purchaseOrderId || !order.inboundShipmentId)) {
      throw new ReceivingError("An exact shipment-line receipt needs its purchase line, purchase order and shipment header. Review the original source before posting.", 409, {
        code: "RECEIVING_SHIPMENT_SOURCE_MISMATCH", receivingLineId: line.id,
      });
    }
    if (!line.purchaseOrderLineId) return;
    if (!this.storage.getPurchaseOrderLineById) throw new ReceivingError("Purchase source lookup is unavailable.", 503);
    const source = await this.storage.getPurchaseOrderLineById(line.purchaseOrderLineId, tx);
    if (!source || (source.lineType ?? "product") !== "product" || source.productId !== productId || (order.purchaseOrderId != null && source.purchaseOrderId !== order.purchaseOrderId)) {
      throw new ReceivingError("The receiving product does not match its purchase source. Review the linked PO line before saving or posting.", 409, { code: "RECEIVING_SOURCE_PRODUCT_MISMATCH", receivingLineId: line.id, purchaseOrderLineId: line.purchaseOrderLineId });
    }
    if (line.inboundShipmentLineId) {
      const result = await tx.execute(sql`SELECT inbound_shipment_id, purchase_order_id, purchase_order_line_id, qty_shipped FROM procurement.inbound_shipment_lines WHERE id = ${line.inboundShipmentLineId}`);
      const shipmentSource = result.rows?.[0];
      if (!shipmentSource || shipmentSource.inbound_shipment_id !== order.inboundShipmentId || shipmentSource.purchase_order_line_id !== line.purchaseOrderLineId || shipmentSource.purchase_order_id !== source.purchaseOrderId) {
        throw new ReceivingError("The receiving shipment-line link is inconsistent. Review the original shipment source before posting.", 409, { code: "RECEIVING_SHIPMENT_SOURCE_MISMATCH", receivingLineId: line.id });
      }
      receiptInteger(shipmentSource.qty_shipped, "Shipment source pieces", true);
    }
  }

  async updateLine(lineId: number, input: Record<string, unknown>, actorId?: string | null) {
    const { expectedUnitVersion, expectedUnitsPerVariant, confirmLegacyUnit, ...fields } = input;
    assertOnlyAllowedFields(fields, RECEIVING_LINE_EDITABLE_FIELDS, "Receiving line update");
    if (Object.keys(fields).length === 0) throw new ReceivingError("Receiving line update requires at least one field", 400);
    if (confirmLegacyUnit !== undefined && confirmLegacyUnit !== true) throw new ReceivingError("confirmLegacyUnit must be true when supplied", 400);
    const expectedFactor = confirmLegacyUnit === true
      ? receiptInteger(expectedUnitsPerVariant, "Reviewed receive pack size", true)
      : null;
    if (confirmLegacyUnit !== true && expectedUnitsPerVariant !== undefined) {
      throw new ReceivingError("A reviewed pack size is only accepted with explicit legacy unit confirmation.", 400);
    }
    const changesUnits = ["productVariantId", "expectedQty", "receivedQty", "damagedQty", "productId"].some((field) => field in fields);
    if (changesUnits && (typeof expectedUnitVersion !== "string" || !/^[a-f0-9]{64}$/.test(expectedUnitVersion))) {
      throw new ReceivingError("Refresh and review the current receipt units before saving.", 409, { code: "RECEIVING_UNIT_VERSION_REQUIRED" });
    }
    if (changesUnits && !actorId) throw new ReceivingError("An authenticated actor is required to change receipt units.", 401);

    return await this.db.transaction(async (tx) => {
      const { line, order } = await this.lockReceivingLineAndOrder(tx, lineId);
      await assertReceivingQuarantineLineEditable(tx, lineId, Object.keys(fields));
      if (changesUnits && receivingUnitVersion(line) !== expectedUnitVersion) {
        throw new ReceivingError("Receipt counts or units changed. Refresh, review the current line, and save again.", 409, { code: "RECEIVING_UNIT_VERSION_CONFLICT", receivingLineId: lineId });
      }
      const updates = this.normalizeLineMutation(fields, line);
      if ("productVariantId" in updates) {
        if (!updates.productVariantId) throw new ReceivingError("A recorded receive unit cannot be cleared; select a valid variant.", 409);
        if (["expectedQty", "receivedQty", "damagedQty"].some((field) => field in updates)) {
          throw new ReceivingError("Change the receive unit separately from its counts so each quantity is converted exactly.", 400);
        }
        const variant = await this.loadReceiveVariant(tx, Number(updates.productVariantId), line.productId);
        await this.assertReceiptSourceProduct(tx, line, order, variant.productId);
        if (line.unitsPerVariantSnapshot == null) {
          if (confirmLegacyUnit !== true || (line.productVariantId != null && variant.id !== line.productVariantId)) {
            throw new ReceivingError("Confirm the current line's count unit before converting a legacy receipt.", 409, { code: "RECEIVING_UNIT_CONFIRMATION_REQUIRED", receivingLineId: lineId });
          }
          if (variant.unitsPerVariant !== expectedFactor) {
            throw new ReceivingError("The selected catalog pack changed. Refresh and review the count unit before confirming it.", 409, {
              code: "RECEIVING_UNIT_CHANGED", receivingLineId: lineId, productVariantId: variant.id,
            });
          }
          // Explicit operator attestation of an unposted legacy count unit.
          // Posted history is immutable and cannot reach this method.
        } else {
          if (confirmLegacyUnit) throw new ReceivingError("A recorded unit must be converted, not reinterpreted.", 409);
          Object.assign(updates, convertReceiptCounts(line, line.unitsPerVariantSnapshot, variant.unitsPerVariant));
        }
        updates.productId = variant.productId;
        updates.unitsPerVariantSnapshot = variant.unitsPerVariant;
      } else if (confirmLegacyUnit) {
        throw new ReceivingError("Unit confirmation requires an explicit receive variant.", 400);
      }
      if ("productId" in updates && !("productVariantId" in updates) && updates.productId !== line.productId) {
        throw new ReceivingError("Select the receive variant to change an unresolved product; a linked product cannot be patched independently.", 409);
      }
      if (line.inboundShipmentLineId && "expectedQty" in fields && fields.expectedQty !== line.expectedQty) {
        throw new ReceivingError("Expected pieces come from the shipment source. Record the actual count without rewriting the source expectation.", 409, { code: "RECEIVING_EXPECTED_SOURCE_IMMUTABLE" });
      }
      const next = { ...line, ...updates };
      if ("putawayLocationId" in updates && next.putawayLocationId) await this.validateLocations(tx, order, [next]);
      if (changesUnits && next.unitsPerVariantSnapshot != null) this.validateReceiptBaseCounts(next, next.unitsPerVariantSnapshot);
      if ("receivedQty" in updates || "expectedQty" in updates) updates.status = this.receivingLineStatus(Number(next.receivedQty), Number(next.expectedQty));
      const now = this.clock();
      const changesCost = ["unitCost", "unitCostMills"].some((field) => field in updates && updates[field] !== line[field]);
      if (changesCost) {
        if (!actorId) throw new ReceivingError("An authenticated actor is required to change receipt costs.", 401);
        updates.costSourceKind = "manual_override";
        updates.costSourceEvidence = { actorId, recordedAt: now.toISOString(), before: { unitCost: line.unitCost, unitCostMills: line.unitCostMills }, after: { unitCost: updates.unitCost ?? line.unitCost, unitCostMills: updates.unitCostMills ?? line.unitCostMills }, state: "review_required" };
      }
      if (changesUnits || changesCost) updates.updatedAt = now;
      const updated = await this.storage.updateReceivingLine(lineId, updates, tx);
      await this.updateReceivingOrderTotals(line.receivingOrderId, tx);
      if (changesUnits || changesCost) {
        await tx.execute(sql`
          INSERT INTO public.audit_events (timestamp, level, actor, action, target, changes, context)
          VALUES (${now}, 'AUDIT', ${actorId}, ${changesCost ? 'procurement.receiving.cost_override' : 'procurement.receiving.units'}, ${`receiving-line:${lineId}`},
            ${JSON.stringify({ before: line, after: updated })}::jsonb,
            ${JSON.stringify({ receivingOrderId: line.receivingOrderId, receivingLineId: lineId, legacyUnitConfirmed: confirmLegacyUnit === true })}::jsonb)
        `);
      }
      return withReceivingUnitVersion(updated);
    });
  }

  async deleteLine(lineId: number): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      const { line } = await this.lockReceivingLineAndOrder(tx, lineId);
      await assertNoReceivingCustodyHistory(tx, { receivingLineId: lineId });
      const deleted = await this.storage.deleteReceivingLine(lineId, tx);
      if (deleted) {
        await this.updateReceivingOrderTotals(line.receivingOrderId, tx);
      }
      return deleted;
    });
  }

  async deleteOrder(orderId: number, userId?: string): Promise<boolean> {
    // Compatibility entry point: list deletion has the same draft-only rules
    // and durable audit as the detail screen's discard command.
    await this.discardDraftReceivingOrder(orderId, userId);
    return true;
  }

  private normalizeLineMutation(
    input: Record<string, unknown>,
    existing: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = { ...input };
    for (const field of ["expectedQty", "receivedQty", "damagedQty"] as const) {
      if (field in normalized) {
        normalized[field] = receiptInteger(normalized[field], field);
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
    return receivingLineStatus(receivedQty, expectedQty);
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
        receivedDate: this.clock(),
      }, tx);
      return { order: lockedOrder, updated: opened };
    });

    const lines = await this.storage.getReceivingLines(orderId);
    const vendor = order.vendorId ? await this.storage.getVendorById(order.vendorId) : null;
    return { ...updated, lines: lines.map(withReceivingUnitVersion), vendor };
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
      const costReconciliation = await this.retryCosts(orderId, userId);
      return { ...this.buildCloseResult(order, closedLines, undefined, poReconciliation), costReconciliation };
    }

    const orderSnapshot = canonicalJson(order);
    let lines = await this.storage.getReceivingLines(orderId);
    const lineSnapshot = receivingLinesSnapshot(lines);
    // Historical damage counts do not prove whether those units were included
    // in receivedQty. Require an explicit accepted/held recount before posting.
    if (lines.some((line: any) => Number(line.damagedQty) > 0)) {
      throw new ReceivingQuarantineError("RECEIVING_DAMAGE_CUSTODY_REQUIRED",
        "Review accepted and held quantities in quarantine before closing a receipt with damaged goods.");
    }
    if (
      order.sourceType === "shipment" &&
      lines.length > 0 &&
      lines.every((line: any) => (Number(line.receivedQty) || 0) <= 0) &&
      !await readReceiptCustodyPresence(this.db, orderId)
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
    const closeAt = this.clock();
    const batchId = `RCV-${orderId}-${closeAt.getTime()}`;
    let totalReceived = 0;
    let linesReceived = 0;
    const receivedVariantIds = new Set<number>();
    const putawayLocationIds = new Set<number>();
    const receivedPurchaseOrderLineIds = new Set<number>();

    const closeResult = await this.db.transaction(async (tx) => {
      await lockInventoryCostGraph(tx);
      await lockReceivingCustodyFence(tx, "write");
      const lockedOrder = await this.lockReceivingOrder(tx, orderId);
      if (lockedOrder.status === "cancelled") {
        throw new ReceivingError("Order already cancelled");
      }
      if (lockedOrder.status === "closed") {
        const currentLines = await this.storage.getReceivingLines(orderId, tx);
        const reconciliation = await this.reconcileLinkedPurchaseOrder(orderId, lockedOrder, currentLines, userId,
          { executor: tx, recordedAt: closeAt });
        return { updated: lockedOrder, replayed: true, poReconciliation: reconciliation };
      }
      if (orderSnapshot !== canonicalJson(lockedOrder)) {
        throw new ReceivingError(
          "Receiving order changed while close was starting. Review the current receipt and retry.",
          409,
          { code: "RECEIVING_CLOSE_SNAPSHOT_CHANGED", receivingOrderId: orderId },
        );
      }
      order = lockedOrder;

      await tx.execute(sql`SELECT id FROM procurement.receiving_lines WHERE receiving_order_id=${orderId} ORDER BY id FOR UPDATE`);
      const lockedLines = await this.storage.getReceivingLines(orderId, tx);
      if (lineSnapshot !== receivingLinesSnapshot(lockedLines)) {
        throw new ReceivingError(
          "Receiving lines changed while close was starting. Review the current receipt and retry.",
          409,
          { code: "RECEIVING_CLOSE_SNAPSHOT_CHANGED", receivingOrderId: orderId },
        );
      }
      lines = lockedLines;
      // Match the receiving/reversal order before taking inventory locks.
      // Source evidence and physical receipt links use these PO rows.
      if (order.purchaseOrderId) {
        await tx.execute(sql`SELECT id FROM procurement.purchase_orders WHERE id = ${order.purchaseOrderId} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM procurement.purchase_order_lines WHERE purchase_order_id = ${order.purchaseOrderId} ORDER BY id FOR UPDATE`);
      }
      // Keep catalog factors stable through inventory posting. A changed pack
      // needs an explicit, exact conversion; never reinterpret old counts.
      const receiveVariants = new Map<number, { id: number; productId: number; unitsPerVariant: number }>();
      for (const variantId of [...new Set<number>(lines.filter((line: any) => line.receivedQty > 0).map((line: any) => Number(line.productVariantId)))].sort((a, b) => a - b)) {
        receiveVariants.set(variantId, await this.loadReceiveVariant(tx, variantId));
      }
      // Preserve the established frozen-unit and explicit-source errors. In
      // particular, a corrupt exact shipment link must never be repaired by
      // inference from another PO or shipment line.
      for (const line of lines.filter((line: any) => line.receivedQty > 0)) {
        const variant = receiveVariants.get(line.productVariantId)!;
        if (line.unitsPerVariantSnapshot == null) {
          throw new ReceivingError("Confirm the receive unit on each legacy line before closing this receipt.", 409, { code: "RECEIVING_UNIT_CONFIRMATION_REQUIRED", receivingLineId: line.id });
        }
        if (line.unitsPerVariantSnapshot !== variant.unitsPerVariant || (line.productId != null && line.productId !== variant.productId)) {
          throw new ReceivingError("The selected catalog pack differs from the recorded receipt unit. Review and convert the receive unit before closing.", 409, { code: "RECEIVING_UNIT_SOURCE_CHANGED", receivingLineId: line.id });
        }
        this.validateReceiptBaseCounts(line, line.unitsPerVariantSnapshot);
        await this.assertReceiptSourceProduct(tx, line, order, variant.productId);
      }
      await this.validateLocations(tx, order, lines);
      const sources = await readReceivingSourceResolution(tx, {
        receivingOrderId: orderId, purchaseOrderId: order.purchaseOrderId ?? null, inboundShipmentId: order.inboundShipmentId ?? null,
        lines: lines.map((line: any) => ({ id: line.id, productId: receiveVariants.get(line.productVariantId)?.productId ?? line.productId ?? null,
          purchaseOrderLineId: line.purchaseOrderLineId ?? null, inboundShipmentLineId: line.inboundShipmentLineId ?? null,
          receivedQty: line.receivedQty, damagedQty: line.damagedQty })),
      });
      const sourceByLine = new Map(sources.map((source) => [source.receivingLineId, source]));
      for (const line of lines) {
        const source = sourceByLine.get(line.id);
        if (!source || (line.purchaseOrderLineId === source.purchaseOrderLineId &&
          (line.inboundShipmentLineId ?? null) === source.inboundShipmentLineId)) continue;
        const before = { purchaseOrderLineId: line.purchaseOrderLineId ?? null, inboundShipmentLineId: line.inboundShipmentLineId ?? null };
        const after = { purchaseOrderLineId: source.purchaseOrderLineId, inboundShipmentLineId: source.inboundShipmentLineId };
        await this.storage.updateReceivingLine(line.id, after, tx);
        await tx.execute(sql`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
          VALUES(${closeAt},'AUDIT',${userId || "system:receiving"},'procurement.receiving.source_resolved',${`receiving-line:${line.id}`},
            ${JSON.stringify({ before, after })}::jsonb,${JSON.stringify({ receivingOrderId: orderId })}::jsonb)`);
      }
      // Re-read our persisted source assignments before cost origin and inventory
      // posting. No temporary DTO-only source can reach the physical owner.
      lines = await this.storage.getReceivingLines(orderId, tx);
      for (const line of lines.filter((line: any) => line.receivedQty > 0)) {
        await this.assertReceiptSourceProduct(tx, line, order, receiveVariants.get(line.productVariantId)!.productId);
      }

      for (const line of lines) {
      if (line.receivedQty > 0 && line.productVariantId && line.putawayLocationId) {
        const qtyToAdd = line.receivedQty;

        const inboundShipmentId = order.inboundShipmentId == null ? undefined : Number(order.inboundShipmentId);
        const unitsPerVariant = line.unitsPerVariantSnapshot;
        let lotUnitCostMills: number | undefined;
        let lotPackagingCostMills = 0;
        let lotLandedCostMills = 0;
        let unitCostMills: number | undefined;
        let unitCostCents: number | undefined;
        let costProvisional = 1;
        if (line.purchaseOrderLineId && order.purchaseOrderId && line.costSourceKind === "purchase_order_line") {
          const evidence = await resolveReceiptCostEvidence(tx, {
            receivingLineId: line.id, purchaseOrderLineId: line.purchaseOrderLineId,
            purchaseOrderId: order.purchaseOrderId, inboundShipmentId: inboundShipmentId ?? null,
            inboundShipmentLineId: line.inboundShipmentLineId ?? null,
            unitsPerVariantSnapshot: unitsPerVariant, costSourceKind: line.costSourceKind,
          }, userId || "system:receiving", this.clock());
          lotUnitCostMills = evidence.unitCostMills;
          lotPackagingCostMills = evidence.packagingCostMills;
          lotLandedCostMills = evidence.landedCostMills;
          unitCostMills = evidence.productUnitCostMills;
          unitCostCents = millsToCents(unitCostMills);
          costProvisional = evidence.costProvisional;
          await this.storage.updateReceivingLine(line.id, {
            costSourceEvidence: { contractVersion: 1, revisionIds: evidence.revisions.map((revision) => revision.id) },
          }, tx);
        } else {
          const resolved = await resolveReceivingLineCost(line, this.storage as any);
          unitCostMills = resolved.mills;
          unitCostCents = resolved.cents;
          if (unitCostMills !== undefined) {
            const scaled = BigInt(unitCostMills) * BigInt(unitsPerVariant);
            if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) throw new ReceivingError("Receipt cost exceeds the supported mills range", 409, { code: "RECEIPT_COST_OVERFLOW" });
            lotUnitCostMills = Number(scaled);
          }
          // An old copied number or a manual price is not provenance. Keep its
          // physical receipt possible and its financial state visibly provisional.
        }
        const lotUnitCostCents = lotUnitCostMills === undefined ? undefined : millsToCents(lotUnitCostMills);

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
          landedCostMills: lotLandedCostMills,
          unitsPerVariantSnapshot: unitsPerVariant,
          costRecordedAt: closeAt,
          inboundShipmentLineId: line.inboundShipmentLineId ?? undefined,
          receivingOrderId: orderId,
          receivingLineId: line.id,
          purchaseOrderId: order.purchaseOrderId || undefined,
          purchaseOrderLineId: line.purchaseOrderLineId || undefined,
          inboundShipmentId,
          costProvisional,
        }, tx);
        if (line.purchaseOrderLineId) {
          receivedPurchaseOrderLineIds.add(Number(line.purchaseOrderLineId));
        }

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

    await enqueueReceiptCostRequests(tx, orderId, [...receivedPurchaseOrderLineIds], userId || "system:receiving", closeAt);

    // Update order totals and close
    const updated = await this.storage.updateReceivingOrder(orderId, {
      status: "closed",
      closedDate: closeAt,
      closedBy: userId,
      receivedLineCount: linesReceived,
      receivedTotalUnits: totalReceived,
    }, tx);
    const reconciledLines = await this.storage.getReceivingLines(orderId, tx);
    const poReconciliation = await this.reconcileLinkedPurchaseOrder(orderId, updated, reconciledLines, userId,
      { executor: tx, recordedAt: closeAt });
    // The stock, PO acceptance and pending-custody completion share one commit.
    // Preparation alone never removes physical goods from quarantine custody.
    await completeReceivingQuarantineAcceptances(tx, {
      receivingOrderId: orderId, actorId: userId || "system:receiving", recordedAt: closeAt,
    });
    return { updated, replayed: false, poReconciliation };
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
    const poReconciliation = closeResult.poReconciliation;
    if (poReconciliation.required) await this.purchasing?.afterReceivingOrderClosed?.(poReconciliation);

    // Spec D, Part 2: receive-time validation warnings. Advisory only —
    // evaluation or persistence failures must never fail the close.
    if (this.receiveWarningEvaluator && this.receiveWarningReporter) {
      try {
        const warnings = await this.receiveWarningEvaluator.evaluateOrder(orderId);
        if (warnings.length > 0) {
          await this.receiveWarningReporter({
            receivingOrderId: orderId,
            purchaseOrderId: updated.purchaseOrderId ?? null,
            warnings,
            userId,
          });
        }
      } catch (warningError) {
        console.warn(
          `[Receiving] Validation warning evaluation failed for receiving order ${orderId}:`,
          warningError,
        );
      }
    }

    const costReconciliation = await this.retryCosts(orderId, userId);
    return { ...this.buildCloseResult(updated, closedLines, Array.from(putawayLocationIds), poReconciliation), costReconciliation };
  }

  async retryCosts(orderId: number, userId: string | null) {
    if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new ReceivingError("Receiving order ID is invalid", 400);
    const receipt = await this.storage.getReceivingOrderById(orderId);
    if (!receipt) throw new ReceivingError("Receiving order not found", 404);
    if (receipt.status !== "closed") throw new ReceivingError("Cost retry requires a completed physical receipt", 409);
    return processReceiptCostRequests(this.db, orderId, this.approvedInvoiceCostReconciler, userId || "system:receiving", this.clock);
  }

  /** Scheduler-only entry point: one durable request, no stock/source override.
   * Review outcomes are never retried automatically. */
  async retryCostsAutomatically(orderId: number, requestId: number) {
    if (!Number.isSafeInteger(orderId) || orderId <= 0 || !Number.isSafeInteger(requestId) || requestId <= 0) {
      throw new ReceivingError("Automatic receipt cost identifiers are invalid", 400);
    }
    return processReceiptCostRequests(this.db, orderId, this.approvedInvoiceCostReconciler, RECEIPT_COST_RECOVERY_ACTOR, this.clock, requestId);
  }

  async completeAllLines(orderId: number, input: unknown, actorId?: string | null) {
    const result = await this.db.transaction(async (tx) => {
      const order = await this.lockReceivingOrder(tx, orderId);
      this.assertReceivingOrderMutable(order);
      await assertNoReceivingCustodyHistory(tx, { receivingOrderId: orderId });
      const lines = await this.storage.getReceivingLines(orderId, tx);
      if (!lines.length) throw new ReceivingError("No lines found for this order", 404);
      const supplied = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
      if (Object.keys(supplied).some((key) => key !== "expectedUnitVersions") || !Array.isArray(supplied.expectedUnitVersions) || supplied.expectedUnitVersions.length !== lines.length) {
        throw new ReceivingError("Refresh and review all current receipt lines before completing their counts.", 409, { code: "RECEIVING_UNIT_VERSION_REQUIRED" });
      }
      const versions = new Map<number, string>();
      for (const item of supplied.expectedUnitVersions) {
        if (!item || typeof item !== "object" || Object.keys(item).some((key) => !["lineId", "unitVersion"].includes(key)) || typeof item.unitVersion !== "string" || !/^[a-f0-9]{64}$/.test(item.unitVersion) || versions.has(item.lineId)) {
          throw new ReceivingError("Receipt line versions are invalid.", 400);
        }
        versions.set(receiptInteger(item.lineId, "Receiving line ID", true), item.unitVersion);
      }
      if (!actorId) throw new ReceivingError("An authenticated actor is required to complete receipt counts.", 401);
      for (const line of lines) {
        if (versions.get(line.id) !== receivingUnitVersion(line)) throw new ReceivingError("Receipt counts or units changed. Refresh and review all current lines.", 409, { code: "RECEIVING_UNIT_VERSION_CONFLICT", receivingLineId: line.id });
        if (line.unitsPerVariantSnapshot == null || !line.productVariantId) throw new ReceivingError("Confirm each receive unit before completing all counts.", 409, { code: "RECEIVING_UNIT_CONFIRMATION_REQUIRED", receivingLineId: line.id });
        this.validateReceiptBaseCounts(line, line.unitsPerVariantSnapshot);
      }
      if (order.purchaseOrderId) {
        await tx.execute(sql`SELECT id FROM procurement.purchase_orders WHERE id = ${order.purchaseOrderId} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM procurement.purchase_order_lines WHERE purchase_order_id = ${order.purchaseOrderId} ORDER BY id FOR UPDATE`);
      }
      const variants = new Map<number, { id: number; productId: number; unitsPerVariant: number }>();
      for (const id of [...new Set<number>(lines.map((line: any) => Number(line.productVariantId)))].sort((a, b) => a - b)) variants.set(id, await this.loadReceiveVariant(tx, id));
      const now = this.clock();
      let updated = 0;
      for (const line of lines) {
        const variant = variants.get(line.productVariantId)!;
        if (variant.unitsPerVariant !== line.unitsPerVariantSnapshot || (line.productId != null && variant.productId !== line.productId)) throw new ReceivingError("A catalog pack changed. Review its recorded receive unit before completing counts.", 409, { code: "RECEIVING_UNIT_SOURCE_CHANGED", receivingLineId: line.id });
        await this.assertReceiptSourceProduct(tx, line, order, variant.productId);
        const receivedQty = line.receivedQty > 0 ? line.receivedQty : line.expectedQty;
        const status = this.receivingLineStatus(receivedQty, line.expectedQty);
        if (line.receivedQty !== receivedQty || line.status !== status) {
          await this.storage.updateReceivingLine(line.id, { receivedQty, status, updatedAt: now }, tx);
          updated++;
        }
      }
      const updatedLines = await this.updateReceivingOrderTotals(orderId, tx);
      const updatedOrder = await this.storage.getReceivingOrderById(orderId, tx);
      await tx.execute(sql`
        INSERT INTO public.audit_events (timestamp, level, actor, action, target, changes, context)
        VALUES (${now}, 'AUDIT', ${actorId}, 'procurement.receiving.complete_counts', ${`receiving:${orderId}`},
          ${JSON.stringify({ before: lines, after: updatedLines })}::jsonb, ${JSON.stringify({ receivingOrderId: orderId })}::jsonb)
      `);
      return { updated, order: updatedOrder, updatedLines };
    });
    const vendor = result.order?.vendorId ? await this.storage.getVendorById(result.order.vendorId) : null;
    return { message: `Completed ${result.updated} lines`, updated: result.updated, order: { ...result.order, lines: result.updatedLines.map(withReceivingUnitVersion), vendor } };
  }

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

    // Catalog creation does not establish the count unit of a legacy line.
    // The caller explicitly confirms/converts units with its content version.
    return {
      line: withReceivingUnitVersion(line),
      requiresUnitConfirmation: true,
      product: { id: product.id, sku: product.sku, name: product.name },
      variant: { id: variant.id, sku: variant.sku, name: variant.name, unitsPerVariant: variant.unitsPerVariant },
    };
  }

  // ─── Bulk Import Lines (CSV) ──────────────────────────────────

  async bulkImportLines(
    orderId: number,
    lines: unknown,
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
    const existingLineSnapshot = receivingLinesSnapshot(existingLines);
    const preparedRows: Array<{ row: number; sku: string; putawayLocationId: number | null; values: Record<string, unknown> }> = [];
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
    const receiptSnapshot = canonicalJson(receipt);
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

    const importedAt = this.clock();
    for (const [index, rawLine] of lines.entries()) {
      const row = index + 1;
      const parsed = receivingImportRowSchema.safeParse(rawLine);
      if (!parsed.success) {
        const sku = rawLine && typeof rawLine === "object" && typeof rawLine.sku === "string" ? rawLine.sku : "(missing)";
        errors.push(`Data row ${row}, SKU ${sku}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
        continue;
      }
      const { sku, qty: parsedQty, location, damaged_qty: parsedDamagedQty, unit_cost, barcode, notes } = parsed.data;

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

      preparedRows.push({ row, sku: sku.toUpperCase(), putawayLocationId, values: {
        sku: sku.toUpperCase(), productName, barcode: productBarcode,
        expectedQty: parsedQty, receivedQty: parsedQty, damagedQty: parsedDamagedQty,
        unitCost: parsedUnitCost, unitCostMills: parsedUnitCostMills, productVariantId, productId,
        putawayLocationId, notes: lineNotes, status: putawayLocationId ? "complete" : "pending",
        receivedBy: userId, receivedAt: importedAt,
      } });
    }

    const identityPlan = planReceivingImportIdentities(existingLines, preparedRows);
    if (identityPlan.issues.length) {
      throw new ReceivingError("No lines were imported. Resolve the ambiguous CSV rows and retry.", 409, {
        code: "RECEIVING_IMPORT_IDENTITY_REVIEW_REQUIRED", rowErrors: identityPlan.issues,
      });
    }
    for (const row of preparedRows) {
      const existingId = identityPlan.targets.get(row.row);
      if (existingId == null) linesToCreate.push({ receivingOrderId: orderId, ...row.values });
      else linesToUpdate.push({ id: existingId, updates: row.values });
    }

    const created = await this.db.transaction(async (tx) => {
      const lockedOrder = await this.lockReceivingOrder(tx, orderId);
      this.assertReceivingOrderMutable(lockedOrder);
      if (canonicalJson(lockedOrder) !== receiptSnapshot) {
        throw new ReceivingError(
          "Receiving order changed while the import was being prepared. Review the current receipt and retry.",
          409,
          { code: "RECEIVING_IMPORT_SNAPSHOT_CHANGED", receivingOrderId: orderId },
        );
      }

      if (lockedOrder.purchaseOrderId) {
        await tx.execute(sql`SELECT id FROM procurement.purchase_orders WHERE id = ${lockedOrder.purchaseOrderId} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM procurement.purchase_order_lines WHERE purchase_order_id = ${lockedOrder.purchaseOrderId} ORDER BY id FOR UPDATE`);
      }
      const currentLines = await this.storage.getReceivingLines(orderId, tx);
      if (receivingLinesSnapshot(currentLines) !== existingLineSnapshot) {
        throw new ReceivingError(
          "Receiving lines changed while the import was being prepared. Review the current receipt and retry.",
          409,
          { code: "RECEIVING_IMPORT_SNAPSHOT_CHANGED", receivingOrderId: orderId },
        );
      }
      const currentById = new Map(currentLines.map((line: any) => [line.id, line]));
      const importLocations = [
        ...currentLines.filter((line: any) => !linesToUpdate.some((item) => item.id === line.id)),
        ...linesToUpdate.map((item) => ({ id: item.id, putawayLocationId: item.updates.putawayLocationId as number | null })),
        ...linesToCreate.map((line: any) => ({ putawayLocationId: line.putawayLocationId })),
      ];
      // Unassigned drafts may be imported before a destination is chosen. Once
      // a location is present, warehouse ownership is mandatory and locked.
      if (lockedOrder.warehouseId || lockedOrder.receivingLocationId || importLocations.some((line) => line.putawayLocationId)) {
        await this.validateLocations(tx, lockedOrder, importLocations);
      }
      const importedVariants = new Map<number, { id: number; productId: number; unitsPerVariant: number }>();
      const importedRows = [...linesToCreate, ...linesToUpdate.map((item) => item.updates)];
      for (const id of [...new Set<number>(importedRows.filter((row: any) => row.productVariantId).map((row: any) => Number(row.productVariantId)))].sort((a, b) => a - b)) importedVariants.set(id, await this.loadReceiveVariant(tx, id));
      for (const row of linesToCreate) {
        const variant = row.productVariantId ? importedVariants.get(row.productVariantId) : null;
        row.unitsPerVariantSnapshot = variant?.unitsPerVariant ?? null;
        if (variant) {
          row.productId = variant.productId;
          this.validateReceiptBaseCounts(row, variant.unitsPerVariant);
        }
      }
      for (const item of linesToUpdate) {
        const current: any = currentById.get(item.id);
        if (!current) throw new ReceivingError("The imported receipt line was removed. Refresh and review the import.", 409);
        if (current.inboundShipmentLineId) throw new ReceivingError("Use the shipment receipt count controls for linked lines; an import cannot rewrite their source expectations.", 409, { code: "RECEIVING_EXPECTED_SOURCE_IMMUTABLE" });
        const variant = item.updates.productVariantId ? importedVariants.get(item.updates.productVariantId) : null;
        if (current.unitsPerVariantSnapshot != null && (!variant || variant.id !== current.productVariantId || variant.unitsPerVariant !== current.unitsPerVariantSnapshot)) throw new ReceivingError("An imported receive unit differs from the recorded line. Review and convert that line first.", 409, { code: "RECEIVING_UNIT_SOURCE_CHANGED", receivingLineId: item.id });
        if (variant) {
          if (current.productId != null && current.productId !== variant.productId) throw new ReceivingError("The imported variant belongs to another product.", 409, { code: "RECEIVING_VARIANT_PRODUCT_MISMATCH" });
          await this.assertReceiptSourceProduct(tx, current, lockedOrder, variant.productId);
          item.updates.productId = variant.productId;
          this.validateReceiptBaseCounts(item.updates, variant.unitsPerVariant);
        } else if (current.productId != null || current.productVariantId != null) {
          throw new ReceivingError("An import cannot clear a recorded receive product or unit.", 409, { code: "RECEIVING_VARIANT_REVIEW_REQUIRED" });
        }
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
  approvedInvoiceCostReconciler?: ApprovedInvoiceCostReconciler | null,
  receiveWarningEvaluator?: ReceiveWarningEvaluator | null,
  receiveWarningReporter?: ReceiveWarningReporter | null,
) {
  return new ReceivingService(
    db,
    inventoryCore,
    channelSync,
    storage,
    purchasing ?? null,
    shipmentTracking ?? null,
    reconciliationFailureReporter ?? null,
    approvedInvoiceCostReconciler ?? null,
    receiveWarningEvaluator ?? null,
    receiveWarningReporter ?? null,
  );
}
