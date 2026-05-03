import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type { DropshipTrackingPushStatus } from "../application/dropship-tracking-push-ops-dtos";
import type {
  DropshipTrackingPushOpsListResult,
  DropshipTrackingPushOpsRecord,
  DropshipTrackingPushOpsRepository,
  DropshipTrackingPushRetryRequest,
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
  retryable: boolean | null;
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

interface TrackingPushRetryRow {
  id: number;
  intake_id: number;
  oms_order_id: string | number;
  vendor_id: number;
  store_connection_id: number;
  platform: string;
  external_order_id: string;
  status: DropshipTrackingPushStatus;
  idempotency_key: string;
  carrier: string;
  tracking_number: string;
  shipped_at: Date;
  attempt_count: string | number;
  last_error_code: string | null;
  last_error_message: string | null;
  raw_result: Record<string, unknown> | null;
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

  async prepareRetry(
    input: Parameters<DropshipTrackingPushOpsRepository["prepareRetry"]>[0],
  ): Promise<DropshipTrackingPushRetryRequest> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await loadTrackingPushForRetry(client, input.pushId);
      if (!existing) {
        throw new DropshipError(
          "DROPSHIP_TRACKING_PUSH_OPS_PUSH_NOT_FOUND",
          "Dropship tracking push was not found.",
          { pushId: input.pushId },
        );
      }

      if (existing.status !== "failed") {
        throw new DropshipError(
          "DROPSHIP_TRACKING_PUSH_OPS_STATUS_NOT_RETRYABLE",
          "Only failed dropship tracking pushes can be retried.",
          { pushId: input.pushId, status: existing.status },
        );
      }

      if (!trackingPushFailureIsRetryable(existing.raw_result)) {
        throw new DropshipError(
          "DROPSHIP_TRACKING_PUSH_OPS_PUSH_NOT_RETRYABLE",
          "Dropship tracking push failure was marked non-retryable.",
          {
            pushId: input.pushId,
            lastErrorCode: existing.last_error_code,
            lastErrorMessage: existing.last_error_message,
          },
        );
      }

      const updated = await client.query<TrackingPushRetryRow>(
        `UPDATE dropship.dropship_marketplace_tracking_pushes
         SET status = 'queued',
             raw_result = COALESCE(raw_result, '{}'::jsonb) || $2::jsonb,
             updated_at = $3
         WHERE id = $1
         RETURNING id, intake_id, oms_order_id, vendor_id, store_connection_id,
                   platform, external_order_id, status, idempotency_key,
                   carrier, tracking_number, shipped_at, attempt_count,
                   last_error_code, last_error_message, raw_result`,
        [
          input.pushId,
          JSON.stringify({
            lastRetryRequest: {
              idempotencyKey: input.idempotencyKey,
              reason: input.reason ?? null,
              actorType: input.actor.actorType,
              actorId: input.actor.actorId ?? null,
              requestedAt: input.now.toISOString(),
            },
          }),
          input.now,
        ],
      );
      const row = requiredRow(updated.rows[0], "Dropship tracking push retry did not return a row.");
      await recordTrackingPushOpsAuditEvent(client, {
        row,
        eventType: "tracking_push_retry_requested",
        actor: input.actor,
        severity: "info",
        payload: {
          idempotencyKey: input.idempotencyKey,
          trackingPushIdempotencyKey: row.idempotency_key,
          previousStatus: existing.status,
          previousAttemptCount: toSafeNonNegativeInteger(existing.attempt_count, "attempt_count"),
          previousLastErrorCode: existing.last_error_code,
          previousLastErrorMessage: existing.last_error_message,
          reason: input.reason ?? null,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return {
        pushId: row.id,
        omsOrderId: toSafePositiveInteger(row.oms_order_id, "oms_order_id"),
        carrier: row.carrier,
        trackingNumber: row.tracking_number,
        shippedAt: row.shipped_at,
        idempotencyKey: row.idempotency_key,
        previousAttemptCount: toSafeNonNegativeInteger(existing.attempt_count, "attempt_count"),
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async markPreparedRetryFailed(
    input: Parameters<DropshipTrackingPushOpsRepository["markPreparedRetryFailed"]>[0],
  ): Promise<void> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<TrackingPushRetryRow>(
        `UPDATE dropship.dropship_marketplace_tracking_pushes
         SET status = 'failed',
             last_error_code = $2,
             last_error_message = $3,
             raw_result = COALESCE(raw_result, '{}'::jsonb) || $4::jsonb,
             updated_at = $5
         WHERE id = $1
           AND status = 'queued'
         RETURNING id, intake_id, oms_order_id, vendor_id, store_connection_id,
                   platform, external_order_id, status, idempotency_key,
                   carrier, tracking_number, shipped_at, attempt_count,
                   last_error_code, last_error_message, raw_result`,
        [
          input.pushId,
          input.code,
          input.message,
          JSON.stringify({
            lastFailure: {
              retryable: input.retryable,
              failedAt: input.now.toISOString(),
            },
          }),
          input.now,
        ],
      );
      const row = updated.rows[0];
      if (row) {
        await recordTrackingPushOpsAuditEvent(client, {
          row,
          eventType: "tracking_push_retry_prepare_failed",
          actor: { actorType: "system" },
          severity: input.retryable ? "warning" : "error",
          payload: {
            code: input.code,
            message: input.message,
            retryable: input.retryable,
          },
          occurredAt: input.now,
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
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
      COALESCE((tp.raw_result->'lastFailure'->>'retryable')::boolean, true) AS retryable,
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
    retryable: row.retryable !== false,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function loadTrackingPushForRetry(
  client: PoolClient,
  pushId: number,
): Promise<TrackingPushRetryRow | null> {
  const result = await client.query<TrackingPushRetryRow>(
    `SELECT id, intake_id, oms_order_id, vendor_id, store_connection_id,
            platform, external_order_id, status, idempotency_key,
            carrier, tracking_number, shipped_at, attempt_count,
            last_error_code, last_error_message, raw_result
     FROM dropship.dropship_marketplace_tracking_pushes
     WHERE id = $1
     LIMIT 1
     FOR UPDATE`,
    [pushId],
  );
  return result.rows[0] ?? null;
}

async function recordTrackingPushOpsAuditEvent(
  client: PoolClient,
  input: {
    row: TrackingPushRetryRow;
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
     VALUES ($1, $2, 'dropship_marketplace_tracking_push', $3, $4,
             $5, $6, $7, $8::jsonb, $9)`,
    [
      input.row.vendor_id,
      input.row.store_connection_id,
      String(input.row.id),
      input.eventType,
      input.actor.actorType,
      input.actor.actorId ?? null,
      input.severity,
      JSON.stringify({
        intakeId: input.row.intake_id,
        omsOrderId: toSafePositiveInteger(input.row.oms_order_id, "oms_order_id"),
        platform: input.row.platform,
        externalOrderId: input.row.external_order_id,
        ...input.payload,
      }),
      input.occurredAt,
    ],
  );
}

function trackingPushFailureIsRetryable(rawResult: Record<string, unknown> | null): boolean {
  const lastFailure = rawResult?.lastFailure;
  if (!lastFailure || typeof lastFailure !== "object" || Array.isArray(lastFailure)) {
    return true;
  }
  return (lastFailure as { retryable?: unknown }).retryable !== false;
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

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new Error(message);
  return row;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
