import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import { supplierCreditCostPreviewSchema } from "@shared/procurement/supplier-credit-cost-review";
import { supplierCreditReviewInputSchema, supplierCreditLineRequiresCostReview, supplierCreditIdSchema, type SupplierCreditDetail } from "@shared/procurement/supplier-credit";
import { readPurchaseApprovalActor, readPurchaseApproverName } from "../identity/infrastructure/purchase-approval-access.repository";
import { hasQuantityAmendmentAuthority } from "./po-quantity-amendment.policy";
import { readPoAmendmentDependencies } from "./po-amendment-dependencies.repository";
import { readInvoiceCorrectionInventoryValues } from "./invoice-correction-cost-values";
import { buildCostDestinationImpact } from "./cost-change-impact";
import { costFingerprint, costInteger } from "../inventory/infrastructure/cost-evidence-values";
import { SupplierCreditError, type CreditTransaction } from "./supplier-credit.repository";
import { readPurchaseCostSources } from "./purchase-cost-source.repository";
import { receiptInvoiceCostRows } from "./domain/receipt-invoice-preview";

type Input = { command: string; creditId?: number; raw: unknown; actorId: string; at: Date; costReviewExecution?: "preview"; commandKey?: string };
async function readReceiptCosts(tx: CreditTransaction, lineIds: number[]) {
  return [...(await readPurchaseCostSources(tx, lineIds)).values()].flatMap(source =>
    source.receiptCosting ? receiptInvoiceCostRows(source, source.receiptCosting.receipts) : [])
    .sort((a, b) => a.receivingLineId - b.receivingLineId);
}
/** Run after the shared graph lock, before IAM/document work. Old credits retain
 * their original command contract. New receipt attribution needs measured review. */
export async function captureSupplierCreditCostReview(tx: CreditTransaction, input: Input) {
  if (!["approve", "void", "reconcile_costs"].includes(input.command) || input.creditId === undefined) return null;
  supplierCreditIdSchema.parse(input.creditId);
  const rows = (await tx.execute(sql`SELECT line.*,invoice.purchase_order_line_id,charge.inbound_shipment_id FROM procurement.supplier_credit_lines line
    JOIN procurement.vendor_invoice_lines invoice ON invoice.id=line.invoice_line_id
    LEFT JOIN procurement.inbound_freight_costs charge ON charge.id=invoice.freight_cost_id WHERE line.supplier_credit_id=${input.creditId} ORDER BY line.id`)).rows;
  if (!rows.some(row => supplierCreditLineRequiresCostReview({ disposition: row.disposition, sourceEvidence: row.source_evidence }))) return null;
  const request = supplierCreditReviewInputSchema.parse(input.raw);
  if (input.costReviewExecution !== "preview" && (!request.previewVersion || !input.commandKey))
    throw new SupplierCreditError("SUPPLIER_CREDIT_COST_PREVIEW_REQUIRED", "Review this receipt's cost changes before approving them.");
  const shipmentIds = [...new Set(rows.filter(row => row.inbound_shipment_id != null).map(row => costInteger(row.inbound_shipment_id, "shipment", 1)))];
  const shipmentLines = shipmentIds.length ? (await tx.execute(sql`SELECT DISTINCT purchase_order_line_id FROM procurement.inbound_shipment_lines
    WHERE inbound_shipment_id=ANY(${sql.param(shipmentIds)}::int[]) AND purchase_order_line_id IS NOT NULL ORDER BY purchase_order_line_id LIMIT 501`)).rows : [];
  if (shipmentLines.length > 500) throw new SupplierCreditError("SUPPLIER_CREDIT_SCOPE_LIMIT", "The complete credit cost review exceeds 500 purchase lines.");
  const lineIds = [...new Set([...rows.filter(row => row.purchase_order_line_id != null), ...shipmentLines].map(row => costInteger(row.purchase_order_line_id, "purchaseOrderLineId", 1)))];
  if (!lineIds.length) throw new SupplierCreditError("SUPPLIER_CREDIT_RECEIPT_SOURCE_MISSING", "Restore the credit's original purchase and receipt relationship before changing costs.");
  const dependencies = await readPoAmendmentDependencies(tx, lineIds, { shipmentIds });
  const values = await readInvoiceCorrectionInventoryValues(tx, dependencies);
  const receipts = await readReceiptCosts(tx, lineIds);
  const authority = await readPurchaseApprovalActor(tx, input.actorId);
  if (!hasQuantityAmendmentAuthority(authority))
    throw new SupplierCreditError("SUPPLIER_CREDIT_COST_ADMIN_REQUIRED", "An Administrator with purchasing approval permission must approve receipt cost changes.", 403);
  return { request, rows, lineIds, shipmentIds, dependencies, values, receipts, authority };
}
export async function finishSupplierCreditCostReview(tx: CreditTransaction, input: Input,
  before: NonNullable<Awaited<ReturnType<typeof captureSupplierCreditCostReview>>>, credit: SupplierCreditDetail) {
  const after = await readPoAmendmentDependencies(tx, before.lineIds, { shipmentIds: before.shipmentIds });
  const impact = buildCostDestinationImpact(before.dependencies, after);
  const afterValues = new Map((await readInvoiceCorrectionInventoryValues(tx, after)).map(row => [row.lotId, row]));
  const inventoryValues = before.values.map(row => {
    const next = afterValues.get(row.lotId);
    if (!next || row.onHandUnits !== next.onHandUnits) throw new Error("Supplier credit changed physical inventory quantities");
    return { lotId: row.lotId, lotNumber: row.lotNumber, onHandUnits: row.onHandUnits,
      beforeMills: row.onHandValueMills, afterMills: next.onHandValueMills, reviewReason: next.valueReviewReason };
  });
  const issues = credit.lines.flatMap(row => row.costIssues.map(issue => issue.message));
  const afterReceipts = new Map((await readReceiptCosts(tx, before.lineIds)).map(row => [row.receivingLineId, row]));
  const receipts = before.receipts.map(row => {
    const next = afterReceipts.get(row.receivingLineId);
    if (!next || next.pieces !== row.pieces) throw new Error("Supplier credit changed received quantities");
    return { receivingLineId: row.receivingLineId, receiptNumber: row.receiptNumber, pieces: row.pieces,
      beforeMills: row.supplierMills, afterMills: next.supplierMills };
  });
  const preview = supplierCreditCostPreviewSchema.parse({ creditId: credit.id, action: input.command, impact, inventoryValues, issues, receipts,
    previewVersion: costFingerprint({ contract: 1, creditId: credit.id, command: input.command, expectedVersion: before.request.expectedVersion,
      reason: before.request.reason, rows: before.rows, authority: before.authority, dependencies: before.dependencies, impact, inventoryValues, issues, receipts }) });
  if (before.request.previewVersion !== undefined && before.request.previewVersion !== preview.previewVersion)
    throw new SupplierCreditError("SUPPLIER_CREDIT_COST_PREVIEW_STALE", "Stock, invoice or credit costs changed. Review the current cost changes again.");
  if (input.costReviewExecution !== "preview") {
    const payload = { creditId: credit.id, actorName: await readPurchaseApproverName(tx, input.actorId),
      approvedAt: input.at.toISOString(), reason: before.request.reason, commandKey: input.commandKey, preview };
    const retained = await tx.execute(sql`INSERT INTO procurement.po_events(po_id,event_type,actor_type,actor_id,payload_json,created_at)
      SELECT DISTINCT purchase_order_id,'supplier_credit_costs_approved','user',${input.actorId},${canonicalJson(payload)}::jsonb,${input.at}::timestamp
      FROM procurement.purchase_order_lines WHERE id=ANY(${sql.param(before.lineIds)}::int[]) RETURNING id`);
    if (!retained.rows.length) throw new Error("Receipt credit approval history was not retained");
  }
  return preview;
}
