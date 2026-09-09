import { listingShippingEstimateInputSchema, listingShippingEstimateResponseSchema,
  type ListingShippingEstimateInput, type ListingShippingEstimateResult } from "@shared/dropship/listing-shipping-estimate";

export type ListingShippingScenarioFields = { quantity: string; country: string; region: string; postalCode: string };

export function buildListingShippingEstimateRequest(storeConnectionId: number, productVariantId: number, fields: ListingShippingScenarioFields): ListingShippingEstimateInput {
  if (!/^\d+$/.test(fields.quantity)) throw new Error("Enter a whole-number purchase quantity.");
  if (!/^[A-Za-z]{2}$/.test(fields.region.trim())) throw new Error("Enter a two-letter state or region code, such as PA.");
  const parsed = listingShippingEstimateInputSchema.safeParse({ storeConnectionId, productVariantId,
    quantity: Number(fields.quantity), destination: { country: fields.country.trim().toUpperCase(),
      postalCode: fields.postalCode.trim(), region: fields.region.trim().toUpperCase() } });
  if (!parsed.success) throw new Error("Enter a valid quantity, two-letter country code, and postal code.");
  return parsed.data;
}

export function readListingShippingEstimateResponse(value: unknown, request: ListingShippingEstimateInput): ListingShippingEstimateResult {
  const parsed = listingShippingEstimateResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("The shipping estimate response was invalid. Please try again.");
  const estimate = parsed.data.estimate;
  const normalized = (part: string) => part.replace(/\s/g, "").toUpperCase();
  if (estimate.storeConnectionId !== request.storeConnectionId || estimate.productVariantId !== request.productVariantId
    || estimate.quantity !== request.quantity || estimate.destination.country !== request.destination.country.toUpperCase()
    || normalized(estimate.destination.postalCode) !== normalized(request.destination.postalCode)
    || (request.destination.region && normalized(estimate.destination.region ?? "") !== normalized(request.destination.region))) {
    throw new Error("The estimate did not match this listing and destination. Please try again.");
  }
  // The server validates integer-cent arithmetic. Customers receive the final
  // charge, not internal inputs with which to reconstruct our pricing rules.
  return estimate;
}
