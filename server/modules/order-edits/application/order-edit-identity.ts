import type { OrderEditSnapshot } from "./order-edit-provider";
import type { OrderEditOrderReference } from "./order-edit-store";
import { OrderEditError } from "../domain/order-edit-error";
export const orderEditHasUnresolvedPayment = (
  snapshot: OrderEditSnapshot,
): boolean =>
  snapshot.transactions.some(
    (transaction) =>
      ["SALE", "CAPTURE", "AUTHORIZATION", "REFUND"].includes(
        transaction.kind,
      ) && !["SUCCESS", "FAILURE", "ERROR"].includes(transaction.status),
  );
export function orderEditEligibilityReasons(
  snapshot: OrderEditSnapshot,
): string[] {
  const reasons = [...snapshot.editableErrors];
  if (
    snapshot.evidence.countryCode !== "US" ||
    snapshot.lines.some((line) => line.quantity > 0 && line.unsupported)
  ) {
    reasons.push(
      "This pilot supports US physical-product orders with supported item pricing.",
    );
  }
  if (snapshot.refunds.length > 0)
    reasons.push(
      "Orders with previous refunds require staff review before editing.",
    );
  if (!snapshot.editable || snapshot.cancelled || snapshot.closed)
    reasons.push("Shopify does not allow editing this order.");
  if (
    !snapshot.fullyPaid ||
    snapshot.outstandingCents !== 0 ||
    snapshot.netPaidCents !== snapshot.totalCents ||
    snapshot.capturableCents !== 0 ||
    orderEditHasUnresolvedPayment(snapshot)
  )
    reasons.push(
      "The original order must be fully paid with no payment or refund still processing.",
    );
  if (snapshot.lines.some((line) => line.quantity !== line.unfulfilledQuantity))
    reasons.push("Picking or fulfillment has already started.");
  return reasons;
}
export function assertOrderEditIdentity(
  reference: Pick<
    OrderEditOrderReference,
    "connectionId" | "channelId" | "externalOrderId" | "externalCustomerId"
  >,
  snapshot: OrderEditSnapshot,
): void {
  const externalId = reference.externalOrderId.split("/").at(-1);
  const customerId = reference.externalCustomerId?.split("/").at(-1) ?? null;
  if (
    snapshot.connectionId !== reference.connectionId ||
    snapshot.channelId !== reference.channelId ||
    snapshot.orderId !== `gid://shopify/Order/${externalId}` ||
    (snapshot.customerId?.split("/").at(-1) ?? null) !== customerId
  )
    throw new OrderEditError(
      "ORDER_EDIT_IDENTITY_CHANGED",
      "The Shopify order identity does not match Echelon.",
    );
}
