import { shipmentExceptionIdSchema, shipmentExceptionRequestSchema, shipmentExceptionResultSchema, type ShipmentExceptionRequest } from "@shared/procurement/shipment-cost-exception";
import { createFinancialCommandIntentStore, financialCommandFetchJson, FinancialCommandRequestError } from "./financial-command";

export function createShipmentExceptionClient(generateKey: () => string) {
  const intent = createFinancialCommandIntentStore(generateKey);
  return { async decide(lineId: number, request: ShipmentExceptionRequest) {
    shipmentExceptionIdSchema.parse(lineId);
    const body = shipmentExceptionRequestSchema.parse(request);
    const key = intent.acquire({ lineId, body });
    try {
      const response = await financialCommandFetchJson<unknown>(`/api/shipment-lines/${lineId}/cost-exception`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
      });
      const result = shipmentExceptionResultSchema.safeParse(response);
      if (!result.success || result.data.lineId !== lineId || result.data.decision.action !== request.action) {
        throw new FinancialCommandRequestError("The approval response could not be verified. Reload the saved review or retry this approval.",
          { status: 200, code: "SHIPMENT_EXCEPTION_RESPONSE_INVALID", ambiguous: true, retryable: true });
      }
      intent.complete(key);
      return result.data;
    } catch (error) { intent.fail(key, error); throw error; }
  } };
}
