import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import { ebayListingFailureDiagnosticSchema } from "../ebay-listing-failure-diagnostic";
import type { Pool } from "pg";
import type { EbayListingSyncJob } from "@shared/types/ebay-listing-sync";
import { ebayListingSyncProgressSchema } from "@shared/types/ebay-listing-sync";
import { ebayListingPhaseFromStage } from "../ebay-listing-job-progress";

interface ProgressRow {
  id: string;
  state: EbayListingSyncJob["state"];
  updated_at: Date;
  requested_at: Date;
  last_activity_at: Date;
  last_worker_activity_at: Date | null;
  stage_key: string | null;
  stage_event: string | null;
  queued_ahead: number | null;
  failure_code: string | null;
  diagnostic: unknown;
}

/** One batched, read-only projection for the feed, details and exact-command
 * receipts. A prior revision/owner cannot supply the current attempt's phase.
 * The worker claims across channels, so queue counts/activity use that same
 * global queue without exposing another channel's identities or error details. */
export async function withEbayListingJobProgress<
  T extends Pick<EbayListingSyncJob, "id" | "kind" | "state" | "updatedAt"> &
    Partial<Pick<EbayListingSyncJob, "code" | "message" | "productId">>,
>(client: Pick<Pool, "query">, jobs: readonly T[]): Promise<T[]> {
  const ids = jobs
    .filter((job) => job.kind !== "admission")
    .map((job) => job.id);
  if (!ids.length) return [...jobs];
  const { rows } = await client.query<ProgressRow>(
    `
    WITH requested AS (
      SELECT id,channel_id,state,revision,claimed_revision,created_at,updated_at,next_attempt_at,error_code
      FROM channels.ebay_listing_sync_jobs WHERE id=ANY($1::uuid[])
    ), worker_activity AS (
      SELECT created_at AS activity_at FROM channels.ebay_listing_sync_events
      WHERE event IN('claimed','stage_started','stage_completed','completed','recovering','awaiting_evidence','needs_attention')
      ORDER BY id DESC LIMIT 1
    )
    SELECT job.id::text,job.state,job.updated_at,job.created_at AS requested_at,
      job.error_code AS failure_code,failure.evidence->'diagnostic' AS diagnostic,
      GREATEST(job.updated_at,activity.created_at) AS last_activity_at,
      CASE WHEN job.state='queued' THEN worker.activity_at ELSE NULL END AS last_worker_activity_at,
      CASE WHEN job.state='queued' THEN NULL ELSE stage.evidence->>'key' END AS stage_key,
      CASE WHEN job.state='queued' THEN NULL ELSE stage.event END AS stage_event,
      CASE WHEN job.state='queued' THEN (
        SELECT count(*)::integer FROM channels.ebay_listing_sync_jobs preceding
        WHERE preceding.state IN('queued','running','recovering','awaiting_evidence') AND NOT preceding.read_retry_paused
          AND preceding.next_attempt_at<=CURRENT_TIMESTAMP
          AND (preceding.next_attempt_at,preceding.id)<(job.next_attempt_at,job.id)
      ) ELSE NULL END AS queued_ahead
    FROM requested job
    LEFT JOIN worker_activity worker ON true
    LEFT JOIN LATERAL(SELECT created_at FROM channels.ebay_listing_sync_events WHERE job_id=job.id ORDER BY id DESC LIMIT 1) activity ON true
    LEFT JOIN LATERAL(
      SELECT id,owner_token FROM channels.ebay_listing_sync_events
      WHERE job_id=job.id AND revision=COALESCE(job.claimed_revision,job.revision) AND event='claimed'
      ORDER BY id DESC LIMIT 1
    ) claim ON true
    LEFT JOIN LATERAL(
      SELECT evidence,event FROM channels.ebay_listing_sync_events
      WHERE job_id=job.id AND revision=COALESCE(job.claimed_revision,job.revision)
        AND owner_token IS NOT DISTINCT FROM claim.owner_token AND id>claim.id
        AND event IN('stage_started','stage_completed') ORDER BY id DESC LIMIT 1
    ) stage ON true
    LEFT JOIN LATERAL(
      SELECT evidence FROM channels.ebay_listing_sync_events
      WHERE job_id=job.id AND revision=COALESCE(job.claimed_revision,job.revision)
        AND owner_token IS NOT DISTINCT FROM claim.owner_token AND id>claim.id
        AND event IN('needs_attention','recovering','awaiting_evidence')
      ORDER BY id DESC LIMIT 1
    ) failure ON true`,
    [ids],
  );
  const snapshots = new Map(jobs.map((job) => [job.id, job]));
  const progress = new Map(
    rows
      .filter((row) => {
        const snapshot = snapshots.get(row.id);
        // A worker may finish between the job read and this projection. Never attach
        // a new state's phase to an older queued/failed response; the next poll reads
        // both again. Stage-only events remain visible without changing updated_at.
        return (
          snapshot?.state === row.state &&
          snapshot.updatedAt === row.updated_at.toISOString()
        );
      })
      .map((row) => {
        const phase = ebayListingPhaseFromStage(row.stage_key);
        return [
          row.id,
          ebayListingSyncProgressSchema.parse({
            requestedAt: row.requested_at.toISOString(),
            lastActivityAt: row.last_activity_at.toISOString(),
            lastWorkerActivityAt:
              row.last_worker_activity_at?.toISOString() ?? null,
            queuedAhead: row.queued_ahead,
            phase,
            phaseState:
              phase === null
                ? null
                : row.stage_event === "stage_completed"
                  ? ("completed" as const)
                  : ("started" as const),
          }),
        ] as const;
      }),
  );
  const policyIssues = new Map(
    rows.flatMap((row) => {
      const snapshot = snapshots.get(row.id);
      if (
        !snapshot ||
        snapshot.state !== row.state ||
        snapshot.updatedAt !== row.updated_at.toISOString() ||
        !["needs_attention", "recovering", "awaiting_evidence"].includes(
          snapshot.state,
        ) ||
        snapshot.code !== row.failure_code
      )
        return [];
      const diagnostic = ebayListingFailureDiagnosticSchema.safeParse(
        row.diagnostic,
      );
      if (
        !diagnostic.success ||
        diagnostic.data.code !== snapshot.code ||
        !diagnostic.data.context.policySource
      )
        return [];
      return [
        [
          row.id,
          resolveEbayListingIssue({
            code: snapshot.code,
            message: snapshot.message,
            productId: snapshot.productId,
            jobId: snapshot.id,
            state: snapshot.state,
            policySource: diagnostic.data.context.policySource,
          }),
        ] as const,
      ];
    }),
  );
  return jobs.map((job) => ({
    ...job,
    ...(progress.has(job.id) ? { progress: progress.get(job.id)! } : {}),
    ...(policyIssues.has(job.id) ? { issue: policyIssues.get(job.id)! } : {}),
  }));
}
