import type { DropshipSourcePlatform } from "../../../../shared/schema/dropship.schema";

export type DropshipMarketplaceOrderCancellationReason = "payment_hold_expired" | "order_intake_rejected";

export interface DropshipMarketplaceOrderCancellationRequest {
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  externalOrderId: string;
  externalOrderNumber: string | null;
  sourceOrderId: string | null;
  orderedAt: string | null;
  reason: DropshipMarketplaceOrderCancellationReason;
  idempotencyKey: string;
}

export interface DropshipMarketplaceOrderCancellationResult {
  status: "cancelled" | "already_cancelled";
  externalCancellationId: string | null;
  rawResult: Record<string, unknown>;
}

export interface DropshipMarketplaceOrderCancellationProvider {
  cancelOrder(
    input: DropshipMarketplaceOrderCancellationRequest,
  ): Promise<DropshipMarketplaceOrderCancellationResult>;
}
