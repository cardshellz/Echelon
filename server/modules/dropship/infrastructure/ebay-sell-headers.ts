/**
 * Request headers for eBay's Sell APIs, as the channel eBay client sends them
 * (channels/adapters/ebay/ebay-api.client.ts): Accept-Language on every call
 * and Content-Language on every write. eBay refuses a call that lacks one of
 * them with 25709 "Invalid value for header <name>"; the channel client notes
 * this for Content-Language, and a vendor's first listing push met it for
 * Accept-Language, which the dropship callers had left out.
 *
 * en-US is the only locale the app sends today (the channel client fixes it,
 * and dropship's Content-Language already did). Listing on a marketplace in
 * another language would need a locale per marketplace here.
 */
export const EBAY_SELL_LOCALE = "en-US";

export type EbaySellHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export function ebaySellRequestHeaders(input: {
  accessToken: string;
  method: EbaySellHttpMethod;
  /** Sent as X-EBAY-C-MARKETPLACE-ID when the call is marketplace-scoped. */
  marketplaceId?: string | null;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${input.accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Language": EBAY_SELL_LOCALE,
    ...(input.method === "GET" ? {} : { "Content-Language": EBAY_SELL_LOCALE }),
    ...(input.marketplaceId ? { "X-EBAY-C-MARKETPLACE-ID": input.marketplaceId } : {}),
  };
}
