import type { EbayProductSyncResult } from "@shared/types/ebay-listing-sync";
import type { EbayListingInspection } from "../marketplace-listings/domain/ebay-listing-inspection";
import type { EbayAutomaticPublicationRecoveryService } from "../inventory-planning/quantity-publication";
import { assertEbayListingSourceIdentityUnchanged } from "./ebay-existing-listing-identity";
import { EbayListingSyncError, syncStageHash, type EbayListingSyncIdentity } from "./ebay-listing-sync.domain";
import { completedEbayListingSyncResult, EbayExistingListingSyncExecution, type EbayListingSyncExecution, type PreparedEbayListingSync } from "./ebay-listing-sync.service";
import { syncContentIntentHash } from "./ebay-listing-sync-content";
import { assertEbayPublicationTargetUnchanged, resolveEbayPublicationTarget } from "./ebay-publication-completion.domain";
import type { EbayListingConnectorDraft, EbayMarketplaceListingConnector, EbayPublishedListingIdentityResolver } from "./listing-connectors/ebay-listing.connector";
import { recoverPriorEbayListingRequests, type EbayListingRequestRecovery } from "./ebay-listing-request-recovery";
import { EbayApiRequestError } from "./adapters/ebay/ebay-api-error";
import { QuantityProviderRequestTimeoutError } from "./provider-request-limits";

export interface PreparedEbayPublication extends PreparedEbayListingSync {
  sourceIdentity: EbayListingSyncIdentity;
  draft: EbayListingConnectorDraft;
  inspection: EbayListingInspection;
  inspect(): Promise<EbayListingInspection>;
  assertInventoryReady(context?: { commandKey: string; actor: string }): Promise<void>;
  resolvePublishedIdentity: EbayPublishedListingIdentityResolver;
}
/** Publication is an operation of the existing saved sync queue. The connector
 * owns provider primitives; inventory admission continues to own every write. */
export class EbayPublicationCompletionExecution implements EbayListingSyncExecution {
  constructor(private readonly prepare: (source: EbayListingSyncIdentity, target: EbayListingSyncIdentity | null) => Promise<PreparedEbayPublication>,
    private readonly recovery: EbayListingRequestRecovery, private readonly connector: EbayMarketplaceListingConnector,
    private readonly assertCompatible: (source: EbayListingSyncIdentity, inspection: EbayListingInspection, target: EbayListingSyncIdentity) => Promise<void>,
    private readonly automaticRecovery?: Pick<EbayAutomaticPublicationRecoveryService, "recover">) {}

  async execute(...args: Parameters<EbayListingSyncExecution["execute"]>): Promise<EbayProductSyncResult> {
    const [source, stage, checkpoint, bindProviderIdentity, context] = args;
    if (context?.operation !== "publish" || !bindProviderIdentity)
      throw new EbayListingSyncError("EBAY_PUBLICATION_OWNER_REQUIRED", "Publication must run through its saved job and identity checkpoints.");
    const inventoryContext = context.jobId && context.requestedBy
      ? { commandKey: context.jobId, actor: context.requestedBy } : undefined;
    let prepared!: PreparedEbayPublication;
    await stage("prepare_listing", syncStageHash(source), async () => {
      prepared = await this.prepare(source, context.publicationTarget);
    });
    assertEbayListingSourceIdentityUnchanged(source, prepared.sourceIdentity);
    const observed = resolveEbayPublicationTarget(source, prepared.inspection);
    const target = context.publicationTarget ?? { ...observed, variants: observed.variants.map(member => ({ ...member, listingId: null })) };
    assertEbayPublicationTargetUnchanged(target, observed);
    await context.bindPublicationTarget(target);
    await this.assertCompatible(source, prepared.inspection, target);
    if (prepared.draft.preparedIntent) {
      if (!context.persistPreparedIntent) throw new EbayListingSyncError("EBAY_PUBLICATION_OWNER_REQUIRED", "The prepared listing requires its saved-job evidence owner.");
      await context.persistPreparedIntent(prepared.draft.preparedIntent);
    }

    // A retained start is a delivery barrier, not proof that eBay accepted it.
    // Inventory can prove rejection or that publication was never sent, even
    // when an earlier stock preparation has its own completed request receipt.
    // The job owner commits that evidence before continuing the same request.
    let publicationWriteStarted = context.publicationWriteStarted;
    if (publicationWriteStarted && !context.publicationWriteCompleted && !context.publicationAccepted
      && context.recoverTerminalPublicationWrite) {
      publicationWriteStarted = !await context.recoverTerminalPublicationWrite(observed);
    }

    // Published readback does not resolve an uncertain prior publish response.
    // The existing maintenance owner first reconciles immutable request evidence,
    // then verifies/adopts or updates current content without publishing again.
    const refreshRequested = context.publicationAcceptedRevision !== null
      && BigInt(context.claimedRevision) > BigInt(context.publicationAcceptedRevision);
    const changedContent = context.publicationIntentHash !== null && context.publicationIntentHash !== syncContentIntentHash(prepared.draft);
    if (prepared.inspection.publication && (refreshRequested || changedContent
      || (!context.publicationAccepted && !context.publicationWriteCompleted && !publicationWriteStarted))) {
      return this.maintain(prepared, observed).execute(source, stage, checkpoint,
        identity => bindProviderIdentity(identity, prepared.inspection.publication!), context);
    }
    await stage("recover_prior_requests", syncStageHash(target), async () => {
      await recoverPriorEbayListingRequests({ identity: target, recovery: this.recovery,
        automaticRecovery: this.automaticRecovery, context });
    });
    let accepted = context.publicationAccepted;
    if (!accepted && !context.publicationWriteCompleted && !publicationWriteStarted) {
      // Validate the complete stock scope before even zero-quantity preparation
      // writes. Per-request inventory admission still owns quantity decisions.
      // Accepted publications can finish read-only verification without this gate.
      await stage("prepare_inventory", syncContentIntentHash(prepared.draft), () => prepared.assertInventoryReady(inventoryContext));
      let result: Awaited<ReturnType<EbayMarketplaceListingConnector["pushListing"]>>;
      try {
        result = await this.connector.pushListing({ client: prepared.client, draft: prepared.draft,
          resolvePublishedIdentity: prepared.resolvePublishedIdentity, stage });
      } catch (error) {
        // Keep actual business refusals actionable. A proved pre-send temporary
        // read failure retries automatically; an escaped write remains fenced.
        let recovered: "rejected" | "not_sent" | null = null;
        try {
          if (context.recoverTerminalPublicationWrite) {
            const current = observed.variants.some(member => member.offerId === null)
              ? resolveEbayPublicationTarget(source, await prepared.inspect()) : observed;
            recovered = await context.recoverTerminalPublicationWrite(current);
          }
        }
        catch (recoveryError) {
          throw new EbayListingSyncError("EBAY_SYNC_PERSISTENCE_FAILED",
            "The publication response could not be recorded completely. The saved request will check it again before another write.",
            { cause: new AggregateError([error, recoveryError], "Publication outcome recovery failed.") });
        }
        if (recovered === "not_sent" && isTemporaryPublicationPreflightFailure(error)) {
          throw new EbayListingSyncError("EBAY_PUBLICATION_PREFLIGHT_RETRY",
            "eBay could not finish the check before publishing. No publication was sent. Echelon will retry this saved update automatically.", { cause: error });
        }
        throw error;
      }
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
    return new EbayExistingListingSyncExecution(async () => ({ ...prepared, identity }), this.recovery, this.connector, this.automaticRecovery);
  }
}

function isTemporaryPublicationPreflightFailure(error: unknown): boolean {
  if (error instanceof EbayApiRequestError) return error.statusCode === 429
    || (error.statusCode !== undefined && error.statusCode >= 500 && error.statusCode <= 599);
  // Node HTTPS wraps this application's deadline reason in AbortError. A
  // generic cancellation is not enough; only our explicit deadline is transient.
  if (error instanceof Error && "code" in error && error.code === "ABORT_ERR"
    && error.cause instanceof QuantityProviderRequestTimeoutError) return true;
  return error instanceof Error && "code" in error && typeof error.code === "string"
    && ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "QUANTITY_PROVIDER_REQUEST_TIMEOUT",
      "EBAY_REGISTRATION_READ_TIMEOUT", "EBAY_REGISTRATION_READ_FAILED"].includes(error.code);
}

export class EbayListingOperationExecution implements EbayListingSyncExecution {
  constructor(private readonly sync: EbayListingSyncExecution, private readonly publish: EbayListingSyncExecution) {}
  execute(...args: Parameters<EbayListingSyncExecution["execute"]>): Promise<EbayProductSyncResult> {
    return (args[4]?.operation === "publish" ? this.publish : this.sync).execute(...args);
  }
}
