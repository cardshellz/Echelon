import type { Pool, PoolClient } from "pg";
import {
  savedSyncBatchSchema,
  type SavedSyncBatch,
  type SyncAdmissionRefusal,
  syncAdmissionRefusalSchema,
} from "../domain/channel-sync-batch";
import type { ChannelSyncBatchStore } from "../application/channel-sync-batch.service";

const BATCH_ADMISSION_LEASE_MS = 120_000;
const BATCH_ADMISSION_RETRY_MS = 30_000;
const selectBatch = `SELECT b.id::text,b.destination,b.actor,b.created_at AS "createdAt",
  b.admission_completed_at AS "admissionCompletedAt",b.admission_error AS "admissionError",b.admission_refusal AS "admissionRefusal",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('productId',m.product_id,'name',m.name,'sku',m.sku,
    'commandKey',m.command_key) ORDER BY m.product_id)
    FROM marketplace.channel_sync_batch_members m WHERE m.batch_id=b.id),'[]'::jsonb) AS members
  FROM marketplace.channel_sync_batches b`;
function decode(row: Record<string, unknown>): SavedSyncBatch {
  return savedSyncBatchSchema.parse({
    ...row,
    createdAt: (row.createdAt as Date).toISOString(),
    admissionCompletedAt: row.admissionCompletedAt
      ? (row.admissionCompletedAt as Date).toISOString()
      : null,
  });
}
export class PostgresChannelSyncBatchRepository
  implements ChannelSyncBatchStore
{
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  async get(id: string): Promise<SavedSyncBatch | null> {
    return this.getInsideTransaction(this.pool, id);
  }
  async getInsideTransaction(database: Pick<PoolClient, "query">, id: string): Promise<SavedSyncBatch | null> {
    const row = (await database.query(selectBatch + " WHERE b.id=$1", [id]))
      .rows[0];
    return row ? decode(row) : null;
  }
  async create(input: SavedSyncBatch): Promise<SavedSyncBatch> {
    const batch = savedSyncBatchSchema.parse(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const saved = await this.createInsideTransaction(client, batch);
      await client.query("COMMIT");
      return saved;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async createInsideTransaction(client: PoolClient, input: SavedSyncBatch): Promise<SavedSyncBatch> {
      const batch = savedSyncBatchSchema.parse(input);
      const inserted = await client.query(
        `INSERT INTO marketplace.channel_sync_batches
        (id,channel_id,destination,actor,member_count,created_at,next_attempt_at)
        VALUES($1,$2,$3::jsonb,$4,$5,$6,$6) ON CONFLICT(id) DO NOTHING RETURNING id`,
        [
          batch.id,
          batch.destination.channelId,
          JSON.stringify(batch.destination),
          batch.actor,
          batch.members.length,
          batch.createdAt,
        ],
      );
      if (inserted.rowCount) {
        await client.query(
          `INSERT INTO marketplace.channel_sync_batch_members(batch_id,product_id,command_key,name,sku)
          SELECT $1,m."productId",m."commandKey"::uuid,m.name,m.sku
          FROM jsonb_to_recordset($2::jsonb) AS m("productId" integer,"commandKey" text,name text,sku text)`,
          [batch.id, JSON.stringify(batch.members)],
        );
      }
      const saved = decode(
        (await client.query(selectBatch + " WHERE b.id=$1", [batch.id]))
          .rows[0],
      );
      return saved;
  }
  async list(channelId: number, offset: number): Promise<SavedSyncBatch[]> {
    return (
      await this.pool.query(
        selectBatch +
          " WHERE b.channel_id=$1 ORDER BY b.created_at DESC,b.id DESC LIMIT 10 OFFSET $2",
        [channelId, offset],
      )
    ).rows.map(decode);
  }
  async claim(token: string, now: Date): Promise<SavedSyncBatch | null> {
    const result = await this.pool.query(
      `WITH candidate AS (
      SELECT id FROM marketplace.channel_sync_batches
      WHERE admission_completed_at IS NULL AND next_attempt_at<=$1 AND (lease_until IS NULL OR lease_until<=$1)
      ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE marketplace.channel_sync_batches b SET lease_token=$2,lease_until=$3,attempts=attempts+1
      FROM candidate c WHERE b.id=c.id RETURNING b.id::text`,
      [now, token, new Date(now.getTime() + BATCH_ADMISSION_LEASE_MS)],
    );
    return result.rows[0] ? this.get(result.rows[0].id) : null;
  }
  async finish(
    id: string,
    token: string,
    now: Date,
    refusal?: SyncAdmissionRefusal,
  ): Promise<boolean> {
    const validated = refusal
      ? syncAdmissionRefusalSchema.parse(refusal)
      : null;
    const result = await this.pool.query(
      `UPDATE marketplace.channel_sync_batches SET admission_completed_at=$3,admission_error=NULL,admission_refusal=$4::jsonb,
      lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND lease_until>$3 AND admission_completed_at IS NULL`,
      [id, token, now, validated ? JSON.stringify(validated) : null],
    );
    return result.rowCount === 1;
  }
  async defer(
    id: string,
    token: string,
    message: string,
    now: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE marketplace.channel_sync_batches SET admission_error=$3,next_attempt_at=$4,
      lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND admission_completed_at IS NULL`,
      [id, token, message, new Date(now.getTime() + BATCH_ADMISSION_RETRY_MS)],
    );
  }
}
