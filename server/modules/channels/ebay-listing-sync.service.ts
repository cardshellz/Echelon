import { z } from "zod";
import type { MarketplaceObservedListingPublication } from "../marketplace-listings";
import type {
  EbayProductSyncResult,
  EbayListingSyncJob,
} from "@shared/types/ebay-listing-sync";
import { ebayProductSyncResultSchema } from "@shared/types/ebay-listing-sync";
import {
  ebayListingSyncIdentitySchema,
  EbayListingSyncError,
  syncFailure,
  syncIdentityHash,
  type EbayListingSyncIdentity,
  type StoredEbayListingSyncJob,
  type EbayPublicationAccepted,
  type EbayPublicationRetryAuthorization,
} from "./ebay-listing-sync.domain";
import {
  EbayMarketplaceListingConnector,
  type EbayListingConnectorDraft,
  type EbayListingLifecycleClient,
} from "./listing-connectors/ebay-listing.connector";
import { syncContentIntentHash } from "./ebay-listing-sync-content";
import type { QuantityPublicationScope } from "../inventory-planning/domain/quantity-publication-admission";
import { assertEbayListingSourceIdentityUnchanged } from "./ebay-existing-listing-identity";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import { ebayListingFailureDiagnostic, type EbayListingFailureDiagnostic } from "./ebay-listing-failure-diagnostic";

export interface PreparedEbayListingSync {
  sourceIdentity?: EbayListingSyncIdentity;
  identity: EbayListingSyncIdentity;
  assertInventoryReady?(context?: { commandKey: string; actor: string }): Promise<void>;
  client: EbayListingLifecycleClient;
  draft: Pick<
    EbayListingConnectorDraft,
    "productId" | "marketplaceId" | "inventoryItems" | "offers" | "itemGroup"
  >;
  variants: Array<{
    variantId: number;
    sku: string;
    productName: string;
    priceCents: number;
    priceChanged: boolean;
  }>;
}
export class EbayExistingListingSyncExecution
  implements EbayListingSyncExecution
{
  constructor(
    private readonly prepare: (
      identity: EbayListingSyncIdentity,
    ) => Promise<PreparedEbayListingSync>,
    private readonly recovery: {
      reconcile(
        scopes: readonly QuantityPublicationScope[],
      ): Promise<{ busy: boolean; resolved: string[]; unresolved: string[] }>;
    },
    private readonly connector: EbayMarketplaceListingConnector,
  ) {}
  async execute(
    identity: EbayListingSyncIdentity,
    stage: Parameters<EbayListingSyncExecution["execute"]>[1],
    verificationIntentHash: string | null = null,
    bindProviderIdentity?: (identity: EbayListingSyncIdentity) => Promise<void>,
    context?: EbayListingExecutionContext,
  ): Promise<EbayProductSyncResult> {
    let prepared!: PreparedEbayListingSync;
    await stage("prepare_listing", syncIdentityHash(identity), async () => {
      prepared = await this.prepare(identity);
    });
    if (prepared.sourceIdentity) {
      assertEbayListingSourceIdentityUnchanged(identity, prepared.sourceIdentity);
    } else if (syncIdentityHash(identity) !== syncIdentityHash(prepared.identity)) {
      // Legacy callers provide an already resolved identity. Its group is part
      // of the provider identity and cannot be treated as a catalog hint.
      throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The listing mapping changed. Start a new sync with the current mapping.");
    }
    const resolvedIdentity = ebayListingSyncIdentitySchema.parse(prepared.identity);
    // Persist the exact observed provider resources before any provider mutation.
    // A later retry cannot silently switch this job to another group or offer.
    await bindProviderIdentity?.(resolvedIdentity);
    const scope = (item: string): QuantityPublicationScope => ({
      destinationKind: "channel_connection",
      connectionId: identity.connectionId,
      providerKey: "ebay",
      providerScopeType: "account",
      externalScopeId: identity.accountId,
      externalInventoryItemId: item,
      productId: null,
      productVariantId: null,
    });
    await stage("recover_prior_requests", syncIdentityHash(resolvedIdentity), async () => {
      const recovery = await this.recovery.reconcile([
        ...(resolvedIdentity.groupKey === null ? [] : [scope(`group:${resolvedIdentity.groupKey}`)]),
        ...resolvedIdentity.variants.map((member) => scope(member.sku)),
      ]);
      if (recovery.busy)
        throw new EbayListingSyncError(
          "PUBLICATION_SCOPE_BUSY",
          "Waiting for an active quantity publisher before checking prior response evidence.",
        );
      if (recovery.unresolved.length)
        throw new EbayListingSyncError(
          "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",
          `A prior request has no provable final response (attempts ${recovery.unresolved.join(", ")}). Reconcile that request before another write.`,
        );
    });
    const contentHash = syncContentIntentHash(prepared.draft);
    const offerIds: Record<number, string> = {};
    for (const member of resolvedIdentity.variants) {
      if (member.offerId) offerIds[member.variantId] = member.offerId;
    }
    const verify = (): Promise<void> => this.connector.verifyExistingListing({
      client: prepared.client,
      draft: prepared.draft,
      identity: resolvedIdentity,
      offerIds,
    });
    // A committed post-write checkpoint binds retries to accepted content. ATP
    // changes do not invalidate it; new content or a new command revision does.
    if (verificationIntentHash === contentHash) {
      await stage("verification", contentHash, verify);
      return completedEbayListingSyncResult(prepared, new Set());
    }
    // Also adopt already-current content after a lost checkpoint or final local
    // commit. This read never substitutes for the response evidence checked above.
    try {
      await stage("inspection", contentHash, verify);
      return completedEbayListingSyncResult(prepared, new Set());
    } catch (error) {
      if (
        !(error instanceof EbayListingSyncError) ||
        error.code !== "EBAY_SYNC_READBACK_PENDING"
      ) throw error;
    }
    // Prepare only before a new provider mutation. Accepted content can finish
    // read-only verification even if stock was paused after the original write.
    // Inventory owns mappings and retained zero stock; retries reuse this job.
    if (prepared.assertInventoryReady) {
      await stage("prepare_inventory", contentHash, () => prepared.assertInventoryReady!(context?.jobId && context.requestedBy
        ? { commandKey: context.jobId, actor: context.requestedBy } : undefined));
    }
    const updated = await this.connector.syncExistingListing({
      client: prepared.client,
      draft: prepared.draft,
      identity: resolvedIdentity,
      stage,
    });
    if (updated.missingOfferVariantIds.length)
      throw new EbayListingSyncError(
        "EBAY_SYNC_OFFER_MISSING",
        "A required existing offer is missing. Review the listing identity.",
      );
    await stage("verification", contentHash, () =>
      this.connector.verifyExistingListing({
        client: prepared.client,
        draft: prepared.draft,
        identity: resolvedIdentity,
        offerIds: updated.updatedOfferIds,
      }),
    );
    return completedEbayListingSyncResult(prepared, new Set(updated.policyChangedVariantIds));
  }
}
export function completedEbayListingSyncResult(
    prepared: PreparedEbayListingSync,
    policyChanges: ReadonlySet<number>,
  ): EbayProductSyncResult {
    return ebayProductSyncResultSchema.parse({
      synced: prepared.variants.length,
      priceChanges: prepared.variants.filter((member) => member.priceChanged)
        .length,
      qtyChanges: 0,
      policyChanges: policyChanges.size,
      errors: 0,
      details: prepared.variants.map((member) => ({
        productId: prepared.identity.productId,
        productName: member.productName,
        variantId: member.variantId,
        variantSku: member.sku,
        success: true,
        lastSyncedPriceCents: member.priceCents,
        priceChanged: member.priceChanged,
        policyChanged: policyChanges.has(member.variantId),
      })),
    });
}

export interface EbayListingSyncClaim {
  job: StoredEbayListingSyncJob;
  release(): Promise<void>;
}
export interface EbayListingSyncStore {
  authorizePublicationRetry(input: EbayPublicationRetryAuthorization, now: Date): Promise<{ job: StoredEbayListingSyncJob; replayed: boolean }>;
  recordAdmissionFailure(input: EbaySyncAdmissionFailure, now: Date): Promise<EbayListingSyncJob>;
  bindProviderIdentity(job: StoredEbayListingSyncJob, identity: EbayListingSyncIdentity, now: Date, publicationObservation?: MarketplaceObservedListingPublication): Promise<void>;
  bindPublicationTarget(job: StoredEbayListingSyncJob, identity: EbayListingSyncIdentity, now: Date): Promise<void>;
  bindPublicationAccepted(job: StoredEbayListingSyncJob, accepted: EbayPublicationAccepted, now: Date): Promise<void>;
  enqueue(
    identity: EbayListingSyncIdentity,
    commandKey: string,
    actor: string,
    now: Date,
    operation?: "sync" | "publish" | "withdraw",
  ): Promise<StoredEbayListingSyncJob>;
  list(channelId: number): Promise<EbayListingSyncJob[]>;
  get(id: string): Promise<StoredEbayListingSyncJob>;
  getByCommand(commandKey: string, channelId: number): Promise<StoredEbayListingSyncJob | null>;
  getAdmission(id: string, channelId: number): Promise<EbayListingSyncJob | null>;
  claim(
    now: Date,
    token: string,
    id?: string,
  ): Promise<EbayListingSyncClaim | null>;
  stage(
    job: StoredEbayListingSyncJob,
    key: string,
    hash: string,
    state: "started" | "completed",
    now: Date,
  ): Promise<void>;
  finish(
    job: StoredEbayListingSyncJob,
    outcome: {
      state:
        | "completed"
        | "recovering"
        | "awaiting_evidence"
        | "needs_attention";
      result: EbayProductSyncResult | null;
      code: string | null;
      message: string | null;
      nextAttemptAt: Date;
      resetAttempts?: boolean;
      diagnostic?: EbayListingFailureDiagnostic;
    },
    now: Date,
  ): Promise<void>;
}
export interface EbayListingSyncExecution {
  execute(
    identity: EbayListingSyncIdentity,
    stage: (
      key: string,
      hash: string,
      work: () => Promise<void>,
    ) => Promise<void>,
    verificationIntentHash?: string | null,
    bindProviderIdentity?: (identity: EbayListingSyncIdentity, publicationObservation?: MarketplaceObservedListingPublication) => Promise<void>,
    context?: EbayListingExecutionContext,
  ): Promise<EbayProductSyncResult>;
}
export interface EbayListingExecutionContext {
  jobId?: string;
  requestedBy?: string;
  providerIdentity?: EbayListingSyncIdentity | null;
  withdrawalWriteCompleted?: boolean;
  withdrawalWriteStarted?: boolean;
  operation: "sync" | "publish" | "withdraw";
  publicationTarget: EbayListingSyncIdentity | null;
  bindPublicationTarget: (identity: EbayListingSyncIdentity) => Promise<void>;
  publicationAccepted: EbayPublicationAccepted | null;
  publicationWriteCompleted: boolean;
  publicationWriteStarted: boolean;
  publicationAcceptedRevision: string | null;
  publicationIntentHash: string | null;
  claimedRevision: string;
  bindPublicationAccepted: (accepted: EbayPublicationAccepted) => Promise<void>;
}

export const ebaySyncAdmissionFailureSchema = z.object({
  channelId: z.number().int().positive(), productId: z.number().int().positive(),
  operation: z.enum(["sync", "publish", "withdraw"]).default("sync"),
  variantIds: z.array(z.number().int().positive()).max(250),
  actor: z.string().trim().min(1).max(200), commandKey: z.string().uuid(),
  code: z.string().min(1).max(100), message: z.string().min(1).max(1000),
}).strict();
export type EbaySyncAdmissionFailure = z.input<typeof ebaySyncAdmissionFailureSchema>;

/** One application owner from request to verified completion. The external adapter
 * owns listing primitives; inventory admission owns every quantity-bearing write. */
export class EbayListingSyncService {
  private running = false;
  constructor(
    private readonly store: EbayListingSyncStore,
    private readonly executor: EbayListingSyncExecution,
    private readonly clock: () => Date,
    private readonly uuid: () => string,
  ) {}
  enqueue(
    identity: unknown,
    actor: unknown,
    commandKey?: string,
    operation: "sync" | "publish" | "withdraw" = "sync",
  ): Promise<StoredEbayListingSyncJob> {
    return this.store.enqueue(
      ebayListingSyncIdentitySchema.parse(identity),
      z
        .string()
        .uuid()
        .parse(commandKey ?? this.uuid()),
      z.string().trim().min(1).max(200).parse(actor),
      this.now(),
      z.enum(["sync", "publish", "withdraw"]).parse(operation),
    );
  }
  authorizePublicationRetry(input: EbayPublicationRetryAuthorization): Promise<{ job: StoredEbayListingSyncJob; replayed: boolean }> {
    const parsed = z.object({ jobId: z.string().uuid(), channelId: z.number().int().positive().max(2147483647),
      expectedRevision: z.string().regex(/^[1-9][0-9]*$/), reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
      commandKey: z.string().uuid(), actor: z.string().trim().min(1).max(200) }).strict().parse(input);
    return this.store.authorizePublicationRetry(parsed, this.now());
  }
  async recordAdmissionFailure(input: Omit<EbaySyncAdmissionFailure, "commandKey" | "variantIds" | "operation"> & { operation?: "sync" | "publish" | "withdraw"; commandKey?: string; variantIds: readonly number[] }): Promise<EbayListingSyncJob> {
    const parsed = ebaySyncAdmissionFailureSchema.parse({ ...input, commandKey: input.commandKey ?? this.uuid() });
    return this.withIssue(await this.store.recordAdmissionFailure(parsed, this.now()));
  }
  async list(channelId: number): Promise<EbayListingSyncJob[]> {
    return (await this.store.list(z.number().int().positive().parse(channelId))).map(job => this.withIssue(job));
  }
  async processDue(
    limit = 5,
    id?: string,
  ): Promise<{ processed: number; failed: number }> {
    z.number().int().min(1).max(20).parse(limit);
    if (id) z.string().uuid().parse(id);
    if (this.running) return { processed: 0, failed: 0 };
    this.running = true;
    const result = { processed: 0, failed: 0 };
    try {
      for (let index = 0; index < limit; index++) {
        const claim = await this.store.claim(
          this.now(),
          z.string().uuid().parse(this.uuid()),
          id,
        );
        if (!claim) break;
        const { job } = claim;
        const publicationProgress = { started: job.publicationWriteStarted,
          completed: job.publicationWriteCompleted, accepted: job.publicationAccepted };
        let withdrawalCompleted = job.withdrawalWriteCompleted;
        let withdrawalStarted = job.withdrawalWriteStarted;
        try {
          const output = ebayProductSyncResultSchema.parse(
            await this.executor.execute(
              job.identity,
              async (key, hash, work) => {
                await this.store.stage(job, key, hash, "started", this.now());
                if (job.operation === "withdraw" && key === "withdraw") withdrawalStarted = true;
                if (job.operation === "publish" && key === "publish") {
                  publicationProgress.started = true;
                }
                await work();
                await this.store.stage(job, key, hash, "completed", this.now());
                if (job.operation === "publish" && key === "publish") publicationProgress.completed = true;
                if (job.operation === "withdraw" && key === "withdraw") withdrawalCompleted = true;
              },
              job.verificationRevision === job.claimedRevision
                ? job.verificationIntentHash
                : null,
              (resolved, observation) => this.store.bindProviderIdentity(job, resolved, this.now(), observation),
              { operation: job.operation, jobId: job.id, requestedBy: job.requestedBy, providerIdentity: job.providerIdentity, publicationTarget: job.publicationTarget,
                withdrawalWriteCompleted: job.withdrawalWriteCompleted,
                withdrawalWriteStarted: job.withdrawalWriteStarted,
                publicationAccepted: job.publicationAccepted, publicationWriteCompleted: job.publicationWriteCompleted,
                publicationWriteStarted: job.publicationWriteStarted, publicationAcceptedRevision: job.publicationAcceptedRevision,
                publicationIntentHash: job.publicationIntentHash,
                claimedRevision: job.claimedRevision ?? job.revision,
                bindPublicationTarget: target => this.store.bindPublicationTarget(job, target, this.now()),
                bindPublicationAccepted: async accepted => { await this.store.bindPublicationAccepted(job, accepted, this.now()); publicationProgress.accepted = accepted; } },
            ),
          );
          await this.store.finish(
            job,
            {
              state: output.errors ? "needs_attention" : "completed",
              result: output,
              code: output.errors ? "EBAY_LISTING_SYNC_INCOMPLETE" : null,
              message: output.details.find((d) => !d.success)?.error ?? null,
              nextAttemptAt: this.now(),
              // A newer command can requeue this successful pass. Only failures
              // consume its retry budget; every stage remains in the audit trail.
              resetAttempts: output.errors === 0,
            },
            this.now(),
          );
          result.processed++;
        } catch (error) {
          result.failed++;
          const failure = syncFailure(error, job.attempts, this.now());
          // Never retire a publication's unresolved write barrier. A new command
          // must join this job and retain its acceptance/start evidence.
          if (job.operation === "publish" && (publicationProgress.started || publicationProgress.completed || publicationProgress.accepted)) {
            failure.state = publicationProgress.accepted || publicationProgress.completed ? "recovering" : "awaiting_evidence";
            failure.resetAttempts = true;
          }
          if (job.operation === "withdraw" && (withdrawalStarted || withdrawalCompleted)) {
            failure.state = withdrawalCompleted ? "recovering" : "awaiting_evidence";
            failure.resetAttempts = true;
          }
          const diagnostic = ebayListingFailureDiagnostic(error);
          // Log before the final transaction: a failed database commit must not
          // erase the original failure and its exact inventory scope.
          console.error(JSON.stringify({ event: "ebay_listing_sync_followup", jobId: job.id,
            productId: job.productId, ...diagnostic }));
          // A failed final commit is retained as running. Never overwrite a newer
          // owner's progress after losing this connection or its fencing token.
          await this.store.finish(
            job,
            { ...failure, result: null, diagnostic },
            this.now(),
          );
        } finally {
          await claim.release();
        }
        if (id) break;
      }
      return result;
    } finally {
      this.running = false;
    }
  }
  get(id: string): Promise<StoredEbayListingSyncJob> {
    return this.store.get(z.string().uuid().parse(id));
  }
  getByCommand(commandKey: string, channelId: number): Promise<StoredEbayListingSyncJob | null> {
    return this.store.getByCommand(z.string().uuid().parse(commandKey), z.number().int().positive().max(2147483647).parse(channelId));
  }
  async getAdmission(id: string, channelId: number): Promise<EbayListingSyncJob | null> {
    const job = await this.store.getAdmission(z.string().uuid().parse(id), z.number().int().positive().parse(channelId));
    return job ? this.withIssue(job) : null;
  }
  private withIssue<T extends EbayListingSyncJob>(job: T): T {
    return job.code || job.state === "needs_attention" || job.state === "awaiting_evidence"
      ? { ...job, issue: resolveEbayListingIssue({ ...job, jobId: job.id }) }
      : job;
  }
  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      throw new Error("Invalid listing sync clock.");
    return new Date(value.getTime());
  }
}
