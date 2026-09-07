import { readReceiptCostQueue } from "./receipt-cost-queue-read.repository";
import { readPurchaseCostApplications } from "./purchase-cost-application-read.repository";
import { sql } from "drizzle-orm";
import { purchaseCostEvidenceSchema, type PurchaseCostEvidence } from "./purchase-cost-trace.service";
import { dateValues, moneyValues, readRows, PURCHASE_WORKSPACE_LINE_LIMIT, type Transaction } from "./purchase-workspace-read";

/** Runs inside the workspace's read-only, repeatable-read transaction. Every
 * source is bounded; excess history fails visibly rather than truncating cost. */
export async function readPurchaseCostEvidence(tx: Transaction, purchaseOrderId: number, shipmentIds: readonly number[]): Promise<PurchaseCostEvidence> {
  const [purchaseLines, invoiceLines, receiptLines, postings, shipmentCharges, allocations, applications, receiptCostQueue] = [
    await readRows(tx, sql`
      SELECT id, sku, line_type AS "lineType", status,
        pricing_basis AS "pricingBasis", pricing_source AS "pricingSource", quote_reference AS "quoteReference",
        order_qty AS "orderedQty", received_qty AS "receivedQty", cancelled_qty AS "cancelledQty",
        total_product_cost_cents AS "productCents", packaging_cost_cents AS "packagingCents",
        discount_cents AS "discountCents", tax_cents AS "taxCents", line_total_cents AS "lineTotalCents",
        unit_cost_mills AS "productUnitMills", pricing_remainder_mills AS "pricingRemainderMills",
        promised_date AS "promisedDate", expected_delivery_date AS "expectedDeliveryDate"
      FROM procurement.purchase_order_lines WHERE purchase_order_id = ${purchaseOrderId}
      ORDER BY line_number, id LIMIT ${PURCHASE_WORKSPACE_LINE_LIMIT + 1}
    `, "purchase cost source lines", PURCHASE_WORKSPACE_LINE_LIMIT),
    await readRows(tx, sql`
      SELECT il.id, il.vendor_invoice_id AS "invoiceId", il.purchase_order_line_id AS "purchaseOrderLineId",
        il.qty_invoiced AS quantity, il.unit_cost_cents AS "unitCostCents", il.unit_cost_mills AS "unitCostMills",
        il.line_total_cents AS "lineTotalCents", il.match_status AS "matchStatus", il.cost_component_evidence AS "costComponentEvidence"
      FROM procurement.vendor_invoice_lines il
      JOIN procurement.purchase_order_lines pol ON pol.id = il.purchase_order_line_id
      WHERE pol.purchase_order_id = ${purchaseOrderId}
      ORDER BY il.vendor_invoice_id, il.line_number, il.id LIMIT ${PURCHASE_WORKSPACE_LINE_LIMIT + 1}
    `, "invoice cost source lines", PURCHASE_WORKSPACE_LINE_LIMIT),
    await readRows(tx, sql`
      SELECT rl.id, rl.receiving_order_id AS "receiptId", rl.purchase_order_line_id AS "purchaseOrderLineId",
        ro.status AS "receiptStatus", ro.purchase_order_id AS "receiptPurchaseOrderId",
        rl.product_variant_id AS "receiptVariantId", rl.product_id AS "receiptProductId", pol.product_id AS "purchaseLineProductId",
        ro.inbound_shipment_id AS "shipmentId", rl.inbound_shipment_line_id AS "shipmentLineId",
        sl.inbound_shipment_id AS "sourceShipmentId", sl.purchase_order_id AS "sourcePurchaseOrderId",
        sl.purchase_order_line_id AS "sourcePurchaseOrderLineId", rl.received_qty AS "receivedUnits",
        rl.reversed_qty AS "reversedUnits", rl.units_per_variant_snapshot AS "frozenPiecesPerUnit"
      FROM procurement.receiving_lines rl
      JOIN procurement.receiving_orders ro ON ro.id = rl.receiving_order_id
      JOIN procurement.purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
      LEFT JOIN procurement.inbound_shipment_lines sl ON sl.id = rl.inbound_shipment_line_id
      WHERE pol.purchase_order_id = ${purchaseOrderId}
      ORDER BY rl.receiving_order_id, rl.id LIMIT ${PURCHASE_WORKSPACE_LINE_LIMIT + 1}
    `, "receipt cost lineage lines", PURCHASE_WORKSPACE_LINE_LIMIT),
    await readRows(tx, sql`
      SELECT it.id, it.receiving_line_id AS "receivingLineId", it.receiving_order_id AS "receivingOrderId",
        it.product_variant_id AS "variantId", it.variant_qty_delta AS "variantQuantity",
        it.created_at AS "postedAt", it.voided_at AS "voidedAt",
        l.id AS "lotId", l.lot_number AS "lotNumber", l.product_variant_id AS "lotVariantId",
        l.warehouse_location_id AS "locationId", l.qty_on_hand AS "onHandUnits",
        l.qty_reserved AS "reservedUnits", l.qty_picked AS "pickedUnits",
        l.po_unit_cost_mills AS "productUnitMills", l.packaging_cost_mills AS "packagingUnitMills",
        l.landed_cost_mills AS "landedUnitMills", l.total_unit_cost_mills AS "totalUnitMills",
        l.cost_provisional AS "recordedProvisional", l.receiving_order_id AS "lotReceivingOrderId",
        l.purchase_order_id AS "lotPurchaseOrderId", l.po_line_id AS "lotPurchaseOrderLineId",
        l.inbound_shipment_id AS "lotShipmentId"
      FROM inventory.inventory_transactions it
      JOIN procurement.receiving_lines rl ON rl.id = it.receiving_line_id
      JOIN procurement.purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
      LEFT JOIN inventory.inventory_lots l ON l.id = it.inventory_lot_id
      WHERE pol.purchase_order_id = ${purchaseOrderId} AND it.transaction_type = 'receipt'
      ORDER BY it.receiving_line_id, it.id LIMIT ${PURCHASE_WORKSPACE_LINE_LIMIT + 1}
    `, "original receipt lot postings", PURCHASE_WORKSPACE_LINE_LIMIT),
    shipmentIds.length === 0 ? [] : await readRows(tx, sql`
      SELECT id, inbound_shipment_id AS "shipmentId", cost_type AS "costType", description,
        currency, exchange_rate::text AS "exchangeRate", estimated_cents AS "estimatedCents",
        actual_cents AS "actualCents", cost_status AS "recordedStatus", vendor_invoice_id AS "invoiceId"
      FROM procurement.inbound_freight_costs
      WHERE inbound_shipment_id = ANY(${sql.param(shipmentIds)}::int[])
      ORDER BY inbound_shipment_id, id LIMIT ${PURCHASE_WORKSPACE_LINE_LIMIT + 1}
    `, "shipment cost sources", PURCHASE_WORKSPACE_LINE_LIMIT),
    shipmentIds.length === 0 ? [] : await readRows(tx, sql`
      SELECT a.id, a.shipment_cost_id AS "chargeId", c.inbound_shipment_id AS "chargeShipmentId",
        sl.inbound_shipment_id AS "shipmentId", a.inbound_shipment_line_id AS "shipmentLineId",
        sl.purchase_order_line_id AS "purchaseOrderLineId", sl.purchase_order_id AS "purchaseOrderId",
        a.allocated_cents AS "allocatedCents", a.allocation_basis_value::text AS "basisValue",
        a.allocation_basis_total::text AS "basisTotal"
      FROM procurement.inbound_freight_allocations a
      JOIN procurement.inbound_freight_costs c ON c.id = a.shipment_cost_id
      JOIN procurement.inbound_shipment_lines sl ON sl.id = a.inbound_shipment_line_id
      JOIN procurement.purchase_order_lines pol ON pol.id = sl.purchase_order_line_id
      WHERE pol.purchase_order_id = ${purchaseOrderId}
        AND c.inbound_shipment_id = ANY(${sql.param(shipmentIds)}::int[])
      ORDER BY a.shipment_cost_id, a.inbound_shipment_line_id, a.id LIMIT ${PURCHASE_WORKSPACE_LINE_LIMIT + 1}
    `, "purchase shipment cost allocations", PURCHASE_WORKSPACE_LINE_LIMIT),
    await readPurchaseCostApplications(tx, purchaseOrderId),
    await readReceiptCostQueue(tx, purchaseOrderId),
  ] as const;

  return purchaseCostEvidenceSchema.parse({
    applications, receiptCostQueue,
    purchaseLines: purchaseLines.map((row) => dateValues(moneyValues(row, [
      "productCents", "packagingCents", "discountCents", "taxCents", "lineTotalCents", "productUnitMills", "pricingRemainderMills",
    ]), ["promisedDate", "expectedDeliveryDate"])),
    invoiceLines: invoiceLines.map((row) => moneyValues(row, ["unitCostCents", "unitCostMills", "lineTotalCents"])),
    shipmentCharges: shipmentCharges.map((row) => moneyValues(row, ["estimatedCents", "actualCents"])),
    allocations: allocations.map((row) => moneyValues(row, ["allocatedCents"])),
    receiptLines,
    postings: postings.map((row) => ({
      ...dateValues(row, ["postedAt", "voidedAt"]),
      lot: row.lotId === null ? null : {
        ...moneyValues(row, ["productUnitMills", "packagingUnitMills", "landedUnitMills", "totalUnitMills"]),
        id: row.lotId, variantId: row.lotVariantId,
        recordedProvisional: row.recordedProvisional === 1 ? true : row.recordedProvisional === 0 ? false : row.recordedProvisional,
        receivingOrderId: row.lotReceivingOrderId, purchaseOrderId: row.lotPurchaseOrderId,
        purchaseOrderLineId: row.lotPurchaseOrderLineId, shipmentId: row.lotShipmentId,
      },
    })),
  });
}
