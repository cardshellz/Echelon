import type { PoolClient } from "pg";
import { z } from "zod";
import { InitialPublicationScopeError } from "../application/inventory-publication-initial-scope.service";
import { initialPublicationScopeFactsSchema, type InitialPublicationScopeFacts } from "../domain/inventory-publication-initial-scope";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";

// These are the complete source predicates read below. SHARE/NOWAIT prevents a
// new feed/member appearing between review revalidation and commit, without
// waiting in the opposite order to a catalog/listing writer's row locks.
export const INITIAL_SCOPE_SOURCE_TABLES = [
  "catalog.products", "catalog.product_variants", "channels.channels", "channels.channel_connections",
  "channels.channel_feeds", "channels.channel_listings", "dropship.dropship_store_connections", "dropship.dropship_vendor_listings",
  "inventory.publication_variant_mapping_heads", "inventory.publication_variant_mapping_versions",
  "inventory.publication_membership_heads", "inventory.publication_membership_versions",
  "marketplace.listing_scopes", "marketplace.channel_listing_scopes", "marketplace.dropship_listing_scopes",
  "marketplace.listing_publications", "marketplace.listing_publication_members", "marketplace.listing_registrations",
  "marketplace.listing_scope_provider_accounts", "marketplace.provider_accounts",
  "marketplace.listing_verification_snapshots", "marketplace.listing_verification_members",
] as const;

const memberSchema = z.object({
  productVariantId: z.number().int().positive(), sku: z.string().min(1),
  inventoryItemId: z.string().nullable(), offerId: z.string().nullable(),
});
const registrationSchema = z.object({
  scopeId: z.string(), publicationId: z.string().nullable(), registrationId: z.string().nullable(),
  registeredPublicationId: z.string().nullable(), verificationId: z.string().nullable(),
  ownerKind: z.string(), provider: z.string(), channelId: z.number().nullable(), storeConnectionId: z.number().nullable(),
  accountOwnerKind: z.string().nullable(), accountChannelId: z.number().nullable(), accountStoreConnectionId: z.number().nullable(),
  externalAccountId: z.string().nullable(), identityScheme: z.string().nullable(), accountProvider: z.string().nullable(),
  registrationAccountId: z.string().nullable(), scopeAccountId: z.string().nullable(),
  externalListingId: z.string().nullable(), hasPendingPublication: z.boolean(), members: z.array(memberSchema),
});
type RegisteredMember = z.infer<typeof memberSchema> & { externalListingId: string; sourceKey: string };

export async function readInitialPublicationScopeFacts(
  client: PoolClient, targetId: number, lockTarget = false,
): Promise<InitialPublicationScopeFacts> {
  const authority = (await client.query(`SELECT authority,revision::text AS "authorityRevision",
    EXISTS(SELECT 1 FROM inventory.availability_activation_freezes WHERE released_at IS NULL) AS frozen
    FROM inventory.availability_runtime_authority WHERE singleton_key=true`)).rows[0];
  const targetRow = (await client.query(`SELECT t.id,t.revision::text,t.state,t.membership_mode AS mode,
    t.publication_authority AS authority,t.destination_kind AS "destinationKind",t.channel_id AS "channelId",
    t.channel_connection_id AS "channelConnectionId",t.dropship_store_connection_id AS "dropshipStoreConnectionId",
    CASE WHEN t.destination_kind='dropship_store_connection' THEN store.platform ELSE channel.provider END AS provider,
    t.provider_scope_type AS "providerScopeType",t.external_scope_id AS "externalScopeId",
    connection.channel_id AS "connectionChannelId"
    FROM inventory.inventory_publication_targets t JOIN channels.channels channel ON channel.id=t.channel_id
    LEFT JOIN channels.channel_connections connection ON connection.id=t.channel_connection_id
    LEFT JOIN dropship.dropship_store_connections store ON store.id=t.dropship_store_connection_id
    WHERE t.id=$1 ${lockTarget ? "FOR UPDATE OF t NOWAIT" : ""}`, [targetId])).rows[0];
  if (!targetRow) throw new InitialPublicationScopeError("INITIAL_SCOPE_TARGET_NOT_FOUND", "The destination does not exist.", 404);
  const { connectionChannelId, ...targetValues } = targetRow;
  const target = initialPublicationScopeFactsSchema.shape.target.parse(targetValues);
  const ownerIssues: string[] = [];
  const ownerEvidenceHashes: string[] = [];
  if (target.destinationKind === "channel_connection" && connectionChannelId !== target.channelId) ownerIssues.push("CHANNEL_CONNECTION_MISMATCH");
  const listings: InitialPublicationScopeFacts["listings"] = [];
  const registered = await readRegisteredMembers(client, target, ownerIssues, ownerEvidenceHashes);
  for (const member of registered) listings.push({
    sourceKey: member.sourceKey, productVariantId: member.productVariantId, active: true, uncertain: false, quarantined: false,
    externalSku: member.sku,
    // eBay inventory item keys are seller SKUs, not offer/listing identifiers.
    externalInventoryItemId: target.provider === "ebay" ? member.sku : member.inventoryItemId,
  });
  if (target.destinationKind === "channel_connection") {
    const feeds = (await client.query(`SELECT id::text,product_variant_id,channel_sku,channel_inventory_item_id,is_active,quarantined_at
      FROM channels.channel_feeds WHERE channel_id=$1 ORDER BY id`, [target.channelId])).rows;
    const channelListings = target.provider === "ebay" ? (await client.query(`SELECT id::text,product_variant_id,external_sku,external_variant_id
      FROM channels.channel_listings WHERE channel_id=$1 ORDER BY id`, [target.channelId])).rows : [];
    // Use the same listing-SKU precedence as getNonShopifyInventorySyncStates /
    // executeInventorySync. Retain the owner rows in the review fingerprint.
    for (const row of channelListings) ownerEvidenceHashes.push(inventoryCutoverEvidenceHash({ channelListing: row }));
    const channelListingByVariant = new Map(channelListings.map(row => [row.product_variant_id, row]));
    if (channelListingByVariant.size !== channelListings.length) ownerIssues.push("DUPLICATE_CHANNEL_LISTING_IDENTITY");
    for (const row of feeds) listings.push({
      sourceKey: `feed:${row.id}`, productVariantId: row.product_variant_id, active: row.is_active === 1, uncertain: false,
      quarantined: row.quarantined_at !== null,
      // Existing eBay quantity publication addresses the seller SKU, whereas
      // Shopify addresses an InventoryItem. A null Shopify-only feed column
      // must not invalidate an eBay identity the existing publisher already uses.
      externalInventoryItemId: target.provider === "ebay"
        ? channelListingByVariant.get(row.product_variant_id)?.external_sku ?? row.channel_sku : row.channel_inventory_item_id,
      externalSku: target.provider === "ebay"
        ? channelListingByVariant.get(row.product_variant_id)?.external_sku ?? row.channel_sku : row.channel_sku,
    });
    const feedVariantIds = new Set(feeds.map(row => row.product_variant_id));
    for (const row of channelListings) {
      if (feedVariantIds.has(row.product_variant_id)) continue;
      listings.push({ sourceKey: `channel-listing:${row.id}`, productVariantId: row.product_variant_id,
        active: true, uncertain: false, quarantined: false, externalInventoryItemId: row.external_sku, externalSku: row.external_sku });
    }
  } else {
    const legacy = (await client.query(`SELECT id::text,product_variant_id,status,external_listing_id,external_offer_id
      FROM dropship.dropship_vendor_listings WHERE store_connection_id=$1 ORDER BY id`, [target.dropshipStoreConnectionId])).rows;
    for (const row of legacy) {
      const matching = registered.filter(member => member.productVariantId === row.product_variant_id
        && member.externalListingId === row.external_listing_id && member.offerId === row.external_offer_id);
      const identity = matching.length === 1 ? matching[0] : undefined;
      const active = ["active", "paused", "drift_detected"].includes(row.status);
      const uncertain = !active && !["not_listed", "preview_ready", "ended"].includes(row.status);
      listings.push({ sourceKey: `dropship-listing:${row.id}`, productVariantId: row.product_variant_id,
        listingStatus: row.status,
        active, uncertain, quarantined: row.status === "drift_detected",
        // A catalog SKU alone is not proof of what the vendor listed. A missing
        // exact registered identity remains a visible blocker, never a guess.
        externalInventoryItemId: identity ? (target.provider === "ebay" ? identity.sku : identity.inventoryItemId) : null,
        externalSku: identity?.sku ?? null });
    }
  }
  const variantIds = [...new Set(listings.map(row => row.productVariantId))].sort((a, b) => a - b);
  const variants = (await client.query(`SELECT v.id,v.product_id AS "productId",p.is_active AS "productActive",
    v.is_active AS "variantActive",v.requires_shipping AS "requiresShipping",p.inventory_tracking_default AS "inventoryTrackingDefault",
    v.inventory_tracking_override AS "inventoryTrackingOverride",v.sales_eligibility AS "salesEligibility",
    (SELECT count(*)::integer FROM inventory.publication_variant_mapping_versions history
      WHERE history.publication_target_id=$1 AND history.product_variant_id=v.id) AS "mappingHistoryCount",
    h.publication_target_id IS NOT NULL AS "mappingHeadExists",
    CASE WHEN m.id IS NULL THEN NULL ELSE jsonb_build_object('id',m.id,'version',m.version,'definitionHash',m.definition_hash,
      'externalInventoryItemId',m.external_inventory_item_id,'externalSku',m.external_sku) END AS mapping
    FROM catalog.product_variants v JOIN catalog.products p ON p.id=v.product_id
    LEFT JOIN inventory.publication_variant_mapping_heads h ON h.product_variant_id=v.id AND h.publication_target_id=$1
    LEFT JOIN inventory.publication_variant_mapping_versions m ON m.id=COALESCE(h.draft_mapping_id,h.active_mapping_id)
    WHERE v.id=ANY($2::integer[]) ORDER BY v.id`, [targetId, variantIds])).rows;
  const count = (await client.query(`SELECT
    (SELECT count(*) FROM inventory.publication_membership_heads WHERE publication_target_id=$1)
    + (SELECT count(*) FROM inventory.publication_membership_versions WHERE publication_target_id=$1) AS count`, [targetId])).rows[0];
  const mappingOwners = (await client.query(`SELECT head.product_variant_id AS "productVariantId",
    mapping.external_inventory_item_id AS "externalInventoryItemId"
    FROM inventory.publication_variant_mapping_heads head
    JOIN inventory.publication_variant_mapping_versions mapping ON mapping.id=COALESCE(head.draft_mapping_id,head.active_mapping_id)
    WHERE head.publication_target_id=$1 ORDER BY head.product_variant_id`, [targetId])).rows;
  return initialPublicationScopeFactsSchema.parse({ ...authority, target, existingMemberCount: Number(count.count), listings, ownerIssues, ownerEvidenceHashes, variants, mappingOwners });
}

async function readRegisteredMembers(client: PoolClient, target: InitialPublicationScopeFacts["target"], issues: string[], evidenceHashes: string[]): Promise<RegisteredMember[]> {
  // Mirrors the listing owner's currentRegistrationStatusesSql: latest verified
  // members replace, not union with, historical publication members.
  const result = await client.query(`SELECT scope.id::text AS "scopeId",pub.id::text AS "publicationId",
    registration.id::text AS "registrationId",scope.owner_kind AS "ownerKind",scope.provider,
    registration.publication_id::text AS "registeredPublicationId",verification.id::text AS "verificationId",
    channel.channel_id AS "channelId",store.store_connection_id AS "storeConnectionId",
    account.owner_kind AS "accountOwnerKind",account.channel_id AS "accountChannelId",
    account.store_connection_id AS "accountStoreConnectionId",account.external_account_id AS "externalAccountId",
    account.identity_scheme AS "identityScheme",account.provider AS "accountProvider",
    registration.provider_account_id::text AS "registrationAccountId",binding.provider_account_id::text AS "scopeAccountId",
    COALESCE(verification.external_listing_id,pub.external_listing_id) AS "externalListingId",
    EXISTS(SELECT 1 FROM marketplace.listing_publications pending WHERE pending.scope_id=scope.id AND pending.status IN ('planned','staged')) AS "hasPendingPublication",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('productVariantId',member.product_variant_id,'sku',member.sku_snapshot,
      'inventoryItemId',member.external_inventory_item_id,'offerId',member.external_offer_id) ORDER BY member.product_variant_id)
      FROM (SELECT product_variant_id,sku_snapshot,external_inventory_item_id,external_offer_id FROM marketplace.listing_verification_members
        WHERE verification_id=verification.id AND disposition='included'
        UNION ALL SELECT product_variant_id,sku_snapshot,external_inventory_item_id,external_offer_id FROM marketplace.listing_publication_members
        WHERE publication_id=pub.id AND verification.id IS NULL AND disposition='included') member),'[]'::jsonb) AS members
    FROM marketplace.listing_scopes scope
    LEFT JOIN marketplace.channel_listing_scopes channel ON channel.scope_id=scope.id
    LEFT JOIN marketplace.dropship_listing_scopes store ON store.scope_id=scope.id
    LEFT JOIN marketplace.listing_publications pub ON pub.scope_id=scope.id AND pub.status='active'
    LEFT JOIN marketplace.listing_registrations registration ON registration.scope_id=scope.id
    LEFT JOIN marketplace.listing_scope_provider_accounts binding ON binding.scope_id=scope.id
    LEFT JOIN marketplace.provider_accounts account ON account.id=binding.provider_account_id
    LEFT JOIN LATERAL (SELECT snapshot.id,snapshot.external_listing_id FROM marketplace.listing_verification_snapshots snapshot
      WHERE snapshot.scope_id=scope.id AND snapshot.source_publication_id=pub.id
      ORDER BY snapshot.verified_at DESC,snapshot.id DESC LIMIT 1) verification ON true
    WHERE ($1='channel_connection' AND channel.channel_id=$2) OR ($1='dropship_store_connection' AND store.store_connection_id=$3)
    ORDER BY scope.id`, [target.destinationKind, target.channelId, target.dropshipStoreConnectionId]);
  const members: RegisteredMember[] = [];
  for (const raw of result.rows) {
    const row = registrationSchema.parse(raw);
    // Seal provenance even for an empty verified membership. A new verification
    // or account binding requires a new review, not just matching SKU numbers.
    evidenceHashes.push(inventoryCutoverEvidenceHash(row));
    if (row.hasPendingPublication) issues.push(`PENDING_PUBLICATION:${row.scopeId}`);
    if (row.publicationId === null && row.registrationId === null) continue;
    const channelOwner = target.destinationKind === "channel_connection";
    const expectedOwner = channelOwner ? "channel" : "dropship";
    if (row.ownerKind !== expectedOwner || row.accountOwnerKind !== expectedOwner || row.provider !== target.provider
      || row.accountProvider !== target.provider || row.publicationId === null || row.registrationId === null || row.registeredPublicationId === null
      || row.scopeAccountId !== row.registrationAccountId || !row.externalListingId
      || row.identityScheme !== "provider_user_id"
      || (channelOwner ? row.accountChannelId !== target.channelId || row.accountStoreConnectionId !== null
        : row.accountStoreConnectionId !== target.dropshipStoreConnectionId || row.accountChannelId !== null)
      || (target.providerScopeType === "account" && row.externalAccountId !== target.externalScopeId)) {
      issues.push(`REGISTRATION_IDENTITY_UNRESOLVED:${row.scopeId}`);
      continue;
    }
    for (const member of row.members) members.push({ ...member, externalListingId: row.externalListingId,
      sourceKey: `registered:${row.scopeId}:${row.publicationId}:${member.productVariantId}` });
  }
  return members;
}
