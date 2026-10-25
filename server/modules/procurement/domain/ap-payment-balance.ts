import { createHash } from "node:crypto";
import { paymentBalanceSchema, type PaymentBalance } from "@shared/procurement/ap-payment-contract";

export type PaymentBalanceHeader = { id: number; vendorId: number; currency: string; status: string; totalAmountCents: unknown };
export type PaymentAllocationEvidence = { id: number; apPaymentId: number; vendorInvoiceId: number; appliedAmountCents: unknown; invoiceVendorId: number | null; invoiceCurrency: string | null; invoiceStatus: string | null };
function positiveMoney(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const amount = BigInt(value);
    return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? amount : null;
  }
  return null;
}
/** Every allocation is independent evidence, including repeated applications to the same invoice. */
export function projectPaymentBalance(payment: PaymentBalanceHeader, allocations: readonly PaymentAllocationEvidence[]): PaymentBalance {
  const ordered = [...allocations].sort((a, b) => a.id - b.id);
  const version = createHash("sha256").update(JSON.stringify({ payment: { id: payment.id, vendorId: payment.vendorId, currency: payment.currency, status: payment.status, totalAmountCents: payment.totalAmountCents }, allocations: ordered }, (_key, value) => typeof value === "bigint" ? value.toString() : value)).digest("hex");
  const review = (code: string, message: string): PaymentBalance => paymentBalanceSchema.parse({ state: "review_required", appliedAmountCents: null, unappliedAmountCents: null, version, issue: { code, message } });
  const total = positiveMoney(payment.totalAmountCents);
  if (![payment.id, payment.vendorId].every(value => Number.isSafeInteger(value) && value > 0) || !total || payment.currency !== "USD" || !["completed", "voided"].includes(payment.status)) return review("AP_PAYMENT_EVIDENCE_INVALID", "Review this payment's amount, currency and status before applying funds.");
  const seen = new Set<number>();
  let applied = BigInt(0);
  for (const allocation of ordered) {
    const amount = positiveMoney(allocation.appliedAmountCents);
    if (!Number.isSafeInteger(allocation.id) || allocation.id <= 0 || seen.has(allocation.id) || allocation.apPaymentId !== payment.id || !Number.isSafeInteger(allocation.vendorInvoiceId) || allocation.vendorInvoiceId <= 0 || !amount
      || allocation.invoiceVendorId !== payment.vendorId || allocation.invoiceCurrency !== payment.currency || !allocation.invoiceStatus
      || (payment.status === "completed" && !["approved", "partially_paid", "paid", "disputed"].includes(allocation.invoiceStatus)))
      return review("AP_PAYMENT_ALLOCATION_REVIEW_REQUIRED", "Recorded payment applications contain missing or incompatible invoice evidence. Review them before applying more funds.");
    seen.add(allocation.id);
    applied += amount;
  }
  if (applied > total) return review("AP_PAYMENT_OVERALLOCATED", "Recorded applications exceed this payment. Review its history before changing the balance.");
  if (payment.status === "voided") return paymentBalanceSchema.parse({ state: "voided", appliedAmountCents: 0, unappliedAmountCents: 0, version, issue: null });
  return paymentBalanceSchema.parse({ state: applied < total ? "available" : "fully_applied", appliedAmountCents: Number(applied), unappliedAmountCents: Number(total - applied), version, issue: null });
}
