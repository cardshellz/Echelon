/**
 * Order-Flow Waterfall — read-only feed for the Flow Monitor page.
 *
 * ECONOMICAL / POOL-SAFE: the app Postgres pool is tiny (max 3, see db.ts), so a
 * burst of concurrent queries here starves every other endpoint (webhooks, orders).
 * This runs entirely inside ONE read-only transaction — a single pooled connection,
 * queried SEQUENTIALLY — with a hard statement_timeout. It therefore uses at most
 * one of the three connections and can never run away. Windowing is on the INDEXED
 * `oms_orders.ordered_at` column and defaults to 30 days; larger ranges are opt-in
 * from the UI. Counts only (no per-row sample fan-out) to keep the query set small.
 */

import { sql } from "drizzle-orm";

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const STATEMENT_TIMEOUT = "8s";

export type FunnelStageKey =
  | "intake" | "oms_to_wms" | "wms_fulfill" | "engine_push" | "shipped" | "writeback";

export interface FlowDuplicates {
  omsToPicking: number;
  overShippedItems: number;
  unmappedEngineSplits: number;
  blockedDupOrders: number;
  sample: any[];
}
export interface FlowIntakeModel { provider: string; model: "poll-primary" | "webhook-primary"; cadenceSeconds: number; note: string }
export interface FlowFunnel { entered: number; reachedWms: number; hasShipment: number; shipped: number; trackingConfirmed: number }
export interface FlowIssue { code: string; severity: "critical" | "warning" | "info"; count: number; message: string; sample: any[]; stage: FunnelStageKey | "other" }

export interface FlowWaterfall {
  generatedAt: string;
  windowDays: number;
  funnel: FlowFunnel;
  channels: Array<{ provider: string; entered: number }>;
  volumePerDay: Array<{ day: string; orders: number }>;
  wmsBuckets: Array<{ status: string; count: number }>;
  eventSpine: Array<{ eventType: string; count: number }>;
  intakeModel: FlowIntakeModel[];
  duplicates: FlowDuplicates;
  deadLetterCauses: Array<{ cause: string; count: number }>;
  crossSystem: { wmsShippedOmsOpen: number; staleConfirmed: number; sample: any[] };
  sla: { breached: number; sample: any[] };
  issues: FlowIssue[];
  health: { generatedAt: string; status: "healthy" | "degraded" | "critical"; counts: { critical: number; warning: number; info: number } };
}

const STAGE_FOR_CODE: Record<string, FunnelStageKey> = {
  WEBHOOK_INBOX_FAILED: "intake",
  WEBHOOK_RETRY_DEAD: "intake",
  OMS_PAID_WITHOUT_WMS: "oms_to_wms",
  WMS_READY_WITHOUT_SHIPMENT: "wms_fulfill",
  SHIPMENT_REQUIRES_REVIEW: "wms_fulfill",
  SHIPMENT_ON_HOLD: "wms_fulfill",
  SHIPMENT_NOT_PUSHED_TO_SHIPSTATION: "engine_push",
  SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED: "writeback",
};
const ISSUE_META: Record<string, { severity: "critical" | "warning"; message: string }> = {
  WEBHOOK_INBOX_FAILED: { severity: "critical", message: "Webhook inbox rows failed or dead-lettered after receipt." },
  WEBHOOK_RETRY_DEAD: { severity: "critical", message: "Webhook retry rows are dead-lettered and need operator action." },
  OMS_PAID_WITHOUT_WMS: { severity: "critical", message: "Paid OMS orders have not reached WMS." },
  WMS_READY_WITHOUT_SHIPMENT: { severity: "critical", message: "Ready WMS orders have no outbound shipment row." },
  SHIPMENT_NOT_PUSHED_TO_SHIPSTATION: { severity: "critical", message: "Outbound shipments are old enough to have been pushed but have no engine id." },
  SHIPMENT_REQUIRES_REVIEW: { severity: "warning", message: "WMS shipments are flagged for warehouse-ops review." },
  SHIPMENT_ON_HOLD: { severity: "warning", message: "WMS shipments are on hold and need warehouse-ops review." },
  SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED: { severity: "critical", message: "Shipped OMS orders have no tracking/fulfillment push success event." },
};

function num(r: any): number {
  const v = Array.isArray(r?.rows) ? r.rows[0]?.count : undefined;
  return Number(v ?? 0) || 0;
}
function rows(r: any): any[] {
  return Array.isArray(r?.rows) ? r.rows : [];
}

export async function getFlowWaterfall(db: any, opts: { windowDays?: number } = {}): Promise<FlowWaterfall> {
  const windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(opts.windowDays || DEFAULT_WINDOW_DAYS)));

  return await db.transaction(async (tx: any) => {
    // One connection, read-only, hard-capped — cannot starve the 3-slot pool or run away.
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`));

    const win = sql`NOW() - make_interval(days => ${windowDays})`;
    const link = sql`((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text))`;

    // ---- funnel (windowed on the INDEXED ordered_at) ----
    const entered = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM oms.oms_orders oo WHERE oo.ordered_at > ${win}`));
    const reachedWms = num(await tx.execute(sql`SELECT COUNT(DISTINCT oo.id)::int AS count FROM oms.oms_orders oo JOIN wms.orders wo ON ${link} WHERE oo.ordered_at > ${win}`));
    const hasShipment = num(await tx.execute(sql`SELECT COUNT(DISTINCT oo.id)::int AS count FROM oms.oms_orders oo JOIN wms.orders wo ON ${link} JOIN wms.outbound_shipments os ON os.order_id = wo.id AND os.status <> 'voided' WHERE oo.ordered_at > ${win}`));
    const shipped = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM oms.oms_orders oo WHERE oo.ordered_at > ${win} AND oo.status = 'shipped'`));
    const trackingConfirmed = num(await tx.execute(sql`SELECT COUNT(DISTINCT oo.id)::int AS count FROM oms.oms_orders oo JOIN oms.oms_order_events e ON e.order_id = oo.id AND e.event_type IN ('tracking_pushed','shopify_fulfillment_pushed') WHERE oo.ordered_at > ${win}`));

    const channels = rows(await tx.execute(sql`SELECT COALESCE(c.provider,'unknown') AS provider, COUNT(*)::int AS entered FROM oms.oms_orders oo LEFT JOIN channels.channels c ON c.id = oo.channel_id WHERE oo.ordered_at > ${win} GROUP BY 1 ORDER BY 2 DESC`)).map((r) => ({ provider: String(r.provider), entered: Number(r.entered) || 0 }));
    const volumePerDay = rows(await tx.execute(sql`SELECT to_char(date_trunc('day', ordered_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS orders FROM oms.oms_orders WHERE ordered_at > ${win} GROUP BY 1 ORDER BY 1`)).map((r) => ({ day: String(r.day), orders: Number(r.orders) || 0 }));
    const wmsBuckets = rows(await tx.execute(sql`SELECT warehouse_status AS status, COUNT(*)::int AS count FROM wms.orders WHERE created_at > ${win} GROUP BY 1 ORDER BY 2 DESC`)).map((r) => ({ status: String(r.status), count: Number(r.count) || 0 }));
    const eventSpine = rows(await tx.execute(sql`SELECT event_type AS "eventType", COUNT(*)::int AS count FROM oms.oms_order_events WHERE created_at > ${win} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`)).map((r) => ({ eventType: String(r.eventType), count: Number(r.count) || 0 }));

    // ---- exception buckets (counts only) ----
    const bc: Record<string, number> = {};
    bc.WEBHOOK_INBOX_FAILED = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM oms.webhook_inbox WHERE status IN ('failed','dead')`));
    bc.WEBHOOK_RETRY_DEAD = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM oms.webhook_retry_queue WHERE status = 'dead'`));
    bc.OMS_PAID_WITHOUT_WMS = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM oms.oms_orders oo WHERE oo.status NOT IN ('cancelled','shipped') AND oo.financial_status IN ('paid','partially_paid') AND oo.ordered_at > ${win} AND NOT EXISTS (SELECT 1 FROM wms.orders wo WHERE (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text))`));
    // Match ops-health.service.ts: only orders that (a) still have a shippable, unfulfilled
    // item, and (b) are not already cancelled/shipped/refunded on the OMS side. Without these
    // guards, digital/membership-only and already-resolved orders inflate this critical count.
    bc.WMS_READY_WITHOUT_SHIPMENT = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM wms.orders wo WHERE wo.warehouse_status IN ('ready','in_progress','ready_to_ship') AND wo.created_at > ${win} AND EXISTS (SELECT 1 FROM wms.order_items oi WHERE oi.order_id = wo.id AND COALESCE(oi.requires_shipping,1) <> 0 AND COALESCE(oi.quantity,0) > COALESCE(oi.fulfilled_quantity,0)) AND NOT EXISTS (SELECT 1 FROM oms.oms_orders oo WHERE ((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text)) AND (oo.status IN ('cancelled','shipped','refunded') OR oo.financial_status = 'refunded')) AND NOT EXISTS (SELECT 1 FROM wms.outbound_shipments os WHERE os.order_id = wo.id AND os.status <> 'voided')`));
    // Match ops-health.service.ts: only shipments that actually carry a shippable, positive-qty
    // item, and whose OMS order isn't already cancelled/shipped/refunded.
    bc.SHIPMENT_NOT_PUSHED_TO_SHIPSTATION = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id = os.order_id WHERE os.status IN ('planned','queued') AND os.created_at < NOW() - INTERVAL '15 minutes' AND os.engine_order_ref IS NULL AND wo.warehouse_status NOT IN ('cancelled','shipped') AND EXISTS (SELECT 1 FROM wms.outbound_shipment_items osi JOIN wms.order_items oi ON oi.id = osi.order_item_id WHERE osi.shipment_id = os.id AND COALESCE(oi.requires_shipping,1) <> 0 AND COALESCE(osi.qty,0) > 0) AND NOT EXISTS (SELECT 1 FROM oms.oms_orders oo WHERE ((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text)) AND (oo.status IN ('cancelled','shipped','refunded') OR oo.financial_status = 'refunded'))`));
    bc.SHIPMENT_REQUIRES_REVIEW = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM wms.outbound_shipments WHERE requires_review = true AND status NOT IN ('cancelled','voided','shipped')`));
    bc.SHIPMENT_ON_HOLD = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM wms.outbound_shipments WHERE status = 'on_hold'`));
    bc.SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM oms.oms_orders oo JOIN channels.channels c ON c.id = oo.channel_id WHERE oo.status = 'shipped' AND oo.shipped_at < NOW() - INTERVAL '1 hour' AND oo.shipped_at > ${win} AND c.provider IN ('ebay','shopify') AND NOT EXISTS (SELECT 1 FROM oms.oms_order_events e WHERE e.order_id = oo.id AND e.event_type IN ('tracking_pushed','shopify_fulfillment_pushed'))`));

    const issues: FlowIssue[] = Object.entries(ISSUE_META)
      .map(([code, m]) => ({ code, severity: m.severity, count: bc[code] ?? 0, message: m.message, sample: [], stage: (STAGE_FOR_CODE[code] ?? "other") as FunnelStageKey | "other" }))
      .filter((i) => i.count > 0);
    const counts = issues.reduce((a, i) => { (a as any)[i.severity] += i.count; return a; }, { critical: 0, warning: 0, info: 0 });

    // ---- divergence lenses ----
    const overShipped = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM (SELECT osi.order_item_id FROM wms.outbound_shipment_items osi JOIN wms.outbound_shipments os ON os.id = osi.shipment_id AND os.status NOT IN ('voided','cancelled') JOIN wms.order_items oi ON oi.id = osi.order_item_id WHERE os.created_at > ${win} GROUP BY osi.order_item_id HAVING SUM(osi.qty) > MAX(oi.quantity)) t`));
    const omsToPicking = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM (SELECT oo.id FROM oms.oms_orders oo JOIN wms.orders wo ON ${link} WHERE wo.warehouse_status <> 'cancelled' AND oo.ordered_at > ${win} GROUP BY oo.id HAVING COUNT(DISTINCT wo.id) > 1) t`));
    const unmappedSplits = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM wms.outbound_shipments WHERE review_reason LIKE '%split_items_unmapped%'`));
    const blockedDup = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM oms.webhook_inbox WHERE status IN ('failed','dead') AND last_error LIKE '%duplicate key value%'`));

    const deadLetterCauses = rows(await tx.execute(sql`SELECT cause, COUNT(*)::int AS count FROM (SELECT CASE
      WHEN last_error LIKE '%no fulfillment-order line item%' THEN 'shopify fulfillment: SKU not on the fulfillment order'
      WHEN last_error LIKE '%2 character country code%' THEN 'shipstation: country code must be 2 chars (400)'
      WHEN last_error LIKE '%Negative Inventory Guard%' THEN 'ship_notify: negative inventory (0 on-hand)'
      WHEN last_error LIKE '%cents must be >= 0%' THEN 'push: negative computed total'
      WHEN last_error LIKE '%total_cents%does not match%' THEN 'push: order total mismatch'
      WHEN last_error LIKE '%shipment not found%' THEN 'ship_notify: shipment not found'
      WHEN last_error LIKE '%no items with positive quantity%' THEN 'fulfillment: no positive-qty items'
      WHEN last_error LIKE '%timeout exceeded%' THEN 'db connect timeout (transient)'
      WHEN last_error LIKE '%Local API returned 500%' THEN 'internal API 500'
      WHEN last_error IS NULL THEN '(no message)' ELSE left(last_error, 60) END AS cause
      FROM oms.webhook_retry_queue WHERE status = 'dead') s GROUP BY cause ORDER BY 2 DESC LIMIT 10`)).map((r) => ({ cause: String(r.cause), count: Number(r.count) || 0 }));

    const wmsShippedOmsOpen = num(await tx.execute(sql`SELECT COUNT(DISTINCT oo.id)::int AS count FROM oms.oms_orders oo JOIN wms.orders wo ON ${link} WHERE oo.status NOT IN ('shipped','cancelled','refunded','partially_shipped') AND wo.warehouse_status = 'shipped' AND oo.ordered_at > ${win}`));
    const staleConfirmed = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM oms.oms_orders WHERE status = 'confirmed' AND ordered_at < NOW() - INTERVAL '2 days' AND ordered_at > ${win}`));
    // Match the canonical SLA monitor (sla-monitor.service.ts): overdue = any non-terminal
    // order past its sla_due_at. The exclusion form correctly includes awaiting_3pl/ready_to_ship/exception.
    const slaBreached = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM wms.orders WHERE sla_due_at IS NOT NULL AND warehouse_status NOT IN ('shipped','completed','cancelled') AND sla_due_at < NOW()`));

    return {
      generatedAt: new Date().toISOString(),
      windowDays,
      funnel: { entered, reachedWms, hasShipment, shipped, trackingConfirmed },
      channels,
      volumePerDay,
      wmsBuckets,
      eventSpine,
      intakeModel: [
        { provider: "ebay", model: "poll-primary", cadenceSeconds: 300, note: "eBay Fulfillment API polled every 5 min (4h lookback); intake self-reconciles." },
        { provider: "shopify", model: "webhook-primary", cadenceSeconds: 900, note: "Real-time webhooks plus a 15-min order-reconciliation sweep." },
      ],
      duplicates: { omsToPicking, overShippedItems: overShipped, unmappedEngineSplits: unmappedSplits, blockedDupOrders: blockedDup, sample: [] },
      deadLetterCauses,
      crossSystem: { wmsShippedOmsOpen, staleConfirmed, sample: [] },
      sla: { breached: slaBreached, sample: [] },
      issues,
      health: { generatedAt: new Date().toISOString(), status: counts.critical > 0 ? "critical" : counts.warning > 0 ? "degraded" : "healthy", counts },
    };
  });
}

/**
 * On-demand drill-down: the offending rows for ONE exception bucket. Kept out of
 * getFlowWaterfall so the waterfall stays counts-only and cheap; this fires a
 * single LIMIT-capped query for just the bucket the user opened — same one
 * read-only transaction + statement_timeout contract, so still ≤1 pool connection.
 * Each window-scoped bucket mirrors the matching count query's WHERE clause exactly.
 */
export async function getFlowBucketSamples(
  db: any,
  code: string,
  opts: { windowDays?: number } = {},
): Promise<{ code: string; rows: any[] }> {
  const windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(opts.windowDays || DEFAULT_WINDOW_DAYS)));
  return await db.transaction(async (tx: any) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`));
    const win = sql`NOW() - make_interval(days => ${windowDays})`;
    const BUCKET: Record<string, any> = {
      WEBHOOK_INBOX_FAILED: sql`SELECT COALESCE(oo.external_order_number, wi.payload->>'name', wi.payload->>'order_number') AS order_number, wi.provider, wi.topic, wi.status, wi.attempts, wi.last_error, COALESCE(wi.processed_at, wi.last_attempt_at, wi.first_received_at) AS at, wi.id AS inbox_id FROM oms.webhook_inbox wi LEFT JOIN oms.oms_orders oo ON oo.external_order_id = COALESCE(wi.payload->>'order_id', wi.payload->>'id') WHERE wi.status IN ('failed','dead') ORDER BY COALESCE(wi.processed_at, wi.last_attempt_at, wi.first_received_at) DESC NULLS LAST LIMIT 50`,
      WEBHOOK_RETRY_DEAD: sql`SELECT COALESCE(rq.payload->>'name', rq.payload->>'order_number', rq.payload->>'orderNumber', wo.order_number) AS order_number, rq.payload->>'shipmentId' AS shipment_id, rq.provider, rq.topic, rq.attempts, rq.last_error, rq.next_retry_at, rq.updated_at AS at, rq.id AS retry_id FROM oms.webhook_retry_queue rq LEFT JOIN wms.outbound_shipments os ON os.id = NULLIF(rq.payload->>'shipmentId','')::int LEFT JOIN wms.orders wo ON wo.id = os.order_id WHERE rq.status = 'dead' ORDER BY rq.updated_at DESC NULLS LAST LIMIT 50`,
      OMS_PAID_WITHOUT_WMS: sql`SELECT oo.external_order_number AS order_number, oo.status, oo.financial_status, oo.ordered_at AS at FROM oms.oms_orders oo WHERE oo.status NOT IN ('cancelled','shipped') AND oo.financial_status IN ('paid','partially_paid') AND oo.ordered_at > ${win} AND NOT EXISTS (SELECT 1 FROM wms.orders wo WHERE (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text)) ORDER BY oo.ordered_at DESC LIMIT 50`,
      WMS_READY_WITHOUT_SHIPMENT: sql`SELECT wo.order_number, wo.warehouse_status, wo.created_at AS at FROM wms.orders wo WHERE wo.warehouse_status IN ('ready','in_progress','ready_to_ship') AND wo.created_at > ${win} AND EXISTS (SELECT 1 FROM wms.order_items oi WHERE oi.order_id = wo.id AND COALESCE(oi.requires_shipping,1) <> 0 AND COALESCE(oi.quantity,0) > COALESCE(oi.fulfilled_quantity,0)) AND NOT EXISTS (SELECT 1 FROM oms.oms_orders oo WHERE ((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text)) AND (oo.status IN ('cancelled','shipped','refunded') OR oo.financial_status = 'refunded')) AND NOT EXISTS (SELECT 1 FROM wms.outbound_shipments os WHERE os.order_id = wo.id AND os.status <> 'voided') ORDER BY wo.created_at DESC LIMIT 50`,
      SHIPMENT_NOT_PUSHED_TO_SHIPSTATION: sql`SELECT os.id AS shipment_id, wo.order_number, os.status, os.created_at AS at FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id = os.order_id WHERE os.status IN ('planned','queued') AND os.created_at < NOW() - INTERVAL '15 minutes' AND os.engine_order_ref IS NULL AND wo.warehouse_status NOT IN ('cancelled','shipped') AND EXISTS (SELECT 1 FROM wms.outbound_shipment_items osi JOIN wms.order_items oi ON oi.id = osi.order_item_id WHERE osi.shipment_id = os.id AND COALESCE(oi.requires_shipping,1) <> 0 AND COALESCE(osi.qty,0) > 0) AND NOT EXISTS (SELECT 1 FROM oms.oms_orders oo WHERE ((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text)) AND (oo.status IN ('cancelled','shipped','refunded') OR oo.financial_status = 'refunded')) ORDER BY os.created_at ASC LIMIT 50`,
      SHIPMENT_REQUIRES_REVIEW: sql`SELECT os.id AS shipment_id, wo.order_number, os.review_reason, os.created_at AS at FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id = os.order_id WHERE os.requires_review = true AND os.status NOT IN ('cancelled','voided','shipped') ORDER BY os.created_at DESC LIMIT 50`,
      SHIPMENT_ON_HOLD: sql`SELECT os.id AS shipment_id, wo.order_number, os.on_hold_reason, os.created_at AS at FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id = os.order_id WHERE os.status = 'on_hold' ORDER BY os.created_at DESC LIMIT 50`,
      SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED: sql`SELECT oo.external_order_number AS order_number, c.provider, oo.shipped_at AS at FROM oms.oms_orders oo JOIN channels.channels c ON c.id = oo.channel_id WHERE oo.status = 'shipped' AND oo.shipped_at < NOW() - INTERVAL '1 hour' AND oo.shipped_at > ${win} AND c.provider IN ('ebay','shopify') AND NOT EXISTS (SELECT 1 FROM oms.oms_order_events e WHERE e.order_id = oo.id AND e.event_type IN ('tracking_pushed','shopify_fulfillment_pushed')) ORDER BY oo.shipped_at DESC LIMIT 50`,
    };
    const query = BUCKET[code];
    if (!query) return { code, rows: [] };
    return { code, rows: rows(await tx.execute(query)) };
  });
}
