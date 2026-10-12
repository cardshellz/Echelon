import type { Pool, PoolClient } from "pg";
import { ebayPublicationStockResultSchema } from "@shared/types/ebay-publication-stock";
import type { InventoryEbayPublicationReadinessReceipt } from "@shared/types/ebay-publication-readiness";
import { findEbayPublicationReadinessReceipt, withEbayPublicationReadinessApplied, rejectEbayPublicationReadinessCommand } from "../../inventory-planning/quantity-publication";
import { PgMarketplaceListingRegistrationRepository, type UnpublishedMappingCompatibilityInput } from "../../marketplace-listings";
import { assertEbayListingSourceIdentityUnchanged } from "../ebay-existing-listing-identity";
import { EbayListingSyncError, type EbayListingSyncIdentity } from "../ebay-listing-sync.domain";
import { EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, ebayListingWorkflowLockKey } from "../ebay-listing-workflow-lock";
import type { EbayPublicationStockDependencies } from "../ebay-publication-stock.service";
import { assertEbayMappingOwnership } from "./ebay-listing-mapping-ownership";
import { PostgresEbayListingSyncRepository } from "./ebay-listing-sync.repository";
import { lockEbayListingSource } from "./ebay-listing-source-fence";

export class PostgresEbayPublicationStockRepository {
  private readonly jobs: PostgresEbayListingSyncRepository;
  private readonly registration: PgMarketplaceListingRegistrationRepository;
  constructor(private readonly pool: Pool, private readonly channelId: number,
    private readonly readSource: (productId: number, client: PoolClient) => Promise<EbayListingSyncIdentity>) {
    this.jobs = new PostgresEbayListingSyncRepository(pool);
    this.registration = new PgMarketplaceListingRegistrationRepository(pool);
  }

  async findApplied(input: Parameters<EbayPublicationStockDependencies["findApplied"]>[0]) {
    const receipt = await findEbayPublicationReadinessReceipt(this.pool, { channelId: this.channelId,
      productId: input.productId, commandKey: input.commandKey, actor: input.actor, contextHash: input.reviewHash });
    return receipt ? this.result(receipt, true) : null;
  }

  async readPreparationTarget(source: EbayListingSyncIdentity): Promise<EbayListingSyncIdentity | null> {
    const row = (await this.pool.query<{ id: string }>(`SELECT id::text FROM channels.ebay_listing_sync_jobs
      WHERE channel_id=$1 AND product_id=$2 AND operation='publish' AND publication_target IS NOT NULL
      ORDER BY created_at DESC,id DESC LIMIT 1`, [source.channelId, source.productId])).rows[0];
    if (!row) return null;
    const job = await this.jobs.get(row.id);
    assertEbayListingSourceIdentityUnchanged(job.identity, source);
    if (job.publicationAccepted || job.publicationWriteCompleted || job.publicationWriteStarted)
      throw Object.assign(new EbayListingSyncError("EBAY_PUBLICATION_PRIOR_WORK_REQUIRED",
        "This product already has a publication attempt. Open its saved recovery before authorizing another publication."), { jobId: job.id });
    return job.publicationTarget;
  }

  async commit(input: Parameters<EbayPublicationStockDependencies["commit"]>[0]) {
    const { source, inventory, command, actor, now } = input;
    const identity = source.sourceIdentity;
    const compatibility: UnpublishedMappingCompatibilityInput = {
      owner: { kind: "channel", channelId: identity.channelId, productId: identity.productId, provider: "ebay", marketplaceId: identity.marketplaceId },
      providerAccount: { provider: "ebay", accountNamespace: source.inventorySource.environment, externalAccountId: identity.accountId },
      groupKey: source.targetIdentity.groupKey,
      members: source.targetIdentity.variants.map(member => ({ productVariantId: member.variantId, sku: member.sku, offerId: member.offerId })),
    };
    const beforeCapture = async (client: PoolClient) => {
      // Inventory's fence precedes listing locks. Never wait while holding it
      // for a worker that may itself need inventory admission: fail and roll back.
      for (const key of [`enqueue:${identity.channelId}:${identity.productId}`, `command:${command.commandKey}`,
        ebayListingWorkflowLockKey(identity.channelId, identity.productId)]) {
        const acquired = (await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS acquired", [EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, key])).rows[0]?.acquired;
        if (!acquired) throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY", "This product has a listing change in progress. Wait for it to finish, then retry this saved request.");
      }
      // Match registration's account -> catalog ordering BEFORE inventory's
      // proposal takes shared catalog locks. Otherwise registration can deadlock.
      await this.registration.acquireUnpublishedCompatibilityLocks(compatibility, client);
      await client.query("LOCK TABLE channels.channel_listings IN SHARE ROW EXCLUSIVE MODE");
      await lockEbayListingSource(client, identity, source.inventorySource.environment);
    };
    const outcome = await withEbayPublicationReadinessApplied(this.pool, { source: source.inventorySource,
      expectedReviewHash: inventory.reviewHash, contextHash: command.expectedReviewHash, commandKey: command.commandKey }, actor, now,
    async (client, receipt) => {
      if (receipt.alreadyApplied) return this.result(receipt, true, client);
      try { assertEbayListingSourceIdentityUnchanged(identity, await this.readSource(identity.productId, client)); }
      catch (error) {
        if (error instanceof EbayListingSyncError && error.code === "EBAY_SYNC_IDENTITY_CHANGED")
          throw new EbayListingSyncError("EBAY_PUBLICATION_STOCK_SOURCE_CHANGED", "The saved catalog or eBay mapping changed. Review the publication again.", { cause: error });
        throw error;
      }
      await this.registration.assertCompatibleUnpublishedPublication(compatibility, client);
      await assertEbayMappingOwnership(source.targetIdentity, client);
      // Keep raw saved identifiers (including null external_sku) separately
      // from the exact reviewed provider target the worker must continue.
      await this.jobs.enqueueInsideTransaction(client, { ...identity, groupKey: source.targetIdentity.groupKey }, command.commandKey,
        actor, now, undefined, "publish", source.targetIdentity);
      return this.result(receipt, false, client);
    }, beforeCapture);
    return outcome.result;
  }

  async reject(input: Parameters<EbayPublicationStockDependencies["reject"]>[0]) {
    const receipt = await rejectEbayPublicationReadinessCommand(this.pool, { channelId: this.channelId,
      productId: input.productId, commandKey: input.command.commandKey, actor: input.actor,
      contextHash: input.command.expectedReviewHash, code: input.code, message: input.message.slice(0, 1000) }, input.now);
    return this.result(receipt, true);
  }

  private async result(receipt: InventoryEbayPublicationReadinessReceipt, replayed: boolean, client?: PoolClient) {
    const job = await this.jobs.getByCommand(receipt.commandKey, receipt.channelId, client);
    if (!job || job.productId !== receipt.productId || job.operation !== "publish")
      throw new EbayListingSyncError("EBAY_PUBLICATION_STOCK_RECEIPT_INCOMPLETE", "The stock setup receipt is missing its saved publication request. Keep this command reference for investigation; do not submit another publication.");
    return ebayPublicationStockResultSchema.parse({ job, replayed, receipt: { commandKey: receipt.commandKey,
      productId: receipt.productId, reviewHash: receipt.contextHash, appliedAt: receipt.appliedAt } });
  }
}
