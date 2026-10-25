import type { PoolClient } from "pg";
import type { InventoryEbayPublicationReadinessInput } from "@shared/types/ebay-publication-readiness";
import { readCatalogStockProductVariantIds } from "../catalog/catalog-stock-selection.reader";
import { PgMarketplaceListingRegistrationRepository, type MarketplaceObservedListingPublication } from "../marketplace-listings";
import { readChannelStockSelectionFacts } from "./infrastructure/channel-stock-selection.repository";
import { resolveChannelStockSelection } from "./channel-stock-selection.domain";
import { assertEbayListingSourceIdentityUnchanged, bindObservedEbayListingMembers, captureEbayListingSourceIdentity } from "./ebay-existing-listing-identity";
import { assertEbayPublicationObservation } from "./ebay-publication-observation";
import { EbayListingSyncError, ebayListingSyncIdentitySchema, syncStageHash, type EbayListingSyncIdentity } from "./ebay-listing-sync.domain";
import { lockEbayListingSource } from "./infrastructure/ebay-listing-source-fence";

/** Internal evidence from the existing Channels observation/binding owner. It
 * authorizes only this listing's preparation, never retirement of other stock. */
export interface VerifiedEbayListingPreparation {
  sourceIdentity: EbayListingSyncIdentity;
  observation: MarketplaceObservedListingPublication;
}

const changed = (): never => { throw new EbayListingSyncError("EBAY_SYNC_PREPARATION_SCOPE_CHANGED",
  "The verified listing stock scope changed. Recheck the saved listing before preparing inventory."); };

export function validateEbayListingPreparationScope(input: InventoryEbayPublicationReadinessInput, proof: VerifiedEbayListingPreparation) {
  const source = ebayListingSyncIdentitySchema.parse(proof.sourceIdentity);
  const identity = bindObservedEbayListingMembers(source, proof.observation);
  const observation = assertEbayPublicationObservation(identity, proof.observation);
  const stockMembers = identity.variants.filter(member => !member.catalogArchived);
  if (input.purpose !== "sync" || source.channelId !== input.channelId || source.connectionId !== input.connectionId
    || source.accountId !== input.accountId || source.productId !== input.productId
    || observation.providerAccount.accountNamespace !== input.environment
    || input.variants.length !== stockMembers.length || input.variants.some(member =>
      !stockMembers.some(bound => bound.variantId === member.productVariantId && bound.sku === member.sku))) changed();
  // Observation timestamps and quantities are not command identity. Every retry
  // must validate fresh evidence, but unchanged membership replays one receipt.
  const ordered = (value: EbayListingSyncIdentity) => ({ ...value, variants: [...value.variants].sort((a, b) => a.variantId - b.variantId) });
  return { source, identity, observation, fingerprint: syncStageHash({ source: ordered(source), identity: ordered(identity),
    environment: input.environment }), productVariantIds: stockMembers.map(member => member.variantId).sort((a, b) => a - b) };
}

/** Acquire the established registration-account prefix and source fence before
 * Inventory takes target/mapping locks. This also fences new FK-linked rows. */
export async function lockEbayListingPreparationScope(client: PoolClient, input: InventoryEbayPublicationReadinessInput,
  proof: VerifiedEbayListingPreparation): Promise<void> {
  const verified = validateEbayListingPreparationScope(input, proof);
  await new PgMarketplaceListingRegistrationRepository().acquireMappingCompatibilityLocks({
    owner: { kind: "channel", channelId: input.channelId, productId: input.productId, provider: "ebay", marketplaceId: verified.identity.marketplaceId },
    observation: verified.observation, memberCandidates: verified.source.variants.map(member => ({ productVariantId: member.variantId,
      sku: member.sku, isActive: member.contentSyncEnabled !== false, availableQuantity: 0 })),
  }, client);
  await lockEbayListingSource(client, verified.source, input.environment);
}

/** Published Channels reader using the caller's transaction. The binder owns
 * provider nonmembership; Channels rechecks the complete saved local scope. */
export async function readEbayListingPreparationScope(client: PoolClient, input: InventoryEbayPublicationReadinessInput,
  proof: VerifiedEbayListingPreparation, lock: boolean) {
  const verified = validateEbayListingPreparationScope(input, proof);
  if (lock) await lockEbayListingPreparationScope(client, input, proof);
  const allVariantIds = await readCatalogStockProductVariantIds(client, input.productId);
  const facts = await readChannelStockSelectionFacts(client, { channelId: input.channelId, channelConnectionId: input.connectionId,
    productId: input.productId, productVariantIds: allVariantIds });
  const listings = (await client.query<{ product_variant_id: number; external_sku: string | null; external_variant_id: string | null; external_product_id: string | null }>(
    `SELECT product_variant_id,external_sku,external_variant_id,external_product_id FROM channels.channel_listings
      WHERE channel_id=$1 AND product_variant_id=ANY($2::integer[])
        AND(sync_status='synced' OR external_product_id IS NOT NULL OR external_variant_id IS NOT NULL OR external_sku IS NOT NULL)
      ORDER BY id ${lock ? "FOR SHARE" : ""}`, [input.channelId, allVariantIds])).rows;
  const selection = resolveChannelStockSelection(facts);
  const current = captureEbayListingSourceIdentity(listings.map(listing => {
    const variant = facts.catalog.variants.find(row => row.id === listing.product_variant_id);
    const decision = selection.variants.find(row => row.productVariantId === listing.product_variant_id);
    if (!variant || !facts.catalog.product || decision?.blockers.length) return changed();
    return { product_id: input.productId, variant_id: listing.product_variant_id, variant_sku: variant.sku,
      external_sku: listing.external_sku, external_variant_id: listing.external_variant_id, external_product_id: listing.external_product_id,
      product_is_active: facts.catalog.product.isActive, variant_is_active: variant.isActive, variant_sales_eligibility: variant.salesEligibility,
      product_status: facts.catalog.product.status,
      product_excluded: facts.catalog.product.ebayListingExcluded, variant_excluded: variant.ebayListingExcluded,
      product_override_is_listed: facts.productIsListed, type_listing_enabled: facts.typeListingEnabled,
      variant_override_is_listed: facts.variants.find(row => row.productVariantId === variant.id)?.variantIsListed };
  }), verified.source);
  assertEbayListingSourceIdentityUnchanged(verified.source, current);
  for (const member of verified.source.variants.filter(member => !verified.productVariantIds.includes(member.variantId))) {
    const expected = member.catalogArchived ? "none" : "zero";
    if (selection.variants.find(row => row.productVariantId === member.variantId)?.action !== expected) changed();
  }
  return { ...verified, selectionFingerprint: selection.fingerprint };
}
