import type { CancellationRewards } from "@shared/customer-account/order-cancellation";
import type { OrderEditSnapshot } from "../../order-edits/application/order-edit-provider";

export interface OrderCancellationProvider {
  cancelOrder(
    connectionId: number,
    orderId: string,
    operationId: string,
  ): Promise<{ jobId: string; done: boolean }>;
  cancellationJob(
    connectionId: number,
    jobId: string,
  ): Promise<{ done: boolean; failed: boolean; orderId: string | null }>;
}
export interface OrderCancellationRewards {
  reviewCancellation(input: {
    customerId: string;
    orderId: string;
  }): Promise<CancellationRewards>;
  settleCancellation(input: {
    operationId: string;
    customerId: string;
    orderId: string;
  }): Promise<CancellationRewards>;
}
export function cancellationPaymentsSettled(
  snapshot: OrderEditSnapshot,
): boolean {
  return (
    snapshot.cancelled &&
    snapshot.netPaidCents === 0 &&
    snapshot.outstandingCents === 0 &&
    snapshot.capturableCents === 0 &&
    [...snapshot.transactions, ...snapshot.refunds.flatMap(refund => refund.transactions)].every((transaction) =>
      ["SUCCESS", "FAILURE", "ERROR"].includes(transaction.status),
    )
  );
}
