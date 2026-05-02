import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  DropshipNotificationChannel,
  DropshipNotificationEventRecord,
  DropshipNotificationListResult,
  DropshipNotificationPreferenceRecord,
  DropshipNotificationRepository,
  DropshipNotificationSendResult,
  DropshipNotificationVendorContact,
  RecordDropshipNotificationEventsRepositoryInput,
  UpsertDropshipNotificationPreferenceRepositoryInput,
} from "../application/dropship-notification-service";

interface NotificationEventRow {
  id: number;
  vendor_id: number;
  event_type: string;
  channel: DropshipNotificationChannel;
  critical: boolean;
  title: string;
  message: string | null;
  payload: Record<string, unknown> | null;
  status: DropshipNotificationEventRecord["status"];
  delivered_at: Date | null;
  read_at: Date | null;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: Date;
  total_count?: string | number;
}

interface NotificationPreferenceRow {
  id: number;
  vendor_id: number;
  event_type: string;
  critical: boolean;
  email_enabled: boolean;
  in_app_enabled: boolean;
  sms_enabled: boolean;
  webhook_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

interface VendorContactRow {
  id: number;
  email: string | null;
}

export class PgDropshipNotificationRepository implements DropshipNotificationRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async send(input: RecordDropshipNotificationEventsRepositoryInput): Promise<DropshipNotificationSendResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const replay = await listEventsByIdempotencyKey(client, input.vendorId, input.idempotencyKey, true);
      if (replay.length > 0) {
        assertNotificationReplayMatches(replay, input.requestHash);
        await client.query("COMMIT");
        return { events: replay, idempotentReplay: true };
      }

      const preference = await getPreferenceWithClient(client, input.vendorId, input.eventType, true);
      const channels = input.channels.filter((channel) => isNotificationChannelEnabled(channel, input.critical, preference));
      const events: DropshipNotificationEventRecord[] = [];
      for (const channel of channels) {
        events.push(await insertNotificationEvent(client, {
          vendorId: input.vendorId,
          eventType: input.eventType,
          channel,
          critical: input.critical,
          title: input.title,
          message: input.message ?? null,
          payload: input.payload,
          status: channel === "in_app" ? "delivered" : "pending",
          deliveredAt: channel === "in_app" ? input.now : null,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          createdAt: input.now,
        }));
      }

      await recordNotificationAuditEvent(client, {
        vendorId: input.vendorId,
        eventType: "notification_recorded",
        entityId: input.idempotencyKey,
        payload: {
          notificationEventType: input.eventType,
          channels: events.map((event) => event.channel),
          critical: input.critical,
          idempotencyKey: input.idempotencyKey,
        },
        createdAt: input.now,
      });
      await client.query("COMMIT");
      return { events, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        const replay = await this.findNotificationReplayAfterUniqueConflict(input);
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvents(input: Parameters<DropshipNotificationRepository["listEvents"]>[0]): Promise<DropshipNotificationListResult> {
    const offset = (input.page - 1) * input.limit;
    const result = await this.dbPool.query<NotificationEventRow>(
      `SELECT id, vendor_id, event_type, channel, critical, title, message, payload,
              status, delivered_at, read_at, idempotency_key, request_hash, created_at,
              COUNT(*) OVER() AS total_count
       FROM dropship.dropship_notification_events
       WHERE vendor_id = $1
         AND ($2::boolean = false OR read_at IS NULL)
       ORDER BY created_at DESC, id DESC
       LIMIT $3 OFFSET $4`,
      [input.vendorId, input.unreadOnly, input.limit, offset],
    );
    return {
      items: result.rows.map(mapNotificationEventRow),
      total: Number(result.rows[0]?.total_count ?? 0),
      page: input.page,
      limit: input.limit,
      unreadOnly: input.unreadOnly,
    };
  }

  async getVendorContact(vendorId: number): Promise<DropshipNotificationVendorContact> {
    const result = await this.dbPool.query<VendorContactRow>(
      `SELECT id, email
       FROM dropship.dropship_vendors
       WHERE id = $1
       LIMIT 1`,
      [vendorId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DropshipError(
        "DROPSHIP_VENDOR_NOT_FOUND",
        "Dropship vendor was not found.",
        { vendorId },
      );
    }
    return {
      vendorId: row.id,
      email: row.email,
    };
  }

  async updateEmailDelivery(input: Parameters<DropshipNotificationRepository["updateEmailDelivery"]>[0]): Promise<DropshipNotificationEventRecord> {
    const result = await this.dbPool.query<NotificationEventRow>(
      `UPDATE dropship.dropship_notification_events
       SET status = $3,
           delivered_at = $4
       WHERE id = $1
         AND vendor_id = $2
         AND channel = 'email'
       RETURNING id, vendor_id, event_type, channel, critical, title, message, payload,
                 status, delivered_at, read_at, idempotency_key, request_hash, created_at`,
      [input.notificationEventId, input.vendorId, input.status, input.deliveredAt],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DropshipError(
        "DROPSHIP_NOTIFICATION_NOT_FOUND",
        "Dropship notification email event was not found.",
        { vendorId: input.vendorId, notificationEventId: input.notificationEventId },
      );
    }
    return mapNotificationEventRow(row);
  }

  async markRead(input: Parameters<DropshipNotificationRepository["markRead"]>[0]): Promise<DropshipNotificationEventRecord> {
    const result = await this.dbPool.query<NotificationEventRow>(
      `UPDATE dropship.dropship_notification_events
       SET read_at = COALESCE(read_at, $3)
       WHERE id = $1
         AND vendor_id = $2
       RETURNING id, vendor_id, event_type, channel, critical, title, message, payload,
                 status, delivered_at, read_at, idempotency_key, request_hash, created_at`,
      [input.notificationEventId, input.vendorId, input.now],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DropshipError(
        "DROPSHIP_NOTIFICATION_NOT_FOUND",
        "Dropship notification event was not found.",
        { vendorId: input.vendorId, notificationEventId: input.notificationEventId },
      );
    }
    return mapNotificationEventRow(row);
  }

  async listPreferences(vendorId: number): Promise<DropshipNotificationPreferenceRecord[]> {
    const result = await this.dbPool.query<NotificationPreferenceRow>(
      `SELECT id, vendor_id, event_type, critical, email_enabled, in_app_enabled,
              sms_enabled, webhook_enabled, created_at, updated_at
       FROM dropship.dropship_notification_preferences
       WHERE vendor_id = $1
       ORDER BY event_type ASC`,
      [vendorId],
    );
    return result.rows.map(mapNotificationPreferenceRow);
  }

  async upsertPreference(
    input: UpsertDropshipNotificationPreferenceRepositoryInput,
  ): Promise<DropshipNotificationPreferenceRecord> {
    const result = await this.dbPool.query<NotificationPreferenceRow>(
      `INSERT INTO dropship.dropship_notification_preferences
        (vendor_id, event_type, critical, email_enabled, in_app_enabled,
         sms_enabled, webhook_enabled, created_at, updated_at)
       VALUES ($1, $2, COALESCE($3, false),
               CASE WHEN COALESCE($3, false) THEN true ELSE COALESCE($4, true) END,
               CASE WHEN COALESCE($3, false) THEN true ELSE COALESCE($5, true) END,
               COALESCE($6, false), COALESCE($7, false), $8, $8)
       ON CONFLICT (vendor_id, event_type) DO UPDATE
         SET critical = COALESCE($3, dropship.dropship_notification_preferences.critical),
             email_enabled = CASE
               WHEN COALESCE($3, dropship.dropship_notification_preferences.critical) THEN true
               ELSE COALESCE($4, dropship.dropship_notification_preferences.email_enabled)
             END,
             in_app_enabled = CASE
               WHEN COALESCE($3, dropship.dropship_notification_preferences.critical) THEN true
               ELSE COALESCE($5, dropship.dropship_notification_preferences.in_app_enabled)
             END,
             sms_enabled = COALESCE($6, dropship.dropship_notification_preferences.sms_enabled),
             webhook_enabled = COALESCE($7, dropship.dropship_notification_preferences.webhook_enabled),
             updated_at = $8
       RETURNING id, vendor_id, event_type, critical, email_enabled, in_app_enabled,
                 sms_enabled, webhook_enabled, created_at, updated_at`,
      [
        input.vendorId,
        input.eventType,
        input.critical ?? null,
        input.emailEnabled ?? null,
        input.inAppEnabled ?? null,
        input.smsEnabled ?? null,
        input.webhookEnabled ?? null,
        input.now,
      ],
    );
    return mapNotificationPreferenceRow(requiredRow(result.rows[0], "Dropship notification preference upsert returned no row."));
  }

  private async findNotificationReplayAfterUniqueConflict(
    input: RecordDropshipNotificationEventsRepositoryInput,
  ): Promise<DropshipNotificationSendResult | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const replay = await listEventsByIdempotencyKey(client, input.vendorId, input.idempotencyKey, true);
      if (replay.length === 0) {
        await client.query("COMMIT");
        return null;
      }
      assertNotificationReplayMatches(replay, input.requestHash);
      await client.query("COMMIT");
      return { events: replay, idempotentReplay: true };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function listEventsByIdempotencyKey(
  client: PoolClient,
  vendorId: number,
  idempotencyKey: string,
  forUpdate: boolean,
): Promise<DropshipNotificationEventRecord[]> {
  const result = await client.query<NotificationEventRow>(
    `SELECT id, vendor_id, event_type, channel, critical, title, message, payload,
            status, delivered_at, read_at, idempotency_key, request_hash, created_at
     FROM dropship.dropship_notification_events
     WHERE vendor_id = $1
       AND idempotency_key = $2
     ORDER BY channel ASC, id ASC
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [vendorId, idempotencyKey],
  );
  return result.rows.map(mapNotificationEventRow);
}

async function getPreferenceWithClient(
  client: PoolClient,
  vendorId: number,
  eventType: string,
  forUpdate: boolean,
): Promise<DropshipNotificationPreferenceRecord | null> {
  const result = await client.query<NotificationPreferenceRow>(
    `SELECT id, vendor_id, event_type, critical, email_enabled, in_app_enabled,
            sms_enabled, webhook_enabled, created_at, updated_at
     FROM dropship.dropship_notification_preferences
     WHERE vendor_id = $1
       AND event_type = $2
     LIMIT 1
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [vendorId, eventType],
  );
  return result.rows[0] ? mapNotificationPreferenceRow(result.rows[0]) : null;
}

async function insertNotificationEvent(
  client: PoolClient,
  input: {
    vendorId: number;
    eventType: string;
    channel: DropshipNotificationChannel;
    critical: boolean;
    title: string;
    message: string | null;
    payload: Record<string, unknown>;
    status: DropshipNotificationEventRecord["status"];
    deliveredAt: Date | null;
    idempotencyKey: string;
    requestHash: string;
    createdAt: Date;
  },
): Promise<DropshipNotificationEventRecord> {
  const result = await client.query<NotificationEventRow>(
    `INSERT INTO dropship.dropship_notification_events
      (vendor_id, event_type, channel, critical, title, message, payload,
       status, delivered_at, idempotency_key, request_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
     RETURNING id, vendor_id, event_type, channel, critical, title, message, payload,
               status, delivered_at, read_at, idempotency_key, request_hash, created_at`,
    [
      input.vendorId,
      input.eventType,
      input.channel,
      input.critical,
      input.title,
      input.message,
      JSON.stringify(input.payload),
      input.status,
      input.deliveredAt,
      input.idempotencyKey,
      input.requestHash,
      input.createdAt,
    ],
  );
  return mapNotificationEventRow(requiredRow(result.rows[0], "Dropship notification insert returned no row."));
}

async function recordNotificationAuditEvent(
  client: PoolClient,
  input: {
    vendorId: number;
    eventType: string;
    entityId: string;
    payload: Record<string, unknown>;
    createdAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, 'dropship_notification_events', $2, $3,
             'system', NULL, 'info', $4::jsonb, $5)`,
    [
      input.vendorId,
      input.entityId,
      input.eventType,
      JSON.stringify(input.payload),
      input.createdAt,
    ],
  );
}

function isNotificationChannelEnabled(
  channel: DropshipNotificationChannel,
  critical: boolean,
  preference: DropshipNotificationPreferenceRecord | null,
): boolean {
  if (critical) return true;
  if (!preference) return true;
  if (channel === "email") return preference.emailEnabled;
  return preference.inAppEnabled;
}

function assertNotificationReplayMatches(events: DropshipNotificationEventRecord[], requestHash: string): void {
  const mismatch = events.find((event) => event.requestHash !== requestHash);
  if (mismatch) {
    throw new DropshipError(
      "DROPSHIP_NOTIFICATION_IDEMPOTENCY_CONFLICT",
      "Dropship notification idempotency key was reused with a different request.",
      { notificationEventId: mismatch.notificationEventId },
    );
  }
}

function mapNotificationEventRow(row: NotificationEventRow): DropshipNotificationEventRecord {
  return {
    notificationEventId: row.id,
    vendorId: row.vendor_id,
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

function mapNotificationPreferenceRow(row: NotificationPreferenceRow): DropshipNotificationPreferenceRecord {
  return {
    notificationPreferenceId: row.id,
    vendorId: row.vendor_id,
    eventType: row.event_type,
    critical: row.critical,
    emailEnabled: row.email_enabled,
    inAppEnabled: row.in_app_enabled,
    smsEnabled: row.sms_enabled,
    webhookEnabled: row.webhook_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original query error is more useful to the caller.
  }
}
