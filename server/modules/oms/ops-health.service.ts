import { sql } from "drizzle-orm";

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
  counts: {
    critical: number;
    warning: number;
    info: number;
  };
  issues: OmsOpsIssue[];
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
  const [
    failedInbox,
    staleProcessingInbox,
    deadRetries,
    pendingRetries,
    omsWithoutWms,
    wmsWithoutShipment,
    unpushedShipments,
    reviewShipments,
    shippedTrackingNotPushed,
  ] = await Promise.all([
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
        SELECT id, provider, topic, attempts, last_error, updated_at
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
          AND next_retry_at <= NOW()
      `,
      sql`
        SELECT id, provider, topic, attempts, next_retry_at, last_error
        FROM oms.webhook_retry_queue
        WHERE status = 'pending'
          AND next_retry_at <= NOW()
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
          AND NOT EXISTS (
            SELECT 1 FROM wms.outbound_shipments os WHERE os.order_id = wo.id
          )
      `,
      sql`
        SELECT wo.id, wo.order_number, wo.warehouse_status, wo.created_at,
               wo.oms_fulfillment_order_id
        FROM wms.orders wo
        WHERE wo.warehouse_status IN ('ready', 'in_progress', 'ready_to_ship')
          AND wo.created_at > NOW() - INTERVAL '14 days'
          AND NOT EXISTS (
            SELECT 1 FROM wms.outbound_shipments os WHERE os.order_id = wo.id
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
          AND os.shipstation_order_id IS NULL
          AND wo.warehouse_status NOT IN ('cancelled', 'shipped')
      `,
      sql`
        SELECT os.id AS shipment_id, os.order_id, wo.order_number,
               os.status, os.created_at
        FROM wms.outbound_shipments os
        JOIN wms.orders wo ON wo.id = os.order_id
        WHERE os.status IN ('planned', 'queued')
          AND os.created_at < NOW() - INTERVAL '15 minutes'
          AND os.shipstation_order_id IS NULL
          AND wo.warehouse_status NOT IN ('cancelled', 'shipped')
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
        FROM oms.oms_orders oo
        JOIN channels.channels c ON c.id = oo.channel_id
        WHERE oo.status = 'shipped'
          AND oo.shipped_at < NOW() - INTERVAL '1 hour'
          AND oo.shipped_at > NOW() - INTERVAL '14 days'
          AND c.provider IN ('ebay', 'shopify')
          AND NOT EXISTS (
            SELECT 1
            FROM oms.oms_order_events e
            WHERE e.order_id = oo.id
              AND e.event_type IN ('tracking_pushed', 'shopify_fulfillment_pushed')
          )
      `,
      sql`
        SELECT oo.id, oo.external_order_number, c.provider, oo.shipped_at,
               oo.tracking_number, oo.tracking_carrier
        FROM oms.oms_orders oo
        JOIN channels.channels c ON c.id = oo.channel_id
        WHERE oo.status = 'shipped'
          AND oo.shipped_at < NOW() - INTERVAL '1 hour'
          AND oo.shipped_at > NOW() - INTERVAL '14 days'
          AND c.provider IN ('ebay', 'shopify')
          AND NOT EXISTS (
            SELECT 1
            FROM oms.oms_order_events e
            WHERE e.order_id = oo.id
              AND e.event_type IN ('tracking_pushed', 'shopify_fulfillment_pushed')
          )
        ORDER BY oo.shipped_at ASC
        LIMIT 10
      `,
    ),
  ]);

  const issues: OmsOpsIssue[] = [
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
      code: "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION",
      severity: "warning",
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
      code: "SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
      severity: "warning",
      count: shippedTrackingNotPushed.count,
      message: "Shipped OMS orders do not have a tracking/fulfillment push success event.",
      sample: shippedTrackingNotPushed.sample,
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
    counts,
    issues,
  };
}
