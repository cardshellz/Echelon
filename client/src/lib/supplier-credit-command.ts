import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { supplierCreditCreateInputSchema, supplierCreditReviewInputSchema, supplierCreditApplyInputSchema, supplierCreditCommandResultSchema, supplierCreditIdSchema } from "@shared/procurement/supplier-credit";
import { createPersistentFinancialIntentStore } from "./persistent-financial-intent";
import { financialCommandFetchJson, FinancialCommandRequestError } from "./financial-command";

export const supplierCreditIntentSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("create"), payload: supplierCreditCreateInputSchema }).strict(),
  z.object({ command: z.literal("approve"), creditId: supplierCreditIdSchema, payload: supplierCreditReviewInputSchema }).strict(),
  z.object({ command: z.literal("apply"), creditId: supplierCreditIdSchema, payload: supplierCreditApplyInputSchema }).strict(),
  z.object({ command: z.literal("reverse"), creditId: supplierCreditIdSchema, applicationId: supplierCreditIdSchema, payload: supplierCreditReviewInputSchema }).strict(),
  z.object({ command: z.literal("void"), creditId: supplierCreditIdSchema, payload: supplierCreditReviewInputSchema }).strict(),
]);
export type SupplierCreditIntent = z.infer<typeof supplierCreditIntentSchema>;
const recoverySchema = z.object({ version: z.literal(1), userId: z.string().min(1), key: z.string().regex(/^[A-Za-z0-9:_-]{8,100}$/), body: supplierCreditIntentSchema }).strict();
export type SupplierCreditRecovery = z.infer<typeof recoverySchema>;
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function createSupplierCreditRecoveryStore(storage: () => RecoveryStorage, userId: string) {
  if (!userId.trim()) throw new Error("Sign in before changing a supplier credit.");
  return createPersistentFinancialIntentStore<SupplierCreditIntent, SupplierCreditRecovery>({
    storage, userId, storageKey: "echelon:supplier-credit:v1", parse: raw => recoverySchema.parse(raw),
    messages: {
      read: "Supplier credit recovery cannot be read. Restore browser session storage before continuing.",
      corrupt: "The saved supplier credit request belongs to another operator or cannot be verified. Recover it as the original operator before another credit action.",
      unresolved: "A supplier credit request is unresolved. Recover it before another credit action.",
      save: "The supplier credit request was not sent because its recovery could not be saved.",
      clear: "The credit outcome is confirmed, but recovery could not be cleared. Recover the saved request again.",
    },
  });
}
function commandUrl(intent: SupplierCreditIntent): string {
  if (intent.command === "create") return "/api/supplier-credits";
  const base = `/api/supplier-credits/${intent.creditId}`;
  if (intent.command === "reverse") return `${base}/applications/${intent.applicationId}/reverse`;
  return `${base}/${intent.command === "apply" ? "applications" : intent.command}`;
}
export function createSupplierCreditClient(generateKey: () => string, store: ReturnType<typeof createSupplierCreditRecoveryStore>, changed: () => void = () => undefined) {
  return {
    async execute(raw: SupplierCreditIntent, pinned?: SupplierCreditRecovery) {
      const intent = supplierCreditIntentSchema.parse(raw);
      if (pinned && (pinned.userId !== store.userId || canonicalJson(recoverySchema.parse(pinned).body) !== canonicalJson(intent))) throw new Error("The saved credit request belongs to another operator or action.");
      const saved = store.acquire(intent, pinned ? () => pinned.key : generateKey);
      if (pinned && saved.key !== pinned.key) throw new Error("Another credit request needs recovery. Reload before retrying.");
      changed();
      try {
        const response = await financialCommandFetchJson<unknown>(commandUrl(intent), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": saved.key }, body: JSON.stringify(intent.payload) });
        const parsed = supplierCreditCommandResultSchema.safeParse(response);
        const invalid = (): never => { throw new FinancialCommandRequestError("The credit may have completed, but its response could not be verified. Recover the saved request.", { status: 200, code: "SUPPLIER_CREDIT_RESPONSE_INVALID", ambiguous: true, retryable: false }); };
        if (!parsed.success) return invalid();
        const result = parsed.data;
        if (result.actorId !== store.userId || result.idempotencyKey !== saved.key || result.command !== intent.command || canonicalJson(result.request) !== canonicalJson(intent.payload)) return invalid();
        if (intent.command !== "create" && result.creditId !== intent.creditId) return invalid();
        if (intent.command === "create") {
          const submittedLines = intent.payload.lines;
          const returnedLines = result.credit.lines.map(({ invoiceLineId, amountCents, disposition }) => ({ invoiceLineId, amountCents, disposition }));
          if (result.credit.createdBy !== store.userId || result.credit.replacesCreditId !== (intent.payload.replacesCreditId ?? null) || result.credit.sourceInvoiceId !== intent.payload.sourceInvoiceId || result.credit.supplierReference !== intent.payload.supplierReference
            || result.credit.creditCalendarDate !== intent.payload.creditCalendarDate || result.credit.reason !== intent.payload.reason || result.credit.status !== "draft"
            || new Set(result.credit.lines.map(line => line.id)).size !== result.credit.lines.length
            || BigInt(result.credit.totalAmountCents) !== submittedLines.reduce((sum, line) => sum + BigInt(line.amountCents), BigInt(0))
            || canonicalJson(returnedLines.map(line => canonicalJson(line)).sort()) !== canonicalJson(submittedLines.map(line => canonicalJson(line)).sort())) return invalid();
        }
        if (["approve", "apply", "reverse"].includes(intent.command) && result.credit.status !== "approved") return invalid();
        if (intent.command === "approve" && result.credit.approvedBy !== store.userId) return invalid();
        if (intent.command === "void" && (result.credit.status !== "voided" || result.credit.voidedBy !== store.userId || result.credit.voidReason !== intent.payload.reason)) return invalid();
        if (intent.command === "apply") {
          const applied = result.credit.applications.filter(row => result.applicationIds.includes(row.id));
          const amounts = (rows: readonly { vendorInvoiceId: number; appliedAmountCents: number }[]) => canonicalJson(rows.map(({ vendorInvoiceId, appliedAmountCents }) => ({ vendorInvoiceId, appliedAmountCents })).sort((a, b) => a.vendorInvoiceId - b.vendorInvoiceId));
          if (new Set(result.applicationIds).size !== result.applicationIds.length || result.applicationIds.length !== applied.length || applied.length !== intent.payload.allocations.length || applied.some(row => row.reversal !== null || row.actorId !== store.userId || row.reason !== intent.payload.reason) || amounts(applied) !== amounts(intent.payload.allocations)) return invalid();
        } else if (result.applicationIds.length !== 0) return invalid();
        if (intent.command === "reverse") {
          const reversal = result.credit.applications.find(row => row.id === intent.applicationId)?.reversal;
          if (result.reversedApplicationId !== intent.applicationId || !reversal || reversal.actorId !== store.userId || reversal.reason !== intent.payload.reason) return invalid();
        } else if (result.reversedApplicationId !== null) return invalid();
        store.complete(saved.key); changed();
        return result;
      } catch (error) {
        if (error instanceof FinancialCommandRequestError && !error.ambiguous && error.status !== null && error.status >= 400 && error.status < 500
          && error.details?.creditCommandOutcome === "rejected" && error.details.command === intent.command && error.details.actorId === store.userId && error.details.idempotencyKey === saved.key) {
          store.complete(saved.key); changed();
        }
        throw error;
      }
    }
  };
}
