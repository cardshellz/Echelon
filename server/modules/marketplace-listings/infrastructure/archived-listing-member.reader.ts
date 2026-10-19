import { z } from "zod";
import { listingMemberIdentitySchema, type ListingMemberIdentity } from "@shared/types/listing-member-lifecycle";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import { ListingMemberLifecycleError } from "../domain/listing-member-lifecycle";
import { canonicalJson } from "@shared/utils/canonical-json";

const scopeSchema = z.object({
  destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
  connectionId: z.number().int().positive(), provider: z.string().min(1), accountId: z.string().min(1),
  environment: z.enum(["production", "sandbox"]), market: z.string().min(1), externalSku: z.string().min(1),
}).strict();
export type ArchivedListingMemberScope = z.infer<typeof scopeSchema>;
export interface ArchivedListingMemberSource { identity: ListingMemberIdentity; sourceRevision: string }

/** Current Catalog archival and retained provider identity, never an ATP mapping
 * or a retirement-success claim. Callers revalidate this revision at admission. */
export async function readArchivedListingMember(client: StockSelectionQueryClient,
  raw: ArchivedListingMemberScope): Promise<ArchivedListingMemberSource | null> {
  const scope = scopeSchema.parse(raw);
  const rows = (await client.query<{ identity: unknown; source_revision: string }>(
    `SELECT identity,source_revision FROM marketplace.listing_member_retirement_sources
     WHERE identity->>'destinationKind'=$1 AND identity->>'connectionId'=$2
       AND identity->>'provider'=$3 AND identity->>'accountId'=$4
       AND identity->>'environment'=$5 AND identity->>'market'=$6 AND identity->>'externalSku'=$7
     LIMIT 2`, [scope.destinationKind, String(scope.connectionId), scope.provider, scope.accountId,
      scope.environment, scope.market, scope.externalSku])).rows;
  if (!rows.length) return null;
  if (rows.length !== 1) throw new ListingMemberLifecycleError("LISTING_MEMBER_IDENTITY_CONFLICT",
    "Multiple archived catalog members claim this exact provider SKU. Repair their saved listing links.");
  const identity = listingMemberIdentitySchema.parse(rows[0].identity);
  if (identity.identityConflict) throw new ListingMemberLifecycleError("LISTING_MEMBER_IDENTITY_CONFLICT",
    "Conflicting saved identities prevent preserving this archived group member.");
  return { identity, sourceRevision: z.string().min(1).parse(rows[0].source_revision) };
}

/** Caller holds one transaction for the admitted provider operation. NOWAIT
 * avoids reversing a lifecycle worker's Catalog -> provider-scope lock order. */
export async function lockArchivedListingMember(client: StockSelectionQueryClient, scope: ArchivedListingMemberScope,
  expected: ArchivedListingMemberSource): Promise<void> {
  const identity = expected.identity;
  await client.query("SELECT id FROM catalog.products WHERE id=$1 FOR SHARE NOWAIT", [identity.productId]);
  await client.query("SELECT id FROM catalog.product_variants WHERE id=$1 AND product_id=$2 FOR UPDATE NOWAIT",
    [identity.productVariantId, identity.productId]);
  if (identity.destinationKind === "channel_connection") {
    await client.query("SELECT id FROM channels.channel_connections WHERE id=$1 AND channel_id=$2 FOR SHARE NOWAIT",
      [identity.connectionId, identity.channelId]);
    await client.query("SELECT channel_id FROM ebay.ebay_oauth_tokens WHERE channel_id=$1 AND environment=$2 FOR SHARE NOWAIT",
      [identity.channelId, identity.environment]);
    await client.query("SELECT product_variant_id FROM channels.channel_listings WHERE channel_id=$1 AND product_variant_id=$2 FOR SHARE NOWAIT",
      [identity.channelId, identity.productVariantId]);
    await client.query("SELECT product_variant_id FROM channels.channel_feeds WHERE channel_id=$1 AND product_variant_id=$2 FOR SHARE NOWAIT",
      [identity.channelId, identity.productVariantId]);
  } else {
    await client.query("SELECT id FROM dropship.dropship_store_connections WHERE id=$1 AND vendor_id=$2 FOR SHARE NOWAIT",
      [identity.connectionId, identity.vendorId]);
    await client.query(`SELECT id FROM dropship.dropship_vendor_listings
      WHERE vendor_id=$1 AND store_connection_id=$2 AND product_variant_id=$3 FOR SHARE NOWAIT`,
    [identity.vendorId, identity.connectionId, identity.productVariantId]);
  }
  if (canonicalJson(await readArchivedListingMember(client, scope)) !== canonicalJson(expected))
    throw new ListingMemberLifecycleError("LISTING_MEMBER_SOURCE_CHANGED", "The archived member's saved identity changed before group maintenance.");
}
