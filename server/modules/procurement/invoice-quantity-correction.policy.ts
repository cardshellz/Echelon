import { deriveInvoiceFinancialState } from "./domain/invoice-financial-state";
import { classifyApPaymentState } from "./domain/ap-payment-state";
import { centsToMills, millsToCents } from "@shared/utils/money";
import { z } from "zod";
import { invoiceQuantityContextSchema, invoiceQuantityPreviewSchema, invoiceQuantityIdSchema, invoiceAmountPerPiece, type InvoiceQuantityPreviewRequest } from "@shared/procurement/invoice-quantity-correction";
import type { PurchaseApprovalActor } from "../identity/domain/purchase-approval-authority";
import { hasQuantityAmendmentAuthority, type AmendmentFacts } from "./po-quantity-amendment.policy";
import { evaluatePurchaseOrderInvoiceMatches } from "./purchase-order-invoice-match";
import { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";

export class InvoiceQuantityCorrectionError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 409) { super(message); this.name = "InvoiceQuantityCorrectionError"; }
}
export type InvoiceCorrectionFacts = AmendmentFacts & { billing?: {
  invoiceId: number; purchaseOrderIds: number[]; purchaseAllocations: { purchaseOrderId: number; amountCents: number | null }[]; allInvoiceLines: AmendmentFacts["invoiceLines"];
  allocations: { invoiceId: number; amountCents: number; paymentStatus: string; currency: string | null }[];
} };
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
function blockedReason(facts: AmendmentFacts, lineId: number, allowClosedBilling = false): string | null {
  const { invoice, poLine } = sourceLine(facts, lineId);
  if (invoice.status === "voided") return "A voided invoice cannot be corrected.";
  if (poLine.lineType !== "product") return "Quantity correction is available for product lines.";
  if (facts.header.cancelledAt || ["cancelled", "short_closed"].includes(facts.header.status)
    || ["cancelled", "short_closed"].includes(facts.header.physicalStatus)) return "A cancelled or short-closed purchase requires its owning correction workflow.";
  if (!allowClosedBilling && isClosedPurchaseOrder(facts)) return "Reopen the PO or explicitly approve a billing correction on this closed purchase.";
  if (["cancelled", "closed", "short_closed"].includes(poLine.status) || (poLine.cancelledQty ?? 0) !== 0 || (poLine.returnedQty ?? 0) !== 0) return "This line has a closure, cancellation or return. Review that record before changing invoice quantity.";
  return null;
}
function invoiceMatches(facts: AmendmentFacts, invoiceLines: AmendmentFacts["invoiceLines"]) {
  try { return evaluatePurchaseOrderInvoiceMatches({ purchaseOrderLines: facts.lines, invoiceLines }); }
  catch { throw new InvoiceQuantityCorrectionError("Recorded PO or invoice quantities and prices are invalid. Review the source records before correcting this line.", "INVOICE_QUANTITY_SOURCE_INVALID"); }
}
function isClosedPurchaseOrder(facts: AmendmentFacts): boolean {
  return !!facts.header.closedAt || facts.header.status === "closed" || facts.header.physicalStatus === "closed";
}
export function reviewedInvoiceAmount(facts: InvoiceCorrectionFacts, lineId: number, afterLineAmount: number): number {
  const { line, invoice } = sourceLine(facts, lineId), billing = facts.billing;
  if (!billing || billing.invoiceId !== invoice.id) throw new InvoiceQuantityCorrectionError("Complete invoice and payment evidence is required before changing the bill.", "INVOICE_CORRECTION_BILLING_REQUIRED");
  if (afterLineAmount !== line.lineTotalCents && (billing.purchaseOrderIds.length !== 1 || billing.purchaseOrderIds[0] !== facts.header.id)) {
    throw new InvoiceQuantityCorrectionError("This bill covers multiple POs. Review its allocations through the invoice workflow before changing billed amounts.", "INVOICE_CORRECTION_ALLOCATION_REVIEW_REQUIRED");
  }
  const allocation = billing.purchaseAllocations.find(row => row.purchaseOrderId === facts.header.id);
  if (afterLineAmount !== line.lineTotalCents && (!allocation || (allocation.amountCents !== null && allocation.amountCents !== invoice.invoicedAmountCents))) {
    throw new InvoiceQuantityCorrectionError("This bill has a partial PO allocation. Review its allocation before changing billed amounts.", "INVOICE_CORRECTION_ALLOCATION_REVIEW_REQUIRED");
  }
  let lineSum = BigInt(0), paidSum = BigInt(0);
  for (const row of billing.allInvoiceLines) {
    if (row.vendorInvoiceId !== invoice.id) throw new InvoiceQuantityCorrectionError("Invoice line scope is invalid.", "INVOICE_QUANTITY_SOURCE_INVALID");
    // Other recorded lines can be credits. The AP owner sums signed line amounts;
    // validate that same net total without changing the credit evidence.
    const amount = z.number().int().safe().safeParse(row.lineTotalCents);
    if (!amount.success) throw new InvoiceQuantityCorrectionError("Recorded invoice line amount is invalid.", "INVOICE_QUANTITY_SOURCE_INVALID");
    lineSum += BigInt(amount.data);
  }
  for (const allocation of billing.allocations) {
    if (allocation.invoiceId !== invoice.id || allocation.currency !== invoice.currency) throw new InvoiceQuantityCorrectionError("Payment scope or currency is invalid.", "INVOICE_QUANTITY_SOURCE_INVALID");
    const paymentState = classifyApPaymentState(allocation.paymentStatus);
    if (paymentState === "review_required") throw new InvoiceQuantityCorrectionError("A payment has an unsupported historical status. Review its evidence before correcting the bill.", "AP_PAYMENT_STATUS_REVIEW_REQUIRED");
    if (paymentState === "settled") paidSum += BigInt(recorded(allocation.amountCents, "payment allocation"));
  }
  if (!billing.allInvoiceLines.some(row => row.id === lineId) || lineSum !== BigInt(recorded(invoice.invoicedAmountCents, "invoice total"))
    || paidSum !== BigInt(recorded(invoice.paidAmountCents, "paid amount"))) throw new InvoiceQuantityCorrectionError("Invoice totals or payment allocations do not reconcile. Review those records before changing the bill.", "INVOICE_QUANTITY_SOURCE_INVALID");
  const currentFinancials = deriveInvoiceFinancialState({ status: invoice.status, invoiceAmountCents: invoice.invoicedAmountCents, paidAmountCents: invoice.paidAmountCents });
  if (currentFinancials.balanceCents !== recorded(invoice.balanceCents, "invoice balance")) throw new InvoiceQuantityCorrectionError("The recorded invoice balance does not reconcile.", "INVOICE_QUANTITY_SOURCE_INVALID");
  const total = lineSum - BigInt(recorded(line.lineTotalCents, "invoice line amount")) + BigInt(afterLineAmount);
  if (total < paidSum) throw new InvoiceQuantityCorrectionError("This correction would put recorded payments above the invoice amount. Review payment or credit records through their owning workflow first.", "INVOICE_CORRECTION_PAYMENT_REVIEW_REQUIRED");
  if (total < BigInt(0) || total > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvoiceQuantityCorrectionError("The corrected invoice amount is outside the supported range.", "INVOICE_CORRECTION_AMOUNT_INVALID", 400);
  return Number(total);
}
export function previewInvoiceQuantity(facts: InvoiceCorrectionFacts, lineId: number, request: InvoiceQuantityPreviewRequest) {
  const { line, invoice, poLine } = sourceLine(facts, lineId);
  const beforeQuantity = invoiceQuantityIdSchema.parse(line.qtyInvoiced);
  const afterQuantity = invoiceQuantityIdSchema.parse(request.quantityPieces);
  const otherQuantity = facts.invoiceLines.filter((row) => row.id !== line.id && row.purchaseOrderLineId === poLine.id)
    .reduce((sum, row) => sum + BigInt(recorded(row.qtyInvoiced, "other invoice quantity")), BigInt(0));
  if (otherQuantity > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvoiceQuantityCorrectionError("Other invoice quantities exceed the supported range.", "INVOICE_QUANTITY_SOURCE_INVALID");
  const amount = recorded(line.lineTotalCents, "invoice line amount");
  const currentUnitCost = line.unitCostMills === null ? centsToMills(recorded(line.unitCostCents, "unit price")) : recorded(line.unitCostMills, "unit price");
  const afterAmount = request.lineTotalCents ?? amount;
  const afterUnitCost = request.unitCostMills ?? currentUnitCost;
  const explicitEconomics = request.lineTotalCents !== undefined;
  const invoiceAmount = explicitEconomics ? reviewedInvoiceAmount(facts, lineId, afterAmount) : recorded(invoice.invoicedAmountCents, "invoice amount");
  const moneyChanged = amount !== afterAmount || currentUnitCost !== afterUnitCost;
  const beforeAllocation = facts.billing?.purchaseAllocations.find(row => row.purchaseOrderId === facts.header.id)?.amountCents ?? null;
  // A sole link assigning the entire bill follows its corrected whole amount.
  // Partial allocations require the allocation owner; an unspecified link stays unspecified.
  const afterAllocation = explicitEconomics && beforeAllocation === invoice.invoicedAmountCents ? invoiceAmount : beforeAllocation;
  const afterFinancials = moneyChanged ? deriveInvoiceFinancialState({ status: invoice.status, invoiceAmountCents: invoiceAmount, paidAmountCents: recorded(invoice.paidAmountCents, "paid amount") })
    : { status: invoice.status, balanceCents: recorded(invoice.balanceCents, "invoice balance") };
  const beforeMatches = invoiceMatches(facts, facts.invoiceLines);
  const afterLines = facts.invoiceLines.map(row => row.id === line.id ? { ...row, qtyInvoiced: afterQuantity, unitCostMills: afterUnitCost, unitCostCents: millsToCents(afterUnitCost), lineTotalCents: afterAmount, ...(moneyChanged ? { costComponentEvidence: null } : {}) } : row);
  const afterMatches = invoiceMatches(facts, afterLines);
  const warnings: string[] = [];
  const mappedInvoiceIds = new Set(afterLines.map((row) => row.vendorInvoiceId));
  const unmappedInvoiceCount = facts.invoices.filter((row) => row.status !== "voided" && !mappedInvoiceIds.has(row.id)).length;
  if (unmappedInvoiceCount > 0) warnings.push(`${unmappedInvoiceCount} invoice(s) linked to this PO have no mapped lines and still need review.`);
  const afterMatch = afterMatches.find((row) => row.id === line.id)!.matchStatus;
  if (afterMatch !== "matched") warnings.push("This quantity will not clear every match issue on this line. Review the proposed match result before confirming.");
  if (moneyChanged) warnings.push("The billed amount or unit price changes. Any recorded cost breakdown must be reviewed again; inventory costs are not changed by this correction.");
  if (!invoiceCostComponentEvidenceSchema.safeParse(line.costComponentEvidence).success) warnings.push("The product and packaging amounts have not been recorded. This correction does not guess their split or change inventory costs.");
  return invoiceQuantityPreviewSchema.parse({
    invoiceId: invoice.id, invoiceLineId: line.id, purchaseOrderId: facts.header.id, sourceVersion: request.sourceVersion,
    beforeQuantity, afterQuantity, orderedQuantity: recorded(poLine.orderQty, "PO quantity"), receivedQuantity: recorded(poLine.receivedQty ?? 0, "received quantity"),
    otherInvoicedQuantity: Number(otherQuantity), invoiceLineAmountCents: amount,
    invoiceAmountCents: recorded(invoice.invoicedAmountCents, "invoice amount"), paidAmountCents: recorded(invoice.paidAmountCents, "paid amount"), balanceCents: recorded(invoice.balanceCents, "balance"),
    recordedUnitCostMills: line.unitCostMills === null ? Number(BigInt(recorded(line.unitCostCents, "unit price")) * BigInt(100)) : recorded(line.unitCostMills, "unit price"),
    beforeAmountPerPiece: invoiceAmountPerPiece(amount, beforeQuantity), afterAmountPerPiece: invoiceAmountPerPiece(afterAmount, afterQuantity),
    afterLineAmountCents: afterAmount, afterInvoiceAmountCents: invoiceAmount, afterBalanceCents: afterFinancials.balanceCents,
    beforeAllocatedToPoCents: beforeAllocation, afterAllocatedToPoCents: afterAllocation,
    afterUnitCostMills: afterUnitCost, beforeInvoiceStatus: invoice.status, afterInvoiceStatus: afterFinancials.status, closedPurchaseOrder: isClosedPurchaseOrder(facts),
    beforeMatch: beforeMatches.find((row) => row.id === line.id)!.matchStatus, afterMatch,
    remainingIssues: afterMatches.filter((row) => row.matchStatus !== "matched").map((row) => ({ invoiceId: row.vendorInvoiceId, lineId: row.id, status: row.matchStatus })), warnings,
  });
}
export function invoiceQuantityContext(facts: InvoiceCorrectionFacts, lineId: number, actor: PurchaseApprovalActor, sourceVersion: string) {
  const { line, invoice } = sourceLine(facts, lineId);
  const current = previewInvoiceQuantity(facts, lineId, { sourceVersion, quantityPieces: line.qtyInvoiced });
  const remaining = BigInt(current.orderedQuantity) - BigInt(current.otherInvoicedQuantity);
  const agreed = current.orderedQuantity > 0 && current.orderedQuantity === current.receivedQuantity;
  const suggestedQuantity = agreed && remaining > BigInt(0) && remaining <= BigInt(2147483647) ? Number(remaining) : null;
  const blocked = blockedReason(facts, lineId, true);
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
    poUnitCostMills: sourceLine(facts, lineId).poLine.unitCostMills ?? centsToMills(sourceLine(facts, lineId).poLine.unitCostCents),
    poLineAmountCents: sourceLine(facts, lineId).poLine.lineTotalCents,
    closedPurchaseOrder: isClosedPurchaseOrder(facts),
    current, suggested: suggestedQuantity === null ? null : previewInvoiceQuantity(facts, lineId, { sourceVersion, quantityPieces: suggestedQuantity }),
  });
}
export function planInvoiceQuantityCorrection(facts: InvoiceCorrectionFacts, lineId: number, request: InvoiceQuantityPreviewRequest) {
  const allowClosedBilling = request.lineTotalCents !== undefined && request.closedPurchaseOrderConfirmed === true;
  const blocked = blockedReason(facts, lineId, allowClosedBilling);
  if (blocked) throw new InvoiceQuantityCorrectionError(blocked, "INVOICE_QUANTITY_BLOCKED");
  const preview = previewInvoiceQuantity(facts, lineId, request);
  if (preview.beforeQuantity === preview.afterQuantity && preview.invoiceLineAmountCents === preview.afterLineAmountCents && preview.recordedUnitCostMills === preview.afterUnitCostMills) throw new InvoiceQuantityCorrectionError("Enter a quantity, unit price or line amount different from the current invoice.", "INVOICE_QUANTITY_NO_CHANGE", 400);
  return preview;
}
