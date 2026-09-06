import { sql, type SQL } from "drizzle-orm";
import {
  resolveReceivingUnitSnapshot,
  type PostedReceiptUnitEvidence,
} from "./receiving-unit-snapshot";

const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_COVERAGE_EVIDENCE_ROWS = 10_000;

export interface ShipmentReceiptCoverageSourceLine {
  id: number;
  purchaseOrderId: number | null;
  purchaseOrderLineId: number | null;
  qtyShipped: number;
}

export interface ClosedShipmentReceivingLine {
  id: number;
  receivingOrderId: number;
  purchaseOrderId: number | null;
  inboundShipmentId: number | null;
  purchaseOrderLineId: number | null;
  inboundShipmentLineId: number | null;
  unitsPerVariantSnapshot: number | null;
  receivedQty: number;
  reversedQty: number;
  receiptStatus: string;
}

export interface ShipmentReceiptCoverageReversal {
  id: number;
  receivingLineId: number;
  receivingOrderId: number;
  qty: number;
  baseUnitsReversed: number | null;
}

export interface ShipmentReceiptCoverageScope {
  purchaseOrderId: number;
  inboundShipmentId: number;
  /** Complete current shipment-line scope for this PO, not a selected subset. */
  shipmentLines: readonly ShipmentReceiptCoverageSourceLine[];
}

export interface ShipmentReceiptCoverageEvidence extends ShipmentReceiptCoverageScope {
  receivingLines: readonly ClosedShipmentReceivingLine[];
  postedReceipts: readonly PostedReceiptUnitEvidence[];
  reversals: readonly ShipmentReceiptCoverageReversal[];
}

export class ShipmentReceiptCoverageError extends Error {
  readonly statusCode = 409;
  readonly details: Record<string, unknown>;

  constructor(reason: string, context: Record<string, unknown>) {
    super(`Shipment receipt coverage needs review: ${reason}. Review the original receipt, shipment-line link and reversal postings before receiving the remainder.`);
    this.name = "ShipmentReceiptCoverageError";
    this.details = { code: "SHIPMENT_RECEIPT_COVERAGE_REVIEW_REQUIRED", ...context, reason };
  }
}

function review(reason: string, context: Record<string, unknown>): never {
  throw new ShipmentReceiptCoverageError(reason, context);
}

function databaseInteger(value: unknown, positive: boolean): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= (positive ? 1 : 0) && value <= MAX_DATABASE_INTEGER;
}

function validateScope(scope: ShipmentReceiptCoverageScope): void {
  if (!databaseInteger(scope.purchaseOrderId, true) || !databaseInteger(scope.inboundShipmentId, true)) {
    review("the requested purchase or shipment identity is invalid", {});
  }
  if (!Array.isArray(scope.shipmentLines) || scope.shipmentLines.length > MAX_COVERAGE_EVIDENCE_ROWS) {
    review("the shipment line scope exceeds the supported evidence limit", { inboundShipmentId: scope.inboundShipmentId });
  }
  const seen = new Set<number>();
  for (const line of scope.shipmentLines) {
    if (!databaseInteger(line.id, true) || seen.has(line.id) ||
      (line.purchaseOrderId !== null && line.purchaseOrderId !== scope.purchaseOrderId) ||
      (line.purchaseOrderLineId !== null && !databaseInteger(line.purchaseOrderLineId, true)) ||
      !databaseInteger(line.qtyShipped, false)) {
      review("a shipment line has invalid or conflicting source evidence", { inboundShipmentId: scope.inboundShipmentId, shipmentLineId: line.id });
    }
    seen.add(line.id);
  }
}

function groupedByReceivingLine<T extends { receivingLineId: number }>(rows: readonly T[]): Map<number, T[]> {
  const result = new Map<number, T[]>();
  for (const row of rows) {
    const values = result.get(row.receivingLineId) ?? [];
    values.push(row);
    result.set(row.receivingLineId, values);
  }
  return result;
}

/**
 * Net physically posted base pieces, keyed by exact shipment line. New frozen
 * receipts remain physical evidence while post-commit PO reconciliation retries.
 * Legacy lines require an exact PO posting and a single possible shipment line.
 * No current catalog factor, SKU match, or PO-wide distribution is permitted.
 */
export function computeClosedShipmentReceivedBaseQtyByLine(input: ShipmentReceiptCoverageEvidence): Map<number, number> {
  validateScope(input);
  const context = { purchaseOrderId: input.purchaseOrderId, inboundShipmentId: input.inboundShipmentId };
  for (const rows of [input.receivingLines, input.postedReceipts, input.reversals]) {
    if (!Array.isArray(rows) || rows.length > MAX_COVERAGE_EVIDENCE_ROWS) review("receipt evidence exceeds the supported limit", context);
  }
  const sourceById = new Map(input.shipmentLines.map((line) => [line.id, line]));
  const sourceByPoLine = new Map<number, ShipmentReceiptCoverageSourceLine[]>();
  for (const line of input.shipmentLines) {
    if (line.purchaseOrderLineId === null) continue;
    const candidates = sourceByPoLine.get(line.purchaseOrderLineId) ?? [];
    candidates.push(line);
    sourceByPoLine.set(line.purchaseOrderLineId, candidates);
  }
  const receivingIds = new Set<number>();
  for (const line of input.receivingLines) {
    if (!databaseInteger(line.id, true) || receivingIds.has(line.id)) review("receiving-line identities are invalid or duplicated", context);
    receivingIds.add(line.id);
  }
  const reversalIds = new Set<number>();
  for (const reversal of input.reversals) {
    if (!databaseInteger(reversal.id, true) || reversalIds.has(reversal.id)) review("reversal identities are invalid or duplicated", context);
    reversalIds.add(reversal.id);
  }
  for (const row of [...input.postedReceipts, ...input.reversals]) {
    if (!receivingIds.has(row.receivingLineId)) review("posting or reversal evidence has no matching receiving line", context);
  }

  const postingsByLine = groupedByReceivingLine(input.postedReceipts);
  const reversalsByLine = groupedByReceivingLine(input.reversals);
  const receivedByShipmentLine = new Map<number, number>();
  for (const line of input.receivingLines) {
    const lineContext = { ...context, receivingOrderId: line.receivingOrderId, receivingLineId: line.id };
    if (!databaseInteger(line.receivingOrderId, true) || line.receiptStatus !== "closed" ||
      line.inboundShipmentId !== input.inboundShipmentId ||
      (line.purchaseOrderId !== null && line.purchaseOrderId !== input.purchaseOrderId) ||
      !databaseInteger(line.receivedQty, false) || !databaseInteger(line.reversedQty, false) ||
      line.reversedQty > line.receivedQty) {
      review("a receipt's source, lifecycle or quantity counters disagree", lineContext);
    }
    const postings = postingsByLine.get(line.id) ?? [];
    const reversals = reversalsByLine.get(line.id) ?? [];
    // Zero-post legacy receipts contribute no coverage and retain their separate
    // recovery action. No unit factor or source mapping is invented for them.
    if (line.receivedQty === 0 && line.reversedQty === 0 && postings.length === 0 && reversals.length === 0) continue;
    if (!databaseInteger(line.purchaseOrderLineId, true)) review("a posted receipt lacks an exact PO-line identity", lineContext);

    let source: ShipmentReceiptCoverageSourceLine | undefined;
    if (line.inboundShipmentLineId !== null) {
      source = sourceById.get(line.inboundShipmentLineId);
      if (!source || source.purchaseOrderLineId !== line.purchaseOrderLineId) {
        review("the recorded shipment line does not belong to this receipt's source", lineContext);
      }
    } else {
      const candidates = sourceByPoLine.get(line.purchaseOrderLineId) ?? [];
      if (candidates.length !== 1 || postings.length !== 1) {
        review("a legacy receipt cannot be attributed to one shipment line from its original PO posting", lineContext);
      }
      source = candidates[0];
    }
    const factor = resolveReceivingUnitSnapshot({
      receivingLineId: line.id, receivingOrderId: line.receivingOrderId,
      purchaseOrderLineId: line.purchaseOrderLineId, purchaseOrderId: input.purchaseOrderId,
      receivedQty: line.receivedQty, unitsPerVariantSnapshot: line.unitsPerVariantSnapshot,
      receiptStatus: line.receiptStatus, postedReceipts: postings,
    });
    let reversedUnits = 0;
    let reversedBase = 0;
    for (const reversal of reversals) {
      if (reversal.receivingOrderId !== line.receivingOrderId ||
        !databaseInteger(reversal.qty, true) || !databaseInteger(reversal.baseUnitsReversed, true) ||
        reversal.baseUnitsReversed !== reversal.qty * factor) {
        review("a reversal does not prove the original receipt-unit conversion", { ...lineContext, reversalId: reversal.id });
      }
      reversedUnits += reversal.qty;
      reversedBase += reversal.baseUnitsReversed;
      if (!Number.isSafeInteger(reversedUnits) || !Number.isSafeInteger(reversedBase)) review("reversal totals exceed the supported range", lineContext);
    }
    const receivedBase = line.receivedQty * factor;
    if (reversedUnits !== line.reversedQty || reversedBase > receivedBase) review("the reversal postings do not match the receipt's reversed quantity", lineContext);
    const total = (receivedByShipmentLine.get(source.id) ?? 0) + receivedBase - reversedBase;
    if (!Number.isSafeInteger(total)) review("received base-piece totals exceed the supported exact range", lineContext);
    receivedByShipmentLine.set(source.id, total);
  }
  return receivedByShipmentLine;
}

type CoverageExecutor = { execute(query: SQL): Promise<{ rows: unknown[] }> };

function evidenceRows<T>(result: { rows: unknown[] }, context: Record<string, unknown>): T[] {
  if (!Array.isArray(result?.rows) || result.rows.length > MAX_COVERAGE_EVIDENCE_ROWS) {
    review("the receipt evidence query is incomplete or exceeds its supported limit", context);
  }
  return result.rows as T[];
}

/** Caller supplies a stable read transaction for a preview, or its authoritative
 * command transaction after source serialization. This loader takes no locks. */
export async function readClosedShipmentReceivedBaseQtyByLine(
  executor: CoverageExecutor,
  scope: ShipmentReceiptCoverageScope,
): Promise<Map<number, number>> {
  validateScope(scope);
  if (scope.shipmentLines.length === 0) return new Map();
  const context = { purchaseOrderId: scope.purchaseOrderId, inboundShipmentId: scope.inboundShipmentId };
  const sourceIds = sql.join(scope.shipmentLines.map((line) => sql`${line.id}`), sql`, `);
  const poLineIds = [...new Set(scope.shipmentLines.flatMap((line) => line.purchaseOrderLineId === null ? [] : [line.purchaseOrderLineId]))];
  const purchaseLineList = sql.join(poLineIds.map((id) => sql`${id}`), sql`, `);
  const receivingLines = evidenceRows<ClosedShipmentReceivingLine>(await executor.execute(sql`
    SELECT rl.id, rl.receiving_order_id AS "receivingOrderId", ro.purchase_order_id AS "purchaseOrderId",
           ro.inbound_shipment_id AS "inboundShipmentId", ro.status AS "receiptStatus",
           rl.purchase_order_line_id AS "purchaseOrderLineId", rl.inbound_shipment_line_id AS "inboundShipmentLineId",
           rl.units_per_variant_snapshot AS "unitsPerVariantSnapshot", rl.received_qty AS "receivedQty", rl.reversed_qty AS "reversedQty"
    FROM procurement.receiving_lines rl
    JOIN procurement.receiving_orders ro ON ro.id = rl.receiving_order_id
    WHERE ro.status = 'closed' AND (
      (ro.inbound_shipment_id = ${scope.inboundShipmentId} AND (
        ro.purchase_order_id = ${scope.purchaseOrderId} OR rl.purchase_order_line_id = ANY(ARRAY[${purchaseLineList}]::integer[])
      )) OR rl.inbound_shipment_line_id = ANY(ARRAY[${sourceIds}]::integer[])
    )
    ORDER BY rl.id LIMIT ${MAX_COVERAGE_EVIDENCE_ROWS + 1}
  `), context);
  if (receivingLines.length === 0) return new Map();
  const receiptLineIds = sql.join(receivingLines.map((line) => sql`${line.id}`), sql`, `);
  const postedReceipts = evidenceRows<PostedReceiptUnitEvidence>(await executor.execute(sql`
    SELECT receiving_line_id AS "receivingLineId", receiving_order_id AS "receivingOrderId",
           purchase_order_line_id AS "purchaseOrderLineId", purchase_order_id AS "purchaseOrderId", qty_received AS "qtyReceived"
    FROM procurement.po_receipts WHERE receiving_line_id = ANY(ARRAY[${receiptLineIds}]::integer[])
    ORDER BY id LIMIT ${MAX_COVERAGE_EVIDENCE_ROWS + 1}
  `), context);
  const reversals = evidenceRows<ShipmentReceiptCoverageReversal>(await executor.execute(sql`
    SELECT id, receiving_line_id AS "receivingLineId", receiving_order_id AS "receivingOrderId", qty,
           base_units_reversed AS "baseUnitsReversed"
    FROM procurement.receipt_reversals WHERE receiving_line_id = ANY(ARRAY[${receiptLineIds}]::integer[])
    ORDER BY id LIMIT ${MAX_COVERAGE_EVIDENCE_ROWS + 1}
  `), context);
  return computeClosedShipmentReceivedBaseQtyByLine({ ...scope, receivingLines, postedReceipts, reversals });
}
