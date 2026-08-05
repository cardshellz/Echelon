import type {
  ProductRateTraceStep,
} from "../../shipping-engine/domain/product-rate-policy";
import type {
  ShippingFulfillmentMode,
  ShippingPricingBasis,
  ShippingRateChargeModel,
} from "../../shipping-engine/domain/rate-selection";
import type {
  NormalizedDropshipShippingDestination,
} from "../domain/shipping-quote";

export interface DropshipSharedShippingQuoteRequest {
  vendorId: number;
  storeConnectionId: number;
  warehouseId: number;
  destination: NormalizedDropshipShippingDestination;
  items: Array<{
    productVariantId: number;
    quantity: number;
  }>;
  packages: Array<{
    packageSequence: number;
    items: Array<{
      productVariantId: number;
      quantity: number;
    }>;
    /** Null on weight-only degraded packages (packaging data incomplete). */
    boxId: number | null;
    boxCode: string | null;
    weightGrams: number;
    lengthMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
  }>;
  cartonizationProvider: {
    name: string;
    version: string;
  };
  quotedAt: Date;
}

export interface DropshipSharedShippingSelectedRate {
  serviceLevelId: number;
  serviceLevelCode: string;
  displayName: string;
  description: string | null;
  fulfillmentMode: ShippingFulfillmentMode;
  pricingBasis: ShippingPricingBasis;
  totalCents: number;
  currency: string;
  promiseMinBusinessDays: number | null;
  promiseMaxBusinessDays: number | null;
  ratedMeasure: number;
  maxShipmentWeightGrams: number | null;
  chargeModel: ShippingRateChargeModel;
  perStartedPoundCents: number | null;
  billablePounds: number | null;
  rateTableId: number;
  productPolicyApplied: boolean;
  calculationTrace: ProductRateTraceStep[];
}

export type DropshipSharedShippingQuoteResult =
  | {
      status: "quoted";
      baseRateCents: number;
      currency: string;
      serviceLevelCode: string;
      rateBookId: number;
      rateBookCode: string;
      rateTableId: number;
      resolvedZone: string | null;
      ratedWeightGrams: number;
      rateProvider: {
        name: string;
        version: string;
      };
      selectedRate: DropshipSharedShippingSelectedRate;
      warnings: string[];
      routing: Record<string, unknown>;
    }
  | {
      status: "unavailable";
      code: string;
      message: string;
      warnings: string[];
      routing: Record<string, unknown> | null;
    };

export interface DropshipSharedShippingQuoteProvider {
  quote(
    input: DropshipSharedShippingQuoteRequest,
  ): Promise<DropshipSharedShippingQuoteResult>;
}
