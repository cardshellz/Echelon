/**
 * Enterprise Operations Dashboard — Phase 7B
 *
 * Single consolidated service that aggregates operational health across all
 * subsystems: OMS flow, WMS operations, shipment status, inventory health,
 * procurement pipeline, and financial KPIs.
 *
 * Each section calls existing services or runs lightweight SQL to avoid
 * duplicating logic. The dashboard endpoint returns the full picture in
 * one response so the frontend can render a unified operations view.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

// ─── Types ─────────────────────────────────────────────────────────

export interface OrderPipelineSummary {
  total: number;
  byStatus: Record<string, number>;
  stuckOrders: number;
  avgAgeHours: number;
  oldestUnshippedHours: number;
}

export interface ShipmentHealthSummary {
  total: number;
  byStatus: Record<string, number>;
  unpushed: number;
  requiresReview: number;
  onHold: number;
  shippedInRange: number;
}

export interface InventoryHealthSummary {
  totalSkus: number;
  totalOnHand: number;
  totalReserved: number;
  totalAvailable: number;
  lowStockSkus: number;
  outOfStockSkus: number;
  overstockSkus: number;
  negativeInventory: number;
}

export interface ProcurementPipelineSummary {
  openPoCount: number;
  openPoValue: number;
  draftPoCount: number;
  overduePoCount: number;
  inTransitShipments: number;
  expectedReceiptsNext30Days: number;
}

export interface FinancialKpis {
  inventoryValueCents: number;
  openPoValueCents: number;
  pendingApCents: number;
  revenueCents: number;
  orderCount: number;
  avgOrderValueCents: number;
}

export interface WebhookHealthSummary {
  pendingRetries: number;
  deadLetters: number;
  failedInbox: number;
  staleRetries: number;
}

export interface ForwardDemandSummary {
  activeEvents: number;
  plannedEvents: number;
  totalForwardDemandPieces: number;
  productsWithForwardDemand: number;
}

export interface EnterpriseDashboard {
  generatedAt: string;
  orderPipeline: OrderPipelineSummary;
  shipmentHealth: ShipmentHealthSummary;
  inventoryHealth: InventoryHealthSummary;
  procurementPipeline: ProcurementPipelineSummary;
  financialKpis: FinancialKpis;
  webhookHealth: WebhookHealthSummary;
  forwardDemand: ForwardDemandSummary;
}

// ─── Helpers ───────────────────────────────────────────────────────

function num(val: any): number {
  return Number(val) || 0;
}

function statusMap(rows: any[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const row of rows) {
    map[row.status ?? "unknown"] = num(row.count);
  }
  return map;
}

// ─── Data fetchers ─────────────────────────────────────────────────

async function getOrderPipeline(): Promise<OrderPipelineSummary> {
  const [statusResult, stuckResult, ageResult] = await Promise.all([
    db.execute(sql`
      SELECT warehouse_status AS status, COUNT(*)::int AS count
      FROM wms.orders
      WHERE warehouse_status NOT IN ('cancelled', 'shipped')
        AND cancelled_at IS NULL
      GROUP BY warehouse_status
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM wms.orders
      WHERE warehouse_status NOT IN ('cancelled', 'shipped', 'completed')
        AND cancelled_at IS NULL
        AND created_at < NOW() - INTERVAL '48 hours'
    `),
    db.execute(sql`
      SELECT
        ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600))::int AS avg_age_hours,
        ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600))::int AS oldest_hours
      FROM wms.orders
      WHERE warehouse_status NOT IN ('cancelled', 'shipped', 'completed')
        AND cancelled_at IS NULL
    `),
  ]);

  const byStatus = statusMap(statusResult.rows as any[]);
  const total = Object.values(byStatus).reduce((s, v) => s + v, 0);

  return {
    total,
    byStatus,
    stuckOrders: num((stuckResult.rows[0] as any)?.count),
    avgAgeHours: num((ageResult.rows[0] as any)?.avg_age_hours),
    oldestUnshippedHours: num((ageResult.rows[0] as any)?.oldest_hours),
  };
}

async function getShipmentHealth(from: Date, to: Date): Promise<ShipmentHealthSummary> {
  const [statusResult, metricsResult] = await Promise.all([
    db.execute(sql`
      SELECT status::text AS status, COUNT(*)::int AS count
      FROM wms.outbound_shipments
      WHERE voided_at IS NULL
      GROUP BY status
    `),
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE status IN ('planned', 'queued')
            AND engine_order_ref IS NULL
            AND created_at < NOW() - INTERVAL '15 minutes'
            AND voided_at IS NULL
        )::int AS unpushed,
        COUNT(*) FILTER (WHERE requires_review = true AND voided_at IS NULL)::int AS requires_review,
        COUNT(*) FILTER (WHERE status = 'on_hold' AND voided_at IS NULL)::int AS on_hold,
        COUNT(*) FILTER (
          WHERE shipped_at >= ${from} AND shipped_at < ${to} AND voided_at IS NULL
        )::int AS shipped_in_range
      FROM wms.outbound_shipments
    `),
  ]);

  const byStatus = statusMap(statusResult.rows as any[]);
  const total = Object.values(byStatus).reduce((s, v) => s + v, 0);
  const m = metricsResult.rows[0] as any;

  return {
    total,
    byStatus,
    unpushed: num(m?.unpushed),
    requiresReview: num(m?.requires_review),
    onHold: num(m?.on_hold),
    shippedInRange: num(m?.shipped_in_range),
  };
}

async function getInventoryHealth(): Promise<InventoryHealthSummary> {
  const result = await db.execute(sql`
    SELECT
      COUNT(DISTINCT il.product_variant_id)::int AS total_skus,
      COALESCE(SUM(il.variant_qty), 0)::int AS total_on_hand,
      COALESCE(SUM(il.reserved_qty), 0)::int AS total_reserved,
      COALESCE(SUM(GREATEST(il.variant_qty - il.reserved_qty, 0)), 0)::int AS total_available,
      COUNT(DISTINCT CASE
        WHEN il.variant_qty > 0 AND il.variant_qty <= 5 THEN il.product_variant_id
      END)::int AS low_stock_skus,
      COUNT(DISTINCT CASE
        WHEN il.variant_qty <= 0 THEN il.product_variant_id
      END)::int AS out_of_stock_skus,
      COUNT(DISTINCT CASE
        WHEN il.variant_qty > 100 THEN il.product_variant_id
      END)::int AS overstock_skus,
      COUNT(DISTINCT CASE
        WHEN il.variant_qty < 0 THEN il.product_variant_id
      END)::int AS negative_inventory
    FROM inventory.inventory_levels il
  `);

  const r = result.rows[0] as any;
  return {
    totalSkus: num(r?.total_skus),
    totalOnHand: num(r?.total_on_hand),
    totalReserved: num(r?.total_reserved),
    totalAvailable: num(r?.total_available),
    lowStockSkus: num(r?.low_stock_skus),
    outOfStockSkus: num(r?.out_of_stock_skus),
    overstockSkus: num(r?.overstock_skus),
    negativeInventory: num(r?.negative_inventory),
  };
}

async function getProcurementPipeline(): Promise<ProcurementPipelineSummary> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('approved', 'sent', 'acknowledged', 'partially_received'))::int AS open_po_count,
      COALESCE(SUM(total_amount_cents) FILTER (WHERE status IN ('approved', 'sent', 'acknowledged', 'partially_received')), 0)::bigint AS open_po_value,
      COUNT(*) FILTER (WHERE status = 'draft')::int AS draft_po_count,
      COUNT(*) FILTER (
        WHERE status IN ('approved', 'sent', 'acknowledged')
          AND expected_delivery_date < CURRENT_DATE
      )::int AS overdue_po_count
    FROM procurement.purchase_orders
  `);

  const shipmentResult = await db.execute(sql`
    SELECT COUNT(*)::int AS in_transit
    FROM procurement.inbound_shipments
    WHERE status IN ('in_transit', 'shipped', 'booked')
  `);

  const receiptResult = await db.execute(sql`
    SELECT COUNT(DISTINCT pol.purchase_order_id)::int AS expected_next_30
    FROM procurement.purchase_order_lines pol
    JOIN procurement.purchase_orders po ON po.id = pol.purchase_order_id
    WHERE pol.status IN ('open', 'partially_received')
      AND po.status IN ('approved', 'sent', 'acknowledged', 'partially_received')
      AND COALESCE(pol.expected_delivery_date, po.expected_delivery_date) <= CURRENT_DATE + INTERVAL '30 days'
  `);

  const r = result.rows[0] as any;
  return {
    openPoCount: num(r?.open_po_count),
    openPoValue: num(r?.open_po_value),
    draftPoCount: num(r?.draft_po_count),
    overduePoCount: num(r?.overdue_po_count),
    inTransitShipments: num((shipmentResult.rows[0] as any)?.in_transit),
    expectedReceiptsNext30Days: num((receiptResult.rows[0] as any)?.expected_next_30),
  };
}

async function getFinancialKpis(from: Date, to: Date): Promise<FinancialKpis> {
  const [invResult, poResult, apResult, orderResult] = await Promise.all([
    db.execute(sql`
      SELECT COALESCE(SUM(il.variant_qty * COALESCE(lot_cost.unit_cost_cents, 0)), 0)::bigint AS value
      FROM inventory.inventory_levels il
      LEFT JOIN LATERAL (
        SELECT unit_cost_cents
        FROM inventory.inventory_lots
        WHERE product_variant_id = il.product_variant_id
          AND on_hand_qty > 0
        ORDER BY created_at DESC
        LIMIT 1
      ) lot_cost ON true
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(total_amount_cents), 0)::bigint AS value
      FROM procurement.purchase_orders
      WHERE status IN ('approved', 'sent', 'acknowledged', 'partially_received')
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(total_amount_cents), 0)::bigint AS value
      FROM procurement.vendor_invoices
      WHERE status IN ('received', 'approved', 'partially_paid')
    `),
    db.execute(sql`
      SELECT
        COALESCE(SUM(amount_paid_cents), 0)::bigint AS revenue_cents,
        COUNT(*)::int AS order_count
      FROM wms.orders
      WHERE cancelled_at IS NULL
        AND order_placed_at >= ${from}
        AND order_placed_at < ${to}
    `),
  ]);

  const o = orderResult.rows[0] as any;
  const orderCount = num(o?.order_count);
  const revenueCents = num(o?.revenue_cents);
  return {
    inventoryValueCents: num((invResult.rows[0] as any)?.value),
    openPoValueCents: num((poResult.rows[0] as any)?.value),
    pendingApCents: num((apResult.rows[0] as any)?.value),
    revenueCents,
    orderCount,
    avgOrderValueCents: orderCount > 0 ? Math.round(revenueCents / orderCount) : 0,
  };
}

async function getWebhookHealth(): Promise<WebhookHealthSummary> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_retries,
      COUNT(*) FILTER (WHERE status = 'dead')::int AS dead_letters,
      COUNT(*) FILTER (
        WHERE status = 'pending'
          AND next_retry_at < NOW() - INTERVAL '15 minutes'
      )::int AS stale_retries
    FROM oms.webhook_retry_queue
  `);

  const inboxResult = await db.execute(sql`
    SELECT COUNT(*)::int AS failed
    FROM oms.webhook_inbox
    WHERE status IN ('failed', 'dead')
  `);

  const r = result.rows[0] as any;
  return {
    pendingRetries: num(r?.pending_retries),
    deadLetters: num(r?.dead_letters),
    failedInbox: num((inboxResult.rows[0] as any)?.failed),
    staleRetries: num(r?.stale_retries),
  };
}

async function getForwardDemandSummary(): Promise<ForwardDemandSummary> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active')::int AS active_events,
      COUNT(*) FILTER (WHERE status = 'planned')::int AS planned_events
    FROM procurement.demand_events
    WHERE status IN ('active', 'planned')
  `);

  const lineResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(del.expected_pieces), 0)::int AS total_pieces,
      COUNT(DISTINCT del.product_id)::int AS product_count
    FROM procurement.demand_event_lines del
    JOIN procurement.demand_events de ON de.id = del.demand_event_id
    WHERE de.status IN ('active', 'planned')
      AND de.start_date >= CURRENT_DATE
  `);

  const r = result.rows[0] as any;
  const l = lineResult.rows[0] as any;
  return {
    activeEvents: num(r?.active_events),
    plannedEvents: num(r?.planned_events),
    totalForwardDemandPieces: num(l?.total_pieces),
    productsWithForwardDemand: num(l?.product_count),
  };
}

// ─── Resilient wrapper ─────────────────────────────────────────────
// Each section is independently faulted so one bad query (e.g. missing
// table before migration runs) doesn't crash the whole dashboard.

async function safe<T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    console.error(`[EnterpriseDashboard] ${label} failed:`, err?.message ?? err);
    return fallback;
  }
}

// ─── Main aggregator ───────────────────────────────────────────────

export interface DashboardDateRange {
  from: Date;
  to: Date;
}

export async function getEnterpriseDashboard(range: DashboardDateRange): Promise<EnterpriseDashboard> {
  const { from, to } = range;
  const [
    orderPipeline,
    shipmentHealth,
    inventoryHealth,
    procurementPipeline,
    financialKpis,
    webhookHealth,
    forwardDemand,
  ] = await Promise.all([
    safe(getOrderPipeline, { total: 0, byStatus: {}, stuckOrders: 0, avgAgeHours: 0, oldestUnshippedHours: 0 }, "orderPipeline"),
    safe(() => getShipmentHealth(from, to), { total: 0, byStatus: {}, unpushed: 0, requiresReview: 0, onHold: 0, shippedInRange: 0 }, "shipmentHealth"),
    safe(getInventoryHealth, { totalSkus: 0, totalOnHand: 0, totalReserved: 0, totalAvailable: 0, lowStockSkus: 0, outOfStockSkus: 0, overstockSkus: 0, negativeInventory: 0 }, "inventoryHealth"),
    safe(getProcurementPipeline, { openPoCount: 0, openPoValue: 0, draftPoCount: 0, overduePoCount: 0, inTransitShipments: 0, expectedReceiptsNext30Days: 0 }, "procurementPipeline"),
    safe(() => getFinancialKpis(from, to), { inventoryValueCents: 0, openPoValueCents: 0, pendingApCents: 0, revenueCents: 0, orderCount: 0, avgOrderValueCents: 0 }, "financialKpis"),
    safe(getWebhookHealth, { pendingRetries: 0, deadLetters: 0, failedInbox: 0, staleRetries: 0 }, "webhookHealth"),
    safe(getForwardDemandSummary, { activeEvents: 0, plannedEvents: 0, totalForwardDemandPieces: 0, productsWithForwardDemand: 0 }, "forwardDemand"),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    orderPipeline,
    shipmentHealth,
    inventoryHealth,
    procurementPipeline,
    financialKpis,
    webhookHealth,
    forwardDemand,
  };
}
