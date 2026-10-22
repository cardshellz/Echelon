import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { assertPoDirectCustodyAdmission, inspectPoDirectCustodyEvidence, MAX_PO_DIRECT_CUSTODY_ROWS,
  PoDirectCustodySourceError, type PoDirectCustodyEvidence, type PoDirectReceiptLine } from "./domain/po-direct-receipt-custody";

interface CustodyExecutor { execute(query: SQL): Promise<{ rows: unknown[] }> }
const id = z.number().int().positive().max(2_147_483_647);
const count = z.number().int().min(0).max(2_147_483_647);
const nullableId = id.nullable();
const observation = z.object({
  id, receivingOrderId: id, receivingLineId: nullableId, purchaseOrderId: nullableId, inboundShipmentId: nullableId,
  receiptStatus: z.string().nullable(), purchaseOrderLineId: nullableId, inboundShipmentLineId: nullableId,
  productId: nullableId, productVariantId: nullableId, unitsPerVariant: nullableId,
  observedQty: id, awaitingReceiptQty: count, receivedQty: count, returnedQty: count, version: count,
  sourceReceivingOrderId: nullableId, sourcePurchaseOrderLineId: nullableId, sourceShipmentLineId: nullableId,
  sourceProductId: nullableId, sourceProductVariantId: nullableId, sourceUnitsPerVariant: nullableId, sourceReceivedQty: count.nullable(),
  purchaseLineOrderId: nullableId, purchaseProductId: nullableId,
  shipmentLineOrderId: nullableId, shipmentLinePurchaseOrderId: nullableId, shipmentLinePurchaseLineId: nullableId,
});
const acceptance = z.object({
  id, observationId: id, observationQty: id, receivingOrderId: id, receivingLineId: id,
  productId: id, productVariantId: id, unitsPerVariant: id, acceptedVariantQty: id,
  status: z.enum(["awaiting_receipt", "received", "cancelled"]), receiptStatus: z.string().nullable(),
  receiptPurchaseOrderId: nullableId, receiptShipmentId: nullableId, lineReceivingOrderId: nullableId,
  linePurchaseOrderLineId: nullableId, lineShipmentLineId: nullableId, lineProductId: nullableId,
  lineProductVariantId: nullableId, lineUnitsPerVariant: nullableId, lineReceivedQty: count.nullable(),
});
const unidentifiedAcceptance = acceptance.extend({ observationReceivingOrderId: id, observationReceivingLineId: nullableId,
  observationProductId: nullableId, observationProductVariantId: nullableId, observationUnitsPerVariant: nullableId,
  observationPurchaseOrderLineId: nullableId, observationShipmentLineId: nullableId,
  observationObservedQty: id, observationAwaitingReceiptQty: count, observationReceivedQty: count,
  observationReturnedQty: count, observationVersion: count, observationWarehouseId: id,
  sourceReceiptStatus: z.string().nullable(),
  sourceReceiptWarehouseId: nullableId, receiptWarehouseId: nullableId, targetPurchaseOrderId: nullableId, targetPurchaseProductId: nullableId,
});
const snapshot = z.object({ observations: z.array(observation).max(MAX_PO_DIRECT_CUSTODY_ROWS),
  acceptances: z.array(acceptance).max(MAX_PO_DIRECT_CUSTODY_ROWS),
  unidentifiedAcceptances: z.array(unidentifiedAcceptance).max(MAX_PO_DIRECT_CUSTODY_ROWS) });

async function readEvidence(executor: CustodyExecutor, purchaseOrderId: number, receivingOrderId: number | null = null): Promise<PoDirectCustodyEvidence> {
  if (!id.safeParse(purchaseOrderId).success || (receivingOrderId !== null && !id.safeParse(receivingOrderId).success)) {
    throw new PoDirectCustodySourceError(purchaseOrderId, new Map(), "A valid purchase identity is required.");
  }
  // One bounded statement observes both immutable identities and disposition
  // counters coherently. Write callers also hold the inventory/custody fence.
  const result = await executor.execute(sql`
    WITH purchase_lines AS MATERIALIZED (
      SELECT id FROM procurement.purchase_order_lines WHERE purchase_order_id=${purchaseOrderId}
    ), observations AS MATERIALIZED (
      SELECT q.id,q.receiving_order_id AS "receivingOrderId",q.receiving_line_id AS "receivingLineId",
        ro.purchase_order_id AS "purchaseOrderId",ro.inbound_shipment_id AS "inboundShipmentId",ro.status AS "receiptStatus",
        q.purchase_order_line_id AS "purchaseOrderLineId",q.inbound_shipment_line_id AS "inboundShipmentLineId",
        q.product_id AS "productId",q.product_variant_id AS "productVariantId",q.units_per_variant_snapshot AS "unitsPerVariant",
        q.observed_qty AS "observedQty",q.awaiting_receipt_qty AS "awaitingReceiptQty",q.received_qty AS "receivedQty",
        q.returned_qty AS "returnedQty",q.version,
        rl.receiving_order_id AS "sourceReceivingOrderId",rl.purchase_order_line_id AS "sourcePurchaseOrderLineId",
        rl.inbound_shipment_line_id AS "sourceShipmentLineId",rl.product_id AS "sourceProductId",
        rl.product_variant_id AS "sourceProductVariantId",rl.units_per_variant_snapshot AS "sourceUnitsPerVariant",
        rl.received_qty AS "sourceReceivedQty",pol.purchase_order_id AS "purchaseLineOrderId",pol.product_id AS "purchaseProductId",
        sl.inbound_shipment_id AS "shipmentLineOrderId",sl.purchase_order_id AS "shipmentLinePurchaseOrderId",
        sl.purchase_order_line_id AS "shipmentLinePurchaseLineId"
      FROM procurement.receiving_quarantine_observations q
      LEFT JOIN procurement.receiving_orders ro ON ro.id=q.receiving_order_id
      LEFT JOIN procurement.receiving_lines rl ON rl.id=q.receiving_line_id
      LEFT JOIN procurement.purchase_order_lines pol ON pol.id=q.purchase_order_line_id
      LEFT JOIN procurement.inbound_shipment_lines sl ON sl.id=q.inbound_shipment_line_id
      WHERE q.purchase_order_line_id IN(SELECT id FROM purchase_lines)
        OR rl.purchase_order_line_id IN(SELECT id FROM purchase_lines)
        OR (ro.purchase_order_id=${purchaseOrderId} AND q.product_id IS NOT NULL)
      ORDER BY q.id LIMIT ${MAX_PO_DIRECT_CUSTODY_ROWS + 1}
    ), acceptances AS MATERIALIZED (
      SELECT a.id,a.observation_id AS "observationId",a.observation_qty AS "observationQty",
        a.receiving_order_id AS "receivingOrderId",a.receiving_line_id AS "receivingLineId",a.product_id AS "productId",
        a.product_variant_id AS "productVariantId",a.units_per_variant_snapshot AS "unitsPerVariant",
        a.accepted_variant_qty AS "acceptedVariantQty",a.status,ro.status AS "receiptStatus",
        ro.purchase_order_id AS "receiptPurchaseOrderId",ro.inbound_shipment_id AS "receiptShipmentId",
        rl.receiving_order_id AS "lineReceivingOrderId",rl.purchase_order_line_id AS "linePurchaseOrderLineId",
        rl.inbound_shipment_line_id AS "lineShipmentLineId",rl.product_id AS "lineProductId",
        rl.product_variant_id AS "lineProductVariantId",rl.units_per_variant_snapshot AS "lineUnitsPerVariant",
        rl.received_qty AS "lineReceivedQty"
      FROM procurement.receiving_quarantine_acceptances a
      LEFT JOIN procurement.receiving_orders ro ON ro.id=a.receiving_order_id
      LEFT JOIN procurement.receiving_lines rl ON rl.id=a.receiving_line_id
      WHERE a.observation_id IN(SELECT id FROM observations)
      ORDER BY a.id LIMIT ${MAX_PO_DIRECT_CUSTODY_ROWS + 1}
    ), unidentified_acceptances AS MATERIALIZED (
      SELECT a.id,a.observation_id AS "observationId",a.observation_qty AS "observationQty",
        a.receiving_order_id AS "receivingOrderId",a.receiving_line_id AS "receivingLineId",a.product_id AS "productId",
        a.product_variant_id AS "productVariantId",a.units_per_variant_snapshot AS "unitsPerVariant",
        a.accepted_variant_qty AS "acceptedVariantQty",a.status,ro.status AS "receiptStatus",
        ro.purchase_order_id AS "receiptPurchaseOrderId",ro.inbound_shipment_id AS "receiptShipmentId",
        rl.receiving_order_id AS "lineReceivingOrderId",rl.purchase_order_line_id AS "linePurchaseOrderLineId",
        rl.inbound_shipment_line_id AS "lineShipmentLineId",rl.product_id AS "lineProductId",
        rl.product_variant_id AS "lineProductVariantId",rl.units_per_variant_snapshot AS "lineUnitsPerVariant",
        rl.received_qty AS "lineReceivedQty",q.receiving_order_id AS "observationReceivingOrderId",
        q.receiving_line_id AS "observationReceivingLineId",q.product_id AS "observationProductId",
        q.product_variant_id AS "observationProductVariantId",q.units_per_variant_snapshot AS "observationUnitsPerVariant",
        q.purchase_order_line_id AS "observationPurchaseOrderLineId",q.inbound_shipment_line_id AS "observationShipmentLineId",
        q.observed_qty AS "observationObservedQty",q.awaiting_receipt_qty AS "observationAwaitingReceiptQty",
        q.received_qty AS "observationReceivedQty",q.returned_qty AS "observationReturnedQty",q.version AS "observationVersion",
        q.warehouse_id AS "observationWarehouseId",source_ro.warehouse_id AS "sourceReceiptWarehouseId",source_ro.status AS "sourceReceiptStatus",
        ro.warehouse_id AS "receiptWarehouseId",pol.purchase_order_id AS "targetPurchaseOrderId",pol.product_id AS "targetPurchaseProductId"
      FROM procurement.receiving_quarantine_acceptances a
      JOIN procurement.receiving_quarantine_observations q ON q.id=a.observation_id
      LEFT JOIN procurement.receiving_orders ro ON ro.id=a.receiving_order_id
      LEFT JOIN procurement.receiving_orders source_ro ON source_ro.id=q.receiving_order_id
      LEFT JOIN procurement.receiving_lines rl ON rl.id=a.receiving_line_id
      LEFT JOIN procurement.purchase_order_lines pol ON pol.id=rl.purchase_order_line_id
      WHERE a.receiving_order_id=${receivingOrderId} AND a.status='awaiting_receipt' AND q.product_id IS NULL
      ORDER BY a.id LIMIT ${MAX_PO_DIRECT_CUSTODY_ROWS + 1}
    ) SELECT COALESCE((SELECT jsonb_agg(to_jsonb(observations)) FROM observations),'[]'::jsonb) AS observations,
      COALESCE((SELECT jsonb_agg(to_jsonb(acceptances)) FROM acceptances),'[]'::jsonb) AS acceptances,
      COALESCE((SELECT jsonb_agg(to_jsonb(unidentified_acceptances)) FROM unidentified_acceptances),'[]'::jsonb) AS "unidentifiedAcceptances"
  `);
  const parsed = z.array(snapshot).length(1).safeParse(result.rows);
  if (!parsed.success) {
    throw new PoDirectCustodySourceError(purchaseOrderId, new Map(), "Custody evidence is incomplete, malformed or exceeds the supported limit.");
  }
  return { purchaseOrderId, ...parsed.data[0] };
}

export async function readPoDirectCustodySources(executor: CustodyExecutor, purchaseOrderId: number): Promise<Map<number, number[]>> {
  return inspectPoDirectCustodyEvidence(await readEvidence(executor, purchaseOrderId)).sources;
}

/** Caller resolved and persisted exact PO sources under the normal close
 * transaction's graph/custody fence. This does not assign a shipment identity. */
export async function assertPoDirectReceiptCustodyAdmission(executor: CustodyExecutor, input: {
  receivingOrderId: number; purchaseOrderId: number; lines: readonly PoDirectReceiptLine[];
}): Promise<void> {
  assertPoDirectCustodyAdmission(await readEvidence(executor, input.purchaseOrderId, input.receivingOrderId), input);
}
