import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { receiptReversalCommandResultSchema, receiptReversalIdSchema, receiptReversalLineBodySchema, receiptReversalOrderBodySchema, type ReceiptReversalCommandResult } from "@shared/procurement/receipt-reversal-command";
import { FinancialCommandRequestError, financialCommandFetchJson } from "./financial-command";
import { createPersistentFinancialIntentStore } from "./persistent-financial-intent";

const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("line"), targetId: receiptReversalIdSchema, receivingOrderId: receiptReversalIdSchema, payload: receiptReversalLineBodySchema }).strict(),
  z.object({ action: z.literal("order"), targetId: receiptReversalIdSchema, receivingOrderId: receiptReversalIdSchema, payload: receiptReversalOrderBodySchema }).strict(),
]).refine(value => value.action !== "order" || value.targetId === value.receivingOrderId, "Receipt reversal target does not match the receipt.");
const recoverySchema = z.object({ version: z.literal(1), userId: z.string().min(1), key: z.string().regex(/^[A-Za-z0-9:_-]{8,100}$/), body: commandSchema }).strict();
export type ReceiptReversalCommand = z.infer<typeof commandSchema>;
export type ReceiptReversalRecovery = z.infer<typeof recoverySchema>;
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The two reversal endpoints share one pending intent per authenticated session. */
export function createReceiptReversalRecoveryStore(storage: () => RecoveryStorage, userId: string) {
  if (!userId.trim()) throw new Error("Sign in before reversing a receipt.");
  return createPersistentFinancialIntentStore<ReceiptReversalCommand, ReceiptReversalRecovery>({
    storage, userId, storageKey: `echelon:receipt-reversal:v1:${encodeURIComponent(userId)}`,
    parse: (raw) => recoverySchema.parse(raw),
    messages: {
      read: "Receipt reversal recovery cannot be read. Restore browser session storage before reversing a receipt.",
      corrupt: "Saved receipt reversal cannot be verified. Restore the original saved request before recording another reversal.",
      unresolved: "A receipt reversal is unresolved. Recover its saved request before recording another reversal.",
      save: "The reversal was not sent because its recovery request could not be saved. Restore browser session storage and retry.",
      clear: "The reversal result was confirmed, but recovery could not be cleared. Recover the saved request again.",
    },
  });
}
export type ReceiptReversalRecoveryStore = ReturnType<typeof createReceiptReversalRecoveryStore>;

export function createReceiptReversalClient(generateKey: () => string, store: ReceiptReversalRecoveryStore) {
  return {
    async execute(input: ReceiptReversalCommand, pinned?: ReceiptReversalRecovery): Promise<ReceiptReversalCommandResult> {
      const body = commandSchema.parse(input);
      if (pinned) {
        const original = recoverySchema.parse(pinned);
        if (original.userId !== store.userId || canonicalJson(original.body) !== canonicalJson(body)) throw new Error("The saved reversal does not match this operator and intent.");
      }
      const record = store.acquire(body, pinned ? () => pinned.key : generateKey);
      if (pinned && pinned.key !== record.key) throw new Error("A different reversal now needs recovery. Reload before retrying.");
      try {
        const path = body.action === "line" ? "receiving-lines" : "receiving-orders";
        const raw = await financialCommandFetchJson<unknown>(`/api/procurement/${path}/${body.targetId}/reverse`, {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": record.key }, body: JSON.stringify(body.payload),
        });
        const parsed = receiptReversalCommandResultSchema.safeParse(raw);
        if (!parsed.success || parsed.data.action !== body.action || parsed.data.targetId !== body.targetId
          || parsed.data.receivingOrderId !== body.receivingOrderId || parsed.data.actorId !== store.userId || parsed.data.idempotencyKey !== record.key
          || (body.action === "line" && (parsed.data.action !== "line" || parsed.data.qty !== body.payload.qty))) {
          throw new FinancialCommandRequestError("The receipt reversal may have completed, but its result could not be verified. Recover the saved request.", {
            status: 200, code: "RECEIPT_REVERSAL_RESPONSE_INVALID", retryable: true, ambiguous: true,
          });
        }
        store.complete(record.key);
        return parsed.data;
      } catch (error) {
        // Authentication, transport and generic rejection responses cannot prove
        // whether an earlier request committed. Only a matching durable rejection can.
        if (error instanceof FinancialCommandRequestError && !error.ambiguous
          && error.details?.receiptReversalOutcome === "rejected" && error.details.idempotencyKey === record.key) store.complete(record.key);
        throw error;
      }
    },
  };
}

/** A parent receipt read must not authorize a line belonging to another receipt. */
export function assertReceiptReversalLineTarget(receivingOrderId: number, receivingLineId: number, lines: readonly { id: number; receivingOrderId: number }[]): void {
  const matches = lines.filter(line => line.id === receivingLineId);
  if (!receiptReversalIdSchema.safeParse(receivingOrderId).success || !receiptReversalIdSchema.safeParse(receivingLineId).success
    || matches.length !== 1 || matches[0].receivingOrderId !== receivingOrderId) {
    throw new Error("This line's receipt ownership could not be verified. Reload the receipt before reversing it.");
  }
}
