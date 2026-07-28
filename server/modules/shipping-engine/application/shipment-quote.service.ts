import {
  getShippingChannelProfile,
  usesRuntimeShippingQuotes,
  type ShippingRatePurpose,
  type ShippingSalesChannel,
} from "../domain/shipping-channel";
import type {
  ShipmentLineInput,
  ShipmentParcelPlan,
} from "../domain/shipment";
import type { RateQuoteResult } from "./rate-quote.service";
import type { FreightRatingContext } from "./rate-quote.service";
import type { ShipmentParcelProvider } from "./shipment-parcel-provider";
import type { ShippingRateProvider } from "./shipping-rate-provider";

export interface ShipmentQuoteRequest {
  channel: ShippingSalesChannel;
  /** Exact assignment purpose. Runtime callers normally use the channel profile default. */
  ratePurpose?: ShippingRatePurpose;
  /** Exact pricing program selected by an active canonical channel policy. */
  rateBookId?: number;
  originWarehouseId: number;
  destination: {
    country: string;
    region?: string | null;
    postalCode: string;
  };
  lines: readonly ShipmentLineInput[];
  freight?: FreightRatingContext | null;
  quotedAt?: Date;
  /** Persist the engine quote snapshot. Used by authenticated operator tests. */
  persistSnapshot?: boolean;
}

export interface ShipmentQuoteDependencies {
  parcelProvider: ShipmentParcelProvider;
  rateProvider: ShippingRateProvider;
}

export type ShipmentQuoteResult =
  | {
      ok: true;
      parcelPlan: ShipmentParcelPlan;
      rates: RateQuoteResult;
    }
  | {
      ok: false;
      code: "CHANNEL_POLICY_MANAGED" | "INVALID_SHIPMENT";
      errors: string[];
    };

/**
 * Channel-neutral runtime quote orchestration. Channel adapters own request
 * parsing and response presentation; this service owns parcel and rate ports.
 */
export async function quoteShipment(
  request: ShipmentQuoteRequest,
  deps: ShipmentQuoteDependencies,
): Promise<ShipmentQuoteResult> {
  const profile = getShippingChannelProfile(request.channel);
  if (!usesRuntimeShippingQuotes(request.channel)) {
    return {
      ok: false,
      code: "CHANNEL_POLICY_MANAGED",
      errors: [
        `${request.channel} shipping is ${profile.quoteMode} and must be handled by ${profile.configurationOwner}`,
      ],
    };
  }

  const parcelResult = await deps.parcelProvider.plan(request.lines);
  if (!parcelResult.ok) {
    return { ok: false, code: "INVALID_SHIPMENT", errors: parcelResult.errors };
  }

  const rates = await deps.rateProvider.quote({
    rateContext: {
      pricingChannel: request.channel,
      purpose: request.ratePurpose ?? profile.ratePurpose,
    },
    rateBookId: request.rateBookId,
    originWarehouseId: request.originWarehouseId,
    destination: request.destination,
    rateSelectionWeightGrams: parcelResult.plan.rateSelectionWeightGrams,
    parcels: parcelResult.plan.parcels,
    lines: request.lines,
    freight: request.freight,
    quotedAt: request.quotedAt,
    persistSnapshot: request.persistSnapshot,
  });

  return { ok: true, parcelPlan: parcelResult.plan, rates };
}
