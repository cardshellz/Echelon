import { sql, type SQL } from "drizzle-orm";
import { computeClosedShipmentReceivedBaseQtyByLine, ShipmentReceiptCoverageError,
  type ShipmentReceiptCoverageScope, type ClosedShipmentReceivingLine, type ShipmentReceiptCoverageReversal } from "./receiving-shipment-coverage";
import type { PostedReceiptUnitEvidence } from "./receiving-unit-snapshot";
import { computeShipmentReceiptCustodyCoverage, assertShipmentCustodyAdmission,
  type ShipmentCustodyObservationEvidence, type ShipmentCustodyAcceptanceEvidence } from "./domain/shipment-receipt-custody";

interface CoverageExecutor { execute(query: SQL): Promise<{ rows: unknown[] }> }
const MAX_EVIDENCE_ROWS = 10_000;
function rows<T>(value: unknown, context: Record<string, unknown>): T[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_ROWS || value.some(row => row === null || typeof row !== "object" || Array.isArray(row))) {
    throw new ShipmentReceiptCoverageError("custody and posting evidence is incomplete or exceeds the supported limit", context);
  }
  return value as T[];
}

/** One bounded SQL statement supplies one PostgreSQL snapshot. An acceptance
 * close cannot appear as new posted stock without its matching custody release.
 * Commands additionally hold the shared inventory/custody graph lock. */
export async function readShipmentReceiptCustodyCoverage(executor: CoverageExecutor, scope: ShipmentReceiptCoverageScope) {
  computeClosedShipmentReceivedBaseQtyByLine({ ...scope, receivingLines: [], postedReceipts: [], reversals: [] });
  if (scope.shipmentLines.length === 0) return computeShipmentReceiptCustodyCoverage({ ...scope,
    receivingLines: [], postedReceipts: [], reversals: [], custodyObservations: [], custodyAcceptances: [] });
  const context = { purchaseOrderId: scope.purchaseOrderId, inboundShipmentId: scope.inboundShipmentId };
  const sourceIds = sql.join(scope.shipmentLines.map(line => sql`${line.id}`), sql`, `);
  const poLineIds = [...new Set(scope.shipmentLines.flatMap(line => line.purchaseOrderLineId === null ? [] : [line.purchaseOrderLineId]))];
  const purchaseLineList = sql.join(poLineIds.map(id => sql`${id}`), sql`, `);
  const result = await executor.execute(sql`
    WITH receipt_rows AS MATERIALIZED (
      SELECT rl.id,rl.receiving_order_id AS "receivingOrderId",ro.purchase_order_id AS "purchaseOrderId",
        ro.inbound_shipment_id AS "inboundShipmentId",ro.status AS "receiptStatus",
        rl.purchase_order_line_id AS "purchaseOrderLineId",rl.inbound_shipment_line_id AS "inboundShipmentLineId",
        rl.units_per_variant_snapshot AS "unitsPerVariantSnapshot",rl.received_qty AS "receivedQty",rl.reversed_qty AS "reversedQty"
      FROM procurement.receiving_lines rl JOIN procurement.receiving_orders ro ON ro.id=rl.receiving_order_id
      WHERE ro.status='closed' AND ((ro.inbound_shipment_id=${scope.inboundShipmentId}
        AND (ro.purchase_order_id=${scope.purchaseOrderId} OR rl.purchase_order_line_id=ANY(ARRAY[${purchaseLineList}]::integer[])))
        OR rl.inbound_shipment_line_id=ANY(ARRAY[${sourceIds}]::integer[]))
      ORDER BY rl.id LIMIT ${MAX_EVIDENCE_ROWS + 1}
    ), posting_rows AS MATERIALIZED (
      SELECT receiving_line_id AS "receivingLineId",receiving_order_id AS "receivingOrderId",
        purchase_order_line_id AS "purchaseOrderLineId",purchase_order_id AS "purchaseOrderId",qty_received AS "qtyReceived"
      FROM procurement.po_receipts WHERE receiving_line_id IN(SELECT id FROM receipt_rows)
      ORDER BY id LIMIT ${MAX_EVIDENCE_ROWS + 1}
    ), reversal_rows AS MATERIALIZED (
      SELECT id,receiving_line_id AS "receivingLineId",receiving_order_id AS "receivingOrderId",qty,base_units_reversed AS "baseUnitsReversed"
      FROM procurement.receipt_reversals WHERE receiving_line_id IN(SELECT id FROM receipt_rows)
      ORDER BY id LIMIT ${MAX_EVIDENCE_ROWS + 1}
    ), custody_rows AS MATERIALIZED (
      SELECT q.id,q.receiving_order_id AS "receivingOrderId",q.receiving_line_id AS "receivingLineId",
        ro.purchase_order_id AS "purchaseOrderId",ro.inbound_shipment_id AS "inboundShipmentId",ro.status AS "receiptStatus",
        q.purchase_order_line_id AS "purchaseOrderLineId",q.inbound_shipment_line_id AS "inboundShipmentLineId",
        q.product_id AS "productId",q.units_per_variant_snapshot AS "unitsPerVariant",q.observed_qty AS "observedQty",
        q.awaiting_receipt_qty AS "awaitingReceiptQty",q.received_qty AS "receivedQty",q.returned_qty AS "returnedQty",q.version,
        rl.receiving_order_id AS "sourceReceivingOrderId",rl.purchase_order_line_id AS "sourcePurchaseOrderLineId",
        rl.inbound_shipment_line_id AS "sourceShipmentLineId",rl.product_id AS "sourceProductId",
        rl.units_per_variant_snapshot AS "sourceUnitsPerVariant",rl.received_qty AS "sourceReceivedQty",pol.product_id AS "purchaseProductId"
      FROM procurement.receiving_quarantine_observations q
      LEFT JOIN procurement.receiving_orders ro ON ro.id=q.receiving_order_id
      LEFT JOIN procurement.receiving_lines rl ON rl.id=q.receiving_line_id
      LEFT JOIN procurement.purchase_order_lines pol ON pol.id=q.purchase_order_line_id
      WHERE (ro.inbound_shipment_id=${scope.inboundShipmentId} AND
        (ro.purchase_order_id=${scope.purchaseOrderId} OR q.purchase_order_line_id=ANY(ARRAY[${purchaseLineList}]::integer[])))
        OR q.inbound_shipment_line_id=ANY(ARRAY[${sourceIds}]::integer[])
      ORDER BY q.id LIMIT ${MAX_EVIDENCE_ROWS + 1}
    ), acceptance_rows AS MATERIALIZED (
      SELECT a.id,a.observation_id AS "observationId",a.observation_qty AS "observationQty",a.receiving_order_id AS "receivingOrderId",
        a.receiving_line_id AS "receivingLineId",a.accepted_variant_qty AS "acceptedVariantQty",a.units_per_variant_snapshot AS "unitsPerVariant",a.status,
        ro.status AS "receiptStatus",ro.purchase_order_id AS "receiptPurchaseOrderId",ro.inbound_shipment_id AS "receiptShipmentId",
        rl.receiving_order_id AS "lineReceivingOrderId",rl.purchase_order_line_id AS "linePurchaseOrderLineId",
        rl.inbound_shipment_line_id AS "lineShipmentLineId",rl.units_per_variant_snapshot AS "lineUnitsPerVariant",rl.received_qty AS "lineReceivedQty"
      FROM procurement.receiving_quarantine_acceptances a
      LEFT JOIN procurement.receiving_orders ro ON ro.id=a.receiving_order_id
      LEFT JOIN procurement.receiving_lines rl ON rl.id=a.receiving_line_id
      WHERE a.observation_id IN(SELECT id FROM custody_rows)
      ORDER BY a.id LIMIT ${MAX_EVIDENCE_ROWS + 1}
    ) SELECT
      COALESCE((SELECT jsonb_agg(to_jsonb(receipt_rows)) FROM receipt_rows),'[]'::jsonb) AS "receivingLines",
      COALESCE((SELECT jsonb_agg(to_jsonb(posting_rows)) FROM posting_rows),'[]'::jsonb) AS "postedReceipts",
      COALESCE((SELECT jsonb_agg(to_jsonb(reversal_rows)) FROM reversal_rows),'[]'::jsonb) AS reversals,
      COALESCE((SELECT jsonb_agg(to_jsonb(custody_rows)) FROM custody_rows),'[]'::jsonb) AS "custodyObservations",
      COALESCE((SELECT jsonb_agg(to_jsonb(acceptance_rows)) FROM acceptance_rows),'[]'::jsonb) AS "custodyAcceptances"
  `);
  if (!Array.isArray(result.rows) || result.rows.length !== 1 || result.rows[0] === null || typeof result.rows[0] !== "object") {
    throw new ShipmentReceiptCoverageError("custody and posting snapshot is unavailable", context);
  }
  const snapshot = result.rows[0] as Record<string, unknown>;
  return computeShipmentReceiptCustodyCoverage({ ...scope,
    receivingLines: rows<ClosedShipmentReceivingLine>(snapshot.receivingLines, context),
    postedReceipts: rows<PostedReceiptUnitEvidence>(snapshot.postedReceipts, context),
    reversals: rows<ShipmentReceiptCoverageReversal>(snapshot.reversals, context),
    custodyObservations: rows<ShipmentCustodyObservationEvidence>(snapshot.custodyObservations, context),
    custodyAcceptances: rows<ShipmentCustodyAcceptanceEvidence>(snapshot.custodyAcceptances, context),
  });
}

/** Called inside normal receipt close after source resolution and its shared
 * graph/custody fence, before any lot, ledger or PO write. */
export async function assertShipmentReceiptCustodyAdmission(executor: CoverageExecutor, input: {
  receivingOrderId: number; purchaseOrderId: number | null; inboundShipmentId: number | null;
  lines: readonly { id: number; inboundShipmentLineId: number | null; receivedQty: number; unitsPerVariantSnapshot: number | null }[];
}): Promise<void> {
  if (input.inboundShipmentId === null || input.purchaseOrderId === null) return;
  const shipmentLines = rows<ShipmentReceiptCoverageScope["shipmentLines"][number]>((await executor.execute(sql`
    SELECT id,purchase_order_id AS "purchaseOrderId",purchase_order_line_id AS "purchaseOrderLineId",qty_shipped AS "qtyShipped"
    FROM procurement.inbound_shipment_lines WHERE inbound_shipment_id=${input.inboundShipmentId} AND purchase_order_id=${input.purchaseOrderId}
    ORDER BY id LIMIT ${MAX_EVIDENCE_ROWS + 1}
  `)).rows, { receivingOrderId: input.receivingOrderId });
  for (const line of input.lines) {
    if (line.receivedQty > 0 && (line.inboundShipmentLineId === null || !shipmentLines.some(source => source.id === line.inboundShipmentLineId))) {
      throw new ShipmentReceiptCoverageError("the counted receipt line is outside its exact shipment source scope", {
        receivingOrderId: input.receivingOrderId, receivingLineId: line.id, inboundShipmentLineId: line.inboundShipmentLineId,
      });
    }
  }
  const coverage = await readShipmentReceiptCustodyCoverage(executor, { purchaseOrderId: input.purchaseOrderId,
    inboundShipmentId: input.inboundShipmentId, shipmentLines });
  assertShipmentCustodyAdmission({ receivingOrderId: input.receivingOrderId, shipmentLines, coverage, receivingLines: input.lines });
}
