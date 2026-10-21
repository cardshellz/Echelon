/**
 * The two refusals the eBay adoption reader raises under one code
 * (server/modules/dropship/infrastructure/dropship-ebay-push-publication.reader.ts).
 * The code is what ops and tests key on; the message tells them apart:
 * - the account check: this store has no verified eBay identity, so a listing
 *   already published under its SKU cannot be linked (reconnecting the store
 *   fixes it);
 * - the environment check: the published listing belongs to the other eBay
 *   environment (sandbox or production) than the store's connection.
 * Shared so the vendor's words (client) and the one-time recovery of pushes
 * the earlier account check refused (server) match the exact server text.
 */
export const EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE = "DROPSHIP_EBAY_PUBLICATION_ACCOUNT_UNVERIFIED" as const;

export const EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE =
  "The published offer cannot be adopted without this store's verified eBay account. Reconnect the intended store account.";

export const EBAY_PUBLICATION_ENVIRONMENT_MISMATCH_MESSAGE =
  "The observed listing belongs to a different eBay environment than the authorized store connection.";
