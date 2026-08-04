import { normalizeUsPostalRegion } from "./us-geography";

const UNITED_STATES_COUNTRY_ALIASES = new Set([
  "US",
  "USA",
  "UNITED STATES",
  "UNITED STATES OF AMERICA",
]);

export interface ShippingDestinationInput {
  country: string;
  region?: string | null;
  postalCode?: string | null;
}

export interface CanonicalShippingDestination {
  country: "US";
  region: string | null;
  postalCode: string | null;
}

export type ShippingDestinationNormalizationResult =
  | {
      ok: true;
      destination: CanonicalShippingDestination;
    }
  | {
      ok: false;
      code:
        | "SHIPPING_DESTINATION_COUNTRY_UNSUPPORTED"
        | "SHIPPING_DESTINATION_REGION_INVALID";
      message: string;
    };

function normalizeCountryToken(country: string): string {
  return country.trim().toUpperCase().replace(/\./g, "");
}

function normalizeOptionalToken(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function normalizeShippingDestination(
  input: ShippingDestinationInput,
): ShippingDestinationNormalizationResult {
  const countryToken = normalizeCountryToken(input.country);
  if (!UNITED_STATES_COUNTRY_ALIASES.has(countryToken)) {
    return {
      ok: false,
      code: "SHIPPING_DESTINATION_COUNTRY_UNSUPPORTED",
      message: "Echelon does not own destination normalization for this country.",
    };
  }

  const rawRegion = normalizeOptionalToken(input.region);
  const region = rawRegion === null ? null : normalizeUsPostalRegion(rawRegion);
  if (rawRegion !== null && region === null) {
    return {
      ok: false,
      code: "SHIPPING_DESTINATION_REGION_INVALID",
      message: "The United States destination region is not recognized.",
    };
  }

  return {
    ok: true,
    destination: {
      country: "US",
      region,
      postalCode: normalizeOptionalToken(input.postalCode)?.toUpperCase() ?? null,
    },
  };
}
