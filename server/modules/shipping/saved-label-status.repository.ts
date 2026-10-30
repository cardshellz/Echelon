import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  savedLabelStatusSourceSchema,
  type SavedLabelStatusSource,
} from "./saved-label-status.domain";

export const SAVED_LABEL_STATUS_LEASE_MS = 15 * 60_000;
export interface SavedLabelStatusClaim extends SavedLabelStatusSource {
  id: number;
  attempt: number;
  failures: number;
  token: string;
  startedAt: Date;
}
export interface SavedLabelStatusOutcome {
  state: "active" | "complete" | "retry" | "review";
  code: string | null;
  status: string | null;
  nextAttemptAt: Date | null;
}
export interface SavedLabelStatusStore {
  claim(
    limit: number,
    now: Date,
    token: string,
  ): Promise<SavedLabelStatusClaim[]>;
  settle(
    claim: SavedLabelStatusClaim,
    outcome: SavedLabelStatusOutcome,
    now: Date,
  ): Promise<boolean>;
}

/** Called inside the source owner's existing transaction: saving a successful
 * label/package and scheduling tracking cannot be split by a process crash. */
export async function enqueueSavedLabelStatus(
  client: Pick<PoolClient, "query">,
  raw: SavedLabelStatusSource,
  instant: Date,
): Promise<void> {
  const source = savedLabelStatusSourceSchema.parse(raw),
    now = z.date().parse(instant);
  const result = await client.query(
    `INSERT INTO wms.saved_label_status_jobs
    (source_kind,source_id,provider_reference,tracking_number,priority,next_attempt_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,CASE WHEN $1='return' THEN 0 ELSE 1 END,$5,$5,$5) ON CONFLICT(source_kind,source_id,provider_reference)
    DO UPDATE SET priority=LEAST(wms.saved_label_status_jobs.priority,EXCLUDED.priority)
    WHERE wms.saved_label_status_jobs.tracking_number=EXCLUDED.tracking_number RETURNING id`,
    [
      source.kind,
      source.sourceId,
      source.providerReference,
      source.trackingNumber,
      now,
    ],
  );
  if (result.rowCount !== 1)
    throw new Error("SAVED_LABEL_STATUS_IDENTITY_CHANGED");
}

export class PostgresSavedLabelStatusStore implements SavedLabelStatusStore {
  constructor(private readonly pool: Pick<Pool, "query" | "connect">) {}
  async claim(
    limit: number,
    instant: Date,
    token: string,
  ): Promise<SavedLabelStatusClaim[]> {
    z.number().int().min(1).max(10).parse(limit);
    z.string().uuid().parse(token);
    const now = z.date().parse(instant);
    const rows = (
      await this.pool.query(
        `WITH due AS (SELECT id FROM wms.saved_label_status_jobs
      WHERE state IN ('pending','active') AND next_attempt_at<=$1 AND (lease_until IS NULL OR lease_until<=$1)
      ORDER BY priority,next_attempt_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
      UPDATE wms.saved_label_status_jobs j SET lease_token=$3,lease_until=$4,attempt_count=attempt_count+1,updated_at=$1
      FROM due WHERE j.id=due.id RETURNING j.id,j.source_kind,j.source_id,j.provider_reference,j.tracking_number,j.attempt_count,j.failure_count`,
        [
          now,
          limit,
          token,
          new Date(now.getTime() + SAVED_LABEL_STATUS_LEASE_MS),
        ],
      )
    ).rows;
    return rows.map((row) => ({
      ...savedLabelStatusSourceSchema.parse({
        kind: row.source_kind,
        sourceId: Number(row.source_id),
        providerReference: row.provider_reference,
        trackingNumber: row.tracking_number,
      }),
      id: z.coerce.number().int().positive().safe().parse(row.id),
      attempt: z.number().int().positive().parse(row.attempt_count),
      failures: z.number().int().nonnegative().parse(row.failure_count),
      token,
      startedAt: now,
    }));
  }
  async settle(
    claim: SavedLabelStatusClaim,
    outcome: SavedLabelStatusOutcome,
    instant: Date,
  ): Promise<boolean> {
    const now = z.date().parse(instant);
    if (now < claim.startedAt)
      throw new Error("Capture clock precedes lease start");
    z.object({
      state: z.enum(["active", "complete", "retry", "review"]),
      code: z
        .string()
        .regex(/^[A-Z0-9_]+$/)
        .max(100)
        .nullable(),
      status: z
        .string()
        .regex(/^[a-z_]+$/)
        .max(50)
        .nullable(),
      nextAttemptAt: z.date().nullable(),
    })
      .strict()
      .parse(outcome);
    if (
      (outcome.state === "active" || outcome.state === "retry") !==
      (outcome.nextAttemptAt !== null)
    )
      throw new Error("Invalid capture schedule");
    if (outcome.nextAttemptAt !== null && outcome.nextAttemptAt <= now)
      throw new Error("Capture retry must be in the future");
    const result = await this.pool.query(
      `WITH updated AS (
      UPDATE wms.saved_label_status_jobs SET state=CASE WHEN $4='retry' THEN 'active' ELSE $4 END,
        failure_count=CASE WHEN $4='retry' THEN failure_count+1 ELSE 0 END,next_attempt_at=COALESCE($7,'infinity'::timestamptz),
        last_error_code=$5,last_status=$6,lease_token=NULL,lease_until=NULL,updated_at=$8
      WHERE id=$1 AND attempt_count=$2 AND lease_token=$3 AND lease_until>$8 RETURNING id
    ) INSERT INTO wms.saved_label_status_attempts(job_id,attempt_number,lease_token,outcome,error_code,canonical_status,actor,started_at,completed_at)
      SELECT id,$2,$3,$4,$5,$6,'system:shipping-status-capture',$9,$8 FROM updated RETURNING id`,
      [
        claim.id,
        claim.attempt,
        claim.token,
        outcome.state,
        outcome.code,
        outcome.status,
        outcome.nextAttemptAt,
        now,
        claim.startedAt,
      ],
    );
    return result.rowCount === 1;
  }
}
