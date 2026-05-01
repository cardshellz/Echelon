import type {
  DropshipCartonizedPackage,
  NormalizedDropshipShippingDestination,
} from "../domain/shipping-quote";

export interface DropshipShippingZoneMatch {
  zone: string;
  zoneRuleId: number;
}

export interface DropshipShippingRateMatch {
  packageSequence: number;
  rateTableId: number;
  carrier: string;
  service: string;
  currency: string;
  rateCents: number;
}

export interface DropshipShippingRateRequest {
  vendorId: number;
  storeConnectionId: number;
  warehouseId: number;
  destination: NormalizedDropshipShippingDestination;
  packages: readonly DropshipCartonizedPackage[];
  quotedAt: Date;
}

export interface DropshipShippingRateResult {
  zone: DropshipShippingZoneMatch;
  rates: DropshipShippingRateMatch[];
  provider: {
    name: string;
    version: string;
  };
}

export interface DropshipShippingRateProvider {
  quoteRates(input: DropshipShippingRateRequest): Promise<DropshipShippingRateResult>;
}
