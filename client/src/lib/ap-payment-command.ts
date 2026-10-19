import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { paymentCalendarDateSchema, paymentApplicationInputSchema, paymentApplicationResultSchema, recordPaymentResultSchema, voidPaymentResultSchema } from "@shared/procurement/ap-payment-contract";
import { createPersistentFinancialIntentStore } from "./persistent-financial-intent";
import { financialCommandFetchJson, FinancialCommandRequestError } from "./financial-command";

const id = z.number().int().positive().max(2_147_483_647);
const cents = z.number().int().nonnegative().safe();
const allocation = z.object({ vendorInvoiceId: id, appliedAmountCents: cents.positive() }).strict();
const optionalText = z.string().max(2000).optional();
export const recordPaymentInputSchema = z.object({
  vendorId: id, paymentDate: paymentCalendarDateSchema,
  paymentMethod: z.enum(["ach", "check", "wire", "credit_card", "other"]),
  totalAmountCents: cents.positive(), referenceNumber: optionalText, checkNumber: optionalText,
  bankAccountLabel: optionalText, notes: optionalText,
  allocations: z.array(allocation).max(100),
}).strict().superRefine((value, context) => {
  if (!Number.isSafeInteger(value.totalAmountCents) || value.totalAmountCents <= 0 || value.allocations.some(row => !Number.isSafeInteger(row.appliedAmountCents) || row.appliedAmountCents <= 0)) return;
  if (new Set(value.allocations.map(row => row.vendorInvoiceId)).size !== value.allocations.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Choose each invoice once." });
  if (value.allocations.reduce((sum, row) => sum + BigInt(row.appliedAmountCents), BigInt(0)) > BigInt(value.totalAmountCents))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Applied amounts exceed the payment total." });
});
export const apPaymentCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("record_payment"), payload: recordPaymentInputSchema, originInvoiceId: id.nullable() }).strict(),
  z.object({ operation: z.literal("apply_payment"), paymentId: id, vendorId: id, paymentTotalAmountCents: cents,
    reviewedUnappliedAmountCents: cents.positive(), payload: paymentApplicationInputSchema }).strict(),
  z.object({ operation: z.literal("void_payment"), paymentId: id, payload: z.object({ reason: z.string().trim().min(1).max(2000) }).strict() }).strict(),
]);
export type ApPaymentCommand = z.infer<typeof apPaymentCommandSchema>;
const recoverySchema = z.object({ version: z.literal(1), userId: z.string().min(1), key: z.string().regex(/^[A-Za-z0-9:_-]{8,100}$/), body: apPaymentCommandSchema }).strict();
export type ApPaymentRecovery = z.infer<typeof recoverySchema>;
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function createApPaymentRecoveryStore(storage: () => RecoveryStorage, userId: string) {
  if (!userId.trim()) throw new Error("Sign in before recording or applying a supplier payment.");
  return createPersistentFinancialIntentStore<ApPaymentCommand, ApPaymentRecovery>({
    storage, userId, storageKey: "echelon:ap-payment:v1",
    parse: raw => recoverySchema.parse(raw),
    messages: {
      read: "Payment recovery cannot be read. Restore browser session storage before continuing.",
      corrupt: "The saved payment request belongs to another operator or cannot be verified. Sign in as the original operator and recover it before sending another payment command.",
      unresolved: "A payment request is unresolved. Recover the saved request before recording, applying or voiding another payment.",
      save: "The payment request was not sent because recovery could not be saved. Restore browser session storage and retry.",
      clear: "The payment outcome is confirmed, but recovery could not be cleared. Retry the saved request again.",
    },
  });
}
function allocationIdentity(rows: readonly { vendorInvoiceId: number; appliedAmountCents: number }[]): string {
  return canonicalJson(rows.map(row => ({ vendorInvoiceId: row.vendorInvoiceId, appliedAmountCents: row.appliedAmountCents })).sort((a, b) => a.vendorInvoiceId - b.vendorInvoiceId));
}
export function createApPaymentCommandClient(generateKey: () => string, store: ReturnType<typeof createApPaymentRecoveryStore>, changed: () => void = () => undefined) {
  return { async execute(raw: ApPaymentCommand, pinned?: ApPaymentRecovery) {
    const command = apPaymentCommandSchema.parse(raw);
    if (command.operation === "apply_payment" && sumPaymentCents(command.payload.allocations.map(row => row.appliedAmountCents)) > command.reviewedUnappliedAmountCents)
      throw new Error("The application exceeds this payment's available balance.");
    if (pinned) {
      const original = recoverySchema.parse(pinned);
      if (original.userId !== store.userId || canonicalJson(original.body) !== canonicalJson(command)) throw new Error("The saved payment request belongs to another operator or command.");
    }
    const record = store.acquire(command, pinned ? () => pinned.key : generateKey);
    if (pinned && record.key !== pinned.key) throw new Error("A different payment request requires recovery. Reload before retrying.");
    changed();
    const url = command.operation === "record_payment" ? "/api/ap-payments" : `/api/ap-payments/${command.paymentId}/${command.operation === "apply_payment" ? "applications" : "void"}`;
    try {
      const rawResult = await financialCommandFetchJson<unknown>(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": record.key }, body: JSON.stringify(command.payload) });
      const invalidResult = (): never => { throw new FinancialCommandRequestError("The payment may have completed, but its result could not be verified. Recover the saved request.", { status: 200, code: "AP_PAYMENT_RESPONSE_INVALID", retryable: false, ambiguous: true }); };
      const matchesIdentity = (result: { actorId: string; idempotencyKey: string; command: string }) => result.actorId === store.userId && result.idempotencyKey === record.key && result.command === command.operation;
      let result: z.infer<typeof recordPaymentResultSchema> | z.infer<typeof paymentApplicationResultSchema> | z.infer<typeof voidPaymentResultSchema>;
      if (command.operation === "void_payment") {
        const parsed = voidPaymentResultSchema.safeParse(rawResult);
        if (!parsed.success) return invalidResult();
        result = parsed.data;
        if (!matchesIdentity(result) || result.paymentId !== command.paymentId) return invalidResult();
      } else if (command.operation === "record_payment") {
        const parsed = recordPaymentResultSchema.safeParse(rawResult);
        if (!parsed.success) return invalidResult();
        result = parsed.data;
        const applied = sumPaymentCents(command.payload.allocations.map(row => row.appliedAmountCents));
        if (!matchesIdentity(result) || result.id !== result.paymentId || result.vendorId !== command.payload.vendorId
          || result.totalAmountCents !== command.payload.totalAmountCents || result.paymentMethod !== command.payload.paymentMethod
          || result.paymentDateSource !== "recorded_calendar_date" || result.paymentCalendarDate !== command.payload.paymentDate
          || result.referenceNumber !== (command.payload.referenceNumber ?? null) || result.checkNumber !== (command.payload.checkNumber ?? null)
          || result.bankAccountLabel !== (command.payload.bankAccountLabel ?? null) || result.notes !== (command.payload.notes ?? null)
          || allocationIdentity(result.applications) !== allocationIdentity(command.payload.allocations)
          || new Set(result.applications.map(row => row.allocationId)).size !== result.applications.length
          || result.paymentBalance.state !== (command.payload.totalAmountCents > applied ? "available" : "fully_applied")
          || result.paymentBalance.appliedAmountCents !== applied || result.paymentBalance.unappliedAmountCents !== command.payload.totalAmountCents - applied) return invalidResult();
      } else {
        const parsed = paymentApplicationResultSchema.safeParse(rawResult);
        if (!parsed.success) return invalidResult();
        result = parsed.data;
        const expectedUnapplied = command.reviewedUnappliedAmountCents - sumPaymentCents(command.payload.allocations.map(row => row.appliedAmountCents));
        if (!matchesIdentity(result) || result.paymentId !== command.paymentId
          || allocationIdentity(result.applications) !== allocationIdentity(command.payload.allocations)
          || new Set(result.applications.map(row => row.allocationId)).size !== result.applications.length
          || result.paymentBalance.state !== (expectedUnapplied > 0 ? "available" : "fully_applied")
          || result.paymentBalance.unappliedAmountCents !== expectedUnapplied || result.paymentBalance.appliedAmountCents !== command.paymentTotalAmountCents - expectedUnapplied
          || result.apLedgerOutcome.entityId !== command.paymentId || canonicalJson([...result.apLedgerOutcome.affectedPaymentIds].sort((a,b) => a-b)) !== canonicalJson([command.paymentId])
          || canonicalJson([...result.apLedgerOutcome.affectedInvoiceIds].sort((a,b) => a-b)) !== canonicalJson(command.payload.allocations.map(row => row.vendorInvoiceId).sort((a,b) => a-b))) return invalidResult();
      }
      store.complete(record.key); changed();
      return result;
    } catch (error) {
      if (error instanceof FinancialCommandRequestError && !error.ambiguous && error.status !== null && error.status >= 400 && error.status < 500 && error.details?.paymentCommandOutcome === "rejected" && error.details.idempotencyKey === record.key && error.details.actorId === store.userId && error.details.command === command.operation) {
        store.complete(record.key); changed();
      }
      throw error;
    }
  } };
}
/** Reject rounding, exponent syntax, negative amounts and unsafe cents. */
export function parsePaymentAmount(raw: string): number {
  const value = raw.trim();
  if (!/^(?:\d+|\d*\.\d{1,2})$/.test(value)) throw new Error("Enter a nonnegative amount with at most two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole || "0") * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The payment amount exceeds the supported range.");
  return Number(amount);
}
export function sumPaymentCents(values: readonly number[]): number {
  let total = BigInt(0);
  for (const value of values) { if (!Number.isSafeInteger(value) || value < 0) throw new Error("Payment amounts must be nonnegative integer cents."); total += BigInt(value); }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The payment total exceeds the supported range.");
  return Number(total);
}
export function formatPaymentAmount(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "Unavailable";
  if (!Number.isSafeInteger(cents)) return "Invalid amount";
  const amount = BigInt(cents), magnitude = amount < BigInt(0) ? -amount : amount;
  return `${amount < BigInt(0) ? "-" : ""}$${String(magnitude / BigInt(100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${String(magnitude % BigInt(100)).padStart(2, "0")}`;
}
export function paymentAllocationInputs(values: Record<number, string>) {
  return Object.entries(values).filter(([, value]) => value.trim() !== "").map(([key, value]) => ({ vendorInvoiceId: id.parse(Number(key)), appliedAmountCents: parsePaymentAmount(value) })).filter(row => row.appliedAmountCents > 0);
}
