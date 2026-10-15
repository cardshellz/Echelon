import { shipmentCostWorkflowIdSchema, shipmentCostUpdateResultSchema, type ShipmentCostUpdateResult } from "@shared/procurement/shipment-cost-workflow";
import { createFinancialCommandIntentStore, financialCommandFetchJson, FinancialCommandRequestError, type FinancialCommandIntentStore } from "./financial-command";

/** Each shipment keeps its own uncertain command so a retry cannot post twice. */
export function createShipmentCostUpdateClient(generateKey: () => string) {
  const intents = new Map<number, FinancialCommandIntentStore>();
  return { async update(shipmentId: number): Promise<ShipmentCostUpdateResult> {
    shipmentCostWorkflowIdSchema.parse(shipmentId);
    let intent = intents.get(shipmentId);
    if (!intent) { intent = createFinancialCommandIntentStore(generateKey); intents.set(shipmentId, intent); }
    const url = `/api/inbound-shipments/${shipmentId}/update-costs`;
    const key = intent.acquire({ shipmentId });
    try {
      const response = await financialCommandFetchJson<unknown>(url, { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: "{}" });
      const result = shipmentCostUpdateResultSchema.safeParse(response);
      if (!result.success || result.data.shipmentId !== shipmentId) throw new FinancialCommandRequestError(
        "The cost update response could not be verified. Reload the saved results before retrying.",
        { status: 200, code: "SHIPMENT_COST_UPDATE_RESPONSE_INVALID", retryable: true, ambiguous: true },
      );
      intent.complete(key);
      return result.data;
    } catch (error) { intent.fail(key, error); throw error; }
  } };
}

/** Keep transport wrappers and internal exceptions out of the purchasing flow. */
export function shipmentCostWorkflowError(error: unknown): string {
  if (error instanceof FinancialCommandRequestError) {
    if (error.status === 401) return "Your session expired. Sign in again before updating costs.";
    if (error.status === 403) return "A user with purchasing approval permission must update these costs.";
    if (error.code === "FINANCIAL_COMMAND_IN_PROGRESS") return "This cost update is already running. Reload the saved results, then retry if needed.";
    if (error.ambiguous) return "We could not confirm the cost update. Reload the saved results, then retry if needed; the same update will not be posted twice.";
    return error.message;
  }
  const message = error instanceof Error ? error.message : "";
  const wrapped = /^(\d{3}):\s*([\s\S]*)$/.exec(message);
  if (wrapped) {
    if (wrapped[1] === "403") return "A user with purchasing permission must make this change.";
    if (Number(wrapped[1]) >= 500) return "The cost review is temporarily unavailable. Reload it and try again.";
    try {
      const body: unknown = JSON.parse(wrapped[2]);
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
    } catch { /* A gateway response is not a user-facing cost explanation. */ }
    return "The cost request could not be completed. Reload this shipment and try again.";
  }
  return "The cost request could not be completed. Reload the saved results and try again.";
}
