import { shipmentExceptionIdSchema } from "@shared/procurement/shipment-cost-exception";
import {
  reconciliationRequestSchema,
  reconciliationResultSchema,
  type ReconciliationRequest,
} from "@shared/procurement/cost-reconciliation";
import {
  createFinancialCommandIntentStore,
  financialCommandFetchJson,
  FinancialCommandRequestError,
} from "./financial-command";
import { canonicalJson } from "@shared/utils/canonical-json";

export function createShipmentReconciliationClient(generateKey: () => string) {
  const intent = createFinancialCommandIntentStore(generateKey);
  let pending: string | null = null;
  return {
    async reconcile(lineId: number, request: ReconciliationRequest) {
      shipmentExceptionIdSchema.parse(lineId);
      const body = reconciliationRequestSchema.parse(request);
      const fingerprint = canonicalJson({ lineId, body });
      if (pending !== null && pending !== fingerprint)
        throw new FinancialCommandRequestError(
          "Retry the pending approval or reload its saved posting before changing the correction.",
          { status: null, code: "SHIPMENT_RECONCILIATION_PENDING", ambiguous: true, retryable: true },
        );
      const key = intent.acquire({ lineId, body });
      pending = fingerprint;
      try {
        const response = await financialCommandFetchJson<unknown>(`/api/shipment-lines/${lineId}/cost-reconciliation`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body: JSON.stringify(body),
        });
        const result = reconciliationResultSchema.safeParse(response);
        if (
          !result.success ||
          result.data.lineId !== lineId ||
          result.data.state.status !== "posted" ||
          result.data.state.destination !== request.destination
        ) {
          throw new FinancialCommandRequestError(
            "The posting response could not be verified. Reload the saved review or retry this approval.",
            { status: 200, code: "SHIPMENT_RECONCILIATION_RESPONSE_INVALID", ambiguous: true, retryable: true },
          );
        }
        intent.complete(key);
        pending = null;
        return result.data;
      } catch (error) {
        intent.fail(key, error);
        if (!(error instanceof FinancialCommandRequestError) || !error.ambiguous) pending = null;
        throw error;
      }
    },
  };
}
