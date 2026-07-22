import { sql } from "drizzle-orm";
import {
  collectOmsFlowReconciliationIssues,
  getOmsFlowReconciliationSchedulerHeartbeat,
} from "./oms-flow-reconciliation.service";
import {
  getChannelWritebackHealth,
  type ChannelWritebackHealth,
} from "./channel-writeback.service";
import { getOmsOpsAlertSchedulerHeartbeat } from "./oms-ops-alert-heartbeat";
import { getEbayOrderPollHeartbeat } from "./ebay-order-poll-heartbeat";
import { getWebhookRetryWorkerHeartbeat } from "./webhook-retry.worker";
import {
  HELD_LINE_AGING_DAYS,
  allLinesHeldCountQuery,
  allLinesHeldSampleQuery,
  heldLineAgingCountQuery,
  heldLineAgingSampleQuery,
} from "./line-item-hold-monitoring";

// P5 (LINE-ITEM-HOLD-DESIGN.md §6.8/§7): a held pre-order line older than this
// is surfaced as an aging exception — by then the PO was most likely cancelled or
// the stock never arrived ("held forever"), so a human should chase the PO or
// cancel the line. Deliberately conservative: pre-orders can legitimately run
// weeks out, and this threshold also drives an ops alert, so keep it low-noise.

export interface OmsOpsIssue {
  code: string;
  severity: "critical" | "warning" | "info";
  count: number;
  message: string;
  sample: unknown[];
}

export interface OmsOpsHealthSummary {
  generatedAt: string;
  status: "healthy" | "degraded" | "critical";
  workers: {
    webhookRetry: ReturnType<typeof getWebhookRetryWorkerHeartbeat>;
    omsFlowReconciliation: ReturnType<typeof getOmsFlowReconciliationSchedulerHeartbeat>;
    omsOpsAlert: ReturnType<typeof getOmsOpsAlertSchedulerHeartbeat>;
    ebayOrderPoll: ReturnType<typeof getEbayOrderPollHeartbeat>;
  };
  counts: {
    critical: number;
    warning: number;
    info: number;
  };
  issues: OmsOpsIssue[];
  channelWriteback: ChannelWritebackHealth;
}

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function countFrom(result: any): number {
  const value = rows(result)[0]?.count ?? 0;
  return Number(value) || 0;
}

function issue(input: OmsOpsIssue): OmsOpsIssue {
  return input;
}

async function countAndSample(
  db: any,
  countQuery: any,
  sampleQuery: any,
): Promise<{ count: number; sample: unknown[] }> {
  const [countResult, sampleResult] = await Promise.all([
    db.execute(countQuery),
    db.execute(sampleQuery),
  ]);
  return {
    count: countFrom(countResult),
    sample: rows(sampleResult),
  };
}

export async function getOmsOpsHealth(db: any): Promise<OmsOpsHealthSummary> {
  const webhookRetryHeartbeat = getWebhookRetryWorkerHeartbeat();
  const reconciliationHeartbeat = getOmsFlowReconciliationSchedulerHeartbeat();
  const alertHeartbeat = getOmsOpsAlertSchedulerHeartbeat();
  const ebayOrderPollHeartbeat = getEbayOrderPollHeartbeat();
  const nowMs = Date.now();
  const webhookRetryWorkerStartedMs = webhookRetryHeartbeat.startedAt
    ? new Date(webhookRetryHeartbeat.startedAt).getTime()
    : null;
  const webhookRetryWorkerLastRunMs = webhookRetryHeartbeat.lastRunAt
    ? new Date(webhookRetryHeartbeat.lastRunAt).getTime()
    : null;
  const webhookRetryWorkerIsStale =
    webhookRetryWorkerStartedMs !== null &&
    nowMs - webhookRetryWorkerStartedMs > 5 * 60_000 &&
    (webhookRetryWorkerLastRunMs === null || nowMs - webhookRetryWorkerLastRunMs > 5 * 60_000);
  const schedulerIsStale = (
    heartbeat: { startedAt: string | null; lastRunAt: string | null },
    graceMs: number,
    staleMs: number,
  ): boolean => {
    const startedMs = heartbeat.startedAt ? new Date(heartbeat.startedAt).getTime() : null;
    const lastRunMs = heartbeat.lastRunAt ? new Date(heartbeat.lastRunAt).getTime() : null;
    return (
      startedMs !== null &&
      nowMs - startedMs > graceMs &&
      (lastRunMs === null || nowMs - lastRunMs > staleMs)
    );
  };
  const reconciliationSchedulerIsStale = schedulerIsStale(
    reconciliationHeartbeat,
    20 * 60_000,
    30 * 60_000,
  );
  const alertSchedulerIsStale = schedulerIsStale(alertHeartbeat, 10 * 60_000, 15 * 60_000);
  const ebayOrderPollIsStale = schedulerIsStale(
    ebayOrderPollHeartbeat,
    15 * 60_000,
    15 * 60_000,
  );
  const [
    flowReconciliationIssues,
    failedInbox,
    duplicateShipStationOrderIds,
    duplicateShipStationOrderKeys,
    duplicateShippingEngineOrderRefs,
    activeWmsItemsWithoutOmsAuthority,
    omsLineAuthorityOverMaterialized,
    reconciliationManualReviews,
    wmsPendingItemsWithoutShipment,
    staleProcessingInbox,
    deadRetries,
    staleDueRetries,
    pendingRetries,
    omsWithoutWms,
    wmsWithoutShipment,
    unpushedShipments,
    reviewShipments,
    onHoldShipments,
    shippedTrackingNotPushed,
    heldLineAging,
    allLinesHeldOrders,
  ] = await Promise.all([
    collectOmsFlowReconciliationIssues(db),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM oms.webhook_inbox
        WHERE status IN ('failed', 'dead')
      `,
      sql`
        SELECT id, provider, topic, event_id, source_domain, status, attempts,
               last_error, updated_at
        FROM oms.webhook_inbox
        WHERE status IN ('failed', 'dead')
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM (
          SELECT s.shipstation_order_id
          FROM wms.outbound_shipments s
          WHERE s.status IN ('planned', 'queued', 'labeled', 'on_hold')
            AND COALESCE(s.source, '') NOT IN ('echelon_combined_child', 'shipstation_combined_child')
            AND s.shipstation_order_id IS NOT NULL
          GROUP BY s.shipstation_order_id
          HAVING COUNT(*) > 1
        ) duplicate_identity
      `,
      sql`
        SELECT s.shipstation_order_id,
               COUNT(*)::int AS shipment_count,
               ARRAY_AGG(s.id ORDER BY s.id) AS shipment_ids,
               ARRAY_AGG(s.order_id ORDER BY s.id) AS wms_order_ids,
               ARRAY_AGG(o.order_number ORDER BY s.id) AS order_numbers,
               ARRAY_AGG(COALESCE(s.source, '') ORDER BY s.id) AS sources,
               ARRAY_AGG(s.status ORDER BY s.id) AS statuses
        FROM wms.outbound_shipments s
        LEFT JOIN wms.orders o ON o.id = s.order_id
        WHERE s.status IN ('planned', 'queued', 'labeled', 'on_hold')
          AND COALESCE(s.source, '') NOT IN ('echelon_combined_child', 'shipstation_combined_child')
          AND s.shipstation_order_id IS NOT NULL
        GROUP BY s.shipstation_order_id
        HAVING COUNT(*) > 1
        ORDER BY shipment_count DESC, s.shipstation_order_id DESC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM (
          SELECT s.shipstation_order_key
          FROM wms.outbound_shipments s
          WHERE s.status IN ('planned', 'queued', 'labeled', 'on_hold')
            AND COALESCE(s.source, '') NOT IN ('echelon_combined_child', 'shipstation_combined_child')
            AND NULLIF(TRIM(s.shipstation_order_key), '') IS NOT NULL
          GROUP BY s.shipstation_order_key
          HAVING COUNT(*) > 1
        ) duplicate_identity
      `,
      sql`
        SELECT s.shipstation_order_key,
               COUNT(*)::int AS shipment_count,
               ARRAY_AGG(s.id ORDER BY s.id) AS shipment_ids,
               ARRAY_AGG(s.order_id ORDER BY s.id) AS wms_order_ids,
               ARRAY_AGG(o.order_number ORDER BY s.id) AS order_numbers,
               ARRAY_AGG(COALESCE(s.source, '') ORDER BY s.id) AS sources,
               ARRAY_AGG(s.status ORDER BY s.id) AS statuses
        FROM wms.outbound_shipments s
        LEFT JOIN wms.orders o ON o.id = s.order_id
        WHERE s.status IN ('planned', 'queued', 'labeled', 'on_hold')
          AND COALESCE(s.source, '') NOT IN ('echelon_combined_child', 'shipstation_combined_child')
          AND NULLIF(TRIM(s.shipstation_order_key), '') IS NOT NULL
        GROUP BY s.shipstation_order_key
        HAVING COUNT(*) > 1
        ORDER BY shipment_count DESC, s.shipstation_order_key DESC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM (
          SELECT s.shipping_engine, s.engine_order_ref
          FROM wms.outbound_shipments s
          WHERE s.status IN ('planned', 'queued', 'labeled', 'on_hold')
            AND COALESCE(s.source, '') NOT IN ('echelon_combined_child', 'shipstation_combined_child')
            AND NULLIF(TRIM(s.shipping_engine), '') IS NOT NULL
            AND NULLIF(TRIM(s.engine_order_ref), '') IS NOT NULL
          GROUP BY s.shipping_engine, s.engine_order_ref
          HAVING COUNT(*) > 1
        ) duplicate_identity
      `,
      sql`
        SELECT s.shipping_engine,
               s.engine_order_ref,
               COUNT(*)::int AS shipment_count,
               ARRAY_AGG(s.id ORDER BY s.id) AS shipment_ids,
               ARRAY_AGG(s.order_id ORDER BY s.id) AS wms_order_ids,
               ARRAY_AGG(o.order_number ORDER BY s.id) AS order_numbers,
               ARRAY_AGG(COALESCE(s.source, '') ORDER BY s.id) AS sources,
               ARRAY_AGG(s.status ORDER BY s.id) AS statuses
        FROM wms.outbound_shipments s
        LEFT JOIN wms.orders o ON o.id = s.order_id
        WHERE s.status IN ('planned', 'queued', 'labeled', 'on_hold')
          AND COALESCE(s.source, '') NOT IN ('echelon_combined_child', 'shipstation_combined_child')
          AND NULLIF(TRIM(s.shipping_engine), '') IS NOT NULL
          AND NULLIF(TRIM(s.engine_order_ref), '') IS NOT NULL
        GROUP BY s.shipping_engine, s.engine_order_ref
        HAVING COUNT(*) > 1
        ORDER BY shipment_count DESC, s.shipping_engine, s.engine_order_ref
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM wms.order_items oi
        JOIN wms.orders wo ON wo.id = oi.order_id
        LEFT JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
        WHERE COALESCE(wo.source, '') IN ('oms', 'shopify', 'ebay')
          AND wo.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
          AND wo.cancelled_at IS NULL
          AND wo.completed_at IS NULL
          AND COALESCE(oi.status, '') NOT IN ('cancelled', 'completed', 'short')
          AND COALESCE(oi.quantity, 0) > 0
          AND (
            oi.oms_order_line_id IS NULL
            OR ol.id IS NULL
          )
      `,
      sql`
        SELECT wo.id AS wms_order_id,
               wo.order_number,
               wo.source,
               wo.warehouse_status,
               oi.id AS wms_order_item_id,
               oi.oms_order_line_id,
               oi.sku,
               oi.quantity,
               oi.status AS item_status,
               CASE
                 WHEN oi.oms_order_line_id IS NULL THEN 'missing_oms_order_line_id'
                 WHEN ol.id IS NULL THEN 'orphan_oms_order_line_id'
                 ELSE 'unknown'
               END AS authority_gap
        FROM wms.order_items oi
        JOIN wms.orders wo ON wo.id = oi.order_id
        LEFT JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
        WHERE COALESCE(wo.source, '') IN ('oms', 'shopify', 'ebay')
          AND wo.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
          AND wo.cancelled_at IS NULL
          AND wo.completed_at IS NULL
          AND COALESCE(oi.status, '') NOT IN ('cancelled', 'completed', 'short')
          AND COALESCE(oi.quantity, 0) > 0
          AND (
            oi.oms_order_line_id IS NULL
            OR ol.id IS NULL
          )
        ORDER BY wo.updated_at DESC NULLS LAST, oi.id DESC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        WITH active_materialized AS (
          SELECT
            oi.oms_order_line_id,
            SUM(oi.quantity)::int AS materialized_quantity
          FROM wms.order_items oi
          JOIN wms.orders wo ON wo.id = oi.order_id
          WHERE oi.oms_order_line_id IS NOT NULL
            AND wo.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
            AND wo.cancelled_at IS NULL
            AND wo.completed_at IS NULL
            AND COALESCE(oi.status, '') NOT IN ('cancelled', 'completed', 'short')
          GROUP BY oi.oms_order_line_id
        )
        SELECT COUNT(*)::int AS count
        FROM active_materialized am
        JOIN oms.oms_order_lines ol ON ol.id = am.oms_order_line_id
        WHERE am.materialized_quantity > COALESCE(ol.authority_fulfillable_quantity, 0)
      `,
      sql`
        WITH active_materialized AS (
          SELECT
            oi.oms_order_line_id,
            SUM(oi.quantity)::int AS materialized_quantity,
            ARRAY_AGG(oi.id ORDER BY oi.id) AS wms_order_item_ids,
            ARRAY_AGG(DISTINCT wo.id ORDER BY wo.id) AS wms_order_ids
          FROM wms.order_items oi
          JOIN wms.orders wo ON wo.id = oi.order_id
          WHERE oi.oms_order_line_id IS NOT NULL
            AND wo.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
            AND wo.cancelled_at IS NULL
            AND wo.completed_at IS NULL
            AND COALESCE(oi.status, '') NOT IN ('cancelled', 'completed', 'short')
          GROUP BY oi.oms_order_line_id
        )
        SELECT ol.order_id AS oms_order_id,
               ol.id AS oms_order_line_id,
               ol.sku,
               ol.quantity AS oms_quantity,
               ol.authority_fulfillable_quantity,
               am.materialized_quantity,
               am.materialized_quantity - COALESCE(ol.authority_fulfillable_quantity, 0) AS over_materialized_quantity,
               am.wms_order_ids,
               am.wms_order_item_ids
        FROM active_materialized am
        JOIN oms.oms_order_lines ol ON ol.id = am.oms_order_line_id
        WHERE am.materialized_quantity > COALESCE(ol.authority_fulfillable_quantity, 0)
        ORDER BY (am.materialized_quantity - COALESCE(ol.authority_fulfillable_quantity, 0)) DESC,
                 ol.id DESC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM wms.reconciliation_exceptions
        WHERE classification = 'manual_review'
          AND status IN ('open', 'acknowledged')
      `,
      sql`
        SELECT rule,
               COUNT(*)::int AS count,
               MAX(last_seen_at) AS last_seen_at
        FROM wms.reconciliation_exceptions
        WHERE classification = 'manual_review'
          AND status IN ('open', 'acknowledged')
        GROUP BY rule
        ORDER BY COUNT(*) DESC, rule
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM wms.order_items oi
        JOIN wms.orders wo ON wo.id = oi.order_id
        WHERE COALESCE(oi.requires_shipping, 1) <> 0
          AND COALESCE(oi.quantity, 0) > COALESCE(oi.fulfilled_quantity, 0)
          AND oi.status NOT IN ('cancelled', 'completed')
          AND wo.warehouse_status NOT IN ('cancelled')
          AND NOT EXISTS (
            SELECT 1
            FROM oms.oms_orders oo
            WHERE (
                (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
                OR (wo.source_table_id = oo.id::text)
              )
              AND (
                oo.status IN ('cancelled', 'shipped', 'refunded')
                OR oo.financial_status = 'refunded'
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM wms.outbound_shipment_items osi
            JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
            WHERE osi.order_item_id = oi.id
              AND os.status NOT IN ('voided', 'cancelled')
          )
      `,
      sql`
        SELECT oi.id AS wms_item_id,
               oi.order_id AS wms_order_id,
               wo.order_number,
               wo.warehouse_status,
               oi.oms_order_line_id,
               oi.sku,
               oi.quantity,
               oi.fulfilled_quantity,
               oi.status,
               oi.requires_shipping
        FROM wms.order_items oi
        JOIN wms.orders wo ON wo.id = oi.order_id
        WHERE COALESCE(oi.requires_shipping, 1) <> 0
          AND COALESCE(oi.quantity, 0) > COALESCE(oi.fulfilled_quantity, 0)
          AND oi.status NOT IN ('cancelled', 'completed')
          AND wo.warehouse_status NOT IN ('cancelled')
          AND NOT EXISTS (
            SELECT 1
            FROM oms.oms_orders oo
            WHERE (
                (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
                OR (wo.source_table_id = oo.id::text)
              )
              AND (
                oo.status IN ('cancelled', 'shipped', 'refunded')
                OR oo.financial_status = 'refunded'
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM wms.outbound_shipment_items osi
            JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
            WHERE osi.order_item_id = oi.id
              AND os.status NOT IN ('voided', 'cancelled')
          )
        ORDER BY wo.updated_at DESC NULLS LAST, oi.id DESC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM oms.webhook_inbox
        WHERE status = 'processing'
          AND updated_at < NOW() - INTERVAL '10 minutes'
      `,
      sql`
        SELECT id, provider, topic, event_id, source_domain, attempts,
               last_attempt_at, updated_at
        FROM oms.webhook_inbox
        WHERE status = 'processing'
          AND updated_at < NOW() - INTERVAL '10 minutes'
        ORDER BY updated_at ASC, id ASC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM oms.webhook_retry_queue
        WHERE status = 'dead'
      `,
      sql`
        SELECT id, provider, topic, source_inbox_id, attempts, last_error, updated_at
        FROM oms.webhook_retry_queue
        WHERE status = 'dead'
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM oms.webhook_retry_queue
        WHERE status = 'pending'
          AND next_retry_at <= NOW() - INTERVAL '15 minutes'
      `,
      sql`
        SELECT id, provider, topic, source_inbox_id, attempts, next_retry_at, last_error
        FROM oms.webhook_retry_queue
        WHERE status = 'pending'
          AND next_retry_at <= NOW() - INTERVAL '15 minutes'
        ORDER BY next_retry_at ASC, id ASC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM oms.webhook_retry_queue
        WHERE status = 'pending'
          AND next_retry_at <= NOW()
          AND next_retry_at > NOW() - INTERVAL '15 minutes'
      `,
      sql`
        SELECT id, provider, topic, source_inbox_id, attempts, next_retry_at, last_error
        FROM oms.webhook_retry_queue
        WHERE status = 'pending'
          AND next_retry_at <= NOW()
          AND next_retry_at > NOW() - INTERVAL '15 minutes'
        ORDER BY next_retry_at ASC, id ASC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM oms.oms_orders oo
        WHERE oo.status NOT IN ('cancelled', 'shipped')
          AND oo.financial_status IN ('paid', 'partially_paid')
          AND oo.created_at > NOW() - INTERVAL '14 days'
          AND NOT EXISTS (
            SELECT 1
            FROM wms.orders wo
            WHERE (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
               OR (wo.source_table_id = oo.id::text)
          )
      `,
      sql`
        SELECT oo.id, oo.external_order_number, oo.external_order_id, oo.status,
               oo.financial_status, oo.created_at
        FROM oms.oms_orders oo
        WHERE oo.status NOT IN ('cancelled', 'shipped')
          AND oo.financial_status IN ('paid', 'partially_paid')
          AND oo.created_at > NOW() - INTERVAL '14 days'
          AND NOT EXISTS (
            SELECT 1
            FROM wms.orders wo
            WHERE (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
               OR (wo.source_table_id = oo.id::text)
          )
        ORDER BY oo.created_at DESC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM wms.orders wo
        WHERE wo.warehouse_status IN ('ready', 'in_progress', 'ready_to_ship')
          AND wo.created_at > NOW() - INTERVAL '14 days'
          AND EXISTS (
            SELECT 1
            FROM wms.order_items oi
            WHERE oi.order_id = wo.id
              AND COALESCE(oi.requires_shipping, 1) <> 0
              AND COALESCE(oi.quantity, 0) > COALESCE(oi.fulfilled_quantity, 0)
          )
          AND NOT EXISTS (
            SELECT 1
            FROM oms.oms_orders oo
            WHERE (
                (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
                OR (wo.source_table_id = oo.id::text)
              )
              AND (
                oo.status IN ('cancelled', 'shipped', 'refunded')
                OR oo.financial_status = 'refunded'
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM wms.outbound_shipments os
            WHERE os.order_id = wo.id
              AND os.status <> 'voided'
          )
      `,
      sql`
        SELECT wo.id, wo.order_number, wo.warehouse_status, wo.created_at,
               wo.oms_fulfillment_order_id
        FROM wms.orders wo
        WHERE wo.warehouse_status IN ('ready', 'in_progress', 'ready_to_ship')
          AND wo.created_at > NOW() - INTERVAL '14 days'
          AND EXISTS (
            SELECT 1
            FROM wms.order_items oi
            WHERE oi.order_id = wo.id
              AND COALESCE(oi.requires_shipping, 1) <> 0
              AND COALESCE(oi.quantity, 0) > COALESCE(oi.fulfilled_quantity, 0)
          )
          AND NOT EXISTS (
            SELECT 1
            FROM oms.oms_orders oo
            WHERE (
                (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
                OR (wo.source_table_id = oo.id::text)
              )
              AND (
                oo.status IN ('cancelled', 'shipped', 'refunded')
                OR oo.financial_status = 'refunded'
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM wms.outbound_shipments os
            WHERE os.order_id = wo.id
              AND os.status <> 'voided'
          )
        ORDER BY wo.created_at DESC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM wms.outbound_shipments os
        JOIN wms.orders wo ON wo.id = os.order_id
        WHERE os.status IN ('planned', 'queued')
          AND os.created_at < NOW() - INTERVAL '15 minutes'
          AND os.engine_order_ref IS NULL
          -- Exclude shipments already flagged for operator review: a permanent
          -- push failure (e.g. bad address/total/country) stamps requires_review
          -- and must NOT be auto-re-enqueued (it surfaces in the requires-review
          -- bucket instead). Prevents the permanent-error dead-letter loop.
          AND COALESCE(os.requires_review, false) = false
          AND COALESCE(os.held, false) = false
          AND wo.warehouse_status NOT IN ('cancelled', 'shipped')
          AND EXISTS (
            SELECT 1
            FROM wms.outbound_shipment_items osi
            JOIN wms.order_items oi ON oi.id = osi.order_item_id
            WHERE osi.shipment_id = os.id
              AND COALESCE(oi.requires_shipping, 1) <> 0
              AND COALESCE(osi.qty, 0) > 0
          )
          AND NOT EXISTS (
            SELECT 1
            FROM oms.oms_orders oo
            WHERE (
                (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
                OR (wo.source_table_id = oo.id::text)
              )
              AND (
                oo.status IN ('cancelled', 'shipped', 'refunded')
                OR oo.financial_status = 'refunded'
              )
          )
      `,
      sql`
        SELECT os.id AS shipment_id, os.order_id, wo.order_number,
               os.status, os.created_at
        FROM wms.outbound_shipments os
        JOIN wms.orders wo ON wo.id = os.order_id
        WHERE os.status IN ('planned', 'queued')
          AND os.created_at < NOW() - INTERVAL '15 minutes'
          AND os.engine_order_ref IS NULL
          -- Exclude shipments already flagged for operator review: a permanent
          -- push failure (e.g. bad address/total/country) stamps requires_review
          -- and must NOT be auto-re-enqueued (it surfaces in the requires-review
          -- bucket instead). Prevents the permanent-error dead-letter loop.
          AND COALESCE(os.requires_review, false) = false
          AND COALESCE(os.held, false) = false
          AND wo.warehouse_status NOT IN ('cancelled', 'shipped')
          AND EXISTS (
            SELECT 1
            FROM wms.outbound_shipment_items osi
            JOIN wms.order_items oi ON oi.id = osi.order_item_id
            WHERE osi.shipment_id = os.id
              AND COALESCE(oi.requires_shipping, 1) <> 0
              AND COALESCE(osi.qty, 0) > 0
          )
          AND NOT EXISTS (
            SELECT 1
            FROM oms.oms_orders oo
            WHERE (
                (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
                OR (wo.source_table_id = oo.id::text)
              )
              AND (
                oo.status IN ('cancelled', 'shipped', 'refunded')
                OR oo.financial_status = 'refunded'
              )
          )
        ORDER BY os.created_at ASC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM wms.outbound_shipments
        WHERE requires_review = true
          AND status NOT IN ('cancelled', 'voided', 'shipped')
      `,
      sql`
        SELECT id AS shipment_id, order_id, status, review_reason, updated_at
        FROM wms.outbound_shipments
        WHERE requires_review = true
          AND status NOT IN ('cancelled', 'voided', 'shipped')
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM wms.outbound_shipments
        WHERE held = true
          AND COALESCE(source, '') <> 'line_item_hold'
      `,
      sql`
        SELECT id AS shipment_id, order_id, status, on_hold_reason, review_reason,
               requires_review, updated_at
        FROM wms.outbound_shipments
        WHERE held = true
          AND COALESCE(source, '') <> 'line_item_hold'
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM wms.outbound_shipments os
        JOIN wms.orders wo ON wo.id = os.order_id
        JOIN oms.oms_orders oo ON (
             (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
          OR (wo.source_table_id = oo.id::text)
        )
        JOIN channels.channels c ON c.id = oo.channel_id
        WHERE oo.status IN ('shipped', 'partially_shipped')
          AND os.status = 'shipped'
          AND os.shipped_at < NOW() - INTERVAL '1 hour'
          AND os.shipped_at > NOW() - INTERVAL '14 days'
          AND c.provider IN ('ebay', 'shopify')
          AND EXISTS (
            SELECT 1
            FROM wms.outbound_shipment_items osi
            JOIN wms.order_items oi ON oi.id = osi.order_item_id
            WHERE osi.shipment_id = os.id
              AND COALESCE(oi.requires_shipping, 1) <> 0
              AND COALESCE(osi.qty, 0) > 0
          )
          AND NOT (
            (
              c.provider = 'shopify'
              AND NULLIF(os.shopify_fulfillment_id, '') IS NOT NULL
            )
            OR EXISTS (
              SELECT 1
              FROM oms.oms_order_events e
              WHERE e.order_id = oo.id
                AND e.details->>'wmsShipmentId' = os.id::text
                AND (
                  (c.provider = 'shopify' AND e.event_type IN ('shopify_fulfillment_pushed', 'shopify_fulfillment_reconciled'))
                  OR (c.provider = 'ebay' AND e.event_type = 'tracking_pushed')
                )
            )
          )
      `,
      sql`
        SELECT oo.id, os.id AS shipment_id, oo.external_order_number,
               c.provider, os.shipped_at, os.tracking_number,
               os.carrier, oo.status AS oms_status
        FROM wms.outbound_shipments os
        JOIN wms.orders wo ON wo.id = os.order_id
        JOIN oms.oms_orders oo ON (
             (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
          OR (wo.source_table_id = oo.id::text)
        )
        JOIN channels.channels c ON c.id = oo.channel_id
        WHERE oo.status IN ('shipped', 'partially_shipped')
          AND os.status = 'shipped'
          AND os.shipped_at < NOW() - INTERVAL '1 hour'
          AND os.shipped_at > NOW() - INTERVAL '14 days'
          AND c.provider IN ('ebay', 'shopify')
          AND EXISTS (
            SELECT 1
            FROM wms.outbound_shipment_items osi
            JOIN wms.order_items oi ON oi.id = osi.order_item_id
            WHERE osi.shipment_id = os.id
              AND COALESCE(oi.requires_shipping, 1) <> 0
              AND COALESCE(osi.qty, 0) > 0
          )
          AND NOT (
            (
              c.provider = 'shopify'
              AND NULLIF(os.shopify_fulfillment_id, '') IS NOT NULL
            )
            OR EXISTS (
              SELECT 1
              FROM oms.oms_order_events e
              WHERE e.order_id = oo.id
                AND e.details->>'wmsShipmentId' = os.id::text
                AND (
                  (c.provider = 'shopify' AND e.event_type IN ('shopify_fulfillment_pushed', 'shopify_fulfillment_reconciled'))
                  OR (c.provider = 'ebay' AND e.event_type = 'tracking_pushed')
                )
            )
          )
        ORDER BY os.shipped_at ASC, os.id ASC
        LIMIT 10
      `,
    ),
    // P5: line-item (pre-order) holds aged past HELD_LINE_AGING_DAYS. Each held
    // line lives in its own held shipment (source='line_item_hold', held=true,
    // held_at set at hold time); once released, held flips false and it ships. A
    // still-held line this old likely means the PO was cancelled or never landed.
    countAndSample(
      db,
      heldLineAgingCountQuery(),
      heldLineAgingSampleQuery(10),
    ),
    // P5: whole-order pre-order exception — every shippable line is held and
    // nothing has shipped yet, so there is no ship-now shipment and the order
    // silently sits. Informational (an all-pre-order order is a valid state), but
    // surfaced so ops can confirm it is intended rather than a mis-hold.
    countAndSample(
      db,
      allLinesHeldCountQuery(),
      allLinesHeldSampleQuery(10),
    ),
  ]);
  const channelWriteback = await getChannelWritebackHealth(db, {
    windowDays: 14,
    sampleLimit: 50,
  });

  const issues: OmsOpsIssue[] = [
    ...flowReconciliationIssues,
    ...(process.env.DISABLE_SCHEDULERS === "true"
      ? []
      : [
          issue({
            code: "WEBHOOK_RETRY_WORKER_NOT_STARTED",
            severity: "critical",
            count: webhookRetryHeartbeat.startedAt ? 0 : 1,
            message: "Webhook retry worker has not started in this process.",
            sample: [webhookRetryHeartbeat],
          }),
          issue({
            code: "WEBHOOK_RETRY_WORKER_STALE",
            severity: "critical",
            count: webhookRetryWorkerIsStale ? 1 : 0,
            message: "Webhook retry worker has not run in more than 5 minutes.",
            sample: [webhookRetryHeartbeat],
          }),
          issue({
            code: "OMS_FLOW_RECONCILIATION_SCHEDULER_NOT_STARTED",
            severity: "critical",
            count: reconciliationHeartbeat.startedAt ? 0 : 1,
            message: "OMS flow reconciliation scheduler has not started in this process.",
            sample: [reconciliationHeartbeat],
          }),
          issue({
            code: "OMS_FLOW_RECONCILIATION_SCHEDULER_STALE",
            severity: "critical",
            count: reconciliationSchedulerIsStale ? 1 : 0,
            message: "OMS flow reconciliation scheduler has not run in more than 30 minutes.",
            sample: [reconciliationHeartbeat],
          }),
          issue({
            code: "OMS_OPS_ALERT_SCHEDULER_NOT_STARTED",
            severity: "critical",
            count: alertHeartbeat.startedAt ? 0 : 1,
            message: "OMS ops alert scheduler has not started in this process.",
            sample: [alertHeartbeat],
          }),
          issue({
            code: "OMS_OPS_ALERT_SCHEDULER_STALE",
            severity: "critical",
            count: alertSchedulerIsStale ? 1 : 0,
            message: "OMS ops alert scheduler has not run in more than 15 minutes.",
            sample: [alertHeartbeat],
          }),
          issue({
            code: "EBAY_ORDER_POLL_NOT_STARTED",
            severity: "critical",
            count: ebayOrderPollHeartbeat.startedAt ? 0 : 1,
            message: "The eBay order safety-net poller has not started in this process.",
            sample: [ebayOrderPollHeartbeat],
          }),
          issue({
            code: "EBAY_ORDER_POLL_STALE",
            severity: "critical",
            count: ebayOrderPollIsStale ? 1 : 0,
            message: "The eBay order safety-net poller has not run in more than 15 minutes.",
            sample: [ebayOrderPollHeartbeat],
          }),
          issue({
            code: "EBAY_ORDER_POLL_FAILED",
            severity: "critical",
            count: ebayOrderPollHeartbeat.lastError ? 1 : 0,
            message: "The latest eBay order safety-net poll failed; durable order retries may be pending.",
            sample: [ebayOrderPollHeartbeat],
          }),
        ]),
    issue({
      code: "WEBHOOK_INBOX_FAILED",
      severity: "critical",
      count: failedInbox.count,
      message: "Webhook inbox rows failed or dead-lettered after receipt.",
      sample: failedInbox.sample,
    }),
    issue({
      code: "WEBHOOK_INBOX_STALE_PROCESSING",
      severity: "critical",
      count: staleProcessingInbox.count,
      message: "Webhook inbox rows are stuck in processing and need replay or operator action.",
      sample: staleProcessingInbox.sample,
    }),
    issue({
      code: "WEBHOOK_RETRY_DEAD",
      severity: "critical",
      count: deadRetries.count,
      message: "Webhook retry rows are dead-lettered and need operator action.",
      sample: deadRetries.sample,
    }),
    issue({
      code: "WEBHOOK_RETRY_STALE_DUE",
      severity: "critical",
      count: staleDueRetries.count,
      message: "Webhook retry rows are overdue by more than 15 minutes; the retry worker may be stalled.",
      sample: staleDueRetries.sample,
    }),
    issue({
      code: "WEBHOOK_RETRY_DUE",
      severity: "warning",
      count: pendingRetries.count,
      message: "Webhook retry rows are due now and waiting for the worker.",
      sample: pendingRetries.sample,
    }),
    issue({
      code: "OMS_PAID_WITHOUT_WMS",
      severity: "critical",
      count: omsWithoutWms.count,
      message: "Paid OMS orders have not reached WMS.",
      sample: omsWithoutWms.sample,
    }),
    issue({
      code: "WMS_READY_WITHOUT_SHIPMENT",
      severity: "critical",
      count: wmsWithoutShipment.count,
      message: "Ready WMS orders have no outbound shipment row.",
      sample: wmsWithoutShipment.sample,
    }),
    issue({
      code: "WMS_PENDING_ITEM_WITHOUT_SHIPMENT",
      severity: "critical",
      count: wmsPendingItemsWithoutShipment.count,
      message: "Shippable WMS order items are pending but not attached to an active shipment.",
      sample: wmsPendingItemsWithoutShipment.sample,
    }),
    issue({
      code: "WMS_ITEM_WITHOUT_OMS_AUTHORITY",
      severity: "critical",
      count: activeWmsItemsWithoutOmsAuthority.count,
      message: "Active OMS-origin WMS items lack a valid OMS line authority reference.",
      sample: activeWmsItemsWithoutOmsAuthority.sample,
    }),
    issue({
      code: "OMS_LINE_AUTHORITY_OVER_MATERIALIZED",
      severity: "critical",
      count: omsLineAuthorityOverMaterialized.count,
      message: "Active WMS materialized quantity exceeds OMS line authority.",
      sample: omsLineAuthorityOverMaterialized.sample,
    }),
    issue({
      code: "WMS_RECONCILIATION_MANUAL_REVIEW",
      severity: "warning",
      count: reconciliationManualReviews.count,
      message: "Open OMS/WMS reconciliation exceptions need manual review, grouped by rule.",
      sample: reconciliationManualReviews.sample,
    }),
    issue({
      code: "SHIPSTATION_ORDER_ID_DUPLICATE",
      severity: "critical",
      count: duplicateShipStationOrderIds.count,
      message: "Active standalone shipments share a ShipStation order id.",
      sample: duplicateShipStationOrderIds.sample,
    }),
    issue({
      code: "SHIPSTATION_ORDER_KEY_DUPLICATE",
      severity: "critical",
      count: duplicateShipStationOrderKeys.count,
      message: "Active standalone shipments share a ShipStation order key.",
      sample: duplicateShipStationOrderKeys.sample,
    }),
    issue({
      code: "SHIPPING_ENGINE_ORDER_REF_DUPLICATE",
      severity: "critical",
      count: duplicateShippingEngineOrderRefs.count,
      message: "Active standalone shipments share a shipping-engine order reference.",
      sample: duplicateShippingEngineOrderRefs.sample,
    }),
    issue({
      code: "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION",
      severity: "critical",
      count: unpushedShipments.count,
      message: "Outbound shipments are old enough to have been pushed but have no ShipStation id.",
      sample: unpushedShipments.sample,
    }),
    issue({
      code: "SHIPMENT_REQUIRES_REVIEW",
      severity: "warning",
      count: reviewShipments.count,
      message: "WMS shipments are flagged for warehouse-ops review.",
      sample: reviewShipments.sample,
    }),
    issue({
      code: "SHIPMENT_ON_HOLD",
      severity: "warning",
      count: onHoldShipments.count,
      message: "Whole-shipment holds need warehouse-ops review (pre-order line holds excluded).",
      sample: onHoldShipments.sample,
    }),
    issue({
      code: "LINE_HELD_AGING",
      severity: "warning",
      count: heldLineAging.count,
      message: `Pre-order line holds have aged past ${HELD_LINE_AGING_DAYS} days — chase the PO or cancel the line.`,
      sample: heldLineAging.sample,
    }),
    issue({
      code: "ORDER_ALL_LINES_HELD",
      severity: "info",
      count: allLinesHeldOrders.count,
      message: "Orders have every shippable line held with nothing shipped yet — no ship-now shipment exists.",
      sample: allLinesHeldOrders.sample,
    }),
    issue({
      code: "SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
      severity: "critical",
      count: shippedTrackingNotPushed.count,
      message: "Shipped WMS shipments do not have a tracking/fulfillment push success event.",
      sample: shippedTrackingNotPushed.sample,
    }),
    issue({
      code: "CHANNEL_WRITEBACK_MASKED_SPLIT",
      severity: "critical",
      count: channelWriteback.masked,
      message: "A channel writeback is missing but another shipment made the order look complete.",
      sample: channelWriteback.exceptions.filter((row) => row.state === "masked"),
    }),
  ].filter((entry) => entry.count > 0);

  const counts = issues.reduce(
    (acc, entry) => {
      acc[entry.severity] += entry.count;
      return acc;
    },
    { critical: 0, warning: 0, info: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    status: counts.critical > 0 ? "critical" : counts.warning > 0 ? "degraded" : "healthy",
    workers: {
      webhookRetry: webhookRetryHeartbeat,
      omsFlowReconciliation: reconciliationHeartbeat,
      omsOpsAlert: alertHeartbeat,
      ebayOrderPoll: ebayOrderPollHeartbeat,
    },
    counts,
    issues,
    channelWriteback,
  };
}
