import type { CancellationRewards } from "@shared/customer-account/order-cancellation";
export { cancellationPaymentsSettled } from "../../order-edits/domain/order-edit-financials";

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
