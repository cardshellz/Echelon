import type { EbayProductSyncResult } from "@shared/types/ebay-listing-sync";
import type { EbayListingInspection } from "../marketplace-listings/domain/ebay-listing-inspection";
import type { QuantityPublicationScope } from "../inventory-planning/domain/quantity-publication-admission";
import { assertEbayListingSourceIdentityUnchanged } from "./ebay-existing-listing-identity";
import { EbayListingSyncError, syncStageHash, type EbayListingSyncIdentity } from "./ebay-listing-sync.domain";
import { completedEbayListingSyncResult, EbayExistingListingSyncExecution, type EbayListingSyncExecution, type PreparedEbayListingSync } from "./ebay-listing-sync.service";
import { syncContentIntentHash } from "./ebay-listing-sync-content";
import { assertEbayPublicationTargetUnchanged, resolveEbayPublicationTarget } from "./ebay-publication-completion.domain";
import type { EbayListingConnectorDraft, EbayMarketplaceListingConnector, EbayPublishedListingIdentityResolver } from "./listing-connectors/ebay-listing.connector";

export interface PreparedEbayPublication extends PreparedEbayListingSync {
  sourceIdentity: EbayListingSyncIdentity;
  draft: EbayListingConnectorDraft;
  inspection: EbayListingInspection;
  inspect(): Promise<EbayListingInspection>;
  assertInventoryReady(context?: { commandKey: string; actor: string }): Promise<void>;
  resolvePublishedIdentity: EbayPublishedListingIdentityResolver;
}
type PublicationRecovery = { reconcile(scopes: readonly QuantityPublicationScope[]): Promise<{ busy: boolean; resolved: string[]; unresolved: string[] }> };

/** Publication is an operation of the existing saved sync queue. The connector
 * owns provider primitives; inventory admission continues to own every write. */
export class EbayPublicationCompletionExecution implements EbayListingSyncExecution {
  constructor(private readonly prepare: (source: EbayListingSyncIdentity, target: EbayListingSyncIdentity | null) => Promise<PreparedEbayPublication>,
    private readonly recovery: PublicationRecovery, private readonly connector: EbayMarketplaceListingConnector,
    private readonly assertCompatible: (source: EbayListingSyncIdentity, inspection: EbayListingInspection, target: EbayListingSyncIdentity) => Promise<void>) {}

  async execute(...args: Parameters<EbayListingSyncExecution["execute"]>): Promise<EbayProductSyncResult> {
    const [source, stage, checkpoint, bindProviderIdentity, context] = args;
    if (context?.operation !== "publish" || !bindProviderIdentity)
      throw new EbayListingSyncError("EBAY_PUBLICATION_OWNER_REQUIRED", "Publication must run through its saved job and identity checkpoints.");
    const inventoryContext = context.jobId && context.requestedBy
      ? { commandKey: context.jobId, actor: context.requestedBy } : undefined;
    const prepared = await this.prepare(source, context.publicationTarget);
    assertEbayListingSourceIdentityUnchanged(source, prepared.sourceIdentity);
    const observed = resolveEbayPublicationTarget(source, prepared.inspection);
    const target = context.publicationTarget ?? { ...observed, variants: observed.variants.map(member => ({ ...member, listingId: null })) };
    assertEbayPublicationTargetUnchanged(target, observed);
    await context.bindPublicationTarget(target);
    await this.assertCompatible(source, prepared.inspection, target);

    // Published readback does not resolve an uncertain prior publish response.
    // The existing maintenance owner first reconciles immutable request evidence,
    // then verifies/adopts or updates current content without publishing again.
    const refreshRequested = context.publicationAcceptedRevision !== null
      && BigInt(context.claimedRevision) > BigInt(context.publicationAcceptedRevision);
    const changedContent = context.publicationIntentHash !== null && context.publicationIntentHash !== syncContentIntentHash(prepared.draft);
    if (prepared.inspection.publication && (refreshRequested || changedContent
      || (!context.publicationAccepted && !context.publicationWriteCompleted && !context.publicationWriteStarted))) {
      await prepared.assertInventoryReady(inventoryContext);
      return this.maintain(prepared, observed).execute(source, stage, checkpoint,
        identity => bindProviderIdentity(identity, prepared.inspection.publication!));
    }
    const scopes: QuantityPublicationScope[] = [
      ...(target.groupKey ? [{ sku: `group:${target.groupKey}`, variantId: null }] : []),
      ...target.variants.map(member => ({ sku: member.sku, variantId: member.variantId })),
    ].map(member => ({ destinationKind: "channel_connection", connectionId: target.connectionId, providerKey: "ebay",
      providerScopeType: "account", externalScopeId: target.accountId, externalInventoryItemId: member.sku,
      productId: target.productId, productVariantId: member.variantId }));
    const recovered = await this.recovery.reconcile(scopes);
    if (recovered.busy) throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY", "Waiting for an active inventory publisher before finishing this saved publication.");
    if (recovered.unresolved.length) throw new EbayListingSyncError("EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",
      `A prior publication request has no provable final response (attempts ${recovered.unresolved.join(", ")}). Review recovery and resume this saved publication before another write.`);
    let accepted = context.publicationAccepted;
    if (!accepted && !context.publicationWriteCompleted && !context.publicationWriteStarted) {
      // Validate the complete stock scope before even zero-quantity preparation
      // writes. Per-request inventory admission still owns quantity decisions.
      // Accepted publications can finish read-only verification without this gate.
      await prepared.assertInventoryReady(inventoryContext);
      const result = await this.connector.pushListing({ client: prepared.client, draft: prepared.draft,
        resolvePublishedIdentity: prepared.resolvePublishedIdentity, stage });
      if (!result.published || !result.externalProductId)
        throw new EbayListingSyncError("EBAY_SYNC_READBACK_PENDING", "eBay returned no confirmed publication identity. The saved job must verify its exact offers before completion.");
      accepted = { listingId: result.externalProductId, offerIds: result.externalOfferIds };
      await context.bindPublicationAccepted(accepted);
    }
    let verified: EbayListingSyncIdentity | undefined;
    await stage("publication_readback", syncStageHash(target), async () => {
      const inspection = await prepared.inspect();
      if (!inspection.publication) {
        const issue = inspection.skus.find(member => member.issue)?.issue;
        if (issue) throw new EbayListingSyncError(issue.code, issue.message);
        throw new EbayListingSyncError(accepted || context.publicationWriteCompleted ? "EBAY_PUBLICATION_READBACK_PENDING" : "EBAY_PUBLICATION_RESPONSE_UNCERTAIN", accepted || context.publicationWriteCompleted
          ? "eBay accepted the publication request, but its complete published listing is not visible yet. This saved job will check again."
          : "The saved publication attempt has no confirmed completion and eBay still reports unpublished offers. No second publish request was sent. Review this job's recovery details before authorizing another attempt.");
      }
      verified = resolveEbayPublicationTarget(source, inspection);
      assertEbayPublicationTargetUnchanged(target, verified);
      if (accepted && verified.variants.some(member => member.listingId !== accepted!.listingId
        || member.offerId !== accepted!.offerIds[member.variantId]))
        throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The published readback differs from eBay's saved acceptance response. Review the listing mapping before any further write.");
      await this.assertCompatible(source, inspection, verified);
      await bindProviderIdentity(verified, inspection.publication);
    });
    if (!verified) throw new EbayListingSyncError("EBAY_SYNC_READBACK_PENDING", "The published listing verification did not complete. Retry this saved job.");
    await stage("verification", syncContentIntentHash(prepared.draft), async () => {
      try {
        await this.connector.verifyExistingListing({ client: prepared.client, draft: prepared.draft, identity: verified!,
          offerIds: Object.fromEntries(verified!.variants.map(member => [member.variantId, member.offerId!])),
        });
      } catch (error) {
        if (error instanceof EbayListingSyncError && error.code === "EBAY_SYNC_READBACK_PENDING")
          throw new EbayListingSyncError("EBAY_PUBLICATION_READBACK_PENDING", "eBay's published listing is visible, but its accepted content and photos are still being verified. This saved publication will check again without republishing.", { cause: error });
        throw error;
      }
    });
    return completedEbayListingSyncResult({ ...prepared, identity: verified }, new Set());
  }

  private maintain(prepared: PreparedEbayPublication, identity: EbayListingSyncIdentity): EbayExistingListingSyncExecution {
    return new EbayExistingListingSyncExecution(async () => ({ ...prepared, identity }), this.recovery, this.connector);
  }
}

export class EbayListingOperationExecution implements EbayListingSyncExecution {
  constructor(private readonly sync: EbayListingSyncExecution, private readonly publish: EbayListingSyncExecution) {}
  execute(...args: Parameters<EbayListingSyncExecution["execute"]>): Promise<EbayProductSyncResult> {
    return (args[4]?.operation === "publish" ? this.publish : this.sync).execute(...args);
  }
}
