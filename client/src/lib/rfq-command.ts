import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  RFQ_RECEIPT_VERSION_HEADER, matchesRfqCommandReceipt, rfqCommandIntentSchema,
  rfqCommandRejectionDetailsSchema, type RfqCommandIntent,
} from "@shared/procurement/rfq-command";
import { createPersistentFinancialIntentStore } from "./persistent-financial-intent";
import { financialCommandFetchJson, FinancialCommandRequestError } from "./financial-command";

const recoverySchema = z.object({
  version: z.literal(1), userId: z.string().min(1),
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/), body: rfqCommandIntentSchema,
}).strict();
export type RfqCommandRecovery = z.infer<typeof recoverySchema>;
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createRfqRecoveryStore(storage: () => RecoveryStorage, userId: string) {
  if (!userId.trim()) throw new Error("Sign in before changing an RFQ.");
  return createPersistentFinancialIntentStore<RfqCommandIntent, RfqCommandRecovery>({
    storage, userId, storageKey: "echelon:rfq-workflow:v1", parse: raw => recoverySchema.parse(raw),
    messages: {
      read: "RFQ recovery cannot be read. Restore browser session storage before continuing.",
      corrupt: "The saved RFQ request belongs to another operator or cannot be verified. Recover it as the original operator before another RFQ action.",
      unresolved: "An RFQ request is unresolved. Recover the original request before another RFQ action.",
      save: "The RFQ request was not sent because its recovery could not be saved.",
      clear: "The RFQ outcome is confirmed, but recovery could not be cleared. Recover the saved request again.",
    },
  });
}

function commandUrl(intent: RfqCommandIntent): string {
  const base = `/api/purchasing/rfqs/${intent.rfqId}`;
  return intent.operation === "capture_quote" ? `${base}/lines/${intent.lineId}/quotes` : `${base}/${intent.operation}`;
}

export function createRfqCommandClient(
  generateKey: () => string,
  store: ReturnType<typeof createRfqRecoveryStore>,
  options: { canExecute: (intent: RfqCommandIntent) => boolean; changed?: () => void },
) {
  const changed = options.changed ?? (() => undefined);
  function requireAuthority(intent: RfqCommandIntent): void {
    if (!options.canExecute(intent)) throw new Error("Current purchasing edit permission is required. The saved RFQ request is retained.");
  }
  return {
    async execute(raw: RfqCommandIntent, pinned?: RfqCommandRecovery) {
      const intent = rfqCommandIntentSchema.parse(raw);
      requireAuthority(intent);
      if (pinned) {
        const original = recoverySchema.parse(pinned);
        if (original.userId !== store.userId || canonicalJson(original.body) !== canonicalJson(intent)) {
          throw new Error("The saved RFQ request belongs to another operator or action.");
        }
      }
      const saved = store.acquire(intent, pinned ? () => pinned.key : generateKey);
      if (pinned && saved.key !== pinned.key) throw new Error("Another RFQ request needs recovery. Reload before retrying.");
      changed();
      // Saving can notify other mounted panels. Recheck the current actor and
      // permission immediately before dispatch, retaining the saved request.
      requireAuthority(intent);
      try {
        const response = await financialCommandFetchJson<unknown>(commandUrl(intent), {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json", "Idempotency-Key": saved.key, [RFQ_RECEIPT_VERSION_HEADER]: "1" },
          body: JSON.stringify(intent.payload),
        });
        if (!matchesRfqCommandReceipt(response, { actorId: store.userId, idempotencyKey: saved.key, intent })) {
          throw new FinancialCommandRequestError("The RFQ action may have completed, but its result could not be verified. Recover the saved request.", {
            status: 200, code: "RFQ_RESPONSE_INVALID", ambiguous: true, retryable: false,
          });
        }
        requireAuthority(intent);
        store.complete(saved.key); changed();
        return response;
      } catch (error) {
        if (error instanceof FinancialCommandRequestError && !error.ambiguous && error.status !== null && error.status >= 400 && error.status < 500) {
          const rejection = rfqCommandRejectionDetailsSchema.safeParse(error.details);
          if (options.canExecute(intent) && rejection.success && rejection.data.actorId === store.userId && rejection.data.idempotencyKey === saved.key
            && canonicalJson(rejection.data.intent) === canonicalJson(intent)) {
            store.complete(saved.key); changed();
          }
        }
        throw error;
      }
    },
  };
}
