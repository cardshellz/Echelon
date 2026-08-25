import { DropshipError } from "../domain/errors";

/**
 * eBay's legacy Post-Order API requires the IAF authorization scheme even
 * when the credential itself is an OAuth user access token. This differs
 * from eBay REST APIs that use the Bearer scheme.
 */
export function buildEbayPostOrderAuthorization(accessToken: string): string {
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_ACCESS_TOKEN_REQUIRED",
      "An eBay access token is required for a Post-Order API request.",
      { retryable: false },
    );
  }

  return `IAF ${accessToken}`;
}
