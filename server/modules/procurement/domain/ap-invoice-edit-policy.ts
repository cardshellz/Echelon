import type { ApInvoiceEditCapability } from "@shared/procurement/ap-invoice-capabilities";

export interface InvoiceEditFacts {
  status: string;
  approvedAt: Date | null;
  approvedBy: string | null;
  paidAmountCents: number;
  hasPaymentHistory: boolean;
}

/** Generic edits are for unrecognized bills. Reviewed corrections have their own owner. */
export function invoiceEditCapability(facts: InvoiceEditFacts): ApInvoiceEditCapability {
  const result = (code: ApInvoiceEditCapability["code"], reason: string): ApInvoiceEditCapability => ({
    allowed: code === "AP_INVOICE_EDITABLE", requiredPermission: "purchasing:edit", code, reason,
  });
  if (!["received", "disputed"].includes(facts.status)) {
    return result("AP_INVOICE_IMMUTABLE", "Only unapproved received or disputed invoices without payment history can be edited.");
  }
  if (!Number.isSafeInteger(facts.paidAmountCents) || facts.paidAmountCents < 0
    || facts.approvedAt === undefined || facts.approvedBy === undefined || typeof facts.hasPaymentHistory !== "boolean") {
    return result("AP_INVOICE_SOURCE_REVIEW_REQUIRED", "Invoice history is incomplete or invalid. Review the recorded evidence before editing.");
  }
  if (facts.approvedAt !== null || facts.approvedBy !== null || facts.paidAmountCents > 0 || facts.hasPaymentHistory) {
    return result("AP_INVOICE_FINANCIAL_HISTORY", "This invoice has approval or payment history. Generic edits are locked; use the reviewed quantity correction for supported line corrections.");
  }
  return result("AP_INVOICE_EDITABLE", "This invoice has no approval or payment history and can be edited.");
}
