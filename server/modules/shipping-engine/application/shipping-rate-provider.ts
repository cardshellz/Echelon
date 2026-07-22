import type { ShippingParcelSpec } from "../domain/shipment";
import type { ShipmentLineInput } from "../domain/shipment";
import type { ShippingRateContext } from "../domain/shipping-channel";
import {
  quoteShipmentRates,
  RATE_QUOTE_ENGINE,
  type FreightRatingContext,
  type RateQuoteResult,
} from "./rate-quote.service";

export interface ShippingRateProviderRequest {
  /** Selects a rate book; it does not imply that channels share prices. */
  rateContext: ShippingRateContext;
  originWarehouseId: number;
  destination: {
    country: string;
    region?: string | null;
    postalCode: string;
  };
  parcels: readonly ShippingParcelSpec[];
  lines?: readonly ShipmentLineInput[];
  freight?: FreightRatingContext | null;
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
    return quoteShipmentRates({
      rateContext: input.rateContext,
      originWarehouseId: input.originWarehouseId,
      destCountry: input.destination.country,
      destRegion: input.destination.region,
      destPostal: input.destination.postalCode,
      parcels: input.parcels.map((parcel) => ({
        billableWeightGrams: parcel.billableWeightGrams,
      })),
      lines: input.lines,
      freight: input.freight,
    }, {
      quotedAt: input.quotedAt,
      persistSnapshot: input.persistSnapshot,
    });
  },
};
