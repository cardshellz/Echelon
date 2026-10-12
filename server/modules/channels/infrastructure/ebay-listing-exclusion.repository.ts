import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ebayProductExclusionRequestSchema, ebayProductExclusionResultSchema, type EbayProductExclusionResult } from "@shared/types/ebay-listing-exclusion";
import { ebayListingSyncJobSchema } from "@shared/types/ebay-listing-sync";
import { setCatalogEbayProductExclusion } from "../../catalog/channel-listing-intent";
import { EbayListingSyncError, type EbayListingSyncIdentity } from "../ebay-listing-sync.domain";
import { PostgresEbayListingSyncRepository } from "./ebay-listing-sync.repository";
import { EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE as lockNamespace, ebayListingWorkflowLockKey } from "../ebay-listing-workflow-lock";

const idSchema = z.number().int().positive().max(2_147_483_647);
interface ExclusionReceipt {
  command_key: string;
  channel_id: number;
  product_id: number;
  actor: string;
  excluded: boolean;
  job_id: string | null;
}

/** Local product intent and its remote follow-up commit together. Provider work
 * belongs to the existing listing worker and never runs inside this transaction. */
export class PostgresEbayListingExclusionRepository {
  private readonly jobs: PostgresEbayListingSyncRepository;
  constructor(
    private readonly pool: Pick<Pool, "connect" | "query">,
    private readonly channelId: number,
    private readonly readSource: (client: PoolClient, productId: number) => Promise<EbayListingSyncIdentity>,
    private readonly clock: () => Date,
  ) {
    idSchema.parse(channelId);
    this.jobs = new PostgresEbayListingSyncRepository(pool);
  }

  async get(productId: number, commandKey: string): Promise<EbayProductExclusionResult> {
    idSchema.parse(productId);
    z.string().uuid().parse(commandKey);
    const row = (await this.pool.query<ExclusionReceipt>(
      "SELECT * FROM channels.ebay_listing_exclusion_commands WHERE command_key=$1 AND channel_id=$2 AND product_id=$3",
      [commandKey, this.channelId, productId],
    )).rows[0];
    if (!row) throw new EbayListingSyncError("EBAY_SYNC_JOB_NOT_FOUND", "This exclusion request has no saved receipt yet. Retry the same request.");
    return this.result(row, true);
  }

  async set(productId: number, raw: unknown, actorInput: string): Promise<EbayProductExclusionResult> {
    idSchema.parse(productId);
    const command = ebayProductExclusionRequestSchema.parse(raw);
    const actor = z.string().trim().min(1).max(200).parse(actorInput);
    const now = z.date().parse(this.clock());
    const client = await this.pool.connect();
    let committed = false;
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [lockNamespace, `enqueue:${this.channelId}:${productId}`]);
      await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [lockNamespace, `command:${command.commandKey}`]);
      const replay = (await client.query<ExclusionReceipt>("SELECT * FROM channels.ebay_listing_exclusion_commands WHERE command_key=$1", [command.commandKey])).rows[0];
      if (replay) {
        if (replay.channel_id !== this.channelId || replay.product_id !== productId || replay.actor !== actor || replay.excluded !== command.excluded)
          throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This request belongs to another product, action or requester.");
        await client.query("COMMIT");
        committed = true;
        return await this.result(replay, true, client);
      }
      if ((await client.query(`SELECT 1 FROM channels.ebay_listing_sync_admission_failures WHERE command_key=$1
        UNION ALL SELECT 1 FROM channels.ebay_listing_mapping_rejections WHERE command_key=$1`, [command.commandKey])).rowCount)
        throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This command already belongs to a rejected listing request. Use the exact saved request's recovery path.");
      const active = (await client.query<{ id: string }>(`SELECT id::text FROM channels.ebay_listing_sync_jobs
        WHERE channel_id=$1 AND product_id=$2 AND operation='withdraw'
          AND state IN ('queued','running','recovering','awaiting_evidence') LIMIT 1`, [this.channelId, productId])).rows[0];
      if (!command.excluded && active)
        throw Object.assign(new EbayListingSyncError("EBAY_WITHDRAWAL_IN_PROGRESS", "This product's saved withdrawal must finish before it can be included again."), { jobId: active.id });
      const acquired = (await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS acquired",
        [lockNamespace, ebayListingWorkflowLockKey(this.channelId, productId)])).rows[0]?.acquired;
      if (!acquired) throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY", "A listing update is running. Retry this same exclusion request after that update finishes.");
      const product = (await client.query<{ id: number; ebay_listing_excluded: boolean }>(
        "SELECT id,ebay_listing_excluded FROM catalog.products WHERE id=$1 FOR UPDATE", [productId])).rows[0];
      if (!product) throw new EbayListingSyncError("EBAY_SYNC_PRODUCT_NOT_FOUND", "The selected product no longer exists.");
      const before = (await client.query<{ is_listed: number | null }>(
        "SELECT is_listed FROM channels.channel_product_overrides WHERE channel_id=$1 AND product_id=$2 FOR UPDATE", [this.channelId, productId])).rows[0];
      await setCatalogEbayProductExclusion(client, productId, command.excluded);
      await client.query(`INSERT INTO channels.channel_product_overrides(channel_id,product_id,is_listed,created_at,updated_at) VALUES($1,$2,$3,$4,$4)
        ON CONFLICT(channel_id,product_id) DO UPDATE SET is_listed=EXCLUDED.is_listed,updated_at=EXCLUDED.updated_at`,
      [this.channelId, productId, command.excluded ? 0 : 1, now]);
      let jobId: string | null = null;
      const mapped = (await client.query(`SELECT 1 FROM channels.channel_listings cl JOIN catalog.product_variants v ON v.id=cl.product_variant_id
        WHERE cl.channel_id=$1 AND v.product_id=$2
          AND (cl.external_sku IS NOT NULL OR cl.external_variant_id IS NOT NULL OR cl.external_product_id IS NOT NULL) LIMIT 1`,
      [this.channelId, productId])).rowCount;
      if (command.excluded && !mapped) {
        const pendingPublication = (await client.query<{ id: string }>(`SELECT id::text FROM channels.ebay_listing_sync_jobs job
          WHERE channel_id=$1 AND product_id=$2 AND operation='publish' AND (
            state IN ('queued','running','recovering','awaiting_evidence') OR (state='needs_attention' AND (
              publication_accepted IS NOT NULL OR EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events evidence
                WHERE evidence.job_id=job.id AND evidence.event='stage_started' AND evidence.evidence->>'key'='publish'))))
          ORDER BY updated_at DESC LIMIT 1`, [this.channelId, productId])).rows[0];
        if (pendingPublication) throw Object.assign(new EbayListingSyncError("EBAY_PUBLICATION_PRIOR_WORK_REQUIRED",
          "A saved publication still owns this product's remote outcome. Open that request and finish its verification or recovery before excluding the listing."), { jobId: pendingPublication.id });
      }
      if (command.excluded && mapped) {
        const source = await this.readSource(client, productId);
        const job = await this.jobs.enqueueInsideTransaction(client, source, command.commandKey, actor, now, undefined, "withdraw");
        jobId = job.id;
      } else if ((await client.query("SELECT 1 FROM channels.ebay_listing_sync_commands WHERE command_key=$1", [command.commandKey])).rowCount) {
        throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This command key already belongs to a listing job.");
      }
      const row = (await client.query<ExclusionReceipt>(`INSERT INTO channels.ebay_listing_exclusion_commands
        (command_key,channel_id,product_id,actor,excluded,job_id,before_intent,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
      [command.commandKey, this.channelId, productId, actor, command.excluded, jobId,
        JSON.stringify({ catalogExcluded: product.ebay_listing_excluded, channelIsListed: before?.is_listed ?? null }), now])).rows[0];
      await client.query("COMMIT");
      committed = true;
      return await this.result(row, false, client);
    } catch (error) {
      if (!committed) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) {
          discard = true;
          throw new EbayListingSyncError("EBAY_EXCLUSION_PERSISTENCE_FAILED", "This request's saved result could not be confirmed. Retry the same command reference before changing the listing again.",
            { cause: new AggregateError([error, rollbackError], "Exclusion rollback failed.") });
        }
      }
      if (error instanceof Error && "code" in error && error.code === "55P03")
        throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY", "Another listing change is using this product. Retry this same saved request shortly.", { cause: error });
      throw error;
    } finally { client.release(discard); }
  }

  private async result(row: ExclusionReceipt, replayed: boolean, client?: PoolClient): Promise<EbayProductExclusionResult> {
    const job = row.job_id ? await this.jobs.getByCommand(row.command_key, row.channel_id, client) : null;
    if (row.job_id && (!job || job.id !== row.job_id || job.operation !== "withdraw" || job.productId !== row.product_id))
      throw new EbayListingSyncError("EBAY_EXCLUSION_PERSISTENCE_FAILED", "The saved exclusion receipt is missing its exact withdrawal job. Keep this command reference and inspect its saved status.");
    return ebayProductExclusionResultSchema.parse({ success: true, productId: row.product_id, excluded: row.excluded,
      commandKey: row.command_key, replayed, job: job ? ebayListingSyncJobSchema.parse(job) : null,
      remoteAction: row.job_id ? "queued_withdrawal" : row.excluded ? "local_exclusion" : "included" });
  }
}
