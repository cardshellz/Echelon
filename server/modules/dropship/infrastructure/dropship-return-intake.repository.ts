import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipReturnIntakeOrderReference,
  DropshipReturnIntakeRepository,
  DropshipReturnIntakeResolvedPolicy,
} from "../application/dropship-return-intake-service";
import type { DropshipReturnIntakeDraft } from "../application/dropship-return-intake-provider";
import type { DropshipReturnIntakeStoreConnection } from "../application/dropship-return-intake-provider";
import type { DropshipReturnIntakePollRepository } from "../application/dropship-return-intake-poll-service";
import type { DropshipReturnTrackingRepository } from "./dropship-return-tracking.provider";

/**
 * PG repository for channel return intake (stack 4/4). Covers both the poll
 * repository port (store listing + watermark) and the intake repository port
 * (order lookup, dedupe, RMA insert, exception queue).
 *
 * Write discipline (coding standards #7): the RMA + items insert runs in one
 * transaction; the (store_connection_id, channel_return_id) unique index is
 * the concurrency guard — a unique violation maps to { created: false } and
 * the service re-reads the winner. Exception-queue upserts are idempotent per
 * open (store, channel return) pair.
 */

interface StoreConnectionRow {
  id: number;
  vendor_id: number;
  last_return_sync_at: Date | null;
}

interface IntakeOrderRow {
  id: number;
  store_connection_id: number;
  vendor_id: number;
  oms_order_id: number | null;
  normalized_payload: unknown;
}

interface RmaRow {
  id: number;
  rma_number: string;
}

interface PolicyRow {
  id: number;
  return_window_days: number;
}

export class PgDropshipReturnIntakeRepository
  implements DropshipReturnIntakeRepository, DropshipReturnIntakePollRepository, DropshipReturnTrackingRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  // ---- Return-tracking repository port (PR 3 watcher wiring) ------------

  async findChannelReturnForTracking(input: {
    storeConnectionId: number;
    trackingNumber: string;
  }): Promise<{ platform: string; channel_return_id: string | null } | null> {
    const result = await this.dbPool.query<{
      platform: string;
      channel_return_id: string | null;
    }>(
      `SELECT sc.platform, r.channel_return_id
       FROM dropship.dropship_rmas r
       JOIN dropship.dropship_store_connections sc ON sc.id = r.store_connection_id
       WHERE r.store_connection_id = $1
         AND r.return_tracking_number = $2
       ORDER BY r.id DESC
       LIMIT 1`,
      [input.storeConnectionId, input.trackingNumber],
    );
    return result.rows[0] ?? null;
  }

  // ---- Poll repository port --------------------------------------------

  async listPollableStoreConnections(input: {
    platform: "ebay" | "shopify";
    limit: number;
  }): Promise<DropshipReturnIntakeStoreConnection[]> {
    const result = await this.dbPool.query<StoreConnectionRow>(
      `SELECT id, vendor_id, last_return_sync_at
       FROM dropship.dropship_store_connections
       WHERE platform = $1
         AND status = 'connected'
         AND setup_status = 'ready'
         AND access_token_ref IS NOT NULL
       ORDER BY last_return_sync_at ASC NULLS FIRST, id ASC
       LIMIT $2`,
      [input.platform, input.limit],
    );
    return result.rows.map((row) => ({
      vendorId: row.vendor_id,
      storeConnectionId: row.id,
      lastReturnSyncAt: row.last_return_sync_at,
    }));
  }

  async markStoreReturnPollSucceeded(input: {
    storeConnectionId: number;
    syncedThrough: Date;
    now: Date;
  }): Promise<void> {
    await this.dbPool.query(
      `UPDATE dropship.dropship_store_connections
       SET last_return_sync_at = CASE
             WHEN last_return_sync_at IS NULL OR last_return_sync_at < $2 THEN $2
             ELSE last_return_sync_at
           END,
           updated_at = $3
       WHERE id = $1`,
      [input.storeConnectionId, input.syncedThrough, input.now],
    );
  }

  // ---- Intake repository port ------------------------------------------

  async findIntakeOrderByExternalId(input: {
    storeConnectionId: number;
    externalOrderId: string;
  }): Promise<DropshipReturnIntakeOrderReference | null> {
    const result = await this.dbPool.query<IntakeOrderRow>(
      `SELECT id, store_connection_id, vendor_id, oms_order_id, normalized_payload
       FROM dropship.dropship_order_intake
       WHERE store_connection_id = $1
         AND external_order_id = $2
       ORDER BY id DESC
       LIMIT 1`,
      [input.storeConnectionId, input.externalOrderId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      intakeId: row.id,
      storeConnectionId: row.store_connection_id,
      vendorId: row.vendor_id,
      omsOrderId: row.oms_order_id,
      lines: readIntakeOrderLines(row.normalized_payload),
    };
  }

  async findRmaByChannelReturnId(input: {
    storeConnectionId: number;
    channelReturnId: string;
  }): Promise<{ rmaId: number; rmaNumber: string } | null> {
    const result = await this.dbPool.query<RmaRow>(
      `SELECT id, rma_number
       FROM dropship.dropship_rmas
       WHERE store_connection_id = $1
         AND channel_return_id = $2
       LIMIT 1`,
      [input.storeConnectionId, input.channelReturnId],
    );
    const row = result.rows[0];
    return row ? { rmaId: row.id, rmaNumber: row.rma_number } : null;
  }

  async createRmaFromChannelDraft(input: {
    draft: DropshipReturnIntakeDraft;
    vendorId: number;
    storeConnectionId: number;
    intakeId: number;
    omsOrderId: number | null;
    status: "requested" | "in_transit";
    rmaNumber: string;
    returnWindowDays: number;
    policyVersionId: number | null;
    items: { productVariantId: number | null; quantity: number }[];
    idempotencyKey: string;
    requestHash: string;
    now: Date;
  }): Promise<{ created: boolean; rmaId: number; rmaNumber: string }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const insert = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_rmas
          (rma_number, vendor_id, store_connection_id, intake_id, oms_order_id,
           status, reason_code, fault_category, return_window_days, label_source,
           return_tracking_number, return_carrier, return_expected_delivery_at,
           vendor_notes, requested_at, updated_at,
           idempotency_key, request_hash, policy_version_id,
           channel_return_id, channel_evidence)
         VALUES ($1, $2, $3, $4, $5,
                 $6, $7, $8, $9, $10,
                 $11, $12, $13,
                 $14, $15, $15,
                 $16, $17, $18,
                 $19, $20::jsonb)
         RETURNING id`,
        [
          input.rmaNumber,
          input.vendorId,
          input.storeConnectionId,
          input.intakeId,
          input.omsOrderId,
          input.status,
          input.draft.reasonText?.slice(0, 80) ?? null,
          input.draft.faultHint,
          input.returnWindowDays,
          input.draft.labelCostCents !== null ? "channel" : null,
          input.draft.returnTracking?.trackingNumber ?? null,
          input.draft.returnTracking?.carrier ?? null,
          input.draft.returnTracking?.expectedDeliveryAt ?? null,
          input.draft.reasonText ?? null,
          input.now,
          input.idempotencyKey,
          input.requestHash,
          input.policyVersionId,
          input.draft.channelReturnId,
          JSON.stringify(input.draft.evidence),
        ],
      );
      const rmaId = insert.rows[0]?.id;
      if (!rmaId) {
        throw new Error("Dropship channel-return RMA insert returned no row.");
      }
      for (const item of input.items) {
        await client.query(
          `INSERT INTO dropship.dropship_rma_items
            (rma_id, product_variant_id, quantity, status, created_at)
           VALUES ($1, $2, $3, 'requested', $4)`,
          [rmaId, item.productVariantId, item.quantity, input.now],
        );
      }
      // In-transit RMAs skip the requested leg: record the transition so the
      // status-update audit trail stays complete (D4 auditability).
      if (input.status === "in_transit") {
        await client.query(
          `INSERT INTO dropship.dropship_rma_status_updates
            (rma_id, vendor_id, previous_status, status, notes, actor_type, actor_id,
             policy_version_id, idempotency_key, request_hash, created_at)
           VALUES ($1, $2, 'requested', 'in_transit', $3, 'system', $4, $5, $6, $7, $8)`,
          [
            rmaId,
            input.vendorId,
            "Channel return already has tracking at intake.",
            "dropship-return-intake",
            input.policyVersionId,
            `${input.idempotencyKey}:in_transit`,
            input.requestHash,
            input.now,
          ],
        );
      }
      await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type,
           actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, $2, 'dropship_rma', $3, 'rma_created_from_channel_return',
                 'system', 'dropship-return-intake', 'info', $4::jsonb, $5)`,
        [
          input.vendorId,
          input.storeConnectionId,
          String(rmaId),
          JSON.stringify({
            rmaNumber: input.rmaNumber,
            channelReturnId: input.draft.channelReturnId,
            intakeId: input.intakeId,
            status: input.status,
            itemCount: input.items.length,
            labelCostCents: input.draft.labelCostCents,
            idempotencyKey: input.idempotencyKey,
          }),
          input.now,
        ],
      );
      await client.query("COMMIT");
      return { created: true, rmaId, rmaNumber: input.rmaNumber };
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        return { created: false, rmaId: 0, rmaNumber: input.rmaNumber };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async recordException(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: "ebay" | "shopify";
    channelReturnId: string;
    failureCode: string;
    message: string;
    channelPayload: Record<string, unknown> | null;
    now: Date;
  }): Promise<{ exceptionId: number }> {
    // Idempotent per open (store, channel return): re-polls bump the attempt
    // count instead of duplicating rows.
    const result = await this.dbPool.query<{ id: number }>(
      `INSERT INTO dropship.dropship_return_intake_exceptions
        (vendor_id, store_connection_id, platform, channel_return_id,
         failure_code, message, channel_payload,
         attempt_count, first_seen_at, last_seen_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, $8, $8, $8, $8)
       ON CONFLICT (store_connection_id, channel_return_id)
         WHERE resolved_at IS NULL
       DO UPDATE SET
         attempt_count = dropship.dropship_return_intake_exceptions.attempt_count + 1,
         failure_code = EXCLUDED.failure_code,
         message = EXCLUDED.message,
         channel_payload = EXCLUDED.channel_payload,
         last_seen_at = EXCLUDED.last_seen_at,
         updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [
        input.vendorId,
        input.storeConnectionId,
        input.platform,
        input.channelReturnId,
        input.failureCode,
        input.message,
        input.channelPayload ? JSON.stringify(input.channelPayload) : null,
        input.now,
      ],
    );
    const exceptionId = result.rows[0]?.id;
    if (!exceptionId) {
      throw new Error("Dropship return-intake exception upsert returned no row.");
    }
    return { exceptionId };
  }

  async resolvePolicyForStore(input: {
    vendorId: number;
    storeConnectionId: number;
    at: Date;
  }): Promise<DropshipReturnIntakeResolvedPolicy | null> {
    // Hierarchical resolution (B1): vendor+store > vendor > store > global,
    // tie-break priority DESC then id DESC. Mirrors the B1 policy repository
    // query; duplicated here to keep the intake write path self-contained.
    const result = await this.dbPool.query<PolicyRow>(
      `SELECT id, return_window_days
       FROM dropship.dropship_return_policies
       WHERE is_active = true
         AND effective_from <= $3
         AND (effective_to IS NULL OR effective_to > $3)
         AND (
           (vendor_id = $1 AND store_connection_id = $2)
           OR (vendor_id = $1 AND store_connection_id IS NULL)
           OR (vendor_id IS NULL AND store_connection_id = $2)
           OR (vendor_id IS NULL AND store_connection_id IS NULL)
         )
       ORDER BY
         CASE
           WHEN vendor_id IS NOT NULL AND store_connection_id IS NOT NULL THEN 4
           WHEN vendor_id IS NOT NULL THEN 3
           WHEN store_connection_id IS NOT NULL THEN 2
           ELSE 1
         END DESC,
         priority DESC,
         id DESC
       LIMIT 1`,
      [input.vendorId, input.storeConnectionId, input.at],
    );
    const row = result.rows[0];
    return row ? { policyId: row.id, returnWindowDays: row.return_window_days } : null;
  }
}

function readIntakeOrderLines(normalizedPayload: unknown): {
  externalLineItemId: string | null;
  sku: string | null;
  productVariantId: number | null;
}[] {
  if (!normalizedPayload || typeof normalizedPayload !== "object") return [];
  const payload = normalizedPayload as Record<string, unknown>;
  const lines = payload.lines;
  if (!Array.isArray(lines)) return [];
  const result: {
    externalLineItemId: string | null;
    sku: string | null;
    productVariantId: number | null;
  }[] = [];
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const record = line as Record<string, unknown>;
    result.push({
      externalLineItemId: readString(record.externalLineItemId),
      sku: readString(record.sku),
      productVariantId: readPositiveInt(record.productVariantId),
    });
  }
  return result;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPositiveInt(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isInteger(parsed) && (parsed as number) > 0 ? (parsed as number) : null;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === "23505",
  );
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original database error.
  }
}
