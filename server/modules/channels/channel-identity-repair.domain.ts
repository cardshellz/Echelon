import { createHash } from "node:crypto";
import type { ChannelFeed, ChannelListing } from "@shared/schema";
import type { ShopifyVariantIdentity } from "./adapters/shopify-identity.reader";
import { isInventoryManagedVariant } from "@shared/catalog/variant-inventory-eligibility";
import { isCustomerSellableVariant } from "@shared/catalog/variant-sales-eligibility";

/** JSONB does not preserve object key order; receipt comparisons must not depend on it. */
export function identityFingerprint(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, entry: unknown) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right, "en")));
    }
    return entry;
  });
  return createHash("sha256").update(canonical).digest("hex");
}
export type RepairCatalogIdentity = { id: number; sku: string | null; requiresShipping: boolean; trackInventory: boolean | null; salesEligibility: "sellable" | "internal_only" };
export type IdentityRepairScope = { channelId: number; connectionId: number; externalAccountId: string };
export type IdentityRepairAction = "repair" | "disable" | "unchanged" | "blocked";

export function feedIdentitySnapshot(feed: ChannelFeed) {
  return { id: feed.id, channelId: feed.channelId, productVariantId: feed.productVariantId,
    channelVariantId: feed.channelVariantId, channelProductId: feed.channelProductId, channelSku: feed.channelSku,
    channelInventoryItemId: feed.channelInventoryItemId, isActive: feed.isActive,
    quarantinedAt: feed.quarantinedAt?.toISOString() ?? null, quarantineReason: feed.quarantineReason,
    updatedAt: feed.updatedAt.toISOString() };
}
export function listingIdentitySnapshot(listing: ChannelListing | undefined) {
  return listing ? { id: listing.id, channelId: listing.channelId, productVariantId: listing.productVariantId,
    externalVariantId: listing.externalVariantId, externalProductId: listing.externalProductId, externalSku: listing.externalSku,
    syncStatus: listing.syncStatus, syncError: listing.syncError, updatedAt: listing.updatedAt.toISOString() } : null;
}

export function planChannelIdentityRepair(input: {
  scope: IdentityRepairScope; feed: ChannelFeed; listing?: ChannelListing;
  catalog: RepairCatalogIdentity | null; evidence: ShopifyVariantIdentity | null; readErrorCode?: string;
}) {
  let action: IdentityRepairAction = "blocked";
  let code = input.readErrorCode ?? "CHANNEL_IDENTITY_REVIEW_REQUIRED";
  const { feed, listing, catalog, evidence } = input;
  if (catalog && input.readErrorCode === "SHOPIFY_IDENTITY_NOT_FOUND") {
    action = feed.isActive === 0 && listing?.syncStatus === "requires_review" ? "unchanged" : "disable";
    code = "DESTINATION_VARIANT_MISSING";
  } else if (catalog && evidence && !input.readErrorCode) {
    if (evidence.sku !== catalog.sku || !catalog.sku) code = "DESTINATION_SKU_MISMATCH";
    else if (!isInventoryManagedVariant(catalog) || !isCustomerSellableVariant(catalog)) code = "CATALOG_VARIANT_INELIGIBLE";
    else if (feed.quarantinedAt) code = "QUARANTINED_MAPPING_REQUIRES_REVIEW";
    else if (listing?.syncStatus === "requires_review") code = "LISTING_REQUIRES_REVIEW";
    else if (listing?.externalVariantId && listing.externalVariantId !== evidence.id) code = "FEED_LISTING_IDENTITY_CONFLICT";
    else {
      const consistent = feed.channelInventoryItemId === evidence.inventory_item_id && feed.channelProductId === evidence.product_id
        && feed.channelSku === evidence.sku && listing?.externalProductId === evidence.product_id
        && listing.externalVariantId === evidence.id && listing.externalSku === evidence.sku;
      action = consistent ? "unchanged" : "repair";
      code = consistent ? "MAPPING_VERIFIED" : "VERIFIED_MAPPING_REPAIR";
    }
  }
  const plan = { scope: input.scope, feedId: feed.id, productVariantId: feed.productVariantId, action, code,
    before: feedIdentitySnapshot(feed), listingBefore: listingIdentitySnapshot(listing), catalog, evidence };
  return { ...plan, expectedHash: identityFingerprint(plan) };
}
export type ChannelIdentityRepairPlan = ReturnType<typeof planChannelIdentityRepair>;
