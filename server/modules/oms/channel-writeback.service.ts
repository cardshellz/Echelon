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
  /** Null removes the historical lower bound for durable debt repair. */
  maxAgeDays?: number | null;
  limit?: number;
  excludeRetryStates?: boolean;
  provider?: "shopify" | "ebay";
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
function shippedChannelShipmentsCte(
  windowDays: number | null,
  minAgeMinutes: number,
  provider?: "shopify" | "ebay",
) {
  const windowPredicate = windowDays === null
    ? sql``
    : sql`AND os.shipped_at > NOW() - make_interval(days => ${windowDays})`;
  const minAge = sql`${minAgeMinutes} * INTERVAL '1 minute'`;
  const providerPredicate = provider
    ? sql`AND c.provider = ${provider}`
    : sql`AND c.provider IN ('shopify', 'ebay')`;

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
        package_signature.shopify_package_signature,
        (
          EXISTS (
            SELECT 1
            FROM oms.oms_order_events e
            WHERE e.order_id = oo.id
              AND e.details->>'wmsShipmentId' = os.id::text
              AND (
                (
                  c.provider = 'shopify'
                  AND e.event_type IN (
                    'shopify_fulfillment_pushed',
                    'shopify_fulfillment_reconciled'
                  )
                  AND e.details->>'coverageVersion' = '2'
                  AND e.details->>'writebackComplete' = 'true'
                  AND e.details->>'packageSignature' = package_signature.shopify_package_signature
                )
                OR (c.provider = 'ebay' AND e.event_type = 'tracking_pushed')
              )
          )
          OR (
            EXISTS (
              SELECT 1
              FROM wms.outbound_shipment_items eligible_item
              JOIN wms.order_items eligible_order_item
                ON eligible_order_item.id = eligible_item.order_item_id
              LEFT JOIN oms.oms_order_lines eligible_oms_line
                ON eligible_oms_line.id = eligible_order_item.oms_order_line_id
              WHERE eligible_item.shipment_id = os.id
                AND eligible_item.shipment_item_purpose = 'customer_fulfillment'
                AND eligible_item.qty > 0
                AND COALESCE(eligible_order_item.status, 'pending') <> 'cancelled'
                AND COALESCE(
                  LOWER(NULLIF(BTRIM(eligible_oms_line.fulfillment_provider), '')),
                  c.provider
                ) = c.provider
            )
            AND NOT EXISTS (
              SELECT 1
              FROM wms.outbound_shipment_items eligible_item
              JOIN wms.order_items eligible_order_item
                ON eligible_order_item.id = eligible_item.order_item_id
              LEFT JOIN oms.oms_order_lines eligible_oms_line
                ON eligible_oms_line.id = eligible_order_item.oms_order_line_id
              WHERE eligible_item.shipment_id = os.id
                AND eligible_item.shipment_item_purpose = 'customer_fulfillment'
                AND eligible_item.qty > 0
                AND COALESCE(eligible_order_item.status, 'pending') <> 'cancelled'
                AND COALESCE(
                  LOWER(NULLIF(BTRIM(eligible_oms_line.fulfillment_provider), '')),
                  c.provider
                ) = c.provider
                AND NOT (
                  EXISTS (
                    SELECT 1
                    FROM wms.physical_shipment_items physical_item
                    JOIN oms.channel_fulfillment_push_items push_item
                      ON push_item.physical_shipment_item_id = physical_item.id
                    JOIN oms.channel_fulfillment_pushes push
                      ON push.id = push_item.channel_fulfillment_push_id
                    WHERE physical_item.legacy_wms_shipment_item_id = eligible_item.id
                      AND push.oms_order_id = oo.id
                      AND push.channel_provider = c.provider
                      AND push.push_status IN ('success', 'ignored')
                      AND push_item.quantity_pushed = eligible_item.qty
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM oms.channel_fulfillment_receipt_items receipt_item
                    JOIN oms.channel_fulfillment_receipts receipt
                      ON receipt.id = receipt_item.receipt_id
                    WHERE receipt_item.legacy_wms_shipment_item_id = eligible_item.id
                      AND receipt.oms_order_id = oo.id
                      AND receipt.source_provider = c.provider
                      AND receipt.processing_status IN ('processed', 'ignored')
                      AND receipt_item.quantity = eligible_item.qty
                  )
                )
            )
          )
        ) AS has_per_shipment_success,
        EXISTS (
          SELECT 1
          FROM oms.oms_order_events e
          WHERE e.order_id = oo.id
            AND e.event_type IN (
              'tracking_pushed',
              'shopify_fulfillment_pushed',
              'shopify_fulfillment_reconciled'
            )
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
      LEFT JOIN LATERAL (
        SELECT 'v2|' || COALESCE(
          string_agg(
            osi.id::text || ':' || COALESCE(osi.order_item_id::text, '0') || ':' || osi.qty::int::text,
            ',' ORDER BY osi.id
          ),
          ''
        ) AS shopify_package_signature
        FROM wms.outbound_shipment_items osi
        LEFT JOIN wms.order_items package_oi ON package_oi.id = osi.order_item_id
        LEFT JOIN oms.oms_order_lines package_ol ON package_ol.id = package_oi.oms_order_line_id
        WHERE osi.shipment_id = os.id
          AND COALESCE(package_oi.status, 'pending') <> 'cancelled'
          AND COALESCE(osi.qty, 0) > 0
          AND COALESCE(
            LOWER(NULLIF(BTRIM(package_ol.fulfillment_provider), '')),
            'shopify'
          ) = 'shopify'
      ) package_signature ON TRUE
      WHERE os.status = 'shipped'
        AND os.shipped_at IS NOT NULL
        AND os.shipped_at < NOW() - ${minAge}
        ${windowPredicate}
        ${providerPredicate}
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
  const maxAgeDays = options.maxAgeDays === null
    ? null
    : normalizedWindowDays(options.maxAgeDays);
  const limit = normalizedLimit(options.limit);
  const cte = shippedChannelShipmentsCte(maxAgeDays, minAgeMinutes, options.provider);
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
