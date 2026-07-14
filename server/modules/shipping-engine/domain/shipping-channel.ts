export const SHIPPING_CHANNEL_PROFILES = {
  shopify: {
    quoteMode: "runtime_quote",
    configurationOwner: "shipping_engine",
    benefitOwner: "platform_discount",
  },
  internal: {
    quoteMode: "runtime_quote",
    configurationOwner: "shipping_engine",
    benefitOwner: "shipping_engine",
  },
  ebay: {
    quoteMode: "external_policy",
    configurationOwner: "channel_adapter",
    benefitOwner: "channel_policy",
  },
  dropship: {
    quoteMode: "managed_policy",
    configurationOwner: "dropship_portal",
    benefitOwner: "channel_policy",
  },
} as const;

export type ShippingSalesChannel = keyof typeof SHIPPING_CHANNEL_PROFILES;
export type ShippingQuoteMode =
  (typeof SHIPPING_CHANNEL_PROFILES)[ShippingSalesChannel]["quoteMode"];

export function getShippingChannelProfile(channel: ShippingSalesChannel) {
  return SHIPPING_CHANNEL_PROFILES[channel];
}

export function usesRuntimeShippingQuotes(channel: ShippingSalesChannel): boolean {
  return SHIPPING_CHANNEL_PROFILES[channel].quoteMode === "runtime_quote";
}
