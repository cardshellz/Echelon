import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { receivingEntryCommandSchema, receivingEntryCommandResultSchema, receivingEntryResultMatchesRequest, type ReceivingEntryCommand, type ReceivingEntryCommandResult } from "@shared/procurement/receiving-entry-command";
import { FinancialCommandRequestError, financialCommandFetchJson } from "./financial-command";
import { createPersistentFinancialIntentStore } from "./persistent-financial-intent";

const recoverySchema = z.object({ version: z.literal(1), userId: z.string().min(1), key: z.string().regex(/^[A-Za-z0-9:_-]{8,100}$/), body: receivingEntryCommandSchema }).strict();
export type ReceivingEntryRecovery = z.infer<typeof recoverySchema>;
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Creation and manual entry share one unresolved intent per operator/session.
 * Equal SKU/counts can describe separate physical batches; only the command key
 * identifies a retry. Never infer deduplication from receipt contents. */
export function createReceivingEntryRecoveryStore(storage: () => RecoveryStorage, userId: string) {
  if (!userId.trim()) throw new Error("Sign in before creating receipts or adding lines.");
  return createPersistentFinancialIntentStore<ReceivingEntryCommand, ReceivingEntryRecovery>({
    storage, userId, storageKey: `echelon:receiving-entry:v1:${encodeURIComponent(userId)}`,
    parse: (raw) => recoverySchema.parse(raw),
    messages: {
      read: "Receiving recovery cannot be read. Restore browser session storage before creating a receipt or adding a line.",
      corrupt: "Saved receiving entry cannot be verified. Restore the original saved request before creating another receipt or line.",
      unresolved: "A receiving entry is unresolved. Confirm its saved request before creating another receipt or line.",
      save: "The receiving entry was not sent because its recovery request could not be saved. Restore browser session storage and retry.",
      clear: "The receiving result was confirmed, but recovery could not be cleared. Confirm the saved request again.",
    },
  });
}
export type ReceivingEntryRecoveryStore = ReturnType<typeof createReceivingEntryRecoveryStore>;

export function createReceivingEntryClient(generateKey: () => string, store: ReceivingEntryRecoveryStore) {
  return {
    async execute(input: ReceivingEntryCommand, pinned?: ReceivingEntryRecovery): Promise<ReceivingEntryCommandResult> {
      const body = receivingEntryCommandSchema.parse(input);
      if (pinned) {
        const original = recoverySchema.parse(pinned);
        if (original.userId !== store.userId || canonicalJson(original.body) !== canonicalJson(body)) throw new Error("The saved receiving entry does not match this operator and intent.");
      }
      const record = store.acquire(body, pinned ? () => pinned.key : generateKey);
      if (pinned && pinned.key !== record.key) throw new Error("A different receiving entry now needs confirmation. Reload before retrying.");
      try {
        const path = body.action === "create" ? "/api/receiving" : `/api/receiving/${body.targetId}/lines`;
        const raw = await financialCommandFetchJson<unknown>(path, {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": record.key }, body: JSON.stringify(body.payload),
        });
        const parsed = receivingEntryCommandResultSchema.safeParse(raw);
        if (!parsed.success || parsed.data.entryCommand.action !== body.action || parsed.data.entryCommand.targetId !== body.targetId
          || parsed.data.entryCommand.actorId !== store.userId || parsed.data.entryCommand.idempotencyKey !== record.key
          || !receivingEntryResultMatchesRequest(parsed.data, body, store.userId)) {
          throw new FinancialCommandRequestError("The receiving entry may have completed, but its result could not be verified. Confirm the saved request.", {
            status: 201, code: "RECEIVING_ENTRY_RESPONSE_INVALID", retryable: true, ambiguous: true,
          });
        }
        store.complete(record.key);
        return parsed.data;
      } catch (error) {
        // A rejected later request does not establish whether an earlier one
        // committed. Only this command's recorded rejection releases its intent.
        if (error instanceof FinancialCommandRequestError && !error.ambiguous
          && error.details?.receivingEntryOutcome === "rejected" && error.details.idempotencyKey === record.key) store.complete(record.key);
        throw error;
      }
    },
  };
}
