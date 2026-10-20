import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const cents = z.number().int().nonnegative().safe();
/** A supplier payment day is a calendar date, never a browser-local instant. */
export const paymentCalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  if (value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Enter a valid payment calendar date.");
export const paymentDateSourceSchema = z.enum(["recorded_calendar_date", "legacy_timestamp"]);
export function paymentCalendarDateToUtc(value: string): Date {
  return new Date(`${paymentCalendarDateSchema.parse(value)}T00:00:00.000Z`);
}
export function formatPaymentCalendarDate(payment: { paymentCalendarDate?: string | null; paymentDateSource?: string }): string {
  if (payment.paymentDateSource !== "recorded_calendar_date" || !paymentCalendarDateSchema.safeParse(payment.paymentCalendarDate).success) return "Date not verified";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(paymentCalendarDateToUtc(payment.paymentCalendarDate!));
}
export const paymentBalanceSchema = z.object({
  state: z.enum(["available", "fully_applied", "voided", "review_required"]),
  appliedAmountCents: cents.nullable(), unappliedAmountCents: cents.nullable(),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  issue: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().nullable(),
}).strict().superRefine((value, context) => {
  const invalid = value.state === "review_required"
    ? value.appliedAmountCents !== null || value.unappliedAmountCents !== null || value.issue === null
    : value.appliedAmountCents === null || value.unappliedAmountCents === null || value.issue !== null
      || (value.state === "available" ? value.unappliedAmountCents <= 0 : value.unappliedAmountCents !== 0);
  if (invalid) context.addIssue({ code: z.ZodIssueCode.custom, message: "Inconsistent payment balance evidence." });
});
export type PaymentBalance = z.infer<typeof paymentBalanceSchema>;
export const paymentApplicationInputSchema = z.object({
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  allocations: z.array(z.object({ vendorInvoiceId: id, appliedAmountCents: cents.positive() }).strict()).min(1).max(100),
  reason: z.string().trim().min(1).max(2000),
}).strict().superRefine((value, context) => {
  if (new Set(value.allocations.map(row => row.vendorInvoiceId)).size !== value.allocations.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allocations"], message: "Choose each invoice once per application." });
  if (value.allocations.every(row => Number.isSafeInteger(row.appliedAmountCents)) && value.allocations.reduce((sum, row) => sum + BigInt(row.appliedAmountCents), BigInt(0)) > BigInt(Number.MAX_SAFE_INTEGER))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allocations"], message: "Application total is too large." });
});
export type PaymentApplicationInput = z.infer<typeof paymentApplicationInputSchema>;
export const paymentApplicationResultSchema = z.object({
  command: z.literal("apply_payment"), paymentId: id, actorId: z.string().min(1), idempotencyKey: z.string().min(1),
  applications: z.array(z.object({ allocationId: id, vendorInvoiceId: id, appliedAmountCents: cents.positive() }).strict()).min(1).max(100),
  paymentBalance: paymentBalanceSchema,
  apLedgerOutcome: z.object({ command: z.literal("apply_payment"), entityType: z.literal("payment"), entityId: id,
    affectedInvoiceIds: z.array(id), affectedPaymentIds: z.array(id), affectedPurchaseOrderIds: z.array(id), message: z.string() }).strict(),
}).strict();
export type PaymentApplicationResult = z.infer<typeof paymentApplicationResultSchema>;

const applicationRowSchema = z.object({ allocationId: id, vendorInvoiceId: id, appliedAmountCents: cents.positive() }).strict();
export const recordPaymentResultSchema = z.object({
  command: z.literal("record_payment"), paymentId: id, id, actorId: z.string().min(1), idempotencyKey: z.string().min(1),
  vendorId: id, totalAmountCents: cents.positive(), currency: z.literal("USD"), status: z.literal("completed"),
  paymentDate: z.string().datetime(), paymentCalendarDate: paymentCalendarDateSchema.nullable(), paymentDateSource: paymentDateSourceSchema,
  paymentMethod: z.string().min(1), referenceNumber: z.string().nullable(), checkNumber: z.string().nullable(), bankAccountLabel: z.string().nullable(), notes: z.string().nullable(),
  applications: z.array(applicationRowSchema), paymentBalance: paymentBalanceSchema,
}).passthrough();
export const voidPaymentResultSchema = z.object({ command: z.literal("void_payment"), paymentId: id, actorId: z.string().min(1), idempotencyKey: z.string().min(1), ok: z.literal(true), status: z.literal("voided") }).passthrough();
export type RecordPaymentResult = z.infer<typeof recordPaymentResultSchema>;
export type VoidPaymentResult = z.infer<typeof voidPaymentResultSchema>;
