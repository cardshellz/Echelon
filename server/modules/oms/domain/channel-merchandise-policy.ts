/** Shopify supplies versioned current merchandise quantities independently of
 * payment settlement. Other providers retain their existing quantity adapters. */
export const CHANNEL_MERCHANDISE_PROVIDER = "shopify";

export function usesChannelMerchandiseQuantities(
  provider: string | null | undefined,
): boolean {
  return provider === CHANNEL_MERCHANDISE_PROVIDER;
}
