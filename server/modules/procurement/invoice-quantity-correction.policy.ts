import { z } from "zod";
import { invoiceQuantityContextSchema, invoiceQuantityPreviewSchema, invoiceQuantityIdSchema, invoiceAmountPerPiece, type InvoiceQuantityPreviewRequest } from "@shared/procurement/invoice-quantity-correction";
import type { PurchaseApprovalActor } from "../identity/domain/purchase-approval-authority";
import { hasQuantityAmendmentAuthority, type AmendmentFacts } from "./po-quantity-amendment.policy";
import { evaluatePurchaseOrderInvoiceMatches } from "./purchase-order-invoice-match";
import { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";

export class InvoiceQuantityCorrectionError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 409) { super(message); this.name = "InvoiceQuantityCorrectionError"; }
}
const nonnegative = z.number().int().nonnegative().safe();
function recorded(value: unknown, field: string): number {
  const result = nonnegative.safeParse(value);
  if (!result.success) throw new InvoiceQuantityCorrectionError(`Recorded ${field} is invalid. Review the invoice first.`, "INVOICE_QUANTITY_SOURCE_INVALID");
  return result.data;
}
export function assertInvoiceQuantityAuthority(actor: PurchaseApprovalActor): void {
  if (!hasQuantityAmendmentAuthority(actor)) throw new InvoiceQuantityCorrectionError("An Administrator with purchasing approval permission must confirm this correction.", "INVOICE_QUANTITY_ADMIN_REQUIRED", 403);
}
function sourceLine(facts: AmendmentFacts, lineId: number) {
  const line = facts.invoiceLines.find((row) => row.id === lineId);
  const invoice = facts.invoices.find((row) => row.id === line?.vendorInvoiceId);
  const poLine = facts.lines.find((row) => row.id === line?.purchaseOrderLineId);
  if (!line || !invoice || !poLine) throw new InvoiceQuantityCorrectionError("The invoice line is not linked to this purchase order. Reload the invoice.", "INVOICE_QUANTITY_LINK_MISSING");
  return { line, invoice, poLine };
}
function blockedReason(facts: AmendmentFacts, lineId: number): string | null {
  const { invoice, poLine } = sourceLine(facts, lineId);
  if (invoice.status === "voided") return "A voided invoice cannot be corrected.";
  if (poLine.lineType !== "product") return "Quantity correction is available for product lines.";
  if (facts.header.closedAt || facts.header.cancelledAt || ["closed", "cancelled", "short_closed"].includes(facts.header.status)
    || ["closed", "cancelled", "short_closed"].includes(facts.header.physicalStatus)) return "Reopen the PO through its approval workflow before correcting a closed or cancelled purchase.";
  if (["cancelled", "closed", "short_closed"].includes(poLine.status) || (poLine.cancelledQty ?? 0) !== 0 || (poLine.returnedQty ?? 0) !== 0) return "This line has a closure, cancellation or return. Review that record before changing invoice quantity.";
  return null;
}
function invoiceMatches(facts: AmendmentFacts, invoiceLines: AmendmentFacts["invoiceLines"]) {
  try { return evaluatePurchaseOrderInvoiceMatches({ purchaseOrderLines: facts.lines, invoiceLines }); }
  catch { throw new InvoiceQuantityCorrectionError("Recorded PO or invoice quantities and prices are invalid. Review the source records before correcting this line.", "INVOICE_QUANTITY_SOURCE_INVALID"); }
}
export function previewInvoiceQuantity(facts: AmendmentFacts, lineId: number, request: InvoiceQuantityPreviewRequest) {
  const { line, invoice, poLine } = sourceLine(facts, lineId);
  const beforeQuantity = invoiceQuantityIdSchema.parse(line.qtyInvoiced);
  const afterQuantity = invoiceQuantityIdSchema.parse(request.quantityPieces);
  const otherQuantity = facts.invoiceLines.filter((row) => row.id !== line.id && row.purchaseOrderLineId === poLine.id)
    .reduce((sum, row) => sum + BigInt(recorded(row.qtyInvoiced, "other invoice quantity")), BigInt(0));
  if (otherQuantity > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvoiceQuantityCorrectionError("Other invoice quantities exceed the supported range.", "INVOICE_QUANTITY_SOURCE_INVALID");
  const beforeMatches = invoiceMatches(facts, facts.invoiceLines);
  const afterLines = facts.invoiceLines.map((row) => row.id === line.id ? { ...row, qtyInvoiced: afterQuantity } : row);
  const afterMatches = invoiceMatches(facts, afterLines);
  const amount = recorded(line.lineTotalCents, "invoice line amount");
  const warnings: string[] = [];
  const mappedInvoiceIds = new Set(afterLines.map((row) => row.vendorInvoiceId));
  const unmappedInvoiceCount = facts.invoices.filter((row) => row.status !== "voided" && !mappedInvoiceIds.has(row.id)).length;
  if (unmappedInvoiceCount > 0) warnings.push(`${unmappedInvoiceCount} invoice(s) linked to this PO have no mapped lines and still need review.`);
  const afterMatch = afterMatches.find((row) => row.id === line.id)!.matchStatus;
  if (afterMatch !== "matched") warnings.push("This quantity will not clear every match issue on this line. Review the proposed match result before confirming.");
  if (!invoiceCostComponentEvidenceSchema.safeParse(line.costComponentEvidence).success) warnings.push("The product and packaging amounts have not been recorded. This correction does not guess their split or change inventory costs.");
  return invoiceQuantityPreviewSchema.parse({
    invoiceId: invoice.id, invoiceLineId: line.id, purchaseOrderId: facts.header.id, sourceVersion: request.sourceVersion,
    beforeQuantity, afterQuantity, orderedQuantity: recorded(poLine.orderQty, "PO quantity"), receivedQuantity: recorded(poLine.receivedQty ?? 0, "received quantity"),
    otherInvoicedQuantity: Number(otherQuantity), invoiceLineAmountCents: amount,
    invoiceAmountCents: recorded(invoice.invoicedAmountCents, "invoice amount"), paidAmountCents: recorded(invoice.paidAmountCents, "paid amount"), balanceCents: recorded(invoice.balanceCents, "balance"),
    recordedUnitCostMills: line.unitCostMills === null ? Number(BigInt(recorded(line.unitCostCents, "unit price")) * BigInt(100)) : recorded(line.unitCostMills, "unit price"),
    beforeAmountPerPiece: invoiceAmountPerPiece(amount, beforeQuantity), afterAmountPerPiece: invoiceAmountPerPiece(amount, afterQuantity),
    beforeMatch: beforeMatches.find((row) => row.id === line.id)!.matchStatus, afterMatch,
    remainingIssues: afterMatches.filter((row) => row.matchStatus !== "matched").map((row) => ({ invoiceId: row.vendorInvoiceId, lineId: row.id, status: row.matchStatus })), warnings,
  });
}
export function invoiceQuantityContext(facts: AmendmentFacts, lineId: number, actor: PurchaseApprovalActor, sourceVersion: string) {
  const { line, invoice } = sourceLine(facts, lineId);
  const current = previewInvoiceQuantity(facts, lineId, { sourceVersion, quantityPieces: line.qtyInvoiced });
  const remaining = BigInt(current.orderedQuantity) - BigInt(current.otherInvoicedQuantity);
  const agreed = current.orderedQuantity > 0 && current.orderedQuantity === current.receivedQuantity;
  const suggestedQuantity = agreed && remaining > BigInt(0) && remaining <= BigInt(2147483647) ? Number(remaining) : null;
  const blocked = blockedReason(facts, lineId);
  const suggestionReason = current.orderedQuantity === 0 || current.receivedQuantity === 0
    ? "No quantity is suggested without a positive PO and received count. Check the supplier invoice."
    : !agreed ? "The PO and received quantities differ. Check the supplier invoice before choosing a quantity."
    : suggestedQuantity === null ? "Other invoice lines cover or exceed this PO's quantity. Check the supplier invoice before entering another quantity."
    : suggestedQuantity === current.beforeQuantity && current.beforeMatch === "matched" ? "These quantities already match. Refresh invoice matching if an old issue is still displayed."
    : "Suggested from the matching PO and received quantities, after subtracting other invoice lines.";
  return invoiceQuantityContextSchema.parse({
    invoiceId: invoice.id, invoiceLineId: line.id, purchaseOrderId: facts.header.id, lineNumber: line.lineNumber, name: line.productName || line.sku || `Line ${line.lineNumber}`, currency: invoice.currency,
    sourceVersion, canApprove: hasQuantityAmendmentAuthority(actor), blockedReason: blocked,
    suggestedQuantity, suggestionReason,
    current, suggested: suggestedQuantity === null ? null : previewInvoiceQuantity(facts, lineId, { sourceVersion, quantityPieces: suggestedQuantity }),
  });
}
export function planInvoiceQuantityCorrection(facts: AmendmentFacts, lineId: number, request: InvoiceQuantityPreviewRequest) {
  const blocked = blockedReason(facts, lineId);
  if (blocked) throw new InvoiceQuantityCorrectionError(blocked, "INVOICE_QUANTITY_BLOCKED");
  const preview = previewInvoiceQuantity(facts, lineId, request);
  if (preview.beforeQuantity === preview.afterQuantity) throw new InvoiceQuantityCorrectionError("Enter a quantity different from the current invoice quantity.", "INVOICE_QUANTITY_NO_CHANGE", 400);
  return preview;
}
