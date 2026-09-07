import { readRows, dateValues, moneyValues, uniqueIds, PURCHASE_WORKSPACE_RECORD_LIMIT, PURCHASE_WORKSPACE_LINE_LIMIT, type Row } from "./purchase-workspace-read";
import { readPurchaseCostEvidence } from "./purchase-cost-trace.repository";
export { PURCHASE_WORKSPACE_RECORD_LIMIT, PURCHASE_WORKSPACE_LINE_LIMIT } from "./purchase-workspace-read";
import { sql } from "drizzle-orm";
import { db as defaultDatabase } from "../../db";
import { purchaseWorkspaceSchema, type PurchaseWorkspace } from "@shared/procurement/purchase-workspace";
import {
  PurchaseWorkspaceError,
  type PurchaseWorkspaceRepository,
  type PurchaseWorkspaceSnapshot,
} from "./purchase-workspace.service";

type Database = Pick<typeof defaultDatabase, "transaction">;
export function createPurchaseWorkspaceRepository(database: Database = defaultDatabase): PurchaseWorkspaceRepository {
  return {
    async read(purchaseOrderId): Promise<PurchaseWorkspaceSnapshot | null> {
      return database.transaction(async (tx) => {
        const purchases = await readRows(tx, sql`
          SELECT p.id, p.po_number AS "poNumber", p.status,
            p.physical_status AS "physicalStatus", p.financial_status AS "financialStatus",
            p.currency, v.name AS "vendorName", p.total_cents AS "totalCents",
            p.invoiced_total_cents AS "invoicedTotalCents", p.paid_total_cents AS "paidTotalCents",
            p.outstanding_cents AS "outstandingCents",
            p.expected_delivery_date AS "expectedDeliveryDate",
            p.confirmed_delivery_date AS "confirmedDeliveryDate", p.actual_delivery_date AS "actualDeliveryDate"
          FROM procurement.purchase_orders p
          LEFT JOIN procurement.vendors v ON v.id = p.vendor_id
          WHERE p.id = ${purchaseOrderId}
          LIMIT 1
        `, "purchase", 1);
        if (purchases.length === 0) return null;

        const [purchaseLines, receiptRows, directShipmentRows, directInvoiceRows] = [
          await readRows(tx, sql`
            SELECT id, sku, product_name AS "productName", line_type AS "lineType",
              order_qty AS "orderedQty", received_qty AS "receivedQty", cancelled_qty AS "cancelledQty",
              CASE WHEN line_type = 'product' THEN 'pieces' ELSE 'not_applicable' END AS "quantityBasis"
            FROM procurement.purchase_order_lines
            WHERE purchase_order_id = ${purchaseOrderId}
            ORDER BY line_number, id LIMIT ${PURCHASE_WORKSPACE_LINE_LIMIT + 1}
          `, "purchase lines", PURCHASE_WORKSPACE_LINE_LIMIT),
          await readRows(tx, sql`
            SELECT ro.id, ro.receipt_number AS "receiptNumber", ro.status,
              ro.purchase_order_id AS "purchaseOrderId", ro.inbound_shipment_id AS "inboundShipmentId",
              ro.expected_date AS "expectedDate", ro.received_date AS "receivedDate", ro.closed_date AS "closedDate"
            FROM procurement.receiving_orders ro
            WHERE ro.purchase_order_id = ${purchaseOrderId}
              OR EXISTS (
                SELECT 1 FROM procurement.receiving_lines rl
                JOIN procurement.purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
                WHERE rl.receiving_order_id = ro.id AND pol.purchase_order_id = ${purchaseOrderId}
              )
              OR EXISTS (
                SELECT 1 FROM procurement.po_receipts pr
                WHERE pr.receiving_order_id = ro.id AND pr.purchase_order_id = ${purchaseOrderId}
              )
            ORDER BY ro.created_at, ro.id LIMIT ${PURCHASE_WORKSPACE_RECORD_LIMIT + 1}
          `, "receipts", PURCHASE_WORKSPACE_RECORD_LIMIT),
          await readRows(tx, sql`
            SELECT DISTINCT sl.inbound_shipment_id AS id
            FROM procurement.inbound_shipment_lines sl
            LEFT JOIN procurement.purchase_order_lines pol ON pol.id = sl.purchase_order_line_id
            WHERE sl.purchase_order_id = ${purchaseOrderId} OR pol.purchase_order_id = ${purchaseOrderId}
            ORDER BY sl.inbound_shipment_id LIMIT ${PURCHASE_WORKSPACE_RECORD_LIMIT + 1}
          `, "purchase shipment links", PURCHASE_WORKSPACE_RECORD_LIMIT),
          await readRows(tx, sql`
            SELECT l.vendor_invoice_id AS "invoiceId", i.inbound_shipment_id AS "shipmentId"
            FROM procurement.vendor_invoice_po_links l
            JOIN procurement.vendor_invoices i ON i.id = l.vendor_invoice_id
            WHERE l.purchase_order_id = ${purchaseOrderId}
            UNION
            SELECT il.vendor_invoice_id AS "invoiceId", i.inbound_shipment_id AS "shipmentId"
            FROM procurement.vendor_invoice_lines il
            JOIN procurement.vendor_invoices i ON i.id = il.vendor_invoice_id
            JOIN procurement.purchase_order_lines pol ON pol.id = il.purchase_order_line_id
            WHERE pol.purchase_order_id = ${purchaseOrderId}
            ORDER BY "invoiceId" LIMIT ${PURCHASE_WORKSPACE_RECORD_LIMIT + 1}
          `, "purchase invoice links", PURCHASE_WORKSPACE_RECORD_LIMIT),
        ] as const;

        const shipmentIds = uniqueIds([
          ...directShipmentRows.map((row) => row.id),
          ...receiptRows.map((row) => row.inboundShipmentId),
          ...directInvoiceRows.map((row) => row.shipmentId),
        ]);
        const [shipmentRows, shipmentLines, shipmentInvoiceRows, connectedReceiptRows] = shipmentIds.length === 0 ? [[], [], [], []] : [
          await readRows(tx, sql`
            SELECT id, shipment_number AS "shipmentNumber", status, mode, container_number AS "containerNumber",
              eta, delivered_date AS "deliveredDate", estimated_total_cost_cents AS "estimatedTotalCostCents",
              actual_total_cost_cents AS "actualTotalCostCents"
            FROM procurement.inbound_shipments
            WHERE id = ANY(${sql.param(shipmentIds)}::int[])
            ORDER BY created_at, id LIMIT ${PURCHASE_WORKSPACE_RECORD_LIMIT + 1}
          `, "shipments", PURCHASE_WORKSPACE_RECORD_LIMIT),
          await readRows(tx, sql`
            SELECT sl.id, sl.inbound_shipment_id AS "shipmentId", sl.purchase_order_id AS "purchaseOrderId",
              sl.purchase_order_line_id AS "purchaseOrderLineId",
              pol.purchase_order_id AS "purchaseOrderLinePurchaseOrderId",
              sl.sku, sl.qty_shipped AS "qtyShipped", sl.allocated_cost_cents AS "allocatedCostCents"
            FROM procurement.inbound_shipment_lines sl
            LEFT JOIN procurement.purchase_order_lines pol ON pol.id = sl.purchase_order_line_id
            WHERE sl.inbound_shipment_id = ANY(${sql.param(shipmentIds)}::int[])
            ORDER BY sl.inbound_shipment_id, sl.id LIMIT ${PURCHASE_WORKSPACE_LINE_LIMIT + 1}
          `, "shipment lines", PURCHASE_WORKSPACE_LINE_LIMIT),
          await readRows(tx, sql`
            SELECT id AS "invoiceId", inbound_shipment_id AS "shipmentId"
            FROM procurement.vendor_invoices WHERE inbound_shipment_id = ANY(${sql.param(shipmentIds)}::int[])
            UNION
            SELECT vendor_invoice_id AS "invoiceId", inbound_shipment_id AS "shipmentId"
            FROM procurement.inbound_freight_costs
            WHERE inbound_shipment_id = ANY(${sql.param(shipmentIds)}::int[]) AND vendor_invoice_id IS NOT NULL
            ORDER BY "invoiceId", "shipmentId" LIMIT ${PURCHASE_WORKSPACE_LINE_LIMIT + 1}
          `, "shipment invoice links", PURCHASE_WORKSPACE_LINE_LIMIT),
          await readRows(tx, sql`
            SELECT id, receipt_number AS "receiptNumber", status,
              purchase_order_id AS "purchaseOrderId", inbound_shipment_id AS "inboundShipmentId",
              expected_date AS "expectedDate", received_date AS "receivedDate", closed_date AS "closedDate"
            FROM procurement.receiving_orders
            WHERE inbound_shipment_id = ANY(${sql.param(shipmentIds)}::int[])
            ORDER BY created_at, id LIMIT ${PURCHASE_WORKSPACE_RECORD_LIMIT + 1}
          `, "connected shipment receipts", PURCHASE_WORKSPACE_RECORD_LIMIT),
        ] as const;
        const invoiceIds = uniqueIds([
          ...directInvoiceRows.map((row) => row.invoiceId),
          ...shipmentInvoiceRows.map((row) => row.invoiceId),
        ]);
        if (invoiceIds.length > PURCHASE_WORKSPACE_RECORD_LIMIT) {
          throw new PurchaseWorkspaceError("PURCHASE_WORKSPACE_TOO_LARGE", "Too many linked invoices for one workspace.", 422);
        }
        const [invoiceRows, invoicePoLinks] = invoiceIds.length === 0 ? [[], []] : [
          await readRows(tx, sql`
            SELECT id, invoice_number AS "invoiceNumber", status, currency,
              invoice_date AS "invoiceDate", due_date AS "dueDate", inbound_shipment_id AS "inboundShipmentId",
              invoiced_amount_cents AS "invoicedAmountCents", paid_amount_cents AS "paidAmountCents", balance_cents AS "balanceCents"
            FROM procurement.vendor_invoices
            WHERE id = ANY(${sql.param(invoiceIds)}::int[])
            ORDER BY invoice_date, id LIMIT ${PURCHASE_WORKSPACE_RECORD_LIMIT + 1}
          `, "invoices", PURCHASE_WORKSPACE_RECORD_LIMIT),
          await readRows(tx, sql`
            SELECT vendor_invoice_id AS "invoiceId", purchase_order_id AS "purchaseOrderId",
              allocated_amount_cents AS "allocatedAmountCents"
            FROM procurement.vendor_invoice_po_links
            WHERE vendor_invoice_id = ANY(${sql.param(invoiceIds)}::int[])
            ORDER BY vendor_invoice_id, purchase_order_id LIMIT ${PURCHASE_WORKSPACE_LINE_LIMIT + 1}
          `, "invoice purchase links", PURCHASE_WORKSPACE_LINE_LIMIT),
        ] as const;

        const linesByShipment = new Map<number, Row[]>();
        for (const line of shipmentLines) {
          const shipmentId = uniqueIds([line.shipmentId])[0];
          const group = linesByShipment.get(shipmentId) ?? [];
          group.push(line);
          linesByShipment.set(shipmentId, group);
        }
        const linksByInvoice = new Map<number, Row[]>();
        for (const link of invoicePoLinks) {
          const invoiceId = uniqueIds([link.invoiceId])[0];
          const group = linksByInvoice.get(invoiceId) ?? [];
          group.push(link);
          linksByInvoice.set(invoiceId, group);
        }
        const purchase = purchaseWorkspaceSchema.shape.purchase.parse({
          ...dateValues(moneyValues(purchases[0], ["totalCents", "invoicedTotalCents", "paidTotalCents", "outstandingCents"]),
            ["expectedDeliveryDate", "confirmedDeliveryDate", "actualDeliveryDate"]),
          lines: purchaseLines,
        });
        const shipments: PurchaseWorkspace["shipments"] = shipmentRows.map((row) => {
          const lines = linesByShipment.get(row.id as number) ?? [];
          return purchaseWorkspaceSchema.shape.shipments.element.parse({
            ...dateValues(moneyValues(row, ["estimatedTotalCostCents", "actualTotalCostCents"]), ["eta", "deliveredDate"]),
            amountScope: "whole_shipment",
            purchaseOrderIds: uniqueIds(lines.flatMap((line) => [line.purchaseOrderId, line.purchaseOrderLinePurchaseOrderId])),
            unlinkedLineCount: lines.filter((line) => line.purchaseOrderId === null && line.purchaseOrderLinePurchaseOrderId === null).length,
            lines: lines.map((line) => moneyValues(line, ["allocatedCostCents"])),
          });
        });
        const receiptMap = new Map([...receiptRows, ...connectedReceiptRows].map((row) => [row.id, row]));
        if (receiptMap.size > PURCHASE_WORKSPACE_RECORD_LIMIT) {
          throw new PurchaseWorkspaceError("PURCHASE_WORKSPACE_TOO_LARGE", "Too many connected receipts for one workspace.", 422);
        }
        const receipts = [...receiptMap.values()].map((row) =>
          purchaseWorkspaceSchema.shape.receipts.element.parse(dateValues(row, ["expectedDate", "receivedDate", "closedDate"])));
        const invoices = invoiceRows.map((row) => {
          const links = linksByInvoice.get(row.id as number) ?? [];
          const purchaseLink = links.find((link) => link.purchaseOrderId === purchaseOrderId);
          return purchaseWorkspaceSchema.shape.invoices.element.parse({
            ...dateValues(moneyValues({
              ...row,
              allocatedToPurchaseCents: purchaseLink ? purchaseLink.allocatedAmountCents : null,
            }, ["invoicedAmountCents", "paidAmountCents", "balanceCents", "allocatedToPurchaseCents"]), ["invoiceDate", "dueDate"]),
            amountScope: "whole_invoice",
            purchaseOrderIds: uniqueIds(links.map((link) => link.purchaseOrderId)),
          });
        });

        return {
          purchase,
          costEvidence: await readPurchaseCostEvidence(tx, purchaseOrderId, shipmentIds),
          shipments,
          receipts,
          invoices,
          directShipmentIds: uniqueIds(directShipmentRows.map((row) => row.id)),
          directReceiptIds: uniqueIds(receiptRows.map((receipt) => receipt.id)),
          directInvoiceIds: uniqueIds(directInvoiceRows.map((row) => row.invoiceId)),
          shipmentInvoiceLinks: shipmentInvoiceRows.map((row) => ({
            shipmentId: uniqueIds([row.shipmentId])[0],
            invoiceId: uniqueIds([row.invoiceId])[0],
          })),
        };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}
