import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { purchaseApprovalInputSchema, purchaseApprovalResultSchema, type PurchaseApprovalResult } from "@shared/procurement/purchase-approval-command";
import { FinancialCommandRequestError, financialCommandFetchJson } from "./financial-command";
import { createPersistentFinancialIntentStore } from "./persistent-financial-intent";

const intentSchema = purchaseApprovalInputSchema.extend({ purchaseOrderId: z.number().int().positive() });
export type PurchaseApprovalIntent = z.infer<typeof intentSchema>;
const recoverySchema = z.object({ version: z.literal(1), userId: z.string().min(1), key: z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/), body: intentSchema }).strict();
export type PurchaseApprovalRecovery = z.infer<typeof recoverySchema>;

export function createPurchaseApprovalRecoveryStore(storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">, userId: string) {
  if (!userId.trim()) throw new Error("Sign in before approving a purchase order.");
  return createPersistentFinancialIntentStore<PurchaseApprovalIntent, PurchaseApprovalRecovery>({
    storage, userId, storageKey: `echelon:purchase-approval:v1:${encodeURIComponent(userId)}`,
    parse: (raw) => recoverySchema.parse(raw),
    messages: {
      read: "Purchase approval recovery cannot be read. Restore browser session storage before approving.",
      corrupt: "Saved purchase approval cannot be verified. Restore the original saved request before approving another purchase.",
      unresolved: "A purchase approval is unresolved. Recover its saved request before approving another purchase.",
      save: "Purchase approval was not sent because its recovery request could not be saved. Restore browser session storage and retry.",
      clear: "Purchase approval was confirmed, but recovery could not be cleared. Recover the saved request again.",
    },
  });
}

export function createPurchaseApprovalClient(generateKey: () => string, store: ReturnType<typeof createPurchaseApprovalRecoveryStore>) {
  return {
    async execute(input: PurchaseApprovalIntent, pinned?: PurchaseApprovalRecovery): Promise<PurchaseApprovalResult> {
      const parsedIntent = intentSchema.safeParse(input);
      if (!parsedIntent.success) throw new Error("Reload the purchase order and review its current amount and lines before approving.");
      const intent = parsedIntent.data;
      if (pinned) {
        const saved = recoverySchema.parse(pinned);
        if (saved.userId !== store.userId || canonicalJson(saved.body) !== canonicalJson(intent)) throw new Error("The saved approval does not match this operator and reviewed purchase.");
      }
      const record = store.acquire(intent, pinned ? () => pinned.key : generateKey);
      if (pinned && pinned.key !== record.key) throw new Error("Another approval request needs recovery. Reload before retrying.");
      const { purchaseOrderId, ...body } = intent;
      try {
        const raw = await financialCommandFetchJson<unknown>(`/api/purchase-orders/${purchaseOrderId}/approve`, {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": record.key }, body: JSON.stringify(body),
        });
        const parsed = purchaseApprovalResultSchema.safeParse(raw);
        if (!parsed.success || parsed.data.id !== purchaseOrderId || parsed.data.approvedBy !== store.userId
          || parsed.data.totalCents !== body.expectedTotalCents || parsed.data.reviewedUpdatedAt !== body.expectedUpdatedAt
          || parsed.data.reviewedLinesFingerprint !== body.expectedLinesFingerprint
          || parsed.data.approvalCommand.idempotencyKey !== record.key) {
          throw new FinancialCommandRequestError("Purchase approval may have completed, but its result could not be verified. Recover the saved request.", {
            status: 200, code: "PO_APPROVAL_RESPONSE_INVALID", retryable: true, ambiguous: true,
          });
        }
        store.complete(record.key);
        return parsed.data;
      } catch (error) {
        if (error instanceof FinancialCommandRequestError && !error.ambiguous
          && error.details?.purchaseApprovalOutcome === "rejected" && error.details.idempotencyKey === record.key) store.complete(record.key);
        throw error;
      }
    },
  };
}
