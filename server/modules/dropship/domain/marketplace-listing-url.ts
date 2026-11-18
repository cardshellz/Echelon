/** Where the store's marketplace account lives; eBay's sandbox is a test site with its own item pages. */
export type MarketplaceEnvironment = "sandbox" | "production";

/**
 * Only an eBay item id forms a public page a vendor can open; other platforms
 * keep the id alone. A sandbox listing lives on eBay's test site, where the
 * production page would say the item cannot be found.
 */
export function marketplaceListingUrl(
  platform: string,
  externalListingId: string | null,
  environment: MarketplaceEnvironment | null,
): string | null {
  if (externalListingId === null) return null;
  if (platform !== "ebay" || !/^\d{6,20}$/.test(externalListingId)) return null;
  const host = environment === "sandbox" ? "sandbox.ebay.com" : "www.ebay.com";
  return `https://${host}/itm/${externalListingId}`;
}

/** The store's recorded environment; anything else reads as unknown rather than guessed. */
export function parseMarketplaceEnvironment(value: unknown): MarketplaceEnvironment | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "sandbox" || normalized === "production" ? normalized : null;
}
