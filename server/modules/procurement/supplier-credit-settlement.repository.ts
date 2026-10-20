import { projectInvoiceSettlement } from "@shared/procurement/invoice-settlement";
import { apPaymentAllocations, apPayments } from "@shared/schema";
import { readPaymentBalances } from "./ap-payment-balance.repository";
import { classifyApPaymentState } from "./domain/ap-payment-state";
import { deriveInvoiceFinancialState } from "./domain/invoice-financial-state";
import { eq, sql } from "drizzle-orm";
import { costInteger } from "../inventory/infrastructure/cost-evidence-values";
import { sumInvoiceCredits, type InvoiceCreditEvidence } from "./domain/invoice-credit-evidence";
import type { ApLedgerDbClient } from "./ap-ledger.service";
export class SupplierCreditEvidenceError extends Error {
  readonly statusCode = 409;
  readonly details: {
    code: string;
    invoiceId: number;
  };
  constructor(invoiceId: number, code = "AP_CREDIT_EVIDENCE_REVIEW") {
    super(code === "AP_PAYMENT_STATUS_REVIEW_REQUIRED"
      ? "This invoice has a payment with an unsupported historical status. Review the payment evidence before changing its balance."
      : code === "AP_INVOICE_CREDIT_HISTORY"
        ? "Supplier credit history must be preserved before this invoice can change."
        : "Invoice settlement evidence needs review before this invoice can change.");
    this.name = "SupplierCreditEvidenceError";
    this.details = {
      code,
      invoiceId
    };
  }
}
export async function readInvoiceCreditEvidence(tx: Pick<ApLedgerDbClient, "execute">, invoiceIds: readonly number[]): Promise<Map<number, InvoiceCreditEvidence[]>> {
  const result = new Map<number, InvoiceCreditEvidence[]>();
  if (!invoiceIds.length) return result;
  const ids = sql.join(invoiceIds.map(id => sql`${id}`), sql`, `);
  const rows = await tx.execute(sql`SELECT a.id,a.vendor_invoice_id,a.supplier_credit_id,a.applied_amount_cents,
    c.vendor_id,c.currency,c.status,c.total_amount_cents,r.id AS reversal_id,
    (SELECT coalesce(sum(x.applied_amount_cents),0) FROM procurement.supplier_credit_applications x
      LEFT JOIN procurement.supplier_credit_application_reversals xr ON xr.application_id=x.id
      WHERE x.supplier_credit_id=c.id AND xr.id IS NULL) AS total_applied,
    (c.id IS NOT NULL AND c.total_amount_cents>0
      AND c.total_amount_cents=(SELECT sum(l.amount_cents) FROM procurement.supplier_credit_lines l WHERE l.supplier_credit_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM procurement.supplier_credit_lines l WHERE l.supplier_credit_id=c.id AND (l.amount_cents<=0 OR l.amount_cents>9007199254740991))
      AND NOT EXISTS(SELECT 1 FROM procurement.supplier_credit_applications x LEFT JOIN procurement.vendor_invoices i ON i.id=x.vendor_invoice_id
        WHERE x.supplier_credit_id=c.id AND (x.applied_amount_cents<=0 OR x.applied_amount_cents>9007199254740991 OR i.id IS NULL
          OR i.vendor_id IS DISTINCT FROM c.vendor_id OR i.currency IS DISTINCT FROM c.currency))) AS evidence_valid
    FROM procurement.supplier_credit_applications a
    LEFT JOIN procurement.supplier_credits c ON c.id=a.supplier_credit_id
    LEFT JOIN procurement.supplier_credit_application_reversals r ON r.application_id=a.id
    WHERE a.vendor_invoice_id IN (${ids}) ORDER BY a.id`);
  for (const raw of rows.rows) {
    const invoiceId = costInteger(raw.vendor_invoice_id, "credit.invoiceId", 1);
    const nullable = (value: unknown, field: string) => value == null ? null : costInteger(value, field);
    const evidence: InvoiceCreditEvidence = {
      allocationId: costInteger(raw.id, "credit.applicationId", 1),
      creditId: costInteger(raw.supplier_credit_id, "credit.id", 1),
      creditVendorId: nullable(raw.vendor_id, "credit.vendorId"),
      creditCurrency: raw.currency == null ? null : String(raw.currency),
      creditStatus: raw.status == null ? null : String(raw.status),
      creditTotalAmountCents: nullable(raw.total_amount_cents, "credit.total"),
      creditAppliedAmountCents: nullable(raw.total_applied, "credit.applied"),
      appliedAmountCents: costInteger(raw.applied_amount_cents, "credit.applicationAmount", -Number.MAX_SAFE_INTEGER),
      reversalId: nullable(raw.reversal_id, "credit.reversalId"),
      evidenceValid: raw.evidence_valid === true
    };
    result.set(invoiceId, [...(result.get(invoiceId) ?? []), evidence]);
  }
  return result;
}
export async function readInvoiceCreditAmount(tx: Pick<ApLedgerDbClient, "execute">, invoice: {
  id: number;
  vendorId: number;
  currency: string;
}): Promise<number> {
  const rows = await readInvoiceCreditEvidence(tx, [invoice.id]);
  const total = sumInvoiceCredits(rows.get(invoice.id) ?? [], invoice.vendorId, invoice.currency);
  if (total === null) throw new SupplierCreditEvidenceError(invoice.id);
  return total;
}
export async function hasInvoiceCreditHistory(tx: Pick<ApLedgerDbClient, "execute">, invoiceId: number): Promise<boolean> {
  const found = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM procurement.supplier_credits WHERE source_invoice_id=${invoiceId})
    OR EXISTS(SELECT 1 FROM procurement.supplier_credit_applications WHERE vendor_invoice_id=${invoiceId}) AS present`);
  return found.rows[0]?.present === true;
}
export async function assertInvoiceHasNoCreditHistory(tx: Pick<ApLedgerDbClient, "execute">, invoiceId: number): Promise<void> {
  if (await hasInvoiceCreditHistory(tx, invoiceId)) throw new SupplierCreditEvidenceError(invoiceId, "AP_INVOICE_CREDIT_HISTORY");
}
type InvoiceSettlementEvidence = {
  id: number;
  vendorId: number;
  currency: string;
  status: string;
  invoicedAmountCents: number;
  paidAmountCents: number;
  creditedAmountCents: number;
  balanceCents: number;
};

async function readVerifiedInvoiceCashAmount(tx: ApLedgerDbClient, invoice: Pick<InvoiceSettlementEvidence, "id" | "vendorId" | "currency">): Promise<bigint> {
  const fail = (): never => { throw new SupplierCreditEvidenceError(invoice.id, "AP_INVOICE_PAYMENT_EVIDENCE_REVIEW"); };
  const rows = await tx.select({ payment: apPayments, amount: apPaymentAllocations.appliedAmountCents })
    .from(apPaymentAllocations).leftJoin(apPayments, eq(apPayments.id, apPaymentAllocations.apPaymentId))
    .where(eq(apPaymentAllocations.vendorInvoiceId, invoice.id));
  let cash = BigInt(0);
  for (const row of rows) {
    if (row.payment && classifyApPaymentState(row.payment.status) === "review_required") {
      throw new SupplierCreditEvidenceError(invoice.id, "AP_PAYMENT_STATUS_REVIEW_REQUIRED");
    }
    if (!row.payment
      || row.payment.vendorId !== invoice.vendorId || row.payment.currency !== invoice.currency
      || !Number.isSafeInteger(row.amount) || row.amount <= 0) fail();
    if (row.payment?.status === "completed") cash += BigInt(row.amount);
  }
  const payments = [...new Map(rows.flatMap(row => row.payment ? [[row.payment.id, row.payment] as const] : [])).values()];
  if ([...(await readPaymentBalances(tx, payments)).values()].some(balance => balance.state === "review_required")) fail();
  return cash;
}

/** Validate the cache against immutable cash and noncash evidence before spending.
 * Never silently repair an inconsistent historical cache as part of a new command. */
export async function assertInvoiceSettlementEvidence(tx: ApLedgerDbClient, invoice: InvoiceSettlementEvidence): Promise<void> {
  const fail = (code = "AP_INVOICE_PAYMENT_EVIDENCE_REVIEW"): never => { throw new SupplierCreditEvidenceError(invoice.id, code); };
  if (![invoice.invoicedAmountCents, invoice.paidAmountCents, invoice.balanceCents].every(value => Number.isSafeInteger(value) && value >= 0)) fail();
  if (!Number.isSafeInteger(invoice.creditedAmountCents) || invoice.creditedAmountCents < 0) fail("AP_CREDIT_EVIDENCE_REVIEW");
  const cash = await readVerifiedInvoiceCashAmount(tx, invoice);
  if (cash !== BigInt(invoice.paidAmountCents)) fail();
  const credited = await readInvoiceCreditAmount(tx, invoice);
  if (credited !== invoice.creditedAmountCents) fail("AP_CREDIT_EVIDENCE_REVIEW");
  const settled = cash + BigInt(credited);
  const settlementError = credited > 0 ? "AP_INVOICE_SETTLEMENT_REVIEW" : "AP_INVOICE_PAYMENT_EVIDENCE_REVIEW";
  if (settled > BigInt(invoice.invoicedAmountCents) || BigInt(invoice.balanceCents) !== BigInt(invoice.invoicedAmountCents) - settled) fail(settlementError);
  const state = deriveInvoiceFinancialState({ status: invoice.status, invoiceAmountCents: invoice.invoicedAmountCents,
    paidAmountCents: Number(cash), creditedAmountCents: credited });
  if (state.status !== invoice.status) fail(settlementError);
}
export async function readVerifiedInvoiceSettlementProjections(tx: ApLedgerDbClient, invoices: readonly {
  id: number;
  vendorId: number;
  currency: string;
  status?: string;
  invoicedAmountCents: number;
  paidAmountCents: number;
  creditedAmountCents: number;
  balanceCents: number;
}[]) {
  const evidence = await readInvoiceCreditEvidence(tx, invoices.map(invoice => invoice.id));
  const projections = new Map<number, ReturnType<typeof projectInvoiceSettlement>>();
  for (const invoice of invoices) {
    const credited = sumInvoiceCredits(evidence.get(invoice.id) ?? [], invoice.vendorId, invoice.currency);
    if (credited === null || credited !== invoice.creditedAmountCents) throw new SupplierCreditEvidenceError(invoice.id);
    const projection = projectInvoiceSettlement(invoice);
    // Legacy cash overpayments remain visible, but only retained payment evidence
    // can verify that exception. New commands always use the stricter guard above.
    if (projection.overpaidAmountCents > 0 && await readVerifiedInvoiceCashAmount(tx, invoice) !== BigInt(invoice.paidAmountCents)) {
      throw new SupplierCreditEvidenceError(invoice.id, "AP_INVOICE_PAYMENT_EVIDENCE_REVIEW");
    }
    projections.set(invoice.id, projection);
  }
  return projections;
}
