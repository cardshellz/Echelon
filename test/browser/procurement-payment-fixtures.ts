import { paymentListItem } from "./procurement-ap-work-list-fixtures";
export function balance(applied = 0, total = 10000, version = "a".repeat(64)) {
  return { state: applied < total ? "available" : "fully_applied", appliedAmountCents: applied, unappliedAmountCents: total-applied, version, issue: null };
}
export function paymentFixture(overrides: Record<string, unknown> = {}) {
  return { ...paymentListItem({ id: 90, paymentNumber: "PAY-90", vendorId: 2, paymentCalendarDate: "2026-10-19", paymentDateSource: "recorded_calendar_date", paymentBalance: balance(), ...overrides }), bankAccountLabel: null, notes: null, allocations: [] };
}
export function recordedPaymentReply(body: any, key: string, actorId = "ap-reader", id = 90) {
  const applied = (body.allocations ?? []).reduce((sum: number,row: any) => sum+row.appliedAmountCents,0);
  return { ...paymentFixture(), ...body, command: "record_payment", paymentId: id, id, actorId, idempotencyKey: key, status: "completed", currency: "USD",
    paymentDate: `${body.paymentDate}T00:00:00.000Z`, paymentCalendarDate: body.paymentDate, paymentDateSource: "recorded_calendar_date",
    referenceNumber: body.referenceNumber ?? null, checkNumber: body.checkNumber ?? null, bankAccountLabel: body.bankAccountLabel ?? null, notes: body.notes ?? null,
    applications: (body.allocations ?? []).map((row: any,index: number) => ({...row,allocationId:index+1})), paymentBalance: balance(applied,body.totalAmountCents) };
}
export function appliedPaymentReply(body: any, key: string, applied: number, actorId = "ap-reader") {
  return { command: "apply_payment", paymentId: 90, actorId, idempotencyKey: key,
    applications: body.allocations.map((row: any,index: number) => ({...row,allocationId:applied+index+1})), paymentBalance: balance(applied,10000,"b".repeat(64)),
    apLedgerOutcome: { command: "apply_payment", entityType: "payment", entityId: 90, affectedInvoiceIds: body.allocations.map((row: any)=>row.vendorInvoiceId), affectedPaymentIds:[90],affectedPurchaseOrderIds:[],message:"Applied existing payment." } };
}
