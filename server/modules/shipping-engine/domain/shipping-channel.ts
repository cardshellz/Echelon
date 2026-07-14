export const SHIPPING_CHANNEL_PROFILES = {
  shopify: {
    quoteMode: "runtime_quote",
    configurationOwner: "shipping_engine",
    benefitOwner: "platform_discount",
    ratePurpose: "customer_checkout",
  },
  internal: {
    quoteMode: "runtime_quote",
    configurationOwner: "shipping_engine",
    benefitOwner: "shipping_engine",
    ratePurpose: "customer_checkout",
  },
  ebay: {
    quoteMode: "external_policy",
    configurationOwner: "channel_adapter",
    benefitOwner: "channel_policy",
    ratePurpose: "customer_checkout",
  },
  dropship: {
    quoteMode: "runtime_quote",
    configurationOwner: "dropship_portal",
    benefitOwner: "channel_policy",
    ratePurpose: "vendor_fulfillment_charge",
  },
} as const;

export type ShippingSalesChannel = keyof typeof SHIPPING_CHANNEL_PROFILES;
export type ShippingQuoteMode =
  (typeof SHIPPING_CHANNEL_PROFILES)[ShippingSalesChannel]["quoteMode"];
export type ShippingRatePurpose =
  (typeof SHIPPING_CHANNEL_PROFILES)[ShippingSalesChannel]["ratePurpose"];

export function getShippingChannelProfile(channel: ShippingSalesChannel) {
  return SHIPPING_CHANNEL_PROFILES[channel];
}

export function usesRuntimeShippingQuotes(channel: ShippingSalesChannel): boolean {
  return SHIPPING_CHANNEL_PROFILES[channel].quoteMode === "runtime_quote";
}
