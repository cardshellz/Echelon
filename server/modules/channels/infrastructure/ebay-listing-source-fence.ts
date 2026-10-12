import type { PoolClient } from "pg";
import { EbayListingSyncError, type EbayListingSyncIdentity } from "../ebay-listing-sync.domain";

/** Fence the saved account, eligibility and mapping inputs through a local
 * listing command's commit. Caller acquires the canonical account lock first. */
export async function lockEbayListingSource(client: PoolClient, identity: EbayListingSyncIdentity,
  environment: "production" | "sandbox"): Promise<void> {
  const changed = () => new EbayListingSyncError("EBAY_PUBLICATION_STOCK_SOURCE_CHANGED", "The saved account, product, or eBay mapping changed. Review the current listing again.");
  const channel = (await client.query("SELECT provider FROM channels.channels WHERE id=$1 FOR UPDATE", [identity.channelId])).rows[0];
  if (channel?.provider?.toLowerCase() !== "ebay") throw changed();
  const connections = (await client.query("SELECT id FROM channels.channel_connections WHERE channel_id=$1 ORDER BY id FOR UPDATE", [identity.channelId])).rows;
  if (connections.length !== 1 || connections[0].id !== identity.connectionId) throw changed();
  const account = (await client.query(`SELECT external_account_id,external_account_identity_scheme,external_account_verified_at
    FROM ebay.ebay_oauth_tokens WHERE channel_id=$1 AND environment=$2 FOR UPDATE`, [identity.channelId, environment])).rows[0];
  if (account?.external_account_id !== identity.accountId || account?.external_account_identity_scheme !== "provider_user_id" || !account?.external_account_verified_at) throw changed();
  if (!(await client.query("SELECT id FROM catalog.products WHERE id=$1 FOR UPDATE", [identity.productId])).rowCount) throw changed();
  // Parent locks prevent new FK-referencing mappings, variants and overrides;
  // existing override rows need their own locks against non-key edits.
  await client.query("SELECT id FROM catalog.product_variants WHERE product_id=$1 ORDER BY id FOR UPDATE", [identity.productId]);
  await client.query("SELECT id FROM channels.channel_product_overrides WHERE channel_id=$1 AND product_id=$2 ORDER BY id FOR UPDATE", [identity.channelId, identity.productId]);
  await client.query(`SELECT id FROM channels.channel_variant_overrides WHERE channel_id=$1
    AND product_variant_id IN (SELECT id FROM catalog.product_variants WHERE product_id=$2) ORDER BY id FOR UPDATE`, [identity.channelId, identity.productId]);
  await client.query(`SELECT id FROM ebay.ebay_category_mappings WHERE channel_id=$1
    AND product_type_slug=(SELECT product_type FROM catalog.products WHERE id=$2) ORDER BY id FOR UPDATE`, [identity.channelId, identity.productId]);
  await client.query("SELECT product_variant_id FROM channels.channel_listings WHERE channel_id=$1 AND product_variant_id=ANY($2::integer[]) ORDER BY product_variant_id FOR UPDATE", [identity.channelId, identity.variants.map(member => member.variantId)]);
}
