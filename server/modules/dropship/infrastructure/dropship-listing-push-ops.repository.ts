import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type { DropshipListingPushJobStatus } from "../application/dropship-listing-push-ops-dtos";
import type {
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
