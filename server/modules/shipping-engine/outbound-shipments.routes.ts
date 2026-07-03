import type { Express, Response } from "express";
import { and, desc, eq, gte, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { channels, orders, outboundShipments } from "@shared/schema";

/**
 * Read-only listing of wms.outbound_shipments for the Shipping → Shipments
 * page. carrier_cost_cents is included but currently 0 on all rows — actual
 * costs start populating with the first-party label flow; the page renders
 * them as "—" until then.
 */

const SHIPMENT_STATUSES = ["planned", "queued", "labeled", "shipped", "cancelled", "voided"] as const;

export function registerOutboundShipmentRoutes(app: Express): void {
  app.get(
    "/api/outbound-shipments",
    requirePermission("orders", "view"),
    async (req, res) => {
      try {
        const search = stringParam(req.query.search);
        const carrier = stringParam(req.query.carrier);
        const status = stringParam(req.query.status);
        const days = intParam(req.query.days, 30, 1, 3650);
        const page = intParam(req.query.page, 1, 1, 100000);
        const pageSize = intParam(req.query.pageSize, 50, 1, 200);

        if (status && !SHIPMENT_STATUSES.includes(status as (typeof SHIPMENT_STATUSES)[number])) {
          return res.status(400).json({ error: { code: "OUTBOUND_SHIPMENTS_INVALID_STATUS" } });
        }

        // Time window: shipped rows filter on shipped_at; unshipped states
        // (planned/queued/cancelled/...) have no shipped_at, so use created_at.
        const windowStart = sql`now() - make_interval(days => ${days})`;
        const windowFilter: SQL = sql`coalesce(${outboundShipments.shippedAt}, ${outboundShipments.createdAt}) >= ${windowStart}`;

        // Historical rows mix raw engine codes with display names (stamps_com /
        // USPS, ups_walleted / UPS®, fedex / FedEx). Canonicalize for display,
        // filtering, and the summary — mirrors C9's normalizeCarrier mapping.
        const canonicalCarrier = sql<string | null>`case
          when ${outboundShipments.carrier} is null then null
          when lower(${outboundShipments.carrier}) in ('stamps_com', 'usps') then 'USPS'
          when lower(${outboundShipments.carrier}) like 'ups%' then 'UPS'
          when lower(${outboundShipments.carrier}) like 'fedex%' then 'FedEx'
          when lower(${outboundShipments.carrier}) like 'dhl%' then 'DHL'
          else ${outboundShipments.carrier}
        end`;

        const searchFilter = search
          ? or(
              ilike(orders.orderNumber, `%${search}%`),
              ilike(orders.customerName, `%${search}%`),
              ilike(outboundShipments.trackingNumber, `%${search}%`),
            )
          : undefined;

        // Summary ignores carrier/status so the chips stay stable while filtering.
        const summaryWhere = and(windowFilter, searchFilter);
        const rowsWhere = and(
          summaryWhere,
          carrier ? sql`${canonicalCarrier} = ${carrier}` : undefined,
          status ? eq(outboundShipments.status, status) : undefined,
        );

        const base = () =>
          db.select({
            id: outboundShipments.id,
            orderId: outboundShipments.orderId,
            orderNumber: orders.orderNumber,
            customerName: orders.customerName,
            channelName: channels.name,
            status: outboundShipments.status,
            carrier: canonicalCarrier,
            trackingNumber: outboundShipments.trackingNumber,
            trackingUrl: outboundShipments.trackingUrl,
            shippedAt: outboundShipments.shippedAt,
            carrierCostCents: outboundShipments.carrierCostCents,
          })
            .from(outboundShipments)
            .leftJoin(orders, eq(orders.id, outboundShipments.orderId))
            .leftJoin(channels, eq(channels.id, outboundShipments.channelId));

        const [rows, totalRows, byCarrier, byStatus] = await Promise.all([
          base()
            .where(rowsWhere)
            .orderBy(desc(sql`coalesce(${outboundShipments.shippedAt}, ${outboundShipments.createdAt})`))
            .limit(pageSize)
            .offset((page - 1) * pageSize),
          db.select({ count: sql<number>`count(*)::int` })
            .from(outboundShipments)
            .leftJoin(orders, eq(orders.id, outboundShipments.orderId))
            .where(rowsWhere),
          db.select({
            carrier: sql<string>`coalesce(${canonicalCarrier}, 'unknown')`,
            count: sql<number>`count(*)::int`,
          })
            .from(outboundShipments)
            .leftJoin(orders, eq(orders.id, outboundShipments.orderId))
            .where(summaryWhere)
            .groupBy(sql`coalesce(${canonicalCarrier}, 'unknown')`)
            .orderBy(desc(sql`count(*)`)),
          db.select({
            status: outboundShipments.status,
            count: sql<number>`count(*)::int`,
          })
            .from(outboundShipments)
            .leftJoin(orders, eq(orders.id, outboundShipments.orderId))
            .where(summaryWhere)
            .groupBy(outboundShipments.status)
            .orderBy(desc(sql`count(*)`)),
        ]);

        return res.json({
          rows,
          total: totalRows[0]?.count ?? 0,
          summary: { byCarrier, byStatus },
        });
      } catch (error) {
        return sendError(res, error);
      }
    },
  );
}

function stringParam(value: unknown): string | undefined {
  if (Array.isArray(value)) return stringParam(value[0]);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const raw = stringParam(value);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sendError(res: Response, error: unknown): Response {
  console.error("[OutboundShipmentRoutes] Failed to list shipments:", error);
  return res.status(500).json({
    error: { code: "OUTBOUND_SHIPMENTS_INTERNAL_ERROR", message: "Failed to list shipments." },
  });
}
