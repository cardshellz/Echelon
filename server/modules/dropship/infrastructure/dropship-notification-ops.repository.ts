import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  DropshipNotificationOpsChannel,
  DropshipNotificationOpsStatus,
} from "../application/dropship-notification-ops-dtos";
import type {
  DropshipNotificationOpsChannelSummary,
  DropshipNotificationOpsEventRecord,
  DropshipNotificationOpsListResult,
  DropshipNotificationOpsPreparedRetry,
  DropshipNotificationOpsRepository,
  DropshipNotificationOpsStatusSummary,
} from "../application/dropship-notification-ops-service";

interface NotificationOpsRow {
  id: number;
  vendor_id: number;
  event_type: string;
  channel: DropshipNotificationOpsChannel;
  critical: boolean;
  title: string;
  message: string | null;
  payload: Record<string, unknown> | null;
  status: DropshipNotificationOpsStatus;
  delivered_at: Date | null;
  read_at: Date | null;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: Date;
  member_id: string;
  business_name: string | null;
  email: string | null;
  vendor_status: string;
  entitlement_status: string;
  total_count?: string | number;
}

interface StatusCountRow {
  status: DropshipNotificationOpsStatus;
  count: string | number;
}

interface ChannelCountRow {
  channel: DropshipNotificationOpsChannel;
  count: string | number;
}

export class PgDropshipNotificationOpsRepository implements DropshipNotificationOpsRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listEvents(
    input: Parameters<DropshipNotificationOpsRepository["listEvents"]>[0],
  ): Promise<DropshipNotificationOpsListResult> {
    const client = await this.dbPool.connect();
    try {
      const listFilters = buildNotificationFilters(input, { includeStatuses: true, includeChannels: true });
      const offset = (input.page - 1) * input.limit;
      const rows = await client.query<NotificationOpsRow>(
        `${notificationSelectSql()}
         ${listFilters.whereSql}
         ORDER BY ne.created_at DESC, ne.id DESC
         LIMIT $${listFilters.params.length + 1}
         OFFSET $${listFilters.params.length + 2}`,
        [...listFilters.params, input.limit, offset],
      );

      const summaryFilters = buildNotificationFilters(input, { includeStatuses: false, includeChannels: true });
      const statusSummary = await client.query<StatusCountRow>(
        `SELECT ne.status, COUNT(*) AS count
         ${notificationBaseFromSql()}
         ${summaryFilters.whereSql}
         GROUP BY ne.status
         ORDER BY ne.status ASC`,
        summaryFilters.params,
      );

      const channelFilters = buildNotificationFilters(input, { includeStatuses: true, includeChannels: false });
      const channelSummary = await client.query<ChannelCountRow>(
        `SELECT ne.channel, COUNT(*) AS count
         ${notificationBaseFromSql()}
         ${channelFilters.whereSql}
         GROUP BY ne.channel
         ORDER BY ne.channel ASC`,
        channelFilters.params,
      );

      return {
        items: rows.rows.map(mapNotificationOpsRow),
        total: rows.rows.length > 0 ? toSafeNonNegativeInteger(rows.rows[0].total_count ?? 0, "total_count") : 0,
        page: input.page,
        limit: input.limit,
        statuses: input.statuses,
        channels: input.channels ?? null,
        summary: statusSummary.rows.map(mapStatusCountRow),
        channelSummary: channelSummary.rows.map(mapChannelCountRow),
      };
    } finally {
      client.release();
    }
  }

  async prepareEmailRetry(
    input: Parameters<DropshipNotificationOpsRepository["prepareEmailRetry"]>[0],
  ): Promise<DropshipNotificationOpsPreparedRetry> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await loadNotificationEventForUpdate(client, input.notificationEventId);
      if (!existing) {
        throw new DropshipError(
          "DROPSHIP_NOTIFICATION_OPS_EVENT_NOT_FOUND",
          "Dropship notification event was not found.",
          { notificationEventId: input.notificationEventId },
        );
      }
      if (existing.channel !== "email" || existing.status !== "failed") {
        throw new DropshipError(
          "DROPSHIP_NOTIFICATION_OPS_STATUS_NOT_RETRYABLE",
          "Only failed email notification events can be retried.",
          {
            notificationEventId: existing.notificationEventId,
            channel: existing.channel,
            status: existing.status,
          },
        );
      }

      await client.query(
        `UPDATE dropship.dropship_notification_events
         SET status = 'pending',
             delivered_at = NULL
         WHERE id = $1
           AND vendor_id = $2
           AND channel = 'email'
           AND status = 'failed'`,
        [existing.notificationEventId, existing.vendor.vendorId],
      );
      const updated = requiredRow(
        await loadNotificationEventForUpdate(client, input.notificationEventId),
        "Dropship notification email retry update returned no row.",
      );
      await recordNotificationOpsAuditEvent(client, {
        event: updated,
        eventType: "notification_email_retry_requested",
        actor: input.actor,
        severity: "info",
        payload: {
          idempotencyKey: input.idempotencyKey,
          previousStatus: existing.status,
          reason: input.reason ?? null,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return {
        event: updated,
        previousStatus: existing.status,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateEmailRetryDelivery(
    input: Parameters<DropshipNotificationOpsRepository["updateEmailRetryDelivery"]>[0],
  ): Promise<DropshipNotificationOpsEventRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE dropship.dropship_notification_events
         SET status = $3,
             delivered_at = $4
         WHERE id = $1
           AND vendor_id = $2
           AND channel = 'email'`,
        [
          input.notificationEventId,
          input.vendorId,
          input.status,
          input.deliveredAt,
        ],
      );
      const updated = await loadNotificationEventForUpdate(client, input.notificationEventId);
      if (!updated || updated.vendor.vendorId !== input.vendorId || updated.channel !== "email") {
        throw new DropshipError(
          "DROPSHIP_NOTIFICATION_OPS_EVENT_NOT_FOUND",
          "Dropship notification email event was not found.",
          { vendorId: input.vendorId, notificationEventId: input.notificationEventId },
        );
      }
      await recordNotificationOpsAuditEvent(client, {
        event: updated,
        eventType: input.status === "delivered"
          ? "notification_email_retry_delivered"
          : "notification_email_retry_failed",
        actor: input.actor,
        severity: input.status === "delivered" ? "info" : "error",
        payload: {
          idempotencyKey: input.idempotencyKey,
          status: input.status,
          failureCode: input.failureCode,
          failureMessage: input.failureMessage,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

function notificationSelectSql(): string {
  return `${notificationSelectColumnsSql(true)}
  ` + notificationBaseFromSql();
}

function notificationActionSelectSql(): string {
  return `${notificationSelectColumnsSql(false)}
  ` + notificationBaseFromSql();
}

function notificationSelectColumnsSql(includeTotalCount: boolean): string {
  return `
    SELECT
      ne.id,
      ne.vendor_id,
      ne.event_type,
      ne.channel,
      ne.critical,
      ne.title,
      ne.message,
      ne.payload,
      ne.status,
      ne.delivered_at,
      ne.read_at,
      ne.idempotency_key,
      ne.request_hash,
      ne.created_at,
      v.member_id,
      v.business_name,
      v.email,
      v.status AS vendor_status,
      v.entitlement_status
      ${includeTotalCount ? ", COUNT(*) OVER() AS total_count" : ""}
  `;
}

function notificationBaseFromSql(): string {
  return `
    FROM dropship.dropship_notification_events ne
    INNER JOIN dropship.dropship_vendors v ON v.id = ne.vendor_id
  `;
}

function buildNotificationFilters(
  input: {
    statuses?: readonly DropshipNotificationOpsStatus[];
    channels?: readonly DropshipNotificationOpsChannel[];
    vendorId?: number;
    critical?: boolean;
    search?: string;
  },
  options: { includeStatuses: boolean; includeChannels: boolean },
): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.includeStatuses && input.statuses && input.statuses.length > 0) {
    params.push(input.statuses);
    clauses.push(`ne.status = ANY($${params.length}::text[])`);
  }
  if (options.includeChannels && input.channels && input.channels.length > 0) {
    params.push(input.channels);
    clauses.push(`ne.channel = ANY($${params.length}::text[])`);
  }
  if (input.vendorId) {
    params.push(input.vendorId);
    clauses.push(`ne.vendor_id = $${params.length}`);
  }
  if (typeof input.critical === "boolean") {
    params.push(input.critical);
    clauses.push(`ne.critical = $${params.length}`);
  }
  if (input.search) {
    params.push(`%${input.search.trim()}%`);
    clauses.push(`(
      ne.id::text ILIKE $${params.length}
      OR ne.event_type ILIKE $${params.length}
      OR ne.title ILIKE $${params.length}
      OR ne.message ILIKE $${params.length}
      OR ne.idempotency_key ILIKE $${params.length}
      OR ne.request_hash ILIKE $${params.length}
      OR v.business_name ILIKE $${params.length}
      OR v.email ILIKE $${params.length}
      OR v.member_id ILIKE $${params.length}
    )`);
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function mapNotificationOpsRow(row: NotificationOpsRow): DropshipNotificationOpsEventRecord {
  return {
    notificationEventId: row.id,
    vendor: {
      vendorId: row.vendor_id,
      memberId: row.member_id,
      businessName: row.business_name,
      email: row.email,
      status: row.vendor_status,
      entitlementStatus: row.entitlement_status,
    },
    eventType: row.event_type,
    channel: row.channel,
    critical: row.critical,
    title: row.title,
    message: row.message,
    payload: row.payload ?? {},
    status: row.status,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    createdAt: row.created_at,
  };
}

function mapStatusCountRow(row: StatusCountRow): DropshipNotificationOpsStatusSummary {
  return {
    status: row.status,
    count: toSafeNonNegativeInteger(row.count, "status_count"),
  };
}

function mapChannelCountRow(row: ChannelCountRow): DropshipNotificationOpsChannelSummary {
  return {
    channel: row.channel,
    count: toSafeNonNegativeInteger(row.count, "channel_count"),
  };
}

async function loadNotificationEventForUpdate(
  client: PoolClient,
  notificationEventId: number,
): Promise<DropshipNotificationOpsEventRecord | null> {
  const result = await client.query<NotificationOpsRow>(
    `${notificationActionSelectSql()}
     WHERE ne.id = $1
     LIMIT 1
     FOR UPDATE OF ne`,
    [notificationEventId],
  );
  return result.rows[0] ? mapNotificationOpsRow(result.rows[0]) : null;
}

async function recordNotificationOpsAuditEvent(
  client: PoolClient,
  input: {
    event: DropshipNotificationOpsEventRecord;
    eventType: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    severity: "info" | "warning" | "error";
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, 'dropship_notification_events', $2, $3,
             $4, $5, $6, $7::jsonb, $8)`,
    [
      input.event.vendor.vendorId,
      String(input.event.notificationEventId),
      input.eventType,
      input.actor.actorType,
      input.actor.actorId ?? null,
      input.severity,
      JSON.stringify(input.payload),
      input.occurredAt,
    ],
  );
}

function requiredRow<T>(row: T | null | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function toSafeNonNegativeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DropshipError(
      "DROPSHIP_NOTIFICATION_OPS_INTEGER_RANGE_ERROR",
      "Dropship notification ops integer value is outside the safe runtime range.",
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
