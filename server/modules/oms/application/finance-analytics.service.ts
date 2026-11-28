import { readIntegerCents, readIntegerMills } from "@shared/money-read";
/**
 * Finance Analytics Service
 *
 * Computes the full revenue waterfall, per-channel breakdown, and
 * prior-period deltas from oms.oms_orders (the order source of truth).
 *
 * All money is integer cents. The client does no math.
 */

import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { millsToCents } from "@shared/utils/money";
import { wmsOmsOrderIdSql } from "../infrastructure/oms-wms-order-link.sql";

// Provider ids share this legacy text column with internal OMS references.
// Reuse the same source-aware, guarded resolution as the operations monitor;
// never cast provider GIDs or match them to coincidentally equal internal ids.
const WMS_OMS_ORDER_ID = wmsOmsOrderIdSql({
  source: sql`wo.source`,
  omsFulfillmentOrderId: sql`wo.oms_fulfillment_order_id`,
  legacySourceTableId: sql`wo.source_table_id`,
});

// ─── Types ────────────────────────────────────────────────────────

export interface FinanceMetric {
  value: number;
  priorValue: number;
  deltaPct: number | null; // null when prior is 0 (avoid ÷0)
}

function metric(value: number, priorValue: number): FinanceMetric {
  return {
    value,
    priorValue,
    deltaPct: priorValue !== 0 ? Math.round(((value - priorValue) / priorValue) * 1000) / 10 : null,
  };
}

export interface FinanceWaterfall {
  grossSalesCents: FinanceMetric;
  discountCents: FinanceMetric;
  netSalesCents: FinanceMetric;
  shippingCents: FinanceMetric;
  taxCents: FinanceMetric;
  totalCollectedCents: FinanceMetric;
  refundCents: FinanceMetric;
  netRevenueCents: FinanceMetric;
  cogsCents: FinanceMetric;
  grossMarginCents: FinanceMetric;
  grossMarginPct: FinanceMetric;
  orderCount: FinanceMetric;
  avgOrderValueCents: FinanceMetric;
  refundedOrderCount: FinanceMetric;
  cancelledOrderCount: FinanceMetric;
}

export interface ChannelBreakdown {
  channelId: number;
  channelName: string;
  provider: string;
  orderCount: number;
  grossSalesCents: number;
  discountCents: number;
  netSalesCents: number;
  shippingCents: number;
  taxCents: number;
  refundCents: number;
  netRevenueCents: number;
  cogsCents: number;
  grossMarginPct: number | null;
  avgOrderValueCents: number;
}

export interface FinanceSummary {
  waterfall: FinanceWaterfall;
  channels: ChannelBreakdown[];
  dateRange: { from: string; to: string };
  priorRange: { from: string; to: string };
}

// ─── Queries ──────────────────────────────────────────────────────

interface RawAgg {
  order_count: number;
  gross_sales_cents: number;
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_collected_cents: number;
  refund_cents: number;
  refunded_order_count: number;
  cancelled_order_count: number;
}

async function aggregateRange(from: Date, to: Date): Promise<RawAgg> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE cancelled_at IS NULL)::int AS order_count,
      COALESCE(SUM(subtotal_cents + discount_cents) FILTER (WHERE cancelled_at IS NULL), 0)::bigint AS gross_sales_cents,
      COALESCE(SUM(discount_cents) FILTER (WHERE cancelled_at IS NULL), 0)::bigint AS discount_cents,
      COALESCE(SUM(shipping_cents) FILTER (WHERE cancelled_at IS NULL), 0)::bigint AS shipping_cents,
      COALESCE(SUM(tax_cents) FILTER (WHERE cancelled_at IS NULL), 0)::bigint AS tax_cents,
      COALESCE(SUM(total_cents) FILTER (WHERE cancelled_at IS NULL), 0)::bigint AS total_collected_cents,
      COALESCE(SUM(refund_amount_cents) FILTER (WHERE cancelled_at IS NULL), 0)::bigint AS refund_cents,
      COUNT(*) FILTER (WHERE financial_status IN ('refunded', 'partially_refunded') AND cancelled_at IS NULL)::int AS refunded_order_count,
      COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL)::int AS cancelled_order_count
    FROM oms.oms_orders
    WHERE ordered_at >= ${from}
      AND ordered_at < ${to}
  `);
  const r = result.rows[0] as any;
  return {
    order_count: Number(r?.order_count) || 0,
    gross_sales_cents: readIntegerCents(r?.gross_sales_cents, "gross sales", true),
    discount_cents: readIntegerCents(r?.discount_cents, "discount", true),
    shipping_cents: readIntegerCents(r?.shipping_cents, "shipping", true),
    tax_cents: readIntegerCents(r?.tax_cents, "tax", true),
    total_collected_cents: readIntegerCents(r?.total_collected_cents, "total collected", true),
    refund_cents: readIntegerCents(r?.refund_cents, "refund", true),
    refunded_order_count: Number(r?.refunded_order_count) || 0,
    cancelled_order_count: Number(r?.cancelled_order_count) || 0,
  };
}

async function readReturnCostSchemaPresence(): Promise<{ hasReturns: boolean; hasLots: boolean; hasTx: boolean }> {
  const res = await db.execute(sql`
    SELECT
      to_regclass('inventory.return_cost_allocations') IS NOT NULL AS has_returns,
      to_regclass('inventory.inventory_lots') IS NOT NULL AS has_lots,
      to_regclass('inventory.inventory_transactions') IS NOT NULL AS has_tx
  `);
  const row = res.rows?.[0] as any;
  return {
    hasReturns: Boolean(row?.has_returns) && Boolean(row?.has_lots),
    hasLots: Boolean(row?.has_lots),
    hasTx: Boolean(row?.has_tx),
  };
}

function sellableReturnGuardSql(hasTx: boolean) {
  if (!hasTx) return sql`TRUE`;
  return sql`NOT EXISTS (
    SELECT 1 FROM inventory.inventory_transactions qtx
    WHERE qtx.inventory_lot_id = rca.returned_lot_id
      AND (
        qtx.reference_type = 'return_quarantine'
        OR (qtx.transaction_type = 'return' AND qtx.target_state IN ('damaged', 'defective'))
      )
  )`;
}

const RESTOCKED_RETURN_MILLS_EXPR = sql`COALESCE(
  CASE WHEN rlot.cost_basis_qty IS NOT NULL AND rlot.cost_basis_qty = rca.quantity
    THEN COALESCE(rlot.product_total_cost_mills, 0) + COALESCE(rlot.packaging_total_cost_mills, 0) + COALESCE(rlot.landed_total_cost_mills, 0)
    ELSE NULL END,
  rca.quantity::bigint * COALESCE(rlot.total_unit_cost_mills, rlot.unit_cost_mills, COALESCE(rlot.unit_cost_cents, 0)::bigint * 100)
)`;

async function aggregateCogs(from: Date, to: Date): Promise<number> {
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(COALESCE(NULLIF(oic.total_cost_mills, 0), oic.total_cost_cents * 100, 0)), 0)::bigint AS cogs_mills
    FROM oms.order_item_costs oic
    JOIN wms.order_items wi ON wi.id = oic.order_item_id
    JOIN wms.orders wo ON wo.id = wi.order_id
    JOIN oms.oms_orders oo ON oo.id = ${WMS_OMS_ORDER_ID}
    WHERE oo.ordered_at >= ${from}
      AND oo.ordered_at < ${to}
      AND oo.cancelled_at IS NULL
  `);
  let netMills = Math.round(readIntegerMills((result.rows[0] as any)?.cogs_mills, "cogs", true));
  const presence = await readReturnCostSchemaPresence();
  if (presence.hasReturns) {
    const returnRes = await db.execute(sql`
      SELECT COALESCE(SUM(${RESTOCKED_RETURN_MILLS_EXPR}), 0)::bigint AS restocked_return_mills
      FROM inventory.return_cost_allocations rca
      JOIN inventory.inventory_lots rlot ON rlot.id = rca.returned_lot_id
      JOIN wms.orders wo ON wo.id = rca.wms_order_id
      JOIN oms.oms_orders oo ON oo.id = ${WMS_OMS_ORDER_ID}
      WHERE oo.ordered_at >= ${from}
        AND oo.ordered_at < ${to}
        AND oo.cancelled_at IS NULL
        AND rca.source_order_item_cost_id IS NOT NULL
        AND ${sellableReturnGuardSql(presence.hasTx)}
    `);
    const returnedMills = Math.round(readIntegerMills((returnRes.rows[0] as any)?.restocked_return_mills, "restocked return cogs", true));
    netMills = Math.max(0, netMills - returnedMills);
  }
  return millsToCents(netMills);
}

async function channelBreakdown(from: Date, to: Date): Promise<ChannelBreakdown[]> {
  const result = await db.execute(sql`
    SELECT
      c.id AS channel_id,
      c.name AS channel_name,
      c.provider,
      COUNT(*) FILTER (WHERE o.cancelled_at IS NULL)::int AS order_count,
      COALESCE(SUM(o.subtotal_cents + o.discount_cents) FILTER (WHERE o.cancelled_at IS NULL), 0)::bigint AS gross_sales_cents,
      COALESCE(SUM(o.discount_cents) FILTER (WHERE o.cancelled_at IS NULL), 0)::bigint AS discount_cents,
      COALESCE(SUM(o.subtotal_cents) FILTER (WHERE o.cancelled_at IS NULL), 0)::bigint AS net_sales_cents,
      COALESCE(SUM(o.shipping_cents) FILTER (WHERE o.cancelled_at IS NULL), 0)::bigint AS shipping_cents,
      COALESCE(SUM(o.tax_cents) FILTER (WHERE o.cancelled_at IS NULL), 0)::bigint AS tax_cents,
      COALESCE(SUM(o.refund_amount_cents) FILTER (WHERE o.cancelled_at IS NULL), 0)::bigint AS refund_cents,
      COALESCE(SUM(o.total_cents - o.refund_amount_cents) FILTER (WHERE o.cancelled_at IS NULL), 0)::bigint AS net_revenue_cents
    FROM oms.oms_orders o
    JOIN channels.channels c ON c.id = o.channel_id
    WHERE o.ordered_at >= ${from}
      AND o.ordered_at < ${to}
    GROUP BY c.id, c.name, c.provider
    ORDER BY net_revenue_cents DESC
  `);

  // COGS per channel
  const cogsResult = await db.execute(sql`
    SELECT
      oo.channel_id,
      COALESCE(SUM(COALESCE(NULLIF(oic.total_cost_mills, 0), oic.total_cost_cents * 100, 0)), 0)::bigint AS cogs_mills
    FROM oms.order_item_costs oic
    JOIN wms.order_items wi ON wi.id = oic.order_item_id
    JOIN wms.orders wo ON wo.id = wi.order_id
    JOIN oms.oms_orders oo ON oo.id = ${WMS_OMS_ORDER_ID}
    WHERE oo.ordered_at >= ${from}
      AND oo.ordered_at < ${to}
      AND oo.cancelled_at IS NULL
    GROUP BY oo.channel_id
  `);
  const cogsMillsMap = new Map<number, number>();
  for (const row of cogsResult.rows as any[]) {
    cogsMillsMap.set(Number(row.channel_id), Math.round(readIntegerMills(row.cogs_mills, "cogs", true)));
  }
  const presence = await readReturnCostSchemaPresence();
  if (presence.hasReturns) {
    const returnChannelRes = await db.execute(sql`
      SELECT
        oo.channel_id,
        COALESCE(SUM(${RESTOCKED_RETURN_MILLS_EXPR}), 0)::bigint AS restocked_return_mills
      FROM inventory.return_cost_allocations rca
      JOIN inventory.inventory_lots rlot ON rlot.id = rca.returned_lot_id
      JOIN wms.orders wo ON wo.id = rca.wms_order_id
      JOIN oms.oms_orders oo ON oo.id = ${WMS_OMS_ORDER_ID}
      WHERE oo.ordered_at >= ${from}
        AND oo.ordered_at < ${to}
        AND oo.cancelled_at IS NULL
        AND rca.source_order_item_cost_id IS NOT NULL
        AND ${sellableReturnGuardSql(presence.hasTx)}
      GROUP BY oo.channel_id
    `);
    for (const row of returnChannelRes.rows as any[]) {
      const chId = Number(row.channel_id);
      const returnedMills = Math.round(readIntegerMills(row.restocked_return_mills, "restocked return cogs", true));
      cogsMillsMap.set(chId, Math.max(0, (cogsMillsMap.get(chId) ?? 0) - returnedMills));
    }
  }
  const cogsMap = new Map<number, number>();
  for (const [chId, mills] of cogsMillsMap.entries()) {
    cogsMap.set(chId, millsToCents(mills));
  }

  return (result.rows as any[]).map((r) => {
    const netRev = readIntegerCents(r.net_revenue_cents, "net rev", true);
    const cogs = cogsMap.get(Number(r.channel_id)) || 0;
    const orderCount = Number(r.order_count) || 0;
    return {
      channelId: Number(r.channel_id),
      channelName: r.channel_name,
      provider: r.provider,
      orderCount,
      grossSalesCents: readIntegerCents(r.gross_sales_cents, "gross sales", true),
      discountCents: readIntegerCents(r.discount_cents, "discount", true),
      netSalesCents: readIntegerCents(r.net_sales_cents, "net sales", true),
      shippingCents: readIntegerCents(r.shipping_cents, "shipping", true),
      taxCents: readIntegerCents(r.tax_cents, "tax", true),
      refundCents: readIntegerCents(r.refund_cents, "refund", true),
      netRevenueCents: netRev,
      cogsCents: cogs,
      grossMarginPct: netRev > 0 ? Math.round(((netRev - cogs) / netRev) * 1000) / 10 : null,
      avgOrderValueCents: orderCount > 0 ? Math.round(netRev / orderCount) : 0,
    };
  });
}

// ─── Main ─────────────────────────────────────────────────────────

function computePriorRange(from: Date, to: Date): { priorFrom: Date; priorTo: Date } {
  const durationMs = to.getTime() - from.getTime();
  const priorTo = new Date(from.getTime());
  const priorFrom = new Date(from.getTime() - durationMs);
  return { priorFrom, priorTo };
}

export async function getFinanceSummary(from: Date, to: Date): Promise<FinanceSummary> {
  const { priorFrom, priorTo } = computePriorRange(from, to);

  // A failed COGS read is unknown, not zero. Propagate it to the route's logged
  // error response instead of publishing an overstated gross margin.
  const [current, prior, currentCogs, priorCogs, channels] = await Promise.all([
    aggregateRange(from, to),
    aggregateRange(priorFrom, priorTo),
    aggregateCogs(from, to),
    aggregateCogs(priorFrom, priorTo),
    channelBreakdown(from, to),
  ]);

  const curNetSales = current.gross_sales_cents - current.discount_cents;
  const priNetSales = prior.gross_sales_cents - prior.discount_cents;
  const curNetRev = current.total_collected_cents - current.refund_cents;
  const priNetRev = prior.total_collected_cents - prior.refund_cents;
  const curMargin = curNetRev - currentCogs;
  const priMargin = priNetRev - priorCogs;
  const curMarginPct = curNetRev > 0 ? Math.round((curMargin / curNetRev) * 1000) / 10 : 0;
  const priMarginPct = priNetRev > 0 ? Math.round((priMargin / priNetRev) * 1000) / 10 : 0;
  const curAov = current.order_count > 0 ? Math.round(curNetRev / current.order_count) : 0;
  const priAov = prior.order_count > 0 ? Math.round(priNetRev / prior.order_count) : 0;

  return {
    waterfall: {
      grossSalesCents: metric(current.gross_sales_cents, prior.gross_sales_cents),
      discountCents: metric(current.discount_cents, prior.discount_cents),
      netSalesCents: metric(curNetSales, priNetSales),
      shippingCents: metric(current.shipping_cents, prior.shipping_cents),
      taxCents: metric(current.tax_cents, prior.tax_cents),
      totalCollectedCents: metric(current.total_collected_cents, prior.total_collected_cents),
      refundCents: metric(current.refund_cents, prior.refund_cents),
      netRevenueCents: metric(curNetRev, priNetRev),
      cogsCents: metric(currentCogs, priorCogs),
      grossMarginCents: metric(curMargin, priMargin),
      grossMarginPct: metric(curMarginPct, priMarginPct),
      orderCount: metric(current.order_count, prior.order_count),
      avgOrderValueCents: metric(curAov, priAov),
      refundedOrderCount: metric(current.refunded_order_count, prior.refunded_order_count),
      cancelledOrderCount: metric(current.cancelled_order_count, prior.cancelled_order_count),
    },
    channels,
    dateRange: { from: from.toISOString(), to: to.toISOString() },
    priorRange: { from: priorFrom.toISOString(), to: priorTo.toISOString() },
  };
}

// ─── Order List (drill-down) ──────────────────────────────────────

export interface FinanceOrderRow {
  id: number;
  externalOrderNumber: string | null;
  channelName: string;
  provider: string;
  orderedAt: string;
  totalCents: number;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  refundAmountCents: number;
  financialStatus: string;
  status: string;
  customerName: string | null;
  cogsCents: number;
}

export interface FinanceOrderList {
  orders: FinanceOrderRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function getFinanceOrders(opts: {
  from: Date;
  to: Date;
  channelId?: number;
  financialStatus?: string;
  page?: number;
  pageSize?: number;
}): Promise<FinanceOrderList> {
  const { from, to, page = 1, pageSize = 50 } = opts;
  const offset = (page - 1) * pageSize;

  const channelFilter = opts.channelId ? sql`AND o.channel_id = ${opts.channelId}` : sql``;
  const statusFilter = opts.financialStatus ? sql`AND o.financial_status = ${opts.financialStatus}` : sql``;

  const presence = await readReturnCostSchemaPresence();
  const returnCreditJoin = presence.hasReturns
    ? sql`LEFT JOIN LATERAL (
        SELECT SUM(${RESTOCKED_RETURN_MILLS_EXPR}) AS returned_cogs
        FROM inventory.return_cost_allocations rca
        JOIN inventory.inventory_lots rlot ON rlot.id = rca.returned_lot_id
        JOIN wms.orders wo ON wo.id = rca.wms_order_id
        WHERE ${WMS_OMS_ORDER_ID} = o.id
          AND rca.source_order_item_cost_id IS NOT NULL
          AND ${sellableReturnGuardSql(presence.hasTx)}
      ) ret_cogs ON true`
    : sql`LEFT JOIN LATERAL (SELECT 0::bigint AS returned_cogs) ret_cogs ON true`;

  const [dataResult, countResult] = await Promise.all([
    db.execute(sql`
      SELECT
        o.id,
        o.external_order_number,
        c.name AS channel_name,
        c.provider,
        o.ordered_at,
        o.total_cents,
        o.subtotal_cents,
        o.discount_cents,
        o.shipping_cents,
        o.tax_cents,
        o.refund_amount_cents,
        o.financial_status,
        o.status,
        o.customer_name,
        GREATEST(0::bigint, COALESCE(cogs.total_cogs, 0)::bigint - COALESCE(ret_cogs.returned_cogs, 0)::bigint) AS cogs_mills
      FROM oms.oms_orders o
      JOIN channels.channels c ON c.id = o.channel_id
      LEFT JOIN LATERAL (
        SELECT SUM(COALESCE(NULLIF(oic.total_cost_mills, 0), oic.total_cost_cents * 100, 0)) AS total_cogs
        FROM oms.order_item_costs oic
        JOIN wms.order_items wi ON wi.id = oic.order_item_id
        JOIN wms.orders wo ON wo.id = wi.order_id
        WHERE ${WMS_OMS_ORDER_ID} = o.id
      ) cogs ON true
      ${returnCreditJoin}
      WHERE o.ordered_at >= ${from}
        AND o.ordered_at < ${to}
        ${channelFilter}
        ${statusFilter}
      ORDER BY o.ordered_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM oms.oms_orders o
      WHERE o.ordered_at >= ${from}
        AND o.ordered_at < ${to}
        ${channelFilter}
        ${statusFilter}
    `),
  ]);

  return {
    orders: (dataResult.rows as any[]).map((r) => ({
      id: Number(r.id),
      externalOrderNumber: r.external_order_number,
      channelName: r.channel_name,
      provider: r.provider,
      orderedAt: r.ordered_at,
      totalCents: readIntegerCents(r.total_cents, "total", true),
      subtotalCents: readIntegerCents(r.subtotal_cents, "subtotal", true),
      discountCents: readIntegerCents(r.discount_cents, "discount", true),
      shippingCents: readIntegerCents(r.shipping_cents, "shipping", true),
      taxCents: readIntegerCents(r.tax_cents, "tax", true),
      refundAmountCents: readIntegerCents(r.refund_amount_cents, "refund amount", true),
      financialStatus: r.financial_status,
      status: r.status,
      customerName: r.customer_name,
      cogsCents: millsToCents(Math.round(readIntegerMills(r.cogs_mills, "cogs", true))),
    })),
    total: Number((countResult.rows[0] as any)?.total) || 0,
    page,
    pageSize,
  };
}

// ─── Single Order Detail (deepest drill) ──────────────────────────

export interface OrderLineDetail {
  id: number;
  sku: string | null;
  title: string | null;
  variantTitle: string | null;
  quantity: number;
  paidPriceCents: number;
  totalPriceCents: number;
  totalDiscountCents: number;
  planDiscountCents: number;
  couponDiscountCents: number;
  taxable: boolean;
}

export interface OrderAdjustmentDetail {
  id: number;
  adjustmentType: string;
  quantity: number;
  restockPolicy: string;
  reason: string | null;
  externalLineItemId: string;
  createdAt: string;
}

export interface OrderEventDetail {
  eventType: string;
  details: any;
  createdAt: string;
}

export interface OrderCostDetail {
  sku: string | null;
  qty: number;
  unitCostCents: number;
  totalCostCents: number;
}

export interface FinanceOrderDetail {
  id: number;
  externalOrderNumber: string | null;
  externalOrderId: string;
  channelName: string;
  provider: string;
  status: string;
  financialStatus: string;
  fulfillmentStatus: string | null;
  customerName: string | null;
  customerEmail: string | null;
  orderedAt: string;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  refundAmountCents: number;
  currency: string;
  riskLevel: string | null;
  riskScore: number | null;
  riskRecommendation: string | null;
  lines: OrderLineDetail[];
  adjustments: OrderAdjustmentDetail[];
  costs: OrderCostDetail[];
  events: OrderEventDetail[];
  cogsTotalCents: number;
  netRevenueCents: number;
  grossMarginPct: number | null;
}

export async function getFinanceOrderDetail(orderId: number): Promise<FinanceOrderDetail | null> {
  const [orderResult, linesResult, adjustmentsResult, eventsResult, costsResult] = await Promise.all([
    db.execute(sql`
      SELECT o.*, c.name AS channel_name, c.provider
      FROM oms.oms_orders o
      JOIN channels.channels c ON c.id = o.channel_id
      WHERE o.id = ${orderId}
    `),
    db.execute(sql`
      SELECT id, sku, title, variant_title, quantity,
             paid_price_cents, total_price_cents,
             total_discount_cents, plan_discount_cents,
             coupon_discount_cents, taxable
      FROM oms.oms_order_lines
      WHERE order_id = ${orderId}
      ORDER BY id
    `),
    db.execute(sql`
      SELECT id, adjustment_type, quantity, restock_policy,
             reason, external_line_item_id, created_at
      FROM oms.order_line_adjustments
      WHERE order_id = ${orderId}
      ORDER BY created_at
    `),
    db.execute(sql`
      SELECT event_type, details, created_at
      FROM oms.oms_order_events
      WHERE order_id = ${orderId}
      ORDER BY created_at
    `),
    db.execute(sql`
      SELECT
        pv.sku,
        oic.qty,
        oic.unit_cost_cents,
        oic.total_cost_cents
      FROM oms.order_item_costs oic
      JOIN wms.order_items wi ON wi.id = oic.order_item_id
      JOIN wms.orders wo ON wo.id = wi.order_id
      LEFT JOIN catalog.product_variants pv ON pv.id = oic.product_variant_id
      WHERE ${WMS_OMS_ORDER_ID} = ${orderId}
      ORDER BY oic.id
    `),
  ]);

  if (orderResult.rows.length === 0) return null;
  const o = orderResult.rows[0] as any;

  const lines: OrderLineDetail[] = (linesResult.rows as any[]).map((r) => ({
    id: Number(r.id),
    sku: r.sku,
    title: r.title,
    variantTitle: r.variant_title,
    quantity: Number(r.quantity) || 0,
    paidPriceCents: readIntegerCents(r.paid_price_cents, "paid price", true),
    totalPriceCents: readIntegerCents(r.total_price_cents, "total price", true),
    totalDiscountCents: readIntegerCents(r.total_discount_cents, "total discount", true),
    planDiscountCents: readIntegerCents(r.plan_discount_cents, "plan discount", true),
    couponDiscountCents: readIntegerCents(r.coupon_discount_cents, "coupon discount", true),
    taxable: r.taxable ?? true,
  }));

  const adjustments: OrderAdjustmentDetail[] = (adjustmentsResult.rows as any[]).map((r) => ({
    id: Number(r.id),
    adjustmentType: r.adjustment_type,
    quantity: Number(r.quantity) || 0,
    restockPolicy: r.restock_policy,
    reason: r.reason,
    externalLineItemId: r.external_line_item_id,
    createdAt: r.created_at,
  }));

  const events: OrderEventDetail[] = (eventsResult.rows as any[]).map((r) => ({
    eventType: r.event_type,
    details: r.details,
    createdAt: r.created_at,
  }));

  const costs: OrderCostDetail[] = (costsResult.rows as any[]).map((r) => ({
    sku: r.sku,
    qty: Number(r.qty) || 0,
    unitCostCents: readIntegerCents(r.unit_cost_cents, "unit cost", true),
    totalCostCents: readIntegerCents(r.total_cost_cents, "total cost", true),
  }));

  const cogsTotalCents = costs.reduce((s, c) => s + c.totalCostCents, 0);
  const totalCents = readIntegerCents(o.total_cents, "total", true);
  const refundAmountCents = readIntegerCents(o.refund_amount_cents, "refund amount", true);
  const netRevenueCents = totalCents - refundAmountCents;

  return {
    id: Number(o.id),
    externalOrderNumber: o.external_order_number,
    externalOrderId: o.external_order_id,
    channelName: o.channel_name,
    provider: o.provider,
    status: o.status,
    financialStatus: o.financial_status,
    fulfillmentStatus: o.fulfillment_status,
    customerName: o.customer_name,
    customerEmail: o.customer_email,
    orderedAt: o.ordered_at,
    subtotalCents: readIntegerCents(o.subtotal_cents, "subtotal", true),
    discountCents: readIntegerCents(o.discount_cents, "discount", true),
    shippingCents: readIntegerCents(o.shipping_cents, "shipping", true),
    taxCents: readIntegerCents(o.tax_cents, "tax", true),
    totalCents,
    refundAmountCents,
    currency: o.currency || "USD",
    riskLevel: o.risk_level,
    riskScore: o.risk_score ? Number(o.risk_score) : null,
    riskRecommendation: o.risk_recommendation,
    lines,
    adjustments,
    costs,
    events,
    cogsTotalCents,
    netRevenueCents,
    grossMarginPct: netRevenueCents > 0
      ? Math.round(((netRevenueCents - cogsTotalCents) / netRevenueCents) * 1000) / 10
      : null,
  };
}
