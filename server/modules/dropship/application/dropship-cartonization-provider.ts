import type {
  DropshipCartonizedPackage,
  NormalizedDropshipShippingDestination,
  NormalizedDropshipShippingQuoteItem,
} from "../domain/shipping-quote";

export interface DropshipCartonizationRequest {
  vendorId: number;
  storeConnectionId: number;
  warehouseId: number;
  destination: NormalizedDropshipShippingDestination;
  items: readonly NormalizedDropshipShippingQuoteItem[];
  quotedAt: Date;
}

export interface DropshipCartonizationResult {
  packages: DropshipCartonizedPackage[];
  engine: {
    name: string;
    version: string;
  };
  warnings: string[];
}

export interface DropshipCartonizationProvider {
  cartonize(input: DropshipCartonizationRequest): Promise<DropshipCartonizationResult>;
}
