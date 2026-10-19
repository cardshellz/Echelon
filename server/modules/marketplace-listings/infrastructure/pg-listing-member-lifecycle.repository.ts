import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { listingMemberIdentitySchema, listingMemberRetirementSchema, type ListingMemberIdentity, type ListingMemberRetirement } from "@shared/types/listing-member-lifecycle";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import { listingMemberRemoteKey } from "../domain/listing-member-lifecycle";
import type { ListingMemberLifecycleSession, ListingMemberLifecycleStore } from "../application/listing-member-lifecycle.port";
import type { ListingAccount } from "@shared/types/channel-listing-publication";
import { ListingPublicationError } from "../domain/listing-publication";

const RETRY_MS = 60_000;
const LOCK_NAMESPACE = 2591013;
const positiveId = z.number().int().positive().max(2_147_483_647);
const batchLimit = z.number().int().min(1).max(250);
interface Row { id: string; identity: unknown; source_identity: unknown; source_revision: string; state: string; code: string | null; message: string | null; verified_at: Date | null }

const localIdentitySchema = listingMemberIdentitySchema.pick({
  destinationKind: true, connectionId: true, channelId: true, vendorId: true, productId: true, productVariantId: true,
}).passthrough();

function discoveredIdentity(source: unknown): { identity: ListingMemberIdentity; invalidMessage: string | null } {
  const parsed = listingMemberIdentitySchema.safeParse(source);
  if (parsed.success) return { identity: parsed.data, invalidMessage: null };

  // The view supplies exact local IDs from its catalog/destination joins. Never
  // invent those IDs. Invalid retained provider fields are diagnostic-only;
  // source_identity preserves their original values for audit and correction.
  const local = localIdentitySchema.parse(source);
  const field = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    const result = schema.safeParse(value);
    return result.success ? result.data : fallback;
  };
  const shape = listingMemberIdentitySchema.shape;
  const identity = listingMemberIdentitySchema.parse({
    destinationKind: local.destinationKind, connectionId: local.connectionId,
    channelId: local.channelId, vendorId: local.vendorId,
    productId: local.productId, productVariantId: local.productVariantId,
    provider: field(shape.provider, local.provider, "invalid"),
    accountId: field(shape.accountId, local.accountId, null),
    // This placeholder cannot authorize dispatch: invalid diagnostics are
    // immutable, unscheduled, and rejected by the shared processing owner.
    environment: field(shape.environment, local.environment, "production"),
    market: field(shape.market, local.market, "invalid"),
    externalSku: field(shape.externalSku, local.externalSku, null),
    externalProductId: field(shape.externalProductId, local.externalProductId, null),
    externalVariantId: field(shape.externalVariantId, local.externalVariantId, null),
    externalInventoryItemId: field(shape.externalInventoryItemId, local.externalInventoryItemId, null),
    identityConflict: true,
  });
  const invalidFields = [...new Set(parsed.error.issues.map(issue => String(issue.path[0] ?? "identity")))].slice(0, 16);
  return { identity, invalidMessage: `The saved listing identity has invalid fields: ${invalidFields.join(", ")}. `
    + "Correct the saved listing connection or mapping before removal. This archived variant remains excluded; no provider request was sent." };
}
function record(row: Row): ListingMemberRetirement {
  return listingMemberRetirementSchema.parse({ operationId: row.id, identity: row.identity, sourceRevision: row.source_revision,
    state: row.state, code: row.code, message: row.message, verifiedAt: row.verified_at?.toISOString() ?? null });
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

/** Consumers only see evidence matching today's archived catalog generation and
 * exact retained destination. A completed sync job cannot erase this receipt. */
export async function readListingMemberRetirements(client: StockSelectionQueryClient, input: {
  destinationKind: "channel_connection" | "dropship_store_connection"; connectionId: number; productVariantIds: readonly number[];
}): Promise<ListingMemberRetirement[]> {
  z.object({ destinationKind: z.enum(["channel_connection", "dropship_store_connection"]), connectionId: positiveId,
    productVariantIds: z.array(positiveId).max(250) }).strict().parse(input);
  if (!input.productVariantIds.length) return [];
  const rows = (await client.query<Row>(`SELECT DISTINCT r.* FROM marketplace.listing_member_retirements r
    JOIN marketplace.listing_member_retirement_sources s ON s.product_variant_id=r.product_variant_id
      AND s.source_revision=r.source_revision AND s.identity=r.source_identity
    WHERE r.identity->>'destinationKind'=$1 AND r.identity->>'connectionId'=$2 AND r.product_variant_id=ANY($3::integer[])`,
  [input.destinationKind, String(input.connectionId), input.productVariantIds])).rows;
  return rows.map(record);
}

export class PostgresListingMemberLifecycleRepository implements ListingMemberLifecycleStore {
  constructor(private readonly pool: Pick<Pool, "connect">, private readonly uuid: () => string = randomUUID) {}
  async listForChannel(channelId: number, productId: number, limit: number): Promise<ListingMemberRetirement[]> {
    positiveId.parse(channelId); positiveId.parse(productId); batchLimit.parse(limit);
    const client = await this.pool.connect();
    try { return (await client.query<Row>(`SELECT * FROM marketplace.listing_member_retirements
      WHERE identity->>'destinationKind'='channel_connection' AND identity->>'channelId'=$1 AND product_id=$2
      ORDER BY created_at DESC,id DESC LIMIT $3`, [String(channelId), productId, limit])).rows.map(record); }
    finally { client.release(); }
  }
  async discover(now: Date, limit: number): Promise<void> {
    z.date().parse(now); batchLimit.parse(limit);
    const client = await this.pool.connect();
    try {
      const rows = (await client.query<{ identity: unknown; source_revision: string }>(`SELECT s.identity,s.source_revision
        FROM marketplace.listing_member_retirement_sources s
        WHERE NOT EXISTS(SELECT 1 FROM marketplace.listing_member_retirements r
          WHERE md5(r.source_identity::text)=md5(s.identity::text) AND r.source_identity=s.identity AND r.source_revision=s.source_revision)
        ORDER BY s.product_variant_id,s.identity::text LIMIT $1`, [limit])).rows;
      for (const source of rows) {
        const { identity, invalidMessage } = discoveredIdentity(source.identity);
        const identityKey = createHash("sha256").update(canonicalJson(source.identity)).digest("hex");
        await client.query("BEGIN");
        try {
          // One transaction commits the desired removal and its first audit event.
          const inserted = (await client.query<Row>(`INSERT INTO marketplace.listing_member_retirements
            (id,identity_key,identity,source_identity,source_revision,product_id,product_variant_id,state,code,message,next_attempt_at,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) ON CONFLICT(identity_key,source_revision) DO NOTHING RETURNING *`,
          [z.string().uuid().parse(this.uuid()), identityKey, identity, source.identity, source.source_revision, identity.productId, identity.productVariantId,
            invalidMessage ? "failed" : "pending", invalidMessage ? "LISTING_MEMBER_IDENTITY_INVALID" : null, invalidMessage,
            invalidMessage ? null : now, now])).rows[0];
          if (inserted) await audit(client, inserted.id, null, now);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      }
    } finally { client.release(); }
  }
  async due(now: Date, limit: number): Promise<string[]> {
    z.date().parse(now); batchLimit.parse(limit);
    const client = await this.pool.connect();
    try { return (await client.query<{ id: string }>(`SELECT id::text FROM marketplace.listing_member_retirements
      WHERE next_attempt_at<=$1 ORDER BY next_attempt_at,id LIMIT $2`, [now, limit])).rows.map(row => row.id); }
    finally { client.release(); }
  }
  async withMember<T>(id: string, work: (session: ListingMemberLifecycleSession) => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      const row = (await client.query<Row>(`SELECT * FROM marketplace.listing_member_retirements WHERE id=$1`,
        [z.string().uuid().parse(id)])).rows[0];
      if (!row) { await client.query("ROLLBACK"); return null; }
      let current = record(row);
      // Two generations/destinations addressing the same remote member cannot race.
      const locked = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS locked",
        [LOCK_NAMESPACE, listingMemberRemoteKey(current.identity)])).rows[0]?.locked;
      if (!locked) { await client.query("ROLLBACK"); return null; }
      // The prior worker may have committed between the first read and lock.
      current = record((await client.query<Row>("SELECT * FROM marketplace.listing_member_retirements WHERE id=$1", [id])).rows[0]);
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
        isCurrent: async () => (await client.query(`SELECT 1 FROM marketplace.listing_member_retirement_sources
          WHERE identity=$1 AND source_revision=$2`, [row.source_identity, current.sourceRevision])).rowCount === 1,
        save: (state, code, message, now) => this.saveProgress(id, state, code, message, now),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async saveProgress(id: string, state: ListingMemberRetirement["state"], code: string | null,
    message: string, now: Date): Promise<ListingMemberRetirement> {
    // The remote-member and catalog locks remain on the worker connection.
    // Commit intent/evidence independently so a crash after dispatch cannot
    // roll back the durable "retiring" marker and cause blind resubmission.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const before = (await client.query<Row>("SELECT * FROM marketplace.listing_member_retirements WHERE id=$1 FOR UPDATE", [id])).rows[0];
      const saved = (await client.query<Row>(`UPDATE marketplace.listing_member_retirements SET state=$2,code=$3,message=$4,
        verified_at=$5,next_attempt_at=$6,updated_at=$7,version=version+1 WHERE id=$1 RETURNING *`,
      [id, state, code, message, state === "retired" ? now : null,
        state === "retired" || state === "superseded" ? null : new Date(now.getTime() + RETRY_MS), now])).rows[0];
      await audit(client, id, record(before), now);
      await client.query("COMMIT");
      return record(saved);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}

async function audit(client: PoolClient, id: string, before: ListingMemberRetirement | null, now: Date) {
  await client.query(`INSERT INTO marketplace.listing_member_retirement_events(operation_id,version,actor,before_state,after_state,occurred_at)
    SELECT id,version,'system:listing-lifecycle',$2,to_jsonb(r),$3 FROM marketplace.listing_member_retirements r WHERE id=$1`, [id, before, now]);
}
