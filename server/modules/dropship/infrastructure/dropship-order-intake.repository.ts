import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type { DropshipSourcePlatform } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import type {
  DropshipOrderIntakeRecord,
  DropshipOrderIntakeRepository,
  DropshipOrderIntakeRepositoryInput,
  DropshipOrderIntakeRepositoryResult,
  DropshipOrderIntakeStatus,
  DropshipOrderIntakeStoreContext,
  NormalizedDropshipOrderPayload,
} from "../application/dropship-order-intake-service";

interface StoreContextRow {
  vendor_id: number;
  vendor_status: string;
  entitlement_status: string;
  store_connection_id: number;
  store_status: string;
  platform: DropshipSourcePlatform;
}

interface OrderIntakeRow {
  id: number;
  channel_id: number;
  vendor_id: number;
  store_connection_id: number;
  platform: DropshipSourcePlatform;
  external_order_id: string;
  external_order_number: string | null;
  source_order_id: string | null;
  status: DropshipOrderIntakeStatus;
  payment_hold_expires_at: Date | null;
  rejection_reason: string | null;
  cancellation_status: string | null;
  raw_payload: Record<string, unknown> | null;
  normalized_payload: NormalizedDropshipOrderPayload | null;
  payload_hash: string | null;
  oms_order_id: string | number | null;
  received_at: Date;
  accepted_at: Date | null;
  updated_at: Date;
}

interface ChannelRow {
  id: number;
  status: string;
}

const IMMUTABLE_INTAKE_STATUSES: readonly DropshipOrderIntakeStatus[] = [
  "accepted",
  "cancelled",
  "rejected",
];

export class PgDropshipOrderIntakeRepository implements DropshipOrderIntakeRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async loadStoreContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipOrderIntakeStoreContext | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<StoreContextRow>(
        `SELECT
           v.id AS vendor_id,
           v.status AS vendor_status,
           v.entitlement_status,
           sc.id AS store_connection_id,
           sc.status AS store_status,
           sc.platform
         FROM dropship.dropship_vendors v
         INNER JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
         WHERE v.id = $1
           AND sc.id = $2
         LIMIT 1`,
        [input.vendorId, input.storeConnectionId],
      );
      return mapStoreContextRow(result.rows[0]);
    } finally {
      client.release();
    }
  }

  async recordMarketplaceIntake(
    input: DropshipOrderIntakeRepositoryInput,
  ): Promise<DropshipOrderIntakeRepositoryResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await recordMarketplaceIntakeWithClient(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        return this.resolveUniqueConflictReplay(input);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async resolveUniqueConflictReplay(
    input: DropshipOrderIntakeRepositoryInput,
  ): Promise<DropshipOrderIntakeRepositoryResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await findExistingIntakeWithClient(client, input, true);
      if (!existing) {
        throw new DropshipError(
          "DROPSHIP_ORDER_INTAKE_CONCURRENT_WRITE_FAILED",
          "Dropship order intake concurrent write could not be resolved.",
          { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId },
        );
      }
      assertExistingIntakeCanReplay(existing, input);
      await client.query("COMMIT");
      return { intake: existing, action: "replayed" };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function recordMarketplaceIntakeWithClient(
  client: PoolClient,
  input: DropshipOrderIntakeRepositoryInput,
): Promise<DropshipOrderIntakeRepositoryResult> {
  const channelId = await resolveDropshipOmsChannelIdWithClient(client);
  const existing = await findExistingIntakeWithClient(client, input, true);
  if (existing) {
    if (existing.payloadHash === input.payloadHash) {
      await recordOrderIntakeAuditEvent(client, {
        input,
        intake: existing,
        eventType: "order_intake_replayed",
        createdAt: input.receivedAt,
      });
      return { intake: existing, action: "replayed" };
    }
    if (IMMUTABLE_INTAKE_STATUSES.includes(existing.status)) {
      throw new DropshipError(
        "DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE",
        "Dropship order intake payload changed after the intake became immutable.",
        {
          intakeId: existing.intakeId,
          status: existing.status,
          externalOrderId: input.externalOrderId,
          storeConnectionId: input.storeConnectionId,
        },
      );
    }
    const updated = await updateExistingIntakeWithClient(client, {
      input,
      existing,
      channelId,
    });
    await recordOrderIntakeAuditEvent(client, {
      input,
      intake: updated,
      eventType: updated.status === "rejected" ? "order_intake_rejected" : "order_intake_payload_updated",
      createdAt: input.receivedAt,
    });
    return { intake: updated, action: "updated" };
  }

  const inserted = await insertOrderIntakeWithClient(client, {
    input,
    channelId,
  });
  await recordOrderIntakeAuditEvent(client, {
    input,
    intake: inserted,
    eventType: inserted.status === "rejected" ? "order_intake_rejected" : "order_intake_recorded",
    createdAt: input.receivedAt,
  });
  return { intake: inserted, action: "created" };
}

async function findExistingIntakeWithClient(
  client: PoolClient,
  input: {
    storeConnectionId: number;
    externalOrderId: string;
  },
  forUpdate: boolean,
): Promise<DropshipOrderIntakeRecord | null> {
  const result = await client.query<OrderIntakeRow>(
    `SELECT id, channel_id, vendor_id, store_connection_id, platform,
            external_order_id, external_order_number, source_order_id, status,
            payment_hold_expires_at, rejection_reason, cancellation_status,
            raw_payload, normalized_payload, payload_hash, oms_order_id,
            received_at, accepted_at, updated_at
     FROM dropship.dropship_order_intake
     WHERE store_connection_id = $1
       AND external_order_id = $2
     LIMIT 1
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [input.storeConnectionId, input.externalOrderId],
  );
  return result.rows[0] ? mapOrderIntakeRow(result.rows[0]) : null;
}

async function insertOrderIntakeWithClient(
  client: PoolClient,
  input: {
    input: DropshipOrderIntakeRepositoryInput;
    channelId: number;
  },
): Promise<DropshipOrderIntakeRecord> {
  const result = await client.query<OrderIntakeRow>(
    `INSERT INTO dropship.dropship_order_intake
      (channel_id, vendor_id, store_connection_id, platform,
       external_order_id, external_order_number, source_order_id, status,
       rejection_reason, cancellation_status, raw_payload, normalized_payload, payload_hash,
       received_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, $11::jsonb, $12::jsonb, $13, $14, $14)
     RETURNING id, channel_id, vendor_id, store_connection_id, platform,
               external_order_id, external_order_number, source_order_id, status,
               payment_hold_expires_at, rejection_reason, cancellation_status,
               raw_payload, normalized_payload, payload_hash, oms_order_id,
               received_at, accepted_at, updated_at`,
    [
      input.channelId,
      input.input.vendorId,
      input.input.storeConnectionId,
      input.input.platform,
      input.input.externalOrderId,
      input.input.externalOrderNumber ?? null,
      input.input.sourceOrderId ?? null,
      input.input.status,
      input.input.rejectionReason,
      input.input.cancellationStatus,
      JSON.stringify(input.input.rawPayload),
      JSON.stringify(input.input.normalizedPayload),
      input.input.payloadHash,
      input.input.receivedAt,
    ],
  );
  return mapOrderIntakeRow(requiredRow(
    result.rows[0],
    "Dropship order intake insert did not return a row.",
  ));
}

async function updateExistingIntakeWithClient(
  client: PoolClient,
  input: {
    input: DropshipOrderIntakeRepositoryInput;
    existing: DropshipOrderIntakeRecord;
    channelId: number;
  },
): Promise<DropshipOrderIntakeRecord> {
  const result = await client.query<OrderIntakeRow>(
    `UPDATE dropship.dropship_order_intake
     SET channel_id = $2,
         platform = $3,
         external_order_number = $4,
         source_order_id = $5,
         status = $6,
         rejection_reason = $7,
         cancellation_status = $8,
         raw_payload = $9::jsonb,
         normalized_payload = $10::jsonb,
         payload_hash = $11,
         updated_at = $12
     WHERE id = $1
     RETURNING id, channel_id, vendor_id, store_connection_id, platform,
               external_order_id, external_order_number, source_order_id, status,
               payment_hold_expires_at, rejection_reason, cancellation_status,
               raw_payload, normalized_payload, payload_hash, oms_order_id,
               received_at, accepted_at, updated_at`,
    [
      input.existing.intakeId,
      input.channelId,
      input.input.platform,
      input.input.externalOrderNumber ?? input.existing.externalOrderNumber,
      input.input.sourceOrderId ?? input.existing.sourceOrderId,
      input.input.status,
      input.input.rejectionReason,
      input.input.cancellationStatus,
      JSON.stringify(input.input.rawPayload),
      JSON.stringify(input.input.normalizedPayload),
      input.input.payloadHash,
      input.input.receivedAt,
    ],
  );
  return mapOrderIntakeRow(requiredRow(
    result.rows[0],
    "Dropship order intake update did not return a row.",
  ));
}

export async function resolveDropshipOmsChannelIdWithClient(client: PoolClient): Promise<number> {
  const configuredId = parseOptionalPositiveIntegerEnv(
    "DROPSHIP_OMS_CHANNEL_ID",
    process.env.DROPSHIP_OMS_CHANNEL_ID,
  );
  if (configuredId) {
    const result = await client.query<ChannelRow>(
      `SELECT id, status
       FROM channels.channels
       WHERE id = $1
       LIMIT 1`,
      [configuredId],
    );
    const channel = result.rows[0];
    if (!channel) {
      throw new DropshipError(
        "DROPSHIP_OMS_CHANNEL_NOT_FOUND",
        "Configured Dropship OMS channel does not exist.",
        { channelId: configuredId },
      );
    }
    if (channel.status !== "active") {
      throw new DropshipError(
        "DROPSHIP_OMS_CHANNEL_NOT_ACTIVE",
        "Configured Dropship OMS channel is not active.",
        { channelId: configuredId, status: channel.status },
      );
    }
    return channel.id;
  }

  const result = await client.query<ChannelRow>(
    `SELECT c.id, c.status
     FROM channels.channels c
     WHERE c.status = 'active'
       AND (
         LOWER(COALESCE(c.shipping_config #>> '{dropship,role}', '')) = 'oms'
         OR COALESCE(c.shipping_config #>> '{dropship,omsChannel}', 'false') = 'true'
         OR EXISTS (
           SELECT 1
           FROM channels.channel_connections cc
           WHERE cc.channel_id = c.id
             AND (
               LOWER(COALESCE(cc.metadata #>> '{dropship,role}', '')) = 'oms'
               OR COALESCE(cc.metadata #>> '{features,dropshipOms}', 'false') = 'true'
               OR COALESCE(cc.metadata #>> '{features,dropship_oms}', 'false') = 'true'
             )
         )
       )
     ORDER BY c.priority DESC, c.id ASC
     LIMIT 2`,
  );
  if (result.rows.length > 1) {
    throw new DropshipError(
      "DROPSHIP_OMS_CHANNEL_CONFIG_AMBIGUOUS",
      "More than one active Dropship OMS channel is configured.",
      {
        channelIds: result.rows.map((row) => row.id),
        envChannelId: "DROPSHIP_OMS_CHANNEL_ID",
      },
    );
  }
  const channel = result.rows[0];
  if (!channel) {
    throw new DropshipError(
      "DROPSHIP_OMS_CHANNEL_CONFIG_REQUIRED",
      "Dropship OMS channel must be explicitly configured before recording order intake.",
      {
        envChannelId: "DROPSHIP_OMS_CHANNEL_ID",
        channelShippingConfig: { dropship: { role: "oms" } },
        channelConnectionMetadata: { features: { dropshipOms: true } },
      },
    );
  }
  return channel.id;
}

async function recordOrderIntakeAuditEvent(
  client: PoolClient,
  input: {
    input: DropshipOrderIntakeRepositoryInput;
    intake: DropshipOrderIntakeRecord;
    eventType: string;
    createdAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_order_intake', $3, $4,
             'system', NULL, $5, $6::jsonb, $7)`,
    [
      input.intake.vendorId,
      input.intake.storeConnectionId,
      String(input.intake.intakeId),
      input.eventType,
      input.intake.status === "rejected" ? "warning" : "info",
      JSON.stringify({
        idempotencyKey: input.input.idempotencyKey,
        payloadHash: input.input.payloadHash,
        platform: input.intake.platform,
        externalOrderId: input.intake.externalOrderId,
        externalOrderNumber: input.intake.externalOrderNumber,
        status: input.intake.status,
        rejectionReason: input.intake.rejectionReason,
      }),
      input.createdAt,
    ],
  );
}

function assertExistingIntakeCanReplay(
  existing: DropshipOrderIntakeRecord,
  input: DropshipOrderIntakeRepositoryInput,
): void {
  if (existing.payloadHash !== input.payloadHash) {
    throw new DropshipError(
      "DROPSHIP_ORDER_INTAKE_IDEMPOTENCY_CONFLICT",
      "Dropship order intake idempotency coordinates were reused with a different payload.",
      {
        intakeId: existing.intakeId,
        storeConnectionId: input.storeConnectionId,
        externalOrderId: input.externalOrderId,
      },
    );
  }
}

function mapStoreContextRow(row: StoreContextRow | undefined): DropshipOrderIntakeStoreContext | null {
  if (!row) return null;
  return {
    vendorId: row.vendor_id,
    vendorStatus: row.vendor_status,
    entitlementStatus: row.entitlement_status,
    storeConnectionId: row.store_connection_id,
    storeStatus: row.store_status,
    platform: row.platform,
  };
}

function mapOrderIntakeRow(row: OrderIntakeRow): DropshipOrderIntakeRecord {
  return {
    intakeId: row.id,
    channelId: row.channel_id,
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    externalOrderId: row.external_order_id,
    externalOrderNumber: row.external_order_number,
    sourceOrderId: row.source_order_id,
    status: row.status,
    paymentHoldExpiresAt: row.payment_hold_expires_at,
    rejectionReason: row.rejection_reason,
    cancellationStatus: row.cancellation_status,
    rawPayload: row.raw_payload ?? {},
    normalizedPayload: requiredPayload(row.normalized_payload, row.id),
    payloadHash: row.payload_hash ?? "",
    omsOrderId: row.oms_order_id === null ? null : Number(row.oms_order_id),
    receivedAt: row.received_at,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
  };
}

function requiredPayload(
  payload: NormalizedDropshipOrderPayload | null,
  intakeId: number,
): NormalizedDropshipOrderPayload {
  if (!payload) {
    throw new DropshipError(
      "DROPSHIP_ORDER_INTAKE_PAYLOAD_REQUIRED",
      "Dropship order intake row is missing normalized payload.",
      { intakeId },
    );
  }
  return payload;
}

function parseOptionalPositiveIntegerEnv(name: string, value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  throw new DropshipError(
    "DROPSHIP_OMS_CHANNEL_ID_INVALID",
    "Dropship OMS channel id configuration must be a positive integer.",
    { env: name, value },
  );
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
