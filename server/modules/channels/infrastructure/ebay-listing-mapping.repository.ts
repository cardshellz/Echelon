import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "@shared/utils/canonical-json";
import { mappingRepairFailureDisposition, ebayListingMappingResultSchema, type EbayListingMappingResult } from "@shared/types/ebay-listing-mapping";
import { ebayListingSyncJobSchema } from "@shared/types/ebay-listing-sync";
import { marketplaceObservedListingPublicationSchema, type PgMarketplaceListingRegistrationRepository } from "../../marketplace-listings";
import { assertEbayListingSourceIdentityUnchanged } from "../ebay-existing-listing-identity";
import { ebayListingSyncIdentitySchema, EbayListingSyncError, syncStageHash } from "../ebay-listing-sync.domain";
import { EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, ebayListingWorkflowLockKey } from "../ebay-listing-workflow-lock";
import type { EbayListingMappingRepairPlan, EbayListingMappingRepairStore, EbayListingMappingSource, EbayListingMappingRejectedCommand } from "../ebay-listing-mapping.service";
import { PostgresEbayListingSyncRepository } from "./ebay-listing-sync.repository";

type MappingCandidateIdentity = Pick<EbayListingMappingSource["candidates"][number], "productVariantId" | "sku" | "isActive">;
export interface EbayListingMappingSourceSnapshot {
  identity: EbayListingMappingSource["identity"];
  environment: EbayListingMappingSource["environment"];
  candidates: readonly MappingCandidateIdentity[];
}
export interface EbayListingMappingRepositoryOptions {
  channelId: number;
  /** Must use this transaction client; this callback performs saved reads only. */
  readSourceInsideTransaction(client: PoolClient, productId: number): Promise<EbayListingMappingSourceSnapshot>;
  canonicalRegistration: Pick<PgMarketplaceListingRegistrationRepository, "acquireMappingCompatibilityLocks" | "assertCompatiblePublication">;
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const actorSchema = z.string().trim().min(1).max(200);
const lookupSchema = z.object({ productId: z.number().int().positive().max(2147483647), channelId: z.number().int().positive().max(2147483647),
  commandKey: z.string().uuid(), requestHash: hash.optional(), actor: actorSchema.optional() }).strict();
type ReplayLookup = z.infer<typeof lookupSchema>;

/** Changes only Channels' local identifiers. Provider observation precedes this
 * short transaction; no provider request or quantity acknowledgement occurs here. */
export class PostgresEbayListingMappingRepairRepository implements EbayListingMappingRepairStore {
  private readonly sync: PostgresEbayListingSyncRepository;
  constructor(private readonly pool: Pool, private readonly options: EbayListingMappingRepositoryOptions) {
    z.number().int().positive().max(2147483647).parse(options.channelId);
    this.sync = new PostgresEbayListingSyncRepository(pool);
  }

  async findReplay(input: ReplayLookup): Promise<EbayListingMappingResult | null> {
    const lookup = lookupSchema.parse(input);
    if (lookup.channelId !== this.options.channelId) throw replayConflict();
    return this.readReplay(this.pool, lookup);
  }

  async rejectReviewedCommand(input: EbayListingMappingRejectedCommand): Promise<EbayListingMappingResult> {
    const lookup = lookupSchema.parse({ productId:input.productId,channelId:input.channelId,commandKey:input.commandKey,requestHash:input.requestHash,actor:input.actor });
    if (lookup.channelId !== this.options.channelId || input.requestHash !== syncStageHash({productId:lookup.productId,channelId:lookup.channelId,
      actor:lookup.actor,reviewHash:hash.parse(input.reviewHash)})) throw replayConflict();
    const now = z.date().parse(input.now);
    const code = z.string().regex(/^[A-Z0-9_]{1,100}$/).parse(input.code);
    const message = z.string().min(1).max(1000).parse(input.message);
    if (mappingRepairFailureDisposition(code) !== "review_again")
      throw new EbayListingSyncError("EBAY_MAPPING_REJECTION_INVALID", "This failure does not prove the mapping command was refused. Keep its request reference and check the saved result.");
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE,`enqueue:${lookup.channelId}:${lookup.productId}`]);
      await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE,`command:${lookup.commandKey}`]);
      const replay = await this.readReplay(client,lookup);
      if (replay) { await client.query("COMMIT"); return replay; }
      if ((await client.query(`SELECT 1 FROM channels.ebay_listing_sync_commands WHERE command_key=$1
        UNION ALL SELECT 1 FROM channels.ebay_listing_sync_admission_failures WHERE command_key=$1`,[lookup.commandKey])).rowCount) throw replayConflict();
      await client.query(`INSERT INTO channels.ebay_listing_mapping_rejections(command_key,channel_id,product_id,request_hash,review_hash,actor,error_code,error_message,rejected_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[lookup.commandKey,lookup.channelId,lookup.productId,lookup.requestHash,input.reviewHash,lookup.actor,code,message,now]);
      await client.query("COMMIT");
    } catch(error) {
      try { await client.query("ROLLBACK"); } catch(rollbackError) { discard=true; throw new EbayListingSyncError("EBAY_MAPPING_PERSISTENCE_FAILED", "The review refusal could not be confirmed. Check the saved request before starting another review.", {cause:new AggregateError([error,rollbackError],"Mapping refusal rollback failed.")}); }
      if(error instanceof EbayListingSyncError) throw error;
      throw new EbayListingSyncError("EBAY_MAPPING_PERSISTENCE_FAILED", "The review refusal could not be saved. Retry this same request to determine its outcome.", {cause:error});
    } finally { client.release(discard); }
    // Throw only after the rejection commits. A concurrent slower provider read
    // with the same command can no longer turn this refusal into a later repair.
    throw new EbayListingSyncError(code,message);
  }

  async apply(input: EbayListingMappingRepairPlan): Promise<EbayListingMappingResult> {
    const plan = validatePlan(input, this.options.channelId);
    const identity = plan.provenIdentity;
    const lookup = { productId: identity.productId, channelId: identity.channelId,
      commandKey: plan.commandKey, requestHash: plan.requestHash, actor: plan.actor };
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      // Match ordinary enqueue's lock order, then use a nonblocking workflow
      // lock so a provider write in flight cannot race a mapping correction.
      await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE,`enqueue:${identity.channelId}:${identity.productId}`]);
      await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE,`command:${plan.commandKey}`]);
      const replay = await this.readReplay(client, lookup);
      if (replay) { await client.query("COMMIT"); return replay; }
      if ((await client.query(`SELECT 1 FROM channels.ebay_listing_sync_commands WHERE command_key=$1
        UNION ALL SELECT 1 FROM channels.ebay_listing_sync_admission_failures WHERE command_key=$1`, [plan.commandKey])).rowCount)
        throw replayConflict();
      const locked = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS locked",
        [EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE,ebayListingWorkflowLockKey(identity.channelId,identity.productId)])).rows[0]?.locked;
      if (!locked) throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY", "This product has a listing update in progress. Wait for it to finish, then review the mapping again.");
      // Registration takes account identity before catalog variants. Acquire
      // that prefix before either our catalog rows or listing-table write lock;
      // the complete scope check follows the source fence to match verification.
      await this.options.canonicalRegistration.acquireMappingCompatibilityLocks({
        owner: {kind:"channel",channelId:identity.channelId,productId:identity.productId,provider:"ebay",marketplaceId:identity.marketplaceId},
        observation:plan.observation,memberCandidates:plan.source.candidates,
      },client);
      // Rare, short local repair transactions serialize with every existing
      // mapping writer. This proves apply-time exclusivity; a later independent
      // legacy edit still faces the normal source fence before provider writes.
      await client.query("LOCK TABLE channels.channel_listings IN SHARE ROW EXCLUSIVE MODE");
      await this.lockSource(client, plan);
      const current = await this.options.readSourceInsideTransaction(client, identity.productId);
      assertEbayListingSourceIdentityUnchanged(plan.source.identity, current.identity);
      if (current.environment !== plan.source.environment || candidateHash(current.candidates) !== candidateHash(plan.source.candidates))
        throw new EbayListingSyncError("EBAY_MAPPING_REVIEW_CHANGED", "The eBay account environment or product membership changed. Review the mapping again.");
      await this.options.canonicalRegistration.assertCompatiblePublication({
        owner: { kind: "channel", channelId: identity.channelId, productId: identity.productId, provider: "ebay", marketplaceId: identity.marketplaceId },
        observation: plan.observation, memberCandidates: plan.source.candidates,
      }, client);
      await this.checkMappingOwnership(identity, client);
      const beforeRows = (await client.query(`SELECT to_jsonb(cl) AS record FROM channels.channel_listings cl
        WHERE channel_id=$1 AND product_variant_id=ANY($2::integer[]) ORDER BY product_variant_id FOR UPDATE`,
      [identity.channelId,identity.variants.map(member => member.variantId)])).rows.map(row => row.record);
      if (beforeRows.length !== identity.variants.length) throw sourceChanged();
      for (const member of identity.variants) {
        const before = plan.source.identity.variants.find(variant => variant.variantId === member.variantId)!;
        const result = await client.query(`UPDATE channels.channel_listings SET external_sku=$3,external_variant_id=$4,external_product_id=$5,
          external_url=$6,updated_at=$7 WHERE channel_id=$1 AND product_variant_id=$2
          AND external_sku IS NOT DISTINCT FROM $8 AND external_variant_id IS NOT DISTINCT FROM $9 AND external_product_id IS NOT DISTINCT FROM $10`,
        [identity.channelId,member.variantId,member.externalSku,member.offerId,member.listingId,plan.observation.externalUrl,plan.now,
          before.externalSku,before.offerId,before.listingId]);
        if (result.rowCount !== 1) throw sourceChanged();
      }
      const afterRows = (await client.query(`SELECT to_jsonb(cl) AS record FROM channels.channel_listings cl
        WHERE channel_id=$1 AND product_variant_id=ANY($2::integer[]) ORDER BY product_variant_id`,
      [identity.channelId,identity.variants.map(member => member.variantId)])).rows.map(row => row.record);
      const job = await this.sync.enqueueInsideTransaction(client, identity, plan.commandKey, plan.actor, plan.now, identity);
      assertEbayListingSourceIdentityUnchanged(job.identity, identity);
      await client.query(`INSERT INTO channels.ebay_listing_mapping_repairs(command_key,channel_id,connection_id,product_id,
        environment,request_hash,review_hash,actor,before_identity,after_identity,queued_identity,before_rows,after_rows,observation,job_id,applied_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16)`,
      [plan.commandKey,identity.channelId,identity.connectionId,identity.productId,plan.source.environment,plan.requestHash,plan.reviewHash,
        plan.actor,canonicalJson(plan.source.identity),canonicalJson(identity),canonicalJson(job.identity),canonicalJson(beforeRows),canonicalJson(afterRows),
        canonicalJson(plan.observation),job.id,plan.now]);
      await client.query("COMMIT");
      return ebayListingMappingResultSchema.parse({ repairStatus: "queued", job, replayed: false,
        receipt: { commandKey: plan.commandKey, productId: identity.productId, reviewHash:plan.reviewHash, appliedAt: plan.now.toISOString() } });
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { discard = true; throw new EbayListingSyncError("EBAY_MAPPING_PERSISTENCE_FAILED", "The mapping repair result could not be confirmed. Retry the same request to retrieve its receipt.",
        { cause: new AggregateError([error,rollbackError], "Mapping repair rollback failed.") }); }
      if (error instanceof EbayListingSyncError || (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("EBAY_"))) throw error;
      if (error instanceof Error && "code" in error && error.code === "55P03")
        throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY", "Another listing change is using these mappings. Wait for it to finish, then retry this repair request.", { cause: error });
      throw new EbayListingSyncError("EBAY_MAPPING_PERSISTENCE_FAILED", "The mapping repair could not finish. Retry the same request to check its saved result.", { cause: error });
    } finally { client.release(discard); }
  }

  private async lockSource(client: PoolClient, plan: EbayListingMappingRepairPlan): Promise<void> {
    const identity = plan.source.identity;
    const channel = (await client.query("SELECT provider FROM channels.channels WHERE id=$1 FOR UPDATE", [identity.channelId])).rows[0];
    if (channel?.provider?.toLowerCase() !== "ebay") throw sourceChanged();
    const connections = (await client.query("SELECT id FROM channels.channel_connections WHERE channel_id=$1 ORDER BY id FOR UPDATE", [identity.channelId])).rows;
    if (connections.length !== 1 || connections[0].id !== identity.connectionId) throw sourceChanged();
    const account = (await client.query(`SELECT external_account_id,external_account_identity_scheme,external_account_verified_at
      FROM ebay.ebay_oauth_tokens WHERE channel_id=$1 AND environment=$2 FOR UPDATE`, [identity.channelId,plan.source.environment])).rows[0];
    if (account?.external_account_id !== identity.accountId || account?.external_account_identity_scheme !== "provider_user_id" || !account?.external_account_verified_at) throw sourceChanged();
    if (!(await client.query("SELECT id FROM catalog.products WHERE id=$1 FOR UPDATE", [identity.productId])).rowCount) throw sourceChanged();
    // Parent row locks also prevent a concurrent new mapping/override referencing
    // an existing variant and a new variant referencing this product.
    await client.query("SELECT id FROM catalog.product_variants WHERE product_id=$1 ORDER BY id FOR UPDATE", [identity.productId]);
    // Parent locks prevent new child rows, but non-key changes to existing
    // eligibility overrides need their own locks through the source reread.
    await client.query("SELECT id FROM channels.channel_product_overrides WHERE channel_id=$1 AND product_id=$2 ORDER BY id FOR UPDATE", [identity.channelId,identity.productId]);
    await client.query(`SELECT id FROM channels.channel_variant_overrides WHERE channel_id=$1
      AND product_variant_id IN (SELECT id FROM catalog.product_variants WHERE product_id=$2) ORDER BY id FOR UPDATE`, [identity.channelId,identity.productId]);
    await client.query(`SELECT id FROM ebay.ebay_category_mappings WHERE channel_id=$1
      AND product_type_slug=(SELECT product_type FROM catalog.products WHERE id=$2) ORDER BY id FOR UPDATE`, [identity.channelId,identity.productId]);
    await client.query("SELECT product_variant_id FROM channels.channel_listings WHERE channel_id=$1 AND product_variant_id=ANY($2::integer[]) ORDER BY product_variant_id FOR UPDATE", [identity.channelId,identity.variants.map(member => member.variantId)]);
  }

  /** Preview and apply use the same exact local ownership check. The apply
   * caller additionally owns the short table lock and transaction source fence. */
  async checkMappingOwnership(input: EbayListingMappingSource["identity"], transactionClient?: PoolClient): Promise<void> {
    const identity = ebayListingSyncIdentitySchema.parse(input);
    if (identity.channelId !== this.options.channelId) throw sourceChanged();
    const client = transactionClient ?? this.pool;
    const rows = (await client.query(`SELECT product_variant_id,external_sku,external_variant_id,external_product_id FROM channels.channel_listings
      WHERE channel_id=$1 AND (external_sku=ANY($2::text[]) OR external_variant_id=ANY($3::text[]) OR external_product_id=ANY($4::text[]))
      ORDER BY product_variant_id`, [identity.channelId,identity.variants.map(member => member.sku),
      identity.variants.map(member => member.offerId),identity.variants.map(member => member.listingId)])).rows;
    const owned = new Set(identity.variants.map(member => member.variantId));
    const conflicts = rows.filter(row => !owned.has(row.product_variant_id) || identity.variants.some(member => member.variantId !== row.product_variant_id
      && (member.sku === row.external_sku || member.offerId === row.external_variant_id)));
    if (conflicts.length) {
      const details = conflicts.slice(0,5).map(row => `variant ${row.product_variant_id ?? "unassigned"}${row.external_sku ? ` (eBay SKU ${row.external_sku})` : ""}`).join(", ");
      throw new EbayListingSyncError("EBAY_MAPPING_OWNERSHIP_CONFLICT", `The observed eBay identifiers are already mapped to ${details}. Review both mappings before applying a repair.`);
    }
  }

  private async readReplay(db: Pick<Pool, "query"> | PoolClient, lookup: ReplayLookup): Promise<EbayListingMappingResult | null> {
    const receipt = (await db.query(`SELECT command_key::text,channel_id,product_id,request_hash,review_hash,actor,job_id::text,applied_at
      FROM channels.ebay_listing_mapping_repairs WHERE command_key=$1`, [lookup.commandKey])).rows[0];
    if (!receipt) {
      const rejection=(await db.query(`SELECT channel_id,product_id,request_hash,actor,error_code,error_message
        FROM channels.ebay_listing_mapping_rejections WHERE command_key=$1`,[lookup.commandKey])).rows[0];
      if (!rejection) return null;
      if (rejection.channel_id!==lookup.channelId || rejection.product_id!==lookup.productId
        || (lookup.requestHash!==undefined && rejection.request_hash!==lookup.requestHash)
        || (lookup.actor!==undefined && rejection.actor!==lookup.actor)) throw replayConflict();
      throw new EbayListingSyncError(rejection.error_code,rejection.error_message);
    }
    if (receipt.channel_id !== lookup.channelId || receipt.product_id !== lookup.productId
      || (lookup.requestHash !== undefined && receipt.request_hash !== lookup.requestHash)
      || (lookup.actor !== undefined && receipt.actor !== lookup.actor)) throw replayConflict();
    const row = (await db.query(`SELECT id::text,product_id AS "productId",state,error_code AS code,error_message AS message,
      next_attempt_at AS "nextAttemptAt",updated_at AS "updatedAt" FROM channels.ebay_listing_sync_jobs WHERE id=$1`, [receipt.job_id])).rows[0];
    if (!row) throw new EbayListingSyncError("EBAY_MAPPING_PERSISTENCE_FAILED", "The saved mapping repair is missing its follow-up sync request. Ask support to inspect the repair receipt.");
    const job = ebayListingSyncJobSchema.parse({ ...row, nextAttemptAt: row.nextAttemptAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
    return ebayListingMappingResultSchema.parse({ repairStatus: "queued",job,replayed:true,
      receipt: { commandKey: receipt.command_key, productId: receipt.product_id, reviewHash:receipt.review_hash, appliedAt: receipt.applied_at.toISOString() } });
  }
}

function candidateHash(candidates: readonly MappingCandidateIdentity[]): string {
  return syncStageHash(candidates.map(({productVariantId,sku,isActive}) => ({productVariantId,sku,isActive})).sort((a,b) => a.productVariantId-b.productVariantId));
}
function sourceChanged(): EbayListingSyncError {
  return new EbayListingSyncError("EBAY_MAPPING_REVIEW_CHANGED", "The saved eBay mapping or account changed. Review the current identifiers before applying a repair.");
}
function replayConflict(): EbayListingSyncError {
  return new EbayListingSyncError("EBAY_MAPPING_COMMAND_CONFLICT", "This repair command belongs to a different product, review or requester. Start a new mapping review.");
}
function validatePlan(input: EbayListingMappingRepairPlan, channelId: number): EbayListingMappingRepairPlan {
  const source = ebayListingSyncIdentitySchema.parse(input.source.identity);
  const next = ebayListingSyncIdentitySchema.parse(input.provenIdentity);
  const observation = marketplaceObservedListingPublicationSchema.parse(input.observation);
  const scope = (identity: typeof source) => ({ channelId: identity.channelId, connectionId: identity.connectionId,
    productId: identity.productId, accountId: identity.accountId, marketplaceId: identity.marketplaceId,
    variants: identity.variants.map(member => ({ variantId: member.variantId,sku: member.sku,catalogSku:member.catalogSku,contentSyncEnabled:member.contentSyncEnabled })).sort((a,b) => a.variantId-b.variantId) });
  if (source.channelId !== channelId || syncStageHash(scope(source)) !== syncStageHash(scope(next))
    || observation.providerAccount.provider !== "ebay" || observation.providerAccount.externalAccountId !== source.accountId
    || observation.providerAccount.accountNamespace !== input.source.environment || observation.marketplaceId !== source.marketplaceId
    || !observation.isPublished || next.groupKey !== (observation.publicationKeyIdentity?.externalId ?? null)
    || observation.members.length !== next.variants.length || next.variants.some(member => member.externalSku !== member.sku
      || member.listingId !== observation.listingIdentity.externalId || !observation.members.some(observed => observed.sku === member.sku
        && observed.inventoryItemIdentity?.externalId === member.sku && observed.offerIdentity?.externalId === member.offerId))) throw sourceChanged();
  if (input.requestHash !== syncStageHash({ productId: source.productId,channelId:source.channelId,
    actor:actorSchema.parse(input.actor),reviewHash:hash.parse(input.reviewHash) })) throw replayConflict();
  return { ...input, source: { ...input.source,identity:source,environment:z.enum(["production","sandbox"]).parse(input.source.environment) },
    provenIdentity:next,observation,commandKey:z.string().uuid().parse(input.commandKey),reviewHash:hash.parse(input.reviewHash),
    requestHash:hash.parse(input.requestHash),actor:actorSchema.parse(input.actor),now:z.date().parse(input.now) };
}
