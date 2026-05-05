import { sql } from "drizzle-orm";
import type { OmsOpsIssue } from "./ops-health.service";

const LOG_PREFIX = "[OMS Flow Reconciliation]";
const LOCK_ID = 918405;

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
        WHERE oo.status IN ('cancelled', 'shipped', 'refunded')
          AND wo.warehouse_status IN ('ready', 'in_progress', 'ready_to_ship', 'picking', 'packed')
          AND oo.updated_at < NOW() - INTERVAL '10 minutes'
      `,
      sql`
        SELECT oo.id AS oms_order_id, oo.external_order_number, oo.status AS oms_status,
               wo.id AS wms_order_id, wo.order_number, wo.warehouse_status, oo.updated_at
        FROM oms.oms_orders oo
        JOIN wms.orders wo ON (
             (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
          OR (wo.source_table_id = oo.id::text)
        )
        WHERE oo.status IN ('cancelled', 'shipped', 'refunded')
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
      severity: "warning" as const,
      count: wmsShippedNoTrackingPush.count,
      message: "Shipped WMS shipments do not have a channel tracking push success event.",
      sample: wmsShippedNoTrackingPush.sample,
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
  return issues;
}

export function startOmsFlowReconciliationScheduler(dbArg: any = getDefaultDb()): void {
  if (process.env.DISABLE_SCHEDULERS === "true") return;
  const withAdvisoryLock = getWithAdvisoryLock();

  const runLocked = () =>
    withAdvisoryLock(LOCK_ID, async () => {
      await runOmsFlowReconciliation(dbArg);
    }).catch((err) => console.error(`${LOG_PREFIX} scheduled run error: ${err.message}`));

  console.log(`${LOG_PREFIX} Scheduler started (every 15 minutes, dyno-safe lock)`);
  setTimeout(runLocked, 20_000);
  setInterval(runLocked, 15 * 60 * 1000);
}
