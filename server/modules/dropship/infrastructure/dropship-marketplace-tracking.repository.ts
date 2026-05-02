import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  DropshipMarketplaceTrackingClaim,
  DropshipMarketplaceTrackingPushRecord,
  DropshipMarketplaceTrackingRepository,
} from "../application/dropship-marketplace-tracking-service";
import type {
  DropshipMarketplaceTrackingLineItem,
  DropshipMarketplaceTrackingRequest,
  DropshipMarketplaceTrackingResult,
} from "../application/dropship-marketplace-tracking-provider";

interface TrackingPushRow {
  id: number;
  intake_id: number;
  oms_order_id: string | number;
  vendor_id: number;
  store_connection_id: number;
  platform: DropshipMarketplaceTrackingRequest["platform"];
  external_order_id: string;
  external_order_number: string | null;
  source_order_id: string | null;
  status: string;
  idempotency_key: string;
  request_hash: string;
  carrier: string;
  tracking_number: string;
  shipped_at: Date;
  external_fulfillment_id: string | null;
  attempt_count: number;
}

interface IntakeRow {
  id: number;
  oms_order_id: string | number;
  vendor_id: number;
  store_connection_id: number;
  platform: DropshipMarketplaceTrackingRequest["platform"];
  external_order_id: string;
  external_order_number: string | null;
  source_order_id: string | null;
}

interface LineItemRow {
  external_line_item_id: string | null;
  quantity: number;
}

export class PgDropshipMarketplaceTrackingRepository implements DropshipMarketplaceTrackingRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async claimForOmsOrder(input: {
    omsOrderId: number;
    carrier: string;
    trackingNumber: string;
    shippedAt: Date;
    idempotencyKey: string;
    now: Date;
  }): Promise<DropshipMarketplaceTrackingClaim> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const intake = await loadIntakeForOmsOrder(client, input.omsOrderId);
      if (!intake) {
        await client.query("COMMIT");
        return { status: "not_dropship" };
      }

      const lineItems = await loadLineItemsForOmsOrder(client, input.omsOrderId);
      const request = buildTrackingRequest({ input, intake, lineItems });
      const requestHash = hashRequest(request);
      const row = await insertOrLoadPush(client, request, requestHash, input.now);
      if (row.request_hash !== requestHash) {
        throw new DropshipError(
          "DROPSHIP_TRACKING_IDEMPOTENCY_CONFLICT",
          "Tracking push idempotency key was reused with a different request.",
          {
            pushId: row.id,
            intakeId: row.intake_id,
            idempotencyKey: input.idempotencyKey,
            retryable: false,
          },
        );
      }
      if (row.status === "succeeded") {
        await client.query("COMMIT");
        return { status: "already_succeeded", push: mapPushRow(row) };
      }

      const claimed = await markPushProcessing(client, row.id, input.now);
      await recordAuditEvent(client, {
        vendorId: claimed.vendor_id,
        storeConnectionId: claimed.store_connection_id,
        entityType: "dropship_marketplace_tracking_push",
        entityId: String(claimed.id),
        eventType: "tracking_push_claimed",
        severity: "info",
        payload: {
          intakeId: claimed.intake_id,
          omsOrderId: toSafeInteger(claimed.oms_order_id, "oms_order_id"),
          platform: claimed.platform,
          externalOrderId: claimed.external_order_id,
          attemptCount: claimed.attempt_count,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return {
        status: "claimed",
        push: mapPushRow(claimed),
        request,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completePush(input: {
    pushId: number;
    result: DropshipMarketplaceTrackingResult;
    now: Date;
  }): Promise<DropshipMarketplaceTrackingPushRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<TrackingPushRow>(
        `UPDATE dropship.dropship_marketplace_tracking_pushes
         SET status = 'succeeded',
             external_fulfillment_id = $2,
             raw_result = $3::jsonb,
             last_error_code = NULL,
             last_error_message = NULL,
             completed_at = $4,
             updated_at = $4
         WHERE id = $1
         RETURNING id, intake_id, oms_order_id, vendor_id, store_connection_id, platform,
                   external_order_id, external_order_number, source_order_id, status,
                   idempotency_key, request_hash, carrier, tracking_number, shipped_at,
                   external_fulfillment_id, attempt_count`,
        [
          input.pushId,
          input.result.externalFulfillmentId,
          JSON.stringify(input.result.rawResult),
          input.now,
        ],
      );
      const row = requiredRow(updated.rows[0], "Tracking push completion did not return a row.");
      await recordAuditEvent(client, {
        vendorId: row.vendor_id,
        storeConnectionId: row.store_connection_id,
        entityType: "dropship_marketplace_tracking_push",
        entityId: String(row.id),
        eventType: "tracking_push_succeeded",
        severity: "info",
        payload: {
          intakeId: row.intake_id,
          externalFulfillmentId: row.external_fulfillment_id,
          attemptCount: row.attempt_count,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return mapPushRow(row);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async failPush(input: {
    pushId: number;
    code: string;
    message: string;
    retryable: boolean;
    now: Date;
  }): Promise<DropshipMarketplaceTrackingPushRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<TrackingPushRow>(
        `UPDATE dropship.dropship_marketplace_tracking_pushes
         SET status = 'failed',
             last_error_code = $2,
             last_error_message = $3,
             raw_result = COALESCE(raw_result, '{}'::jsonb) || $4::jsonb,
             updated_at = $5
         WHERE id = $1
         RETURNING id, intake_id, oms_order_id, vendor_id, store_connection_id, platform,
                   external_order_id, external_order_number, source_order_id, status,
                   idempotency_key, request_hash, carrier, tracking_number, shipped_at,
                   external_fulfillment_id, attempt_count`,
        [
          input.pushId,
          input.code,
          input.message,
          JSON.stringify({ lastFailure: { retryable: input.retryable, failedAt: input.now.toISOString() } }),
          input.now,
        ],
      );
      const row = requiredRow(updated.rows[0], "Tracking push failure update did not return a row.");
      await recordAuditEvent(client, {
        vendorId: row.vendor_id,
        storeConnectionId: row.store_connection_id,
        entityType: "dropship_marketplace_tracking_push",
        entityId: String(row.id),
        eventType: "tracking_push_failed",
        severity: input.retryable ? "warning" : "error",
        payload: {
          intakeId: row.intake_id,
          code: input.code,
          message: input.message,
          retryable: input.retryable,
          attemptCount: row.attempt_count,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return mapPushRow(row);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function loadIntakeForOmsOrder(
  client: PoolClient,
  omsOrderId: number,
): Promise<IntakeRow | null> {
  const result = await client.query<IntakeRow>(
    `SELECT id, oms_order_id, vendor_id, store_connection_id, platform,
            external_order_id, external_order_number, source_order_id
     FROM dropship.dropship_order_intake
     WHERE oms_order_id = $1
     LIMIT 1`,
    [omsOrderId],
  );
  return result.rows[0] ?? null;
}

async function loadLineItemsForOmsOrder(
  client: PoolClient,
  omsOrderId: number,
): Promise<DropshipMarketplaceTrackingLineItem[]> {
  const result = await client.query<LineItemRow>(
    `SELECT external_line_item_id, quantity
     FROM oms.oms_order_lines
     WHERE order_id = $1
     ORDER BY id ASC`,
    [omsOrderId],
  );
  return result.rows.map((row) => ({
    externalLineItemId: row.external_line_item_id,
    quantity: Number(row.quantity),
  }));
}

function buildTrackingRequest(input: {
  input: {
    omsOrderId: number;
    carrier: string;
    trackingNumber: string;
    shippedAt: Date;
    idempotencyKey: string;
  };
  intake: IntakeRow;
  lineItems: DropshipMarketplaceTrackingLineItem[];
}): DropshipMarketplaceTrackingRequest {
  return {
    intakeId: input.intake.id,
    omsOrderId: input.input.omsOrderId,
    vendorId: input.intake.vendor_id,
    storeConnectionId: input.intake.store_connection_id,
    platform: input.intake.platform,
    externalOrderId: input.intake.external_order_id,
    externalOrderNumber: input.intake.external_order_number,
    sourceOrderId: input.intake.source_order_id,
    carrier: input.input.carrier,
    trackingNumber: input.input.trackingNumber,
    shippedAt: input.input.shippedAt,
    lineItems: input.lineItems,
    idempotencyKey: input.input.idempotencyKey,
  };
}

async function insertOrLoadPush(
  client: PoolClient,
  request: DropshipMarketplaceTrackingRequest,
  requestHash: string,
  now: Date,
): Promise<TrackingPushRow> {
  const inserted = await client.query<TrackingPushRow>(
    `INSERT INTO dropship.dropship_marketplace_tracking_pushes
      (intake_id, oms_order_id, vendor_id, store_connection_id, platform,
       external_order_id, external_order_number, source_order_id, status,
       idempotency_key, request_hash, carrier, tracking_number, shipped_at,
       created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5,
       $6, $7, $8, 'queued',
       $9, $10, $11, $12, $13,
       $14, $14)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, intake_id, oms_order_id, vendor_id, store_connection_id, platform,
               external_order_id, external_order_number, source_order_id, status,
               idempotency_key, request_hash, carrier, tracking_number, shipped_at,
               external_fulfillment_id, attempt_count`,
    [
      request.intakeId,
      request.omsOrderId,
      request.vendorId,
      request.storeConnectionId,
      request.platform,
      request.externalOrderId,
      request.externalOrderNumber,
      request.sourceOrderId,
      request.idempotencyKey,
      requestHash,
      request.carrier,
      request.trackingNumber,
      request.shippedAt,
      now,
    ],
  );
  if (inserted.rows[0]) {
    return inserted.rows[0];
  }
  const existing = await client.query<TrackingPushRow>(
    `SELECT id, intake_id, oms_order_id, vendor_id, store_connection_id, platform,
            external_order_id, external_order_number, source_order_id, status,
            idempotency_key, request_hash, carrier, tracking_number, shipped_at,
            external_fulfillment_id, attempt_count
     FROM dropship.dropship_marketplace_tracking_pushes
     WHERE idempotency_key = $1
     FOR UPDATE`,
    [request.idempotencyKey],
  );
  return requiredRow(existing.rows[0], "Tracking push idempotency row could not be reloaded.");
}

async function markPushProcessing(
  client: PoolClient,
  pushId: number,
  now: Date,
): Promise<TrackingPushRow> {
  const result = await client.query<TrackingPushRow>(
    `UPDATE dropship.dropship_marketplace_tracking_pushes
     SET status = 'processing',
         attempt_count = attempt_count + 1,
         last_error_code = NULL,
         last_error_message = NULL,
         updated_at = $2
     WHERE id = $1
     RETURNING id, intake_id, oms_order_id, vendor_id, store_connection_id, platform,
               external_order_id, external_order_number, source_order_id, status,
               idempotency_key, request_hash, carrier, tracking_number, shipped_at,
               external_fulfillment_id, attempt_count`,
    [pushId, now],
  );
  return requiredRow(result.rows[0], "Tracking push claim did not return a row.");
}

async function recordAuditEvent(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    entityType: string;
    entityId: string;
    eventType: string;
    severity: "info" | "warning" | "error";
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, $3, $4, $5,
             'system', NULL, $6, $7::jsonb, $8)`,
    [
      input.vendorId,
      input.storeConnectionId,
      input.entityType,
      input.entityId,
      input.eventType,
      input.severity,
      JSON.stringify(input.payload),
      input.occurredAt,
    ],
  );
}

function mapPushRow(row: TrackingPushRow): DropshipMarketplaceTrackingPushRecord {
  return {
    pushId: row.id,
    intakeId: row.intake_id,
    omsOrderId: toSafeInteger(row.oms_order_id, "oms_order_id"),
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    status: row.status,
    externalOrderId: row.external_order_id,
    trackingNumber: row.tracking_number,
    carrier: row.carrier,
    attemptCount: row.attempt_count,
    externalFulfillmentId: row.external_fulfillment_id,
  };
}

function hashRequest(request: DropshipMarketplaceTrackingRequest): string {
  return createHash("sha256")
    .update(JSON.stringify({
      intakeId: request.intakeId,
      omsOrderId: request.omsOrderId,
      storeConnectionId: request.storeConnectionId,
      platform: request.platform,
      externalOrderId: request.externalOrderId,
      carrier: request.carrier,
      trackingNumber: request.trackingNumber,
      shippedAt: request.shippedAt.toISOString(),
      lineItems: request.lineItems,
    }))
    .digest("hex");
}

function toSafeInteger(value: string | number, field: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new DropshipError("DROPSHIP_TRACKING_INVALID_INTEGER", "Tracking push row contains an invalid integer.", {
      field,
      value,
      retryable: false,
    });
  }
  return numeric;
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
