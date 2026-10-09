import { z } from "zod";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import { ebayPublicationRecoveryConfirmationSchema } from "@shared/types/ebay-publication-recovery";
import type { EbayProductSyncResult } from "@shared/types/ebay-listing-sync";
import type { EbayPublicationRecoveryService } from "../inventory-planning/quantity-publication";
import type { QuantityPublicationScope } from "../inventory-planning/domain/quantity-publication-admission";
import { EbayListingSyncError, type StoredEbayListingSyncJob } from "./ebay-listing-sync.domain";
import { ebayListingSyncIdentitySchema, type EbayListingSyncIdentity } from "./ebay-listing-sync.domain";
import type { EbayListingSyncService } from "./ebay-listing-sync.service";

/** Listing diagnostics translate a saved job into inventory-owned recovery scopes.
 * This owner never rewrites provider evidence or chooses a quantity. */
export class EbayListingRecoveryService {
  constructor(
    private readonly jobs: Pick<EbayListingSyncService, "get" | "getByCommand" | "getAdmission">,
    private readonly recovery: Pick<EbayPublicationRecoveryService, "preview" | "resume">,
    private readonly enqueue: (productId: number, actor: string, commandKey: string) => Promise<EbayProductSyncResult>,
    private readonly readProductIdentity?: (productId: number) => Promise<EbayListingSyncIdentity>,
  ) {}

  async inspect(id: string, channelId: number) {
    z.string().uuid().parse(id);
    try {
      const stored = await this.ownedJob(id, channelId);
      return { job: this.publicJob(stored), sourceIdentity: stored.identity, providerIdentity: stored.providerIdentity };
    } catch (error) {
      if (!(error instanceof EbayListingSyncError) || error.code !== "EBAY_SYNC_JOB_NOT_FOUND") throw error;
      const joined = await this.jobs.getByCommand(id, channelId);
      if (joined) {
        if (joined.identity.channelId !== channelId) throw error;
        return { job: this.publicJob(joined), sourceIdentity: joined.identity, providerIdentity: joined.providerIdentity };
      }
      const admission = await this.jobs.getAdmission(id, channelId);
      if (!admission) throw error;
      return { job: admission, sourceIdentity: null, providerIdentity: null };
    }
  }

  async preview(id: string, channelId: number) {
    const job = await this.ownedJob(id, channelId);
    return { ...(await this.recovery.preview(this.scopes(job))), jobId: job.id, productId: job.productId };
  }

  async resume(id: string, channelId: number, actor: string, input: unknown) {
    const command = ebayPublicationRecoveryConfirmationSchema.extend({ idempotencyKey: z.string().uuid() }).parse(input);
    const job = await this.ownedJob(id, channelId);
    const result = await this.recovery.resume({ ...command, scopes: this.scopes(job), actor });
    try {
      // The receipt commits first. If the process stops here, the already durable
      // blocked job will retry; replaying this command also safely retries enqueue.
      const queued = await this.enqueue(job.productId, actor, command.idempotencyKey);
      const next = queued.jobs.find(member => member.productId === job.productId);
      if (!next) throw new Error("Canonical sync admission did not save a result.");
      // A durable admission rejection is a real result: correct it and request
      // a NEW sync, rather than retrying a command key already bound to rejection.
      return { ...result, job: next };
    } catch (cause) {
      throw new EbayListingSyncError("EBAY_RECOVERY_FOLLOWUP_PENDING",
        "Recovery was authorized and saved, but the immediate sync could not be queued. The saved blocked update remains available. Refresh its status; retry this same recovery confirmation to resume queueing without changing the old receipt.", { cause });
    }
  }

  async inspectProduct(productId: number, channelId: number) {
    const sourceIdentity = await this.productIdentity(productId, channelId);
    return { job: null, productId, sourceIdentity, providerIdentity: null };
  }

  async previewProduct(productId: number, channelId: number) {
    const identity = await this.productIdentity(productId, channelId);
    return { ...(await this.recovery.preview(this.identityScopes(identity))), jobId: null, productId };
  }

  async resumeProduct(productId: number, channelId: number, actor: string, input: unknown) {
    const command = ebayPublicationRecoveryConfirmationSchema.extend({ idempotencyKey: z.string().uuid() }).parse(input);
    const identity = await this.productIdentity(productId, channelId);
    const result = await this.recovery.resume({ ...command, scopes: this.identityScopes(identity), actor });
    // An initial publication has no saved maintenance job. The UI explicitly
    // requests Publish after this audited decision; recovery itself never sends it.
    return { ...result, job: null, productId, nextAction: "retry_publish" as const };
  }

  private async productIdentity(productId: number, channelId: number): Promise<EbayListingSyncIdentity> {
    z.number().int().positive().max(2147483647).parse(productId);
    if (!this.readProductIdentity) throw new EbayListingSyncError("EBAY_SYNC_SCOPE_UNAVAILABLE", "Product recovery is not configured.");
    const identity = ebayListingSyncIdentitySchema.parse(await this.readProductIdentity(productId));
    if (identity.productId !== productId || identity.channelId !== channelId)
      throw new EbayListingSyncError("EBAY_SYNC_SCOPE_UNAVAILABLE", "This recovery identity does not belong to the selected product and channel.");
    return identity;
  }

  private async ownedJob(id: string, channelId: number): Promise<StoredEbayListingSyncJob> {
    const job = await this.jobs.get(z.string().uuid().parse(id));
    if (job.identity.channelId !== channelId) throw new EbayListingSyncError("EBAY_SYNC_JOB_NOT_FOUND", "The listing sync job was not found.");
    return job;
  }

  private scopes(job: StoredEbayListingSyncJob): QuantityPublicationScope[] {
    const identity = job.providerIdentity ?? job.identity;
    // Older source group keys were catalog-derived guesses. Only a provider
    // observation can authorize including a group in this recovery's scope.
    return this.identityScopes({ ...identity, groupKey: job.providerIdentity?.groupKey ?? null });
  }

  private identityScopes(identity: EbayListingSyncIdentity): QuantityPublicationScope[] {
    const keys = [...(identity.groupKey ? [{ sku: `group:${identity.groupKey}`, variantId: null }] : []),
      ...identity.variants.map(member => ({ sku: member.sku, variantId: member.variantId }))];
    return keys.map(member => ({ destinationKind: "channel_connection", connectionId: identity.connectionId,
      providerKey: "ebay", providerScopeType: "account", externalScopeId: identity.accountId, externalInventoryItemId: member.sku,
      productId: identity.productId, productVariantId: member.variantId }));
  }

  private publicJob(job: StoredEbayListingSyncJob) {
    const { id, kind, productId, state, code, message, nextAttemptAt, updatedAt } = job;
    return { id, kind, productId, state, code, message, nextAttemptAt, updatedAt,
      ...(code ? { issue: resolveEbayListingIssue({ code, message, productId, jobId: id, state }) } : {}) };
  }
}
