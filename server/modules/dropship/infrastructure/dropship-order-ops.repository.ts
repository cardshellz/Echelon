import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type { DropshipOrderIntakeStatus, NormalizedDropshipOrderPayload } from "../application/dropship-order-intake-service";
import type {
  DropshipOrderOpsActionResult,
  DropshipOrderOpsIntakeListItem,
  DropshipOrderOpsIntakeListResult,
  DropshipOrderOpsRepository,
  DropshipOrderOpsStatusSummary,
} from "../application/dropship-order-ops-service";

interface OpsIntakeRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  platform: string;
  external_order_id: string;
  external_order_number: string | null;
  status: DropshipOrderIntakeStatus;
  payment_hold_expires_at: Date | null;
  rejection_reason: string | null;
  cancellation_status: string | null;
  normalized_payload: NormalizedDropshipOrderPayload | null;
  oms_order_id: string | number | null;
  received_at: Date;
  accepted_at: Date | null;
  updated_at: Date;
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
  latest_event_type: string | null;
  latest_event_severity: string | null;
  latest_event_created_at: Date | null;
  latest_event_payload: Record<string, unknown> | null;
  total_count: string | number;
}

interface StatusCountRow {
  status: DropshipOrderIntakeStatus;
  count: string | number;
}

interface ActionIntakeRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  external_order_id: string;
  status: DropshipOrderIntakeStatus;
  payment_hold_expires_at: Date | null;
  rejection_reason: string | null;
  cancellation_status: string | null;
  updated_at: Date;
}

const RETRYABLE_OPS_STATUSES = new Set<DropshipOrderIntakeStatus>(["failed", "exception"]);
const EXCEPTION_ACTIONABLE_STATUSES = new Set<DropshipOrderIntakeStatus>([
  "received",
  "retrying",
  "failed",
  "payment_hold",
  "cancelled",
  "rejected",
]);

export class PgDropshipOrderOpsRepository implements DropshipOrderOpsRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listIntakes(
    input: Parameters<DropshipOrderOpsRepository["listIntakes"]>[0],
  ): Promise<DropshipOrderOpsIntakeListResult> {
    const client = await this.dbPool.connect();
    try {
      const listFilters = buildOpsIntakeFilters(input, { includeStatuses: true });
      const offset = (input.page - 1) * input.limit;
      const rows = await client.query<OpsIntakeRow>(
        `${opsIntakeListSelectSql()}
         ${listFilters.whereSql}
         ORDER BY oi.updated_at DESC, oi.id DESC
         LIMIT $${listFilters.params.length + 1}
         OFFSET $${listFilters.params.length + 2}`,
        [...listFilters.params, input.limit, offset],
      );

      const summaryFilters = buildOpsIntakeFilters(input, { includeStatuses: false });
      const summary = await client.query<StatusCountRow>(
        `SELECT oi.status, COUNT(*) AS count
         ${opsIntakeBaseFromSql()}
         ${summaryFilters.whereSql}
         GROUP BY oi.status
         ORDER BY oi.status ASC`,
        summaryFilters.params,
      );

      return {
        items: rows.rows.map(mapOpsIntakeRow),
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

  async retryIntake(
    input: Parameters<DropshipOrderOpsRepository["retryIntake"]>[0],
  ): Promise<DropshipOrderOpsActionResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await loadActionIntakeForUpdate(client, input.intakeId);
      if (!existing) {
        throw new DropshipError(
          "DROPSHIP_ORDER_OPS_INTAKE_NOT_FOUND",
          "Dropship order intake was not found.",
          { intakeId: input.intakeId },
        );
      }

      if (existing.status === "retrying") {
        await client.query("COMMIT");
        return mapActionResult(existing, existing.status, true);
      }

      if (!RETRYABLE_OPS_STATUSES.has(existing.status)) {
        throw new DropshipError(
          "DROPSHIP_ORDER_OPS_STATUS_NOT_RETRYABLE",
          "Dropship order intake status cannot be moved to retrying by ops.",
          { intakeId: input.intakeId, status: existing.status },
        );
      }

      const updated = await client.query<ActionIntakeRow>(
        `UPDATE dropship.dropship_order_intake
         SET status = 'retrying',
             payment_hold_expires_at = NULL,
             rejection_reason = NULL,
             cancellation_status = NULL,
             updated_at = $2
         WHERE id = $1
         RETURNING id, vendor_id, store_connection_id, external_order_id, status,
                   payment_hold_expires_at, rejection_reason, cancellation_status, updated_at`,
        [input.intakeId, input.now],
      );
      const row = requiredRow(updated.rows[0], "Dropship order ops retry did not return a row.");
      await recordOpsAuditEvent(client, {
        row,
        eventType: "order_ops_retry_requested",
        actor: input.actor,
        severity: "info",
        payload: {
          idempotencyKey: input.idempotencyKey,
          previousStatus: existing.status,
          previousRejectionReason: existing.rejection_reason,
          reason: input.reason ?? null,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return mapActionResult(row, existing.status, false);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async markException(
    input: Parameters<DropshipOrderOpsRepository["markException"]>[0],
  ): Promise<DropshipOrderOpsActionResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await loadActionIntakeForUpdate(client, input.intakeId);
      if (!existing) {
        throw new DropshipError(
          "DROPSHIP_ORDER_OPS_INTAKE_NOT_FOUND",
          "Dropship order intake was not found.",
          { intakeId: input.intakeId },
        );
      }

      if (existing.status === "exception") {
        await client.query("COMMIT");
        return mapActionResult(existing, existing.status, true);
      }

      if (!EXCEPTION_ACTIONABLE_STATUSES.has(existing.status)) {
        throw new DropshipError(
          "DROPSHIP_ORDER_OPS_STATUS_NOT_ACTIONABLE",
          "Dropship order intake status cannot be marked as an ops exception.",
          { intakeId: input.intakeId, status: existing.status },
        );
      }

      const updated = await client.query<ActionIntakeRow>(
        `UPDATE dropship.dropship_order_intake
         SET status = 'exception',
             rejection_reason = $2,
             updated_at = $3
         WHERE id = $1
         RETURNING id, vendor_id, store_connection_id, external_order_id, status,
                   payment_hold_expires_at, rejection_reason, cancellation_status, updated_at`,
        [input.intakeId, input.reason, input.now],
      );
      const row = requiredRow(updated.rows[0], "Dropship order ops exception update did not return a row.");
      await recordOpsAuditEvent(client, {
        row,
        eventType: "order_ops_exception_marked",
        actor: input.actor,
        severity: "warning",
        payload: {
          idempotencyKey: input.idempotencyKey,
          previousStatus: existing.status,
          previousRejectionReason: existing.rejection_reason,
          previousCancellationStatus: existing.cancellation_status,
          paymentHoldExpiresAt: existing.payment_hold_expires_at?.toISOString() ?? null,
          reason: input.reason,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return mapActionResult(row, existing.status, false);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

function opsIntakeListSelectSql(): string {
  return `
    SELECT
      oi.id,
      oi.vendor_id,
      oi.store_connection_id,
      oi.platform,
      oi.external_order_id,
      oi.external_order_number,
      oi.status,
      oi.payment_hold_expires_at,
      oi.rejection_reason,
      oi.cancellation_status,
      oi.normalized_payload,
      oi.oms_order_id,
      oi.received_at,
      oi.accepted_at,
      oi.updated_at,
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
      latest.event_type AS latest_event_type,
      latest.severity AS latest_event_severity,
      latest.created_at AS latest_event_created_at,
      latest.payload AS latest_event_payload,
      COUNT(*) OVER() AS total_count
  ` + opsIntakeBaseFromSql();
}

function opsIntakeBaseFromSql(): string {
  return `
    FROM dropship.dropship_order_intake oi
    INNER JOIN dropship.dropship_vendors v ON v.id = oi.vendor_id
    INNER JOIN dropship.dropship_store_connections sc ON sc.id = oi.store_connection_id
    LEFT JOIN LATERAL (
      SELECT ae.event_type, ae.severity, ae.created_at, ae.payload
      FROM dropship.dropship_audit_events ae
      WHERE ae.entity_type = 'dropship_order_intake'
        AND ae.entity_id = oi.id::text
      ORDER BY ae.created_at DESC, ae.id DESC
      LIMIT 1
    ) latest ON true
  `;
}

function buildOpsIntakeFilters(
  input: {
    statuses?: readonly DropshipOrderIntakeStatus[];
    vendorId?: number;
    storeConnectionId?: number;
    search?: string;
  },
  options: { includeStatuses: boolean },
): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.includeStatuses && input.statuses && input.statuses.length > 0) {
    params.push(input.statuses);
    clauses.push(`oi.status = ANY($${params.length}::text[])`);
  }
  if (input.vendorId) {
    params.push(input.vendorId);
    clauses.push(`oi.vendor_id = $${params.length}`);
  }
  if (input.storeConnectionId) {
    params.push(input.storeConnectionId);
    clauses.push(`oi.store_connection_id = $${params.length}`);
  }
  if (input.search) {
    params.push(`%${input.search.trim()}%`);
    clauses.push(`(
      oi.external_order_id ILIKE $${params.length}
      OR oi.external_order_number ILIKE $${params.length}
      OR v.business_name ILIKE $${params.length}
      OR v.email ILIKE $${params.length}
      OR sc.external_display_name ILIKE $${params.length}
      OR sc.shop_domain ILIKE $${params.length}
    )`);
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

async function loadActionIntakeForUpdate(
  client: PoolClient,
  intakeId: number,
): Promise<ActionIntakeRow | null> {
  const result = await client.query<ActionIntakeRow>(
    `SELECT id, vendor_id, store_connection_id, external_order_id, status,
            payment_hold_expires_at, rejection_reason, cancellation_status, updated_at
     FROM dropship.dropship_order_intake
     WHERE id = $1
     LIMIT 1
     FOR UPDATE`,
    [intakeId],
  );
  return result.rows[0] ?? null;
}

async function recordOpsAuditEvent(
  client: PoolClient,
  input: {
    row: ActionIntakeRow;
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
     VALUES ($1, $2, 'dropship_order_intake', $3, $4,
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
        externalOrderId: input.row.external_order_id,
        ...input.payload,
      }),
      input.occurredAt,
    ],
  );
}

function mapOpsIntakeRow(row: OpsIntakeRow): DropshipOrderOpsIntakeListItem {
  const payload = row.normalized_payload ?? { lines: [] };
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  return {
    intakeId: row.id,
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
    status: row.status,
    paymentHoldExpiresAt: row.payment_hold_expires_at,
    rejectionReason: row.rejection_reason,
    cancellationStatus: row.cancellation_status,
    omsOrderId: row.oms_order_id === null ? null : toSafeInteger(row.oms_order_id, "oms_order_id"),
    receivedAt: row.received_at,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
    lineCount: lines.length,
    totalQuantity: sumLineQuantities(lines),
    shipTo: payload.shipTo ?? null,
    latestAuditEvent: row.latest_event_type && row.latest_event_severity && row.latest_event_created_at
      ? {
        eventType: row.latest_event_type,
        severity: row.latest_event_severity,
        createdAt: row.latest_event_created_at,
        payload: row.latest_event_payload ?? {},
      }
      : null,
  };
}

function mapStatusCountRow(row: StatusCountRow): DropshipOrderOpsStatusSummary {
  return {
    status: row.status,
    count: toSafeInteger(row.count, "status_count"),
  };
}

function mapActionResult(
  row: ActionIntakeRow,
  previousStatus: DropshipOrderIntakeStatus,
  idempotentReplay: boolean,
): DropshipOrderOpsActionResult {
  return {
    intakeId: row.id,
    previousStatus,
    status: row.status,
    idempotentReplay,
    updatedAt: row.updated_at,
  };
}

function sumLineQuantities(lines: readonly unknown[]): number {
  return lines.reduce<number>((sum, line) => {
    if (!line || typeof line !== "object") {
      return sum;
    }
    const quantity = (line as { quantity?: unknown }).quantity;
    return typeof quantity === "number" && Number.isInteger(quantity) && quantity > 0
      ? sum + quantity
      : sum;
  }, 0);
}

function toSafeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DropshipError(
      "DROPSHIP_ORDER_OPS_INTEGER_RANGE_ERROR",
      "Dropship order ops integer value is outside the safe runtime range.",
      { field, value: String(value) },
    );
  }
  return parsed;
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
