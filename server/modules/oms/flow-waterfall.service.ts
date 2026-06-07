/**
 * Order-Flow Waterfall — read-only feed for the Flow Monitor page.
 *
 * Composes a single funnel view of where orders diverge from the happy path:
 *   channel → OMS → WMS → shipping engine → channel write-back.
 *
 * READ-ONLY: every query is a SELECT; this service performs no writes and has
 * no side effects. It reuses getOmsOpsHealth() for the open-exception buckets
 * and adds 14-day throughput, channel mix, daily volume, live WMS state, and
 * the oms_order_events spine.
 *
 * NOTE on the top of the funnel: "did a channel order never reach OMS?" cannot
 * be derived from oms.* alone (a never-ingested order has no row anywhere). That
 * check belongs to the per-channel intake reconcilers; `intakeModel` records HOW
 * each channel is reconciled against its own order list rather than a count.
 */

import { sql } from "drizzle-orm";
import { getOmsOpsHealth, type OmsOpsHealthSummary, type OmsOpsIssue } from "./ops-health.service";

const DEFAULT_WINDOW_DAYS = 14;
const STATE_WINDOW_DAYS = 30;
const DIVERGENCE_WINDOW_DAYS = 90;
const EVENT_SPINE_LIMIT = 12;

export type FunnelStageKey =
  | "intake"
  | "oms_to_wms"
  | "wms_fulfill"
  | "engine_push"
  | "shipped"
  | "writeback";

/** Which funnel stage each ops-health issue code drops out of. */
const STAGE_FOR_CODE: Record<string, FunnelStageKey> = {
  WEBHOOK_INBOX_FAILED: "intake",
  WEBHOOK_INBOX_STALE_PROCESSING: "intake",
  WEBHOOK_RETRY_DEAD: "intake",
  WEBHOOK_RETRY_STALE_DUE: "intake",
  WEBHOOK_RETRY_DUE: "intake",
  OMS_PAID_WITHOUT_WMS: "oms_to_wms",
  WMS_READY_WITHOUT_SHIPMENT: "wms_fulfill",
  WMS_PENDING_ITEM_WITHOUT_SHIPMENT: "wms_fulfill",
  SHIPMENT_REQUIRES_REVIEW: "wms_fulfill",
  SHIPMENT_ON_HOLD: "wms_fulfill",
  SHIPMENT_NOT_PUSHED_TO_SHIPSTATION: "engine_push",
  SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED: "writeback",
};

export interface FlowFunnel {
  entered: number;
  reachedWms: number;
  hasShipment: number;
  shipped: number;
  trackingConfirmed: number;
}

export interface FlowIntakeModel {
  provider: string;
  model: "poll-primary" | "webhook-primary";
  cadenceSeconds: number;
  note: string;
}

export interface FlowDuplicates {
  // (1) OMS pushed duplicate work into picking — 2+ active (non-cancelled) WMS orders for one OMS order
  omsToPicking: number;
  // (2+3) An engine duplicated a shipment (WMS double-push OR engine-created extra): an order-item shipped
  //       beyond its ordered qty — Σ(outbound_shipment_items.qty) per order_item_id > order_items.quantity.
  //       Engine-agnostic (reads only the canonical shipment-item mapping) and split/combine-safe by construction.
  overShippedItems: number;
  // engine split items the adapter could not reconcile (requires_review = *_split_items_unmapped)
  unmappedEngineSplits: number;
  // duplicate OMS-order ingest attempts blocked by the unique index
  blockedDupOrders: number;
  sample: any[];
}

export interface FlowWaterfall {
  generatedAt: string;
  windowDays: number;
  funnel: FlowFunnel;
  channels: Array<{ provider: string; entered: number }>;
  volumePerDay: Array<{ day: string; orders: number }>;
  wmsBuckets: Array<{ status: string; count: number }>;
  eventSpine: Array<{ eventType: string; count: number }>;
  intakeModel: FlowIntakeModel[];
  // Over-processing (an order handled 2+ times) — the funnel can't see this.
  duplicates: FlowDuplicates;
  // The dead-letter backlog split into named root causes.
  deadLetterCauses: Array<{ cause: string; count: number }>;
  // Where OMS / WMS / shipping engine disagree.
  crossSystem: { wmsShippedOmsOpen: number; staleConfirmed: number; sample: any[] };
  // Past ship-by deadline but not shipped (marketplace late-shipment risk).
  sla: { breached: number; sample: any[] };
  /** Open exceptions, tagged with the funnel stage they drop out of. */
  issues: Array<OmsOpsIssue & { stage: FunnelStageKey | "other" }>;
  health: OmsOpsHealthSummary;
}

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}
function countOf(result: any): number {
  return Number(rows(result)[0]?.count ?? 0) || 0;
}

export async function getFlowWaterfall(
  db: any,
  opts: { windowDays?: number } = {},
): Promise<FlowWaterfall> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const win = sql`NOW() - make_interval(days => ${windowDays})`;
  const stateWin = sql`NOW() - make_interval(days => ${STATE_WINDOW_DAYS})`;
  // OMS↔WMS link is soft (no FK): match on oms_fulfillment_order_id or source_table_id.
  const link = sql`((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text))`;

  // Run the (already heavy) ops-health check first, THEN our queries in bounded
  // groups. Firing everything in one big Promise.all stacks ~35 concurrent queries
  // and exhausts the small Heroku Postgres pool ("timeout when trying to connect").
  const health = await getOmsOpsHealth(db);
  const [
    entered,
    reachedWms,
    hasShipment,
    shipped,
    trackingConfirmed,
    channelRows,
    volumeRows,
    wmsRows,
    eventRows,
  ] = await Promise.all([
    db.execute(sql`SELECT COUNT(*)::int AS count FROM oms.oms_orders oo WHERE oo.created_at > ${win}`),
    db.execute(sql`SELECT COUNT(DISTINCT oo.id)::int AS count FROM oms.oms_orders oo JOIN wms.orders wo ON ${link} WHERE oo.created_at > ${win}`),
    db.execute(sql`SELECT COUNT(DISTINCT oo.id)::int AS count FROM oms.oms_orders oo JOIN wms.orders wo ON ${link} JOIN wms.outbound_shipments os ON os.order_id = wo.id AND os.status <> 'voided' WHERE oo.created_at > ${win}`),
    db.execute(sql`SELECT COUNT(*)::int AS count FROM oms.oms_orders oo WHERE oo.created_at > ${win} AND oo.status = 'shipped'`),
    db.execute(sql`SELECT COUNT(DISTINCT oo.id)::int AS count FROM oms.oms_orders oo JOIN oms.oms_order_events e ON e.order_id = oo.id AND e.event_type IN ('tracking_pushed', 'shopify_fulfillment_pushed') WHERE oo.created_at > ${win}`),
    db.execute(sql`SELECT COALESCE(c.provider, 'unknown') AS provider, COUNT(*)::int AS entered FROM oms.oms_orders oo LEFT JOIN channels.channels c ON c.id = oo.channel_id WHERE oo.created_at > ${win} GROUP BY 1 ORDER BY 2 DESC`),
    db.execute(sql`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS orders FROM oms.oms_orders WHERE created_at > ${win} GROUP BY 1 ORDER BY 1`),
    db.execute(sql`SELECT warehouse_status AS status, COUNT(*)::int AS count FROM wms.orders WHERE created_at > ${stateWin} GROUP BY 1 ORDER BY 2 DESC`),
    db.execute(sql`SELECT event_type AS "eventType", COUNT(*)::int AS count FROM oms.oms_order_events WHERE created_at > ${stateWin} GROUP BY 1 ORDER BY 2 DESC LIMIT ${EVENT_SPINE_LIMIT}`),
  ]);

  const issues = (health.issues ?? []).map((i) => ({
    ...i,
    stage: (STAGE_FOR_CODE[i.code] ?? "other") as FunnelStageKey | "other",
  }));

  // ---- divergence lenses (all read-only) ----
  const divWin = sql`NOW() - make_interval(days => ${DIVERGENCE_WINDOW_DAYS})`;
  const [
    omsToPicking, overShipped, unmappedSplits, blockedDup, dupSampleRows,
    deadCauseRows, wmsShippedOmsOpen, staleConfirmed, slaBreach, slaSampleRows, crossSampleRows,
  ] = await Promise.all([
    // (1) OMS pushed duplicate work to picking: OMS order with 2+ ACTIVE (non-cancelled) WMS orders
    db.execute(sql`SELECT COUNT(*)::int AS count FROM (SELECT oo.id FROM oms.oms_orders oo JOIN wms.orders wo ON ${link} WHERE wo.warehouse_status <> 'cancelled' AND oo.created_at > ${divWin} GROUP BY oo.id HAVING COUNT(DISTINCT wo.id) > 1) t`),
    // (2+3) An engine duplicated a shipment: any order-item whose total shipped qty across active shipments
    // exceeds its ordered qty. Engine-agnostic + split/combine-safe (the canonical per-item mapping handles both).
    db.execute(sql`SELECT COUNT(*)::int AS count FROM (SELECT osi.order_item_id FROM wms.outbound_shipment_items osi JOIN wms.outbound_shipments os ON os.id = osi.shipment_id AND os.status NOT IN ('voided','cancelled') JOIN wms.order_items oi ON oi.id = osi.order_item_id WHERE os.created_at > ${divWin} GROUP BY osi.order_item_id HAVING SUM(osi.qty) > MAX(oi.quantity)) t`),
    // engine split items the adapter could not reconcile back onto order-items
    db.execute(sql`SELECT COUNT(*)::int AS count FROM wms.outbound_shipments WHERE review_reason LIKE '%split_items_unmapped%'`),
    // duplicate OMS-order ingest attempts blocked by the unique index
    db.execute(sql`SELECT COUNT(*)::int AS count FROM oms.webhook_inbox WHERE status IN ('failed','dead') AND last_error LIKE '%duplicate key value%'`),
    // sample of the real OMS→picking duplicates (human order numbers)
    db.execute(sql`SELECT oo.external_order_number, COUNT(DISTINCT wo.id)::int AS active_wms FROM oms.oms_orders oo JOIN wms.orders wo ON ${link} WHERE wo.warehouse_status <> 'cancelled' AND oo.created_at > ${divWin} GROUP BY oo.id, oo.external_order_number HAVING COUNT(DISTINCT wo.id) > 1 ORDER BY 2 DESC LIMIT 6`),
    db.execute(sql`SELECT cause, COUNT(*)::int AS count FROM (SELECT CASE
      WHEN last_error LIKE '%no fulfillment-order line item%' THEN 'shopify fulfillment: SKU not on the fulfillment order'
      WHEN last_error LIKE '%2 character country code%' THEN 'shipstation: country code must be 2 chars (400)'
      WHEN last_error LIKE '%Negative Inventory Guard%' THEN 'ship_notify: negative inventory (0 on-hand)'
      WHEN last_error LIKE '%cents must be >= 0%' THEN 'push: negative computed total'
      WHEN last_error LIKE '%total_cents%does not match%' THEN 'push: order total mismatch'
      WHEN last_error LIKE '%shipment not found%' THEN 'ship_notify: shipment not found'
      WHEN last_error LIKE '%no items with positive quantity%' THEN 'fulfillment: no positive-qty items'
      WHEN last_error LIKE '%timeout exceeded%' THEN 'db connect timeout (transient)'
      WHEN last_error LIKE '%Local API returned 500%' THEN 'internal API 500'
      WHEN last_error IS NULL THEN '(no message)'
      ELSE left(last_error, 60) END AS cause
      FROM oms.webhook_retry_queue WHERE status = 'dead') s GROUP BY cause ORDER BY 2 DESC LIMIT 12`),
    db.execute(sql`SELECT COUNT(DISTINCT oo.id)::int AS count FROM oms.oms_orders oo JOIN wms.orders wo ON ${link} WHERE oo.status NOT IN ('shipped','cancelled','refunded','partially_shipped') AND wo.warehouse_status = 'shipped' AND oo.created_at > ${divWin}`),
    db.execute(sql`SELECT COUNT(*)::int AS count FROM oms.oms_orders WHERE status = 'confirmed' AND created_at < NOW() - INTERVAL '2 days' AND created_at > ${divWin}`),
    db.execute(sql`SELECT COUNT(*)::int AS count FROM wms.orders WHERE warehouse_status IN ('ready','in_progress','picking','picked','packing','packed') AND sla_due_at IS NOT NULL AND sla_due_at < NOW()`),
    db.execute(sql`SELECT id AS wms_order_id, order_number, warehouse_status, sla_due_at FROM wms.orders WHERE warehouse_status IN ('ready','in_progress','picking','picked','packing','packed') AND sla_due_at IS NOT NULL AND sla_due_at < NOW() ORDER BY sla_due_at ASC LIMIT 6`),
    db.execute(sql`SELECT id, external_order_number, status, created_at FROM oms.oms_orders WHERE status = 'confirmed' AND created_at < NOW() - INTERVAL '2 days' AND created_at > ${divWin} ORDER BY created_at ASC LIMIT 6`),
  ]);

  const duplicates: FlowDuplicates = {
    omsToPicking: countOf(omsToPicking),
    overShippedItems: countOf(overShipped),
    unmappedEngineSplits: countOf(unmappedSplits),
    blockedDupOrders: countOf(blockedDup),
    sample: rows(dupSampleRows),
  };
  const deadLetterCauses = rows(deadCauseRows).map((r) => ({ cause: String(r.cause), count: Number(r.count) || 0 }));
  const crossSystem = {
    wmsShippedOmsOpen: countOf(wmsShippedOmsOpen),
    staleConfirmed: countOf(staleConfirmed),
    sample: rows(crossSampleRows),
  };
  const sla = { breached: countOf(slaBreach), sample: rows(slaSampleRows) };

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    funnel: {
      entered: countOf(entered),
      reachedWms: countOf(reachedWms),
      hasShipment: countOf(hasShipment),
      shipped: countOf(shipped),
      trackingConfirmed: countOf(trackingConfirmed),
    },
    channels: rows(channelRows).map((r) => ({ provider: String(r.provider), entered: Number(r.entered) || 0 })),
    volumePerDay: rows(volumeRows).map((r) => ({ day: String(r.day), orders: Number(r.orders) || 0 })),
    wmsBuckets: rows(wmsRows).map((r) => ({ status: String(r.status), count: Number(r.count) || 0 })),
    eventSpine: rows(eventRows).map((r) => ({ eventType: String(r.eventType), count: Number(r.count) || 0 })),
    intakeModel: [
      {
        provider: "ebay",
        model: "poll-primary",
        cadenceSeconds: 300,
        note: "eBay Fulfillment API polled every 5 min (4h lookback); intake self-reconciles, so eBay is not exposed to silent webhook-drop misses.",
      },
      {
        provider: "shopify",
        model: "webhook-primary",
        cadenceSeconds: 900,
        note: "Real-time webhooks plus a 15-min order-reconciliation sweep that pulls in any missing orders (POS, TikTok, dropped webhooks).",
      },
    ],
    duplicates,
    deadLetterCauses,
    crossSystem,
    sla,
    issues,
    health,
  };
}
