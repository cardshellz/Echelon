import { supplierReturnReviewIntentSchema, verifySupplierReturnCreditReviewResult } from "./supplier-return-credit-review";
import type { SupplierReturnCreditReviewCommandResult } from "@shared/procurement/supplier-return-credit";
import type { SupplierReturnCommandResult } from "@shared/procurement/supplier-return";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { supplierReturnPreviewSchema, supplierReturnRecordInputSchema, supplierReturnCommandResultSchema, type SupplierReturnPreviewInput, type SupplierReturnStockPreview } from "@shared/procurement/supplier-return";
import { createPersistentFinancialIntentStore } from "./persistent-financial-intent";
import { financialCommandFetchJson, FinancialCommandRequestError } from "./financial-command";

const selectedLines = (rows: readonly { inventoryLotId: number; quantity: number }[]) => canonicalJson(rows.map(({ inventoryLotId, quantity }) => ({ inventoryLotId, quantity })).sort((a, b) => a.inventoryLotId - b.inventoryLotId));
export function verifySupplierReturnPreview(input: SupplierReturnPreviewInput, raw: unknown): SupplierReturnStockPreview {
  const preview = supplierReturnPreviewSchema.parse(raw);
  if (preview.vendorId !== input.vendorId || selectedLines(preview.lines) !== selectedLines(input.lines)) throw new Error("Return preview belongs to different selected stock. Review the source again.");
  return preview;
}
const supplierReturnRecordIntentSchema = z.object({
  command: z.literal("record"), payload: supplierReturnRecordInputSchema, reviewed: supplierReturnPreviewSchema,
}).strict().superRefine((value, context) => {
  if (value.payload.vendorId !== value.reviewed.vendorId || value.payload.expectedSourceFingerprint !== value.reviewed.sourceFingerprint
    || selectedLines(value.payload.lines) !== selectedLines(value.reviewed.lines)) context.addIssue({ code: "custom", message: "The return request must match its reviewed physical and value evidence." });
});
export const supplierReturnIntentSchema = z.union([supplierReturnRecordIntentSchema, supplierReturnReviewIntentSchema]);
export type SupplierReturnResult = SupplierReturnCommandResult | SupplierReturnCreditReviewCommandResult;
export function supplierReturnResultId(result: SupplierReturnResult): number { return result.command === "record" ? result.returnId : result.review.returnId; }
export type SupplierReturnIntent = z.infer<typeof supplierReturnIntentSchema>;
const recoverySchema = z.object({ version: z.literal(1), userId: z.string().min(1), key: z.string().regex(/^[A-Za-z0-9:_-]{8,100}$/), body: supplierReturnIntentSchema }).strict();
export type SupplierReturnRecovery = z.infer<typeof recoverySchema>;
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function createSupplierReturnRecoveryStore(storage: () => RecoveryStorage, userId: string) {
  if (!userId.trim()) throw new Error("Sign in before recording a supplier return.");
  return createPersistentFinancialIntentStore<SupplierReturnIntent, SupplierReturnRecovery>({
    storage, userId, storageKey: "echelon:supplier-return:v1", parse: raw => recoverySchema.parse(raw),
    messages: {
      read: "Supplier return recovery cannot be read. Restore browser session storage before continuing.",
      corrupt: "The saved supplier return belongs to another operator or cannot be verified. Recover it as the original operator before recording another return.",
      unresolved: "A supplier return is unresolved. Recover it before recording another physical return.",
      save: "The supplier return was not sent because its recovery could not be saved.",
      clear: "The return outcome is confirmed, but recovery could not be cleared. Recover the saved request again.",
    },
  });
}
export function createSupplierReturnClient(generateKey: () => string, store: ReturnType<typeof createSupplierReturnRecoveryStore>, changed: () => void = () => undefined) {
  return { async execute(raw: SupplierReturnIntent, pinned?: SupplierReturnRecovery) {
    const intent = supplierReturnIntentSchema.parse(raw);
    if (pinned && (pinned.userId !== store.userId || canonicalJson(recoverySchema.parse(pinned).body) !== canonicalJson(intent))) throw new Error("The saved return belongs to another operator or action.");
    const saved = store.acquire(intent, pinned ? () => pinned.key : generateKey);
    if (pinned && saved.key !== pinned.key) throw new Error("Another supplier return needs recovery. Reload before retrying.");
    changed();
    try {
      const endpoint = intent.command === "record" ? "/api/supplier-returns" : `/api/supplier-return-entitlements/${intent.entitlementId}/review`;
      const rawResult = await financialCommandFetchJson<unknown>(endpoint, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": saved.key }, body: JSON.stringify(intent.payload) });
      if (intent.command === "review_credit_difference") {
        const result = verifySupplierReturnCreditReviewResult(rawResult, intent, store.userId, saved.key);
        store.complete(saved.key); changed(); return result;
      }
      const parsed = supplierReturnCommandResultSchema.safeParse(rawResult);
      const invalid = (): never => { throw new FinancialCommandRequestError("The physical return may have completed, but its response could not be verified. Recover the saved request.", { status: 200, code: "SUPPLIER_RETURN_RESPONSE_INVALID", ambiguous: true, retryable: false }); };
      if (!parsed.success) return invalid();
      const result = parsed.data;
      const detail = result.return;
      if (result.actorId !== store.userId || result.idempotencyKey !== saved.key || canonicalJson(result.request) !== canonicalJson(intent.payload)
        || detail.vendorId !== intent.payload.vendorId || detail.sourceFingerprint !== intent.reviewed.sourceFingerprint
        || detail.returnCalendarDate !== intent.payload.returnCalendarDate || detail.evidenceReference !== intent.payload.evidenceReference
        || detail.reason !== intent.payload.reason || detail.supplierReference !== (intent.payload.supplierReference ?? null)) return invalid();
      const sources = detail.lines.map(line => line.source).sort((a, b) => a.inventoryLotId - b.inventoryLotId);
      const reviewed = [...intent.reviewed.lines].sort((a, b) => a.inventoryLotId - b.inventoryLotId);
      if (canonicalJson(sources) !== canonicalJson(reviewed)) return invalid();
      // Replays can contain later cost revisions. Verify the immutable initial
      // entries against the reviewed value, never substitute current costs.
      for (const line of detail.lines) {
        const receipt = detail.inventoryReceipt.lines.find(row => row.returnLineId === line.id)!;
        for (const component of ["product", "packaging", "landed"] as const) {
          const initial = line.costEntries.filter(entry => entry.id === receipt.initialCostEntryIds[component]);
          if (initial.length !== 1 || initial[0].component !== component || initial[0].recordedBy !== store.userId
            || initial[0].previousMills !== 0 || initial[0].nextMills !== line.source.costs[`${component}Mills`]
            || initial[0].deltaMills !== line.source.costs[`${component}Mills`]) return invalid();
        }
      }
      store.complete(saved.key); changed(); return result;
    } catch (error) {
      if (error instanceof FinancialCommandRequestError && !error.ambiguous && error.status !== null && error.status >= 400 && error.status < 500
        && error.details?.supplierReturnCommandOutcome === "rejected" && error.details.command === intent.command
        && error.details.actorId === store.userId && error.details.idempotencyKey === saved.key
        && (intent.command === "record" || error.details.entitlementId === intent.entitlementId)) { store.complete(saved.key); changed(); }
      throw error;
    }
  } };
}
