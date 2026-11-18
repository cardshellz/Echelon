import { receiptInvoiceCostRows } from "./domain/receipt-invoice-preview";
import { sql } from "drizzle-orm";
import {
  receiptInvoiceContextSchema,
  receiptInvoiceApprovalHistorySchema,
} from "@shared/procurement/receipt-invoice-costs";
import {
  costFingerprint,
  costInteger,
  CostEvidenceError,
  lockInventoryCostGraph,
} from "../inventory/infrastructure/cost-evidence.repository";
import {
  readPurchaseApprovalActor,
  readPurchaseApproverName,
} from "../identity/purchase-approval-authority.api";
import { assertInvoiceQuantityAuthority } from "./invoice-quantity-correction.policy";
import { readPoAmendmentDependencies } from "./po-amendment-dependencies.repository";
import { readPurchaseCostSource } from "./purchase-cost-source.repository";
import { readReceiptCostingEvidence } from "./receipt-invoice-costs.repository";
import { resolvePurchaseCostSource } from "./domain/purchase-cost-source";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";

export async function readReceiptInvoiceApprovalHistory(
  tx: AmendmentTransaction,
  purchaseOrderId: number,
) {
  const rows = (
    await tx.execute(sql`SELECT event.payload_json->>'actorName' AS "actorName",
    event.payload_json->>'approvedAt' AS "approvedAt",event.payload_json->>'reason' AS reason,
    event.payload_json->'preview' AS preview,line.id AS "purchaseOrderLineId",COALESCE(line.product_name,line.sku,'Product') AS label
    FROM procurement.po_events event JOIN procurement.purchase_order_lines line
      ON line.id=(event.payload_json->'preview'->'change'->>'purchaseOrderLineId')::integer
    WHERE event.po_id=${purchaseOrderId} AND line.purchase_order_id=${purchaseOrderId} AND event.event_type='receipt_invoice_costs_approved'
    ORDER BY event.id DESC LIMIT 20`)
  ).rows;
  return receiptInvoiceApprovalHistorySchema.parse(rows);
}

/** Same graph-first protocol as receiving/AP and other purchasing approvals. */
export async function readReceiptInvoiceReviewSource(
  tx: AmendmentTransaction,
  lineId: number,
  actorId: string,
) {
  await lockInventoryCostGraph(tx);
  const line = (
    await tx.execute(sql`SELECT line.*,po.po_number,po.cancelled_at,po.vendor_id AS po_vendor_id FROM procurement.purchase_order_lines line
    JOIN procurement.purchase_orders po ON po.id=line.purchase_order_id WHERE line.id=${lineId} FOR UPDATE OF po,line`)
  ).rows[0];
  if (
    !line ||
    line.line_type !== "product" ||
    line.cancelled_at ||
    ["cancelled", "short_closed"].includes(String(line.status))
  )
    throw new CostEvidenceError(
      "RECEIPT_COST_SOURCE_INVALID",
      "Choose a current product PO line before assigning receipt costs.",
    );
  await tx.execute(sql`SELECT invoice.id FROM procurement.vendor_invoices invoice JOIN procurement.vendor_invoice_lines line
    ON line.vendor_invoice_id=invoice.id WHERE line.purchase_order_line_id=${lineId} ORDER BY invoice.id,line.id FOR UPDATE OF invoice,line`);
  await tx.execute(sql`SELECT line.id FROM procurement.receiving_lines line JOIN procurement.receiving_orders receipt ON receipt.id=line.receiving_order_id
    WHERE line.purchase_order_line_id=${lineId} ORDER BY receipt.id,line.id FOR UPDATE OF receipt,line`);
  const dependencies = await readPoAmendmentDependencies(tx, [lineId]);
  const source = await readPurchaseCostSource(tx, lineId);
  if (!source)
    throw new CostEvidenceError(
      "RECEIPT_COST_SOURCE_INVALID",
      "The purchase cost source is unavailable.",
    );
  const receiptCosting =
    source.receiptCosting ?? (await readReceiptCostingEvidence(tx, lineId));
  const actor = await readPurchaseApprovalActor(tx, actorId),
    actorName = await readPurchaseApproverName(tx, actorId);
  let canApprove = true;
  try {
    assertInvoiceQuantityAuthority(actor);
  } catch {
    canApprove = false;
  }
  const invoices = (
    await tx.execute(sql`SELECT line.id,line.vendor_invoice_id AS "invoiceId",invoice.invoice_number AS "invoiceNumber",invoice.vendor_id
    FROM procurement.vendor_invoice_lines line JOIN procurement.vendor_invoices invoice ON invoice.id=line.vendor_invoice_id
    WHERE line.purchase_order_line_id=${lineId} AND invoice.status IN ('approved','partially_paid','paid') ORDER BY line.id LIMIT 10001`)
  ).rows;
  if (
    invoices.some((row) => Number(row.vendor_id) !== Number(line.po_vendor_id))
  )
    throw new CostEvidenceError(
      "RECEIPT_INVOICE_SUPPLIER_MISMATCH",
      "The invoice supplier differs from the PO supplier. Review the invoice link before assigning its costs.",
    );
  if (invoices.length > 1000)
    throw new CostEvidenceError(
      "RECEIPT_COST_LIMIT",
      "The complete receipt invoice review exceeds 1000 invoices.",
    );
  const approvals = (
    await tx.execute(sql`SELECT context->>'actorName' AS "actorName",timestamp AS "approvedAt",context->>'reason' AS reason,changes->'preview' AS preview
    FROM public.audit_events WHERE action='procurement.receipt_invoice_costs.approved' AND target=${`purchase_order_line:${lineId}`}
    ORDER BY id DESC LIMIT 20`)
  ).rows;
  const sourceVersion = costFingerprint({
    reviewVersion: 1,
    line,
    source,
    receiptCosting,
    invoiceMetadata: invoices,
    dependencies,
    actor,
  });
  const context = receiptInvoiceContextSchema.parse({
    purchaseOrderLineId: lineId,
    purchaseOrderId: line.purchase_order_id,
    label: String(line.product_name || line.sku || `Line ${line.line_number}`),
    enabled: Boolean(source.receiptCosting),
    sourceVersion,
    canApprove,
    allocations: receiptCosting.allocations,
    receipts: receiptCosting.receipts,
    costs: receiptInvoiceCostRows(source, receiptCosting.receipts),
    invoices: invoices.map((row) => {
      const invoice = source.approvedInvoices.find(
        (invoice) => Number(invoice.id) === Number(row.id),
      )!;
      const candidate = resolvePurchaseCostSource({
        purchaseOrderLine: {
          ...source.purchaseOrderLine,
          order_qty: invoice.qty_invoiced,
          received_qty: invoice.qty_invoiced,
          status: "open",
        },
        approvedInvoices: [invoice],
      });
      return {
        id: row.id,
        invoiceId: row.invoiceId,
        invoiceNumber: row.invoiceNumber,
        pieces: costInteger(invoice.qty_invoiced, "invoice pieces", 1),
        amountCents: costInteger(invoice.line_total_cents, "invoice amount"),
        ready: candidate.every(
          (row) => row.evidence === "confirmed" && row.currency === "USD",
        ),
      };
    }),
    approvals: approvals.map((row) => ({
      ...row,
      approvedAt: new Date(row.approvedAt as string).toISOString(),
    })),
  });
  return {
    context,
    source,
    receiptCosting,
    invoiceMetadata: invoices,
    dependencies,
    actor,
    actorName,
    line,
    sourceVersion,
  };
}
