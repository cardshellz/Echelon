import type { PoolClient } from "pg";
import type { VerifiedStockListing } from "../application/verified-listing-stock.service";
import { InventoryPublicationMembershipError } from "../application/inventory-publication-membership.service";
import { calculatePublicationVariantMappingDefinitionHash } from "../domain/inventory-channel-exposure";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";

const fail = (code: string, message: string): never => { throw new InventoryPublicationMembershipError(code, message); };

/** Caller holds the inventory configuration fence. Only a missing inventory
 * mapping is imported; existing mappings and saved drafts are never replaced. */
export async function prepareVerifiedStockMapping(client: PoolClient, targetId: number, input: VerifiedStockListing,
  requestHash: string, actor: string, now: Date): Promise<void> {
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
  const head = (await client.query<{ draft_mapping_id: number | null; external_inventory_item_id: string | null;
    external_sku: string | null; lifecycle_status: string | null }>(`SELECT h.draft_mapping_id,m.external_inventory_item_id,m.external_sku,m.lifecycle_status
    FROM inventory.publication_variant_mapping_heads h LEFT JOIN inventory.publication_variant_mapping_versions m ON m.id=h.active_mapping_id
    WHERE h.publication_target_id=$1 AND h.product_variant_id=$2 FOR UPDATE OF h`, [targetId, input.productVariantId])).rows[0];
  if (head) {
    if (head.draft_mapping_id !== null || head.lifecycle_status !== "sealed"
      || head.external_inventory_item_id !== input.sku || head.external_sku !== input.sku) {
      fail("STOCK_LISTING_MAPPING_REVIEW_REQUIRED", "An existing stock mapping or saved change needs review; it was not overwritten.");
    }
    return;
  }
  const conflict = await client.query(`SELECT 1 FROM inventory.publication_variant_mapping_versions
    WHERE publication_target_id=$1 AND external_inventory_item_id=$2 AND product_variant_id<>$3 AND lifecycle_status IN ('draft','sealed')`,
  [targetId, input.sku, input.productVariantId]);
  if (conflict.rowCount) fail("STOCK_LISTING_MAPPING_CONFLICT", "Another Echelon SKU already owns this Walmart inventory identity.");
  const definitionHash = calculatePublicationVariantMappingDefinitionHash({ publicationTargetId: targetId,
    productVariantId: input.productVariantId, externalInventoryItemId: input.sku, externalSku: input.sku });
  const reason = "Connected a verified published Walmart listing to the enabled ATP stock destination.";
  const mapping = (await client.query<{ id: number }>(`INSERT INTO inventory.publication_variant_mapping_versions
    (publication_target_id,product_variant_id,version,external_inventory_item_id,external_sku,definition_hash,change_reason,
      idempotency_key,request_hash,created_by,created_at,updated_at)
    VALUES($1,$2,1,$3,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
  [targetId, input.productVariantId, input.sku, definitionHash, reason, `verified-stock-map:${requestHash}`, requestHash, actor, now])).rows[0];
  if (!mapping) fail("STOCK_LISTING_MAPPING_FAILED", "The inventory identity was not saved.");
  await client.query(`INSERT INTO inventory.publication_variant_mapping_heads
    (publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason,updated_at)
    VALUES($1,$2,$3,1,$4,$5,$6)`, [targetId, input.productVariantId, mapping.id, actor, reason, now]);
  await promoteInventoryCutoverDefinitionsInsideTransaction(client, {
    contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [], publicationTargetIds: [targetId],
    selections: [{ kind: "variant_mapping", key: `${targetId}:${input.productVariantId}`, definitionId: mapping.id, definitionHash }],
  }, { actor, reason, occurredAt: now });
  await client.query(`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES($1,'AUDIT',$2,'inventory_availability.verified_listing_mapping.connected',$3,$4::jsonb,$5::jsonb)`,
  [now, actor, `inventory.inventory_publication_target:${targetId}`, JSON.stringify({ before: null,
    after: { productVariantId: input.productVariantId, mappingId: mapping.id, sku: input.sku, definitionHash } }), JSON.stringify({ requestHash, observation: input })]);
}
