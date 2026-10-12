import type { EbayListingInspection } from "../marketplace-listings/domain/ebay-listing-inspection";
import type { QuantityPublicationScope } from "../inventory-planning/domain/quantity-publication-admission";
import { assertEbayListingSourceIdentityUnchanged } from "./ebay-existing-listing-identity";
import { resolveEbayPublicationTarget, assertEbayPublicationTargetUnchanged } from "./ebay-publication-completion.domain";
import { EbayListingSyncError, syncIdentityHash, type EbayListingSyncIdentity } from "./ebay-listing-sync.domain";
import type { EbayListingSyncExecution } from "./ebay-listing-sync.service";

export interface PreparedEbayWithdrawal {
  sourceIdentity: EbayListingSyncIdentity;
  inspect(): Promise<EbayListingInspection>;
  client: {
    withdrawOffer(id: string): Promise<void>;
    withdrawOfferByInventoryItemGroup(group: string, marketplace: string): Promise<void>;
  };
}

/** Uses canonical observed topology; a renamed Catalog SKU never addresses a withdrawal. */
export function resolveEbayWithdrawalIdentity(
  source: EbayListingSyncIdentity,
  inspection: EbayListingInspection,
  previous?: EbayListingSyncIdentity | null,
): EbayListingSyncIdentity {
  if (source.variants.some(member => !member.offerId))
    throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID", "Every saved eBay variant needs its exact offer ID before this listing can be withdrawn. Review its mapping.");
  // UNPUBLISHED responses omit historical listing IDs. Verify the same exact
  // offers and topology, retaining previous IDs in the immutable audit binding.
  const current = resolveEbayPublicationTarget({ ...source, groupKey: null,
    variants: source.variants.map(member => ({ ...member, listingId: null })),
  }, inspection);
  const publishedListingId = inspection.publication?.listingIdentity.externalId;
  if (publishedListingId && source.variants.some(member => member.listingId !== null && member.listingId !== publishedListingId))
    throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The live eBay listing differs from this product's saved listing. Review its mapping before withdrawal.");
  const savedById = new Map(source.variants.map(member => [member.variantId, member]));
  const previousById = new Map(previous?.variants.map(member => [member.variantId, member]));
  return { ...current, variants: current.variants.map(member => {
    const saved = savedById.get(member.variantId)!;
    return { ...member, externalSku: saved.externalSku,
      listingId: saved.listingId ?? member.listingId ?? previousById.get(member.variantId)?.listingId ?? null };
  }) };
}

export class EbayListingWithdrawalExecution implements EbayListingSyncExecution {
  constructor(
    private readonly prepare: (source: EbayListingSyncIdentity) => Promise<PreparedEbayWithdrawal>,
    private readonly recovery: {
      reconcile(scopes: readonly QuantityPublicationScope[]): Promise<{ busy: boolean; resolved: string[]; unresolved: string[] }>;
    },
  ) {}

  async execute(...args: Parameters<EbayListingSyncExecution["execute"]>) {
    const [source, stage, _checkpoint, bind, context] = args;
    if (context?.operation !== "withdraw" || !bind)
      throw new EbayListingSyncError("EBAY_WITHDRAWAL_OWNER_REQUIRED", "Withdrawal requires its saved listing job.");
    const prepared = await this.prepare(source);
    assertEbayListingSourceIdentityUnchanged(source, prepared.sourceIdentity);
    const inspection = await prepared.inspect();
    const identity = resolveEbayWithdrawalIdentity(source, inspection, context.providerIdentity);
    if (context.providerIdentity) assertEbayPublicationTargetUnchanged(context.providerIdentity, identity);
    await bind(identity);

    const members = [
      ...(identity.groupKey ? [{ sku: `group:${identity.groupKey}`, variantId: null }] : []),
      ...identity.variants.map(member => ({ sku: member.sku, variantId: member.variantId })),
    ];
    const scopes: QuantityPublicationScope[] = members.map(member => ({
      destinationKind: "channel_connection", connectionId: identity.connectionId, providerKey: "ebay", providerScopeType: "account",
      externalScopeId: identity.accountId, externalInventoryItemId: member.sku, productId: identity.productId, productVariantId: member.variantId,
    }));
    const recovered = await this.recovery.reconcile(scopes);
    if (recovered.busy)
      throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY", "Waiting for the current inventory request before withdrawing this listing.");
    if (recovered.unresolved.length)
      throw new EbayListingSyncError("EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED", `A prior inventory request needs recovery (attempts ${recovered.unresolved.join(", ")}). Review recovery to resume this saved withdrawal.`);

    if (inspection.publication && context.withdrawalWriteStarted && !context.withdrawalWriteCompleted)
      throw new EbayListingSyncError("EBAY_WITHDRAWAL_RESPONSE_UNCERTAIN", "The saved withdrawal started, but its completion could not be recorded. Review its recovery before authorizing another attempt; the worker will check the existing listing first.");

    if (inspection.publication && !context.withdrawalWriteCompleted) {
      await stage("withdraw", syncIdentityHash(identity), async () => {
        if (identity.groupKey) await prepared.client.withdrawOfferByInventoryItemGroup(identity.groupKey, identity.marketplaceId);
        else await prepared.client.withdrawOffer(identity.variants[0].offerId!);
      });
    }
    await stage("verification", syncIdentityHash(identity), async () => {
      const latest = await prepared.inspect();
      const current = resolveEbayWithdrawalIdentity(source, latest, identity);
      assertEbayPublicationTargetUnchanged(identity, current);
      if (latest.publication || latest.skus.some(member => member.offers.some(offer => offer.status !== "UNPUBLISHED")))
        throw new EbayListingSyncError("EBAY_WITHDRAWAL_READBACK_PENDING", "eBay has not yet confirmed that every exact offer is unpublished. This saved withdrawal will check again.");
    });
    return { synced: 0, priceChanges: 0, qtyChanges: 0, policyChanges: 0, errors: 0, pending: 0, jobs: [],
      details: identity.variants.map(member => ({ success: true, productId: source.productId, variantId: member.variantId, variantSku: member.sku })) };
  }
}

export class EbayWithdrawalOperationExecution implements EbayListingSyncExecution {
  constructor(private readonly listing: EbayListingSyncExecution, private readonly withdrawal: EbayListingSyncExecution) {}
  execute(...args: Parameters<EbayListingSyncExecution["execute"]>) {
    return (args[4]?.operation === "withdraw" ? this.withdrawal : this.listing).execute(...args);
  }
}
