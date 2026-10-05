import type { ReturnLabelAddress } from "../application/return-label-provider.port";
import type { ShippingAddressType } from "@shared/shipping/address-type";

const RESIDENTIAL_INDICATORS = {
  commercial: "no",
  residential: "yes",
  unknown: "unknown",
} as const satisfies Record<ShippingAddressType, string>;

/** Quotes and purchases must classify the same physical return route. */
export function shipStationReturnAddress(address: ReturnLabelAddress) {
  return {
    name: address.name,
    phone: address.phone,
    company_name: address.companyName,
    address_line1: address.addressLine1,
    address_line2: address.addressLine2,
    address_line3: address.addressLine3,
    city_locality: address.city,
    state_province: address.state,
    postal_code: address.postalCode,
    country_code: address.countryCode,
    // Shopify shipping addresses do not supply this classification. Do not
    // infer a residential origin from a person's name or a missing company.
    address_residential_indicator: RESIDENTIAL_INDICATORS[address.addressType ?? "unknown"],
  };
}
