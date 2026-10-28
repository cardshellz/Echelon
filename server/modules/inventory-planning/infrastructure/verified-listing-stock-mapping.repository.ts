import type { PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { VerifiedStockListing } from "../application/verified-listing-stock.service";
import { InventoryPublicationMembershipError } from "../application/inventory-publication-membership.service";
import { quantityPublicationScopeSchema } from "../domain/quantity-publication-admission";
import { PostgresInventoryChannelExposureAdminStore, VARIANT_MAPPING_LOCK_NAMESPACE } from "./inventory-channel-exposure-admin.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";
import type { MappingPreparationTarget } from "./publication-mapping-preparation.repository";
import { quantityPublicationScopeLockKey } from "./quantity-publication-admission.repository";
import { lockStockLinkCommandMembers } from "./stock-link-command";
import { retireStockLinkMappingsInsideTransaction, type StockLinkRetiredMapping } from "./stock-link-retire";

const fail = (code: string, message: string): never => { throw new InventoryPublicationMembershipError(code, message); };

const LINK_REASON = "Connected a verified published Walmart listing to the enabled ATP stock destination.";
const RELINK_REASON = "The Card Shellz SKU changed; linked the published Walmart item that carries the new SKU.";

/** What the link step changed: nothing (already linked), a first link, or a relink after a Card Shellz SKU change. */
export type VerifiedStockLinkChange = "none" | "linked" | "relinked";

/**
 * The Walmart stock link inside the caller's configuration transaction (channels PR4, PLAN-CH-v3 §3.4, §3.5). The caller
 * holds the inventory cutover fence. The link is the SKU itself (identity = sku). It is written with the engine's own
 * primitives, never with hand-written mapping rows (this replaced prepareVerifiedStockMapping, whose behaviour the
 * verified-listing-stock PG suite pins):
 * - the global stop, the Walmart connection and the verified feed FOR SHARE, and the hold, as before;
 * - the draft writer's per-destination lock (918428) before the head FOR UPDATE, so a manual draft save and this link
 *   always meet on that lock first (N3);
 * - an existing head is left alone unless it already holds exactly this SKU (no change), or it holds the SKU this size
 *   carried before a Card Shellz SKU change (`replacesSku`, a relink: the old version is retired first, with the pair
 *   and provider-scope TRY locks the retire needs), or it has no version at all left (retired);
 * - another size owning the SKU is refused (STOCK_LISTING_MAPPING_CONFLICT), as before;
 * - the draft writer saves the version (idempotency receipt, predecessor, identity conflict check, draft audit) and the
 *   sealer promotes it; one stock_link audit row records the change with its evidence.
 * No provider I/O happens here.
 */
export async function linkVerifiedStockMapping(client: PoolClient, scopeKeys: string[], target: MappingPreparationTarget,
  input: VerifiedStockListing, requestHash: string, actor: string, now: Date): Promise<VerifiedStockLinkChange> {
  const targetId = target.id;
  const global = await client.query("SELECT 1 FROM channels.sync_settings WHERE global_enabled=true FOR SHARE");
  if (global.rowCount !== 1) fail("STOCK_LISTING_GLOBAL_STOP", "Automatic stock updates are paused globally.");
  const connection = await client.query(`SELECT 1 FROM channels.walmart_connections w
    JOIN channels.channel_connections c ON c.id=w.connection_id AND c.channel_id=w.channel_id
    WHERE w.channel_id=$1 AND w.connection_id=$2 AND w.partner_id=$3 AND w.environment=$4 AND w.ship_node_id=$5
    FOR SHARE OF w,c`, [input.channelId, input.connectionId, input.accountId, input.environment, input.externalScopeId]);
  if (connection.rowCount !== 1) fail("STOCK_LISTING_ACCOUNT_CHANGED", "The Walmart connection changed after the listing was verified.");
  const feed = await client.query(`SELECT 1 FROM channels.channel_feeds
    WHERE channel_id=$1 AND product_variant_id=$2 AND channel_sku=$3 AND channel_inventory_item_id=$3
      AND channel_product_id=$4 AND is_active=1 AND quarantined_at IS NULL FOR SHARE`,
  [input.channelId, input.productVariantId, input.sku, input.externalProductId]);
  if (feed.rowCount !== 1) fail("STOCK_LISTING_LINK_CHANGED", "The verified Walmart item no longer matches its Echelon listing link.");
  const hold = await client.query(`SELECT 1 FROM inventory.inventory_publication_target_variant_holds
    WHERE publication_target_id=$1 AND product_variant_id=$2 AND held_at IS NOT NULL`, [targetId, input.productVariantId]);
  if (hold.rowCount) fail("STOCK_LISTING_HELD", "Stock for this SKU is on hold.");
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [VARIANT_MAPPING_LOCK_NAMESPACE, targetId]);
  const head = (await client.query<{ revision: string; active_mapping_id: number | null; draft_mapping_id: number | null;
    external_inventory_item_id: string | null; external_sku: string | null; lifecycle_status: string | null }>(
    `SELECT h.revision::text AS revision,h.active_mapping_id,h.draft_mapping_id,m.external_inventory_item_id,m.external_sku,m.lifecycle_status
    FROM inventory.publication_variant_mapping_heads h LEFT JOIN inventory.publication_variant_mapping_versions m ON m.id=h.active_mapping_id
    WHERE h.publication_target_id=$1 AND h.product_variant_id=$2 FOR UPDATE OF h`, [targetId, input.productVariantId])).rows[0];
  const sealedOn = (sku: string) => head?.draft_mapping_id === null && head.lifecycle_status === "sealed"
    && head.external_inventory_item_id === sku && head.external_sku === sku;
  if (head && sealedOn(input.sku)) return "none";
  const relink = head !== undefined && input.replacesSku !== undefined && input.replacesSku !== input.sku && sealedOn(input.replacesSku);
  const emptyHead = head !== undefined && head.active_mapping_id === null && head.draft_mapping_id === null;
  if (head && !relink && !emptyHead) {
    fail("STOCK_LISTING_MAPPING_REVIEW_REQUIRED", "An existing stock mapping or saved change needs review; it was not overwritten.");
  }
  const conflict = await client.query(`SELECT 1 FROM inventory.publication_variant_mapping_versions
    WHERE publication_target_id=$1 AND external_inventory_item_id=$2 AND product_variant_id<>$3 AND lifecycle_status IN ('draft','sealed')`,
  [targetId, input.sku, input.productVariantId]);
  if (conflict.rowCount) fail("STOCK_LISTING_MAPPING_CONFLICT", "Another Echelon SKU already owns this Walmart inventory identity.");

  let retired: StockLinkRetiredMapping[] = [];
  let expectedHeadRevision = head?.revision ?? "0";
  if (relink) {
    // A stock update to either SKU in flight makes the relink busy (TRY locks; the store releases the scope keys).
    const scopeKey = (item: string) => quantityPublicationScopeLockKey(quantityPublicationScopeSchema.parse({
      destinationKind: target.destination_kind, connectionId: target.channel_connection_id, providerKey: target.provider_key,
      providerScopeType: target.provider_scope_type, externalScopeId: target.external_scope_id, externalInventoryItemId: item,
      productId: null, productVariantId: null }));
    await lockStockLinkCommandMembers(client, scopeKeys, { publicationTargetId: targetId, pairVariantIds: [input.productVariantId],
      scopeKeys: [scopeKey(input.replacesSku!), scopeKey(input.sku)], heads: [] });
    retired = await retireStockLinkMappingsInsideTransaction(client, { publicationTargetId: targetId, actor, reason: RELINK_REASON, now,
      members: [{ productVariantId: input.productVariantId, mappingId: Number(head!.active_mapping_id), expectedHeadRevision: head!.revision }] });
    expectedHeadRevision = retired[0]!.headRevision;
  }
  const reason = relink ? RELINK_REASON : LINK_REASON;
  const saved = await new PostgresInventoryChannelExposureAdminStore().saveVariantMappingDraftInsideTransaction(drizzle(client), {
    publicationTargetId: targetId, productVariantId: input.productVariantId,
    externalInventoryItemId: input.sku, externalSku: input.sku, expectedHeadRevision,
    expectedDraftMappingId: null, expectedDraftDefinitionHash: null, changeReason: reason,
    idempotencyKey: `verified-stock-map:${requestHash}:${input.productVariantId}`,
    requestHash, actorId: actor, occurredAt: now,
  });
  await promoteInventoryCutoverDefinitionsInsideTransaction(client, {
    contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [], publicationTargetIds: [targetId],
    selections: [{ kind: "variant_mapping", key: `${targetId}:${input.productVariantId}`, definitionId: saved.definitionId,
      definitionHash: saved.definitionHash }],
  }, { actor, reason, occurredAt: now });
  const change: VerifiedStockLinkChange = relink ? "relinked" : "linked";
  await client.query(`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES($1,'AUDIT',$2,$3,$4,$5::jsonb,$6::jsonb)`,
  [now, actor, `inventory_availability.stock_link.${change}`, `inventory.inventory_publication_target:${targetId}`,
    JSON.stringify({
      before: retired[0] ? { mappingId: retired[0].mappingId, itemId: retired[0].externalInventoryItemId, sku: retired[0].externalSku,
        retiredAt: retired[0].retiredAt } : null,
      after: { productVariantId: input.productVariantId, mappingId: saved.definitionId, itemId: input.sku, sku: input.sku,
        definitionHash: saved.definitionHash } }),
    JSON.stringify({ requestHash, origin: input.setupOperationId ? "recreation" : "background", observation: input })]);
  return change;
}
