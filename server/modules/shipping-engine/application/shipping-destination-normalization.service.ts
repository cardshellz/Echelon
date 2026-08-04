import {
  normalizeShippingDestination,
  type ShippingDestinationInput,
  type ShippingDestinationNormalizationResult,
} from "../domain/shipping-destination-normalization";

export class ShippingDestinationNormalizationService {
  normalize(
    input: ShippingDestinationInput,
  ): ShippingDestinationNormalizationResult {
    return normalizeShippingDestination(input);
  }
}
