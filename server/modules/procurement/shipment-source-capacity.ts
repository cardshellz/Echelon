import { and, inArray, sql } from "drizzle-orm";
import { purchaseOrderLines, purchaseOrders } from "@shared/schema";
import type { PurchaseOrder, PurchaseOrderLine } from "@shared/schema";
import { PO_PHYSICAL_STATUSES, poStatusEnum } from "@shared/schema/procurement.schema";

const MAX_DATABASE_ID = 2_147_483_647;
const MAX_EVIDENCE_ROWS = 10_000;
const SHIPMENT_STATUSES = new Set([
  "draft", "booked", "in_transit", "at_port", "customs_clearance", "delivered", "costing", "closed", "cancelled",
]);

export class ShipmentSourceCapacityError extends Error {
  constructor(message: string, public statusCode: number, public details: Record<string, unknown>) {
    super(message);
    this.name = "ShipmentSourceCapacityError";
  }
}

function review(reason: string, context: Record<string, unknown> = {}): never {
  throw new ShipmentSourceCapacityError(
    "Shipment quantity needs source review before it can change. " + reason,
    409,
    { code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED", ...context },
  );
}

function quantity(value: unknown, field: string, context: Record<string, unknown>): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return review(`Recorded ${field} is not a nonnegative safe integer.`, context);
  }
  return value;
}

function sum(left: number, right: number, context: Record<string, unknown>): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) return review("Recorded quantities exceed the supported exact range.", context);
  return result;
}

export interface ShipmentCapacityCommitment {
  id: number;
  inboundShipmentId: number;
  purchaseOrderId: number | null;
  purchaseOrderLineId: number;
  qtyShipped: number;
  shipmentStatus: string | null;
}

export interface ShipmentCapacityReceipt {
  id: number;
  purchaseOrderId: number;
  purchaseOrderLineId: number;
  receivingOrderId: number;
  receivingLineId: number;
  qtyReceived: number;
  receiptExists: boolean;
  receivingLineExists: boolean;
  receivingLinePurchaseOrderLineId: number | null;
  receiptLineAllocationCount: number;
  receivedVariantQty: number;
  reversedVariantQty: number;
  receiptPurchaseOrderId: number | null;
  inboundShipmentId: number | null;
  receiptStatus: string | null;
}

export interface ShipmentCapacityReversal {
  receivingLineId: number;
  receivingOrderId: number;
  qty: number;
  baseUnitsReversed: number | null;
}

export interface ShipmentSourceCapacity {
  purchaseOrder: PurchaseOrder;
  line: PurchaseOrderLine;
  committedShipmentQty: number;
  directReceivedQty: number;
  remainingQty: number;
}

/**
 * PO and shipment quantities are base pieces. po_receipts snapshots are also
 * base pieces; receiving_lines quantities and live catalog pack sizes are not
 * substitutes. A completed shipment's receipt overlaps its commitment and must
 * not be subtracted twice. Incomplete or contradictory lineage stops the write.
 */
export function computeShipmentSourceCapacity(input: {
  purchaseOrder: PurchaseOrder;
  line: PurchaseOrderLine;
  commitments: readonly ShipmentCapacityCommitment[];
  receipts: readonly ShipmentCapacityReceipt[];
  reversals: readonly ShipmentCapacityReversal[];
  unpostedClosedReceivingLineIds?: readonly number[];
  pendingDirectReceivingOrderIds?: readonly number[];
  excludeShipmentLineId?: number;
}): ShipmentSourceCapacity {
  const { purchaseOrder, line, commitments, receipts, reversals } = input;
  const context = { purchaseOrderId: purchaseOrder.id, purchaseOrderLineId: line.id };
  if (line.purchaseOrderId !== purchaseOrder.id) review("The PO line has inconsistent purchase ownership.", context);
  if (!(poStatusEnum as readonly string[]).includes(purchaseOrder.status) ||
      (purchaseOrder.physicalStatus != null && !(PO_PHYSICAL_STATUSES as readonly string[]).includes(purchaseOrder.physicalStatus))) {
    review("The purchase has an unrecognized lifecycle status.", context);
  }
  if (["received", "closed", "cancelled"].includes(purchaseOrder.status) ||
      ["received", "short_closed", "cancelled"].includes(purchaseOrder.physicalStatus ?? "")) {
    throw new ShipmentSourceCapacityError("This purchase no longer accepts shipment allocations.", 409, {
      code: "SHIPMENT_LINE_SOURCE_INELIGIBLE", ...context,
    });
  }
  if ((line.lineType ?? "product") !== "product" || !["open", "partially_received"].includes(line.status)) {
    throw new ShipmentSourceCapacityError("Only open or partially received product PO lines accept shipment allocations.", 409, {
      code: "SHIPMENT_LINE_SOURCE_INELIGIBLE", ...context,
    });
  }
  if (!Number.isSafeInteger(line.productId) || (line.productId ?? 0) <= 0 || (line.productId ?? 0) > MAX_DATABASE_ID) {
    review("The product PO line has no valid product identity.", context);
  }
  const ordered = quantity(line.orderQty, "ordered pieces", context);
  const cancelled = quantity(line.cancelledQty ?? 0, "cancelled pieces", context);
  const received = quantity(line.receivedQty ?? 0, "received pieces", context);
  if (ordered > MAX_DATABASE_ID || cancelled > ordered) review("The PO quantity counters are inconsistent.", context);
  if (input.pendingDirectReceivingOrderIds?.length) {
    review("A direct PO receipt is unfinished. Finish or cancel that receipt, then review the source quantities and retry.", {
      ...context, receivingOrderIds: [...input.pendingDirectReceivingOrderIds],
    });
  }
  if (input.unpostedClosedReceivingLineIds?.length) {
    review("A closed receipt has received units without a matching base-piece posting. Reconcile the receipt first.", {
      ...context, receivingLineIds: [...input.unpostedClosedReceivingLineIds],
    });
  }

  const shipmentQuantities = new Map<number, number>();
  const allCommitmentIds = new Set<number>();
  let committed = 0;
  let excluded = 0;
  for (const row of commitments) {
    if (allCommitmentIds.has(row.id)) review("Shipment commitment evidence contains duplicate line identities.", context);
    allCommitmentIds.add(row.id);
    if (row.purchaseOrderLineId !== line.id || (row.purchaseOrderId !== null && row.purchaseOrderId !== purchaseOrder.id)) {
      review("A shipment line has inconsistent purchase links.", { ...context, shipmentLineId: row.id });
    }
    if (!row.shipmentStatus || !SHIPMENT_STATUSES.has(row.shipmentStatus)) {
      review("A linked shipment is missing or has an unrecognized status.", { ...context, shipmentLineId: row.id });
    }
    const shipped = quantity(row.qtyShipped, "shipment pieces", context);
    if (shipped === 0 || shipped > MAX_DATABASE_ID) review("A linked shipment has invalid shipped pieces.", context);
    if (row.shipmentStatus === "cancelled") continue;
    shipmentQuantities.set(row.inboundShipmentId, sum(shipmentQuantities.get(row.inboundShipmentId) ?? 0, shipped, context));
    committed = sum(committed, shipped, context);
    if (row.id === input.excludeShipmentLineId) excluded = shipped;
  }
  if (input.excludeShipmentLineId !== undefined && !allCommitmentIds.has(input.excludeShipmentLineId)) {
    review("The shipment line being changed is absent from its source commitments.", context);
  }

  const reversalsByLine = new Map<number, number>();
  const reversalVariantQtyByLine = new Map<number, number>();
  const reversalOrderByLine = new Map<number, number>();
  for (const reversal of reversals) {
    const reversed = quantity(reversal.baseUnitsReversed, "reversal base-piece snapshot", context);
    if (reversed === 0) review("A receipt reversal is missing its positive base-piece snapshot.", context);
    const reversedVariants = quantity(reversal.qty, "reversal variant quantity", context);
    if (reversedVariants === 0) review("A receipt reversal has no positive recorded variant quantity.", context);
    const previousOrder = reversalOrderByLine.get(reversal.receivingLineId);
    if (previousOrder !== undefined && previousOrder !== reversal.receivingOrderId) review("Receipt reversal ownership is inconsistent.", context);
    reversalOrderByLine.set(reversal.receivingLineId, reversal.receivingOrderId);
    reversalVariantQtyByLine.set(reversal.receivingLineId, sum(reversalVariantQtyByLine.get(reversal.receivingLineId) ?? 0, reversedVariants, context));
    reversalsByLine.set(reversal.receivingLineId, sum(reversalsByLine.get(reversal.receivingLineId) ?? 0, reversed, context));
  }
  const receiptLineIds = new Set<number>();
  const receiptIds = new Set<number>();
  const receivedByShipment = new Map<number, number>();
  let recordedReceived = 0;
  let directReceived = 0;
  for (const row of receipts) {
    if (receiptIds.has(row.id) || receiptLineIds.has(row.receivingLineId)) review("Receipt evidence has duplicate identities.", context);
    receiptIds.add(row.id);
    receiptLineIds.add(row.receivingLineId);
    if (!row.receiptExists || !row.receivingLineExists || row.purchaseOrderId !== purchaseOrder.id ||
        row.purchaseOrderLineId !== line.id ||
        (row.receiptPurchaseOrderId !== null && row.receiptPurchaseOrderId !== purchaseOrder.id) ||
        (row.receivingLinePurchaseOrderLineId !== null && row.receivingLinePurchaseOrderLineId !== line.id)) {
      review("A receipt has incomplete or inconsistent purchase lineage.", { ...context, receivingOrderId: row.receivingOrderId });
    }
    if (row.receiptStatus !== "closed") review("A receipt posting does not belong to a closed receipt.", context);
    if (row.receiptLineAllocationCount !== 1) review("A receiving line has ambiguous PO allocation evidence.", context);
    const receivedVariants = quantity(row.receivedVariantQty, "received variant quantity", context);
    const reversedVariants = quantity(row.reversedVariantQty, "reversed variant quantity", context);
    const posted = quantity(row.qtyReceived, "receipt base-piece snapshot", context);
    if (reversedVariants > receivedVariants || reversedVariants !== (reversalVariantQtyByLine.get(row.receivingLineId) ?? 0) ||
        ((receivedVariants === 0) !== (posted === 0)) ||
        (reversalOrderByLine.has(row.receivingLineId) && reversalOrderByLine.get(row.receivingLineId) !== row.receivingOrderId)) {
      review("The receipt and reversal snapshots do not reconcile to the receiving line.", context);
    }
    const reversed = reversalsByLine.get(row.receivingLineId) ?? 0;
    if (reversed > posted) review("Receipt reversals exceed their recorded base-piece posting.", context);
    const net = posted - reversed;
    recordedReceived = sum(recordedReceived, net, context);
    if (row.inboundShipmentId === null) {
      directReceived = sum(directReceived, net, context);
    } else {
      // Do not reinterpret receipt history attached to a cancelled/missing
      // shipment as a direct PO receipt: that relationship needs review.
      if (!shipmentQuantities.has(row.inboundShipmentId)) review("Receipt history references a missing or cancelled shipment commitment.", context);
      receivedByShipment.set(row.inboundShipmentId, sum(receivedByShipment.get(row.inboundShipmentId) ?? 0, net, context));
    }
  }
  if ([...reversalsByLine.keys()].some((id) => !receiptLineIds.has(id))) review("A reversal has no matching base-piece receipt posting.", context);
  if (recordedReceived !== received) {
    review("PO received pieces do not reconcile to recorded receipt and reversal snapshots.", {
      ...context, receivedQty: received, recordedReceivedQty: recordedReceived,
    });
  }
  for (const [shipmentId, receiptQty] of receivedByShipment) {
    if (receiptQty > (shipmentQuantities.get(shipmentId) ?? 0)) {
      review("Shipment-linked receipts exceed their original recorded shipment pieces.", { ...context, shipmentId });
    }
  }
  // Exclude only after checking receipt overlap against the original complete
  // shipment commitment. The command owner separately blocks receipt history.
  committed -= excluded;
  const consumed = sum(committed, directReceived, context);
  const remaining = ordered - cancelled - consumed;
  if (!Number.isSafeInteger(remaining) || remaining < 0) review("Existing shipment and direct receipt commitments exceed the PO quantity.", context);
  return { purchaseOrder, line, committedShipmentQty: committed, directReceivedQty: directReceived, remainingQty: remaining };
}

function ids(values: readonly number[], label: string): number[] {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > MAX_DATABASE_ID) || new Set(values).size !== values.length) {
    throw new ShipmentSourceCapacityError(`${label} must contain distinct positive database IDs.`, 400, { code: "SHIPMENT_LINE_SOURCE_IDS_INVALID" });
  }
  return [...values].sort((a, b) => a - b);
}

/** Caller must hold the target shipment FOR UPDATE before calling this function.
 * Both ID lists are explicit and nonempty; empty never means "all". Preflight
 * candidate IDs are revalidated against locked ownership and current counters.
 */
export interface ShipmentSourceCapacityInput {
  purchaseOrderIds: readonly number[];
  purchaseOrderLineIds: readonly number[];
  excludeShipmentLineId?: number;
}

export interface ShipmentSourceCapacityProjection {
  capacities: Map<number, ShipmentSourceCapacity>;
  reviewRequired: Map<number, ShipmentSourceCapacityError>;
}

async function loadShipmentSourceCapacities(tx: any, input: ShipmentSourceCapacityInput, lockSources: boolean): Promise<ShipmentSourceCapacityProjection> {
  const purchaseOrderIds = ids(input.purchaseOrderIds, "Purchase order IDs");
  const lineIds = ids(input.purchaseOrderLineIds, "Purchase order line IDs");
  if (input.excludeShipmentLineId !== undefined) ids([input.excludeShipmentLineId], "Excluded shipment line ID");
  const headerQuery = tx.select().from(purchaseOrders)
    .where(inArray(purchaseOrders.id, purchaseOrderIds)).orderBy(purchaseOrders.id);
  const headers: PurchaseOrder[] = await (lockSources ? headerQuery.for("update") : headerQuery);
  if (headers.length !== purchaseOrderIds.length) throw new ShipmentSourceCapacityError("Purchase order not found.", 404, { code: "SHIPMENT_LINE_SOURCE_NOT_FOUND" });
  const lineQuery = tx.select().from(purchaseOrderLines)
    .where(and(inArray(purchaseOrderLines.purchaseOrderId, purchaseOrderIds), inArray(purchaseOrderLines.id, lineIds)))
    .orderBy(purchaseOrderLines.id);
  const lines: PurchaseOrderLine[] = await (lockSources ? lineQuery.for("update") : lineQuery);
  if (lines.length !== lineIds.length) throw new ShipmentSourceCapacityError("A selected PO line is missing or belongs to another purchase.", 409, { code: "SHIPMENT_LINE_SOURCE_OWNERSHIP_CHANGED" });
  const list = sql.join(lineIds.map((id) => sql`${id}`), sql`, `);
  const purchaseList = sql.join(purchaseOrderIds.map((id) => sql`${id}`), sql`, `);
  const commitments = await tx.execute(sql`
    SELECT isl.id, isl.inbound_shipment_id AS "inboundShipmentId", isl.purchase_order_id AS "purchaseOrderId",
           isl.purchase_order_line_id AS "purchaseOrderLineId", isl.qty_shipped AS "qtyShipped", s.status AS "shipmentStatus"
    FROM procurement.inbound_shipment_lines isl
    LEFT JOIN procurement.inbound_shipments s ON s.id = isl.inbound_shipment_id
    WHERE isl.purchase_order_line_id = ANY(ARRAY[${list}]::integer[])
    ORDER BY isl.id LIMIT ${MAX_EVIDENCE_ROWS + 1}
  `);
  const receipts = await tx.execute(sql`
    SELECT pr.id, pr.purchase_order_id AS "purchaseOrderId", pr.purchase_order_line_id AS "purchaseOrderLineId",
           pr.receiving_order_id AS "receivingOrderId", pr.receiving_line_id AS "receivingLineId", pr.qty_received AS "qtyReceived",
           (ro.id IS NOT NULL) AS "receiptExists", (rl.id IS NOT NULL AND rl.receiving_order_id = pr.receiving_order_id) AS "receivingLineExists",
           (SELECT COUNT(*)::int FROM procurement.po_receipts other_pr WHERE other_pr.receiving_line_id = pr.receiving_line_id) AS "receiptLineAllocationCount",
           rl.received_qty AS "receivedVariantQty", rl.reversed_qty AS "reversedVariantQty",
           rl.purchase_order_line_id AS "receivingLinePurchaseOrderLineId", ro.purchase_order_id AS "receiptPurchaseOrderId",
           ro.inbound_shipment_id AS "inboundShipmentId", ro.status AS "receiptStatus"
    FROM procurement.po_receipts pr
    LEFT JOIN procurement.receiving_orders ro ON ro.id = pr.receiving_order_id
    LEFT JOIN procurement.receiving_lines rl ON rl.id = pr.receiving_line_id
    WHERE pr.purchase_order_line_id = ANY(ARRAY[${list}]::integer[])
    ORDER BY pr.id LIMIT ${MAX_EVIDENCE_ROWS + 1}
  `);
  const reversals = await tx.execute(sql`
    SELECT rr.receiving_line_id AS "receivingLineId", rr.receiving_order_id AS "receivingOrderId", rr.qty,
           rr.base_units_reversed AS "baseUnitsReversed",
           COALESCE(pr.purchase_order_line_id, rl.purchase_order_line_id) AS "purchaseOrderLineId"
    FROM procurement.receipt_reversals rr
    LEFT JOIN procurement.receiving_lines rl ON rl.id = rr.receiving_line_id
    LEFT JOIN procurement.po_receipts pr ON pr.receiving_line_id = rr.receiving_line_id
    WHERE COALESCE(pr.purchase_order_line_id, rl.purchase_order_line_id) = ANY(ARRAY[${list}]::integer[])
    ORDER BY rr.id LIMIT ${MAX_EVIDENCE_ROWS + 1}
  `);
  // Inspect unfinished receipts before looking for closed-but-unreconciled
  // receipts. A direct receipt can post inventory without the PO lock, then
  // wait on this transaction to reconcile its PO counters. In this order it
  // is observed either as pending here or as missing its posting below.
  const pendingDirectReceipts = await tx.execute(sql`
    SELECT ro.id, ro.purchase_order_id AS "purchaseOrderId", rl.purchase_order_line_id AS "purchaseOrderLineId"
    FROM procurement.receiving_orders ro
    LEFT JOIN procurement.receiving_lines rl ON rl.receiving_order_id = ro.id
    WHERE ro.inbound_shipment_id IS NULL AND ro.status NOT IN ('closed', 'cancelled')
      AND (
        rl.purchase_order_line_id = ANY(ARRAY[${list}]::integer[])
        OR (rl.purchase_order_line_id IS NULL AND ro.purchase_order_id = ANY(ARRAY[${purchaseList}]::integer[]))
      )
    ORDER BY ro.id, rl.id LIMIT ${MAX_EVIDENCE_ROWS + 1}
  `);
  const missingPostings = await tx.execute(sql`
    SELECT rl.id, rl.purchase_order_line_id AS "purchaseOrderLineId", ro.purchase_order_id AS "purchaseOrderId"
    FROM procurement.receiving_lines rl
    JOIN procurement.receiving_orders ro ON ro.id = rl.receiving_order_id
    WHERE (
        rl.purchase_order_line_id = ANY(ARRAY[${list}]::integer[])
        OR (rl.purchase_order_line_id IS NULL AND ro.purchase_order_id = ANY(ARRAY[${purchaseList}]::integer[]))
      )
      AND ro.status = 'closed' AND (rl.received_qty <> 0 OR rl.reversed_qty <> 0)
      AND NOT EXISTS (SELECT 1 FROM procurement.po_receipts pr WHERE pr.receiving_line_id = rl.id AND (rl.purchase_order_line_id IS NULL OR pr.purchase_order_line_id = rl.purchase_order_line_id))
    ORDER BY rl.id LIMIT ${MAX_EVIDENCE_ROWS + 1}
  `);
  for (const result of [commitments, receipts, reversals, missingPostings, pendingDirectReceipts]) {
    if (!Array.isArray(result.rows)) review("The source evidence query returned an invalid result.");
    if (result.rows.length > MAX_EVIDENCE_ROWS) review("The source history exceeds the bounded command review limit.");
  }
  const headerById = new Map(headers.map((header) => [header.id, header]));
  const result = new Map<number, ShipmentSourceCapacity>();
  const reviewRequired = new Map<number, ShipmentSourceCapacityError>();
  for (const line of lines) {
    const lineCommitments = (commitments.rows as ShipmentCapacityCommitment[]).filter((row) => row.purchaseOrderLineId === line.id);
    try {
      result.set(line.id, computeShipmentSourceCapacity({
        purchaseOrder: headerById.get(line.purchaseOrderId)!, line,
        commitments: lineCommitments,
        receipts: (receipts.rows as ShipmentCapacityReceipt[]).filter((row) => row.purchaseOrderLineId === line.id),
        reversals: (reversals.rows as Array<ShipmentCapacityReversal & { purchaseOrderLineId: number }>).filter((row) => row.purchaseOrderLineId === line.id),
        unpostedClosedReceivingLineIds: (missingPostings.rows as Array<{ id: number; purchaseOrderLineId: number | null; purchaseOrderId: number | null }>)
          .filter((row) => row.purchaseOrderLineId === line.id || (row.purchaseOrderLineId === null && row.purchaseOrderId === line.purchaseOrderId)).map((row) => row.id),
        pendingDirectReceivingOrderIds: [...new Set((pendingDirectReceipts.rows as Array<{ id: number; purchaseOrderLineId: number | null; purchaseOrderId: number | null }>)
          .filter((row) => row.purchaseOrderLineId === line.id || (row.purchaseOrderLineId === null && row.purchaseOrderId === line.purchaseOrderId)).map((row) => row.id))],
        ...(input.excludeShipmentLineId !== undefined && lineCommitments.some((row) => row.id === input.excludeShipmentLineId)
          ? { excludeShipmentLineId: input.excludeShipmentLineId } : {}),
      }));
    } catch (error) {
      if (lockSources || !(error instanceof ShipmentSourceCapacityError)) throw error;
      reviewRequired.set(line.id, error);
    }
  }
  if (input.excludeShipmentLineId !== undefined && !(commitments.rows as ShipmentCapacityCommitment[]).some((row) => row.id === input.excludeShipmentLineId)) {
    review("The excluded shipment line is absent from the selected source lines.");
  }
  return { capacities: result, reviewRequired };
}

/** Authoritative write check; the caller already owns the shipment lock. */
export async function lockShipmentSourceCapacity(tx: any, input: ShipmentSourceCapacityInput): Promise<Map<number, ShipmentSourceCapacity>> {
  return (await loadShipmentSourceCapacities(tx, input, true)).capacities;
}

/** Indicative read projection. No row locks or writes; callers may provide a
 * repeatable-read, read-only transaction for one coherent display snapshot.
 * The write owner always rechecks current evidence under its source locks.
 */
export async function readShipmentSourceCapacities(tx: any, input: Omit<ShipmentSourceCapacityInput, "excludeShipmentLineId">): Promise<ShipmentSourceCapacityProjection> {
  return loadShipmentSourceCapacities(tx, input, false);
}


/** Application read boundary for the PO's shipment chooser. Display quantities
 * come from the same evidence and pure calculation as the locked write owner.
 */
export async function getShippablePurchaseOrderLines(db: any, purchaseOrderId: number) {
  ids([purchaseOrderId], "Purchase order ID");
  return db.transaction(async (tx: any) => {
    const found = await tx.select({ id: purchaseOrders.id }).from(purchaseOrders)
      .where(inArray(purchaseOrders.id, [purchaseOrderId])).limit(1);
    if (!found[0]) throw new ShipmentSourceCapacityError("Purchase order not found.", 404, { code: "SHIPMENT_LINE_SOURCE_NOT_FOUND" });
    const rawLines: PurchaseOrderLine[] = await tx.select().from(purchaseOrderLines)
      .where(inArray(purchaseOrderLines.purchaseOrderId, [purchaseOrderId])).orderBy(purchaseOrderLines.id);
    const candidates = rawLines.filter((line) => (line.lineType ?? "product") === "product" && ["open", "partially_received"].includes(line.status));
    if (candidates.length === 0) return { lines: [], reviewRequiredLines: [] };
    const projection = await readShipmentSourceCapacities(tx, {
      purchaseOrderIds: [purchaseOrderId], purchaseOrderLineIds: candidates.map((line) => line.id),
    });
    return {
      lines: candidates.flatMap((line) => {
        const capacity = projection.capacities.get(line.id);
        return capacity && capacity.remainingQty > 0 ? [{
          ...capacity.line, alreadyShippedQty: capacity.committedShipmentQty,
          directReceivedQty: capacity.directReceivedQty, remainingQty: capacity.remainingQty,
        }] : [];
      }),
      reviewRequiredLines: candidates.flatMap((line) => {
        const error = projection.reviewRequired.get(line.id);
        return error ? [{ ...line, remainingQty: null, code: String(error.details.code), error: error.message }] : [];
      }),
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
