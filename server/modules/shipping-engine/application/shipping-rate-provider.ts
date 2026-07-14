import type { ShippingParcelSpec } from "../domain/shipment";
import {
  quoteParcels,
  RATE_QUOTE_ENGINE,
  type RateQuoteResult,
} from "./rate-quote.service";

export interface ShippingRateProviderRequest {
  originWarehouseId: number;
  destination: {
    country: string;
    postalCode: string;
  };
  parcels: readonly ShippingParcelSpec[];
  quotedAt?: Date;
  persistSnapshot?: boolean;
}

export interface ShippingRateProvider {
  readonly provider: {
    name: string;
    version: string;
  };
  quote(input: ShippingRateProviderRequest): Promise<RateQuoteResult>;
}

/** Local deterministic zone-and-weight tables used in the checkout hot path. */
export const localRateTableShippingRateProvider: ShippingRateProvider = {
  provider: RATE_QUOTE_ENGINE,
  quote(input) {
    return quoteParcels({
      originWarehouseId: input.originWarehouseId,
      destCountry: input.destination.country,
      destPostal: input.destination.postalCode,
      parcels: input.parcels.map((parcel) => ({
        billableWeightGrams: parcel.billableWeightGrams,
      })),
    }, {
      quotedAt: input.quotedAt,
      persistSnapshot: input.persistSnapshot,
    });
  },
};
