import type { PoolClient } from "pg";
import type { DropshipEbayStockReadinessInput } from "@shared/types/dropship-ebay-stock-readiness";
import type { PublicationMembershipBlocker } from "@shared/types/inventory-publication-membership";
import { ebayPublicationMappingRowSchema, reviewEbayPublicationMember, type EbayPublicationMappingRow } from "../domain/ebay-publication-readiness";
import type { ActivePublicationVariantMappingSnapshot } from "../application/inventory-channel-exposure-runtime.service";
import {
  mappingTargetBlockers, readTargets, reviewMappingPreparation,
  type MappingPreparationTarget, type PublicationMappingProposal,
} from "./publication-mapping-preparation.repository";

const blocker = (code: string, message: string, productVariantId: number | null = null,
  action: PublicationMembershipBlocker["action"] = "configure_inventory"): PublicationMembershipBlocker =>
  ({ code, message, action, productVariantId });

export interface DropshipEbayStockCaptureVariant {
  productVariantId: number;
  sku: string;
  mappingAction: "none" | "promote_draft" | "create";
  desiredQuantity: string | null;
}

export interface DropshipEbayStockCapture {
  /** The store account's one Card Shellz stock destination, when it can be identified. */
  target: MappingPreparationTarget | null;
  /** Live, Echelon-published destinations for the exact store account (the gate's
   * own count, canonical-quantity-publication-member.reader.ts). */
  liveTargetCount: number;
  blockers: PublicationMembershipBlocker[];
  variants: DropshipEbayStockCaptureVariant[];
  rows: EbayPublicationMappingRow[];
  /** No blocker and every member already has its exact sealed mapping. */
  currentlyReady: boolean;
}

/** The exact store account's destination. One live Echelon destination is the
 * target; with none live, a single configured one is reported (so its own state is
 * the blocker); anything else is STOCK_LISTING_TARGET_MISMATCH. Nothing is guessed. */
function selectStoreTarget(candidates: readonly MappingPreparationTarget[]) {
  const live = candidates.filter(row => row.state === "live" && row.publication_authority === "echelon");
  if (live.length === 1) return { target: live[0]!, liveTargetCount: 1 };
  if (live.length === 0 && candidates.length === 1) return { target: candidates[0]!, liveTargetCount: 0 };
  return { target: null, liveTargetCount: live.length };
}

/** Member identity rows on one destination: catalog SKU (COALESCE(v.sku,p.sku), the
 * SKU the Dropship eBay draft uses), the planner's eligibility (track_inventory NULL
 * counts as tracked, inventory-channel-exposure-runtime.repository.ts), current
 * active/draft mapping, holds and other members already using the SKU. */
export async function readDropshipEbayStockMemberRows(client: PoolClient, targetId: number | null,
  productVariantIds: readonly number[]): Promise<Array<Record<string, unknown> & { id: number; sku: string | null }>> {
  return (await client.query(`SELECT v.id,v.product_id,COALESCE(v.sku,p.sku) AS sku,NULL::text AS external_sku,
    (p.is_active AND p.status='active' AND v.is_active AND v.requires_shipping AND COALESCE(v.track_inventory,true)
      AND v.sales_eligibility='sellable') IS TRUE AS eligible,
    h.active_mapping_id,h.draft_mapping_id,h.revision::text AS head_revision,
    active.external_inventory_item_id AS active_inventory_id,active.external_sku AS active_sku,
    m.id AS mapping_id,m.version AS mapping_version,m.definition_hash AS mapping_hash,
    m.external_inventory_item_id AS mapping_inventory_id,m.external_sku AS mapping_sku,m.lifecycle_status AS mapping_status,
    holds.held_at,
    ARRAY(SELECT other.product_variant_id FROM inventory.publication_variant_mapping_heads other
      JOIN inventory.publication_variant_mapping_versions om ON om.id=other.active_mapping_id OR om.id=other.draft_mapping_id
      WHERE other.publication_target_id=$1 AND other.product_variant_id<>v.id
      AND om.external_inventory_item_id=COALESCE(v.sku,p.sku) ORDER BY other.product_variant_id) AS conflicts
    FROM catalog.product_variants v JOIN catalog.products p ON p.id=v.product_id
    LEFT JOIN inventory.publication_variant_mapping_heads h ON h.publication_target_id=$1 AND h.product_variant_id=v.id
    LEFT JOIN inventory.publication_variant_mapping_versions m ON m.id=COALESCE(h.draft_mapping_id,h.active_mapping_id)
    LEFT JOIN inventory.publication_variant_mapping_versions active ON active.id=h.active_mapping_id
    LEFT JOIN inventory.inventory_publication_target_variant_holds holds ON holds.publication_target_id=$1 AND holds.product_variant_id=v.id
    WHERE v.id=ANY($2::integer[]) ORDER BY v.id`, [targetId, [...productVariantIds]])).rows;
}

/** Pure per-member review (domain/ebay-publication-readiness.ts): never overwrites a
 * differing draft or active mapping, flags a SKU used by another member and holds.
 * A member without a catalog SKU is a changed source and is not parsed. */
export function reviewDropshipEbayStockMembers(source: DropshipEbayStockReadinessInput, targetId: number | null,
  rawRows: ReadonlyArray<Record<string, unknown> & { id: number; sku: string | null }>) {
  const blockers: PublicationMembershipBlocker[] = [];
  const rows: EbayPublicationMappingRow[] = [];
  for (const raw of rawRows) {
    if (raw.sku === null || raw.sku.trim() === "") continue;
    rows.push(ebayPublicationMappingRowSchema.parse(raw));
  }
  const variants: DropshipEbayStockCaptureVariant[] = source.variants.map(input => {
    const decision = reviewEbayPublicationMember(source, input, targetId, rows.filter(row => row.id === input.productVariantId));
    blockers.push(...decision.blockers);
    return { productVariantId: input.productVariantId, sku: input.sku, mappingAction: decision.variant.mappingAction, desiredQuantity: null };
  });
  return { rows, variants, blockers };
}

/**
 * Read-only proposal for linking a Dropship eBay store listing's exact SKU. Mirrors
 * captureEbayPublicationReadiness for a `dropship_store_connection` destination:
 * target, provider-verified store account, global stop, member identities and, on
 * request, the canonical quantity review with the proposed mappings overlaid.
 * With `lock`, it takes the same row locks as the channel capture (destination
 * FOR UPDATE, store/sync settings/catalog/vendor listings FOR SHARE).
 */
export async function captureDropshipEbayStockReadiness(client: PoolClient, source: DropshipEbayStockReadinessInput,
  options: { lock: boolean; quantityReview: boolean }): Promise<DropshipEbayStockCapture> {
  const blockers: PublicationMembershipBlocker[] = [];
  const candidates = (await readTargets(client, undefined, undefined, undefined, options.lock, source.storeConnectionId))
    .filter(row => row.destination_kind === "dropship_store_connection" && row.provider_key === "ebay"
      && row.provider_scope_type === "account" && row.external_scope_id === source.accountId);
  const { target, liveTargetCount } = selectStoreTarget(candidates);
  if (!target) blockers.push(blocker("STOCK_LISTING_TARGET_MISMATCH", liveTargetCount === 0
    ? "This Dropship eBay store account has no live Card Shellz stock destination."
    : "This Dropship eBay store account has more than one live Card Shellz stock destination."));
  else blockers.push(...mappingTargetBlockers(target));
  // The CHECK dropship_store_connections_stable_identity_chk
  // (migrations/0609_marketplace_listing_registration.sql) makes the environment
  // non-null and external_account_verified_at set whenever this scheme is set.
  const account = await client.query(`SELECT id FROM dropship.dropship_store_connections
    WHERE id=$1 AND vendor_id=$2 AND lower(platform)='ebay' AND status='connected'
      AND external_account_id=$3 AND external_account_identity_scheme='provider_user_id' AND provider_environment=$4
    ${options.lock ? "FOR SHARE" : ""}`, [source.storeConnectionId, source.vendorId, source.accountId, source.environment]);
  if (account.rowCount !== 1) blockers.push(blocker("STOCK_LISTING_ACCOUNT_CHANGED",
    "Reconnect the expected eBay seller account for this Dropship store.", null, "reconnect"));
  const enabled = await client.query(`SELECT global_enabled FROM channels.sync_settings ${options.lock ? "FOR SHARE" : ""}`);
  if (enabled.rows.length !== 1 || enabled.rows[0].global_enabled !== true)
    blockers.push(blocker("STOCK_LISTING_GLOBAL_STOP", "Automatic stock publication is paused globally."));
  const variantIds = source.variants.map(row => row.productVariantId);
  if (options.lock) {
    await client.query("SELECT id FROM catalog.products WHERE id=$1 FOR SHARE", [source.productId]);
    await client.query("SELECT id FROM catalog.product_variants WHERE id=ANY($1::integer[]) ORDER BY id FOR SHARE", [variantIds]);
    await client.query(`SELECT id FROM dropship.dropship_vendor_listings WHERE store_connection_id=$1
      AND product_variant_id=ANY($2::integer[]) ORDER BY id FOR SHARE`, [source.storeConnectionId, variantIds]);
  }
  const rawRows = await readDropshipEbayStockMemberRows(client, target?.id ?? null, variantIds);
  for (const raw of rawRows) if (raw.sku === null || raw.sku.trim() === "") blockers.push(blocker("STOCK_LISTING_SOURCE_CHANGED",
    "The catalog variant has no SKU. Review the product before publishing stock.", raw.id, "review_variant"));
  const members = reviewDropshipEbayStockMembers(source, target?.id ?? null, rawRows);
  blockers.push(...members.blockers);
  if (options.quantityReview && target && blockers.length === 0) {
    const proposal: PublicationMappingProposal = { mappings: [], newMappingVariantIds: [],
      identities: source.variants.map(member => ({ productVariantId: member.productVariantId,
        externalInventoryItemId: member.sku, externalSku: member.sku })) };
    const mappings: ActivePublicationVariantMappingSnapshot[] = [], missing: number[] = [];
    for (const input of source.variants) {
      const row = members.rows.find(candidate => candidate.id === input.productVariantId);
      if (row?.mapping_id != null && row.mapping_version != null && row.mapping_hash) mappings.push({ mappingId: row.mapping_id,
        productVariantId: input.productVariantId, version: row.mapping_version, definitionHash: row.mapping_hash,
        externalInventoryItemId: input.sku, externalSku: input.sku });
      else missing.push(input.productVariantId);
    }
    proposal.mappings = mappings; proposal.newMappingVariantIds = missing;
    const review = (await reviewMappingPreparation(client, { publicationTargetId: target.id, expectedTargetRevision: target.revision,
      productId: source.productId, productVariantIds: variantIds, allowRetainedZero: source.purpose === "sync" }, options.lock, proposal)).review;
    blockers.push(...review.blockers);
    for (const variant of members.variants) {
      const quantity = review.quantities.find(row => row.productVariantId === variant.productVariantId);
      if (quantity) variant.desiredQuantity = quantity.desiredQuantity;
      else if (!blockers.some(row => row.code === "STOCK_LISTING_QUANTITY_UNAVAILABLE" && row.productVariantId === variant.productVariantId))
        blockers.push(blocker("STOCK_LISTING_QUANTITY_UNAVAILABLE",
          "The canonical stock planner did not return this exact SKU. Review its active stock model and policy.", variant.productVariantId));
    }
  }
  return { target, liveTargetCount, blockers: uniqueBlockers(blockers), variants: members.variants, rows: members.rows,
    currentlyReady: blockers.length === 0 && members.variants.every(row => row.mappingAction === "none") };
}

/** reviewMappingPreparation repeats the destination's own blockers; report each once. */
function uniqueBlockers(blockers: readonly PublicationMembershipBlocker[]): PublicationMembershipBlocker[] {
  const seen = new Set<string>();
  return blockers.filter(row => {
    const key = `${row.code}:${row.productVariantId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
