/**
 * Pure transformation helpers for the channel-listings read endpoint.
 *
 * Kept separate from the route so we can unit-test the per-row mapping
 * (status synthesis, GID parsing, admin URL construction) without spinning
 * up Express or the DB.
 */

export type ChannelListingRowInput = {
  listingId: number;
  channelId: number;
  channelName: string | null;
  channelProvider: string | null;
  shopDomain: string | null;
  productVariantId: number | null;
  variantSku: string | null;
  // `variantIsActive` reflects productVariants.is_active. When false the
  // variant has been archived; the listing is therefore stale even if
  // sync_status still says 'synced'. See deriveListingStatus.
  variantIsActive: boolean;
  externalProductId: string | null;
  externalVariantId: string | null;
  externalUrl: string | null;
  syncStatus: string | null;
  syncError: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  lastSyncedAt: Date | string | null;
};

export type ChannelListingDto = {
  listingId: number;
  variantId: number | null;
  variantSku: string | null;
  channelId: number;
  channelName: string | null;
  channelProvider: string | null;
  shopDomain: string | null;
  externalListingId: string | null;
  externalListingIdNumeric: string | null;
  externalProductId: string | null;
  status: "active" | "archived" | "pending" | "error";
  syncStatus: string | null;
  syncError: string | null;
  listedSince: Date | string | null;
  lastSynced: Date | string | null;
  adminUrl: string | null;
};

/**
 * Extract the trailing numeric portion from a Shopify GID
 * (e.g. "gid://shopify/ProductVariant/62783080038559" -> "62783080038559").
 * Falls through to identity for already-numeric strings, returns null otherwise.
 */
export function extractNumericId(value: string | null | undefined): string | null {
  if (!value) return null;
  // Match any trailing /<digits> optionally followed by query string.
  const gidMatch = value.match(/\/(\d+)(?:\?|$)/);
  if (gidMatch) return gidMatch[1];
  if (/^\d+$/.test(value)) return value;
  return null;
}

/**
 * Synthesize a user-facing listing status from the raw sync_status column,
 * the variant's archive flag, and presence of an external id. The schema
 * does not store a true "listing status" so we compose one here:
 *   - "archived": the underlying product variant has been archived
 *                 (productVariants.is_active = false). Takes precedence
 *                 over every other state because the listing should not
 *                 be sold even if sync_status still reads 'synced'.
 *   - "error"   : last sync explicitly failed
 *   - "active"  : we have an external variant id AND sync isn't pending
 *   - "pending" : queued, never pushed, or no external id yet
 */
export function deriveListingStatus(input: {
  syncStatus: string | null | undefined;
  externalVariantId: string | null | undefined;
  variantIsActive: boolean;
}): "active" | "archived" | "pending" | "error" {
  // Archived takes precedence — once a variant is deactivated, the
  // listing is effectively archived even if sync_status still says 'synced'.
  if (input.variantIsActive === false) return "archived";

  if (input.syncStatus === "error") return "error";
  if (input.externalVariantId && input.syncStatus !== "pending") return "active";
  return "pending";
}

/**
 * Build a deep-link to the channel admin UI for a single listing.
 * Returns null when we don't know how to construct one for the provider;
 * the UI is expected to hide the "Open" link in that case.
 *
 * Supported:
 *   - shopify : admin variant page, requires shopDomain + numeric product + numeric variant
 *   - other   : fall back to externalUrl if the adapter populated one
 */
export function buildAdminUrl(args: {
  channelProvider: string | null | undefined;
  shopDomain: string | null | undefined;
  externalProductIdNumeric: string | null;
  externalListingIdNumeric: string | null;
  externalUrl: string | null | undefined;
}): string | null {
  const { channelProvider, shopDomain, externalProductIdNumeric, externalListingIdNumeric, externalUrl } = args;

  if (
    channelProvider === "shopify" &&
    shopDomain &&
    externalProductIdNumeric &&
    externalListingIdNumeric
  ) {
    // shop_domain is stored like "card-shellz.myshopify.com"; the admin
    // URL path uses only the store handle ("card-shellz").
    const storeHandle = shopDomain.replace(/\.myshopify\.com$/i, "");
    return `https://admin.shopify.com/store/${storeHandle}/products/${externalProductIdNumeric}/variants/${externalListingIdNumeric}`;
  }

  // For unsupported providers (eBay variant-level deep-links don't exist in a
  // stable way, etc.), fall back to whatever the adapter recorded.
  return externalUrl ?? null;
}

/** Map a raw DB row to the public DTO returned by the route. */
export function rowToListingDto(row: ChannelListingRowInput): ChannelListingDto {
  const externalListingId = row.externalVariantId ?? null;
  const externalListingIdNumeric = extractNumericId(externalListingId);
  const externalProductId = row.externalProductId ?? null;
  const externalProductIdNumeric = extractNumericId(externalProductId);
  const status = deriveListingStatus({
    syncStatus: row.syncStatus,
    externalVariantId: externalListingId,
    variantIsActive: row.variantIsActive,
  });
  const adminUrl = buildAdminUrl({
    channelProvider: row.channelProvider,
    shopDomain: row.shopDomain,
    externalProductIdNumeric,
    externalListingIdNumeric,
    externalUrl: row.externalUrl,
  });

  return {
    listingId: row.listingId,
    variantId: row.productVariantId,
    variantSku: row.variantSku ?? null,
    channelId: row.channelId,
    channelName: row.channelName,
    channelProvider: row.channelProvider,
    shopDomain: row.shopDomain ?? null,
    externalListingId,
    externalListingIdNumeric,
    externalProductId,
    status,
    syncStatus: row.syncStatus ?? null,
    syncError: row.syncError ?? null,
    listedSince: row.createdAt,
    lastSynced: row.lastSyncedAt,
    adminUrl,
  };
}
