import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type { DropshipTrackingPushStatus } from "../application/dropship-tracking-push-ops-dtos";
import type {
  DropshipTrackingPushOpsListResult,
  DropshipTrackingPushOpsRecord,
  DropshipTrackingPushOpsRepository,
  DropshipTrackingPushOpsStatusSummary,
} from "../application/dropship-tracking-push-ops-service";

interface TrackingPushOpsRow {
  id: number;
  intake_id: number;
  oms_order_id: string | number;
  vendor_id: number;
  store_connection_id: number;
  platform: string;
  external_order_id: string;
  external_order_number: string | null;
  source_order_id: string | null;
  status: DropshipTrackingPushStatus;
  idempotency_key: string;
  request_hash: string;
  carrier: string;
  tracking_number: string;
  shipped_at: Date;
  external_fulfillment_id: string | null;
  attempt_count: string | number;
  last_error_code: string | null;
  last_error_message: string | null;
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
  total_count: string | number;
}

interface StatusCountRow {
  status: DropshipTrackingPushStatus;
  count: string | number;
}

export class PgDropshipTrackingPushOpsRepository implements DropshipTrackingPushOpsRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listPushes(
    input: Parameters<DropshipTrackingPushOpsRepository["listPushes"]>[0],
  ): Promise<DropshipTrackingPushOpsListResult> {
    const client = await this.dbPool.connect();
    try {
      const listFilters = buildTrackingPushFilters(input, { includeStatuses: true });
      const offset = (input.page - 1) * input.limit;
      const rows = await client.query<TrackingPushOpsRow>(
        `${trackingPushSelectSql()}
         ${listFilters.whereSql}
         ORDER BY tp.updated_at DESC, tp.id DESC
         LIMIT $${listFilters.params.length + 1}
         OFFSET $${listFilters.params.length + 2}`,
        [...listFilters.params, input.limit, offset],
      );

      const summaryFilters = buildTrackingPushFilters(input, { includeStatuses: false });
      const summary = await client.query<StatusCountRow>(
        `SELECT tp.status, COUNT(*) AS count
         ${trackingPushBaseFromSql()}
         ${summaryFilters.whereSql}
         GROUP BY tp.status
         ORDER BY tp.status ASC`,
        summaryFilters.params,
      );

      return {
        items: rows.rows.map(mapTrackingPushOpsRow),
        total: rows.rows.length > 0 ? toSafeNonNegativeInteger(rows.rows[0].total_count, "total_count") : 0,
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

function trackingPushSelectSql(): string {
  return `
    SELECT
      tp.id,
      tp.intake_id,
      tp.oms_order_id,
      tp.vendor_id,
      tp.store_connection_id,
      tp.platform,
      tp.external_order_id,
      tp.external_order_number,
      tp.source_order_id,
      tp.status,
      tp.idempotency_key,
      tp.request_hash,
      tp.carrier,
      tp.tracking_number,
      tp.shipped_at,
      tp.external_fulfillment_id,
      tp.attempt_count,
      tp.last_error_code,
      tp.last_error_message,
      tp.created_at,
      tp.updated_at,
      tp.completed_at,
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
      COUNT(*) OVER() AS total_count
  ` + trackingPushBaseFromSql();
}

function trackingPushBaseFromSql(): string {
  return `
    FROM dropship.dropship_marketplace_tracking_pushes tp
    INNER JOIN dropship.dropship_vendors v ON v.id = tp.vendor_id
    INNER JOIN dropship.dropship_store_connections sc ON sc.id = tp.store_connection_id
  `;
}

function buildTrackingPushFilters(
  input: {
    statuses?: readonly DropshipTrackingPushStatus[];
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
    clauses.push(`tp.status = ANY($${params.length}::text[])`);
  }
  if (input.vendorId) {
    params.push(input.vendorId);
    clauses.push(`tp.vendor_id = $${params.length}`);
  }
  if (input.storeConnectionId) {
    params.push(input.storeConnectionId);
    clauses.push(`tp.store_connection_id = $${params.length}`);
  }
  if (input.platform) {
    params.push(input.platform);
    clauses.push(`tp.platform = $${params.length}`);
  }
  if (input.search) {
    params.push(`%${input.search.trim()}%`);
    clauses.push(`(
      tp.id::text ILIKE $${params.length}
      OR tp.intake_id::text ILIKE $${params.length}
      OR tp.oms_order_id::text ILIKE $${params.length}
      OR tp.external_order_id ILIKE $${params.length}
      OR tp.external_order_number ILIKE $${params.length}
      OR tp.source_order_id ILIKE $${params.length}
      OR tp.carrier ILIKE $${params.length}
      OR tp.tracking_number ILIKE $${params.length}
      OR tp.external_fulfillment_id ILIKE $${params.length}
      OR tp.last_error_code ILIKE $${params.length}
      OR tp.last_error_message ILIKE $${params.length}
      OR v.business_name ILIKE $${params.length}
      OR v.email ILIKE $${params.length}
      OR v.member_id ILIKE $${params.length}
      OR sc.external_display_name ILIKE $${params.length}
      OR sc.shop_domain ILIKE $${params.length}
    )`);
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function mapTrackingPushOpsRow(row: TrackingPushOpsRow): DropshipTrackingPushOpsRecord {
  return {
    pushId: row.id,
    intakeId: row.intake_id,
    omsOrderId: toSafePositiveInteger(row.oms_order_id, "oms_order_id"),
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
    externalOrderId: row.external_order_id,
    externalOrderNumber: row.external_order_number,
    sourceOrderId: row.source_order_id,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    carrier: row.carrier,
    trackingNumber: row.tracking_number,
    shippedAt: row.shipped_at,
    externalFulfillmentId: row.external_fulfillment_id,
    attemptCount: toSafeNonNegativeInteger(row.attempt_count, "attempt_count"),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapStatusCountRow(row: StatusCountRow): DropshipTrackingPushOpsStatusSummary {
  return {
    status: row.status,
    count: toSafeNonNegativeInteger(row.count, "status_count"),
  };
}

function toSafePositiveInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_TRACKING_PUSH_OPS_INTEGER_RANGE_ERROR",
      "Dropship tracking push ops integer value is outside the safe runtime range.",
      { field, value: String(value) },
    );
  }
  return parsed;
}

function toSafeNonNegativeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DropshipError(
      "DROPSHIP_TRACKING_PUSH_OPS_INTEGER_RANGE_ERROR",
      "Dropship tracking push ops integer value is outside the safe runtime range.",
      { field, value: String(value) },
    );
  }
  return parsed;
}
