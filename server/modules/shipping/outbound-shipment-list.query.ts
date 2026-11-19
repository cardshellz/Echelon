import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { channels, orders, outboundShipments } from "@shared/schema";
import { hasStaffCapability, SHIPMENT_CAPABILITIES } from "@shared/staff-capabilities";
import { outboundShipmentListSchema } from "@shared/shipment-access";
import { withShipmentAccess, ShipmentAccessError } from "./outbound-shipment-access.query";
const SHIPMENT_STATUSES = ["planned", "queued", "labeled", "shipped", "cancelled", "voided"] as const;
/** Existing bounded list/filter semantics, with capability-filtered projection.
 * Cost values are not selected for a reader without sensitive-data authority.
 */
export async function queryOutboundShipments(actorId: string, rawQuery: Record<string,unknown>) {
  return withShipmentAccess(actorId, SHIPMENT_CAPABILITIES.view, async (tx,permissions) => {
    const canReadCosts = hasStaffCapability(permissions, SHIPMENT_CAPABILITIES.costs);
    const search = stringParam(rawQuery.search);
    const carrier = stringParam(rawQuery.carrier);
    const status = stringParam(rawQuery.status);
    const days = intParam(rawQuery.days, 30, 1, 3650);
    const page = intParam(rawQuery.page, 1, 1, 100000);
    const pageSize = intParam(rawQuery.pageSize, 50, 1, 200);

    if (status && !SHIPMENT_STATUSES.includes(status as (typeof SHIPMENT_STATUSES)[number])) {
      throw new ShipmentAccessError(400, "OUTBOUND_SHIPMENTS_INVALID_STATUS", "Invalid shipment status.");
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
      tx.select({
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
        ...(canReadCosts ? { carrierCostCents: outboundShipments.carrierCostCents } : {}),
      })
        .from(outboundShipments)
        .leftJoin(orders, eq(orders.id, outboundShipments.orderId))
        .leftJoin(channels, eq(channels.id, outboundShipments.channelId));

    // One transaction/client: await each query rather than queue concurrent client.query calls.
    const rows = await base()
        .where(rowsWhere)
        .orderBy(desc(sql`coalesce(${outboundShipments.shippedAt}, ${outboundShipments.createdAt})`))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
    const totalRows = await tx.select({ count: sql<number>`count(*)::int` })
        .from(outboundShipments)
        .leftJoin(orders, eq(orders.id, outboundShipments.orderId))
        .where(rowsWhere);
    const byCarrier = await tx.select({
        carrier: sql<string>`coalesce(${canonicalCarrier}, 'unknown')`,
        count: sql<number>`count(*)::int`,
      })
        .from(outboundShipments)
        .leftJoin(orders, eq(orders.id, outboundShipments.orderId))
        .where(summaryWhere)
        .groupBy(sql`coalesce(${canonicalCarrier}, 'unknown')`)
        .orderBy(desc(sql`count(*)`));
    const byStatus = await tx.select({
        status: outboundShipments.status,
        count: sql<number>`count(*)::int`,
      })
        .from(outboundShipments)
        .leftJoin(orders, eq(orders.id, outboundShipments.orderId))
        .where(summaryWhere)
        .groupBy(outboundShipments.status)
        .orderBy(desc(sql`count(*)`));

    return outboundShipmentListSchema.parse({
      rows: rows.map(row => ({ ...row, shippedAt: row.shippedAt?.toISOString() ?? null })),
      total: totalRows[0]?.count ?? 0,
      summary: { byCarrier, byStatus },
    });
  });
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
