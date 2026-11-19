import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  purchaseOrderEntryCommandSchema, purchaseOrderEntryCommandResultSchema, purchaseOrderEntryResultMatchesRequest,
  type PurchaseOrderEntryCommand, type PurchaseOrderEntryCommandResult,
} from "@shared/procurement/purchase-order-entry-command";
import { FinancialCommandRequestError, financialCommandFetchJson } from "./financial-command";
import { createPersistentFinancialIntentStore } from "./persistent-financial-intent";

const recoverySchema = z.object({
  version: z.literal(1), userId: z.string().min(1), key: z.string().regex(/^[A-Za-z0-9:_-]{8,100}$/),
  body: purchaseOrderEntryCommandSchema,
}).strict();
export type PurchaseOrderEntryRecovery = z.infer<typeof recoverySchema>;

export function purchaseOrderEntryRequest(command: PurchaseOrderEntryCommand): { url: string; method: "POST" | "PUT" } {
  switch (command.action) {
    case "create": return { url: "/api/purchase-orders", method: "POST" };
    case "save-draft": return { url: `/api/purchase-orders/${command.targetId}/draft`, method: "PUT" };
    case "duplicate": return { url: `/api/purchase-orders/${command.targetId}/duplicate`, method: "POST" };
    case "prepare": return { url: `/api/purchase-orders/${command.targetId}/send-to-vendor`, method: "POST" };
    case "prepare-document": return { url: `/api/purchase-orders/${command.targetId}/send-pdf`, method: "POST" };
  }
}

/** One unresolved purchasing request per operator across the full editor,
 * legacy dialog and preparation actions. Never rotate its key after uncertainty. */
export function createPurchaseOrderEntryRecoveryStore(storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">, userId: string) {
  if (!userId.trim()) throw new Error("Sign in before saving purchase orders.");
  return createPersistentFinancialIntentStore<PurchaseOrderEntryCommand, PurchaseOrderEntryRecovery>({
    storage, userId, storageKey: `echelon:purchase-order-entry:v1:${encodeURIComponent(userId)}`,
    parse: raw => recoverySchema.parse(raw),
    messages: {
      read: "Purchase order recovery cannot be read. Restore browser session storage before saving or preparing a purchase.",
      corrupt: "Saved purchase order recovery cannot be verified. Preserve the original request before starting another purchase action.",
      unresolved: "A purchase order request is unresolved. Recover its saved request before saving or preparing another purchase.",
      save: "The purchase order request was not sent because recovery could not be saved. Restore browser session storage and retry.",
      clear: "The purchase order result was confirmed, but recovery could not be cleared. Recover the same saved request again.",
    },
  });
}

export function createPurchaseOrderEntryClient(generateKey: () => string, store: ReturnType<typeof createPurchaseOrderEntryRecoveryStore>, isCurrent: () => boolean) {
  return {
    async execute(input: PurchaseOrderEntryCommand, pinned?: PurchaseOrderEntryRecovery): Promise<PurchaseOrderEntryCommandResult> {
      if (!isCurrent()) throw new Error("The purchasing operator or permission changed. Review the original saved request before sending.");
      const command = purchaseOrderEntryCommandSchema.parse(JSON.parse(canonicalJson(input)));
      if (pinned) {
        const original = recoverySchema.parse(pinned);
        if (original.userId !== store.userId || canonicalJson(original.body) !== canonicalJson(command)) {
          throw new Error("The saved purchase request does not match this operator and intent.");
        }
      }
      const record = store.acquire(command, pinned ? () => pinned.key : generateKey);
      if (pinned && pinned.key !== record.key) throw new Error("Another purchase request now needs recovery. Reload before retrying.");
      const { url, method } = purchaseOrderEntryRequest(command);
      try {
        const raw = await financialCommandFetchJson<unknown>(url, {
          method, credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": record.key },
          body: JSON.stringify(command.payload),
        });
        const parsed = purchaseOrderEntryCommandResultSchema.safeParse(raw);
        if (!parsed.success || parsed.data.entryCommand.idempotencyKey !== record.key
          || !purchaseOrderEntryResultMatchesRequest(parsed.data, command, store.userId)) {
          throw new FinancialCommandRequestError("The purchase order request may have completed, but its result could not be verified. Recover the saved request.", {
            status: null, code: "PURCHASE_ORDER_ENTRY_RESPONSE_INVALID", retryable: true, ambiguous: true,
          });
        }
        if (!isCurrent()) throw new FinancialCommandRequestError("The purchase result arrived after the operator or permission changed. The original request is retained for its operator to confirm.", {
          status: null, code: "PURCHASE_ORDER_ENTRY_CONTEXT_CHANGED", retryable: true, ambiguous: true,
        });
        store.complete(record.key);
        return parsed.data;
      } catch (error) {
        // Permission errors, old middleware keys and generic conflicts cannot
        // prove whether an earlier attempt committed. Retain those exact intents.
        if (isCurrent() && error instanceof FinancialCommandRequestError && !error.ambiguous
          && error.details?.purchaseOrderEntryOutcome === "rejected" && error.details.idempotencyKey === record.key
          && error.details.actorId === store.userId && error.details.action === command.action
          && error.details.targetId === command.targetId && error.details.requestCanonical === canonicalJson(command)) {
          store.complete(record.key);
        }
        throw error;
      }
    },
  };
}
