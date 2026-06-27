import { sql } from "drizzle-orm";
import { cancelOrder, markOrderShipped } from "../orders/order-status-core";
import type { OmsOpsIssue } from "./ops-health.service";
import {
  enqueueDelayedTrackingPush,
  enqueueOmsWmsSyncRetry,
  enqueueShopifyFulfillmentRetry,
  enqueueShipStationShipmentPushRetry,
  enqueueWmsShipmentCreateRetry,
} from "./webhook-retry.worker";

const LOG_PREFIX = "[OMS Flow Reconciliation]";
const LOCK_ID = 918405;
const REMEDIABLE_CODES = new Set([
  "OMS_PAID_WITHOUT_WMS",
  "WMS_READY_WITHOUT_SHIPMENT",
  "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION",
  "OMS_FINAL_WMS_ACTIVE",
  "WMS_FINAL_OMS_OPEN",
  "SHIPMENT_SHIPPED_OMS_OPEN",
  "SHOPIFY_SHIPMENT_FULFILLMENT_NOT_PUSHED",
  "WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
  "SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
]);
const AUTO_TRACKING_RETRY_LIMIT = 10;
const AUTO_FLOW_REMEDIATION_LIMIT = 10;
let reconciliationSchedulerStartedAt: Date | null = null;
let reconciliationSchedulerLastRunAt: Date | null = null;
let reconciliationSchedulerLastSuccessAt: Date | null = null;
let reconciliationSchedulerLastError: string | null = null;

export interface OmsFlowReconciliationSchedulerHeartbeat {
  startedAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export function getOmsFlowReconciliationSchedulerHeartbeat(): OmsFlowReconciliationSchedulerHeartbeat {
  return {
    startedAt: reconciliationSchedulerStartedAt?.toISOString() ?? null,
    lastRunAt: reconciliationSchedulerLastRunAt?.toISOString() ?? null,
    lastSuccessAt: reconciliationSchedulerLastSuccessAt?.toISOString() ?? null,
    lastError: reconciliationSchedulerLastError,
  };
}

export function resetOmsFlowReconciliationSchedulerHeartbeatForTests(): void {
  reconciliationSchedulerStartedAt = null;
  reconciliationSchedulerLastRunAt = null;
  reconciliationSchedulerLastSuccessAt = null;
  reconciliationSchedulerLastError = null;
}

export interface OmsFlowRemediationInput {
  code: string;
  omsOrderId?: number;
  wmsOrderId?: number;
  shipmentId?: number;
  operator: string;
}

export interface OmsFlowRemediationResult {
  code: string;
  action: string;
  changed: boolean;
  omsOrderId: number | null;
  wmsOrderId: number | null;
  shipmentId: number | null;
  retryQueueId?: number | null;
}

function getDefaultDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../db").db;
}

function getWithAdvisoryLock(): <T>(lockId: number, fn: () => Promise<T>) => Promise<T | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../infrastructure/scheduler-lock").withAdvisoryLock;
}

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function countFrom(result: any): number {
  return Number(rows(result)[0]?.count ?? 0) || 0;
}

function firstRow<T>(result: any): T | undefined {
  return rows(result)[0] as T | undefined;
}

function positiveInt(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

async function withOptionalTransaction<T>(db: any, fn: (tx: any) => Promise<T>): Promise<T> {
  if (typeof db.transaction === "function") {
    return db.transaction(fn);
  }
  return fn(db);
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

export async function collectOmsFlowReconciliationIssues(db: any): Promise<OmsOpsIssue[]> {
  const [
    omsFinalWmsActive,
    wmsFinalOmsOpen,
    shipmentShippedOmsOpen,
    wmsShippedNoTrackingPush,
    omsPaidWithoutWms,
    wmsReadyWithoutShipment,
    unpushedShipStationShipments,
    shopifyShipmentFulfillmentMissing,
    partitionDuplicateLineCoverage,
  ] = await Promise.all([
    countAndSample(
      db,
      sql`
        SELECT COUNT(*)::int AS count
        FROM oms.oms_orders oo
        JOIN wms.orders wo ON (
             (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
          OR (wo.source_table_id = oo.id::text)
        )
        WHERE (
            oo.status IN ('cancelled', 'shipped', 'refunded')
            OR oo.financial_status = 'refunded'
          )
          AND wo.warehouse_status IN ('ready', 'in_progress', 'ready_to_ship', 'picking', 'packed')
          AND oo.updated_at < NOW() - INTERVAL '10 minutes'
      `,
      sql`
        SELECT oo.id AS oms_order_id, oo.external_order_number, oo.status AS oms_status,
               oo.financial_status, wo.id AS wms_order_id, wo.order_number,
               wo.warehouse_status, oo.updated_at
        FROM oms.oms_orders oo
        JOIN wms.orders wo ON (
             (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
          OR (wo.source_table_id = oo.id::text)
        )
        WHERE (
            oo.status IN ('cancelled', 'shipped', 'refunded')
            OR oo.financial_status = 'refunded'
          )
          AND wo.warehouse_status IN ('ready', 'in_progress', 'ready_to_ship', 'picking', 'packed')
          AND oo.updated_at < NOW() - INTERVAL '10 minutes'
        ORDER BY oo.updated_at ASC
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
        SELECT oo.id AS oms_order_id, oo.external_order_number, oo.external_order_id,
               oo.status, oo.financial_status, oo.created_at
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
        SELECT wo.id AS wms_order_id, wo.order_number, wo.warehouse_status,
               wo.created_at, NULLIF(wo.oms_fulfillment_order_id, '') AS oms_order_id
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
        FROM wms.orders wo
        JOIN oms.oms_orders oo ON (
             (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
          OR (wo.source_table_id = oo.id::text)
        )
        WHERE wo.warehouse_status IN ('cancelled', 'shipped')
          AND oo.status NOT IN ('cancelled', 'shipped', 'partially_shipped', 'refunded')
          AND wo.updated_at < NOW() - INTERVAL '10 minutes'
      `,
      sql`
        SELECT wo.id AS wms_order_id, wo.order_number, wo.warehouse_status,
               oo.id AS oms_order_id, oo.external_order_number, oo.status AS oms_status,
               wo.updated_at
        FROM wms.orders wo
        JOIN oms.oms_orders oo ON (
             (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
          OR (wo.source_table_id = oo.id::text)
        )
        WHERE wo.warehouse_status IN ('cancelled', 'shipped')
          AND oo.status NOT IN ('cancelled', 'shipped', 'partially_shipped', 'refunded')
          AND wo.updated_at < NOW() - INTERVAL '10 minutes'
        ORDER BY wo.updated_at ASC
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
        WHERE os.status = 'shipped'
          AND oo.status NOT IN ('shipped', 'partially_shipped')
          AND os.updated_at < NOW() - INTERVAL '10 minutes'
      `,
      sql`
        SELECT os.id AS shipment_id, os.order_id AS wms_order_id, os.tracking_number,
               os.carrier, os.shipped_at, oo.id AS oms_order_id,
               oo.external_order_number, oo.status AS oms_status
        FROM wms.outbound_shipments os
        JOIN wms.orders wo ON wo.id = os.order_id
        JOIN oms.oms_orders oo ON (
             (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
          OR (wo.source_table_id = oo.id::text)
        )
        WHERE os.status = 'shipped'
          AND oo.status NOT IN ('shipped', 'partially_shipped')
          AND os.updated_at < NOW() - INTERVAL '10 minutes'
        ORDER BY os.updated_at ASC
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
        WHERE os.status = 'shipped'
          AND os.shipped_at < NOW() - INTERVAL '1 hour'
          AND os.shipped_at > NOW() - INTERVAL '14 days'
          AND c.provider IN ('ebay', 'shopify')
          AND NOT EXISTS (
            SELECT 1
            FROM oms.oms_order_events e
            WHERE e.order_id = oo.id
              AND e.event_type IN ('tracking_pushed', 'shopify_fulfillment_pushed')
          )
      `,
      sql`
        SELECT os.id AS shipment_id, os.order_id AS wms_order_id, os.shipped_at,
               os.tracking_number, os.carrier, oo.id AS oms_order_id,
               oo.external_order_number, c.provider
        FROM wms.outbound_shipments os
        JOIN wms.orders wo ON wo.id = os.order_id
        JOIN oms.oms_orders oo ON (
             (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
          OR (wo.source_table_id = oo.id::text)
        )
        JOIN channels.channels c ON c.id = oo.channel_id
        WHERE os.status = 'shipped'
          AND os.shipped_at < NOW() - INTERVAL '1 hour'
          AND os.shipped_at > NOW() - INTERVAL '14 days'
          AND c.provider IN ('ebay', 'shopify')
          AND NOT EXISTS (
            SELECT 1
            FROM oms.oms_order_events e
            WHERE e.order_id = oo.id
              AND e.event_type IN ('tracking_pushed', 'shopify_fulfillment_pushed')
          )
        ORDER BY os.shipped_at ASC
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
        SELECT os.id AS shipment_id, os.order_id AS wms_order_id,
               wo.order_number, os.status, os.created_at,
               NULLIF(wo.oms_fulfillment_order_id, '') AS oms_order_id
        FROM wms.outbound_shipments os
        JOIN wms.orders wo ON wo.id = os.order_id
        WHERE os.status IN ('planned', 'queued')
          AND os.created_at < NOW() - INTERVAL '15 minutes'
          AND os.engine_order_ref IS NULL
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
        FROM wms.outbound_shipments os
        JOIN wms.orders wo ON wo.id = os.order_id
        JOIN oms.oms_orders oo ON (
             (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
          OR (wo.source_table_id = oo.id::text)
        )
        JOIN channels.channels c ON c.id = oo.channel_id
        WHERE os.status = 'shipped'
          AND os.shipped_at < NOW() - INTERVAL '10 minutes'
          AND os.shipped_at > NOW() - INTERVAL '14 days'
          AND c.provider = 'shopify'
          AND os.shopify_fulfillment_id IS NULL
          AND COALESCE(oo.fulfillment_status, 'unfulfilled') <> 'fulfilled'
          AND NOT EXISTS (
            SELECT 1
            FROM oms.webhook_retry_queue q
            WHERE q.provider = 'internal'
              AND q.topic = 'shopify_fulfillment_push'
              AND q.status = 'pending'
              AND q.payload->>'shipmentId' = os.id::text
          )
      `,
      sql`
        SELECT os.id AS shipment_id, os.order_id AS wms_order_id, os.shipped_at,
               os.tracking_number, os.carrier, oo.id AS oms_order_id,
               oo.external_order_number, os.shopify_fulfillment_id
        FROM wms.outbound_shipments os
        JOIN wms.orders wo ON wo.id = os.order_id
        JOIN oms.oms_orders oo ON (
             (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
          OR (wo.source_table_id = oo.id::text)
        )
        JOIN channels.channels c ON c.id = oo.channel_id
        WHERE os.status = 'shipped'
          AND os.shipped_at < NOW() - INTERVAL '10 minutes'
          AND os.shipped_at > NOW() - INTERVAL '14 days'
          AND c.provider = 'shopify'
          AND os.shopify_fulfillment_id IS NULL
          AND COALESCE(oo.fulfillment_status, 'unfulfilled') <> 'fulfilled'
          AND NOT EXISTS (
            SELECT 1
            FROM oms.webhook_retry_queue q
            WHERE q.provider = 'internal'
              AND q.topic = 'shopify_fulfillment_push'
              AND q.status = 'pending'
              AND q.payload->>'shipmentId' = os.id::text
          )
        ORDER BY os.shipped_at ASC
        LIMIT 10
      `,
    ),
    countAndSample(
      db,
      sql`
        WITH duplicate_line_coverage AS (
          SELECT
            ol.order_id AS oms_order_id,
            oi.oms_order_line_id,
            COUNT(DISTINCT wo.id)::int AS wms_order_count
          FROM wms.order_items oi
          JOIN wms.orders wo ON wo.id = oi.order_id
          JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
          WHERE oi.oms_order_line_id IS NOT NULL
            AND COALESCE(wo.source, '') IN ('oms', 'shopify', 'ebay')
            AND wo.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
            AND wo.cancelled_at IS NULL
            AND wo.completed_at IS NULL
            AND COALESCE(oi.status, '') NOT IN ('cancelled', 'completed', 'short')
            AND COALESCE(oi.quantity, 0) > 0
          GROUP BY ol.order_id, oi.oms_order_line_id
          HAVING COUNT(DISTINCT wo.id) > 1
        )
        SELECT COUNT(*)::int AS count
        FROM duplicate_line_coverage
      `,
      sql`
        WITH duplicate_line_coverage AS (
          SELECT
            ol.order_id AS oms_order_id,
            oi.oms_order_line_id,
            ol.sku,
            ol.authority_fulfillable_quantity,
            SUM(COALESCE(oi.quantity, 0))::int AS materialized_quantity,
            COUNT(DISTINCT wo.id)::int AS wms_order_count,
            ARRAY_AGG(DISTINCT wo.id) AS wms_order_ids,
            ARRAY_AGG(DISTINCT COALESCE(wo.warehouse_id, 0)) AS warehouse_ids,
            ARRAY_AGG(DISTINCT COALESCE(NULLIF(wo.fulfillment_partition_key, ''), 'default')) AS fulfillment_partition_keys,
            ARRAY_AGG(DISTINCT oi.id) AS wms_order_item_ids
          FROM wms.order_items oi
          JOIN wms.orders wo ON wo.id = oi.order_id
          JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
          WHERE oi.oms_order_line_id IS NOT NULL
            AND COALESCE(wo.source, '') IN ('oms', 'shopify', 'ebay')
            AND wo.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
            AND wo.cancelled_at IS NULL
            AND wo.completed_at IS NULL
            AND COALESCE(oi.status, '') NOT IN ('cancelled', 'completed', 'short')
            AND COALESCE(oi.quantity, 0) > 0
          GROUP BY ol.order_id, oi.oms_order_line_id, ol.sku, ol.authority_fulfillable_quantity
          HAVING COUNT(DISTINCT wo.id) > 1
        )
        SELECT *
        FROM duplicate_line_coverage
        ORDER BY wms_order_count DESC, oms_order_line_id DESC
        LIMIT 10
      `,
    ),
  ]);

  const issues: OmsOpsIssue[] = [
    {
      code: "OMS_FINAL_WMS_ACTIVE",
      severity: "critical" as const,
      count: omsFinalWmsActive.count,
      message: "OMS orders are final but linked WMS orders are still active.",
      sample: omsFinalWmsActive.sample,
    },
    {
      code: "WMS_FINAL_OMS_OPEN",
      severity: "critical" as const,
      count: wmsFinalOmsOpen.count,
      message: "WMS orders are final but linked OMS orders are still open.",
      sample: wmsFinalOmsOpen.sample,
    },
    {
      code: "SHIPMENT_SHIPPED_OMS_OPEN",
      severity: "critical" as const,
      count: shipmentShippedOmsOpen.count,
      message: "WMS shipments are shipped but linked OMS orders are not shipped.",
      sample: shipmentShippedOmsOpen.sample,
    },
    {
      code: "WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
      severity: "critical" as const,
      count: wmsShippedNoTrackingPush.count,
      message: "Shipped WMS shipments do not have a channel tracking push success event.",
      sample: wmsShippedNoTrackingPush.sample,
    },
    {
      code: "OMS_PAID_WITHOUT_WMS",
      severity: "critical" as const,
      count: omsPaidWithoutWms.count,
      message: "Paid OMS orders have not reached WMS.",
      sample: omsPaidWithoutWms.sample,
    },
    {
      code: "WMS_READY_WITHOUT_SHIPMENT",
      severity: "critical" as const,
      count: wmsReadyWithoutShipment.count,
      message: "Ready WMS orders have no outbound shipment row.",
      sample: wmsReadyWithoutShipment.sample,
    },
    {
      code: "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION",
      severity: "critical" as const,
      count: unpushedShipStationShipments.count,
      message: "Outbound shipments are old enough to have been pushed but have no ShipStation id.",
      sample: unpushedShipStationShipments.sample,
    },
    {
      code: "SHOPIFY_SHIPMENT_FULFILLMENT_NOT_PUSHED",
      severity: "critical" as const,
      count: shopifyShipmentFulfillmentMissing.count,
      message: "Shopify WMS shipments are shipped but have no Shopify fulfillment id.",
      sample: shopifyShipmentFulfillmentMissing.sample,
    },
    {
      code: "WMS_PARTITION_DUPLICATE_LINE_COVERAGE",
      severity: "critical" as const,
      count: partitionDuplicateLineCoverage.count,
      message: "Active WMS fulfillment partitions cover the same OMS order line.",
      sample: partitionDuplicateLineCoverage.sample,
    },
  ];

  return issues.filter((entry) => entry.count > 0);
}

export async function runOmsFlowReconciliation(dbArg: any = getDefaultDb()): Promise<OmsOpsIssue[]> {
  const issues = await collectOmsFlowReconciliationIssues(dbArg);
  if (issues.length > 0) {
    const summary = issues.map((issue) => `${issue.code}=${issue.count}`).join(", ");
    console.warn(`${LOG_PREFIX} detected flow issues: ${summary}`);
  }
  await autoCloseResolvedDeadFulfillmentRetries(dbArg);
  await autoRemediateCriticalFlowIssues(dbArg, issues);
  await autoQueueStaleTrackingPushRetries(dbArg, issues);
  await autoQueueStaleShipStationPushRetries(dbArg, issues);
  await autoQueueMissingShopifyFulfillmentRetries(dbArg, issues);
  return issues;
}

export async function autoCloseResolvedDeadFulfillmentRetries(db: any): Promise<number> {
  const result = await db.execute(sql`
    WITH candidates AS (
      SELECT
        q.id,
        q.topic,
        q.created_at,
        q.updated_at AS dead_at,
        CASE
          WHEN q.payload->>'shipmentId' ~ '^[0-9]+$'
            THEN (q.payload->>'shipmentId')::bigint
          ELSE NULL
        END AS payload_shipment_id,
        CASE
          WHEN q.payload->>'orderId' ~ '^[0-9]+$'
            THEN (q.payload->>'orderId')::bigint
          ELSE NULL
        END AS payload_order_id,
        CASE
          WHEN q.payload->>'omsOrderId' ~ '^[0-9]+$'
            THEN (q.payload->>'omsOrderId')::bigint
          ELSE NULL
        END AS payload_oms_order_id,
        NULLIF(q.payload->>'trackingNumber', '') AS payload_tracking_number,
        COALESCE(
          NULLIF(q.payload->>'shopifyFulfillmentId', ''),
          NULLIF(q.payload->>'fulfillmentId', '')
        ) AS payload_fulfillment_id
      FROM oms.webhook_retry_queue q
      WHERE q.provider = 'internal'
        AND q.status = 'dead'
        AND q.topic IN ('delayed_tracking_push', 'shopify_fulfillment_push')
    ),
    scoped_candidates AS (
      SELECT
        c.*,
        os.id AS shipment_id,
        NULLIF(os.tracking_number, '') AS shipment_tracking_number,
        NULLIF(os.shopify_fulfillment_id, '') AS shipment_shopify_fulfillment_id,
        COALESCE(payload_oo.id, shipment_oo.id) AS oms_order_id,
        (
             c.payload_shipment_id IS NOT NULL
          OR c.payload_tracking_number IS NOT NULL
          OR c.payload_fulfillment_id IS NOT NULL
          OR NULLIF(os.tracking_number, '') IS NOT NULL
          OR NULLIF(os.shopify_fulfillment_id, '') IS NOT NULL
        ) AS has_specific_scope
      FROM candidates c
      LEFT JOIN wms.outbound_shipments os ON os.id = c.payload_shipment_id
      LEFT JOIN wms.orders wo ON wo.id = os.order_id
      LEFT JOIN oms.oms_orders shipment_oo ON (
           (wo.source = 'oms' AND wo.oms_fulfillment_order_id = shipment_oo.id::text)
        OR (wo.source_table_id = shipment_oo.id::text)
      )
      LEFT JOIN oms.oms_orders payload_oo
        ON payload_oo.id = COALESCE(c.payload_order_id, c.payload_oms_order_id)
    ),
    resolved AS (
      SELECT DISTINCT c.id
      FROM scoped_candidates c
      JOIN oms.oms_order_events e
        ON e.created_at >= COALESCE(c.dead_at, c.created_at)
       AND (
            (c.topic = 'delayed_tracking_push'
              AND e.event_type IN ('tracking_pushed', 'shopify_fulfillment_pushed'))
         OR (c.topic = 'shopify_fulfillment_push'
              AND e.event_type = 'shopify_fulfillment_pushed')
       )
      WHERE (c.oms_order_id IS NULL OR e.order_id = c.oms_order_id)
        AND (
             (c.shipment_id IS NOT NULL
               AND e.details->>'wmsShipmentId' = c.shipment_id::text)
          OR (c.payload_shipment_id IS NOT NULL
               AND e.details->>'wmsShipmentId' = c.payload_shipment_id::text)
          OR (c.shipment_tracking_number IS NOT NULL
               AND e.details->>'trackingNumber' = c.shipment_tracking_number)
          OR (c.payload_tracking_number IS NOT NULL
               AND e.details->>'trackingNumber' = c.payload_tracking_number)
          OR (c.shipment_shopify_fulfillment_id IS NOT NULL
               AND e.details->>'shopifyFulfillmentId' = c.shipment_shopify_fulfillment_id)
          OR (c.shipment_shopify_fulfillment_id IS NOT NULL
               AND e.details->>'fulfillmentId' = c.shipment_shopify_fulfillment_id)
          OR (c.payload_fulfillment_id IS NOT NULL
               AND e.details->>'shopifyFulfillmentId' = c.payload_fulfillment_id)
          OR (c.payload_fulfillment_id IS NOT NULL
               AND e.details->>'fulfillmentId' = c.payload_fulfillment_id)
          OR (c.has_specific_scope = false AND c.oms_order_id IS NOT NULL)
        )
    )
    UPDATE oms.webhook_retry_queue q
    SET status = 'success',
        last_error = 'auto-closed: later OMS fulfillment/tracking event confirmed success',
        updated_at = NOW()
    FROM resolved
    WHERE q.id = resolved.id
      AND q.status = 'dead'
    RETURNING q.id
  `);

  const closed = rows(result).filter((row) => row?.id != null).length;
  if (closed > 0) {
    console.warn(`${LOG_PREFIX} auto-closed ${closed} resolved fulfillment/tracking retry row(s)`);
  }
  return closed;
}

async function autoRemediateCriticalFlowIssues(
  db: any,
  issues: OmsOpsIssue[],
): Promise<void> {
  const mappings: Array<{
    code: string;
    inputFromSample: (sample: any) => Omit<OmsFlowRemediationInput, "operator"> | null;
  }> = [
    {
      code: "OMS_FINAL_WMS_ACTIVE",
      inputFromSample: (sample) => {
        const omsOrderId = Number(sample.oms_order_id);
        const wmsOrderId = Number(sample.wms_order_id);
        return Number.isInteger(omsOrderId) && omsOrderId > 0 &&
          Number.isInteger(wmsOrderId) && wmsOrderId > 0
          ? { code: "OMS_FINAL_WMS_ACTIVE", omsOrderId, wmsOrderId }
          : null;
      },
    },
    {
      code: "OMS_PAID_WITHOUT_WMS",
      inputFromSample: (sample) => {
        const omsOrderId = Number(sample.oms_order_id ?? sample.id);
        return Number.isInteger(omsOrderId) && omsOrderId > 0
          ? { code: "OMS_PAID_WITHOUT_WMS", omsOrderId }
          : null;
      },
    },
    {
      code: "WMS_READY_WITHOUT_SHIPMENT",
      inputFromSample: (sample) => {
        const wmsOrderId = Number(sample.wms_order_id ?? sample.id);
        return Number.isInteger(wmsOrderId) && wmsOrderId > 0
          ? { code: "WMS_READY_WITHOUT_SHIPMENT", wmsOrderId }
          : null;
      },
    },
    {
      code: "WMS_FINAL_OMS_OPEN",
      inputFromSample: (sample) => {
        const omsOrderId = Number(sample.oms_order_id);
        const wmsOrderId = Number(sample.wms_order_id);
        return Number.isInteger(omsOrderId) && omsOrderId > 0 &&
          Number.isInteger(wmsOrderId) && wmsOrderId > 0
          ? { code: "WMS_FINAL_OMS_OPEN", omsOrderId, wmsOrderId }
          : null;
      },
    },
    {
      code: "SHIPMENT_SHIPPED_OMS_OPEN",
      inputFromSample: (sample) => {
        const omsOrderId = Number(sample.oms_order_id);
        const shipmentId = Number(sample.shipment_id);
        return Number.isInteger(omsOrderId) && omsOrderId > 0 &&
          Number.isInteger(shipmentId) && shipmentId > 0
          ? { code: "SHIPMENT_SHIPPED_OMS_OPEN", omsOrderId, shipmentId }
          : null;
      },
    },
    {
      code: "WMS_READY_WITHOUT_SHIPMENT",
      inputFromSample: (sample) => {
        const wmsOrderId = Number(sample.wms_order_id ?? sample.id);
        return Number.isInteger(wmsOrderId) && wmsOrderId > 0
          ? { code: "WMS_READY_WITHOUT_SHIPMENT", wmsOrderId }
          : null;
      },
    },
  ];

  for (const mapping of mappings) {
    const issue = issues.find((entry) => entry.code === mapping.code);
    if (!issue) continue;

    let changed = 0;
    for (const sample of issue.sample.slice(0, AUTO_FLOW_REMEDIATION_LIMIT)) {
      const remediationInput = mapping.inputFromSample(sample);
      if (!remediationInput) continue;

      try {
        const result = await remediateOmsFlowIssue(db, {
          ...remediationInput,
          operator: "scheduled_reconciliation",
        });
        if (result.changed) changed++;
      } catch (error: any) {
        console.warn(
          `${LOG_PREFIX} auto-remediation failed for ${mapping.code}: ${error?.message || error}`,
        );
      }
    }

    if (changed > 0) {
      console.warn(`${LOG_PREFIX} auto-remediated ${changed} ${mapping.code} row(s)`);
    }
  }
}

async function autoQueueStaleTrackingPushRetries(
  db: any,
  issues: OmsOpsIssue[],
): Promise<void> {
  const issue = issues.find((entry) => entry.code === "WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED");
  if (!issue) return;

  let queued = 0;
  for (const sample of issue.sample.slice(0, AUTO_TRACKING_RETRY_LIMIT)) {
    const row = sample as any;
    const omsOrderId = Number(row.oms_order_id);
    const shipmentId = Number(row.shipment_id);
    if (
      !Number.isInteger(omsOrderId) ||
      omsOrderId <= 0 ||
      !Number.isInteger(shipmentId) ||
      shipmentId <= 0
    ) {
      continue;
    }

    const existing = await db.execute(sql`
      SELECT id
      FROM oms.webhook_retry_queue
      WHERE provider = 'internal'
        AND topic = 'delayed_tracking_push'
        AND status = 'pending'
        AND (
             (payload->>'shipmentId') = ${String(shipmentId)}
          OR (
               (payload->>'orderId') = ${String(omsOrderId)}
           AND payload->>'shipmentId' IS NULL
          )
        )
      LIMIT 1
    `);
    if (rows(existing).length > 0) {
      continue;
    }

    await enqueueDelayedTrackingPush(db, omsOrderId, shipmentId);
    queued++;
  }

  if (queued > 0) {
    console.warn(`${LOG_PREFIX} auto-queued ${queued} delayed tracking push retry row(s)`);
  }
}

async function autoQueueStaleShipStationPushRetries(
  db: any,
  issues: OmsOpsIssue[],
): Promise<void> {
  const issue = issues.find((entry) => entry.code === "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION");
  if (!issue) return;

  let queued = 0;
  for (const sample of issue.sample.slice(0, AUTO_TRACKING_RETRY_LIMIT)) {
    const shipmentId = Number((sample as any).shipment_id);
    if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
      continue;
    }

    await enqueueShipStationShipmentPushRetry(
      db,
      shipmentId,
      new Error("scheduled reconciliation: shipment missing ShipStation order id"),
    );
    queued++;
  }

  if (queued > 0) {
    console.warn(`${LOG_PREFIX} auto-queued ${queued} ShipStation shipment push retry row(s)`);
  }
}

async function autoQueueMissingShopifyFulfillmentRetries(
  db: any,
  issues: OmsOpsIssue[],
): Promise<void> {
  const issue = issues.find((entry) => entry.code === "SHOPIFY_SHIPMENT_FULFILLMENT_NOT_PUSHED");
  if (!issue) return;

  let queued = 0;
  for (const sample of issue.sample.slice(0, AUTO_TRACKING_RETRY_LIMIT)) {
    const shipmentId = Number((sample as any).shipment_id);
    if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
      continue;
    }

    await enqueueShopifyFulfillmentRetry(
      db,
      shipmentId,
      new Error("scheduled reconciliation: shipped Shopify shipment missing fulfillment id"),
    );
    queued++;
  }

  if (queued > 0) {
    console.warn(`${LOG_PREFIX} auto-queued ${queued} Shopify fulfillment push retry row(s)`);
  }
}

export async function remediateOmsFlowIssue(
  db: any,
  input: OmsFlowRemediationInput,
): Promise<OmsFlowRemediationResult> {
  if (!REMEDIABLE_CODES.has(input.code)) {
    throw new Error(`Unsupported OMS flow remediation code: ${input.code}`);
  }

  if (input.code === "OMS_PAID_WITHOUT_WMS") {
    const omsOrderId = positiveInt(input.omsOrderId, "omsOrderId");
    const result = await db.execute(sql`
      SELECT oo.id
      FROM oms.oms_orders oo
      WHERE oo.id = ${omsOrderId}
        AND oo.status NOT IN ('cancelled', 'shipped')
        AND oo.financial_status IN ('paid', 'partially_paid')
        AND NOT EXISTS (
          SELECT 1
          FROM wms.orders wo
          WHERE (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
             OR (wo.source_table_id = oo.id::text)
        )
      LIMIT 1
    `);

    if (rows(result).length === 0) {
      return {
        code: input.code,
        action: "wms_sync_not_queued",
        changed: false,
        omsOrderId,
        wmsOrderId: null,
        shipmentId: null,
        retryQueueId: null,
      };
    }

    await enqueueOmsWmsSyncRetry(
      db,
      omsOrderId,
      new Error(`manual remediation by ${input.operator || "unknown"}`),
    );

    await db.execute(sql`
      INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
      VALUES (
        ${omsOrderId},
        'flow_reconciliation_remediated',
        ${JSON.stringify({ code: input.code, operator: input.operator })}::jsonb,
        NOW()
      )
    `);

    return {
      code: input.code,
      action: "queued_oms_wms_sync",
      changed: true,
      omsOrderId,
      wmsOrderId: null,
      shipmentId: null,
      retryQueueId: null,
    };
  }

  if (input.code === "WMS_READY_WITHOUT_SHIPMENT") {
    const wmsOrderId = positiveInt(input.wmsOrderId, "wmsOrderId");
    const result = await db.execute(sql`
      SELECT wo.id,
             NULLIF(wo.oms_fulfillment_order_id, '') AS oms_order_id
      FROM wms.orders wo
      WHERE wo.id = ${wmsOrderId}
        AND wo.warehouse_status IN ('ready', 'in_progress', 'ready_to_ship')
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
      LIMIT 1
    `);

    const row = firstRow<{ id: number; oms_order_id: string | null }>(result);
    if (!row) {
      return {
        code: input.code,
        action: "shipment_create_not_queued",
        changed: false,
        omsOrderId: null,
        wmsOrderId,
        shipmentId: null,
        retryQueueId: null,
      };
    }

    await enqueueWmsShipmentCreateRetry(
      db,
      wmsOrderId,
      new Error(`manual remediation by ${input.operator || "unknown"}`),
    );

    const omsOrderId = Number(row.oms_order_id);
    if (Number.isInteger(omsOrderId) && omsOrderId > 0) {
      await db.execute(sql`
        INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
        VALUES (
          ${omsOrderId},
          'flow_reconciliation_remediated',
          ${JSON.stringify({ code: input.code, wmsOrderId, operator: input.operator })}::jsonb,
          NOW()
        )
      `);
    }

    return {
      code: input.code,
      action: "queued_wms_shipment_create",
      changed: true,
      omsOrderId: Number.isInteger(omsOrderId) && omsOrderId > 0 ? omsOrderId : null,
      wmsOrderId,
      shipmentId: null,
      retryQueueId: null,
    };
  }

  if (input.code === "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION") {
    const shipmentId = positiveInt(input.shipmentId, "shipmentId");
    const result = await db.execute(sql`
      SELECT os.id, os.order_id AS wms_order_id,
             NULLIF(wo.oms_fulfillment_order_id, '') AS oms_order_id
      FROM wms.outbound_shipments os
      JOIN wms.orders wo ON wo.id = os.order_id
      WHERE os.id = ${shipmentId}
        AND os.status IN ('planned', 'queued')
        AND os.engine_order_ref IS NULL
        -- Skip shipments already flagged for review: a permanent push failure
        -- (bad address/total/country) won't succeed on re-push, so don't queue
        -- a guaranteed-dead retry. The operator must fix the data + clear the
        -- flag first. (Mirrors the SHIPMENT_NOT_PUSHED_TO_SHIPSTATION bucket.)
        AND COALESCE(os.requires_review, false) = false
        -- A held shipment (line-item hold) is intentionally unpushed; never
        -- auto-remediate it onto ShipStation.
        AND COALESCE(os.held, false) = false
        AND os.created_at < NOW() - INTERVAL '15 minutes'
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
      LIMIT 1
    `);

    const row = firstRow<{ wms_order_id: number; oms_order_id: string | null }>(result);
    if (!row) {
      return {
        code: input.code,
        action: "shipstation_push_not_queued",
        changed: false,
        omsOrderId: null,
        wmsOrderId: input.wmsOrderId ? Number(input.wmsOrderId) : null,
        shipmentId,
        retryQueueId: null,
      };
    }

    await enqueueShipStationShipmentPushRetry(
      db,
      shipmentId,
      new Error(`manual remediation by ${input.operator || "unknown"}`),
    );

    const omsOrderId = Number(row.oms_order_id);
    if (Number.isInteger(omsOrderId) && omsOrderId > 0) {
      await db.execute(sql`
        INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
        VALUES (
          ${omsOrderId},
          'flow_reconciliation_remediated',
          ${JSON.stringify({ code: input.code, shipmentId, operator: input.operator })}::jsonb,
          NOW()
        )
      `);
    }

    return {
      code: input.code,
      action: "queued_shipstation_shipment_push",
      changed: true,
      omsOrderId: Number.isInteger(omsOrderId) && omsOrderId > 0 ? omsOrderId : null,
      wmsOrderId: Number(row.wms_order_id),
      shipmentId,
      retryQueueId: null,
    };
  }

  if (input.code === "OMS_FINAL_WMS_ACTIVE") {
    const omsOrderId = positiveInt(input.omsOrderId, "omsOrderId");
    const wmsOrderId = positiveInt(input.wmsOrderId, "wmsOrderId");
    const updated = await withOptionalTransaction(db, async (tx) => {
      const omsResult: any = await tx.execute(sql`
        SELECT oo.status, oo.financial_status
        FROM oms.oms_orders oo
        JOIN wms.orders wo ON (
             (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
          OR (wo.source_table_id = oo.id::text)
        )
        WHERE oo.id = ${omsOrderId}
          AND wo.id = ${wmsOrderId}
          AND (oo.status IN ('cancelled', 'shipped', 'refunded') OR oo.financial_status = 'refunded')
        LIMIT 1
      `);
      const omsRow = omsResult?.rows?.[0];
      if (!omsRow) return false;

      const isCancelled = omsRow.status === "cancelled" || omsRow.status === "refunded" || omsRow.financial_status === "refunded";
      const transResult = isCancelled
        ? await cancelOrder(tx, wmsOrderId, `oms_flow_reconcile_${omsRow.status}`)
        : await markOrderShipped(tx, wmsOrderId, "oms_flow_reconcile_shipped");

      if (transResult.transitioned) {
        if (isCancelled) {
          await tx.execute(sql`UPDATE wms.orders SET assigned_picker_id = NULL WHERE id = ${wmsOrderId}`);
        }
        await tx.execute(sql`
          INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
          VALUES (
            ${omsOrderId},
            'flow_reconciliation_remediated',
            ${JSON.stringify({ code: input.code, wmsOrderId, operator: input.operator })}::jsonb,
            NOW()
          )
        `);
      }
      return transResult.transitioned;
    });

    return {
      code: input.code,
      action: "aligned_wms_from_oms",
      changed: updated,
      omsOrderId,
      wmsOrderId,
      shipmentId: null,
    };
  }

  if (input.code === "WMS_FINAL_OMS_OPEN") {
    const omsOrderId = positiveInt(input.omsOrderId, "omsOrderId");
    const wmsOrderId = positiveInt(input.wmsOrderId, "wmsOrderId");
    const updated = await withOptionalTransaction(db, async (tx) => {
      const result = await tx.execute(sql`
        WITH latest_shipment AS (
          SELECT tracking_number, carrier, shipped_at
          FROM wms.outbound_shipments
          WHERE order_id = ${wmsOrderId}
            AND status = 'shipped'
          ORDER BY shipped_at DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
          LIMIT 1
        )
        UPDATE oms.oms_orders oo
        SET status = CASE
              WHEN wo.warehouse_status = 'cancelled' THEN 'cancelled'
              WHEN wo.warehouse_status = 'shipped' THEN 'shipped'
              ELSE oo.status
            END,
            fulfillment_status = CASE
              WHEN wo.warehouse_status = 'shipped' THEN 'fulfilled'
              ELSE oo.fulfillment_status
            END,
            tracking_number = COALESCE((SELECT tracking_number FROM latest_shipment), oo.tracking_number),
            tracking_carrier = COALESCE((SELECT carrier FROM latest_shipment), oo.tracking_carrier),
            shipped_at = CASE
              WHEN wo.warehouse_status = 'shipped' THEN COALESCE((SELECT shipped_at FROM latest_shipment), oo.shipped_at, NOW())
              ELSE oo.shipped_at
            END,
            cancelled_at = CASE
              WHEN wo.warehouse_status = 'cancelled' THEN COALESCE(oo.cancelled_at, NOW())
              ELSE oo.cancelled_at
            END,
            updated_at = NOW()
        FROM wms.orders wo
        WHERE oo.id = ${omsOrderId}
          AND wo.id = ${wmsOrderId}
          AND (
               (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
            OR (wo.source_table_id = oo.id::text)
          )
          AND wo.warehouse_status IN ('cancelled', 'shipped')
          AND oo.status NOT IN ('cancelled', 'shipped', 'partially_shipped', 'refunded')
        RETURNING oo.id
      `);

      if (rows(result).length > 0) {
        await tx.execute(sql`
          INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
          VALUES (
            ${omsOrderId},
            'flow_reconciliation_remediated',
            ${JSON.stringify({ code: input.code, wmsOrderId, operator: input.operator })}::jsonb,
            NOW()
          )
        `);
      }
      return rows(result).length > 0;
    });

    return {
      code: input.code,
      action: "aligned_oms_from_wms",
      changed: updated,
      omsOrderId,
      wmsOrderId,
      shipmentId: null,
    };
  }

  if (input.code === "SHIPMENT_SHIPPED_OMS_OPEN") {
    const omsOrderId = positiveInt(input.omsOrderId, "omsOrderId");
    const shipmentId = positiveInt(input.shipmentId, "shipmentId");
    const updated = await withOptionalTransaction(db, async (tx) => {
      const result = await tx.execute(sql`
        UPDATE oms.oms_orders oo
        SET status = 'shipped',
            fulfillment_status = 'fulfilled',
            tracking_number = COALESCE(os.tracking_number, oo.tracking_number),
            tracking_carrier = COALESCE(os.carrier, oo.tracking_carrier),
            shipped_at = COALESCE(os.shipped_at, oo.shipped_at, NOW()),
            updated_at = NOW()
        FROM wms.outbound_shipments os
        JOIN wms.orders wo ON wo.id = os.order_id
        WHERE oo.id = ${omsOrderId}
          AND os.id = ${shipmentId}
          AND os.status = 'shipped'
          AND (
               (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
            OR (wo.source_table_id = oo.id::text)
          )
          AND oo.status NOT IN ('shipped', 'partially_shipped')
        RETURNING oo.id, os.order_id AS wms_order_id
      `);

      const row = firstRow<{ wms_order_id: number }>(result);
      if (row) {
        await tx.execute(sql`
          INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
          VALUES (
            ${omsOrderId},
            'flow_reconciliation_remediated',
            ${JSON.stringify({ code: input.code, shipmentId, operator: input.operator })}::jsonb,
            NOW()
          )
        `);
      }
      return row ?? null;
    });

    return {
      code: input.code,
      action: "marked_oms_shipped_from_wms_shipment",
      changed: Boolean(updated),
      omsOrderId,
      wmsOrderId: updated ? Number(updated.wms_order_id) : null,
      shipmentId,
    };
  }

  const omsOrderId = positiveInt(input.omsOrderId, "omsOrderId");
  const shipmentId = input.shipmentId == null
    ? undefined
    : positiveInt(input.shipmentId, "shipmentId");
  await enqueueDelayedTrackingPush(db, omsOrderId, shipmentId);

  return {
    code: input.code,
    action: "queued_tracking_push",
    changed: true,
    omsOrderId,
    wmsOrderId: input.wmsOrderId ? Number(input.wmsOrderId) : null,
    shipmentId: shipmentId ?? null,
    retryQueueId: null,
  };
}

export function startOmsFlowReconciliationScheduler(dbArg: any = getDefaultDb()): void {
  if (process.env.DISABLE_SCHEDULERS === "true") return;
  const withAdvisoryLock = getWithAdvisoryLock();
  reconciliationSchedulerStartedAt = new Date();

  const runLocked = () => {
    reconciliationSchedulerLastRunAt = new Date();
    return withAdvisoryLock(LOCK_ID, async () => {
      await runOmsFlowReconciliation(dbArg);
      reconciliationSchedulerLastSuccessAt = new Date();
      reconciliationSchedulerLastError = null;
    }).catch((err) => {
      reconciliationSchedulerLastError = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} scheduled run error: ${reconciliationSchedulerLastError}`);
    });
  };

  console.log(`${LOG_PREFIX} Scheduler started (every 15 minutes, dyno-safe lock)`);
  setTimeout(runLocked, 20_000);
  setInterval(runLocked, 15 * 60 * 1000);
}
