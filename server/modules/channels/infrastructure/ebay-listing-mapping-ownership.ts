import type { Pool, PoolClient } from "pg";
import { ebayListingSyncIdentitySchema, EbayListingSyncError, type EbayListingSyncIdentity } from "../ebay-listing-sync.domain";

/** Shared local identity check. Mutation callers hold the short listing-table
 * lock so another mapping cannot appear between this read and their commit. */
export async function assertEbayMappingOwnership(input: EbayListingSyncIdentity, client: Pick<Pool, "query"> | PoolClient): Promise<void> {
  const identity = ebayListingSyncIdentitySchema.parse(input);
  const rows = (await client.query(`SELECT product_variant_id,external_sku,external_variant_id,external_product_id FROM channels.channel_listings
    WHERE channel_id=$1 AND (external_sku=ANY($2::text[]) OR external_variant_id=ANY($3::text[]) OR external_product_id=ANY($4::text[]))
    ORDER BY product_variant_id`, [identity.channelId,identity.variants.map(member => member.sku),
    identity.variants.map(member => member.offerId),identity.variants.map(member => member.listingId)])).rows;
  const owned = new Set(identity.variants.map(member => member.variantId));
  const conflicts = rows.filter(row => !owned.has(row.product_variant_id) || identity.variants.some(member => member.variantId !== row.product_variant_id
    && (member.sku === row.external_sku || (member.offerId !== null && member.offerId === row.external_variant_id))));
  if (conflicts.length) {
    const details = conflicts.slice(0,5).map(row => `variant ${row.product_variant_id ?? "unassigned"}${row.external_sku ? ` (eBay SKU ${row.external_sku})` : ""}`).join(", ");
    throw new EbayListingSyncError("EBAY_MAPPING_OWNERSHIP_CONFLICT", `The observed eBay identifiers are already mapped to ${details}. Review both mappings before saving this listing.`);
  }
}
