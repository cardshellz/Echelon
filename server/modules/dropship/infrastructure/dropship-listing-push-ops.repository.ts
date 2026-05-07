import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type { DropshipListingPushJobStatus } from "../application/dropship-listing-push-ops-dtos";
import type {
  DropshipListingPushOpsActionResult,
  DropshipListingPushOpsJobListItem,
  DropshipListingPushOpsJobListResult,
  DropshipListingPushOpsLatestItemError,
  DropshipListingPushOpsRepository,
  DropshipListingPushOpsStatusSummary,
} from "../application/dropship-listing-push-ops-service";

interface ListingPushJobRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  platform: string;
  status: DropshipListingPushJobStatus;
  job_type: string;
  requested_scope: Record<string, unknown> | null;
  requested_by: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  member_id: string;
  business_name: string | null;
  email: string | null;
  vendor_status: string;
  entitlement_status: string;
  store_platform: string;
  store_status: string;
  setup_status: string;
  external_display_name: string | null;
  shop_domain: string | null;
  item_total: string | number;
  item_queued: string | number;
  item_processing: string | number;
  item_completed: string | number;
  item_failed: string | number;
  item_blocked: string | number;
  item_cancelled: string | number;
  latest_error_item_id: number | null;
  latest_error_product_variant_id: number | null;
  latest_error_status: string | null;
  latest_error_code: string | null;
  latest_error_message: string | null;
  latest_error_updated_at: Date | null;
  total_count: string | number;
}

interface StatusCountRow {
  status: DropshipListingPushJobStatus;
  count: string | number;
}

interface ListingPushActionJobRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  status: DropshipListingPushJobStatus;
  updated_at: Date;
  completed_at: Date | null;
}

interface RequeuedListingPushItemRow {
  id: number;
  listing_id: number | null;
}

const DEFAULT_LISTING_PUSH_OPS_STALE_PROCESSING_MINUTES = 30;

export class PgDropshipListingPushOpsRepository implements DropshipListingPushOpsRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listJobs(
    input: Parameters<DropshipListingPushOpsRepository["listJobs"]>[0],
  ): Promise<DropshipListingPushOpsJobListResult> {
    const client = await this.dbPool.connect();
    try {
      const listFilters = buildListingPushJobFilters(input, { includeStatuses: true });
      const offset = (input.page - 1) * input.limit;
      const rows = await client.query<ListingPushJobRow>(
        `${listingPushJobSelectSql()}
         ${listFilters.whereSql}
         ORDER BY j.updated_at DESC, j.id DESC
         LIMIT $${listFilters.params.length + 1}
         OFFSET $${listFilters.params.length + 2}`,
        [...listFilters.params, input.limit, offset],
      );

      const summaryFilters = buildListingPushJobFilters(input, { includeStatuses: false });
      const summary = await client.query<StatusCountRow>(
        `SELECT j.status, COUNT(*) AS count
         ${listingPushJobBaseFromSql()}
         ${summaryFilters.whereSql}
         GROUP BY j.status
         ORDER BY j.status ASC`,
        summaryFilters.params,
      );

      return {
        items: rows.rows.map(mapListingPushJobRow),
        total: rows.rows.length > 0 ? toSafeInteger(rows.rows[0].total_count, "total_count") : 0,
        page: input.page,
        limit: input.limit,
        statuses: input.statuses,
        summary: summary.rows.map(mapStatusCountRow),
      };
    } finally {
      client.release();
    }
  }

  async retryJob(
    input: Parameters<DropshipListingPushOpsRepository["retryJob"]>[0],
  ): Promise<DropshipListingPushOpsActionResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await loadListingPushJobForUpdate(client, input.jobId);
      if (!existing) {
        throw new DropshipError(
          "DROPSHIP_LISTING_PUSH_OPS_JOB_NOT_FOUND",
          "Dropship listing push job was not found.",
          { jobId: input.jobId },
        );
      }

      if (existing.status === "queued") {
        await client.query("COMMIT");
        return mapActionResult(existing, existing.status, 0, true);
      }

      const staleProcessingMinutes = listingPushOpsStaleProcessingMinutes();
      let requeuedItems: RequeuedListingPushItemRow[];
      if (existing.status === "failed") {
        requeuedItems = await requeueRetryableFailedItems(client, {
          jobId: input.jobId,
          now: input.now,
          idempotencyKey: input.idempotencyKey,
          actor: input.actor,
          reason: input.reason,
        });
        if (requeuedItems.length === 0) {
          throw new DropshipError(
            "DROPSHIP_LISTING_PUSH_OPS_JOB_NOT_RETRYABLE",
            "Dropship listing push job has no retryable failed items.",
            { jobId: input.jobId, status: existing.status },
          );
        }
        await markRequeuedListingsQueued(client, {
          listingIds: uniquePositiveIntegers(requeuedItems.map((row) => row.listing_id)),
          now: input.now,
          jobId: input.jobId,
          idempotencyKey: input.idempotencyKey,
        });
      } else if (existing.status === "processing") {
        if (!isStaleProcessingJob(existing, input.now, staleProcessingMinutes)) {
          throw new DropshipError(
            "DROPSHIP_LISTING_PUSH_OPS_STATUS_NOT_RETRYABLE",
            "Only failed or stale processing dropship listing push jobs can be retried.",
            {
              jobId: input.jobId,
              status: existing.status,
              updatedAt: existing.updated_at.toISOString(),
              staleAfterMinutes: staleProcessingMinutes,
            },
          );
        }
        requeuedItems = await requeueProcessingItems(client, {
          jobId: input.jobId,
          now: input.now,
          idempotencyKey: input.idempotencyKey,
          actor: input.actor,
          reason: input.reason,
          staleAfterMinutes: staleProcessingMinutes,
        });
      } else {
        throw new DropshipError(
          "DROPSHIP_LISTING_PUSH_OPS_STATUS_NOT_RETRYABLE",
          "Only failed or stale processing dropship listing push jobs can be retried.",
          { jobId: input.jobId, status: existing.status },
        );
      }

      const updated = await client.query<ListingPushActionJobRow>(
        `UPDATE dropship.dropship_listing_push_jobs
         SET status = 'queued',
             error_message = NULL,
             completed_at = NULL,
             updated_at = $2
         WHERE id = $1
         RETURNING id, vendor_id, store_connection_id, status, updated_at, completed_at`,
        [input.jobId, input.now],
      );
      const row = requiredRow(updated.rows[0], "Dropship listing push job retry did not return a row.");
      await recordListingPushOpsAuditEvent(client, {
        row,
        eventType: "listing_push_job_retry_requested",
        actor: input.actor,
        severity: existing.status === "processing" ? "warning" : "info",
        payload: {
          idempotencyKey: input.idempotencyKey,
          previousStatus: existing.status,
          requeuedItemCount: requeuedItems.length,
          staleJobUpdatedAt: existing.status === "processing" ? existing.updated_at.toISOString() : null,
          staleAfterMinutes: existing.status === "processing" ? staleProcessingMinutes : null,
          reason: input.reason ?? null,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return mapActionResult(row, existing.status, requeuedItems.length, false);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

function listingPushJobSelectSql(): string {
  return `
    SELECT
      j.id,
      j.vendor_id,
      j.store_connection_id,
      sc.platform,
      j.status,
      j.job_type,
      j.requested_scope,
      j.requested_by,
      j.idempotency_key,
      j.request_hash,
      j.error_message,
      j.created_at,
      j.updated_at,
      j.completed_at,
      v.member_id,
      v.business_name,
      v.email,
      v.status AS vendor_status,
      v.entitlement_status,
      sc.platform AS store_platform,
      sc.status AS store_status,
      sc.setup_status,
      sc.external_display_name,
      sc.shop_domain,
      COALESCE(item_counts.item_total, 0) AS item_total,
      COALESCE(item_counts.item_queued, 0) AS item_queued,
      COALESCE(item_counts.item_processing, 0) AS item_processing,
      COALESCE(item_counts.item_completed, 0) AS item_completed,
      COALESCE(item_counts.item_failed, 0) AS item_failed,
      COALESCE(item_counts.item_blocked, 0) AS item_blocked,
      COALESCE(item_counts.item_cancelled, 0) AS item_cancelled,
      latest_error.id AS latest_error_item_id,
      latest_error.product_variant_id AS latest_error_product_variant_id,
      latest_error.status AS latest_error_status,
      latest_error.error_code AS latest_error_code,
      latest_error.error_message AS latest_error_message,
      latest_error.updated_at AS latest_error_updated_at,
      COUNT(*) OVER() AS total_count
  ` + listingPushJobBaseFromSql();
}

function listingPushJobBaseFromSql(): string {
  return `
    FROM dropship.dropship_listing_push_jobs j
    INNER JOIN dropship.dropship_vendors v ON v.id = j.vendor_id
    INNER JOIN dropship.dropship_store_connections sc ON sc.id = j.store_connection_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS item_total,
        COUNT(*) FILTER (WHERE i.status = 'queued') AS item_queued,
        COUNT(*) FILTER (WHERE i.status = 'processing') AS item_processing,
        COUNT(*) FILTER (WHERE i.status = 'completed') AS item_completed,
        COUNT(*) FILTER (WHERE i.status = 'failed') AS item_failed,
        COUNT(*) FILTER (WHERE i.status = 'blocked') AS item_blocked,
        COUNT(*) FILTER (WHERE i.status = 'cancelled') AS item_cancelled
      FROM dropship.dropship_listing_push_job_items i
      WHERE i.job_id = j.id
    ) item_counts ON true
    LEFT JOIN LATERAL (
      SELECT i.id, i.product_variant_id, i.status, i.error_code, i.error_message, i.updated_at
      FROM dropship.dropship_listing_push_job_items i
      WHERE i.job_id = j.id
        AND i.status IN ('failed', 'blocked')
      ORDER BY i.updated_at DESC, i.id DESC
      LIMIT 1
    ) latest_error ON true
  `;
}

function buildListingPushJobFilters(
  input: {
    statuses?: readonly DropshipListingPushJobStatus[];
    vendorId?: number;
    storeConnectionId?: number;
    platform?: string;
    search?: string;
  },
  options: { includeStatuses: boolean },
): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.includeStatuses && input.statuses && input.statuses.length > 0) {
    params.push(input.statuses);
    clauses.push(`j.status = ANY($${params.length}::text[])`);
  }
  if (input.vendorId) {
    params.push(input.vendorId);
    clauses.push(`j.vendor_id = $${params.length}`);
  }
  if (input.storeConnectionId) {
    params.push(input.storeConnectionId);
    clauses.push(`j.store_connection_id = $${params.length}`);
  }
  if (input.platform) {
    params.push(input.platform);
    clauses.push(`sc.platform = $${params.length}`);
  }
  if (input.search) {
    params.push(`%${input.search.trim()}%`);
    clauses.push(`(
      j.id::text ILIKE $${params.length}
      OR j.idempotency_key ILIKE $${params.length}
      OR j.request_hash ILIKE $${params.length}
      OR v.business_name ILIKE $${params.length}
      OR v.email ILIKE $${params.length}
      OR v.member_id ILIKE $${params.length}
      OR sc.external_display_name ILIKE $${params.length}
      OR sc.shop_domain ILIKE $${params.length}
      OR latest_error.error_code ILIKE $${params.length}
      OR latest_error.error_message ILIKE $${params.length}
    )`);
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function mapListingPushJobRow(row: ListingPushJobRow): DropshipListingPushOpsJobListItem {
  return {
    jobId: row.id,
    vendor: {
      vendorId: row.vendor_id,
      memberId: row.member_id,
      businessName: row.business_name,
      email: row.email,
      status: row.vendor_status,
      entitlementStatus: row.entitlement_status,
    },
    storeConnection: {
      storeConnectionId: row.store_connection_id,
      platform: row.store_platform,
      status: row.store_status,
      setupStatus: row.setup_status,
      externalDisplayName: row.external_display_name,
      shopDomain: row.shop_domain,
    },
    platform: row.platform,
    status: row.status,
    jobType: row.job_type,
    requestedBy: row.requested_by,
    requestedScope: row.requested_scope,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    itemSummary: {
      total: toSafeInteger(row.item_total, "item_total"),
      queued: toSafeInteger(row.item_queued, "item_queued"),
      processing: toSafeInteger(row.item_processing, "item_processing"),
      completed: toSafeInteger(row.item_completed, "item_completed"),
      failed: toSafeInteger(row.item_failed, "item_failed"),
      blocked: toSafeInteger(row.item_blocked, "item_blocked"),
      cancelled: toSafeInteger(row.item_cancelled, "item_cancelled"),
    },
    latestItemError: mapLatestItemError(row),
  };
}

function mapLatestItemError(row: ListingPushJobRow): DropshipListingPushOpsLatestItemError | null {
  if (
    row.latest_error_item_id === null ||
    row.latest_error_product_variant_id === null ||
    row.latest_error_status === null ||
    row.latest_error_updated_at === null
  ) {
    return null;
  }
  return {
    itemId: row.latest_error_item_id,
    productVariantId: row.latest_error_product_variant_id,
    status: row.latest_error_status,
    errorCode: row.latest_error_code,
    errorMessage: row.latest_error_message,
    updatedAt: row.latest_error_updated_at,
  };
}

function mapStatusCountRow(row: StatusCountRow): DropshipListingPushOpsStatusSummary {
  return {
    status: row.status,
    count: toSafeInteger(row.count, "status_count"),
  };
}

async function loadListingPushJobForUpdate(
  client: PoolClient,
  jobId: number,
): Promise<ListingPushActionJobRow | null> {
  const result = await client.query<ListingPushActionJobRow>(
    `SELECT id, vendor_id, store_connection_id, status, updated_at, completed_at
     FROM dropship.dropship_listing_push_jobs
     WHERE id = $1
     LIMIT 1
     FOR UPDATE`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

async function requeueRetryableFailedItems(
  client: PoolClient,
  input: {
    jobId: number;
    now: Date;
    idempotencyKey: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    reason?: string;
  },
): Promise<RequeuedListingPushItemRow[]> {
  const result = await client.query<RequeuedListingPushItemRow>(
    `UPDATE dropship.dropship_listing_push_job_items
     SET status = 'queued',
         error_code = NULL,
         error_message = NULL,
         result = COALESCE(result, '{}'::jsonb) || $2::jsonb,
         updated_at = $3
     WHERE job_id = $1
       AND status = 'failed'
       AND COALESCE((result->'push'->>'retryable')::boolean, true) = true
     RETURNING id, listing_id`,
    [
      input.jobId,
      retryRequestPayload(input),
      input.now,
    ],
  );
  return result.rows;
}

async function requeueProcessingItems(
  client: PoolClient,
  input: {
    jobId: number;
    now: Date;
    idempotencyKey: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    reason?: string;
    staleAfterMinutes: number;
  },
): Promise<RequeuedListingPushItemRow[]> {
  const result = await client.query<RequeuedListingPushItemRow>(
    `UPDATE dropship.dropship_listing_push_job_items
     SET status = 'queued',
         error_code = NULL,
         error_message = NULL,
         result = COALESCE(result, '{}'::jsonb) || $2::jsonb,
         updated_at = $3
     WHERE job_id = $1
       AND status = 'processing'
     RETURNING id, listing_id`,
    [
      input.jobId,
      retryRequestPayload(input),
      input.now,
    ],
  );
  return result.rows;
}

async function markRequeuedListingsQueued(
  client: PoolClient,
  input: {
    listingIds: number[];
    now: Date;
    jobId: number;
    idempotencyKey: string;
  },
): Promise<void> {
  if (input.listingIds.length === 0) {
    return;
  }
  await client.query(
    `UPDATE dropship.dropship_vendor_listings
     SET status = 'queued',
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = $3
     WHERE id = ANY($1::int[])`,
    [
      input.listingIds,
      JSON.stringify({
        lastPushRetry: {
          jobId: input.jobId,
          idempotencyKey: input.idempotencyKey,
          requestedAt: input.now.toISOString(),
        },
      }),
      input.now,
    ],
  );
}

async function recordListingPushOpsAuditEvent(
  client: PoolClient,
  input: {
    row: ListingPushActionJobRow;
    eventType: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    severity: "info" | "warning" | "error";
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_listing_push_job', $3, $4,
             $5, $6, $7, $8::jsonb, $9)`,
    [
      input.row.vendor_id,
      input.row.store_connection_id,
      String(input.row.id),
      input.eventType,
      input.actor.actorType,
      input.actor.actorId ?? null,
      input.severity,
      JSON.stringify(input.payload),
      input.occurredAt,
    ],
  );
}

function retryRequestPayload(input: {
  idempotencyKey: string;
  actor: { actorType: "admin" | "system"; actorId?: string };
  reason?: string;
  now: Date;
  staleAfterMinutes?: number;
}): string {
  return JSON.stringify({
    lastRetryRequest: {
      idempotencyKey: input.idempotencyKey,
      reason: input.reason ?? null,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId ?? null,
      requestedAt: input.now.toISOString(),
      staleAfterMinutes: input.staleAfterMinutes ?? null,
    },
  });
}

function mapActionResult(
  row: ListingPushActionJobRow,
  previousStatus: DropshipListingPushJobStatus,
  requeuedItemCount: number,
  idempotentReplay: boolean,
): DropshipListingPushOpsActionResult {
  return {
    jobId: row.id,
    previousStatus,
    status: row.status,
    requeuedItemCount,
    idempotentReplay,
    updatedAt: row.updated_at,
  };
}

function listingPushOpsStaleProcessingMinutes(): number {
  const value = Number(process.env.DROPSHIP_LISTING_PUSH_STALE_PROCESSING_MINUTES);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_LISTING_PUSH_OPS_STALE_PROCESSING_MINUTES;
}

function isStaleProcessingJob(
  row: Pick<ListingPushActionJobRow, "updated_at">,
  now: Date,
  staleAfterMinutes: number,
): boolean {
  return row.updated_at.getTime() <= now.getTime() - staleAfterMinutes * 60_000;
}

function uniquePositiveIntegers(values: ReadonlyArray<number | null>): number[] {
  return [...new Set(values.filter((value): value is number => (
    typeof value === "number" && Number.isInteger(value) && value > 0
  )))];
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function toSafeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DropshipError(
      "DROPSHIP_LISTING_PUSH_OPS_INTEGER_RANGE_ERROR",
      "Dropship listing push ops integer value is outside the safe runtime range.",
      { field, value: String(value) },
    );
  }
  return parsed;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
