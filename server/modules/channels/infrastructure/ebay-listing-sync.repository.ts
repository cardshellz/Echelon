import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  ebayListingSyncJobSchema,
  type EbayListingSyncJob,
} from "@shared/types/ebay-listing-sync";
import {
  EbayListingSyncError,
  storedEbayListingSyncJobSchema,
  syncIdentityHash,
  syncStageHash,
  type EbayListingSyncIdentity,
  type StoredEbayListingSyncJob,
} from "../ebay-listing-sync.domain";
import type {
  EbayListingSyncClaim,
  EbayListingSyncStore,
  EbaySyncAdmissionFailure,
} from "../ebay-listing-sync.service";
import { assertEbayListingSourceIdentityUnchanged } from "../ebay-existing-listing-identity";
import { EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, ebayListingWorkflowLockKey } from "../ebay-listing-workflow-lock";

const LOCK_NAMESPACE = 918427;
const rowSql = `SELECT id::text,product_id AS "productId",state,error_code AS code,error_message AS message,
  next_attempt_at AS "nextAttemptAt",updated_at AS "updatedAt",identity,revision::text,claimed_revision::text AS "claimedRevision",
  owner_token::text AS "ownerToken",attempts,result,verification_intent_hash AS "verificationIntentHash",
  verification_revision::text AS "verificationRevision",provider_identity AS "providerIdentity" FROM channels.ebay_listing_sync_jobs`;
function decode(row: Record<string, unknown>): StoredEbayListingSyncJob {
  return storedEbayListingSyncJobSchema.parse({
    ...row,
    nextAttemptAt: (row.nextAttemptAt as Date).toISOString(),
    updatedAt: (row.updatedAt as Date).toISOString(),
  });
}
export class PostgresEbayListingSyncRepository implements EbayListingSyncStore {
  private readonly clients = new Map<string, PoolClient>();
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}
  async enqueue(
    identity: EbayListingSyncIdentity,
    commandKey: string,
    actor: string,
    now: Date,
  ): Promise<StoredEbayListingSyncJob> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='2s'");
      const job = await this.enqueueInsideTransaction(client, identity, commandKey, actor, now);
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
  ): Promise<StoredEbayListingSyncJob> {
    // Product command serialization is distinct from quantity admission. Joining
    // a pending job records a new requested revision without taking its HTTP lock.
    await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [
      LOCK_NAMESPACE,
      `enqueue:${identity.channelId}:${identity.productId}`,
    ]);
    await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [LOCK_NAMESPACE, `command:${commandKey}`]);
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
      return job;
    }
    const active = (
      await client.query<{ id: string; identity: EbayListingSyncIdentity; providerIdentity: EbayListingSyncIdentity | null }>(
        `SELECT id::text,identity,provider_identity AS "providerIdentity" FROM channels.ebay_listing_sync_jobs
      WHERE channel_id=$1 AND product_id=$2 AND state IN ('queued','running','recovering','awaiting_evidence') FOR UPDATE`,
        [identity.channelId, identity.productId],
      )
    ).rows[0];
    let id: string;
    let reusable = !!active;
    if (active) {
      try {
        assertEbayListingSourceIdentityUnchanged(active.identity, identity);
        if (verifiedProviderIdentity && active.providerIdentity
          && syncIdentityHash(active.providerIdentity) !== syncIdentityHash(verifiedProviderIdentity))
          throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The verified provider resources changed. A fresh owned sync request is required.");
      }
      catch (error) {
        if (!(error instanceof EbayListingSyncError)) throw error;
        const locked = (await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS acquired", [LOCK_NAMESPACE, active.id])).rows[0]?.acquired;
        if (!locked) throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY", "An update using the earlier mapping is still running. The new mapping can be synced after that update finishes.");
        // Retain the old command and its provider evidence; only an idle job can
        // be superseded. Quantity admission independently fences unresolved writes.
        await client.query("UPDATE channels.ebay_listing_sync_jobs SET state='needs_attention',owner_token=NULL,claimed_revision=NULL,error_code='EBAY_SYNC_SOURCE_SUPERSEDED',error_message='A newer sync request replaced the changed source mapping.',updated_at=$2 WHERE id=$1", [active.id, now.toISOString()]);
        await client.query("INSERT INTO channels.ebay_listing_sync_events(job_id,revision,event,evidence,created_at) SELECT id,revision,'needs_attention',$2::jsonb,$3 FROM channels.ebay_listing_sync_jobs WHERE id=$1", [active.id, canonicalJson({ code: "EBAY_SYNC_SOURCE_SUPERSEDED", commandKey, actor }), now.toISOString()]);
        reusable = false;
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
        `INSERT INTO channels.ebay_listing_sync_jobs(id,channel_id,connection_id,product_id,identity,identity_hash,requested_by,created_at,updated_at,next_attempt_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$8,$8)`,
        [
          id,
          identity.channelId,
          identity.connectionId,
          identity.productId,
          JSON.stringify(identity),
          syncIdentityHash(identity),
          actor,
          now.toISOString(),
        ],
      );
    }
    await client.query(
      `INSERT INTO channels.ebay_listing_sync_commands(command_key,job_id,identity_hash,actor,created_at) VALUES($1,$2,$3,$4,$5)`,
      [commandKey, id, syncIdentityHash(identity), actor, now.toISOString()],
    );
    const job = decode(
      (await client.query(rowSql + " WHERE id=$1", [id])).rows[0],
    );
    await this.event(client, job, "requested", { commandKey, actor }, now);
    return job;
  }
  async list(channelId: number): Promise<EbayListingSyncJob[]> {
    return (
      await this.pool.query(
        `SELECT * FROM (SELECT DISTINCT ON ("productId") * FROM (
          SELECT id::text,product_id AS "productId",'sync' AS kind,state,error_code AS code,error_message AS message,
          next_attempt_at AS "nextAttemptAt",updated_at AS "updatedAt" FROM channels.ebay_listing_sync_jobs WHERE channel_id=$1
          UNION ALL SELECT command_key::text,product_id,'admission','needs_attention',error_code,error_message,created_at,created_at
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
    const client = await this.pool.connect();
    try {
      return await this.transaction(client, async () => {
        await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [LOCK_NAMESPACE, `enqueue:${input.channelId}:${input.productId}`]);
        await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [LOCK_NAMESPACE, `command:${input.commandKey}`]);
        if ((await client.query("SELECT 1 FROM channels.ebay_listing_sync_commands WHERE command_key=$1", [input.commandKey])).rowCount)
          throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This command already owns a saved sync job; inspect that job.");
        const hash = syncStageHash({ ...input, variantIds: [...input.variantIds].sort((a,b) => a-b) });
        await client.query(`INSERT INTO channels.ebay_listing_sync_admission_failures(command_key,channel_id,product_id,variant_ids,actor,error_code,error_message,request_hash,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(command_key) DO NOTHING`, [input.commandKey,input.channelId,input.productId,input.variantIds,input.actor,input.code,input.message,hash,now.toISOString()]);
        const row = (await client.query("SELECT *,command_key::text AS id,product_id AS \"productId\" FROM channels.ebay_listing_sync_admission_failures WHERE command_key=$1", [input.commandKey])).rows[0];
        if (row.request_hash !== hash) throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This rejected command belongs to a different request.");
        return ebayListingSyncJobSchema.parse({ id: row.id,productId: row.productId,kind: "admission",state: "needs_attention",code: row.error_code,message: row.error_message,nextAttemptAt: row.created_at.toISOString(),updatedAt: row.created_at.toISOString() });
      });
    } finally { client.release(); }
  }
  async bindProviderIdentity(job: StoredEbayListingSyncJob, identity: EbayListingSyncIdentity, now: Date): Promise<void> {
    const client = this.client(job);
    const hash = syncIdentityHash(identity);
    if (identity.productId !== job.identity.productId || identity.channelId !== job.identity.channelId
      || identity.connectionId !== job.identity.connectionId || identity.accountId !== job.identity.accountId
      || identity.marketplaceId !== job.identity.marketplaceId || identity.variants.length !== job.identity.variants.length
      || job.identity.variants.some(member => !identity.variants.some(resolved => resolved.variantId === member.variantId && resolved.sku === member.sku
        && (member.catalogSku === undefined || member.catalogSku === resolved.catalogSku)
        && (member.contentSyncEnabled ?? true) === (resolved.contentSyncEnabled ?? true)
        && resolved.externalSku === member.externalSku && (member.offerId === null || resolved.offerId === member.offerId)
        && (member.listingId === null || resolved.listingId === member.listingId))))
      throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The observed provider identity does not match this saved request.");
    await this.transaction(client, async () => {
      await this.assertOwner(client, job);
      const row = (await client.query("SELECT provider_identity_hash FROM channels.ebay_listing_sync_jobs WHERE id=$1", [job.id])).rows[0];
      if (row.provider_identity_hash) {
        if (row.provider_identity_hash !== hash) throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The eBay group, offers or listing changed since this job first verified them. Review its mapping and start a new sync.");
        return;
      }
      await this.event(client, job, "stage_completed", { key: "provider_identity", preparedIntentHash: hash, identity }, now);
      await client.query("UPDATE channels.ebay_listing_sync_jobs SET provider_identity=$3::jsonb,provider_identity_hash=$4 WHERE id=$1 AND owner_token=$2", [job.id,job.ownerToken,canonicalJson(identity),hash]);
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
  async getByCommand(commandKey: string, channelId: number): Promise<StoredEbayListingSyncJob | null> {
    // A second command can join an existing job. Recover a lost HTTP response
    // through that durable membership, never by assuming command ID equals job ID.
    const row = (await this.pool.query(rowSql + ` WHERE channel_id=$2 AND id=(
      SELECT job_id FROM channels.ebay_listing_sync_commands WHERE command_key=$1)`, [commandKey, channelId])).rows[0];
    return row ? decode(row) : null;
  }
  async getAdmission(id: string, channelId: number): Promise<EbayListingSyncJob | null> {
    const row = (await this.pool.query(`SELECT command_key::text AS id,product_id AS "productId",error_code AS code,error_message AS message,created_at
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
      if (outcome.result)
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
      throw new EbayListingSyncError(
        "EBAY_SYNC_PERSISTENCE_FAILED",
        "The local sync transaction could not finish. Saved work will be checked again.",
        { cause: error },
      );
    }
  }
}
