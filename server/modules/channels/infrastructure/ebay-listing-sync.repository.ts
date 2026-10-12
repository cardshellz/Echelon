import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  ebayListingSyncJobSchema,
  type EbayListingSyncJob,
} from "@shared/types/ebay-listing-sync";
import {
  EbayListingSyncError,
  ebayListingSyncIdentitySchema,
  ebayPublicationAcceptedSchema,
  publicationRetryReviewHash,
  storedEbayListingSyncJobSchema,
  syncIdentityHash,
  syncStageHash,
  type EbayListingSyncIdentity,
  type StoredEbayListingSyncJob,
  type EbayPublicationRetryAuthorization,
} from "../ebay-listing-sync.domain";
import {
  ebaySyncAdmissionFailureSchema,
  type EbayListingSyncClaim,
  type EbayListingSyncStore,
  type EbaySyncAdmissionFailure,
} from "../ebay-listing-sync.service";
import { assertEbayListingSourceIdentityUnchanged } from "../ebay-existing-listing-identity";
import { EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, ebayListingWorkflowLockKey } from "../ebay-listing-workflow-lock";
import { PgMarketplaceListingRegistrationRepository, type MarketplaceObservedListingPublication } from "../../marketplace-listings";
import { assertEbayPublicationObservation } from "../ebay-publication-observation";
import { assertEbayPublicationTargetUnchanged } from "../ebay-publication-completion.domain";
import { assertEbayMappingOwnership } from "./ebay-listing-mapping-ownership";

const LOCK_NAMESPACE = 918427;
const PUBLICATION_EVIDENCE_RECHECK_MS = 30_000;
// Authorization retains the original evidence. Only starts after that explicit
// acknowledgement prevent a new send; successful responses remain permanent.
const currentPublicationStart = `evidence.event='stage_started' AND evidence.evidence->>'key'='publish'
  AND evidence.id>COALESCE((SELECT max(retry_receipt.id) FROM channels.ebay_listing_sync_events retry_receipt
    WHERE retry_receipt.job_id=evidence.job_id AND retry_receipt.event='publication_retry_authorized'),0)`;
const rowSql = `SELECT id::text,product_id AS "productId",state,error_code AS code,error_message AS message,
  next_attempt_at AS "nextAttemptAt",updated_at AS "updatedAt",identity,revision::text,claimed_revision::text AS "claimedRevision",
  owner_token::text AS "ownerToken",attempts,result,verification_intent_hash AS "verificationIntentHash",
  verification_revision::text AS "verificationRevision",provider_identity AS "providerIdentity",operation,requested_by AS "requestedBy",
  EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events evidence WHERE evidence.job_id=channels.ebay_listing_sync_jobs.id
    AND evidence.event='stage_completed' AND evidence.evidence->>'key'='withdraw') AS "withdrawalWriteCompleted",
  EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events evidence WHERE evidence.job_id=channels.ebay_listing_sync_jobs.id
    AND evidence.event='stage_started' AND evidence.evidence->>'key'='withdraw'
    AND evidence.id>COALESCE((SELECT max(withdrawal_authorization.id) FROM channels.ebay_listing_sync_events withdrawal_authorization
      WHERE withdrawal_authorization.job_id=evidence.job_id AND withdrawal_authorization.event='withdrawal_retry_authorized'),0)) AS "withdrawalWriteStarted",
  publication_target AS "publicationTarget",publication_accepted AS "publicationAccepted",
  EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events evidence WHERE evidence.job_id=ebay_listing_sync_jobs.id
    AND ${currentPublicationStart}) AS "publicationWriteStarted",
  (SELECT evidence.evidence->>'preparedIntentHash' FROM channels.ebay_listing_sync_events evidence
    WHERE evidence.job_id=ebay_listing_sync_jobs.id AND ${currentPublicationStart}
    ORDER BY evidence.id LIMIT 1) AS "publicationIntentHash",
  EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events evidence WHERE evidence.job_id=ebay_listing_sync_jobs.id
    AND evidence.event='stage_completed' AND evidence.evidence->>'key'='publish') AS "publicationWriteCompleted",
  (SELECT min(evidence.revision)::text FROM channels.ebay_listing_sync_events evidence WHERE evidence.job_id=ebay_listing_sync_jobs.id
    AND evidence.event='stage_completed' AND evidence.evidence->>'key' IN ('publish','publication_accepted')) AS "publicationAcceptedRevision"
  FROM channels.ebay_listing_sync_jobs`;
function decode(row: Record<string, unknown>): StoredEbayListingSyncJob {
  return storedEbayListingSyncJobSchema.parse({
    ...row,
    nextAttemptAt: (row.nextAttemptAt as Date).toISOString(),
    updatedAt: (row.updatedAt as Date).toISOString(),
  });
}
function hasPublicationBarrier(job: StoredEbayListingSyncJob): boolean {
  return job.operation === "publish" && (job.publicationWriteStarted || job.publicationWriteCompleted || job.publicationAccepted !== null);
}
function validatePublicationTarget(source: EbayListingSyncIdentity, input: EbayListingSyncIdentity): EbayListingSyncIdentity {
  const target = ebayListingSyncIdentitySchema.parse(input);
  if (target.channelId !== source.channelId || target.connectionId !== source.connectionId
    || target.productId !== source.productId || target.accountId !== source.accountId || target.marketplaceId !== source.marketplaceId
    || (source.groupKey !== null && target.groupKey !== source.groupKey)
    || target.variants.length !== source.variants.length || source.variants.some(member => !target.variants.some(next =>
      next.variantId === member.variantId && next.sku === member.sku && next.catalogSku === member.catalogSku
      && (next.contentSyncEnabled ?? true) === (member.contentSyncEnabled ?? true) && next.mappingExists === member.mappingExists
      && next.externalSku === (member.externalSku ?? member.sku) && next.listingId === null
      && (member.offerId === null || next.offerId === member.offerId))))
    throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The publication target does not match the saved local and provider identities.");
  return target;
}
const publicationRetryInputSchema = z.object({
  jobId:z.string().uuid(),channelId:z.number().int().positive().max(2147483647),expectedRevision:z.string().regex(/^[1-9][0-9]*$/),
  reviewHash:z.string().regex(/^[a-f0-9]{64}$/),commandKey:z.string().uuid(),actor:z.string().trim().min(1).max(200),
}).strict();
export class PostgresEbayListingSyncRepository implements EbayListingSyncStore {
  private readonly clients = new Map<string, PoolClient>();
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}
  async enqueue(
    identity: EbayListingSyncIdentity,
    commandKey: string,
    actor: string,
    now: Date,
    operation: "sync" | "publish" | "withdraw" = "sync",
  ): Promise<StoredEbayListingSyncJob> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='2s'");
      const job = await this.enqueueInsideTransaction(client, identity, commandKey, actor, now, undefined, operation);
      await client.query("COMMIT");
      return job;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Channels-owned composition boundary. The caller owns BEGIN/COMMIT/ROLLBACK;
   * use this for atomic local mapping repair plus its durable follow-up request. */
  async enqueueInsideTransaction(
    client: PoolClient,
    identity: EbayListingSyncIdentity,
    commandKey: string,
    actor: string,
    now: Date,
    verifiedProviderIdentity?: EbayListingSyncIdentity,
    operation: "sync" | "publish" | "withdraw" = "sync",
    reviewedPublicationTarget?: EbayListingSyncIdentity,
  ): Promise<StoredEbayListingSyncJob> {
    identity = ebayListingSyncIdentitySchema.parse(identity);
    if (operation !== "sync" && operation !== "publish" && operation !== "withdraw") throw new EbayListingSyncError("EBAY_SYNC_OPERATION_INVALID", "The saved listing operation is invalid.");
    if (operation === "publish" && identity.variants.some(member => member.mappingExists === undefined || member.listingId !== null))
      throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "Publication requires the exact current unpublished mapping, including whether each mapping exists.");
    if (reviewedPublicationTarget && operation !== "publish")
      throw new EbayListingSyncError("EBAY_SYNC_OPERATION_INVALID", "Only a publication request can retain a reviewed publication target.");
    const reviewedTarget = reviewedPublicationTarget ? validatePublicationTarget(identity, reviewedPublicationTarget) : null;
    // Product command serialization is distinct from quantity admission. Joining
    // a pending job records a new requested revision without taking its HTTP lock.
    await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [
      LOCK_NAMESPACE,
      `enqueue:${identity.channelId}:${identity.productId}`,
    ]);
    await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [LOCK_NAMESPACE, `command:${commandKey}`]);
    if ((await client.query("SELECT 1 FROM channels.ebay_listing_exclusion_commands WHERE command_key=$1 AND job_id IS NULL", [commandKey])).rowCount)
      throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This command already belongs to a local product inclusion or exclusion receipt.");
    if ((await client.query("SELECT 1 FROM channels.ebay_listing_sync_admission_failures WHERE command_key=$1", [commandKey])).rowCount)
      throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This request was already saved as a rejected admission. Start a new sync after correcting its issue.");
    const replay = (
      await client.query<{
        job_id: string;
        identity_hash: string;
        actor: string;
      }>(
        `SELECT job_id::text,identity_hash,actor
      FROM channels.ebay_listing_sync_commands WHERE command_key=$1`,
        [commandKey],
      )
    ).rows[0];
    if (replay) {
      if (
        replay.identity_hash !== syncIdentityHash(identity) ||
        replay.actor !== actor
      )
        throw new EbayListingSyncError(
          "EBAY_SYNC_REPLAY_CONFLICT",
          "This sync command belongs to a different listing identity or requester.",
        );
      const job = decode(
        (await client.query(rowSql + " WHERE id=$1", [replay.job_id]))
          .rows[0],
      );
      if (job.operation !== operation) throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This command already belongs to a different listing operation.");
      if (reviewedTarget) {
        if (!job.publicationTarget) throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This command was saved without the reviewed publication target.");
        assertEbayPublicationTargetUnchanged(job.publicationTarget, reviewedTarget);
      }
      return job;
    }
    const priorTerminal = (await client.query(rowSql + " WHERE channel_id=$1 AND product_id=$2 AND operation='publish' AND state='needs_attention'", [identity.channelId,identity.productId])).rows.map(decode).find(hasPublicationBarrier);
    if (priorTerminal) throw this.priorPublicationRequired(priorTerminal.id);
    const active = (
      await client.query<{ id: string; identity: EbayListingSyncIdentity; providerIdentity: EbayListingSyncIdentity | null; operation: "sync" | "publish" | "withdraw" }>(
        `SELECT id::text,identity,provider_identity AS "providerIdentity",operation FROM channels.ebay_listing_sync_jobs
      WHERE channel_id=$1 AND product_id=$2 AND state IN ('queued','running','recovering','awaiting_evidence') FOR UPDATE`,
        [identity.channelId, identity.productId],
      )
    ).rows[0];
    let id: string;
    let reusable = !!active;
    if (active) {
      if (active.operation === "withdraw" && operation !== "withdraw")
        throw Object.assign(new EbayListingSyncError("EBAY_WITHDRAWAL_IN_PROGRESS", "This product's saved withdrawal must finish before another listing operation can start."), { jobId: active.id });
      try {
        if (active.operation !== operation) throw new EbayListingSyncError("EBAY_SYNC_OPERATION_CHANGED", "A new listing operation requires its own durable request.");
        assertEbayListingSourceIdentityUnchanged(active.identity, identity);
        if (verifiedProviderIdentity && active.providerIdentity
          && syncIdentityHash(active.providerIdentity) !== syncIdentityHash(verifiedProviderIdentity))
          throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The verified provider resources changed. A fresh owned sync request is required.");
      }
      catch (error) {
        if (!(error instanceof EbayListingSyncError)) throw error;
        const locked = (await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS acquired", [LOCK_NAMESPACE, active.id])).rows[0]?.acquired;
        if (!locked) throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY", "An update using the earlier mapping is still running. The new mapping can be synced after that update finishes.");
        const current = decode((await client.query(rowSql + " WHERE id=$1",[active.id])).rows[0]);
        if (hasPublicationBarrier(current)) throw this.priorPublicationRequired(current.id);
        if (current.operation === "withdraw" && (current.withdrawalWriteCompleted || current.withdrawalWriteStarted))
          throw Object.assign(new EbayListingSyncError("EBAY_WITHDRAWAL_IN_PROGRESS", "eBay accepted this saved withdrawal. Its original listing must be verified before changing the request's mapping."), { jobId: current.id });
        // Retain the old command and its provider evidence; only an idle job can
        // be superseded. Quantity admission independently fences unresolved writes.
        await client.query("UPDATE channels.ebay_listing_sync_jobs SET state='needs_attention',owner_token=NULL,claimed_revision=NULL,error_code='EBAY_SYNC_SOURCE_SUPERSEDED',error_message='A newer sync request replaced the changed source mapping.',updated_at=$2 WHERE id=$1", [active.id, now.toISOString()]);
        await client.query("INSERT INTO channels.ebay_listing_sync_events(job_id,revision,event,evidence,created_at) SELECT id,revision,'needs_attention',$2::jsonb,$3 FROM channels.ebay_listing_sync_jobs WHERE id=$1", [active.id, canonicalJson({ code: "EBAY_SYNC_SOURCE_SUPERSEDED", commandKey, actor }), now.toISOString()]);
        reusable = false;
      }
    }
    let retainedTarget = reviewedTarget;
    let retainedTargetJobId: string | null = null;
    if (operation === "publish" && !reusable) {
      // A failed preparation can leave real offers before any publish request.
      // Preserve only the latest job's proven target and only for the same local
      // source. The worker must still inspect these exact resources before use.
      const previousRow = (await client.query(rowSql +
        ` WHERE channel_id=$1 AND product_id=$2 AND operation='publish' ORDER BY created_at DESC,
          (SELECT max(sequence.id) FROM channels.ebay_listing_sync_events sequence WHERE sequence.job_id=ebay_listing_sync_jobs.id AND sequence.event='requested') DESC,id DESC LIMIT 1`,
      [identity.channelId, identity.productId])).rows[0];
      if (previousRow) {
        const previous = decode(previousRow);
        if (previous.state === "needs_attention" && previous.publicationTarget) {
          if (hasPublicationBarrier(previous)) throw this.priorPublicationRequired(previous.id);
          let sameSource = true;
          try { assertEbayListingSourceIdentityUnchanged(previous.identity, identity); }
          catch (error) {
            if (!(error instanceof EbayListingSyncError) || error.code !== "EBAY_SYNC_IDENTITY_CHANGED") throw error;
            sameSource = false;
          }
          if (sameSource) {
            if (retainedTarget) assertEbayPublicationTargetUnchanged(previous.publicationTarget, retainedTarget);
            else retainedTarget = validatePublicationTarget(identity, previous.publicationTarget);
            retainedTargetJobId = previous.id;
          }
        }
      }
    }
    if (active && reusable) {
      id = active.id;
      await client.query(
        `UPDATE channels.ebay_listing_sync_jobs SET revision=revision+1,updated_at=$2,next_attempt_at=$2 WHERE id=$1`,
        [id, now.toISOString()],
      );
    } else {
      id = commandKey;
      await client.query(
        `INSERT INTO channels.ebay_listing_sync_jobs(id,channel_id,connection_id,product_id,identity,identity_hash,requested_by,created_at,updated_at,next_attempt_at,operation)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$8,$8,$9)`,
        [
          id,
          identity.channelId,
          identity.connectionId,
          identity.productId,
          JSON.stringify(identity),
          syncIdentityHash(identity),
          actor,
          now.toISOString(),
          operation,
        ],
      );
    }
    await client.query(
      `INSERT INTO channels.ebay_listing_sync_commands(command_key,job_id,identity_hash,actor,created_at) VALUES($1,$2,$3,$4,$5)`,
      [commandKey, id, syncIdentityHash(identity), actor, now.toISOString()],
    );
    let job = decode(
      (await client.query(rowSql + " WHERE id=$1", [id])).rows[0],
    );
    if (retainedTarget) validatePublicationTarget(job.identity, retainedTarget);
    if (retainedTarget && job.publicationTarget) assertEbayPublicationTargetUnchanged(job.publicationTarget, retainedTarget);
    if (retainedTarget && !job.publicationTarget) {
      // Reviewed and previously saved targets use the same preparation receipt.
      // Neither is a claim that eBay published it; the worker still observes the
      // exact target before writes.
      for (const key of [job.id, ebayListingWorkflowLockKey(identity.channelId, identity.productId)]) {
        const acquired = (await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS acquired", [LOCK_NAMESPACE, key])).rows[0]?.acquired;
        if (!acquired) throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY", "A provider operation is running for this listing. Recheck the saved request before applying this publication review.");
      }
      if (job.ownerToken !== null || job.claimedRevision !== null || job.state === "running")
        throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY", "The listing worker is still preparing this publication. Wait for its current attempt to finish before applying the review.");
      const targetHash = syncIdentityHash(retainedTarget);
      await this.event(client, job, "requested", { commandKey, actor, reviewedPublicationTarget: retainedTarget, retainedTargetJobId, targetHash, sourceIdentityHash: syncIdentityHash(identity),
        ownerTransactionId: (await client.query("SELECT pg_current_xact_id()::text AS id")).rows[0].id }, now);
      await client.query("UPDATE channels.ebay_listing_sync_jobs SET publication_target=$2::jsonb,publication_target_hash=$3 WHERE id=$1",
        [job.id, canonicalJson(retainedTarget), targetHash]);
      job = decode((await client.query(rowSql + " WHERE id=$1", [job.id])).rows[0]);
    } else await this.event(client, job, "requested", { commandKey, actor }, now);
    return job;
  }
  private priorPublicationRequired(jobId: string): EbayListingSyncError {
    return Object.assign(new EbayListingSyncError("EBAY_PUBLICATION_PRIOR_WORK_REQUIRED", `A prior publication may already have reached eBay. Review its saved status before starting a different request.`), { jobId });
  }

  async authorizePublicationRetry(input: EbayPublicationRetryAuthorization, now: Date): Promise<{job:StoredEbayListingSyncJob;replayed:boolean}> {
    input=publicationRetryInputSchema.parse(input);
    const client=await this.pool.connect();
    try { return await this.transaction(client,async()=>{
      const initial=(await client.query("SELECT channel_id,product_id FROM channels.ebay_listing_sync_jobs WHERE id=$1",[input.jobId])).rows[0];
      if(!initial || initial.channel_id!==input.channelId) throw new EbayListingSyncError("EBAY_SYNC_JOB_NOT_FOUND","The saved listing request was not found for this channel.");
      await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))",[LOCK_NAMESPACE,`enqueue:${input.channelId}:${initial.product_id}`]);
      await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))",[LOCK_NAMESPACE,`command:${input.commandKey}`]);
      // Expected revision is deliberately excluded from replay comparison. The
      // review hash already binds the original revision, which this command advances.
      const {expectedRevision,...request}=input;
      const requestHash=syncStageHash(request);
      const replay=(await client.query(`SELECT command.job_id::text,command.actor,event.evidence FROM channels.ebay_listing_sync_commands command
        LEFT JOIN channels.ebay_listing_sync_events event ON event.job_id=command.job_id AND event.event IN ('publication_retry_authorized','withdrawal_retry_authorized')
          AND event.evidence->>'commandKey'=command.command_key::text WHERE command.command_key=$1`,[input.commandKey])).rows[0];
      if(replay){
        if(replay.job_id!==input.jobId || replay.actor!==input.actor || replay.evidence?.requestHash!==requestHash)
          throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT","This recovery command belongs to a different saved request, review or requester.");
        return {job:decode((await client.query(rowSql+" WHERE id=$1",[input.jobId])).rows[0]),replayed:true};
      }
      if((await client.query("SELECT 1 FROM channels.ebay_listing_sync_admission_failures WHERE command_key=$1",[input.commandKey])).rowCount)
        throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT","This recovery command already belongs to a rejected listing request.");
      for(const key of [input.jobId,ebayListingWorkflowLockKey(input.channelId,initial.product_id)]){
        const acquired=(await client.query<{acquired:boolean}>("SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS acquired",[LOCK_NAMESPACE,key])).rows[0]?.acquired;
        if(!acquired) throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY","This listing still has an active provider operation. Wait for it to finish, then review recovery again.");
      }
      const job=decode((await client.query(rowSql+" WHERE id=$1 FOR UPDATE",[input.jobId])).rows[0]);
      const mayRetryPublication = job.operation === "publish" && job.publicationTarget && job.publicationWriteStarted && !job.publicationWriteCompleted && !job.publicationAccepted;
      const mayRetryWithdrawal = job.operation === "withdraw" && job.providerIdentity && job.withdrawalWriteStarted && !job.withdrawalWriteCompleted
        && ["queued", "running", "recovering", "awaiting_evidence"].includes(job.state);
      if ((!mayRetryPublication && !mayRetryWithdrawal) || job.state === "completed")
        throw new EbayListingSyncError("EBAY_PUBLICATION_RETRY_NOT_ALLOWED","This request has no unaccepted publication attempt to authorize. Recheck its saved status; a completed or accepted publish cannot be resent.");
      if(job.revision!==expectedRevision || publicationRetryReviewHash(job)!==input.reviewHash)
        throw new EbayListingSyncError("EBAY_PUBLICATION_RETRY_REVIEW_CHANGED","The saved publication changed after this review. Review its current recovery before authorizing a retry.");
      if((await client.query("SELECT 1 FROM channels.ebay_listing_sync_jobs WHERE channel_id=$1 AND product_id=$2 AND id<>$3 AND state IN ('queued','running','recovering','awaiting_evidence')",[input.channelId,initial.product_id,input.jobId])).rowCount)
        throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY","Another saved request owns this listing. Review that request before authorizing this publication.");
      await client.query("INSERT INTO channels.ebay_listing_sync_commands(command_key,job_id,identity_hash,actor,created_at) VALUES($1,$2,$3,$4,$5)",
        [input.commandKey,input.jobId,syncIdentityHash(job.identity),input.actor,now.toISOString()]);
      await this.event(client,{...job,claimedRevision:null,ownerToken:null},job.operation === "withdraw" ? "withdrawal_retry_authorized" : "publication_retry_authorized",{
        ...request,requestHash,beforeRevision:job.revision,identity:job.identity,publicationTarget:job.publicationTarget,publicationIntentHash:job.publicationIntentHash,
        ...(job.operation === "withdraw" ? { providerIdentity: job.providerIdentity } : {}),
        ownerTransactionId:(await client.query("SELECT pg_current_xact_id()::text AS id")).rows[0].id,
      },now);
      await client.query(`UPDATE channels.ebay_listing_sync_jobs SET revision=revision+1,state='queued',owner_token=NULL,claimed_revision=NULL,
        attempts=0,error_code=NULL,error_message=NULL,result=NULL,next_attempt_at=$2,updated_at=$2 WHERE id=$1`,[input.jobId,now.toISOString()]);
      return {job:decode((await client.query(rowSql+" WHERE id=$1",[input.jobId])).rows[0]),replayed:false};
    }); } finally {client.release();}
  }
  async list(channelId: number): Promise<EbayListingSyncJob[]> {
    return (
      await this.pool.query(
        `SELECT * FROM (SELECT DISTINCT ON ("productId") * FROM (
          SELECT id::text,product_id AS "productId",'sync' AS kind,operation,state,error_code AS code,error_message AS message,
          next_attempt_at AS "nextAttemptAt",updated_at AS "updatedAt" FROM channels.ebay_listing_sync_jobs WHERE channel_id=$1
          UNION ALL SELECT command_key::text,product_id,'admission',operation,'needs_attention',error_code,error_message,created_at,created_at
          FROM channels.ebay_listing_sync_admission_failures WHERE channel_id=$1) all_jobs
          ORDER BY "productId","updatedAt" DESC,id DESC)
          latest ORDER BY "updatedAt" DESC LIMIT 500`,
        [channelId],
      )
    ).rows.map((row) =>
      ebayListingSyncJobSchema.parse({
        ...row,
        nextAttemptAt: row.nextAttemptAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }),
    );
  }
  async recordAdmissionFailure(input: EbaySyncAdmissionFailure, now: Date): Promise<EbayListingSyncJob> {
    input=ebaySyncAdmissionFailureSchema.parse(input);
    const client = await this.pool.connect();
    try {
      return await this.transaction(client, async () => {
        await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [LOCK_NAMESPACE, `enqueue:${input.channelId}:${input.productId}`]);
        await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [LOCK_NAMESPACE, `command:${input.commandKey}`]);
        if ((await client.query("SELECT 1 FROM channels.ebay_listing_sync_commands WHERE command_key=$1", [input.commandKey])).rowCount)
          throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This command already owns a saved sync job; inspect that job.");
        const {operation="sync",...request}=input;
        // Old maintenance admission receipts predate operation. Preserve their
        // command fingerprint while publish requests include their distinct intent.
        const hash = syncStageHash({ ...request,...(operation === "publish" ? {operation} : {}), variantIds: [...input.variantIds].sort((a,b) => a-b) });
        await client.query(`INSERT INTO channels.ebay_listing_sync_admission_failures(command_key,channel_id,product_id,variant_ids,actor,error_code,error_message,request_hash,created_at,operation)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(command_key) DO NOTHING`, [input.commandKey,input.channelId,input.productId,input.variantIds,input.actor,input.code,input.message,hash,now.toISOString(),operation]);
        const row = (await client.query("SELECT *,command_key::text AS id,product_id AS \"productId\" FROM channels.ebay_listing_sync_admission_failures WHERE command_key=$1", [input.commandKey])).rows[0];
        if (row.request_hash !== hash || row.operation !== operation) throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This rejected command belongs to a different request.");
        return ebayListingSyncJobSchema.parse({ id: row.id,productId: row.productId,kind: "admission",operation:row.operation,state: "needs_attention",code: row.error_code,message: row.error_message,nextAttemptAt: row.created_at.toISOString(),updatedAt: row.created_at.toISOString() });
      });
    } finally { client.release(); }
  }
  async bindProviderIdentity(job: StoredEbayListingSyncJob, identity: EbayListingSyncIdentity, now: Date, publicationObservation?: MarketplaceObservedListingPublication): Promise<void> {
    identity = ebayListingSyncIdentitySchema.parse(identity);
    const observation = job.operation === "publish" ? assertEbayPublicationObservation(identity, publicationObservation) : null;
    const client = this.client(job);
    const hash = syncIdentityHash(identity);
    if (identity.productId !== job.identity.productId || identity.channelId !== job.identity.channelId
      || identity.connectionId !== job.identity.connectionId || identity.accountId !== job.identity.accountId
      || identity.marketplaceId !== job.identity.marketplaceId || identity.variants.length !== job.identity.variants.length
      || job.identity.variants.some(member => !identity.variants.some(resolved => resolved.variantId === member.variantId && resolved.sku === member.sku
        && (member.catalogSku === undefined || member.catalogSku === resolved.catalogSku)
        && (member.contentSyncEnabled ?? true) === (resolved.contentSyncEnabled ?? true)
        && resolved.externalSku === (job.operation === "publish" ? member.externalSku ?? member.sku : member.externalSku) && (member.offerId === null || resolved.offerId === member.offerId)
        && (member.listingId === null || resolved.listingId === member.listingId))))
      throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The observed provider identity does not match this saved request.");
    await this.transaction(client, async () => {
      await this.assertOwner(client, job);
      if (job.operation === "publish") {
        const targetRow = (await client.query("SELECT publication_target,publication_accepted FROM channels.ebay_listing_sync_jobs WHERE id=$1", [job.id])).rows[0];
        const target = ebayListingSyncIdentitySchema.parse(targetRow?.publication_target);
        if (target.groupKey !== identity.groupKey || identity.variants.some(member => !member.offerId || !member.listingId
          || member.externalSku !== member.sku || !target.variants.some(expected => expected.variantId === member.variantId
            && expected.sku === member.sku && (!expected.offerId || expected.offerId === member.offerId)))
          || new Set(identity.variants.map(member => member.listingId)).size !== 1
          || (targetRow.publication_accepted && identity.variants.some(member => member.listingId !== targetRow.publication_accepted.listingId
            || member.offerId !== targetRow.publication_accepted.offerIds[member.variantId])))
          throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The completed publication does not match this request's pinned provider target.");
      }
      const row = (await client.query("SELECT provider_identity_hash FROM channels.ebay_listing_sync_jobs WHERE id=$1", [job.id])).rows[0];
      if (row.provider_identity_hash) {
        if (row.provider_identity_hash !== hash) throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The eBay group, offers or listing changed since this job first verified them. Review its mapping and start a new sync.");
        return;
      }
      await this.event(client, job, "stage_completed", { key: "provider_identity", preparedIntentHash: hash, identity,
        ...(observation ? { observation: { ...observation, observedAt: observation.observedAt.toISOString() } } : {}) }, now);
      await client.query("UPDATE channels.ebay_listing_sync_jobs SET provider_identity=$3::jsonb,provider_identity_hash=$4 WHERE id=$1 AND owner_token=$2", [job.id,job.ownerToken,canonicalJson(identity),hash]);
    });
  }
  async bindPublicationTarget(job: StoredEbayListingSyncJob, input: EbayListingSyncIdentity, now: Date): Promise<void> {
    if (job.operation !== "publish") throw new EbayListingSyncError("EBAY_SYNC_OPERATION_INVALID", "Only a publication request can retain a publication target.");
    const target = validatePublicationTarget(job.identity, input);
    const hash = syncIdentityHash(target);
    const client = this.client(job);
    await this.transaction(client, async () => {
      await this.assertOwner(client, job);
      const row = (await client.query("SELECT publication_target_hash FROM channels.ebay_listing_sync_jobs WHERE id=$1", [job.id])).rows[0];
      if (row.publication_target_hash) {
        if (row.publication_target_hash !== hash) throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The publication target changed after this request started. Review its saved provider outcome before another write.");
        return;
      }
      await this.event(client, job, "stage_completed", {key:"publication_target",preparedIntentHash:hash,identity:target}, now);
      await client.query("UPDATE channels.ebay_listing_sync_jobs SET publication_target=$3::jsonb,publication_target_hash=$4 WHERE id=$1 AND owner_token=$2",
        [job.id,job.ownerToken,canonicalJson(target),hash]);
    });
  }
  async bindPublicationAccepted(job: StoredEbayListingSyncJob, input: {listingId:string;offerIds:Record<string,string>}, now: Date): Promise<void> {
    const accepted=ebayPublicationAcceptedSchema.parse(input);
    const client=this.client(job);
    if(job.operation!=="publish") throw new EbayListingSyncError("EBAY_SYNC_OPERATION_INVALID", "Only a saved publication can record a publication response.");
    await this.transaction(client,async()=>{
      await this.assertOwner(client,job);
      const row=(await client.query("SELECT publication_target,publication_accepted_hash FROM channels.ebay_listing_sync_jobs WHERE id=$1",[job.id])).rows[0];
      const target=ebayListingSyncIdentitySchema.parse(row.publication_target);
      if(Object.keys(accepted.offerIds).length!==target.variants.length || new Set(Object.values(accepted.offerIds)).size!==target.variants.length
        || target.variants.some(member=>!accepted.offerIds[member.variantId] || (member.offerId!==null && member.offerId!==accepted.offerIds[member.variantId])))
        throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The publication response does not identify every pinned provider offer.");
      const hash=syncStageHash(accepted);
      if(row.publication_accepted_hash){
        if(row.publication_accepted_hash!==hash) throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The publication response differs from the result already saved for this request.");
        return;
      }
      await this.event(client,job,"stage_completed",{key:"publication_accepted",preparedIntentHash:hash,response:accepted},now);
      await client.query("UPDATE channels.ebay_listing_sync_jobs SET publication_accepted=$3::jsonb,publication_accepted_hash=$4 WHERE id=$1 AND owner_token=$2",
        [job.id,job.ownerToken,canonicalJson(accepted),hash]);
    });
  }
  async get(id: string): Promise<StoredEbayListingSyncJob> {
    const row = (await this.pool.query(rowSql + " WHERE id=$1", [id])).rows[0];
    if (!row)
      throw new EbayListingSyncError(
        "EBAY_SYNC_JOB_NOT_FOUND",
        "The listing sync job was not found.",
      );
    return decode(row);
  }
  async getByCommand(commandKey: string, channelId: number, transactionClient?: PoolClient): Promise<StoredEbayListingSyncJob | null> {
    // A second command can join an existing job. Recover a lost HTTP response
    // through that durable membership, never by assuming command ID equals job ID.
    const row = (await (transactionClient ?? this.pool).query(rowSql + ` WHERE channel_id=$2 AND id=(
      SELECT job_id FROM channels.ebay_listing_sync_commands WHERE command_key=$1)`, [commandKey, channelId])).rows[0];
    return row ? decode(row) : null;
  }
  async getAdmission(id: string, channelId: number): Promise<EbayListingSyncJob | null> {
    const row = (await this.pool.query(`SELECT command_key::text AS id,product_id AS "productId",operation,error_code AS code,error_message AS message,created_at
      FROM channels.ebay_listing_sync_admission_failures WHERE command_key=$1 AND channel_id=$2`, [id,channelId])).rows[0];
    return row ? ebayListingSyncJobSchema.parse({ ...row, kind: "admission",state: "needs_attention",
      nextAttemptAt: row.created_at.toISOString(),updatedAt: row.created_at.toISOString() }) : null;
  }
  async claim(
    now: Date,
    token: string,
    id?: string,
  ): Promise<EbayListingSyncClaim | null> {
    const client = await this.pool.connect();
    let lockedId: string | null = null;
    let lockedWorkflowKey: string | null = null;
    try {
      await client.query("BEGIN");
      const rows = (
        await client.query<{ id: string; channel_id: number; product_id: number }>(
          `SELECT id::text,channel_id,product_id FROM channels.ebay_listing_sync_jobs
        WHERE state IN ('queued','running','recovering','awaiting_evidence') AND next_attempt_at<=$1 AND ($2::uuid IS NULL OR id=$2)
        ORDER BY next_attempt_at,id LIMIT 20 FOR UPDATE SKIP LOCKED`,
          [now.toISOString(), id ?? null],
        )
      ).rows;
      for (const row of rows) {
        const acquired = (
          await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock($1,hashtext($2)) AS acquired",
            [LOCK_NAMESPACE, row.id],
          )
        ).rows[0]?.acquired;
        if (!acquired) continue;
        lockedId = row.id;
        const workflowKey = ebayListingWorkflowLockKey(row.channel_id, row.product_id);
        const workflowAcquired = (await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1,hashtext($2)) AS acquired",
          [EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, workflowKey])).rows[0]?.acquired;
        if (!workflowAcquired) {
          await client.query("SELECT pg_advisory_unlock($1,hashtext($2))", [LOCK_NAMESPACE,row.id]);
          lockedId = null;
          continue;
        }
        lockedWorkflowKey = workflowKey;
        await client.query(
          `UPDATE channels.ebay_listing_sync_jobs SET state='running',owner_token=$2,claimed_revision=revision,
          attempts=attempts+1,updated_at=$3 WHERE id=$1`,
          [row.id, token, now.toISOString()],
        );
        const job = decode(
          (await client.query(rowSql + " WHERE id=$1", [row.id])).rows[0],
        );
        await this.event(client, job, "claimed", {}, now);
        await client.query("COMMIT");
        this.clients.set(token, client);
        let released = false;
        return {
          job,
          release: async () => {
            if (released) return;
            released = true;
            this.clients.delete(token);
            try {
              await client.query("SELECT pg_advisory_unlock($1,hashtext($2))", [EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE,workflowKey]);
              await client.query("SELECT pg_advisory_unlock($1,hashtext($2))", [
                LOCK_NAMESPACE,
                row.id,
              ]);
              client.release();
            } catch (error) {
              client.release(true);
              throw error;
            }
          },
        };
      }
      await client.query("COMMIT");
      client.release();
      return null;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
        if (lockedWorkflowKey) await client.query("SELECT pg_advisory_unlock($1,hashtext($2))", [EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE,lockedWorkflowKey]);
        if (lockedId)
          await client.query("SELECT pg_advisory_unlock($1,hashtext($2))", [
            LOCK_NAMESPACE,
            lockedId,
          ]);
      } finally {
        client.release(true);
      }
      throw error;
    }
  }
  async stage(
    job: StoredEbayListingSyncJob,
    key: string,
    hash: string,
    state: "started" | "completed",
    now: Date,
  ): Promise<void> {
    if (!key || key.length > 300 || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error("Invalid listing stage evidence.");
    const client = this.client(job);
    await this.transaction(client, async () => {
      await this.assertOwner(client, job);
      // This is prepared intent, not the actual quantity-bearing request body;
      // inventory admission separately hashes its freshly authorized payload.
      await this.event(
        client,
        job,
        `stage_${state}`,
        { key, preparedIntentHash: hash },
        now,
      );
      if (key === "verification" && state === "started") {
        await client.query(
          `UPDATE channels.ebay_listing_sync_jobs SET verification_intent_hash=$3,verification_revision=claimed_revision
           WHERE id=$1 AND owner_token=$2`,
          [job.id, job.ownerToken, hash],
        );
      }
    });
  }
  async finish(
    job: StoredEbayListingSyncJob,
    outcome: Parameters<EbayListingSyncStore["finish"]>[1],
    now: Date,
  ): Promise<void> {
    const client = this.client(job);
    await this.transaction(client, async () => {
      await this.assertOwner(client, job);
      // Projection and completion are one transaction, fenced by the same owner.
      // Quantity projections belong to inventory publication, not this content job.
      const current=decode((await client.query(rowSql+" WHERE id=$1",[job.id])).rows[0]);
      const currentRevision=current.revision;
      // A business error after the send began cannot turn uncertainty into a
      // fresh publish command. Keep its saved recovery reachable and active.
      const retainBarrier=outcome.state==="needs_attention" && (hasPublicationBarrier(current) || (current.operation === "withdraw" && (current.withdrawalWriteCompleted || current.withdrawalWriteStarted)));
      if(retainBarrier) outcome={...outcome,state:"awaiting_evidence",resetAttempts:true,
        nextAttemptAt:new Date(Math.max(outcome.nextAttemptAt.getTime(),now.getTime()+PUBLICATION_EVIDENCE_RECHECK_MS))};
      if (job.operation === "publish" && outcome.result && outcome.state === "completed" && currentRevision === job.claimedRevision) {
        await this.projectPublication(client, job, outcome.result, now);
      } else if (job.operation === "withdraw" && outcome.result && outcome.state === "completed" && currentRevision === job.claimedRevision) {
        await this.projectWithdrawal(client, job, outcome.result, now);
      } else if (job.operation === "sync" && outcome.result)
        for (const detail of outcome.result.details) {
          const member = job.identity.variants.find(
            (v) =>
              v.variantId === detail.variantId && v.sku === detail.variantSku,
          );
          if (!member)
            throw new EbayListingSyncError(
              "EBAY_SYNC_RESULT_SCOPE_INVALID",
              "The sync result contains a different variant identity.",
            );
          const projected = await client.query(
            `UPDATE channels.channel_listings SET sync_status=$3,sync_error=$4,
          last_synced_price=CASE WHEN $5::integer IS NULL THEN last_synced_price ELSE $5 END,last_synced_at=$6,updated_at=$6
          WHERE channel_id=$1 AND product_variant_id=$2 AND external_sku IS NOT DISTINCT FROM $7
          AND external_variant_id IS NOT DISTINCT FROM $8 AND external_product_id IS NOT DISTINCT FROM $9`,
            [
              job.identity.channelId,
              member.variantId,
              detail.success ? "synced" : "error",
              detail.error ?? null,
              detail.success ? (detail.lastSyncedPriceCents ?? null) : null,
              now.toISOString(),
              member.externalSku,
              member.offerId,
              member.listingId,
            ],
          );
          if (projected.rowCount !== 1)
            throw new EbayListingSyncError(
              "EBAY_SYNC_PROJECTION_IDENTITY_CHANGED",
              "The exact listing projection changed before sync completion.",
            );
        }
      const changed = await client.query(
        `UPDATE channels.ebay_listing_sync_jobs SET
        state=CASE WHEN revision>claimed_revision THEN 'queued' ELSE $3 END,owner_token=NULL,claimed_revision=NULL,
        error_code=$4,error_message=$5,result=$6::jsonb,next_attempt_at=CASE WHEN revision>claimed_revision THEN $7::timestamptz ELSE $8::timestamptz END,
        attempts=CASE WHEN $9::boolean THEN 0 ELSE attempts END,
        updated_at=$7 WHERE id=$1 AND owner_token=$2 RETURNING id`,
        [
          job.id,
          job.ownerToken,
          outcome.state,
          outcome.code,
          outcome.message,
          JSON.stringify(outcome.result),
          now.toISOString(),
          outcome.nextAttemptAt.toISOString(),
          outcome.resetAttempts ?? false,
        ],
      );
      if (changed.rowCount !== 1)
        throw new EbayListingSyncError(
          "EBAY_SYNC_OWNER_LOST",
          "Listing sync ownership was lost.",
        );
      await this.event(
        client,
        job,
        outcome.state,
        { code: outcome.code, message: outcome.message },
        now,
      );
    });
  }
  private async projectWithdrawal(client: PoolClient, job: StoredEbayListingSyncJob,
    result: NonNullable<Parameters<EbayListingSyncStore["finish"]>[1]["result"]>, now: Date): Promise<void> {
    const verified = (await client.query(`SELECT 1 FROM channels.ebay_listing_sync_jobs j
      WHERE j.id=$1 AND j.provider_identity IS NOT NULL AND j.verification_revision=j.claimed_revision
      AND EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=j.id AND e.revision=j.claimed_revision
        AND e.owner_token=j.owner_token AND e.event='stage_completed' AND e.evidence->>'key'='verification'
        AND e.evidence->>'preparedIntentHash'=j.verification_intent_hash)`, [job.id])).rowCount;
    if (!verified || result.errors || result.details.length !== job.identity.variants.length
      || job.identity.variants.some(member => result.details.filter(detail => detail.success && detail.variantId===member.variantId && detail.variantSku===member.sku).length!==1))
      throw new EbayListingSyncError("EBAY_WITHDRAWAL_UNVERIFIED", "The exact eBay offers must be verified unpublished before ending the saved listing.");
    for (const member of job.identity.variants) {
      const changed = await client.query(`UPDATE channels.channel_listings SET sync_status='ended',sync_error=NULL,last_synced_at=$3,updated_at=$3
        WHERE channel_id=$1 AND product_variant_id=$2 AND external_sku IS NOT DISTINCT FROM $4
          AND external_variant_id IS NOT DISTINCT FROM $5 AND external_product_id IS NOT DISTINCT FROM $6`,
        [job.identity.channelId,member.variantId,now,member.externalSku,member.offerId,member.listingId]);
      if (changed.rowCount!==1) throw new EbayListingSyncError("EBAY_SYNC_PROJECTION_IDENTITY_CHANGED", "The listing mapping changed before withdrawal completion. Its saved identifiers were not overwritten.");
    }
  }
  private async projectPublication(client: PoolClient, job: StoredEbayListingSyncJob,
    result: NonNullable<Parameters<EbayListingSyncStore["finish"]>[1]["result"]>, now: Date): Promise<void> {
    const persisted = (await client.query(`SELECT provider_identity,EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events evidence
      WHERE evidence.job_id=job.id AND evidence.revision=job.claimed_revision AND evidence.owner_token=job.owner_token
        AND evidence.event='stage_completed' AND evidence.evidence->>'key'='verification'
        AND evidence.evidence->>'preparedIntentHash'=job.verification_intent_hash AND job.verification_revision=job.claimed_revision) AS verified
      FROM channels.ebay_listing_sync_jobs job WHERE id=$1`, [job.id])).rows[0];
    if (!persisted?.provider_identity || !persisted.verified) throw new EbayListingSyncError("EBAY_SYNC_PUBLICATION_UNVERIFIED", "Publication cannot finish before eBay's exact published listing and this request's current content are verified.");
    const published = ebayListingSyncIdentitySchema.parse(persisted.provider_identity);
    const savedObservation = (await client.query(`SELECT evidence->'observation' AS observation FROM channels.ebay_listing_sync_events
      WHERE job_id=$1 AND event='stage_completed' AND evidence->>'key'='provider_identity'
        AND evidence->'identity'=$2::jsonb ORDER BY id LIMIT 1`, [job.id, canonicalJson(published)])).rows[0]?.observation;
    const observation = assertEbayPublicationObservation(published, savedObservation && {
      ...savedObservation, observedAt: new Date(savedObservation.observedAt),
    });
    const compatibility = { owner: { kind: "channel" as const, channelId: published.channelId, productId: published.productId,
      provider: "ebay" as const, marketplaceId: published.marketplaceId }, observation,
      memberCandidates: published.variants.map(member => ({ productVariantId: member.variantId, sku: member.sku,
        isActive: member.contentSyncEnabled !== false, availableQuantity: 0 })) };
    // Use the same account -> catalog -> canonical-scope lock order as mapping
    // repair/registration. Retain locks through local projection and completion.
    const registration = new PgMarketplaceListingRegistrationRepository();
    await registration.acquireMappingCompatibilityLocks(compatibility, client);
    await client.query("LOCK TABLE channels.channel_listings IN SHARE ROW EXCLUSIVE MODE");
    const connections = (await client.query("SELECT id FROM channels.channel_connections WHERE channel_id=$1 ORDER BY id FOR UPDATE", [published.channelId])).rows;
    const account = (await client.query(`SELECT external_account_id,external_account_identity_scheme,external_account_verified_at
      FROM ebay.ebay_oauth_tokens WHERE channel_id=$1 AND environment=$2 FOR UPDATE`,
      [published.channelId, observation.providerAccount.accountNamespace])).rows[0];
    if (connections.length !== 1 || connections[0].id !== published.connectionId || account?.external_account_id !== published.accountId
      || account?.external_account_identity_scheme !== "provider_user_id" || !account?.external_account_verified_at)
      throw new EbayListingSyncError("EBAY_SYNC_ACCOUNT_CHANGED", "The connected eBay account changed before publication could be saved. Reconnect the intended account and check the saved publication.");
    const expected = job.identity.variants.filter(member => member.contentSyncEnabled !== false);
    if (result.errors !== 0 || result.details.length !== expected.length || new Set(result.details.map(detail => detail.variantId)).size !== expected.length
      || expected.some(member => !result.details.some(detail => detail.variantId === member.variantId && detail.variantSku === member.sku && detail.success)))
      throw new EbayListingSyncError("EBAY_SYNC_RESULT_SCOPE_INVALID", "The publication result must account for every requested variant before completion.");
    // Lock all source variants before mappings: their FK prevents a new mapping
    // appearing after an absence check. Existing mappings still need exact CAS.
    const variants = (await client.query("SELECT id,sku FROM catalog.product_variants WHERE product_id=$1 ORDER BY id FOR UPDATE", [job.identity.productId])).rows;
    await registration.assertCompatiblePublication(compatibility, client);
    await assertEbayMappingOwnership(published, client);
    for (const source of job.identity.variants) {
      if (!variants.some(row => row.id === source.variantId && (source.catalogSku === undefined || row.sku === source.catalogSku)))
        throw new EbayListingSyncError("EBAY_SYNC_PROJECTION_IDENTITY_CHANGED", "The catalog variant changed before publication could be saved.");
      const current = (await client.query("SELECT external_sku,external_variant_id,external_product_id FROM channels.channel_listings WHERE channel_id=$1 AND product_variant_id=$2 FOR UPDATE",
        [job.identity.channelId,source.variantId])).rows[0];
      if (source.mappingExists === undefined || Boolean(current) !== source.mappingExists || (current &&
        (current.external_sku !== source.externalSku || current.external_variant_id !== source.offerId || current.external_product_id !== source.listingId)))
        throw new EbayListingSyncError("EBAY_SYNC_PROJECTION_IDENTITY_CHANGED", "The exact saved mapping changed before publication could be recorded. The verified provider result remains saved for recovery.");
      const observed = published.variants.find(member => member.variantId === source.variantId && member.sku === source.sku);
      if (!observed?.offerId || !observed.listingId || observed.externalSku !== source.sku)
        throw new EbayListingSyncError("EBAY_SYNC_PUBLICATION_UNVERIFIED", "The final eBay publication is missing an exact member identity.");
      const detail = result.details.find(item => item.variantId === source.variantId);
      // Retained excluded members receive exact identity only; their historical
      // content error/price is not represented as a successful content update.
      if (current) {
        await client.query(`UPDATE channels.channel_listings SET external_sku=$3,external_variant_id=$4,external_product_id=$5,
          sync_status=CASE WHEN $6 THEN 'synced' ELSE sync_status END,sync_error=CASE WHEN $6 THEN NULL ELSE sync_error END,
          last_synced_price=COALESCE($7::integer,last_synced_price),last_synced_at=CASE WHEN $6 THEN $8 ELSE last_synced_at END,updated_at=$8
          WHERE channel_id=$1 AND product_variant_id=$2`, [job.identity.channelId,source.variantId,observed.externalSku,observed.offerId,observed.listingId,
          Boolean(detail),detail?.lastSyncedPriceCents ?? null,now]);
      } else {
        await client.query(`INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,
          sync_status,sync_error,last_synced_price,last_synced_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$8,$8)`,
          [job.identity.channelId,source.variantId,observed.externalSku,observed.offerId,observed.listingId,detail ? "synced" : "pending",detail?.lastSyncedPriceCents ?? null,now]);
      }
    }
  }
  private client(job: StoredEbayListingSyncJob): PoolClient {
    const client = job.ownerToken && this.clients.get(job.ownerToken);
    if (!client)
      throw new EbayListingSyncError(
        "EBAY_SYNC_OWNER_LOST",
        "Listing sync ownership was lost.",
      );
    return client;
  }
  private async assertOwner(
    client: PoolClient,
    job: StoredEbayListingSyncJob,
  ): Promise<void> {
    const found = await client.query(
      "SELECT id FROM channels.ebay_listing_sync_jobs WHERE id=$1 AND owner_token=$2 AND claimed_revision=$3 AND state='running' FOR UPDATE",
      [job.id, job.ownerToken, job.claimedRevision],
    );
    if (found.rowCount !== 1)
      throw new EbayListingSyncError(
        "EBAY_SYNC_OWNER_LOST",
        "Listing sync ownership was lost.",
      );
  }
  private event(
    client: PoolClient,
    job: StoredEbayListingSyncJob,
    event: string,
    evidence: unknown,
    now: Date,
  ): Promise<unknown> {
    return client.query(
      `INSERT INTO channels.ebay_listing_sync_events(job_id,revision,event,owner_token,evidence,created_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        job.id,
        job.claimedRevision ?? job.revision,
        event,
        job.ownerToken,
        canonicalJson(evidence),
        now.toISOString(),
      ],
    );
  }
  private async transaction<T>(
    client: PoolClient,
    work: () => Promise<T>,
  ): Promise<T> {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      const value = await work();
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new EbayListingSyncError(
          "EBAY_SYNC_PERSISTENCE_FAILED",
          "The local sync transaction could not finish. Saved work will be checked again.",
          {
            cause: new AggregateError(
              [error, rollbackError],
              "Sync rollback failed.",
            ),
          },
        );
      }
      // Database/audit failure is a local persistence fault, not a provider
      // rejection. Preserve its cause for diagnostics without exposing SQL.
      if (error instanceof EbayListingSyncError) throw error;
      if (error instanceof Error && "code" in error && error.code === "EBAY_MAPPING_CANONICAL_CONFLICT")
        throw new EbayListingSyncError(error.code, error.message, { cause: error });
      throw new EbayListingSyncError(
        "EBAY_SYNC_PERSISTENCE_FAILED",
        "The local sync transaction could not finish. Saved work will be checked again.",
        { cause: error },
      );
    }
  }
}
