import { sql } from "drizzle-orm";

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const DEFAULT_SAMPLE_LIMIT = 50;
const MAX_SAMPLE_LIMIT = 500;

export type ChannelWritebackState =
  | "retrying"
  | "dead"
  | "masked"
  | "partial_order"
  | "missing";

export interface ChannelWritebackException {
  shipment_id: number;
  wms_order_id: number;
  oms_order_id: number;
  order_number: string | null;
  provider: string;
  oms_status: string | null;
  shipped_at: string | Date | null;
  tracking_number: string | null;
  carrier: string | null;
  shopify_fulfillment_id: string | null;
  has_per_shipment_success: boolean;
  has_order_level_success: boolean;
  pending_retry: boolean;
  dead_retry: boolean;
  state: ChannelWritebackState;
}

export interface ChannelWritebackProviderSummary {
  provider: string;
  shipped: number;
  complete: number;
  missing: number;
  masked: number;
  partialOrders: number;
  retrying: number;
  dead: number;
}

export interface ChannelWritebackHealth {
  generatedAt: string;
  windowDays: number;
  shipped: number;
  complete: number;
  missing: number;
  masked: number;
  partialOrders: number;
  retrying: number;
  dead: number;
  byProvider: ChannelWritebackProviderSummary[];
  exceptions: ChannelWritebackException[];
}

export interface ChannelWritebackCandidateOptions {
  minAgeMinutes?: number;
  maxAgeDays?: number;
  limit?: number;
  excludeRetryStates?: boolean;
}

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function positiveBound(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function normalizedWindowDays(value: unknown): number {
  return positiveBound(value, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS);
}

function normalizedLimit(value: unknown): number {
  return positiveBound(value, DEFAULT_SAMPLE_LIMIT, MAX_SAMPLE_LIMIT);
}

/**
 * One row represents one physical WMS shipment. An order-level event is kept
 * only as diagnostic context; it never makes another shipment complete.
 */
function shippedChannelShipmentsCte(windowDays: number, minAgeMinutes: number) {
  const window = sql`NOW() - make_interval(days => ${windowDays})`;
  const minAge = sql`${minAgeMinutes} * INTERVAL '1 minute'`;

  return sql`
    WITH shipped_channel_shipments AS (
      SELECT
        os.id AS shipment_id,
        os.order_id AS wms_order_id,
        oo.id AS oms_order_id,
        wo.order_number,
        c.provider,
        oo.status AS oms_status,
        os.shipped_at,
        NULLIF(os.tracking_number, '') AS tracking_number,
        NULLIF(os.carrier, '') AS carrier,
        NULLIF(os.shopify_fulfillment_id, '') AS shopify_fulfillment_id,
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
        ) AS has_per_shipment_success,
        EXISTS (
          SELECT 1
          FROM oms.oms_order_events e
          WHERE e.order_id = oo.id
            AND e.event_type IN ('tracking_pushed', 'shopify_fulfillment_pushed')
        ) AS has_order_level_success,
        EXISTS (
          SELECT 1
          FROM oms.webhook_retry_queue q
          WHERE q.provider = 'internal'
            AND q.status = 'pending'
            AND q.topic = CASE
              WHEN c.provider = 'shopify' THEN 'shopify_fulfillment_push'
              WHEN c.provider = 'ebay' THEN 'delayed_tracking_push'
              ELSE ''
            END
            AND q.payload->>'shipmentId' = os.id::text
        ) AS pending_retry,
        EXISTS (
          SELECT 1
          FROM oms.webhook_retry_queue q
          WHERE q.provider = 'internal'
            AND q.status = 'dead'
            AND q.topic = CASE
              WHEN c.provider = 'shopify' THEN 'shopify_fulfillment_push'
              WHEN c.provider = 'ebay' THEN 'delayed_tracking_push'
              ELSE ''
            END
            AND q.payload->>'shipmentId' = os.id::text
        ) AS dead_retry
      FROM wms.outbound_shipments os
      JOIN wms.orders wo ON wo.id = os.order_id
      JOIN oms.oms_orders oo ON (
           (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
        OR (wo.source_table_id = oo.id::text)
      )
      JOIN channels.channels c ON c.id = oo.channel_id
      WHERE os.status = 'shipped'
        AND os.shipped_at IS NOT NULL
        AND os.shipped_at < NOW() - ${minAge}
        AND os.shipped_at > ${window}
        AND c.provider IN ('shopify', 'ebay')
        AND EXISTS (
          SELECT 1
          FROM wms.outbound_shipment_items osi
          JOIN wms.order_items oi ON oi.id = osi.order_item_id
          WHERE osi.shipment_id = os.id
            AND COALESCE(oi.requires_shipping, 1) <> 0
            AND COALESCE(osi.qty, 0) > 0
        )
    )
  `;
}

function missingPredicate() {
  return sql`has_per_shipment_success = false`;
}

function countValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function getChannelWritebackHealth(
  db: any,
  options: { windowDays?: number; sampleLimit?: number } = {},
): Promise<ChannelWritebackHealth> {
  const windowDays = normalizedWindowDays(options.windowDays);
  const sampleLimit = normalizedLimit(options.sampleLimit);
  const cte = shippedChannelShipmentsCte(windowDays, 10);

  const summaryResult = await db.execute(sql`
      ${cte}
      SELECT
        provider,
        COUNT(*)::int AS shipped,
        COUNT(*) FILTER (WHERE has_per_shipment_success)::int AS complete,
        COUNT(*) FILTER (WHERE ${missingPredicate()})::int AS missing,
        COUNT(*) FILTER (WHERE ${missingPredicate()} AND has_order_level_success)::int AS masked,
        COUNT(DISTINCT oms_order_id) FILTER (
          WHERE ${missingPredicate()} AND oms_status = 'partially_shipped'
        )::int AS partial_orders,
        COUNT(*) FILTER (WHERE ${missingPredicate()} AND pending_retry)::int AS retrying,
        COUNT(*) FILTER (WHERE ${missingPredicate()} AND dead_retry)::int AS dead
      FROM shipped_channel_shipments
      GROUP BY provider
      ORDER BY provider
    `);
  const sampleResult = await db.execute(sql`
      ${cte}
      SELECT
        shipment_id,
        wms_order_id,
        oms_order_id,
        order_number,
        provider,
        oms_status,
        shipped_at,
        tracking_number,
        carrier,
        shopify_fulfillment_id,
        has_per_shipment_success,
        has_order_level_success,
        pending_retry,
        dead_retry,
        CASE
          WHEN dead_retry THEN 'dead'
          WHEN pending_retry THEN 'retrying'
          WHEN has_order_level_success THEN 'masked'
          WHEN oms_status = 'partially_shipped' THEN 'partial_order'
          ELSE 'missing'
        END AS state
      FROM shipped_channel_shipments
      WHERE ${missingPredicate()}
      ORDER BY shipped_at ASC, shipment_id ASC
      LIMIT ${sampleLimit}
    `);

  const byProvider = rows(summaryResult)
    .filter((row) => row.provider != null && String(row.provider).trim().length > 0)
    .map((row) => ({
      provider: String(row.provider),
      shipped: countValue(row.shipped),
      complete: countValue(row.complete),
      missing: countValue(row.missing),
      masked: countValue(row.masked),
      partialOrders: countValue(row.partial_orders),
      retrying: countValue(row.retrying),
      dead: countValue(row.dead),
    }));

  const exceptions = rows(sampleResult).filter((row) => {
    const shipmentId = Number(row.shipment_id);
    return Number.isInteger(shipmentId) && shipmentId > 0;
  }) as ChannelWritebackException[];

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    shipped: byProvider.reduce((sum, row) => sum + row.shipped, 0),
    complete: byProvider.reduce((sum, row) => sum + row.complete, 0),
    missing: byProvider.reduce((sum, row) => sum + row.missing, 0),
    masked: byProvider.reduce((sum, row) => sum + row.masked, 0),
    partialOrders: byProvider.reduce((sum, row) => sum + row.partialOrders, 0),
    retrying: byProvider.reduce((sum, row) => sum + row.retrying, 0),
    dead: byProvider.reduce((sum, row) => sum + row.dead, 0),
    byProvider,
    exceptions,
  };
}

export async function findChannelWritebackCandidates(
  db: any,
  options: ChannelWritebackCandidateOptions = {},
): Promise<ChannelWritebackException[]> {
  const minAgeMinutes = positiveBound(options.minAgeMinutes, 60, 7 * 24 * 60);
  const maxAgeDays = normalizedWindowDays(options.maxAgeDays);
  const limit = normalizedLimit(options.limit);
  const cte = shippedChannelShipmentsCte(maxAgeDays, minAgeMinutes);
  const retryStatePredicate = options.excludeRetryStates
    ? sql` AND pending_retry = false AND dead_retry = false`
    : sql``;

  const result = await db.execute(sql`
    ${cte}
    SELECT
      shipment_id,
      wms_order_id,
      oms_order_id,
      order_number,
      provider,
      oms_status,
      shipped_at,
      tracking_number,
      carrier,
      shopify_fulfillment_id,
      has_per_shipment_success,
      has_order_level_success,
      pending_retry,
      dead_retry,
      CASE
        WHEN dead_retry THEN 'dead'
        WHEN pending_retry THEN 'retrying'
        WHEN has_order_level_success THEN 'masked'
        WHEN oms_status = 'partially_shipped' THEN 'partial_order'
        ELSE 'missing'
      END AS state
    FROM shipped_channel_shipments
    WHERE ${missingPredicate()}${retryStatePredicate}
    ORDER BY shipped_at ASC, shipment_id ASC
    LIMIT ${limit}
  `);

  return rows(result) as ChannelWritebackException[];
}
