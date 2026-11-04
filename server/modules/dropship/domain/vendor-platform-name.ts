/**
 * The marketplace's name as a vendor reads it in an alert or email ("eBay",
 * not the stored code "ebay"). Words only: never use it as a key, a code or
 * anything that is stored, compared or hashed for idempotency.
 */
const VENDOR_PLATFORM_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ebay: "eBay",
  shopify: "Shopify",
});

export function vendorPlatformName(platform: string | null | undefined): string {
  if (platform && Object.hasOwn(VENDOR_PLATFORM_NAMES, platform)) return VENDOR_PLATFORM_NAMES[platform];
  return "marketplace";
}
