import type { OrderEditOperation } from "@shared/order-edits/order-edit.contract";
import { safeOrderEditPaymentUrl } from "@/lib/order-edits";

/** Navigation follows this tab's explicit approval, never simply opening an
 * unpaid edit. Payment evidence still comes from Shopify and the normal worker. */
export function orderEditPaymentDestination(
  operation: OrderEditOperation,
  approvedOperationId: string | null,
): string | null {
  if (
    operation.operationId !== approvedOperationId ||
    operation.status !== "awaiting_payment" ||
    operation.commandInProgress === true ||
    operation.balanceDueCents <= 0 ||
    operation.error !== null
  )
    return null;
  return safeOrderEditPaymentUrl(operation.paymentUrl);
}
