import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  assertRecoveryDate, RECEIPT_COST_RECOVERY_ACTOR,
  receiptCostRecoveryClaimSchema, type ReceiptCostRecoveryClaim, type ReceiptCostRecoveryOutcome,
} from "./receipt-cost-recovery.domain";

type RecoveryPool = Pick<Pool, "connect">;
export interface ReceiptCostRecoveryRepository {
  prepare(input: { now: Date; maxAttempts: number; graceMs: number; limit: number }): Promise<void>;
  claimNext(input: { now: Date; leaseMs: number; leaseToken: string }): Promise<ReceiptCostRecoveryClaim | null>;
  complete(claim: ReceiptCostRecoveryClaim, outcome: ReceiptCostRecoveryOutcome, now: Date): Promise<ReceiptCostRecoveryOutcome["state"] | null>;
}

async function transaction<T>(pool: RecoveryPool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '15000ms'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], "Receipt-cost recovery rollback failed"); }
    throw error;
  } finally { client.release(); }
}

async function event(client: PoolClient, requestId: number, eventType: string, before: unknown, after: unknown, now: Date): Promise<void> {
  await client.query(`INSERT INTO procurement.receipt_cost_recovery_events
    (request_id,event_type,before_state,after_state,recorded_by,recorded_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6)`,
  [requestId, eventType, canonicalJson(before), canonicalJson(after), RECEIPT_COST_RECOVERY_ACTOR, now]);
}

/** Mutable scheduling metadata is separate from immutable financial attempts.
 * Expired workers are fenced by their token; actual cost effects still run
 * through the existing graph-locked, idempotent receiving cost owner. */
export function createReceiptCostRecoveryRepository(pool: RecoveryPool): ReceiptCostRecoveryRepository {
  return {
    async prepare(input) {
      assertRecoveryDate(input.now);
      const maxAttempts = z.number().int().min(1).max(20).parse(input.maxAttempts);
      const limit = z.number().int().min(1).max(500).parse(input.limit);
      const graceMs = z.number().int().min(0).max(86_400_000).parse(input.graceMs);
      await transaction(pool, async (client) => {
        // No historical receipt is fabricated: only already committed requests
        // on closed receipts with absent/transient outcomes are eligible.
        await client.query(`INSERT INTO procurement.receipt_cost_recovery_jobs
          (request_id,state,max_attempts,next_attempt_at,updated_at)
          SELECT request.id,'queued',$2,$1,$1 FROM procurement.receipt_cost_requests request
          JOIN procurement.receiving_orders receipt ON receipt.id=request.receiving_order_id
          LEFT JOIN procurement.receipt_cost_recovery_jobs job ON job.request_id=request.id
          LEFT JOIN LATERAL (SELECT state FROM procurement.receipt_cost_attempts
            WHERE request_id=request.id ORDER BY id DESC LIMIT 1) latest ON true
          WHERE job.request_id IS NULL AND receipt.status='closed'
            AND request.requested_at <= $1::timestamptz - ($3::bigint * interval '1 millisecond')
            AND (latest.state IS NULL OR latest.state='retry_required')
          ORDER BY request.requested_at,request.id LIMIT $4 ON CONFLICT(request_id) DO NOTHING`,
        [input.now, maxAttempts, graceMs, limit]);

        // Recover a crash after the financial commit and before job completion.
        // Exhaustion also terminates a lease lost on its final attempt.
        const stale = await client.query(`SELECT job.*,latest.state AS receipt_state
          FROM procurement.receipt_cost_recovery_jobs job
          LEFT JOIN LATERAL (SELECT state FROM procurement.receipt_cost_attempts
            WHERE request_id=job.request_id ORDER BY id DESC LIMIT 1) latest ON true
          WHERE job.state IN ('queued','processing')
            AND (job.state='queued' OR job.lease_expires_at <= $1)
            AND (latest.state IN ('applied','review_required') OR job.attempt_count >= job.max_attempts)
          ORDER BY job.request_id LIMIT $2 FOR UPDATE OF job SKIP LOCKED`, [input.now, limit]);
        for (const before of stale.rows) {
          const state = before.receipt_state === "applied" || before.receipt_state === "review_required" ? before.receipt_state : "exhausted";
          const changed = await client.query(`UPDATE procurement.receipt_cost_recovery_jobs
            SET state=$2,lease_token=NULL,lease_expires_at=NULL,updated_at=$3,
              last_error_code=CASE WHEN $2='exhausted' THEN 'RECEIPT_COST_RECOVERY_LEASE_EXHAUSTED' ELSE NULL END
            WHERE request_id=$1 RETURNING *`, [before.request_id, state, input.now]);
          await event(client, Number(before.request_id), "recovered", before, changed.rows[0], input.now);
        }
      });
    },

    async claimNext(input) {
      assertRecoveryDate(input.now);
      const leaseMs = z.number().int().min(1_000).max(3_600_000).parse(input.leaseMs);
      const leaseToken = z.string().uuid().parse(input.leaseToken);
      return transaction(pool, async (client) => {
        const selected = await client.query(`SELECT job.*,request.receiving_order_id,request.purchase_order_line_id
          FROM procurement.receipt_cost_recovery_jobs job
          JOIN procurement.receipt_cost_requests request ON request.id=job.request_id
          JOIN procurement.receiving_orders receipt ON receipt.id=request.receiving_order_id
          LEFT JOIN LATERAL (SELECT state FROM procurement.receipt_cost_attempts
            WHERE request_id=job.request_id ORDER BY id DESC LIMIT 1) latest ON true
          WHERE receipt.status='closed' AND job.attempt_count < job.max_attempts
            AND (latest.state IS NULL OR latest.state='retry_required')
            AND ((job.state='queued' AND job.next_attempt_at <= $1)
              OR (job.state='processing' AND job.lease_expires_at <= $1))
          ORDER BY job.next_attempt_at,job.request_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED`, [input.now]);
        const before = selected.rows[0];
        if (!before) return null;
        const updated = await client.query(`UPDATE procurement.receipt_cost_recovery_jobs
          SET state='processing',attempt_count=attempt_count+1,lease_token=$2,
            lease_expires_at=$3::timestamptz + ($4::bigint * interval '1 millisecond'),updated_at=$3
          WHERE request_id=$1 RETURNING *`, [before.request_id, leaseToken, input.now, leaseMs]);
        const after = updated.rows[0];
        await event(client, Number(before.request_id), "claimed", before, after, input.now);
        return receiptCostRecoveryClaimSchema.parse({ requestId: Number(after.request_id), receiptId: before.receiving_order_id,
          purchaseOrderLineId: before.purchase_order_line_id, attemptCount: after.attempt_count,
          maxAttempts: after.max_attempts, leaseToken: after.lease_token });
      });
    },

    async complete(claimInput, outcome, now) {
      const claim = receiptCostRecoveryClaimSchema.parse(claimInput);
      assertRecoveryDate(now); assertRecoveryDate(outcome.nextAttemptAt);
      const state = z.enum(["queued", "applied", "review_required", "exhausted"]).parse(outcome.state);
      const errorCode = z.string().min(1).max(100).nullable().parse(outcome.errorCode);
      return transaction(pool, async (client) => {
        const selected = await client.query(`SELECT * FROM procurement.receipt_cost_recovery_jobs
          WHERE request_id=$1 AND state='processing' AND lease_token=$2 AND lease_expires_at > $3
          FOR UPDATE`, [claim.requestId, claim.leaseToken, now]);
        const before = selected.rows[0];
        if (!before) return null;
        const latest = await client.query(`SELECT state FROM procurement.receipt_cost_attempts
          WHERE request_id=$1 ORDER BY id DESC LIMIT 1`, [claim.requestId]);
        const recordedState = latest.rows[0]?.state;
        // A simultaneous explicit retry can finish after this worker's result.
        const finalState = recordedState === "applied" || recordedState === "review_required" ? recordedState : state;
        const updated = await client.query(`UPDATE procurement.receipt_cost_recovery_jobs
          SET state=$2,next_attempt_at=$3,lease_token=NULL,lease_expires_at=NULL,last_error_code=$4,updated_at=$5
          WHERE request_id=$1 RETURNING *`,
        [claim.requestId, finalState, outcome.nextAttemptAt, finalState === "applied" ? null : errorCode, now]);
        await event(client, claim.requestId, "completed", before, updated.rows[0], now);
        return finalState;
      });
    },
  };
}
