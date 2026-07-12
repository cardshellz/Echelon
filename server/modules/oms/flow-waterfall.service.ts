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
 *
 * ── ONE issue registry ──────────────────────────────────────────────
 * Every condition that stops an order from flowing through correctly — stuck at a
 * stage, a contradictory state, a duplicate, a dead-lettered webhook, an SLA breach —
 * is ONE declarative `FLOW_ISSUES` entry: { code, kind, stage, severity, message
 * (what, plain), why (where to look + what to do, plain), remediation, replaySafe,
 * count, sample }. The waterfall feed, the health roll-up, and the drill-down are all
 * derived from it, so adding a future check = appending ONE entry — it then shows up
 * everywhere with what/where/how-to-fix attached. This is the "tell me what's wrong,
 * where to look, and what to do — without prompting" layer that ends the whack-a-mole.
 * Guidance is written in plain operator language (no table/column names).
 */

import { sql } from "drizzle-orm";
import { getChannelWritebackHealth, type ChannelWritebackHealth } from "./channel-writeback.service";

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const STATEMENT_TIMEOUT = "8s";

export type FunnelStageKey =
  | "intake" | "oms_to_wms" | "wms_fulfill" | "engine_push" | "shipped" | "writeback";

// What class of problem this is. Drives grouping/iconography in the UI.
export type IssueKind = "stuck" | "contradiction" | "duplicate" | "queue_failure" | "sla";

// What an operator should DO about it — the action layer that turns the monitor
// from a dashboard into a worklist.
export type RemediationClass =
  | "REQUEUE"             // re-run the failed step; safe once the cause is cleared
  | "REPLAY_AFTER_STOCK"  // receive inventory first, then replay (idempotent)
  | "REPLAY_AFTER_FIX"    // fix the data/code, then replay
  | "MANUAL_REVIEW"       // a human must look and decide (release / void / restore / expedite)
  | "INVESTIGATE"         // cause unknown — open the rows and diagnose
  | "CODE_FIX"            // a bug; replay won't help until patched
  | "PURGE_OBSOLETE";     // underlying order/shipment is terminal — safe to drop

export interface FlowDuplicates {
  omsToPicking: number;
  overShippedItems: number;
  unmappedEngineSplits: number;
  blockedDupOrders: number;
  sample: any[];
}
export interface FlowIntakeModel { provider: string; model: "poll-primary" | "webhook-primary"; cadenceSeconds: number; note: string }
export interface FlowFunnel { entered: number; reachedWms: number; hasShipment: number; shipped: number; trackingConfirmed: number }
export interface FlowIssue {
  code: string;
  kind: IssueKind;
  severity: "critical" | "warning" | "info";
  stage: FunnelStageKey | "other";
  count: number;
  message: string;
  why?: string;
  remediation: RemediationClass;
  replaySafe: boolean;
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
  duplicates: FlowDuplicates;
  deadLetterCauses: Array<{ code: string; cause: string; count: number }>;
  crossSystem: { wmsShippedOmsOpen: number; omsNotUpdated: number; sample: any[] };
  sla: { breached: number; sample: any[] };
  issues: FlowIssue[];
  health: { generatedAt: string; status: "healthy" | "degraded" | "critical"; counts: { critical: number; warning: number; info: number } };
  channelWriteback: ChannelWritebackHealth;
}

interface FlowIssueDef {
  code: string;
  kind: IssueKind;
  severity: "critical" | "warning" | "info";
  stage: FunnelStageKey | "other";
  message: string;
  why: string;
  remediation: RemediationClass;
  replaySafe: boolean;
  count: (win: any) => any;
  sample: (win: any) => any;
}

// The soft OMS↔WMS correlation (no FK): join on the fulfillment-order id or the
// source_table_id. Used by several issue queries — keep aliases oo / wo.
const LINK = sql`((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text))`;

// ── Dead-letter reason taxonomy ─────────────────────────────────────
// 99.8% of the dead-letter backlog is a handful of reasons. Classify each row by
// the (provider, topic, last_error) signature into a CANONICAL code, with a
// guaranteed UNCLASSIFIED catch-all so a NEW failure mode surfaces itself ("3
// unclassified — add a rule") instead of fragmenting into dozens of pseudo-buckets.
// Read-time for v1 (no migration); a persisted reason_code column is the fast-follow.
// Uses the `rq` alias (oms.webhook_retry_queue rq).
const DEAD_LETTER_REASON_CODE = sql`CASE
  WHEN rq.provider = 'shipstation' AND rq.last_error LIKE '%Negative Inventory Guard%' THEN 'SHIPNOTIFY_NO_INVENTORY'
  WHEN rq.provider = 'shipstation' AND rq.last_error LIKE '%no parseable wms-item lineItemKey%' THEN 'SHIPNOTIFY_UNMAPPED_LINEITEM'
  WHEN rq.provider = 'shipstation' AND rq.last_error LIKE '%shipment not found%' THEN 'SHIPNOTIFY_SHIPMENT_NOT_FOUND'
  WHEN rq.topic = 'shopify_fulfillment_push' AND rq.last_error LIKE '%no items with positive quantity%' THEN 'SHOPIFY_PUSH_NO_POSITIVE_QTY'
  WHEN rq.topic = 'shopify_fulfillment_push' AND rq.last_error LIKE '%no fulfillment-order line item%' THEN 'SHOPIFY_PUSH_SKU_NOT_ON_FO'
  WHEN rq.topic = 'oms_wms_sync' AND rq.last_error LIKE '%no WMS order%' THEN 'OMS_WMS_SYNC_NO_ORDER'
  WHEN rq.last_error LIKE '%2 character country code%' THEN 'SHIPSTATION_COUNTRY_CODE'
  WHEN rq.last_error LIKE '%cents must be >= 0%' THEN 'PUSH_NEGATIVE_TOTAL'
  WHEN rq.last_error LIKE '%total_cents%does not match%' THEN 'PUSH_TOTAL_MISMATCH'
  WHEN rq.last_error LIKE '%timeout exceeded%' THEN 'DB_CONNECT_TIMEOUT'
  WHEN rq.provider = 'shopify'
    AND rq.topic = 'refunds/create'
    AND rq.last_error LIKE '%Local API returned 500%'
    THEN 'SHOPIFY_REFUND_CASCADE_FAILED'
  WHEN rq.last_error LIKE '%Local API returned 500%' THEN 'INTERNAL_API_500'
  WHEN rq.last_error LIKE '%processed%failed%' THEN 'SHIPNOTIFY_UNSPECIFIED'
  WHEN rq.last_error IS NULL THEN 'NO_MESSAGE'
  ELSE 'UNCLASSIFIED' END`;

const DEAD_LETTER_LABELS: Record<string, string> = {
  SHIPNOTIFY_NO_INVENTORY: "Couldn't ship — nothing in stock to deduct",
  SHIPNOTIFY_UNMAPPED_LINEITEM: "Ship update — items didn't match the order",
  SHIPNOTIFY_SHIPMENT_NOT_FOUND: "Ship update — shipment not found",
  SHOPIFY_PUSH_NO_POSITIVE_QTY: "Tracking push — shipment had no items",
  SHOPIFY_PUSH_SKU_NOT_ON_FO: "Tracking push — item not on the order",
  OMS_WMS_SYNC_NO_ORDER: "Hand-off — no warehouse order was created",
  SHIPSTATION_COUNTRY_CODE: "Push — country code must be 2 letters",
  PUSH_NEGATIVE_TOTAL: "Push — order total came out negative",
  PUSH_TOTAL_MISMATCH: "Push — order total didn't match",
  DB_CONNECT_TIMEOUT: "Temporary database timeout",
  SHOPIFY_REFUND_CASCADE_FAILED: "Refund line update failed to finish",
  INTERNAL_API_500: "Internal error (500)",
  SHIPNOTIFY_UNSPECIFIED: "Ship update failed (reason not recorded)",
  NO_MESSAGE: "(no error message)",
  UNCLASSIFIED: "Unclassified — needs a rule",
};

// ── The registry — every order-flow-stopper, declared once ──────────
// The retry-queue dead-letters are NOT one entry here — they're generated as one
// issue PER reason code (see DEAD_LETTER_REASONS below) and appended, so each shows
// as its own drillable bucket at the stage where it actually fails.
const BASE_ISSUES: FlowIssueDef[] = [
  // ---- intake ----
  {
    code: "WEBHOOK_INBOX_FAILED", kind: "stuck", stage: "intake", severity: "critical",
    message: "Channel events failed to finish",
    why: "A channel event such as an order, cancellation, fulfillment, or refund did not finish processing. Re-run it; a successful retry automatically clears the originating inbox failure.",
    remediation: "REQUEUE", replaySafe: true,
    count: () => sql`SELECT COUNT(*)::int AS count FROM oms.webhook_inbox WHERE status IN ('failed','dead')`,
    sample: () => sql`SELECT COALESCE(oo.external_order_number, wi.payload->>'name', wi.payload->>'order_number') AS order_number, wi.provider, wi.topic, wi.status, wi.attempts, wi.last_error, COALESCE(wi.processed_at, wi.last_attempt_at, wi.first_received_at) AS at, wi.id AS inbox_id FROM oms.webhook_inbox wi LEFT JOIN oms.oms_orders oo ON oo.external_order_id = COALESCE(wi.payload->>'order_id', wi.payload->>'id') WHERE wi.status IN ('failed','dead') ORDER BY COALESCE(wi.processed_at, wi.last_attempt_at, wi.first_received_at) DESC NULLS LAST LIMIT 50`,
  },
  {
    code: "BLOCKED_DUP_INGEST", kind: "duplicate", stage: "intake", severity: "info",
    message: "Duplicate incoming orders were blocked",
    why: "A channel sent the same order twice and the second copy was rejected — normally harmless, the first one went through. Only worth checking if the order is actually missing.",
    remediation: "INVESTIGATE", replaySafe: false,
    count: () => sql`SELECT COUNT(*)::int AS count FROM oms.webhook_inbox WHERE status IN ('failed','dead') AND last_error LIKE '%duplicate key value%'`,
    sample: () => sql`SELECT wi.provider, wi.topic, wi.last_error, COALESCE(wi.processed_at, wi.last_attempt_at, wi.first_received_at) AS at, wi.id AS inbox_id FROM oms.webhook_inbox wi WHERE wi.status IN ('failed','dead') AND wi.last_error LIKE '%duplicate key value%' ORDER BY COALESCE(wi.processed_at, wi.last_attempt_at, wi.first_received_at) DESC NULLS LAST LIMIT 50`,
  },
  // ---- oms → wms ----
  {
    code: "OMS_PAID_WITHOUT_WMS", kind: "stuck", stage: "oms_to_wms", severity: "critical",
    message: "Paid orders haven't reached the warehouse",
    why: "The customer paid but the order never made it to the warehouse to be picked. Re-send it to the warehouse — it's safe to re-run.",
    remediation: "REPLAY_AFTER_FIX", replaySafe: true,
    count: (win: any) => sql`SELECT COUNT(*)::int AS count FROM oms.oms_orders oo WHERE oo.status NOT IN ('cancelled','shipped') AND oo.financial_status IN ('paid','partially_paid') AND oo.ordered_at > ${win} AND NOT EXISTS (SELECT 1 FROM wms.orders wo WHERE (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text))`,
    sample: (win: any) => sql`SELECT oo.external_order_number AS order_number, oo.status, oo.financial_status, oo.ordered_at AS at FROM oms.oms_orders oo WHERE oo.status NOT IN ('cancelled','shipped') AND oo.financial_status IN ('paid','partially_paid') AND oo.ordered_at > ${win} AND NOT EXISTS (SELECT 1 FROM wms.orders wo WHERE (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text)) ORDER BY oo.ordered_at DESC LIMIT 50`,
  },
  {
    code: "OMS_DOUBLE_PICKING", kind: "duplicate", stage: "oms_to_wms", severity: "critical",
    message: "One order is being picked twice",
    why: "A single order created two active warehouse jobs, so it would be picked and shipped twice. Cancel the duplicate job and keep one. (Multiple shipments for one order are fine — this only flags duplicate jobs.)",
    remediation: "MANUAL_REVIEW", replaySafe: false,
    count: (win: any) => sql`SELECT COUNT(*)::int AS count FROM (SELECT oo.id FROM oms.oms_orders oo JOIN wms.orders wo ON ${LINK} WHERE wo.warehouse_status <> 'cancelled' AND oo.ordered_at > ${win} GROUP BY oo.id HAVING COUNT(DISTINCT wo.id) > 1) t`,
    sample: (win: any) => sql`SELECT oo.external_order_number AS order_number, COUNT(DISTINCT wo.id)::int AS active_warehouse_jobs, oo.ordered_at AS at FROM oms.oms_orders oo JOIN wms.orders wo ON ${LINK} WHERE wo.warehouse_status <> 'cancelled' AND oo.ordered_at > ${win} GROUP BY oo.external_order_number, oo.ordered_at HAVING COUNT(DISTINCT wo.id) > 1 ORDER BY 2 DESC LIMIT 50`,
  },
  // ---- wms fulfill ----
  {
    // WHERE mirrors ops-health.service.ts: only orders with a shippable, unfulfilled item and
    // not already cancelled/shipped/refunded — else digital/membership orders inflate this.
    code: "WMS_READY_WITHOUT_SHIPMENT", kind: "stuck", stage: "wms_fulfill", severity: "critical",
    message: "Ready orders have no shipment",
    why: "The warehouse marked these ready to ship but there's no shipment to print a label for. Re-create the shipment so it can go out.",
    remediation: "REPLAY_AFTER_FIX", replaySafe: false,
    count: (win: any) => sql`SELECT COUNT(*)::int AS count FROM wms.orders wo WHERE wo.warehouse_status IN ('ready','in_progress','ready_to_ship') AND wo.created_at > ${win} AND EXISTS (SELECT 1 FROM wms.order_items oi WHERE oi.order_id = wo.id AND COALESCE(oi.requires_shipping,1) <> 0 AND COALESCE(oi.quantity,0) > COALESCE(oi.fulfilled_quantity,0)) AND NOT EXISTS (SELECT 1 FROM oms.oms_orders oo WHERE ((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text)) AND (oo.status IN ('cancelled','shipped','refunded') OR oo.financial_status = 'refunded')) AND NOT EXISTS (SELECT 1 FROM wms.outbound_shipments os WHERE os.order_id = wo.id AND os.status <> 'voided')`,
    sample: (win: any) => sql`SELECT wo.order_number, wo.warehouse_status, wo.created_at AS at FROM wms.orders wo WHERE wo.warehouse_status IN ('ready','in_progress','ready_to_ship') AND wo.created_at > ${win} AND EXISTS (SELECT 1 FROM wms.order_items oi WHERE oi.order_id = wo.id AND COALESCE(oi.requires_shipping,1) <> 0 AND COALESCE(oi.quantity,0) > COALESCE(oi.fulfilled_quantity,0)) AND NOT EXISTS (SELECT 1 FROM oms.oms_orders oo WHERE ((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text)) AND (oo.status IN ('cancelled','shipped','refunded') OR oo.financial_status = 'refunded')) AND NOT EXISTS (SELECT 1 FROM wms.outbound_shipments os WHERE os.order_id = wo.id AND os.status <> 'voided') ORDER BY wo.created_at DESC LIMIT 50`,
  },
  {
    code: "SHIPMENT_REQUIRES_REVIEW", kind: "stuck", stage: "wms_fulfill", severity: "warning",
    message: "Shipments flagged for review",
    why: "These shipments were held for a person to check before they go out. Open each one, resolve the flag, and release it.",
    remediation: "MANUAL_REVIEW", replaySafe: false,
    count: () => sql`SELECT COUNT(*)::int AS count FROM wms.outbound_shipments WHERE requires_review = true AND status NOT IN ('cancelled','voided','shipped')`,
    // Higher limit + reason-ordered: the drill-down rolls these up by review_reason
    // (categories first, expand to orders), so it must return the full set, not a top-50.
    sample: () => sql`SELECT os.review_reason, os.id AS shipment_id, wo.order_number, os.created_at AS at FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id = os.order_id WHERE os.requires_review = true AND os.status NOT IN ('cancelled','voided','shipped') ORDER BY os.review_reason, os.created_at DESC LIMIT 500`,
  },
  {
    code: "SHIPMENT_ON_HOLD", kind: "stuck", stage: "wms_fulfill", severity: "warning",
    message: "Shipments on hold",
    why: "These shipments are paused — often an address problem or a last-minute customer change. Sort out the issue and release them, or cancel if they shouldn't ship.",
    remediation: "MANUAL_REVIEW", replaySafe: false,
    count: () => sql`SELECT COUNT(*)::int AS count FROM wms.outbound_shipments WHERE held = true`,
    sample: () => sql`SELECT os.id AS shipment_id, wo.order_number, os.on_hold_reason, os.created_at AS at FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id = os.order_id WHERE os.held = true ORDER BY os.created_at DESC LIMIT 50`,
  },
  {
    // WHERE mirrors the canonical SLA monitor (sla-monitor.service.ts): overdue = non-terminal past due.
    code: "SLA_BREACHED", kind: "sla", stage: "wms_fulfill", severity: "warning",
    message: "Orders past their ship-by date",
    why: "These orders are overdue to ship. Move them to the front of the pick-and-pack queue.",
    remediation: "MANUAL_REVIEW", replaySafe: false,
    count: () => sql`SELECT COUNT(*)::int AS count FROM wms.orders WHERE sla_due_at IS NOT NULL AND warehouse_status NOT IN ('shipped','completed','cancelled') AND sla_due_at < NOW()`,
    sample: () => sql`SELECT wo.order_number, wo.warehouse_status, wo.sla_due_at AS at FROM wms.orders wo WHERE wo.sla_due_at IS NOT NULL AND wo.warehouse_status NOT IN ('shipped','completed','cancelled') AND wo.sla_due_at < NOW() ORDER BY wo.sla_due_at ASC LIMIT 50`,
  },
  // ---- engine push ----
  {
    // WHERE mirrors ops-health.service.ts: only shipments carrying a shippable, positive-qty item.
    code: "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION", kind: "stuck", stage: "engine_push", severity: "critical",
    message: "Shipments not sent to the shipping app",
    why: "These shipments should have been handed to the shipping app by now but weren't, so no label exists. Re-send them to the shipping app.",
    remediation: "REQUEUE", replaySafe: true,
    count: () => sql`SELECT COUNT(*)::int AS count FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id = os.order_id WHERE os.status IN ('planned','queued') AND os.created_at < NOW() - INTERVAL '15 minutes' AND os.engine_order_ref IS NULL AND COALESCE(os.requires_review, false) = false AND COALESCE(os.held, false) = false AND wo.warehouse_status NOT IN ('cancelled','shipped') AND EXISTS (SELECT 1 FROM wms.outbound_shipment_items osi JOIN wms.order_items oi ON oi.id = osi.order_item_id WHERE osi.shipment_id = os.id AND COALESCE(oi.requires_shipping,1) <> 0 AND COALESCE(osi.qty,0) > 0) AND NOT EXISTS (SELECT 1 FROM oms.oms_orders oo WHERE ((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text)) AND (oo.status IN ('cancelled','shipped','refunded') OR oo.financial_status = 'refunded'))`,
    sample: () => sql`SELECT os.id AS shipment_id, wo.order_number, os.status, os.created_at AS at FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id = os.order_id WHERE os.status IN ('planned','queued') AND os.created_at < NOW() - INTERVAL '15 minutes' AND os.engine_order_ref IS NULL AND COALESCE(os.requires_review, false) = false AND COALESCE(os.held, false) = false AND wo.warehouse_status NOT IN ('cancelled','shipped') AND EXISTS (SELECT 1 FROM wms.outbound_shipment_items osi JOIN wms.order_items oi ON oi.id = osi.order_item_id WHERE osi.shipment_id = os.id AND COALESCE(oi.requires_shipping,1) <> 0 AND COALESCE(osi.qty,0) > 0) AND NOT EXISTS (SELECT 1 FROM oms.oms_orders oo WHERE ((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR (wo.source_table_id = oo.id::text)) AND (oo.status IN ('cancelled','shipped','refunded') OR oo.financial_status = 'refunded')) ORDER BY os.created_at ASC LIMIT 50`,
  },
  {
    code: "UNMAPPED_ENGINE_SPLIT", kind: "duplicate", stage: "engine_push", severity: "warning",
    message: "Split shipments we couldn't match up",
    why: "The shipping app split an order into pieces we couldn't match back to the original items, so stock and tracking might not line up. Review and match them by hand.",
    remediation: "MANUAL_REVIEW", replaySafe: false,
    count: () => sql`SELECT COUNT(*)::int AS count FROM wms.outbound_shipments WHERE review_reason LIKE '%split_items_unmapped%'`,
    sample: () => sql`SELECT os.id AS shipment_id, wo.order_number, os.review_reason, os.created_at AS at FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id = os.order_id WHERE os.review_reason LIKE '%split_items_unmapped%' ORDER BY os.created_at DESC LIMIT 50`,
  },
  // ---- shipped (contradictions kept verbatim from the plain-language rewrite + over-ship) ----
  {
    code: "SHIPPED_SHIPMENT_CANCELLED", kind: "contradiction", stage: "shipped", severity: "critical",
    message: "Shipped packages are marked cancelled",
    why: "This package already shipped (it has tracking) but shows as cancelled, so the order reads as unshipped. Open it, confirm it shipped, and restore it to shipped — leave it only if it was a duplicate label that never went out.",
    remediation: "MANUAL_REVIEW", replaySafe: false,
    count: () => sql`SELECT COUNT(*)::int AS count FROM wms.outbound_shipments WHERE status = 'cancelled' AND shipped_at IS NOT NULL`,
    sample: () => sql`SELECT os.id AS shipment_id, wo.order_number, os.source, os.voided_reason, os.tracking_number, os.cancelled_at AS at FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id = os.order_id WHERE os.status = 'cancelled' AND os.shipped_at IS NOT NULL ORDER BY os.cancelled_at DESC NULLS LAST LIMIT 50`,
  },
  {
    code: "ORDER_CANCELLED_WITH_SHIPPED_UNITS", kind: "contradiction", stage: "shipped", severity: "critical",
    message: "Cancelled orders that were actually paid & shipped",
    why: "The order shows cancelled, but the customer paid and the items shipped — so it has dropped out of the active orders view (a “lost order”). Restore it to shipped, unless there was a genuine refund or cancellation.",
    remediation: "MANUAL_REVIEW", replaySafe: false,
    count: (win: any) => sql`SELECT COUNT(*)::int AS count FROM oms.oms_orders oo WHERE oo.status = 'cancelled' AND oo.cancelled_at IS NULL AND oo.financial_status = 'paid' AND oo.ordered_at > ${win} AND EXISTS (SELECT 1 FROM wms.orders wo JOIN wms.outbound_shipments os ON os.order_id = wo.id WHERE ((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR wo.source_table_id = oo.id::text) AND os.status IN ('shipped','returned','lost'))`,
    sample: (win: any) => sql`SELECT oo.external_order_number AS order_number, oo.status, oo.financial_status, oo.fulfillment_status, oo.ordered_at AS at FROM oms.oms_orders oo WHERE oo.status = 'cancelled' AND oo.cancelled_at IS NULL AND oo.financial_status = 'paid' AND oo.ordered_at > ${win} AND EXISTS (SELECT 1 FROM wms.orders wo JOIN wms.outbound_shipments os ON os.order_id = wo.id WHERE ((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text) OR wo.source_table_id = oo.id::text) AND os.status IN ('shipped','returned','lost')) ORDER BY oo.ordered_at DESC LIMIT 50`,
  },
  {
    code: "SHIPMENT_SHIPPED_AT_WRONG_STATUS", kind: "contradiction", stage: "shipped", severity: "warning",
    message: "Shipments with a ship date but not marked shipped",
    why: "This shipment has a ship date but is stuck in a pre-ship status, so fulfillment looks incomplete. Confirm whether it actually shipped and mark it shipped.",
    remediation: "MANUAL_REVIEW", replaySafe: false,
    count: () => sql`SELECT COUNT(*)::int AS count FROM wms.outbound_shipments WHERE shipped_at IS NOT NULL AND status IN ('planned','queued','labeled')`,
    sample: () => sql`SELECT os.id AS shipment_id, wo.order_number, os.status, os.source, os.review_reason, os.tracking_number, os.shipped_at AS at FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id = os.order_id WHERE os.shipped_at IS NOT NULL AND os.status IN ('planned','queued','labeled') ORDER BY os.shipped_at DESC LIMIT 50`,
  },
  {
    code: "ORDER_SHIPPED_BUT_LINE_SHORT", kind: "contradiction", stage: "shipped", severity: "warning",
    message: "Orders marked shipped with an item short",
    why: "The order is marked fully shipped, but one item shipped fewer units than were ordered. Check the missing units — reship or refund them — and set the order to partially shipped.",
    remediation: "MANUAL_REVIEW", replaySafe: false,
    count: (win: any) => sql`SELECT COUNT(*)::int AS count FROM (
      SELECT oi.id
      FROM wms.order_items oi
      JOIN wms.orders wo ON wo.id = oi.order_id AND wo.warehouse_status = 'shipped' AND wo.created_at > ${win}
      JOIN wms.outbound_shipment_items osi ON osi.order_item_id = oi.id
      JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
      WHERE COALESCE(oi.requires_shipping,1) <> 0 AND oi.status <> 'cancelled' AND oi.quantity > 0
      GROUP BY oi.id, oi.quantity
      HAVING COALESCE(SUM(osi.qty) FILTER (WHERE os.status IN ('shipped','returned','lost')),0) > 0
         AND COALESCE(SUM(osi.qty) FILTER (WHERE os.status IN ('shipped','returned','lost')),0) < oi.quantity
    ) t`,
    sample: (win: any) => sql`SELECT wo.order_number, oi.sku, oi.quantity AS ordered,
        COALESCE(SUM(osi.qty) FILTER (WHERE os.status IN ('shipped','returned','lost')),0)::int AS shipped_qty, wo.created_at AS at
      FROM wms.order_items oi
      JOIN wms.orders wo ON wo.id = oi.order_id AND wo.warehouse_status = 'shipped' AND wo.created_at > ${win}
      JOIN wms.outbound_shipment_items osi ON osi.order_item_id = oi.id
      JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
      WHERE COALESCE(oi.requires_shipping,1) <> 0 AND oi.status <> 'cancelled' AND oi.quantity > 0
      GROUP BY wo.order_number, oi.sku, oi.quantity, wo.created_at
      HAVING COALESCE(SUM(osi.qty) FILTER (WHERE os.status IN ('shipped','returned','lost')),0) > 0
         AND COALESCE(SUM(osi.qty) FILTER (WHERE os.status IN ('shipped','returned','lost')),0) < oi.quantity
      ORDER BY wo.created_at DESC LIMIT 50`,
  },
  {
    code: "ITEM_OVER_SHIPPED", kind: "duplicate", stage: "shipped", severity: "critical",
    message: "An item shipped more than was ordered",
    why: "More units of an item went out than the customer ordered — usually a shipment that got duplicated. Check what actually shipped and correct the extra.",
    remediation: "INVESTIGATE", replaySafe: false,
    count: (win: any) => sql`SELECT COUNT(*)::int AS count FROM (SELECT osi.order_item_id FROM wms.outbound_shipment_items osi JOIN wms.outbound_shipments os ON os.id = osi.shipment_id AND os.status NOT IN ('voided','cancelled') JOIN wms.order_items oi ON oi.id = osi.order_item_id WHERE os.created_at > ${win} GROUP BY osi.order_item_id HAVING SUM(osi.qty) > MAX(oi.quantity)) t`,
    sample: (win: any) => sql`SELECT wo.order_number, oi.sku, MAX(oi.quantity)::int AS ordered, SUM(osi.qty)::int AS shipped_qty FROM wms.outbound_shipment_items osi JOIN wms.outbound_shipments os ON os.id = osi.shipment_id AND os.status NOT IN ('voided','cancelled') JOIN wms.order_items oi ON oi.id = osi.order_item_id JOIN wms.orders wo ON wo.id = oi.order_id WHERE os.created_at > ${win} GROUP BY wo.order_number, oi.sku, osi.order_item_id HAVING SUM(osi.qty) > MAX(oi.quantity) ORDER BY 4 DESC LIMIT 50`,
  },
  // ---- writeback ----
  {
    code: "WMS_SHIPPED_OMS_OPEN", kind: "contradiction", stage: "writeback", severity: "critical",
    message: "Shipped in the warehouse, still open on the order",
    why: "The warehouse shipped it but the order still shows as open, so the customer may not see it as fulfilled. Re-sync the order — it's safe to re-run.",
    remediation: "REPLAY_AFTER_FIX", replaySafe: true,
    count: (win: any) => sql`SELECT COUNT(DISTINCT oo.id)::int AS count FROM oms.oms_orders oo JOIN wms.orders wo ON ${LINK} WHERE oo.status NOT IN ('shipped','cancelled','refunded','partially_shipped') AND wo.warehouse_status = 'shipped' AND oo.ordered_at > ${win}`,
    sample: (win: any) => sql`SELECT oo.external_order_number AS order_number, oo.status, wo.warehouse_status, oo.ordered_at AS at FROM oms.oms_orders oo JOIN wms.orders wo ON ${LINK} WHERE oo.status NOT IN ('shipped','cancelled','refunded','partially_shipped') AND wo.warehouse_status = 'shipped' AND oo.ordered_at > ${win} ORDER BY oo.ordered_at DESC LIMIT 50`,
  },
  {
    // Replaces the old time-based STALE_CONFIRMED. Authoritative: keys off the WMS
    // order being terminal-done ('completed', typically shipped-via-combine) while the
    // OMS status is still open — i.e. a real OMS-status-out-of-sync divergence, not a
    // clock. ('shipped' is covered by WMS_SHIPPED_OMS_OPEN above; this is 'completed'.)
    code: "ORDER_FULFILLED_OMS_NOT_UPDATED", kind: "contradiction", stage: "writeback", severity: "warning",
    message: "Finished in the warehouse, but the order never updated",
    why: "The warehouse marked this order completed — usually because it shipped combined into another order's package — but the OMS status never updated, so it still reads as confirmed/unfulfilled and lingers as an open order. Re-sync its status from the warehouse so it shows shipped (and the channel gets the fulfillment). This is the real divergence the old 'stuck >2 days' check was mis-flagging.",
    remediation: "REPLAY_AFTER_FIX", replaySafe: true,
    count: (win: any) => sql`SELECT COUNT(DISTINCT oo.id)::int AS count FROM oms.oms_orders oo JOIN wms.orders wo ON ${LINK} WHERE oo.status NOT IN ('shipped','cancelled','refunded','partially_shipped') AND wo.warehouse_status = 'completed' AND oo.ordered_at > ${win}`,
    sample: (win: any) => sql`SELECT oo.external_order_number AS order_number, oo.status, oo.fulfillment_status, wo.warehouse_status, oo.ordered_at AS at FROM oms.oms_orders oo JOIN wms.orders wo ON ${LINK} WHERE oo.status NOT IN ('shipped','cancelled','refunded','partially_shipped') AND wo.warehouse_status = 'completed' AND oo.ordered_at > ${win} ORDER BY oo.ordered_at DESC LIMIT 50`,
  },
  {
    code: "SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED", kind: "stuck", stage: "writeback", severity: "critical",
    message: "Shipped, but tracking not sent to the channel",
    why: "These shipped but the tracking number was never sent back to the sales channel, so the customer sees no shipping update. Re-send the tracking to the channel.",
    remediation: "REQUEUE", replaySafe: true,
    count: (win: any) => sql`
      WITH shipped AS (
        SELECT os.id AS shipment_id,
               (
                 (c.provider = 'shopify' AND NULLIF(os.shopify_fulfillment_id, '') IS NOT NULL)
                 OR EXISTS (
                   SELECT 1
                   FROM oms.oms_order_events e
                   WHERE e.order_id = oo.id
                     AND e.details->>'wmsShipmentId' = os.id::text
                     AND (
                       (c.provider = 'shopify' AND e.event_type = 'shopify_fulfillment_pushed')
                       OR (c.provider = 'ebay' AND e.event_type = 'tracking_pushed')
                     )
                 )
               ) AS writeback_complete
        FROM oms.oms_orders oo
        JOIN channels.channels c ON c.id = oo.channel_id
        JOIN wms.orders wo ON ${LINK}
        JOIN wms.outbound_shipments os ON os.order_id = wo.id
        WHERE oo.status IN ('shipped', 'partially_shipped')
          AND os.status = 'shipped'
          AND os.shipped_at < NOW() - INTERVAL '1 hour'
          AND os.shipped_at > ${win}
          AND c.provider IN ('ebay', 'shopify')
          AND EXISTS (
            SELECT 1
            FROM wms.outbound_shipment_items osi
            JOIN wms.order_items oi ON oi.id = osi.order_item_id
            WHERE osi.shipment_id = os.id
              AND COALESCE(oi.requires_shipping, 1) <> 0
              AND COALESCE(osi.qty, 0) > 0
          )
      )
      SELECT COUNT(*)::int AS count FROM shipped WHERE writeback_complete = false
    `,
    sample: (win: any) => sql`
      WITH shipped AS (
        SELECT os.id AS shipment_id,
               oo.external_order_number AS order_number,
               c.provider,
               os.tracking_number,
               os.shipped_at AS at,
               (
                 (c.provider = 'shopify' AND NULLIF(os.shopify_fulfillment_id, '') IS NOT NULL)
                 OR EXISTS (
                   SELECT 1
                   FROM oms.oms_order_events e
                   WHERE e.order_id = oo.id
                     AND e.details->>'wmsShipmentId' = os.id::text
                     AND (
                       (c.provider = 'shopify' AND e.event_type = 'shopify_fulfillment_pushed')
                       OR (c.provider = 'ebay' AND e.event_type = 'tracking_pushed')
                     )
                 )
               ) AS writeback_complete
        FROM oms.oms_orders oo
        JOIN channels.channels c ON c.id = oo.channel_id
        JOIN wms.orders wo ON ${LINK}
        JOIN wms.outbound_shipments os ON os.order_id = wo.id
        WHERE oo.status IN ('shipped', 'partially_shipped')
          AND os.status = 'shipped'
          AND os.shipped_at < NOW() - INTERVAL '1 hour'
          AND os.shipped_at > ${win}
          AND c.provider IN ('ebay', 'shopify')
          AND EXISTS (
            SELECT 1
            FROM wms.outbound_shipment_items osi
            JOIN wms.order_items oi ON oi.id = osi.order_item_id
            WHERE osi.shipment_id = os.id
              AND COALESCE(oi.requires_shipping, 1) <> 0
              AND COALESCE(osi.qty, 0) > 0
          )
      )
      SELECT shipment_id, order_number, provider, tracking_number, at
      FROM shipped
      WHERE writeback_complete = false
      ORDER BY at ASC, shipment_id ASC
      LIMIT 50
    `,
  },
  {
    // Catches a channel push that is tied to a physical shipment but carries a
    // different tracking number than the shipment currently marked shipped.
    // This is intentionally shipment-scoped: an order-level last push cannot
    // identify which split package a stale tracking number belongs to.
    code: "CHANNEL_TRACKING_STALE", kind: "contradiction", stage: "writeback", severity: "warning",
    message: "Shipped, but the channel has stale tracking",
    why: "The tracking we sent the sales channel no longer matches the shipment that actually went out — usually the original label was voided and the order re-shipped with a new tracking that was never re-pushed. The customer is following a dead/voided tracking link. Re-push the current tracking to the channel.",
    remediation: "REQUEUE", replaySafe: true,
    count: (win: any) => sql`
      SELECT COUNT(*)::int AS count
      FROM oms.oms_orders oo
      JOIN channels.channels c ON c.id = oo.channel_id
      JOIN wms.orders wo ON ${LINK}
      JOIN wms.outbound_shipments os ON os.order_id = wo.id
      JOIN LATERAL (
        SELECT NULLIF(e.details->>'trackingNumber', '') AS pushed
        FROM oms.oms_order_events e
        WHERE e.order_id = oo.id
          AND e.details->>'wmsShipmentId' = os.id::text
          AND NULLIF(e.details->>'trackingNumber', '') IS NOT NULL
          AND (
            (c.provider = 'shopify' AND e.event_type = 'shopify_fulfillment_pushed')
            OR (c.provider = 'ebay' AND e.event_type = 'tracking_pushed')
          )
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 1
      ) latest_push ON latest_push.pushed <> NULLIF(os.tracking_number, '')
      WHERE oo.status IN ('shipped', 'partially_shipped')
        AND c.provider IN ('ebay', 'shopify')
        AND os.status = 'shipped'
        AND os.shipped_at > ${win}
        AND NULLIF(os.tracking_number, '') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM wms.outbound_shipment_items osi
          JOIN wms.order_items oi ON oi.id = osi.order_item_id
          WHERE osi.shipment_id = os.id
            AND COALESCE(oi.requires_shipping, 1) <> 0
            AND COALESCE(osi.qty, 0) > 0
        )
    `,
    sample: (win: any) => sql`
      SELECT oo.external_order_number AS order_number,
             os.id AS shipment_id,
             c.provider,
             latest_push.pushed AS channel_tracking,
             os.tracking_number AS actual_tracking,
             os.shipped_at AS at
      FROM oms.oms_orders oo
      JOIN channels.channels c ON c.id = oo.channel_id
      JOIN wms.orders wo ON ${LINK}
      JOIN wms.outbound_shipments os ON os.order_id = wo.id
      JOIN LATERAL (
        SELECT NULLIF(e.details->>'trackingNumber', '') AS pushed
        FROM oms.oms_order_events e
        WHERE e.order_id = oo.id
          AND e.details->>'wmsShipmentId' = os.id::text
          AND NULLIF(e.details->>'trackingNumber', '') IS NOT NULL
          AND (
            (c.provider = 'shopify' AND e.event_type = 'shopify_fulfillment_pushed')
            OR (c.provider = 'ebay' AND e.event_type = 'tracking_pushed')
          )
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 1
      ) latest_push ON latest_push.pushed <> NULLIF(os.tracking_number, '')
      WHERE oo.status IN ('shipped', 'partially_shipped')
        AND c.provider IN ('ebay', 'shopify')
        AND os.status = 'shipped'
        AND os.shipped_at > ${win}
        AND NULLIF(os.tracking_number, '') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM wms.outbound_shipment_items osi
          JOIN wms.order_items oi ON oi.id = osi.order_item_id
          WHERE osi.shipment_id = os.id
            AND COALESCE(oi.requires_shipping, 1) <> 0
            AND COALESCE(osi.qty, 0) > 0
        )
      ORDER BY os.shipped_at DESC, os.id DESC
      LIMIT 50
    `,
  },
];

// ── Dead-letter reason buckets — one first-class issue per reason code ──
// Instead of one undifferentiated "1057 dead" list, each reason is its own
// drillable chip (count + what + where + what-to-do), at the stage where it
// actually fails, with the CORRECT remediation (e.g. no-stock is "receive stock
// then re-run", NOT a misleading "replay-safe"). Classification reuses
// DEAD_LETTER_REASON_CODE so the split exactly matches the breakdown, and the
// UNCLASSIFIED bucket is itself an issue — a new failure mode surfaces as a chip.
interface DeadLetterReasonDef {
  code: string;
  stage: FunnelStageKey | "other";
  severity: "critical" | "warning" | "info";
  message: string;
  why: string;
  remediation: RemediationClass;
  replaySafe: boolean;
}
const DEAD_LETTER_REASONS: DeadLetterReasonDef[] = [
  { code: "SHIPNOTIFY_NO_INVENTORY", stage: "shipped", severity: "critical",
    message: "Shipped, but no stock on hand to deduct",
    why: "The package shipped but there was no stock on hand to subtract, so recording the shipment was blocked. Receive the stock first, then re-run these — re-running alone won't help until the stock is there. (This is the inventory-deduction gap.)",
    remediation: "REPLAY_AFTER_STOCK", replaySafe: false },
  { code: "SHIPNOTIFY_UNSPECIFIED", stage: "shipped", severity: "warning",
    message: "Ship update failed — reason wasn't recorded",
    why: "These older failures didn't save why they failed (from before we captured the detail) — almost all are the same out-of-stock problem from one week in May. Treat them like the no-stock bucket, or clear them if those orders are long settled.",
    remediation: "INVESTIGATE", replaySafe: false },
  { code: "SHOPIFY_PUSH_NO_POSITIVE_QTY", stage: "writeback", severity: "warning",
    message: "Tracking push — the shipment had no items",
    why: "We tried to send tracking to Shopify but the shipment had nothing to report (no items with a quantity). Find why the shipment came through empty before retrying.",
    remediation: "INVESTIGATE", replaySafe: false },
  { code: "SHIPNOTIFY_UNMAPPED_LINEITEM", stage: "shipped", severity: "warning",
    message: "Ship update — items didn't match the order",
    why: "The shipping app's items couldn't be matched back to the order's items, so the ship update was rejected. Match them up by hand, then re-run.",
    remediation: "MANUAL_REVIEW", replaySafe: false },
  { code: "SHOPIFY_PUSH_SKU_NOT_ON_FO", stage: "writeback", severity: "warning",
    message: "Tracking push — item isn't on the order",
    why: "Shopify says the item we shipped isn't on its copy of the order (often a pre-order or a changed line). Reconcile the order on Shopify, then re-send tracking.",
    remediation: "INVESTIGATE", replaySafe: false },
  { code: "OMS_WMS_SYNC_NO_ORDER", stage: "oms_to_wms", severity: "critical",
    message: "Hand-off failed — no warehouse order created",
    why: "Sending the order to the warehouse produced nothing, so it can't be picked. Re-send it to the warehouse.",
    remediation: "REPLAY_AFTER_FIX", replaySafe: true },
  { code: "SHIPNOTIFY_SHIPMENT_NOT_FOUND", stage: "shipped", severity: "warning",
    message: "Ship update — shipment not found",
    why: "A ship notice arrived for a shipment we can't find — usually it was voided or replaced. Confirm the shipment, then clear or re-run.",
    remediation: "INVESTIGATE", replaySafe: false },
  { code: "SHIPSTATION_COUNTRY_CODE", stage: "engine_push", severity: "warning",
    message: "Push rejected — country code must be 2 letters",
    why: "The shipping app rejected the address because the country wasn't a 2-letter code. The normalizer should fix new ones; re-run these once you've confirmed the fix is live.",
    remediation: "REQUEUE", replaySafe: true },
  { code: "PUSH_NEGATIVE_TOTAL", stage: "engine_push", severity: "warning",
    message: "Push rejected — order total came out negative",
    why: "The computed order total was below zero, so the push was rejected. Check the line/discount math on the order before retrying.",
    remediation: "INVESTIGATE", replaySafe: false },
  { code: "PUSH_TOTAL_MISMATCH", stage: "engine_push", severity: "warning",
    message: "Push rejected — order total didn't match",
    why: "The order total we computed didn't match the channel's, so the push was rejected. Reconcile the totals before retrying.",
    remediation: "INVESTIGATE", replaySafe: false },
  { code: "DB_CONNECT_TIMEOUT", stage: "shipped", severity: "warning",
    message: "Temporary database timeout",
    why: "A transient database timeout — not a real problem with the order. Safe to re-run.",
    remediation: "REQUEUE", replaySafe: true },
  { code: "SHOPIFY_REFUND_CASCADE_FAILED", stage: "wms_fulfill", severity: "critical",
    message: "Refund line update did not finish",
    why: "Shopify recorded the refund, but the OMS/WMS line disposition did not finish. Re-run the event; the refund id makes authority, reservation, shipment, and expected-return updates idempotent.",
    remediation: "REQUEUE", replaySafe: true },
  { code: "INTERNAL_API_500", stage: "shipped", severity: "warning",
    message: "Internal error (500)",
    why: "An internal request errored out. If it's not recurring, re-running clears it; if it recurs, the underlying call needs a look.",
    remediation: "REQUEUE", replaySafe: true },
  { code: "NO_MESSAGE", stage: "intake", severity: "warning",
    message: "Failed with no error recorded",
    why: "The update failed but saved no reason. Open a couple to see what they have in common, then add a rule so they bucket correctly.",
    remediation: "INVESTIGATE", replaySafe: false },
  { code: "UNCLASSIFIED", stage: "intake", severity: "warning",
    message: "Unclassified failure — needs a rule",
    why: "A failure we haven't labeled yet. This catch-all is what makes new problems visible — open a few, find the common reason, and add it to the reason list so it gets its own bucket.",
    remediation: "INVESTIGATE", replaySafe: false },
];

// Drill-down rows for ONE reason bucket (the dead-letter row query + reason filter).
// Resolves an order ref per topic so the rows are actionable: oms_wms_sync carries
// {omsOrderId} → oms_orders.external_order_number; shopify_fulfillment_push carries
// {shipmentId} → our shipment → wms order number; SHIP_NOTIFY carries only a ShipStation
// {resource_url batchId} (a batch of many orders — no single order), surfaced as
// shipstation_batch so it can at least be opened in ShipStation.
const deadLetterRows = (reasonCode: string) => sql`SELECT ${DEAD_LETTER_REASON_CODE} AS reason_code, COALESCE(rq.payload->>'name', rq.payload->>'order_number', rq.payload->>'orderNumber', oo.external_order_number, wo.order_number) AS order_number, rq.payload->>'shipmentId' AS shipment_id, (regexp_match(rq.payload->>'resource_url', 'batchId=([0-9]+)'))[1] AS shipstation_batch, rq.provider, rq.topic, rq.attempts, rq.last_error, rq.next_retry_at, rq.updated_at AS at, rq.id AS retry_id FROM oms.webhook_retry_queue rq LEFT JOIN wms.outbound_shipments os ON os.id = NULLIF(rq.payload->>'shipmentId','')::int LEFT JOIN wms.orders wo ON wo.id = os.order_id LEFT JOIN oms.oms_orders oo ON oo.id = NULLIF(rq.payload->>'omsOrderId','')::int WHERE rq.status = 'dead' AND (${DEAD_LETTER_REASON_CODE}) = ${reasonCode} ORDER BY rq.updated_at DESC NULLS LAST LIMIT 50`;

const DEAD_LETTER_ISSUES: FlowIssueDef[] = DEAD_LETTER_REASONS.map((r) => ({
  code: r.code, kind: "queue_failure", stage: r.stage, severity: r.severity,
  message: r.message, why: r.why, remediation: r.remediation, replaySafe: r.replaySafe,
  // Counts come from ONE grouped pass in getFlowWaterfall (pool-friendly); this
  // standalone form is used by the registry test and any direct count.
  count: () => sql`SELECT COUNT(*)::int AS count FROM oms.webhook_retry_queue rq WHERE rq.status = 'dead' AND (${DEAD_LETTER_REASON_CODE}) = ${r.code}`,
  sample: () => deadLetterRows(r.code),
}));

export const FLOW_ISSUES: FlowIssueDef[] = [...BASE_ISSUES, ...DEAD_LETTER_ISSUES];

// Back-compat view: the contradiction subset, still validated by the invariants test
// (so a refactor can't silently drop the 2026-06 audit bug classes).
export const CONSISTENCY_INVARIANTS = FLOW_ISSUES.filter((i) => i.kind === "contradiction");

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

    // ---- funnel (windowed on the INDEXED ordered_at) ----
    const entered = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM oms.oms_orders oo WHERE oo.ordered_at > ${win}`));
    const reachedWms = num(await tx.execute(sql`SELECT COUNT(DISTINCT oo.id)::int AS count FROM oms.oms_orders oo JOIN wms.orders wo ON ${LINK} WHERE oo.ordered_at > ${win}`));
    const hasShipment = num(await tx.execute(sql`SELECT COUNT(DISTINCT oo.id)::int AS count FROM oms.oms_orders oo JOIN wms.orders wo ON ${LINK} JOIN wms.outbound_shipments os ON os.order_id = wo.id AND os.status <> 'voided' WHERE oo.ordered_at > ${win}`));
    const shipped = num(await tx.execute(sql`SELECT COUNT(*)::int AS count FROM oms.oms_orders oo WHERE oo.ordered_at > ${win} AND oo.status IN ('shipped', 'partially_shipped')`));
    const trackingConfirmed = num(await tx.execute(sql`
      WITH shipped_orders AS (
        SELECT oo.id,
               BOOL_AND(
                 (
                   (c.provider = 'shopify' AND NULLIF(os.shopify_fulfillment_id, '') IS NOT NULL)
                   OR EXISTS (
                     SELECT 1
                     FROM oms.oms_order_events e
                     WHERE e.order_id = oo.id
                       AND e.details->>'wmsShipmentId' = os.id::text
                       AND (
                         (c.provider = 'shopify' AND e.event_type = 'shopify_fulfillment_pushed')
                         OR (c.provider = 'ebay' AND e.event_type = 'tracking_pushed')
                       )
                   )
                 )
               ) AS all_shipments_written
        FROM oms.oms_orders oo
        JOIN channels.channels c ON c.id = oo.channel_id
        JOIN wms.orders wo ON ${LINK}
        JOIN wms.outbound_shipments os ON os.order_id = wo.id
        WHERE oo.ordered_at > ${win}
          AND oo.status IN ('shipped', 'partially_shipped')
          AND os.status = 'shipped'
          AND c.provider IN ('ebay', 'shopify')
          AND EXISTS (
            SELECT 1
            FROM wms.outbound_shipment_items osi
            JOIN wms.order_items oi ON oi.id = osi.order_item_id
            WHERE osi.shipment_id = os.id
              AND COALESCE(oi.requires_shipping, 1) <> 0
              AND COALESCE(osi.qty, 0) > 0
          )
        GROUP BY oo.id
      )
      SELECT COUNT(*)::int AS count
      FROM shipped_orders
      WHERE all_shipments_written
    `));

    const channels = rows(await tx.execute(sql`SELECT COALESCE(c.provider,'unknown') AS provider, COUNT(*)::int AS entered FROM oms.oms_orders oo LEFT JOIN channels.channels c ON c.id = oo.channel_id WHERE oo.ordered_at > ${win} GROUP BY 1 ORDER BY 2 DESC`)).map((r) => ({ provider: String(r.provider), entered: Number(r.entered) || 0 }));
    const volumePerDay = rows(await tx.execute(sql`SELECT to_char(date_trunc('day', ordered_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS orders FROM oms.oms_orders WHERE ordered_at > ${win} GROUP BY 1 ORDER BY 1`)).map((r) => ({ day: String(r.day), orders: Number(r.orders) || 0 }));
    const wmsBuckets = rows(await tx.execute(sql`SELECT warehouse_status AS status, COUNT(*)::int AS count FROM wms.orders WHERE created_at > ${win} GROUP BY 1 ORDER BY 2 DESC`)).map((r) => ({ status: String(r.status), count: Number(r.count) || 0 }));
    const eventSpine = rows(await tx.execute(sql`SELECT event_type AS "eventType", COUNT(*)::int AS count FROM oms.oms_order_events WHERE created_at > ${win} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`)).map((r) => ({ eventType: String(r.eventType), count: Number(r.count) || 0 }));

    // ---- dead-letter reason counts in ONE grouped pass (one query feeds every
    // queue_failure bucket AND the sidebar breakdown — keeps the tiny pool happy) ----
    const dlRows = rows(await tx.execute(sql`SELECT ${DEAD_LETTER_REASON_CODE} AS code, COUNT(*)::int AS count FROM oms.webhook_retry_queue rq WHERE rq.status = 'dead' GROUP BY 1`));
    const dlMap: Record<string, number> = {};
    for (const r of dlRows) dlMap[String(r.code)] = Number(r.count) || 0;

    // ---- issues: iterate the ONE registry, counts only, SEQUENTIAL (pool-safe).
    // queue_failure (dead-letter) buckets read from dlMap; everything else self-counts. ----
    const bc: Record<string, number> = {};
    const allIssues: FlowIssue[] = [];
    for (const def of FLOW_ISSUES) {
      const count = def.kind === "queue_failure" ? (dlMap[def.code] ?? 0) : num(await tx.execute(def.count(win)));
      bc[def.code] = count;
      allIssues.push({
        code: def.code, kind: def.kind, severity: def.severity, stage: def.stage,
        count, message: def.message, why: def.why, remediation: def.remediation,
        replaySafe: def.replaySafe, sample: [],
      });
    }
    const issues = allIssues.filter((i) => i.count > 0);
    const channelWriteback = await getChannelWritebackHealth(tx, {
      windowDays,
      sampleLimit: 50,
    });
    const counts = issues.reduce((a, i) => { (a as any)[i.severity] += i.count; return a; }, { critical: 0, warning: 0, info: 0 });

    // ---- dead-letter reason breakdown for the sidebar (from the same grouped pass) ----
    const deadLetterCauses = Object.entries(dlMap)
      .map(([code, count]) => ({ code, cause: DEAD_LETTER_LABELS[code] ?? code, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 14);

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
      // Back-compat summary fields, now derived from the registry counts.
      duplicates: { omsToPicking: bc.OMS_DOUBLE_PICKING ?? 0, overShippedItems: bc.ITEM_OVER_SHIPPED ?? 0, unmappedEngineSplits: bc.UNMAPPED_ENGINE_SPLIT ?? 0, blockedDupOrders: bc.BLOCKED_DUP_INGEST ?? 0, sample: [] },
      deadLetterCauses,
      crossSystem: { wmsShippedOmsOpen: bc.WMS_SHIPPED_OMS_OPEN ?? 0, omsNotUpdated: bc.ORDER_FULFILLED_OMS_NOT_UPDATED ?? 0, sample: [] },
      sla: { breached: bc.SLA_BREACHED ?? 0, sample: [] },
      issues,
      health: { generatedAt: new Date().toISOString(), status: counts.critical > 0 ? "critical" : counts.warning > 0 ? "degraded" : "healthy", counts },
      channelWriteback,
    };
  });
}

/**
 * On-demand drill-down: the offending rows for ONE issue. Kept out of
 * getFlowWaterfall so the waterfall stays counts-only and cheap; this fires a
 * single LIMIT-capped query for just the issue the user opened — same one
 * read-only transaction + statement_timeout contract, so still ≤1 pool connection.
 * The sample query is the registry entry's own `sample` builder (mirrors its count).
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
    const def = FLOW_ISSUES.find((i) => i.code === code);
    if (!def) return { code, rows: [] };
    return { code, rows: rows(await tx.execute(def.sample(win))) };
  });
}
