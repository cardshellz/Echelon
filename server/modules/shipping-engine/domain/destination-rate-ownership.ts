/**
 * Destination ownership for the Card Shellz Shopify checkout.
 *
 * Echelon owns United States customer-facing rates. Shopify/Global-e owns
 * every valid non-US destination until an explicit country is migrated to an
 * Echelon rate program. This wildcard delegation is deliberate: a country
 * enabled in Shopify must not also require a duplicate Echelon allowlist row.
 */

export const ECHELON_MANAGED_COUNTRY_CODE = "US";

export type ShopifyCheckoutRateOwner = "echelon" | "shopify";

export type ShopifyCheckoutRateOwnership =
  | {
      ok: true;
      countryCode: string;
      owner: ShopifyCheckoutRateOwner;
      reasonCode: "US_ECHELON_MANAGED" | "NON_US_SHOPIFY_MANAGED";
    }
  | {
      ok: false;
      countryCode: string;
      reasonCode: "INVALID_DESTINATION_COUNTRY";
      message: string;
    };

export function resolveShopifyCheckoutRateOwnership(
  destinationCountry: string,
): ShopifyCheckoutRateOwnership {
  const countryCode = destinationCountry.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return {
      ok: false,
      countryCode,
      reasonCode: "INVALID_DESTINATION_COUNTRY",
      message: "Destination country must be a two-letter ISO country code.",
    };
  }

  if (countryCode === ECHELON_MANAGED_COUNTRY_CODE) {
    return {
      ok: true,
      countryCode,
      owner: "echelon",
      reasonCode: "US_ECHELON_MANAGED",
    };
  }

  return {
    ok: true,
    countryCode,
    owner: "shopify",
    reasonCode: "NON_US_SHOPIFY_MANAGED",
  };
}
