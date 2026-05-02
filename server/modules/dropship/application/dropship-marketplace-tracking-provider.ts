import type { DropshipSourcePlatform } from "../../../../shared/schema/dropship.schema";

export interface DropshipMarketplaceTrackingLineItem {
  externalLineItemId: string | null;
  quantity: number;
}

export interface DropshipMarketplaceTrackingRequest {
  intakeId: number;
  omsOrderId: number;
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  externalOrderId: string;
  externalOrderNumber: string | null;
  sourceOrderId: string | null;
  carrier: string;
  trackingNumber: string;
  shippedAt: Date;
  lineItems: DropshipMarketplaceTrackingLineItem[];
  idempotencyKey: string;
}

export interface DropshipMarketplaceTrackingResult {
  status: "succeeded";
  externalFulfillmentId: string | null;
  rawResult: Record<string, unknown>;
}

export interface DropshipMarketplaceTrackingProvider {
  pushTracking(
    input: DropshipMarketplaceTrackingRequest,
  ): Promise<DropshipMarketplaceTrackingResult>;
}
