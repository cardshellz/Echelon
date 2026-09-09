import type {
  DropshipCartonizedPackage,
  DropshipPackagingWarning,
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
  /** Internal evidence identifies the shared suite and exact box specifications. */
  packaging?: { suiteId: number; suiteRevision: number; assignmentRevision: number; boxes: unknown[] };
  packages: DropshipCartonizedPackage[];
  engine: {
    name: string;
    version: string;
  };
  warnings: string[];
  /** Structured packaging degradation signals; persisted on the quote snapshot. */
  packagingWarnings: DropshipPackagingWarning[];
}

export interface DropshipCartonizationProvider {
  cartonize(input: DropshipCartonizationRequest): Promise<DropshipCartonizationResult>;
}
