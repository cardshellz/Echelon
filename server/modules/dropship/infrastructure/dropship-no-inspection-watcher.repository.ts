import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipNoInspectionCandidate,
  DropshipNoInspectionEvidencePack,
  DropshipNoInspectionWatcherRepository,
} from "../application/dropship-no-inspection-watcher-service";
import { DropshipError } from "../domain/errors";

interface CandidateRow {
  id: number;
  vendor_id: number;
  store_connection_id: number | null;
  rma_number: string;
  status: string;
  return_tracking_number: string | null;
  return_expected_delivery_at: Date | null;
  requested_at: Date;
  policy_version_id: number | null;
  no_inspection_timeout_days: number | null;
  marketplace_case_ref: string | null;
}

const DEFAULT_NO_INSPECTION_TIMEOUT_DAYS = 10;

export class PgDropshipNoInspectionWatcherRepository implements DropshipNoInspectionWatcherRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listCandidates(input: {
    now: Date;
    limit: number;
  }): Promise<DropshipNoInspectionCandidate[]> {
    // Candidates: RMAs still on the outbound-to-us leg (requested/in_transit)
    // that EITHER have a tracking number (lost-status path) OR an expected
    // delivery date inside the timeout window (timeout path). The watcher
    // service evaluates the actual triggers; this query is the coarse filter.
    // The timeout knob comes from the RMA's governing policy version row
    // (migration 188), defaulting to 10 days for pre-versioning RMAs.
    const result = await this.dbPool.query<CandidateRow>(
      `SELECT r.id, r.vendor_id, r.store_connection_id, r.rma_number, r.status,
              r.return_tracking_number, r.return_expected_delivery_at, r.requested_at,
              r.policy_version_id, p.no_inspection_timeout_days,
              (r.no_inspection_evidence ->> 'marketplaceCaseRef') AS marketplace_case_ref
       FROM dropship.dropship_rmas r
       LEFT JOIN dropship.dropship_return_policies p ON p.id = r.policy_version_id
       WHERE r.status IN ('requested', 'in_transit')
         AND r.received_at IS NULL
         AND (
           r.return_tracking_number IS NOT NULL
           OR (
             r.return_expected_delivery_at IS NOT NULL
             AND r.return_expected_delivery_at
                   + (COALESCE(p.no_inspection_timeout_days, $2) || ' days')::interval <= $1
           )
         )
       ORDER BY r.id ASC
       LIMIT $3`,
      [input.now, DEFAULT_NO_INSPECTION_TIMEOUT_DAYS, input.limit],
    );
    return result.rows.map((row) => ({
      rmaId: row.id,
      vendorId: row.vendor_id,
      storeConnectionId: row.store_connection_id,
      rmaNumber: row.rma_number,
      status: row.status as "requested" | "in_transit",
      returnTrackingNumber: row.return_tracking_number,
      returnExpectedDeliveryAt: row.return_expected_delivery_at,
      requestedAt: row.requested_at,
      policyVersionId: row.policy_version_id,
      noInspectionTimeoutDays: row.no_inspection_timeout_days ?? DEFAULT_NO_INSPECTION_TIMEOUT_DAYS,
      marketplaceCaseRef: row.marketplace_case_ref,
    }));
  }

  async queueForReview(input: {
    rmaId: number;
    vendorId: number;
    evidence: DropshipNoInspectionEvidencePack;
    policyVersionId: number | null;
    idempotencyKey: string;
    workerId: string;
    now: Date;
  }): Promise<{ queued: boolean }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ id: number; status: string }>(
        `SELECT id, status
         FROM dropship.dropship_rmas
         WHERE id = $1
         LIMIT 1
         FOR UPDATE`,
        [input.rmaId],
      );
      const rma = locked.rows[0];
      if (!rma) {
        throw new DropshipError(
          "DROPSHIP_RMA_NOT_FOUND",
          "Dropship RMA was not found for no-inspection review.",
          { rmaId: input.rmaId },
        );
      }
      // State machine (D4): only requested/in_transit → no_inspection_review.
      // Anything else means the RMA moved on (admin action, concurrent
      // watcher run, delivery scan) — skip, never error.
      if (rma.status !== "requested" && rma.status !== "in_transit") {
        await client.query("COMMIT");
        return { queued: false };
      }

      const evidence: DropshipNoInspectionEvidencePack = {
        ...input.evidence,
        workerId: input.workerId,
      };
      const updated = await client.query(
        `UPDATE dropship.dropship_rmas
         SET status = 'no_inspection_review',
             no_inspection_evidence = $3::jsonb,
             updated_at = $2
         WHERE id = $1
           AND status IN ('requested', 'in_transit')`,
        [input.rmaId, input.now, JSON.stringify(evidence)],
      );
      if (updated.rowCount !== 1) {
        await client.query("COMMIT");
        return { queued: false };
      }

      await client.query(
        `INSERT INTO dropship.dropship_rma_status_updates
          (rma_id, vendor_id, previous_status, status, notes, actor_type, actor_id,
           policy_version_id, idempotency_key, request_hash, created_at)
         VALUES ($1, $2, $3, 'no_inspection_review', $4, 'system', $5, $6, $7, $8, $9)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          input.rmaId,
          input.vendorId,
          rma.status,
          `No-inspection review queued (${evidence.trigger}).`,
          input.workerId,
          input.policyVersionId,
          input.idempotencyKey,
          createHash("sha256").update(JSON.stringify({
            command: "rma_no_inspection_queued",
            rmaId: input.rmaId,
            trigger: evidence.trigger,
          })).digest("hex"),
          input.now,
        ],
      );

      await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type,
           actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, NULL, 'dropship_rma', $2, 'rma_no_inspection_review_queued',
                 'job', $3, 'info', $4::jsonb, $5)`,
        [
          input.vendorId,
          String(input.rmaId),
          input.workerId,
          JSON.stringify({
            previousStatus: rma.status,
            status: "no_inspection_review",
            trigger: evidence.trigger,
            trackingNumber: evidence.trackingNumber,
            carrierStatus: evidence.carrierStatus,
            expectedDeliveryAt: evidence.expectedDeliveryAt,
            policyVersionId: input.policyVersionId,
          }),
          input.now,
        ],
      );

      await client.query("COMMIT");
      return { queued: true };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
