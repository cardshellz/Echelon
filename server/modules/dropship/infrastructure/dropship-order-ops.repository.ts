import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type { DropshipOrderIntakeStatus, NormalizedDropshipOrderPayload } from "../application/dropship-order-intake-service";
import type {
  DropshipOrderOpsActionResult,
  DropshipOrderOpsAuditEventDetail,
  DropshipOrderOpsEconomicsSnapshot,
  DropshipOrderOpsIntakeDetail,
  DropshipOrderOpsIntakeLine,
  DropshipOrderOpsIntakeListItem,
  DropshipOrderOpsIntakeListResult,
  DropshipOrderOpsRepository,
  DropshipOrderOpsShippingQuoteSnapshot,
  DropshipOrderOpsStatusSummary,
  DropshipOrderOpsTrackingPushSummary,
  DropshipOrderOpsWalletLedgerEntry,
} from "../application/dropship-order-ops-service";
import type { DropshipTrackingPushStatus } from "../application/dropship-tracking-push-ops-dtos";

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

interface OpsIntakeDetailRow extends OpsIntakeRow {
  source_order_id: string | null;
  economics_snapshot_id: number | null;
  economics_shipping_quote_snapshot_id: number | null;
  economics_warehouse_id: number | null;
  economics_currency: string | null;
  retail_subtotal_cents: string | number | null;
  wholesale_subtotal_cents: string | number | null;
  shipping_cents: string | number | null;
  economics_insurance_pool_cents: string | number | null;
  fees_cents: string | number | null;
  total_debit_cents: string | number | null;
  pricing_snapshot: Record<string, unknown> | null;
  economics_created_at: Date | null;
  quote_snapshot_id: number | null;
  quote_warehouse_id: number | null;
  quote_currency: string | null;
  quote_destination_country: string | null;
  quote_destination_postal_code: string | null;
  quote_package_count: number | null;
  base_rate_cents: string | number | null;
  markup_cents: string | number | null;
  quote_insurance_pool_cents: string | number | null;
  dunnage_cents: string | number | null;
  total_shipping_cents: string | number | null;
  quote_payload: Record<string, unknown> | null;
  quote_created_at: Date | null;
  wallet_ledger_entry_id: number | null;
  wallet_ledger_type: string | null;
  wallet_ledger_status: string | null;
  wallet_ledger_amount_cents: string | number | null;
  wallet_ledger_currency: string | null;
  available_balance_after_cents: string | number | null;
  pending_balance_after_cents: string | number | null;
  wallet_ledger_created_at: Date | null;
  wallet_ledger_settled_at: Date | null;
}

interface AuditEventRow {
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  severity: string;
  payload: Record<string, unknown> | null;
  created_at: Date;
}

interface TrackingPushDetailRow {
  id: number;
  wms_shipment_id: string | number | null;
  platform: string;
  status: DropshipTrackingPushStatus;
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

  async getIntakeDetail(
    input: Parameters<DropshipOrderOpsRepository["getIntakeDetail"]>[0],
  ): Promise<DropshipOrderOpsIntakeDetail | null> {
    const client = await this.dbPool.connect();
    try {
      const filters = buildDetailFilters(input);
      const result = await client.query<OpsIntakeDetailRow>(
        `${opsIntakeDetailSelectSql()}
         ${filters.whereSql}
         LIMIT 1`,
        filters.params,
      );
      const row = result.rows[0];
      if (!row) return null;

      const auditEvents = await client.query<AuditEventRow>(
        `SELECT event_type, actor_type, actor_id, severity, payload, created_at
         FROM dropship.dropship_audit_events
         WHERE entity_type = 'dropship_order_intake'
           AND entity_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 20`,
        [String(input.intakeId)],
      );
      const trackingPushes = await client.query<TrackingPushDetailRow>(
        `SELECT
           id,
           wms_shipment_id,
           platform,
           status,
           carrier,
           tracking_number,
           shipped_at,
           external_fulfillment_id,
           attempt_count,
           COALESCE((raw_result->'lastFailure'->>'retryable')::boolean, true) AS retryable,
           last_error_code,
           last_error_message,
           created_at,
           updated_at,
           completed_at
         FROM dropship.dropship_marketplace_tracking_pushes
         WHERE intake_id = $1
           AND vendor_id = $2
           AND store_connection_id = $3
         ORDER BY shipped_at DESC, id DESC
         LIMIT 50`,
        [row.id, row.vendor_id, row.store_connection_id],
      );
      return mapOpsIntakeDetailRow(row, auditEvents.rows, trackingPushes.rows);
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

function opsIntakeDetailSelectSql(): string {
  return `
    SELECT
      oi.id,
      oi.vendor_id,
      oi.store_connection_id,
      oi.platform,
      oi.external_order_id,
      oi.external_order_number,
      oi.source_order_id,
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
      1 AS total_count,
      econ.id AS economics_snapshot_id,
      econ.shipping_quote_snapshot_id AS economics_shipping_quote_snapshot_id,
      econ.warehouse_id AS economics_warehouse_id,
      econ.currency AS economics_currency,
      econ.retail_subtotal_cents,
      econ.wholesale_subtotal_cents,
      econ.shipping_cents,
      econ.insurance_pool_cents AS economics_insurance_pool_cents,
      econ.fees_cents,
      econ.total_debit_cents,
      econ.pricing_snapshot,
      econ.created_at AS economics_created_at,
      quote.id AS quote_snapshot_id,
      quote.warehouse_id AS quote_warehouse_id,
      quote.currency AS quote_currency,
      quote.destination_country AS quote_destination_country,
      quote.destination_postal_code AS quote_destination_postal_code,
      quote.package_count AS quote_package_count,
      quote.base_rate_cents,
      quote.markup_cents,
      quote.insurance_pool_cents AS quote_insurance_pool_cents,
      quote.dunnage_cents,
      quote.total_shipping_cents,
      quote.quote_payload,
      quote.created_at AS quote_created_at,
      ledger.id AS wallet_ledger_entry_id,
      ledger.type AS wallet_ledger_type,
      ledger.status AS wallet_ledger_status,
      ledger.amount_cents AS wallet_ledger_amount_cents,
      ledger.currency AS wallet_ledger_currency,
      ledger.available_balance_after_cents,
      ledger.pending_balance_after_cents,
      ledger.created_at AS wallet_ledger_created_at,
      ledger.settled_at AS wallet_ledger_settled_at
    ${opsIntakeBaseFromSql()}
    LEFT JOIN dropship.dropship_order_economics_snapshots econ
      ON econ.intake_id = oi.id
    LEFT JOIN LATERAL (
      SELECT
        CASE
          WHEN ae.payload->>'shippingQuoteSnapshotId' ~ '^[0-9]+$'
          THEN (ae.payload->>'shippingQuoteSnapshotId')::integer
          ELSE NULL
        END AS shipping_quote_snapshot_id
      FROM dropship.dropship_audit_events ae
      WHERE ae.entity_type = 'dropship_order_intake'
        AND ae.entity_id = oi.id::text
        AND ae.event_type = 'order_acceptance_payment_hold'
      ORDER BY ae.created_at DESC, ae.id DESC
      LIMIT 1
    ) hold_quote ON true
    LEFT JOIN dropship.dropship_shipping_quote_snapshots quote
      ON quote.id = COALESCE(econ.shipping_quote_snapshot_id, hold_quote.shipping_quote_snapshot_id)
    LEFT JOIN LATERAL (
      SELECT wl.id, wl.type, wl.status, wl.amount_cents, wl.currency,
             wl.available_balance_after_cents, wl.pending_balance_after_cents,
             wl.created_at, wl.settled_at
      FROM dropship.dropship_wallet_ledger wl
      WHERE wl.reference_type = 'order_intake'
        AND wl.reference_id = oi.id::text
        AND wl.type = 'order_debit'
      ORDER BY wl.id ASC
      LIMIT 1
    ) ledger ON true
  `;
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

function buildDetailFilters(input: {
  intakeId: number;
  vendorId?: number;
  storeConnectionId?: number;
}): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  params.push(input.intakeId);
  clauses.push(`oi.id = $${params.length}`);
  if (input.vendorId) {
    params.push(input.vendorId);
    clauses.push(`oi.vendor_id = $${params.length}`);
  }
  if (input.storeConnectionId) {
    params.push(input.storeConnectionId);
    clauses.push(`oi.store_connection_id = $${params.length}`);
  }
  return {
    whereSql: `WHERE ${clauses.join(" AND ")}`,
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

function mapOpsIntakeDetailRow(
  row: OpsIntakeDetailRow,
  auditEvents: AuditEventRow[],
  trackingPushes: TrackingPushDetailRow[],
): DropshipOrderOpsIntakeDetail {
  const payload = row.normalized_payload ?? { lines: [] };
  return {
    ...mapOpsIntakeRow(row),
    sourceOrderId: row.source_order_id,
    orderedAt: normalizeOptionalString(payload.orderedAt),
    marketplaceStatus: normalizeOptionalString(payload.marketplaceStatus),
    totals: mapNormalizedTotals(payload.totals),
    lines: mapNormalizedLines(payload.lines),
    economicsSnapshot: mapEconomicsSnapshot(row),
    shippingQuoteSnapshot: mapShippingQuoteSnapshot(row),
    walletLedgerEntry: mapWalletLedgerEntry(row),
    trackingPushes: trackingPushes.map(mapTrackingPushDetailRow),
    auditEvents: auditEvents.map(mapAuditEventDetail),
  };
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

function mapNormalizedLines(lines: NormalizedDropshipOrderPayload["lines"] | undefined): DropshipOrderOpsIntakeLine[] {
  if (!Array.isArray(lines)) return [];
  return lines.map((line, index) => {
    const quantity = normalizePositiveInteger(line.quantity) ?? 0;
    const unitRetailPriceCents = normalizeOptionalSafeInteger(line.unitRetailPriceCents);
    return {
      lineIndex: index,
      externalLineItemId: normalizeOptionalString(line.externalLineItemId),
      externalListingId: normalizeOptionalString(line.externalListingId),
      externalOfferId: normalizeOptionalString(line.externalOfferId),
      sku: normalizeOptionalString(line.sku),
      productVariantId: normalizePositiveInteger(line.productVariantId),
      quantity,
      unitRetailPriceCents,
      lineRetailTotalCents: unitRetailPriceCents === null ? null : safeMultiply(unitRetailPriceCents, quantity),
      title: normalizeOptionalString(line.title),
    };
  });
}

function mapNormalizedTotals(
  totals: NormalizedDropshipOrderPayload["totals"] | undefined,
): DropshipOrderOpsIntakeDetail["totals"] {
  if (!totals || typeof totals !== "object") return null;
  return {
    retailSubtotalCents: normalizeOptionalSafeInteger(totals.retailSubtotalCents),
    shippingPaidCents: normalizeOptionalSafeInteger(totals.shippingPaidCents),
    taxCents: normalizeOptionalSafeInteger(totals.taxCents),
    discountCents: normalizeOptionalSafeInteger(totals.discountCents),
    grandTotalCents: normalizeOptionalSafeInteger(totals.grandTotalCents),
    currency: normalizeCurrency(totals.currency),
  };
}

function mapEconomicsSnapshot(row: OpsIntakeDetailRow): DropshipOrderOpsEconomicsSnapshot | null {
  if (row.economics_snapshot_id === null || row.economics_created_at === null) return null;
  return {
    economicsSnapshotId: row.economics_snapshot_id,
    shippingQuoteSnapshotId: row.economics_shipping_quote_snapshot_id,
    warehouseId: row.economics_warehouse_id,
    currency: row.economics_currency ?? "USD",
    retailSubtotalCents: requiredSafeInteger(row.retail_subtotal_cents, "retail_subtotal_cents"),
    wholesaleSubtotalCents: requiredSafeInteger(row.wholesale_subtotal_cents, "wholesale_subtotal_cents"),
    shippingCents: requiredSafeInteger(row.shipping_cents, "shipping_cents"),
    insurancePoolCents: requiredSafeInteger(row.economics_insurance_pool_cents, "economics_insurance_pool_cents"),
    feesCents: requiredSafeInteger(row.fees_cents, "fees_cents"),
    totalDebitCents: requiredSafeInteger(row.total_debit_cents, "total_debit_cents"),
    pricingSnapshot: row.pricing_snapshot ?? {},
    createdAt: row.economics_created_at,
  };
}

function mapShippingQuoteSnapshot(row: OpsIntakeDetailRow): DropshipOrderOpsShippingQuoteSnapshot | null {
  if (row.quote_snapshot_id === null || row.quote_warehouse_id === null || row.quote_created_at === null) return null;
  return {
    quoteSnapshotId: row.quote_snapshot_id,
    warehouseId: row.quote_warehouse_id,
    currency: row.quote_currency ?? "USD",
    destinationCountry: row.quote_destination_country ?? "US",
    destinationPostalCode: row.quote_destination_postal_code,
    packageCount: row.quote_package_count ?? 0,
    baseRateCents: requiredSafeInteger(row.base_rate_cents, "base_rate_cents"),
    markupCents: requiredSafeInteger(row.markup_cents, "markup_cents"),
    insurancePoolCents: requiredSafeInteger(row.quote_insurance_pool_cents, "quote_insurance_pool_cents"),
    dunnageCents: requiredSafeInteger(row.dunnage_cents, "dunnage_cents"),
    totalShippingCents: requiredSafeInteger(row.total_shipping_cents, "total_shipping_cents"),
    quotePayload: row.quote_payload ?? {},
    createdAt: row.quote_created_at,
  };
}

function mapWalletLedgerEntry(row: OpsIntakeDetailRow): DropshipOrderOpsWalletLedgerEntry | null {
  if (row.wallet_ledger_entry_id === null || row.wallet_ledger_created_at === null) return null;
  return {
    walletLedgerEntryId: row.wallet_ledger_entry_id,
    type: row.wallet_ledger_type ?? "order_debit",
    status: row.wallet_ledger_status ?? "unknown",
    amountCents: requiredSafeInteger(row.wallet_ledger_amount_cents, "wallet_ledger_amount_cents"),
    currency: row.wallet_ledger_currency ?? "USD",
    availableBalanceAfterCents: optionalSafeInteger(row.available_balance_after_cents, "available_balance_after_cents"),
    pendingBalanceAfterCents: optionalSafeInteger(row.pending_balance_after_cents, "pending_balance_after_cents"),
    createdAt: row.wallet_ledger_created_at,
    settledAt: row.wallet_ledger_settled_at,
  };
}

function mapAuditEventDetail(row: AuditEventRow): DropshipOrderOpsAuditEventDetail {
  return {
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    severity: row.severity,
    payload: row.payload ?? {},
    createdAt: row.created_at,
  };
}

function mapTrackingPushDetailRow(row: TrackingPushDetailRow): DropshipOrderOpsTrackingPushSummary {
  return {
    pushId: toSafeInteger(row.id, "tracking_push_id"),
    wmsShipmentId: optionalSafeInteger(row.wms_shipment_id, "wms_shipment_id"),
    platform: row.platform,
    status: row.status,
    carrier: row.carrier,
    trackingNumber: row.tracking_number,
    shippedAt: row.shipped_at,
    externalFulfillmentId: row.external_fulfillment_id,
    attemptCount: toSafeInteger(row.attempt_count, "tracking_push_attempt_count"),
    retryable: row.retryable !== false,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
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

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeCurrency(value: unknown): string {
  const parsed = normalizeOptionalString(value)?.toUpperCase();
  return parsed && /^[A-Z]{3}$/.test(parsed) ? parsed : "USD";
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

function normalizeOptionalSafeInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value;
}

function safeMultiply(left: number, right: number): number | null {
  const result = left * right;
  return Number.isSafeInteger(result) ? result : null;
}

function requiredSafeInteger(value: string | number | null, field: string): number {
  if (value === null) {
    throw new DropshipError(
      "DROPSHIP_ORDER_OPS_INTEGER_REQUIRED",
      "Dropship order detail integer value is required.",
      { field },
    );
  }
  return toSafeInteger(value, field);
}

function optionalSafeInteger(value: string | number | null, field: string): number | null {
  if (value === null) return null;
  return toSafeInteger(value, field);
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
