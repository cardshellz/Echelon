/**
 * Order lifecycle tracer (READ-ONLY).
 *
 * Answers: "why didn't order <N> get pushed to ShipStation — or was it
 * already shipped/tracked via another path?" by walking the full life story
 * across OMS -> WMS -> outbound shipment -> push-retry queue -> fulfillment
 * inbox. Makes NO writes.
 *
 * Column/table names verified against:
 *   shared/schema/oms.schema.ts      (oms_orders, oms_order_events, webhook_retry_queue, webhook_inbox)
 *   shared/schema/orders.schema.ts   (wms.orders, wms.outbound_shipments)
 * Push-retry topics verified against:
 *   server/modules/oms/webhook-retry.worker.ts
 *     - oms_wms_sync            payload.omsOrderId   (OMS->WMS sync failed)
 *     - shipstation_shipment_push payload.shipmentId (engine push failed)
 *     - shopify_fulfillment_push  payload.shipmentId
 *     - delayed_tracking_push     payload.shipmentId / orderId
 *
 * Connection: EXTERNAL_DATABASE_URL (per CLAUDE.md), falling back to DATABASE_URL.
 *
 * Usage:
 *   npx tsx scripts/trace-order.ts 58153
 *   npx tsx scripts/trace-order.ts 58153 --json
 *
 * The argument is matched against BOTH oms.oms_orders.external_order_number and
 * wms.orders.order_number (that is what a human "order number" like 58153 maps
 * to — see oms.service mapShopifyOrderToOrderData / wms-sync.service line 246).
 */

import pg from "pg";

const { Pool } = pg;

const orderArg = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);
const asJson = process.argv.includes("--json");

if (!orderArg) {
  console.error("Usage: npx tsx scripts/trace-order.ts <order-number> [--json]");
  process.exit(2);
}

const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("No EXTERNAL_DATABASE_URL or DATABASE_URL set — cannot connect.");
  process.exit(2);
}

const orderNumber = orderArg.trim();

function hr(title: string) {
  if (!asJson) console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}
function show(label: string, rows: any[]) {
  if (asJson) return;
  if (!rows || rows.length === 0) {
    console.log(`  (none) — ${label}`);
    return;
  }
  console.table(rows);
}

async function main() {
  const pool = new Pool({ connectionString, max: 2 });
  const out: Record<string, any> = { orderNumber };

  try {
    // ── 1. OMS order ────────────────────────────────────────────────────
    hr(`1. OMS order(s) matching external_order_number = '${orderNumber}'`);
    const oms = await pool.query(
      `SELECT id, channel_id, external_order_id, external_order_number,
              status, financial_status, fulfillment_status,
              warehouse_id, tracking_number,
              shipstation_order_id, shipstation_order_key,
              shipping_engine, engine_order_ref,
              created_at, updated_at
         FROM oms.oms_orders
        WHERE external_order_number = $1
        ORDER BY id`,
      [orderNumber],
    );
    out.omsOrders = oms.rows;
    show("OMS order", oms.rows);
    const omsIds = oms.rows.map((r) => Number(r.id));

    // ── 2. OMS events (the life story) ──────────────────────────────────
    hr(`2. OMS order events (chronological life story)`);
    if (omsIds.length) {
      const events = await pool.query(
        `SELECT id, order_id, event_type, details, created_at
           FROM oms.oms_order_events
          WHERE order_id = ANY($1::bigint[])
          ORDER BY created_at, id`,
        [omsIds],
      );
      out.omsEvents = events.rows;
      // details can be large JSON — print compact
      show("OMS events", events.rows.map((r) => ({
        id: r.id, at: r.created_at, type: r.event_type,
        details: typeof r.details === "object" ? JSON.stringify(r.details).slice(0, 200) : r.details,
      })));
    } else {
      console.log("  (skipped — no OMS order found)");
    }

    // ── 3. WMS order(s) ─────────────────────────────────────────────────
    hr(`3. WMS order(s) — by oms_fulfillment_order_id OR order_number`);
    const wms = await pool.query(
      `SELECT id, source, oms_fulfillment_order_id, source_table_id,
              order_number, external_order_id,
              warehouse_status, on_hold,
              assigned_picker_id, tracking_number,
              shipstation_order_id, shipstation_order_key,
              shipping_engine, engine_order_ref,
              created_at, updated_at
         FROM wms.orders
        WHERE (source = 'oms' AND oms_fulfillment_order_id = ANY($1::text[]))
           OR order_number = $2
        ORDER BY id`,
      [omsIds.map(String), orderNumber],
    );
    out.wmsOrders = wms.rows;
    show("WMS order", wms.rows);
    const wmsIds = wms.rows.map((r) => Number(r.id));

    // ── 4. Outbound shipments ───────────────────────────────────────────
    hr(`4. Outbound shipments — status, push refs, tracking, review flags`);
    if (wmsIds.length) {
      const ships = await pool.query(
        `SELECT id, order_id, status,
                external_fulfillment_id,
                shipstation_order_id, shipstation_order_key,
                shipping_engine, engine_order_ref, engine_shipment_ref,
                carrier, tracking_number, shipped_at,
                requires_review, review_reason,
                voided_at, created_at, updated_at
           FROM wms.outbound_shipments
          WHERE order_id = ANY($1::int[])
          ORDER BY id`,
        [wmsIds],
      );
      out.shipments = ships.rows;
      show("Outbound shipment", ships.rows);
    } else {
      console.log("  (skipped — no WMS order found)");
    }
    const shipmentIds = (out.shipments ?? []).map((r: any) => Number(r.id));

    // ── 5. Push-retry / dead-letter queue ───────────────────────────────
    hr(`5. Webhook retry queue — stuck OMS->WMS sync or ShipStation push`);
    // Match on omsOrderId (sync) and shipmentId (push/fulfillment/tracking).
    const retry = await pool.query(
      `SELECT id, provider, topic, status, attempts, last_error,
              next_retry_at, created_at, updated_at,
              payload
         FROM oms.webhook_retry_queue
        WHERE (payload->>'omsOrderId') = ANY($1::text[])
           OR (payload->>'shipmentId') = ANY($2::text[])
           OR (payload->>'orderId')    = ANY($3::text[])
        ORDER BY created_at`,
      [omsIds.map(String), shipmentIds.map(String), wmsIds.map(String)],
    );
    out.retryQueue = retry.rows;
    show("Retry queue", retry.rows.map((r) => ({
      id: r.id, provider: r.provider, topic: r.topic, status: r.status,
      attempts: r.attempts, next_retry_at: r.next_retry_at,
      last_error: (r.last_error || "").slice(0, 160),
      payload: JSON.stringify(r.payload),
    })));

    // ── 6. Fulfillment inbox (already shipped via another channel?) ─────
    hr(`6. Webhook inbox — inbound fulfillment events for this order`);
    // Shopify fulfillment webhooks carry the order id in event_id/payload.
    const inbox = await pool.query(
      `SELECT id, provider, topic, event_id, status, attempts,
              last_error, first_received_at, processed_at
         FROM oms.webhook_inbox
        WHERE topic ILIKE '%fulfill%'
          AND ( event_id = ANY($1::text[])
             OR event_id = $2
             OR payload::text ILIKE '%' || $2 || '%' )
        ORDER BY first_received_at
        LIMIT 50`,
      [oms.rows.map((r) => String(r.external_order_id)), orderNumber],
    );
    out.fulfillmentInbox = inbox.rows;
    show("Fulfillment inbox", inbox.rows);

    // ── Verdict heuristics ──────────────────────────────────────────────
    hr(`VERDICT (heuristic — confirm against rows above)`);
    const verdict: string[] = [];
    const o = oms.rows[0];
    const w = wms.rows[0];
    const liveShip = (out.shipments ?? []).find((s: any) => !s.voided_at && s.status !== "cancelled");

    if (!o) {
      verdict.push(`No OMS order with external_order_number='${orderNumber}'. It may be ingested under a different number, never ingested, or belongs to a channel not flowing through OMS.`);
    }
    if (o && (o.status === "cancelled" || ["refunded", "voided"].includes(o.financial_status))) {
      verdict.push(`OMS order is ${o.status}/${o.financial_status} — wms-sync.service skips/cancels engine push for final-or-cancelled orders (isFinalOrCancelledOmsOrder). This is the most likely reason it never went to ShipStation.`);
    }
    if (o && o.fulfillment_status === "fulfilled") {
      verdict.push(`OMS fulfillment_status='fulfilled' — it was likely fulfilled outside this WMS (another channel/manual). Check tracking_number on OMS (${o.tracking_number ?? "null"}).`);
    }
    if (w && w.on_hold === 1) {
      verdict.push(`WMS order is ON HOLD — picking is blocked (orders.storage claimOrder requires on_hold=0) and it won't progress to push.`);
    }
    if (w && ["cancelled"].includes(w.warehouse_status)) {
      verdict.push(`WMS order warehouse_status='cancelled' — no push expected.`);
    }
    if (liveShip && (liveShip.engine_order_ref || liveShip.shipstation_order_id)) {
      verdict.push(`Shipment ${liveShip.id} HAS an engine ref (engine_order_ref=${liveShip.engine_order_ref ?? "null"}, shipstation_order_id=${liveShip.shipstation_order_id ?? "null"}) — it WAS pushed. If it's not visible in ShipStation, check status='${liveShip.status}' and whether it was later cancelled/voided there.`);
    }
    if (liveShip && !liveShip.engine_order_ref && !liveShip.shipstation_order_id) {
      verdict.push(`Shipment ${liveShip.id} exists (status='${liveShip.status}') but has NO engine/shipstation ref — it was created but never successfully pushed. Look at section 5 for a 'shipstation_shipment_push' retry row and its last_error.`);
    }
    if (w && wmsIds.length && (out.shipments ?? []).length === 0) {
      verdict.push(`WMS order exists but has NO outbound_shipments row — shipment creation failed during sync (wms-sync.service 5b is non-fatal). Reconcile sweep should retry; check for an 'oms_wms_sync' retry row in section 5.`);
    }
    if (liveShip && liveShip.requires_review) {
      verdict.push(`Shipment ${liveShip.id} requires_review=true, reason='${liveShip.review_reason}' — likely held (e.g. refund_after_ship / address change). It will not auto-push while held.`);
    }
    if (liveShip && liveShip.tracking_number) {
      verdict.push(`Shipment ${liveShip.id} already has tracking '${liveShip.tracking_number}' (carrier=${liveShip.carrier ?? "?"}, shipped_at=${liveShip.shipped_at ?? "?"}) — it IS shipped. Answers the 'shipped via another channel' question.`);
    }
    if (verdict.length === 0) {
      verdict.push(`No single obvious cause from heuristics. Read sections 1-6 manually — the OMS events (2) and retry queue (5) carry the precise reason.`);
    }

    if (asJson) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      verdict.forEach((v, i) => console.log(`  ${i + 1}. ${v}`));
      console.log("");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("trace-order failed:", err);
  process.exit(1);
});
