import crypto from "node:crypto";
import { sql } from "drizzle-orm";

import { sqlIntegerArray } from "../../infrastructure/postgres-array";
import {
  evaluateShopifyWritebackDebt,
  type ShopifyAggregateFulfillmentEvidence,
  type ShopifyWritebackDebtEvidenceMode,
  type ShopifyWritebackDebtEvaluation,
  type ShopifyWritebackDebtItem,
  type ShopifyWritebackDebtShipment,
} from "./shopify-writeback-debt";
import type { ShopifyFulfillmentSnapshot } from "./shopify-fulfillment-snapshot";

const RESOLUTION_EVENT = "shopify_writeback_debt_reconciled";
const REVIEW_REASON_PREFIX = "permanent_fulfillment_push_failure:";

interface DebtRow {
  readonly retry_id: number;
  readonly source_inbox_id: number | null;
  readonly shipment_id: number;
  readonly tracking_number: string | null;
  readonly external_order_id: string;
  readonly retry_last_error: string | null;
}

interface DebtItemRow {
  readonly shipment_id: number;
  readonly legacy_shipment_item_id: number;
  readonly wms_order_item_id: number;
  readonly quantity_required: number;
  readonly direct_evidence_quantity: number;
  readonly channel_order_line_id: string | null;
}

export interface ShopifyWritebackDebtOrder {
  readonly id: number;
  readonly external_order_id: string;
  readonly external_order_number: string | null;
  readonly channel_id: number;
  readonly provider: "shopify";
  readonly dead_retry_count: number;
  readonly first_failed_at: Date;
}

export interface ResolveShopifyWritebackDebtInput {
  readonly omsOrderId: number;
  readonly mode: ShopifyWritebackDebtEvidenceMode;
  readonly source: string;
  readonly execute?: boolean;
  readonly shipmentIds?: readonly number[];
  readonly resolvedAt?: Date;
  readonly providerSnapshot?: ShopifyFulfillmentSnapshot;
}

export interface ResolveShopifyWritebackDebtResult extends ShopifyWritebackDebtEvaluation {
  readonly omsOrderId: number;
  readonly candidateShipmentCount: number;
  readonly retryRowsResolved: number;
  readonly inboxRowsResolved: number;
  readonly reviewMarkersCleared: number;
  readonly eventRecorded: boolean;
}

function rowsOf<T>(result: any): T[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableText(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function assertInput(input: ResolveShopifyWritebackDebtInput): void {
  if (!Number.isInteger(input.omsOrderId) || input.omsOrderId <= 0) {
    throw new Error("omsOrderId must be a positive integer");
  }
  if (input.mode !== "direct" && input.mode !== "full_snapshot") {
    throw new Error(`Unsupported Shopify writeback debt mode: ${String(input.mode)}`);
  }
  if (!input.source.trim()) {
    throw new Error("Shopify writeback debt resolution source cannot be blank");
  }
  if (
    input.resolvedAt
    && (!(input.resolvedAt instanceof Date) || Number.isNaN(input.resolvedAt.getTime()))
  ) {
    throw new Error("resolvedAt must be a valid Date");
  }
  if (
    input.mode === "full_snapshot"
    && (!input.providerSnapshot || !input.providerSnapshot.complete)
  ) {
    throw new Error("full_snapshot mode requires a complete read-only Shopify fulfillment snapshot");
  }
  for (const shipmentId of input.shipmentIds ?? []) {
    if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
      throw new Error("shipmentIds must contain only positive integers");
    }
  }
}

function normalizeShopifyResourceId(value: unknown): string | null {
  const text = value == null ? "" : String(value).trim();
  if (!text) return null;
  const gidMatch = /^gid:\/\/shopify\/[^/]+\/(\d+)$/.exec(text);
  return gidMatch?.[1] ?? text;
}

function normalizeTrackingNumber(value: unknown): string | null {
  const normalized = value == null
    ? ""
    : String(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
  return normalized || null;
}

interface ProviderEvidence {
  readonly aggregateByChannelLine: ReadonlyMap<string, number>;
  readonly directByTrackingAndChannelLine: ReadonlyMap<string, number>;
}

function addTextQuantity(target: Map<string, number>, key: string, quantity: number): void {
  target.set(key, (target.get(key) ?? 0) + quantity);
}

function buildProviderEvidence(snapshot?: ShopifyFulfillmentSnapshot): ProviderEvidence {
  const aggregateByChannelLine = new Map<string, number>();
  const directByTrackingAndChannelLine = new Map<string, number>();
  if (!snapshot) {
    return { aggregateByChannelLine, directByTrackingAndChannelLine };
  }
  for (const physicalPackage of snapshot.packages) {
    for (const item of physicalPackage.items) {
      addTextQuantity(
        aggregateByChannelLine,
        item.channelOrderLineId,
        item.quantity,
      );
      for (const trackingNumber of physicalPackage.trackingNumbers) {
        addTextQuantity(
          directByTrackingAndChannelLine,
          `${trackingNumber}:${item.channelOrderLineId}`,
          item.quantity,
        );
      }
    }
  }
  return { aggregateByChannelLine, directByTrackingAndChannelLine };
}

function buildShipmentSnapshots(
  debtRows: readonly DebtRow[],
  itemRows: readonly DebtItemRow[],
  providerEvidence: ProviderEvidence,
): ShopifyWritebackDebtShipment[] {
  const byShipment = new Map<number, {
    trackingNumber: string | null;
    retryIds: Set<number>;
    sourceInboxIds: Set<number>;
    items: ShopifyWritebackDebtItem[];
  }>();

  for (const row of debtRows) {
    const shipmentId = positiveInteger(row.shipment_id);
    const retryId = positiveInteger(row.retry_id);
    if (!shipmentId || !retryId) {
      throw new Error("Shopify writeback retry query returned invalid shipment or retry identity");
    }
    const existing = byShipment.get(shipmentId) ?? {
      trackingNumber: nullableText(row.tracking_number),
      retryIds: new Set<number>(),
      sourceInboxIds: new Set<number>(),
      items: [],
    };
    existing.retryIds.add(retryId);
    const sourceInboxId = positiveInteger(row.source_inbox_id);
    if (sourceInboxId) existing.sourceInboxIds.add(sourceInboxId);
    byShipment.set(shipmentId, existing);
  }

  for (const row of itemRows) {
    const shipmentId = positiveInteger(row.shipment_id);
    const existing = shipmentId ? byShipment.get(shipmentId) : null;
    const legacyShipmentItemId = positiveInteger(row.legacy_shipment_item_id);
    const wmsOrderItemId = positiveInteger(row.wms_order_item_id);
    const quantityRequired = positiveInteger(row.quantity_required);
    const channelOrderLineId = normalizeShopifyResourceId(row.channel_order_line_id);
    if (
      !existing
      || !legacyShipmentItemId
      || !wmsOrderItemId
      || !quantityRequired
    ) {
      throw new Error("Shopify writeback item query returned invalid lineage or quantity");
    }
    const trackingNumber = normalizeTrackingNumber(existing.trackingNumber);
    const providerDirectQuantity = trackingNumber && channelOrderLineId
      ? providerEvidence.directByTrackingAndChannelLine.get(
        `${trackingNumber}:${channelOrderLineId}`,
      ) ?? 0
      : 0;
    existing.items.push(Object.freeze({
      legacyShipmentItemId,
      wmsOrderItemId,
      channelOrderLineId,
      quantityRequired,
      directEvidenceQuantity: Math.max(
        nonNegativeInteger(row.direct_evidence_quantity),
        providerDirectQuantity,
      ),
    }));
  }

  return [...byShipment.entries()]
    .sort(([left], [right]) => left - right)
    .map(([shipmentId, snapshot]) => Object.freeze({
      shipmentId,
      trackingNumber: snapshot.trackingNumber,
      retryIds: Object.freeze([...snapshot.retryIds].sort((left, right) => left - right)),
      sourceInboxIds: Object.freeze(
        [...snapshot.sourceInboxIds].sort((left, right) => left - right),
      ),
      items: Object.freeze(
        [...snapshot.items].sort(
          (left, right) => left.legacyShipmentItemId - right.legacyShipmentItemId,
        ),
      ),
    }));
}

async function resolveWithExecutor(
  executor: any,
  input: ResolveShopifyWritebackDebtInput,
): Promise<ResolveShopifyWritebackDebtResult> {
  const execute = input.execute ?? true;
  const resolvedAt = input.resolvedAt ?? new Date();
  const shipmentIds = [...new Set(input.shipmentIds ?? [])];

  await executor.execute(sql`
    SELECT pg_advisory_xact_lock(85421, ${input.omsOrderId})
  `);

  const debtResult = await executor.execute(sql`
    SELECT
      retry.id::int AS retry_id,
      retry.source_inbox_id::int AS source_inbox_id,
      shipment.id::int AS shipment_id,
      NULLIF(BTRIM(shipment.tracking_number), '') AS tracking_number,
      oms_order.external_order_id,
      retry.last_error AS retry_last_error
    FROM oms.webhook_retry_queue retry
    JOIN wms.outbound_shipments shipment
      ON shipment.id = CASE
        WHEN retry.payload->>'shipmentId' ~ '^[0-9]+$'
          THEN (retry.payload->>'shipmentId')::int
      END
    JOIN wms.orders wms_order ON wms_order.id = shipment.order_id
    JOIN oms.oms_orders oms_order ON oms_order.id = ${input.omsOrderId}
    JOIN channels.channels channel ON channel.id = oms_order.channel_id
    WHERE retry.provider = 'internal'
      AND retry.topic = 'shopify_fulfillment_push'
      AND retry.status = 'dead'
      AND LOWER(channel.provider) = 'shopify'
      AND (
        (wms_order.source = 'oms' AND wms_order.oms_fulfillment_order_id = oms_order.id::text)
        OR wms_order.source_table_id = oms_order.id::text
      )
      AND (
        ${shipmentIds.length === 0}
        OR shipment.id = ANY(${sqlIntegerArray(shipmentIds)})
      )
    ORDER BY shipment.id, retry.id
    FOR UPDATE OF retry, shipment
  `);
  const debtRows = rowsOf<DebtRow>(debtResult);
  if (debtRows.length === 0) {
    return Object.freeze({
      omsOrderId: input.omsOrderId,
      candidateShipmentCount: 0,
      resolvedShipmentIds: Object.freeze([]),
      resolvedRetryIds: Object.freeze([]),
      resolvedSourceInboxIds: Object.freeze([]),
      unresolved: Object.freeze([]),
      retryRowsResolved: 0,
      inboxRowsResolved: 0,
      reviewMarkersCleared: 0,
      eventRecorded: false,
    });
  }

  const expectedSourceOrderIds = new Set(
    debtRows.map((row) => normalizeShopifyResourceId(row.external_order_id)),
  );
  if (
    input.providerSnapshot
    && (
      expectedSourceOrderIds.size !== 1
      || !expectedSourceOrderIds.has(input.providerSnapshot.sourceOrderId)
    )
  ) {
    throw new Error("Shopify fulfillment snapshot does not belong to the retry order");
  }

  const candidateShipmentIds = [
    ...new Set(debtRows.map((row) => Number(row.shipment_id))),
  ];
  const itemResult = await executor.execute(sql`
    SELECT
      shipment_item.shipment_id::int AS shipment_id,
      shipment_item.id::int AS legacy_shipment_item_id,
      shipment_item.order_item_id::int AS wms_order_item_id,
      shipment_item.qty::int AS quantity_required,
      oms_line.external_line_item_id AS channel_order_line_id,
      COALESCE((
        SELECT MAX(evidence.quantity)::int
        FROM (
          SELECT push_item.quantity_pushed::int AS quantity
          FROM wms.physical_shipment_items physical_item
          JOIN oms.channel_fulfillment_push_items push_item
            ON push_item.physical_shipment_item_id = physical_item.id
          JOIN oms.channel_fulfillment_pushes push
            ON push.id = push_item.channel_fulfillment_push_id
          WHERE physical_item.legacy_wms_shipment_item_id = shipment_item.id
            AND push.oms_order_id = ${input.omsOrderId}
            AND push.channel_provider = 'shopify'
            AND push.push_status IN ('success', 'ignored')
          UNION ALL
          SELECT receipt_item.quantity::int AS quantity
          FROM oms.channel_fulfillment_receipt_items receipt_item
          JOIN oms.channel_fulfillment_receipts receipt
            ON receipt.id = receipt_item.receipt_id
          WHERE receipt_item.legacy_wms_shipment_item_id = shipment_item.id
            AND receipt.oms_order_id = ${input.omsOrderId}
            AND receipt.source_provider = 'shopify'
            AND receipt.processing_status IN ('processed', 'ignored')
        ) evidence
      ), 0)::int AS direct_evidence_quantity
    FROM wms.outbound_shipment_items shipment_item
    JOIN wms.order_items order_item ON order_item.id = shipment_item.order_item_id
    JOIN oms.oms_order_lines oms_line ON oms_line.id = order_item.oms_order_line_id
    WHERE shipment_item.shipment_id = ANY(${sqlIntegerArray(candidateShipmentIds)})
      AND shipment_item.shipment_item_purpose = 'customer_fulfillment'
      AND shipment_item.qty > 0
      AND COALESCE(order_item.status, 'pending') <> 'cancelled'
      AND COALESCE(
        LOWER(NULLIF(BTRIM(oms_line.fulfillment_provider), '')),
        'shopify'
      ) = 'shopify'
    ORDER BY shipment_item.shipment_id, shipment_item.id
  `);

  const providerEvidence = buildProviderEvidence(input.providerSnapshot);
  const aggregateEvidence: ShopifyAggregateFulfillmentEvidence[] = [
    ...providerEvidence.aggregateByChannelLine.entries(),
  ].map(([channelOrderLineId, quantity]) => ({ channelOrderLineId, quantity }));

  const shipments = buildShipmentSnapshots(
    debtRows,
    rowsOf<DebtItemRow>(itemResult),
    providerEvidence,
  );
  const evaluation = evaluateShopifyWritebackDebt(shipments, aggregateEvidence, input.mode);
  if (!execute || evaluation.resolvedRetryIds.length === 0) {
    return Object.freeze({
      omsOrderId: input.omsOrderId,
      candidateShipmentCount: shipments.length,
      ...evaluation,
      retryRowsResolved: 0,
      inboxRowsResolved: 0,
      reviewMarkersCleared: 0,
      eventRecorded: false,
    });
  }

  const resolutionMessage =
    `Superseded by canonical Shopify fulfillment evidence (${input.source}, ${input.mode})`;
  const retryResult = await executor.execute(sql`
    UPDATE oms.webhook_retry_queue
    SET status = 'success',
        last_error = ${resolutionMessage},
        updated_at = ${resolvedAt}
    WHERE id = ANY(${sqlIntegerArray(evaluation.resolvedRetryIds)})
      AND provider = 'internal'
      AND topic = 'shopify_fulfillment_push'
      AND status = 'dead'
    RETURNING id, source_inbox_id
  `);
  const resolvedRetryRows = rowsOf<any>(retryResult);
  const resolvedInboxIds = [
    ...new Set(
      resolvedRetryRows
        .map((row) => positiveInteger(row.source_inbox_id))
        .filter((id): id is number => id !== null),
    ),
  ];

  let inboxRowsResolved = 0;
  if (resolvedInboxIds.length > 0) {
    const inboxResult = await executor.execute(sql`
      UPDATE oms.webhook_inbox
      SET status = 'succeeded',
          last_error = ${resolutionMessage},
          processed_at = COALESCE(processed_at, ${resolvedAt}),
          updated_at = ${resolvedAt}
      WHERE id = ANY(${sqlIntegerArray(resolvedInboxIds)})
        AND status <> 'succeeded'
      RETURNING id
    `);
    inboxRowsResolved = rowsOf(inboxResult).length;
  }

  const reviewResult = await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = false,
        review_reason = NULL,
        updated_at = ${resolvedAt}
    WHERE id = ANY(${sqlIntegerArray(evaluation.resolvedShipmentIds)})
      AND requires_review = true
      AND review_reason LIKE ${`${REVIEW_REASON_PREFIX}%`}
    RETURNING id
  `);

  const reconciliationKey = [
    "shopify-writeback-debt:v1",
    input.mode,
    ...evaluation.resolvedShipmentIds,
  ].join(":");
  const eventResult = await executor.execute(sql`
    INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
    SELECT
      ${input.omsOrderId},
      ${RESOLUTION_EVENT},
      ${JSON.stringify({
        reconciliationKey,
        source: input.source,
        evidenceMode: input.mode,
        shipmentIds: evaluation.resolvedShipmentIds,
        retryIds: evaluation.resolvedRetryIds,
        retryStatusTransition: {
          from: "dead",
          to: "success",
        },
        resolvedRetryEvidence: debtRows
          .filter((row) => evaluation.resolvedRetryIds.includes(row.retry_id))
          .map((row) => ({
            retryId: row.retry_id,
            shipmentId: row.shipment_id,
            originalLastError: nullableText(row.retry_last_error),
          })),
        providerSnapshot: input.providerSnapshot
          ? {
            sourceOrderId: input.providerSnapshot.sourceOrderId,
            observedAt: input.providerSnapshot.observedAt.toISOString(),
            evidenceSha256: crypto
              .createHash("sha256")
              .update(JSON.stringify(input.providerSnapshot.packages))
              .digest("hex"),
            sourceFulfillmentIds: input.providerSnapshot.packages.map(
              (physicalPackage) => physicalPackage.sourceFulfillmentId,
            ),
          }
          : null,
      })}::jsonb,
      ${resolvedAt}
    WHERE NOT EXISTS (
      SELECT 1
      FROM oms.oms_order_events
      WHERE order_id = ${input.omsOrderId}
        AND event_type = ${RESOLUTION_EVENT}
        AND details->>'reconciliationKey' = ${reconciliationKey}
    )
    RETURNING id
  `);

  return Object.freeze({
    omsOrderId: input.omsOrderId,
    candidateShipmentCount: shipments.length,
    ...evaluation,
    retryRowsResolved: resolvedRetryRows.length,
    inboxRowsResolved,
    reviewMarkersCleared: rowsOf(reviewResult).length,
    eventRecorded: rowsOf(eventResult).length > 0,
  });
}

export async function resolveShopifyWritebackDebtForOrder(
  dbArg: any,
  input: ResolveShopifyWritebackDebtInput,
): Promise<ResolveShopifyWritebackDebtResult> {
  assertInput(input);
  if (typeof dbArg?.transaction === "function") {
    return dbArg.transaction((tx: any) => resolveWithExecutor(tx, input));
  }
  if (input.execute === false) {
    return resolveWithExecutor(dbArg, input);
  }
  throw new Error(
    "Shopify writeback debt mutation requires transaction-capable database access",
  );
}

export async function resolveShopifyWritebackDebtForShipment(
  dbArg: any,
  shipmentId: number,
  source: string,
): Promise<ResolveShopifyWritebackDebtResult> {
  if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
    throw new Error(`shipmentId must be a positive integer (got ${shipmentId})`);
  }
  const result = await dbArg.execute(sql`
    SELECT oms_order.id::int AS oms_order_id
    FROM wms.outbound_shipments shipment
    JOIN wms.orders wms_order ON wms_order.id = shipment.order_id
    JOIN oms.oms_orders oms_order ON (
      (wms_order.source = 'oms' AND wms_order.oms_fulfillment_order_id = oms_order.id::text)
      OR wms_order.source_table_id = oms_order.id::text
    )
    JOIN channels.channels channel ON channel.id = oms_order.channel_id
    WHERE shipment.id = ${shipmentId}
      AND LOWER(channel.provider) = 'shopify'
    LIMIT 1
  `);
  const omsOrderId = positiveInteger(rowsOf<any>(result)[0]?.oms_order_id);
  if (!omsOrderId) {
    throw new Error(`Shopify OMS order not found for WMS shipment ${shipmentId}`);
  }
  return resolveShopifyWritebackDebtForOrder(dbArg, {
    omsOrderId,
    mode: "direct",
    source,
    shipmentIds: [shipmentId],
  });
}

export async function findShopifyWritebackDebtOrders(
  dbArg: any,
  limit: number,
  options: { readonly includeDeferred?: boolean } = {},
): Promise<ShopifyWritebackDebtOrder[]> {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error("Shopify writeback debt order limit must be an integer from 1 through 500");
  }
  const result = await dbArg.execute(sql`
    SELECT
      oms_order.id::int AS id,
      oms_order.external_order_id,
      oms_order.external_order_number,
      oms_order.channel_id::int AS channel_id,
      'shopify'::text AS provider,
      COUNT(DISTINCT retry.id)::int AS dead_retry_count,
      MIN(COALESCE(retry.updated_at, retry.created_at)) AS first_failed_at
    FROM oms.webhook_retry_queue retry
    JOIN wms.outbound_shipments shipment
      ON shipment.id = CASE
        WHEN retry.payload->>'shipmentId' ~ '^[0-9]+$'
          THEN (retry.payload->>'shipmentId')::int
      END
    JOIN wms.orders wms_order ON wms_order.id = shipment.order_id
    JOIN oms.oms_orders oms_order ON (
      (wms_order.source = 'oms' AND wms_order.oms_fulfillment_order_id = oms_order.id::text)
      OR wms_order.source_table_id = oms_order.id::text
    )
    JOIN channels.channels channel ON channel.id = oms_order.channel_id
    WHERE retry.provider = 'internal'
      AND retry.topic = 'shopify_fulfillment_push'
      AND retry.status = 'dead'
      AND LOWER(channel.provider) = 'shopify'
      AND (
        ${options.includeDeferred === true}
        OR COALESCE(retry.next_retry_at, retry.updated_at, retry.created_at) <= NOW()
      )
    GROUP BY
      oms_order.id,
      oms_order.external_order_id,
      oms_order.external_order_number,
      oms_order.channel_id
    ORDER BY
      MIN(COALESCE(retry.next_retry_at, retry.updated_at, retry.created_at)),
      oms_order.id
    LIMIT ${limit}
  `);
  return rowsOf<any>(result).map((row) => Object.freeze({
    id: Number(row.id),
    external_order_id: String(row.external_order_id),
    external_order_number: nullableText(row.external_order_number),
    channel_id: Number(row.channel_id),
    provider: "shopify" as const,
    dead_retry_count: Number(row.dead_retry_count),
    first_failed_at: new Date(row.first_failed_at),
  }));
}


export async function deferShopifyWritebackDebtOrder(
  dbArg: any,
  omsOrderId: number,
  nextRetryAt: Date,
): Promise<number> {
  if (!Number.isInteger(omsOrderId) || omsOrderId <= 0) {
    throw new Error("omsOrderId must be a positive integer");
  }
  if (!(nextRetryAt instanceof Date) || Number.isNaN(nextRetryAt.getTime())) {
    throw new Error("nextRetryAt must be a valid Date");
  }
  const result = await dbArg.execute(sql`
    UPDATE oms.webhook_retry_queue retry
    SET next_retry_at = ${nextRetryAt}
    FROM wms.outbound_shipments shipment
    JOIN wms.orders wms_order ON wms_order.id = shipment.order_id
    JOIN oms.oms_orders oms_order ON (
      (wms_order.source = 'oms' AND wms_order.oms_fulfillment_order_id = oms_order.id::text)
      OR wms_order.source_table_id = oms_order.id::text
    )
    JOIN channels.channels channel ON channel.id = oms_order.channel_id
    WHERE retry.provider = 'internal'
      AND retry.topic = 'shopify_fulfillment_push'
      AND retry.status = 'dead'
      AND retry.payload->>'shipmentId' ~ '^[0-9]+$'
      AND (retry.payload->>'shipmentId')::int = shipment.id
      AND oms_order.id = ${omsOrderId}
      AND LOWER(channel.provider) = 'shopify'
    RETURNING retry.id
  `);
  return rowsOf(result).length;
}
