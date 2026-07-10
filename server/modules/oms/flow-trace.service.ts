/**
 * Per-order Flow Trace — read-only "life story" of a single order across the
 * whole flow: channel → OMS → WMS → shipment → shipping engine → write-back.
 *
 * Answers "where in our flow did THIS order go wrong?" by assembling the order's
 * cross-system records + raw webhook/event timeline, then computing a per-order
 * stage ladder that lands on the first divergence.
 *
 * READ-ONLY: SELECT only, no writes. Extends the existing getOrderFlowHistory
 * (webhook_inbox + webhook_retry_queue + events) with WMS + shipments + a
 * computed stage verdict. Stage is derived from events/WMS/shipments — never
 * from oms_orders.status alone (that field goes stale).
 */

import { sql } from "drizzle-orm";

export type TraceStageStatus = "done" | "current" | "failed" | "pending" | "skipped";

export interface TraceStage {
  key: string;
  label: string;
  status: TraceStageStatus;
  detail?: string;
}

export interface TraceTimelineEntry {
  id: string;
  source: "webhook_inbox" | "webhook_retry" | "reconciliation" | "alert" | "event";
  status: string;
  label: string;
  details: any;
  createdAt: string | null;
}

export interface FlowTrace {
  found: boolean;
  query: string;
  oms: {
    id: number;
    externalOrderNumber: string | null;
    externalOrderId: string | null;
    channel: string | null;
    status: string | null;
    financialStatus: string | null;
    trackingNumber: string | null;
    trackingCarrier: string | null;
    createdAt: string | null;
    shippedAt: string | null;
  } | null;
  wms: Array<{ id: number; warehouseStatus: string | null; createdAt: string | null; linkVia: string | null; active: boolean }>;
  shipments: Array<{
    id: number; wmsOrderId: number | null; status: string | null;
    engineOrderRef: string | null; shipstationOrderId: number | null;
    trackingNumber: string | null; shopifyFulfillmentId: string | null;
    hasShippableItems: boolean;
    requiresReview: boolean | null; reviewReason: string | null; onHoldReason: string | null;
    createdAt: string | null;
  }>;
  events: Array<{ eventType: string; details: any; createdAt: string | null }>;
  timeline: TraceTimelineEntry[];
  stages: TraceStage[];
  diverged: { stage: string; reason: string } | null;
}

function rows(r: any): any[] {
  return Array.isArray(r?.rows) ? r.rows : [];
}

/** Resolve an order by order number ("#58409" or "58409"), external id, or internal id. */
export async function getFlowTrace(db: any, ref: string): Promise<FlowTrace> {
  // One read-only connection with a hard statement_timeout — same pool-safety
  // contract as getFlowWaterfall, so an on-demand trace can never hold more than
  // one of the three pool slots, nor run away.
  return await db.transaction(async (tx: any) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '8s'`);
    return await traceWithin(tx, ref);
  });
}

async function traceWithin(db: any, ref: string): Promise<FlowTrace> {
  const raw = (ref ?? "").trim();
  const stripped = raw.replace(/^#/, "");
  const hashed = `#${stripped}`;

  const omsRows = rows(
    await db.execute(sql`
      SELECT oo.id, oo.external_order_number, oo.external_order_id, oo.status, oo.financial_status,
             oo.tracking_number, oo.tracking_carrier, oo.created_at, oo.shipped_at, c.provider
      FROM oms.oms_orders oo
      LEFT JOIN channels.channels c ON c.id = oo.channel_id
      WHERE oo.external_order_number IN (${raw}, ${hashed}, ${stripped})
         OR oo.external_order_id = ${stripped}
         OR oo.id::text = ${stripped}
      ORDER BY oo.created_at DESC
      LIMIT 1
    `),
  );

  if (omsRows.length === 0) {
    return { found: false, query: raw, oms: null, wms: [], shipments: [], events: [], timeline: [], stages: [], diverged: null };
  }
  const o = omsRows[0];
  const omsId: number = Number(o.id);

  // WMS orders linked via the soft OMS↔WMS link
  const wmsRows = rows(
    await db.execute(sql`
      SELECT id, warehouse_status, created_at,
             CASE WHEN source = 'oms' AND oms_fulfillment_order_id = ${String(omsId)} THEN 'oms_fulfillment_order_id'
                  WHEN source_table_id = ${String(omsId)} THEN 'source_table_id' ELSE NULL END AS link_via
      FROM wms.orders
      WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(omsId)}) OR source_table_id = ${String(omsId)}
      ORDER BY created_at ASC
    `),
  );
  const wmsIds = wmsRows.map((w) => Number(w.id));

  const shipmentRows = wmsIds.length
    ? rows(
        await db.execute(sql`
          SELECT id, order_id, status, engine_order_ref, shipstation_order_id,
                 tracking_number, shopify_fulfillment_id,
                 EXISTS (
                   SELECT 1
                   FROM wms.outbound_shipment_items osi
                   JOIN wms.order_items oi ON oi.id = osi.order_item_id
                   WHERE osi.shipment_id = wms.outbound_shipments.id
                     AND COALESCE(oi.requires_shipping, 1) <> 0
                     AND COALESCE(osi.qty, 0) > 0
                 ) AS has_shippable_items,
                 requires_review, review_reason, on_hold_reason, created_at
          FROM wms.outbound_shipments
          WHERE order_id = ANY(${wmsIds})
          ORDER BY created_at ASC
        `),
      )
    : [];

  const eventRows = rows(
    await db.execute(sql`
      SELECT event_type, details, created_at FROM oms.oms_order_events
      WHERE order_id = ${omsId} ORDER BY created_at ASC
    `),
  );

  // Raw webhook timeline (reuses the matching approach from getOrderFlowHistory)
  const externalIds = [o.external_order_id, o.external_order_number, String(omsId)].filter(Boolean) as string[];
  // Sequential (not Promise.all): inside the single-connection tx, two concurrent
  // queries would contend for the one connection. These two are cheap + LIMIT 20.
  const inbox = await db.execute(sql`
    SELECT id, provider, topic, status, attempts, last_error, first_received_at, last_attempt_at, processed_at, updated_at
    FROM oms.webhook_inbox
    WHERE payload->>'id' = ANY(${externalIds}) OR payload->>'order_id' = ANY(${externalIds})
       OR payload->>'admin_graphql_api_id' = ANY(${externalIds}) OR payload->>'name' = ANY(${externalIds})
    ORDER BY COALESCE(processed_at, last_attempt_at, first_received_at, updated_at) DESC NULLS LAST LIMIT 20
  `);
  const retries = await db.execute(sql`
    SELECT id, provider, topic, status, attempts, last_error, source_inbox_id, next_retry_at, created_at, updated_at
    FROM oms.webhook_retry_queue
    WHERE payload->>'id' = ANY(${externalIds}) OR payload->>'order_id' = ANY(${externalIds})
       OR payload->>'orderId' = ${String(omsId)} OR payload->>'name' = ANY(${externalIds})
    ORDER BY updated_at DESC NULLS LAST LIMIT 20
  `);

  const timeline: TraceTimelineEntry[] = [];
  for (const r of rows(inbox)) {
    timeline.push({ id: `webhook_inbox:${r.id}`, source: "webhook_inbox", status: r.status, label: `${r.provider}/${r.topic}`,
      details: { attempts: r.attempts, lastError: r.last_error }, createdAt: r.processed_at ?? r.last_attempt_at ?? r.first_received_at ?? r.updated_at ?? null });
  }
  for (const r of rows(retries)) {
    timeline.push({ id: `webhook_retry:${r.id}`, source: "webhook_retry", status: r.status, label: `${r.provider}/${r.topic}`,
      details: { attempts: r.attempts, lastError: r.last_error, nextRetryAt: r.next_retry_at }, createdAt: r.updated_at ?? r.created_at ?? null });
  }
  for (const r of eventRows) {
    const src = r.event_type === "flow_reconciliation_remediated" ? "reconciliation" : String(r.event_type).includes("failed") ? "alert" : "event";
    timeline.push({ id: `event:${r.event_type}:${r.created_at}`, source: src as any, status: r.event_type, label: r.event_type, details: r.details, createdAt: r.created_at ?? null });
  }
  timeline.sort((a, b) => (b.createdAt ? new Date(b.createdAt).getTime() : 0) - (a.createdAt ? new Date(a.createdAt).getTime() : 0));

  // ---- compute the per-order stage ladder (derived, not from oms.status alone) ----
  const eventTypes = new Set(eventRows.map((e) => String(e.event_type)));
  const activeWms = wmsRows.filter((w) => String(w.warehouse_status) !== "cancelled");
  const activeShipments = shipmentRows.filter((s) => !["voided", "cancelled"].includes(String(s.status)));
  const pushedShipments = activeShipments.filter((s) => s.engine_order_ref != null);
  const shippedShipments = shipmentRows.filter(
    (s) => String(s.status) === "shipped" && s.has_shippable_items !== false,
  );
  const channelWritebackRequired = ["shopify", "ebay"].includes(String(o.provider));
  const writebackCompleteCount = shippedShipments.filter((s) => {
    if (String(o.provider) === "shopify" && String(s.shopify_fulfillment_id ?? "").trim().length > 0) {
      return true;
    }
    return eventRows.some((event) => {
      const details = event.details && typeof event.details === "object" ? event.details : {};
      return String(details.wmsShipmentId ?? "") === String(s.id)
        && ((String(o.provider) === "shopify" && String(event.event_type) === "shopify_fulfillment_pushed")
          || (String(o.provider) === "ebay" && String(event.event_type) === "tracking_pushed"));
    });
  }).length;
  const allShippedShipmentsWrittenBack = shippedShipments.length > 0
    && writebackCompleteCount === shippedShipments.length;
  // A failed/dead inbox row only fails the ingestion stage when it was NOT
  // superseded by a later successful delivery of the same provider/topic.
  // Channels redeliver webhooks (and the retry worker replays them), so a
  // transient blip that self-healed must not paint a healthy order as
  // diverged — that's exactly the stale-flag false positive on the monitor.
  const inboxRows = rows(inbox);
  const inboxAt = (r: any): number => {
    const t = r.processed_at ?? r.last_attempt_at ?? r.first_received_at ?? r.updated_at;
    const ms = t ? new Date(t).getTime() : NaN;
    return Number.isFinite(ms) ? ms : 0;
  };
  const failedInboxRows = inboxRows.filter((r) => ["failed", "dead"].includes(String(r.status)));
  const unrecoveredInboxFailures = failedInboxRows.filter(
    (f) =>
      !inboxRows.some(
        (s) =>
          String(s.status) === "succeeded" &&
          String(s.provider) === String(f.provider) &&
          String(s.topic) === String(f.topic) &&
          inboxAt(s) >= inboxAt(f),
      ),
  );
  const recoveredInboxFailures = failedInboxRows.length - unrecoveredInboxFailures.length;
  const failedInbox = unrecoveredInboxFailures.length > 0;
  const deadRetry = rows(retries).find((r) => String(r.status) === "dead");

  const stages: TraceStage[] = [];
  const add = (key: string, label: string, status: TraceStageStatus, detail?: string) => stages.push({ key, label, status, detail });

  add("placed", "Channel order placed", "done", `${o.provider ?? "channel"} ${o.external_order_number ?? ""}`.trim());
  add(
    "ingested",
    "Ingested → OMS",
    failedInbox ? "failed" : "done",
    failedInbox
      ? "a webhook for this order failed and was never superseded by a successful delivery"
      : recoveredInboxFailures > 0
        ? `${recoveredInboxFailures} webhook failure${recoveredInboxFailures > 1 ? "s" : ""} recovered by a later successful delivery`
        : undefined,
  );
  add("wms", "Accepted & reached WMS",
    activeWms.length === 0 ? "failed" : activeWms.length > 1 ? "failed" : "done",
    activeWms.length === 0 ? "no active WMS order" : activeWms.length > 1 ? `${activeWms.length} active WMS orders (duplicate)` : undefined);
  add("fulfill", "Picked & packed",
    activeWms.some((w) => ["exception"].includes(String(w.warehouse_status))) ? "failed"
      : activeShipments.length > 0 || activeWms.some((w) => ["packed", "ready_to_ship", "shipped"].includes(String(w.warehouse_status))) ? "done"
      : activeWms.length ? "current" : "pending",
    activeWms.map((w) => w.warehouse_status).join(", ") || undefined);
  add("engine_push", "Pushed to ShipStation",
    deadRetry && /shipstation_shipment_push/.test(String(deadRetry.topic)) ? "failed"
      : pushedShipments.length > 0 ? "done"
      : activeShipments.length ? "current" : "pending",
    deadRetry && /shipstation_shipment_push/.test(String(deadRetry.topic)) ? String(deadRetry.last_error).slice(0, 120) : undefined);
  add("shipped", "Shipped & confirmed",
    deadRetry && /SHIP_NOTIFY/.test(String(deadRetry.topic)) ? "failed"
      : shippedShipments.length > 0 || eventTypes.has("shipped_via_shipstation") ? "done"
      : pushedShipments.length ? "current" : "pending",
    deadRetry && /SHIP_NOTIFY/.test(String(deadRetry.topic)) ? String(deadRetry.last_error).slice(0, 120) : undefined);
  add("writeback", "Written back to channel",
    !channelWritebackRequired ? "skipped"
      : allShippedShipmentsWrittenBack ? "done"
      : shippedShipments.length > 0 ? "failed"
      : String(o.status) === "shipped" ? "failed"
      : "pending",
    channelWritebackRequired && shippedShipments.length > 0 && !allShippedShipmentsWrittenBack
      ? `${writebackCompleteCount}/${shippedShipments.length} shipped shipment${shippedShipments.length === 1 ? "" : "s"} confirmed`
      : !channelWritebackRequired ? "no channel writeback adapter is configured" : undefined);

  const divergedStage = stages.find((s) => s.status === "failed") ?? stages.find((s) => s.status === "current");
  const diverged = divergedStage && divergedStage.status === "failed"
    ? { stage: divergedStage.label, reason: divergedStage.detail ?? "diverged here" }
    : null;

  return {
    found: true,
    query: raw,
    oms: {
      id: omsId,
      externalOrderNumber: o.external_order_number ?? null,
      externalOrderId: o.external_order_id ?? null,
      channel: o.provider ?? null,
      status: o.status ?? null,
      financialStatus: o.financial_status ?? null,
      trackingNumber: o.tracking_number ?? null,
      trackingCarrier: o.tracking_carrier ?? null,
      createdAt: o.created_at ?? null,
      shippedAt: o.shipped_at ?? null,
    },
    wms: wmsRows.map((w) => ({ id: Number(w.id), warehouseStatus: w.warehouse_status ?? null, createdAt: w.created_at ?? null, linkVia: w.link_via ?? null, active: String(w.warehouse_status) !== "cancelled" })),
    shipments: shipmentRows.map((s) => ({ id: Number(s.id), wmsOrderId: s.order_id != null ? Number(s.order_id) : null, status: s.status ?? null, engineOrderRef: s.engine_order_ref ?? null, shipstationOrderId: s.shipstation_order_id != null ? Number(s.shipstation_order_id) : null, trackingNumber: s.tracking_number ?? null, shopifyFulfillmentId: s.shopify_fulfillment_id ?? null, hasShippableItems: s.has_shippable_items !== false, requiresReview: s.requires_review ?? null, reviewReason: s.review_reason ?? null, onHoldReason: s.on_hold_reason ?? null, createdAt: s.created_at ?? null })),
    events: eventRows.map((e) => ({ eventType: String(e.event_type), details: e.details, createdAt: e.created_at ?? null })),
    timeline,
    stages,
    diverged,
  };
}
