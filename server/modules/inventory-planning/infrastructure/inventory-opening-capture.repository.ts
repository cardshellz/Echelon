import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { openingCaptureChunkSchema, openingCaptureIdSchema, openingCaptureRequestSchema, openingCaptureStatusSchema, openingCaptureStageSchema,
  type OpeningCaptureStatus } from "@shared/types/inventory-opening-capture";
import { z } from "zod";
import type { InventoryOpeningCapturePort } from "../application/inventory-opening-capture.port";
import { InventoryCutoverOpeningError } from "../application/inventory-cutover-opening.service";
import type { OpeningSource } from "@shared/types/inventory-cutover-opening";
import { openingCaptureChunks } from "./inventory-opening-capture-artifact";

const actorSchema = z.string().trim().min(1).max(100);
const fields = `id::text,state,stage,created_at AS "createdAt",completed_at AS "completedAt",chunk_count AS "chunkCount",error_code AS "errorCode"`;
function status(row: Record<string, unknown>): OpeningCaptureStatus {
  return openingCaptureStatusSchema.parse({ ...row,
    createdAt: (row.createdAt as Date).toISOString(), completedAt: row.completedAt ? (row.completedAt as Date).toISOString() : null });
}
function unavailable() { return new InventoryCutoverOpeningError("CUTOVER_CAPTURE_NOT_AVAILABLE", "The capture is unavailable or expired.", 404); }

/** Sole writer for transient capture state. No stock/verification/authority writes. */
export class PostgresInventoryOpeningCaptureRepository implements InventoryOpeningCapturePort {
  constructor(private readonly pool: Pick<Pool, "connect" | "query">, private readonly newId: () => string = randomUUID) {}

  async enqueue(rawActor: string, rawKey: string): Promise<OpeningCaptureStatus> {
    const actor = actorSchema.parse(rawActor);
    const { idempotencyKey } = openingCaptureRequestSchema.parse({ idempotencyKey: rawKey });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='2s'");
      // Fixed lock identity is module-owned and only serializes short enqueue
      // transactions; it is different from the worker's session-lifetime lock.
      await client.query("SELECT pg_advisory_xact_lock(184731, 1)");
      const replay = (await client.query(`SELECT ${fields} FROM inventory.opening_capture_jobs WHERE actor=$1 AND request_key=$2`, [actor,idempotencyKey])).rows[0];
      if (replay) { await client.query("COMMIT"); return status(replay); }
      const worker = (await client.query(`SELECT singleton FROM inventory.opening_capture_worker
        WHERE heartbeat_at > clock_timestamp()-interval '30 seconds'`)).rows;
      if (worker.length !== 1) throw new InventoryCutoverOpeningError("CUTOVER_CAPTURE_WORKER_OFFLINE", "The inventory capture worker is offline. Start the capture worker before retrying.", 503);
      const active = (await client.query(`SELECT ${fields},actor FROM inventory.opening_capture_jobs WHERE state IN ('queued','running')`)).rows;
      if (active[0]?.actor === actor) {
        const { actor: _actor, ...job } = active[0];
        await client.query("COMMIT"); return status(job);
      }
      if (active.length) throw new InventoryCutoverOpeningError("CUTOVER_CAPTURE_BUSY", "Another inventory capture is in progress. Wait for it to finish before starting another.", 409);
      const id = openingCaptureIdSchema.parse(this.newId());
      const row = (await client.query(`INSERT INTO inventory.opening_capture_jobs(id,actor,request_key,state,stage)
        VALUES($1,$2,$3,'queued','queued') RETURNING ${fields}`, [id,actor,idempotencyKey])).rows[0];
      await client.query("COMMIT"); return status(row);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async status(rawActor: string, rawId: string): Promise<OpeningCaptureStatus> {
    const actor = actorSchema.parse(rawActor), id = openingCaptureIdSchema.parse(rawId);
    const row = (await this.pool.query(`SELECT ${fields} FROM inventory.opening_capture_jobs
      WHERE id=$1 AND actor=$2 AND created_at > clock_timestamp()-interval '24 hours'`, [id,actor])).rows[0];
    if (!row) throw unavailable();
    // Do not claim that a disconnected worker is still making progress. Never
    // resume a partly captured snapshot; a new worker explicitly fails it.
    if (row.state === "running" || row.state === "queued") {
      const live = (await this.pool.query(`SELECT singleton FROM inventory.opening_capture_worker
        WHERE heartbeat_at > clock_timestamp()-interval '30 seconds'`)).rows;
      if (!live.length) throw new InventoryCutoverOpeningError("CUTOVER_CAPTURE_WORKER_OFFLINE", "The capture worker stopped responding. No complete snapshot is available.", 503);
    }
    return status(row);
  }

  async chunk(rawActor: string, rawId: string, rawIndex: number) {
    const actor = actorSchema.parse(rawActor), id = openingCaptureIdSchema.parse(rawId);
    const index = openingCaptureChunkSchema.shape.index.parse(rawIndex);
    const row = (await this.pool.query(`SELECT part.content FROM inventory.opening_capture_chunks part
      JOIN inventory.opening_capture_jobs job ON job.id=part.capture_id
      WHERE job.id=$1 AND job.actor=$2 AND job.state='complete' AND part.chunk_index=$3
        AND part.chunk_index < job.chunk_count AND job.created_at > clock_timestamp()-interval '24 hours'`, [id,actor,index])).rows[0];
    if (!row) throw unavailable();
    return openingCaptureChunkSchema.parse({ captureId: id, index, text: row.content });
  }

  async heartbeat(): Promise<void> {
    await this.pool.query(`INSERT INTO inventory.opening_capture_worker(singleton,heartbeat_at) VALUES(true,clock_timestamp())
      ON CONFLICT(singleton) DO UPDATE SET heartbeat_at=EXCLUDED.heartbeat_at`);
  }
  async recoverInterrupted(): Promise<void> {
    // Called ONLY after acquiring the worker session lock: the former worker
    // cannot still be writing these artifacts. Partial chunks are never served.
    await this.pool.query(`UPDATE inventory.opening_capture_jobs SET state='failed',stage='failed',
      error_code='CUTOVER_CAPTURE_INTERRUPTED',completed_at=clock_timestamp()
      WHERE state='running' OR (state='queued' AND created_at < clock_timestamp()-interval '24 hours')`);
    await this.pool.query(`DELETE FROM inventory.opening_capture_chunks WHERE capture_id IN
      (SELECT id FROM inventory.opening_capture_jobs WHERE state='failed')`);
    await this.cleanupExpired();
  }
  async cleanupExpired(): Promise<void> {
    await this.pool.query(`DELETE FROM inventory.opening_capture_jobs WHERE created_at < clock_timestamp()-interval '24 hours' AND state NOT IN ('queued','running')`);
  }
  async claim(): Promise<{ id: string; actor: string } | null> {
    const row = (await this.pool.query(`UPDATE inventory.opening_capture_jobs SET state='running',stage='starting',started_at=clock_timestamp()
      WHERE id=(SELECT id FROM inventory.opening_capture_jobs WHERE state='queued' ORDER BY created_at LIMIT 1)
      AND state='queued' RETURNING id::text,actor`)).rows[0];
    return row ?? null;
  }
  async progress(id: string, stage: string): Promise<void> {
    openingCaptureStageSchema.parse(stage);
    await this.pool.query(`UPDATE inventory.opening_capture_jobs SET stage=$2 WHERE id=$1 AND state='running'`, [id,stage]);
  }
  async append(id: string, index: number, text: string): Promise<void> {
    openingCaptureChunkSchema.parse({ captureId:id,index,text });
    const result = await this.pool.query(`INSERT INTO inventory.opening_capture_chunks(capture_id,chunk_index,content)
      SELECT id,$2,$3 FROM inventory.opening_capture_jobs WHERE id=$1 AND state='running'`, [id,index,text]);
    if (result.rowCount !== 1) throw new Error("CUTOVER_CAPTURE_NOT_RUNNING");
  }
  async complete(id: string, count: number): Promise<void> {
    const result = await this.pool.query(`UPDATE inventory.opening_capture_jobs SET state='complete',stage='complete',chunk_count=$2,completed_at=clock_timestamp()
      WHERE id=$1 AND state='running' AND $2>0
        AND (SELECT count(*) FROM inventory.opening_capture_chunks WHERE capture_id=$1)=$2
        AND (SELECT min(chunk_index) FROM inventory.opening_capture_chunks WHERE capture_id=$1)=0
        AND (SELECT max(chunk_index) FROM inventory.opening_capture_chunks WHERE capture_id=$1)=$2-1`, [id,count]);
    if (result.rowCount !== 1) throw new Error("CUTOVER_CAPTURE_INCOMPLETE_ARTIFACT");
  }
  async writeResult(id: string, source: OpeningSource): Promise<number> {
    let count = 0;
    for (const chunk of openingCaptureChunks(source)) await this.append(id, count++, chunk);
    return count;
  }
  async fail(id: string, code: string): Promise<void> {
    await this.pool.query(`UPDATE inventory.opening_capture_jobs SET state='failed',stage='failed',error_code=$2,completed_at=clock_timestamp()
      WHERE id=$1 AND state='running'`, [id,code]);
    await this.pool.query(`DELETE FROM inventory.opening_capture_chunks WHERE capture_id=$1
      AND EXISTS(SELECT 1 FROM inventory.opening_capture_jobs WHERE id=$1 AND state='failed')`, [id]);
  }
}

export async function lockOpeningCaptureWorker(client: PoolClient): Promise<boolean> {
  return (await client.query("SELECT pg_try_advisory_lock(184731, 2) AS locked")).rows[0]?.locked === true;
}
