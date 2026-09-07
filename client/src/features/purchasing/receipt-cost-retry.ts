import { receiptCostRetryResultSchema, type ReceiptCostRetryResult } from "@shared/procurement/receipt-cost-queue";
import { createFinancialCommandIntentStore, financialCommandFetchJson, FinancialCommandRequestError } from "@/lib/financial-command";

/** The same receipt intent retains its key after an uncertain response. A
 * completed review/retry outcome may be retried as a new explicit command. */
export function createReceiptCostRetryClient(dependencies: {
  generateKey: () => string;
  request?: typeof financialCommandFetchJson;
}) {
  const request = dependencies.request ?? financialCommandFetchJson;
  const stores = new Map<number, ReturnType<typeof createFinancialCommandIntentStore>>();
  return async (receiptId: number): Promise<ReceiptCostRetryResult> => {
    if (!Number.isSafeInteger(receiptId) || receiptId <= 0) throw new Error("The receipt reference is invalid.");
    const intent = stores.get(receiptId) ?? createFinancialCommandIntentStore(dependencies.generateKey);
    stores.set(receiptId, intent);
    const key = intent.acquire({ receiptId, action: "retry_receipt_costs" });
    try {
      const response = await request<unknown>(`/api/receiving/${receiptId}/retry-costs`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: "{}",
      });
      const result = receiptCostRetryResultSchema.safeParse(response);
      if (!result.success) throw new FinancialCommandRequestError("The cost result could not be verified. Refresh the workspace or retry the same request.", {
        status: 200, code: "RECEIPT_COST_RESPONSE_INVALID", ambiguous: true, retryable: true,
      });
      intent.complete(key); stores.delete(receiptId);
      return result.data;
    } catch (error) {
      intent.fail(key, error);
      throw error;
    }
  };
}
