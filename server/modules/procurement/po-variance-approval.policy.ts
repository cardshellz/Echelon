import { z } from "zod";
import { centsToMills } from "@shared/utils/money";
import { poVarianceContextSchema } from "@shared/procurement/po-variance-approval";
import type { PoException } from "@shared/schema";
import { evaluatePurchaseOrderInvoiceMatches, computePurchaseOrderInvoiceMatchSourceFingerprint } from "./purchase-order-invoice-match";
import { hasQuantityAmendmentAuthority } from "./po-quantity-amendment.policy";
import type { readQuantityAmendmentSource } from "./po-quantity-amendment.repository";
export class PoVarianceApprovalError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 409) { super(message); this.name = "PoVarianceApprovalError"; }
}
export function buildPoVarianceContext(source: Awaited<ReturnType<typeof readQuantityAmendmentSource>>, exception: PoException) {
  const { facts } = source;
  if (exception.kind !== "match_mismatch" || exception.poId !== facts.header.id || !["open", "acknowledged"].includes(exception.status)) {
    throw new PoVarianceApprovalError("This financial exception is no longer awaiting approval. Reload the PO.", "PO_VARIANCE_STATE_INVALID");
  }
  const payload = z.object({ invoiceId: z.number().int().positive(), sourceVersion: z.literal(1), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(exception.payload);
  if (!payload.success) throw new PoVarianceApprovalError("This exception has no current financial evidence. Refresh invoice matching before approving.", "PO_VARIANCE_STALE");
  const fingerprint = computePurchaseOrderInvoiceMatchSourceFingerprint({ purchaseOrderId: facts.header.id,
    purchaseOrderLines: facts.lines, activeInvoices: facts.invoices.filter(row => row.status !== "voided"), invoiceLines: facts.invoiceLines });
  if (fingerprint !== payload.data.sourceFingerprint) throw new PoVarianceApprovalError("The invoice or PO changed. Refresh matching and review the current variance.", "PO_VARIANCE_STALE");
  const invoice = facts.invoices.find(row => row.id === payload.data.invoiceId);
  if (!invoice || invoice.status === "voided") throw new PoVarianceApprovalError("The linked invoice is unavailable.", "PO_VARIANCE_STATE_INVALID");
  const results = evaluatePurchaseOrderInvoiceMatches({ purchaseOrderLines: facts.lines, invoiceLines: facts.invoiceLines });
  const issues = results.filter(row => row.vendorInvoiceId === invoice.id && row.matchStatus !== "matched").map(result => {
    const line = facts.invoiceLines.find(row => row.id === result.id)!;
    const poLine = facts.lines.find(row => row.id === line.purchaseOrderLineId);
    if (!poLine || !["qty_discrepancy", "price_discrepancy", "over_billed"].includes(result.matchStatus)) {
      throw new PoVarianceApprovalError("Map every invoice line to its PO before accepting a financial variance.", "PO_VARIANCE_MAPPING_REQUIRED");
    }
    return { lineId: line.id, lineNumber: line.lineNumber, name: line.productName || line.description || line.sku || `Line ${line.lineNumber}`,
      invoiceQuantity: line.qtyInvoiced, orderedQuantity: poLine.orderQty, receivedQuantity: poLine.receivedQty ?? 0,
      invoiceUnitCostMills: line.unitCostMills ?? centsToMills(line.unitCostCents), poUnitCostMills: poLine.unitCostMills ?? centsToMills(poLine.unitCostCents),
      invoiceLineAmountCents: line.lineTotalCents, status: result.matchStatus };
  });
  if (!issues.length) throw new PoVarianceApprovalError("This invoice has no current variance to accept. Refresh matching.", "PO_VARIANCE_STALE");
  return poVarianceContextSchema.parse({ exceptionId: exception.id, purchaseOrderId: facts.header.id, sourceVersion: source.sourceVersion,
    sourceFingerprint: fingerprint, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, currency: invoice.currency,
    canApprove: hasQuantityAmendmentAuthority(source.actor),
    blockedReason: invoice.currency !== facts.header.currency ? "Review the invoice currency conversion before accepting this variance." : null, issues });
}
