import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { listingMemberConflictListSchema, listingMemberIdentitySchema, listingMemberRetirementSchema, type ListingMemberIdentity, type ListingMemberRetirement } from "@shared/types/listing-member-lifecycle";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import { listingMemberRemoteKey } from "../domain/listing-member-lifecycle";
import type { ListingMemberLifecycleSession, ListingMemberLifecycleStore, ListingMemberProgress, ListingMemberRecoveryAuthorization } from "../application/listing-member-lifecycle.port";
import type { ListingAccount } from "@shared/types/channel-listing-publication";
import { ListingPublicationError } from "../domain/listing-publication";

const RETRY_MS = 60_000;
const LOCK_NAMESPACE = 2591013;
const positiveId = z.number().int().positive().max(2_147_483_647);
const batchLimit = z.number().int().min(1).max(250);
// Old rows predate dispatch_status. A count alone cannot prove no send: every
// retained event must have a valid identity, version and pre-dispatch state,
// and the last event must match the current state. The SQL alias is internal.
const provenNoDispatchSql = `r.dispatch_status='none' AND r.dispatch_key IS NULL
  AND r.verification_attempts=0 AND NOT r.recovery_required
  AND r.state IN ('pending','failed') AND COALESCE((SELECT
    count(*)=r.version AND min(e.version)=1 AND max(e.version)=r.version
    AND bool_and((e.after_state->>'id'=r.id::text AND e.after_state->>'version'=e.version::text
      AND e.after_state->>'identity_key'=r.identity_key AND e.after_state->>'source_revision'=r.source_revision
      AND e.after_state->>'product_id'=r.product_id::text AND e.after_state->>'product_variant_id'=r.product_variant_id::text
      AND e.after_state->'identity'=r.identity AND e.after_state->'source_identity'=r.source_identity
      AND e.after_state->>'state' IN ('pending','failed')
      AND COALESCE(e.after_state->>'dispatch_status','none')='none'
      AND COALESCE(e.after_state->>'dispatch_key','')=''
      AND COALESCE(e.after_state->>'verification_attempts','0')='0'
      AND COALESCE(e.after_state->>'recovery_required','false')='false') IS TRUE)
    AND bool_or(e.version=r.version AND e.after_state->>'state'=r.state
      AND (e.after_state->>'code' IS NOT DISTINCT FROM r.code))
    FROM marketplace.listing_member_retirement_events e WHERE e.operation_id=r.id),false)`;
// Older workers could supersede a request after dispatch. The terminal row is
// immutable, so derive the unresolved outcome from the retained event stream
// without changing or pretending to complete the historical request.
const legacyUnconfirmedSql = `r.state='superseded' AND NOT COALESCE(
  r.dispatch_status='none' AND r.dispatch_key IS NULL AND r.verification_attempts=0 AND NOT r.recovery_required
  AND (SELECT count(*)=r.version AND min(e.version)=1 AND max(e.version)=r.version
    AND bool_and((e.after_state->>'id'=r.id::text AND e.after_state->>'version'=e.version::text
      AND e.after_state->>'identity_key'=r.identity_key AND e.after_state->>'source_revision'=r.source_revision
      AND e.after_state->>'product_id'=r.product_id::text AND e.after_state->>'product_variant_id'=r.product_variant_id::text
      AND e.after_state->'identity'=r.identity AND e.after_state->'source_identity'=r.source_identity
      AND e.after_state->>'state' IN ('pending','failed','superseded')
      AND (e.after_state->>'state'<>'superseded' OR e.version=r.version)
      AND COALESCE(e.after_state->>'dispatch_status','none')='none'
      AND COALESCE(e.after_state->>'dispatch_key','')=''
      AND COALESCE(e.after_state->>'verification_attempts','0')='0'
      AND COALESCE(e.after_state->>'recovery_required','false')='false') IS TRUE)
    AND bool_or(e.version=r.version AND e.after_state->>'state'='superseded'
      AND (e.after_state->>'code' IS NOT DISTINCT FROM r.code))
    FROM marketplace.listing_member_retirement_events e WHERE e.operation_id=r.id),false)`;
interface Row { id: string; identity: unknown; source_identity: unknown; source_revision: string; state: string; code: string | null; message: string | null; verified_at: Date | null; version: number; dispatch_status: string; dispatch_key: string | null; verification_attempts: number; recovery_required: boolean; unconfirmed_prior_dispatch?: boolean; next_attempt_at?: Date | number | null }

function record(row: Row): ListingMemberRetirement {
  return listingMemberRetirementSchema.parse({ operationId: row.id, identity: row.identity, sourceRevision: row.source_revision,
    // Project legacy/incomplete audit evidence as unknown without changing the
    // immutable original row or adding fields to the existing API contract.
    version: row.version, dispatchStatus: row.dispatch_status === "none" && (row.state === "retiring" || row.unconfirmed_prior_dispatch)
      ? "unknown" : row.dispatch_status,
    dispatchKey: row.dispatch_key, verificationAttempts: row.verification_attempts, recoveryRequired: row.recovery_required,
    state: row.state, code: row.code, message: row.message, verifiedAt: row.verified_at?.toISOString() ?? null });
}

/**
 * Takes the remote-member lock of one listing member until the caller's transaction ends, without waiting: the one
 * lock every remote removal of that member holds across its provider calls (retirement's withMember below, and
 * Dropship's listing end worker, PR C PLAN-C v4.1 §5.5). The key is the remote identity (listingMemberRemoteKey), so
 * two local connections addressing the same provider member serialize. Published through listing-member-lifecycle.ts;
 * the namespace stays private to this file. False: another remover holds it, nothing was locked.
 */
export async function tryLockListingMemberRemote(client: Pick<PoolClient, "query">, identity: ListingMemberIdentity): Promise<boolean> {
  const locked = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS locked",
    [LOCK_NAMESPACE, listingMemberRemoteKey(listingMemberIdentitySchema.parse(identity))])).rows[0]?.locked;
  return locked === true;
}

/** Invoked under the existing account/SKU publication lock. The current catalog
 * source, rather than worker discovery timing, stops stale queued submissions. */
export async function assertArchivedMemberPublicationAllowed(
  client: StockSelectionQueryClient, account: ListingAccount, skus: readonly string[],
): Promise<void> {
  if (!skus.length) return;
  const archived = await client.query(`SELECT 1 FROM marketplace.listing_member_retirement_sources
    WHERE identity->>'provider'=$1 AND identity->>'accountId'=$2
      AND identity->>'environment'=$3 AND identity->>'market'=$4
      AND identity->>'externalSku'=ANY($5::text[]) LIMIT 1`,
  [account.provider, account.accountId, account.environment, account.market, skus]);
  if (archived.rows.length) throw new ListingPublicationError("LISTING_MEMBER_ARCHIVED",
    "Publication is stopped because this catalog variant is archived. Restore it in the catalog before publishing again.");
}

/** Include the current archived generation and unresolved older dispatches.
 * A changed catalog mapping must not make a possibly sent operation disappear. */
export async function readListingMemberRetirements(client: StockSelectionQueryClient, input: {
  destinationKind: "channel_connection" | "dropship_store_connection"; connectionId: number; productVariantIds: readonly number[];
}): Promise<ListingMemberRetirement[]> {
  z.object({ destinationKind: z.enum(["channel_connection", "dropship_store_connection"]), connectionId: positiveId,
    productVariantIds: z.array(positiveId).max(250) }).strict().parse(input);
  if (!input.productVariantIds.length) return [];
  const rows = (await client.query<Row>(`SELECT r.*,(${legacyUnconfirmedSql}) AS unconfirmed_prior_dispatch FROM marketplace.listing_member_retirements r
    WHERE r.identity->>'destinationKind'=$1 AND r.identity->>'connectionId'=$2 AND r.product_variant_id=ANY($3::integer[])
      AND (EXISTS (SELECT 1 FROM marketplace.listing_member_retirement_sources s
        WHERE s.product_variant_id=r.product_variant_id AND s.source_revision=r.source_revision AND s.identity=r.source_identity)
        OR (r.state NOT IN ('retired','superseded') AND
          (r.dispatch_status IN ('unknown','accepted','authorized') OR r.recovery_required OR r.state='retiring'
            OR EXISTS (SELECT 1 FROM marketplace.listing_member_retirement_events e WHERE e.operation_id=r.id
              AND (e.after_state->>'state'='retiring' OR e.after_state->>'dispatch_status' IN ('unknown','accepted','authorized')))))
        OR (${legacyUnconfirmedSql}))
      ORDER BY r.created_at,r.id`,
  [input.destinationKind, String(input.connectionId), input.productVariantIds])).rows;
  return rows.map(record);
}

export class PostgresListingMemberLifecycleRepository implements ListingMemberLifecycleStore {
  constructor(private readonly pool: Pick<Pool, "connect">) {}
  async listConflictsForChannel(channelId: number, offset: number) {
    positiveId.parse(channelId); z.number().int().nonnegative().safe().parse(offset);
    const client = await this.pool.connect();
    try {
      // Only current source evidence belongs in the workspace. The immutable
      // history retains superseded conflicts separately for audit.
      const rows = (await client.query(`SELECT DISTINCT r.product_id AS "productId",
          r.product_variant_id AS "productVariantId",v.sku,r.id::text AS "operationId"
        FROM marketplace.listing_member_retirements r
        JOIN marketplace.listing_member_retirement_sources s ON s.product_variant_id=r.product_variant_id
          AND s.source_revision=r.source_revision AND s.identity=r.source_identity
        JOIN catalog.product_variants v ON v.id=r.product_variant_id
        WHERE r.identity->>'destinationKind'='channel_connection' AND r.identity->>'channelId'=$1
          AND r.state='failed' AND r.code='LISTING_MEMBER_IDENTITY_CONFLICT'
        ORDER BY "productVariantId","operationId" LIMIT 101 OFFSET $2::bigint`, [String(channelId), offset])).rows;
      return listingMemberConflictListSchema.parse({ items: rows.slice(0, 100), hasMore: rows.length > 100, offset });
    } finally { client.release(); }
  }
  async listForChannel(channelId: number, productId: number, limit: number): Promise<ListingMemberRetirement[]> {
    positiveId.parse(channelId); positiveId.parse(productId); batchLimit.parse(limit);
    const client = await this.pool.connect();
    try { return (await client.query<Row>(`SELECT r.*,(${legacyUnconfirmedSql}) AS unconfirmed_prior_dispatch FROM marketplace.listing_member_retirements r
      WHERE r.identity->>'destinationKind'='channel_connection' AND r.identity->>'channelId'=$1 AND r.product_id=$2
      ORDER BY r.created_at DESC,r.id DESC LIMIT $3`, [String(channelId), productId, limit])).rows.map(record); }
    finally { client.release(); }
  }
  async listForDropship(connectionId:number,vendorId:number,productId:number,limit:number):Promise<ListingMemberRetirement[]> {
    positiveId.parse(connectionId); positiveId.parse(vendorId); positiveId.parse(productId); batchLimit.parse(limit);
    const client = await this.pool.connect();
    try { return (await client.query<Row>(`SELECT r.*,(${legacyUnconfirmedSql}) AS unconfirmed_prior_dispatch FROM marketplace.listing_member_retirements r
      WHERE r.identity->>'destinationKind'='dropship_store_connection' AND r.identity->>'connectionId'=$1 AND r.identity->>'vendorId'=$2 AND r.product_id=$3
      ORDER BY r.created_at DESC,r.id DESC LIMIT $4`,[String(connectionId),String(vendorId),productId,limit])).rows.map(record); }
    finally { client.release(); }
  }
  async due(now: Date, limit: number): Promise<string[]> {
    z.date().parse(now); batchLimit.parse(limit);
    const client = await this.pool.connect();
    try { return (await client.query<{ id: string }>(`SELECT r.id::text FROM marketplace.listing_member_retirements r
      WHERE r.next_attempt_at<=$1 OR (r.next_attempt_at='infinity'::timestamptz
        AND r.state='failed' AND r.code='LISTING_MEMBER_IDENTITY_CONFLICT' AND (${provenNoDispatchSql}))
      ORDER BY r.next_attempt_at,r.id LIMIT $2`, [now, limit])).rows.map(row => row.id); }
    finally { client.release(); }
  }
  async withMember<T>(id: string, work: (session: ListingMemberLifecycleSession) => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      let row = (await client.query<Row>(`SELECT r.*,(${legacyUnconfirmedSql}) AS unconfirmed_prior_dispatch FROM marketplace.listing_member_retirements r WHERE r.id=$1`,
        [z.string().uuid().parse(id)])).rows[0];
      if (!row) { await client.query("ROLLBACK"); return null; }
      let current = record(row);
      // Two generations/destinations addressing the same remote member cannot race.
      if (!(await tryLockListingMemberRemote(client, current.identity))) { await client.query("ROLLBACK"); return null; }
      // The prior worker may have committed between the first read and lock.
      row = (await client.query<Row>(`SELECT r.*,(${legacyUnconfirmedSql}) AS unconfirmed_prior_dispatch FROM marketplace.listing_member_retirements r WHERE r.id=$1`, [id])).rows[0];
      current = record(row);
      // Catalog owns archive/reactivation. Hold only this product/member while a
      // remote removal is in flight, so reactivation cannot race a destructive call.
      await client.query("SELECT id FROM catalog.products WHERE id=$1 FOR SHARE", [current.identity.productId]);
      await client.query("SELECT id FROM catalog.product_variants WHERE id=$1 FOR UPDATE", [current.identity.productVariantId]);
      // The parent variant lock also fences new FK-linked mappings. Lock the
      // existing mappings against reassignment while a provider request runs.
      if (current.identity.destinationKind === "channel_connection") {
        await client.query(`SELECT product_variant_id FROM channels.channel_listings
          WHERE channel_id=$1 AND product_variant_id=$2 FOR SHARE`, [current.identity.channelId, current.identity.productVariantId]);
        await client.query(`SELECT product_variant_id FROM channels.channel_feeds
          WHERE channel_id=$1 AND product_variant_id=$2 FOR SHARE`, [current.identity.channelId, current.identity.productVariantId]);
      } else {
        await client.query(`SELECT id FROM dropship.dropship_vendor_listings
          WHERE vendor_id=$1 AND store_connection_id=$2 AND product_variant_id=$3 FOR SHARE`,
        [current.identity.vendorId, current.identity.connectionId, current.identity.productVariantId]);
      }
      const result = await work({ current,
        retryDeferred: row.next_attempt_at === Infinity,
        isCurrent: async () => (await client.query(`SELECT 1 FROM marketplace.listing_member_retirement_sources
          WHERE identity=$1 AND source_revision=$2`, [row.source_identity, current.sourceRevision])).rowCount === 1,
        hasProvenNoDispatch: async () => {
          const evidence = (await client.query<{ proven: boolean }>(`SELECT (${provenNoDispatchSql}) AS proven
            FROM marketplace.listing_member_retirements r WHERE r.id=$1`, [id])).rows[0];
          return evidence?.proven === true;
        },
        save: (state, code, message, now, progress) => this.saveProgress(id, state, code, message, now, progress),
        recoveryCommand: async commandKey => {
          const saved = (await client.query("SELECT operation_id,actor,review_hash FROM marketplace.listing_member_recovery_commands WHERE command_key=$1", [commandKey])).rows[0];
          return saved ? { operationId: saved.operation_id, actor: saved.actor, reviewHash: saved.review_hash } : null;
        },
        authorizeRecovery: (input, now) => this.authorizeRecovery(id, input, now),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async saveProgress(id: string, state: ListingMemberRetirement["state"], code: string | null,
    message: string, now: Date, progress: ListingMemberProgress = {}): Promise<ListingMemberRetirement> {
    // The remote-member and catalog locks remain on the worker connection.
    // Commit intent/evidence independently so a crash after dispatch cannot
    // roll back the durable "retiring" marker and cause blind resubmission.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const before = (await client.query<Row & {snapshot:unknown}>("SELECT r.*,to_jsonb(r) snapshot FROM marketplace.listing_member_retirements r WHERE id=$1 FOR UPDATE", [id])).rows[0];
      const retryAfterMs = progress.retryAfterMs === undefined ? RETRY_MS
        : z.number().int().min(RETRY_MS).max(24 * 60 * 60_000).parse(progress.retryAfterMs);
      const saved = (await client.query<Row>(`UPDATE marketplace.listing_member_retirements SET state=$2,code=$3,message=$4,
        verified_at=$5,next_attempt_at=$6,updated_at=$7,version=version+1,
        dispatch_status=COALESCE($8,dispatch_status),dispatch_key=COALESCE($9,dispatch_key),
        verification_attempts=COALESCE($10,verification_attempts),recovery_required=CASE WHEN $2 IN ('retired','superseded') THEN false ELSE COALESCE($11,recovery_required) END WHERE id=$1 RETURNING *`,
      [id, state, code, message, state === "retired" ? now : null,
        state === "retired" || state === "superseded" ? null
          : state === "failed" && code === "LISTING_MEMBER_IDENTITY_CONFLICT" ? "infinity"
          : new Date(now.getTime() + retryAfterMs), now, progress.dispatchStatus ?? null, progress.dispatchKey ?? null,
        progress.verificationAttempts ?? null, progress.recoveryRequired ?? null])).rows[0];
      await audit(client, id, record(before), now);
      await client.query("COMMIT");
      return record(saved);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  private async authorizeRecovery(id: string, input: ListingMemberRecoveryAuthorization, now: Date): Promise<ListingMemberRetirement> {
    // withMember retains the remote identity, catalog and mapping locks on its
    // other connection. Commit authorization independently, just like dispatch.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const before = (await client.query<Row & {snapshot:unknown}>("SELECT r.*,to_jsonb(r) snapshot FROM marketplace.listing_member_retirements r WHERE id=$1 FOR UPDATE", [id])).rows[0];
      await client.query(`INSERT INTO marketplace.listing_member_recovery_commands(command_key,operation_id,actor,review_hash,before_record,observation,authorized_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.commandKey,id,input.actor,input.reviewHash,JSON.stringify(before.snapshot),JSON.stringify(input.observation),now]);
      const saved = (await client.query<Row>(`UPDATE marketplace.listing_member_retirements SET state='pending',code=NULL,
        message='Removal recovery authorized. The exact saved member will be checked before dispatch.',
        dispatch_status='authorized',dispatch_key=$2,verification_attempts=0,recovery_required=false,
        next_attempt_at=$3,updated_at=$3,version=version+1 WHERE id=$1 RETURNING *`, [id,input.commandKey,now])).rows[0];
      await audit(client,id,record(before),now,input.actor);
      await client.query("COMMIT");
      return record(saved);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}

async function audit(client: PoolClient, id: string, before: ListingMemberRetirement | null, now: Date, actor = "system:listing-lifecycle") {
  await client.query(`INSERT INTO marketplace.listing_member_retirement_events(operation_id,version,actor,before_state,after_state,occurred_at)
    SELECT id,version,$4,$2,to_jsonb(r),$3 FROM marketplace.listing_member_retirements r WHERE id=$1`, [id, before, now, actor]);
}
