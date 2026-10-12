import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { canonicalJson } from "@shared/utils/canonical-json";
import { inventoryEbayPublicationReadinessSchema, type InventoryEbayPublicationReadinessInput } from "@shared/types/ebay-publication-readiness";
import type { PublicationMembershipBlocker } from "@shared/types/inventory-publication-membership";
import { ebayPublicationMappingRowSchema, reviewEbayPublicationMember, type EbayPublicationMappingRow } from "../domain/ebay-publication-readiness";
import { reviewMappingPreparation, readTargets, type PublicationMappingProposal } from "./publication-mapping-preparation.repository";
import type { ActivePublicationVariantMappingSnapshot } from "../application/inventory-channel-exposure-runtime.service";

export const readinessDigest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const blocker = (code: string, message: string, productVariantId: number | null = null,
  action: PublicationMembershipBlocker["action"] = "configure_inventory"): PublicationMembershipBlocker => ({ code, message, action, productVariantId });

/** Read-only proposal: uses the active ATP/model/policy/source owners. Only
 * proposed exact SKU mappings are overlaid, never selection or draft policy. */
export async function captureEbayPublicationReadiness(client: PoolClient, source: InventoryEbayPublicationReadinessInput, lock: boolean) {
  const blockers: PublicationMembershipBlocker[] = [];
  const targets = await readTargets(client, source.channelId, source.connectionId, undefined, lock);
  const target = targets.length === 1 ? targets[0] : null;
  if (!target || target.provider_key !== "ebay" || target.destination_kind !== "channel_connection"
    || target.provider_scope_type !== "account" || target.external_scope_id !== source.accountId) {
    blockers.push(blocker("STOCK_LISTING_TARGET_MISMATCH", "Configure one exact eBay stock destination for this connected seller account."));
  }
  const account = await client.query(`SELECT t.external_account_id FROM ebay.ebay_oauth_tokens t
    JOIN channels.channel_connections c ON c.channel_id=t.channel_id AND c.id=$2
    WHERE t.channel_id=$1 AND t.environment=$3 AND t.external_account_id=$4
      AND t.external_account_identity_scheme='provider_user_id' AND t.external_account_verified_at IS NOT NULL
    ${lock ? "FOR SHARE OF t,c" : ""}`, [source.channelId, source.connectionId, source.environment, source.accountId]);
  if (account.rowCount !== 1) blockers.push(blocker("STOCK_LISTING_ACCOUNT_CHANGED", "Reconnect the expected eBay seller account and review this publication again.", null, "reconnect"));
  const enabled = await client.query(`SELECT global_enabled FROM channels.sync_settings ${lock ? "FOR SHARE" : ""}`);
  if (enabled.rows.length !== 1 || enabled.rows[0].global_enabled !== true) blockers.push(blocker("STOCK_LISTING_GLOBAL_STOP", "Automatic stock publication is paused globally."));
  if (target?.held_at) blockers.push(blocker("STOCK_LISTING_HELD", "This stock destination is on hold. Review the hold before publishing."));
  if (lock) {
    await client.query("SELECT id FROM catalog.products WHERE id=$1 FOR SHARE", [source.productId]);
    await client.query("SELECT id FROM catalog.product_variants WHERE id=ANY($1::integer[]) ORDER BY id FOR SHARE", [source.variants.map(row => row.productVariantId)]);
    await client.query("SELECT id FROM channels.channel_listings WHERE channel_id=$1 AND product_variant_id=ANY($2::integer[]) ORDER BY id FOR SHARE",
      [source.channelId, source.variants.map(row => row.productVariantId)]);
  }
  const rows = (await client.query<EbayPublicationMappingRow>(`SELECT v.id,v.product_id,v.sku,cl.external_sku,
    (p.is_active AND p.status='active' AND v.is_active AND v.requires_shipping AND v.track_inventory IS TRUE AND v.sales_eligibility='sellable') IS TRUE AS eligible,
    h.active_mapping_id,h.draft_mapping_id,h.revision::text AS head_revision,
    active.external_inventory_item_id AS active_inventory_id,active.external_sku AS active_sku,
    m.id AS mapping_id,m.version AS mapping_version,m.definition_hash AS mapping_hash,
    m.external_inventory_item_id AS mapping_inventory_id,m.external_sku AS mapping_sku,m.lifecycle_status AS mapping_status,
    holds.held_at,
    ARRAY(SELECT other.product_variant_id FROM inventory.publication_variant_mapping_heads other
      JOIN inventory.publication_variant_mapping_versions om ON om.id=other.active_mapping_id OR om.id=other.draft_mapping_id
      WHERE other.publication_target_id=$1 AND other.product_variant_id<>v.id
      AND om.external_inventory_item_id=COALESCE(cl.external_sku,v.sku) ORDER BY other.product_variant_id) AS conflicts
    FROM catalog.product_variants v JOIN catalog.products p ON p.id=v.product_id
    LEFT JOIN channels.channel_listings cl ON cl.channel_id=$2 AND cl.product_variant_id=v.id
    LEFT JOIN inventory.publication_variant_mapping_heads h ON h.publication_target_id=$1 AND h.product_variant_id=v.id
    LEFT JOIN inventory.publication_variant_mapping_versions m ON m.id=COALESCE(h.draft_mapping_id,h.active_mapping_id)
    LEFT JOIN inventory.publication_variant_mapping_versions active ON active.id=h.active_mapping_id
    LEFT JOIN inventory.inventory_publication_target_variant_holds holds ON holds.publication_target_id=$1 AND holds.product_variant_id=v.id
    WHERE v.id=ANY($3::integer[]) ORDER BY v.id`, [target?.id ?? null, source.channelId, source.variants.map(row => row.productVariantId)])).rows.map(row => ebayPublicationMappingRowSchema.parse(row));
  const proposal: PublicationMappingProposal = { mappings: [], newMappingVariantIds: [] };
  const mappings: ActivePublicationVariantMappingSnapshot[] = [], missing: number[] = [];
  const variants = source.variants.map(input => {
    const matches = rows.filter(row => row.id === input.productVariantId);
    const row = matches.length === 1 ? matches[0] : undefined;
    const decision = reviewEbayPublicationMember(source, input, target?.id ?? null, matches);
    blockers.push(...decision.blockers);
    if (row?.mapping_id != null && row.mapping_version != null && row.mapping_hash) mappings.push({ mappingId: row.mapping_id,
      productVariantId: input.productVariantId, version: row.mapping_version, definitionHash: row.mapping_hash,
      externalInventoryItemId: input.sku, externalSku: input.sku });
    else missing.push(input.productVariantId);
    return decision.variant;
  });
  proposal.mappings = mappings; proposal.newMappingVariantIds = missing;
  let mappingReview = null;
  if (target && blockers.length === 0) {
    mappingReview = (await reviewMappingPreparation(client, { publicationTargetId: target.id, expectedTargetRevision: target.revision,
      productId: source.productId, productVariantIds: source.variants.map(row => row.productVariantId) }, lock, proposal)).review;
    blockers.push(...mappingReview.blockers);
    for (const variant of variants) {
      const quantity = mappingReview.quantities.find(row => row.productVariantId === variant.productVariantId);
      if (quantity) variant.desiredQuantity = quantity.desiredQuantity;
      else blockers.push(blocker("STOCK_LISTING_QUANTITY_UNAVAILABLE", "The canonical stock planner did not return this exact SKU. Review its active stock model and policy.", variant.productVariantId));
    }
  }
  const currentlyReady = blockers.length === 0 && variants.every(row => row.mappingAction === "none");
  const body = { channelId: source.channelId, connectionId: source.connectionId, productId: source.productId,
    publicationTargetId: target?.id ?? null, targetRevision: target?.revision ?? null, ready: blockers.length === 0,
    currentlyReady, variants, blockers, effects: currentlyReady ? ["Use the existing stock mappings and current canonical stock quantities."] :
      ["Seal only the verified exact eBay SKU mappings for the existing channel selection.",
        "Recalculate destination quantities with the existing active stock model, source, and policies.", "Save publication work in the same transaction."] };
  return { review: inventoryEbayPublicationReadinessSchema.parse({ ...body,
    reviewHash: readinessDigest({ source, body, target, rows, mappingReview }) }), target, rows, proposal, mappingReview };
}
