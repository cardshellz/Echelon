import { sql } from "drizzle-orm";
import type { OmsLineAuthorityState } from "./oms-line-authority";
import { recordOmsLineAuthorityEvent } from "./oms-line-authority-ledger";
import {
  allocateActiveShipmentItems,
  deriveRefundAuthority,
  extractRefundLineAdjustments,
  RefundsCreateBadPayloadError,
  type ShopifyRefundLineAdjustment,
} from "./refund-line-disposition";
import {
  markShipmentCancelled,
  recomputeOrderStatusFromShipments,
} from "../orders/shipment-rollup";
import { refreshOmsLineMaterializedQuantities } from "./oms-line-materialization.repository";
import { recordOmsWmsAuthorityCleanupAudit } from "../wms/oms-wms-authority-cleanup-audit.repository";
import { applyRefundAuthorityToWmsOrderItem } from "../wms/order-item-commands";
import { createExpectedWmsReturn } from "../wms/expected-return-commands";

const REFUND_LOCK_NAMESPACE = 918413;

export { RefundsCreateBadPayloadError, extractRefundLineAdjustments };

export type ApplyShopifyRefundCascadeOutcome =
  | "financial_only"
  | "line_dispositions_applied"
  | "return_expected"
  | "idempotent_skip"
  | "order_not_tracked"
  | "wms_order_not_found";

export interface ApplyShopifyRefundCascadeResult {
  outcome: ApplyShopifyRefundCascadeOutcome;
  refundExternalId: string;
  omsOrderId?: number;
  wmsOrderId?: number;
  returnId?: number | null;
  returnExpected: boolean;
  restocked: false;
  adjustedLines: number;
  releasedReservationQuantity: number;
  cancelledShipments: number;
  repushedShipments: number;
  flaggedShipments: number;
  warnings: string[];
}

interface ReservationReleaseResult {
  releasedQuantity: number;
}

export interface ShopifyRefundCascadeHelpers {
  resolveOmsOrder: (
    db: any,
    args: { shopifyOrderId: string | number; channelId: number },
  ) => Promise<{ id: number } | null>;
  releaseOrderItemReservation?: (args: {
    orderId: number;
    orderItemId: number;
    quantity: number;
    sourceEventId: string;
    reason: string;
    userId?: string;
  }) => Promise<ReservationReleaseResult>;
  shipstation?: { cancelOrder: (shipstationOrderId: number) => Promise<unknown> };
  shippingEngine?: {
    cancel: (ref: {
      engine: string;
      engineOrderRef: string;
      engineShipmentRef?: string;
    }) => Promise<unknown>;
  };
  pushShipment?: (shipmentId: number) => Promise<unknown>;
  recordReturnCase?: (args: {
    tx: any;
    channelId: number;
    omsOrderId: number;
    wmsOrderId: number;
    wmsReturnId: number;
    refundExternalId: string;
    now: Date;
  }) => Promise<unknown>;
}

export interface ShopifyRefundCascadeOptions {
  channelId: number;
  sourceInboxId?: number | null;
  now?: Date;
  logPrefix?: string;
}

export interface ReconcilePersistedShopifyRefundAuthorityInput {
  omsOrderId: number;
  wmsOrderId: number;
  refundExternalId: string;
  adjustments: readonly ShopifyRefundLineAdjustment[];
  sourceInboxId?: number | null;
  now: Date;
  audit: {
    runId: string;
    operator: string;
    reason: string;
  };
}

export interface ReconcilePersistedShopifyRefundAuthorityResult {
  authorityChanges: number;
  wmsLineChanges: number;
  warnings: readonly string[];
}

interface OmsLineStateRow {
  id: number;
  external_line_item_id: string;
  channel_observed_quantity: number;
  paid_quantity: number;
  authority_fulfillable_quantity: number;
  cancelled_quantity: number;
  refunded_quantity: number;
  authorization_status: string;
  authorized_at: Date | string | null;
  authorized_by_event_id: string | null;
  requires_shipping: boolean | null;
  refund_cancel_quantity: number;
  refund_other_quantity: number;
}

interface WmsItemState {
  id: number;
  omsOrderLineId: number;
  externalLineItemId: string;
  quantity: number;
  pickedQuantity: number;
  fulfilledQuantity: number;
  status: string;
  authorityFulfillableQuantity: number;
  requiresShipping: boolean;
  manualReviewReason: string | null;
}

interface ShipmentReconciliationPlan {
  shipmentId: number;
  status: string;
  remainingQuantity: number;
  contentsChanged: boolean;
  skipEngineCancel: boolean;
  reviewReason: string | null;
}

interface InternalRefundResult {
  insertedAdjustments: number;
  authorityChanges: number;
  wmsLineChanges: number;
  releaseTargets: Array<{ orderItemId: number; quantity: number }>;
  shipmentPlans: ShipmentReconciliationPlan[];
  returnId: number | null;
  returnItemsCreated: number;
  warnings: string[];
}

function deriveRefundEventReservationReleaseQuantity(args: {
  line: OmsLineStateRow;
  adjustment: ShopifyRefundLineAdjustment;
  pickedQuantity: number;
  fulfilledQuantity: number;
}): number {
  if (args.adjustment.restockPolicy === "return") return 0;

  const paidQuantity = Math.max(0, Number(args.line.paid_quantity ?? 0));
  const cancelledQuantity = Math.max(0, Number(args.line.cancelled_quantity ?? 0));
  const cumulativeCancelQuantity = Math.max(
    0,
    Number(args.line.refund_cancel_quantity ?? 0),
  );
  const cumulativeOtherQuantity = Math.max(
    0,
    Number(args.line.refund_other_quantity ?? 0),
  );
  const currentCancelQuantity = args.adjustment.restockPolicy === "cancel"
    ? args.adjustment.quantity
    : 0;
  const currentOtherQuantity = args.adjustment.restockPolicy === "cancel"
    ? 0
    : args.adjustment.quantity;
  const previousCancelQuantity = Math.max(
    cumulativeCancelQuantity - currentCancelQuantity,
    0,
  );
  const previousOtherQuantity = Math.max(
    cumulativeOtherQuantity - currentOtherQuantity,
    0,
  );
  const authorityBeforeEvent = Math.max(
    paidQuantity - Math.max(cancelledQuantity, previousCancelQuantity) - previousOtherQuantity,
    0,
  );
  const authorityAfterEvent = Math.max(
    paidQuantity - Math.max(cancelledQuantity, cumulativeCancelQuantity) - cumulativeOtherQuantity,
    0,
  );
  const eventAuthorityReduction = Math.max(
    authorityBeforeEvent - authorityAfterEvent,
    0,
  );
  const physicalProgress = Math.max(
    Math.max(0, args.pickedQuantity),
    Math.max(0, args.fulfilledQuantity),
  );
  const unconsumedPaidQuantity = Math.max(paidQuantity - physicalProgress, 0);

  return Math.min(eventAuthorityReduction, unconsumedPaidQuantity);
}

function rowsOf<T>(result: any): T[] {
  return Array.isArray(result?.rows) ? result.rows as T[] : [];
}

function parseRefundTimestamp(value: unknown, fallback: Date): Date {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function refundReturnEventKey(refundExternalId: string, wmsOrderId: number): string {
  return `shopify:refund:${refundExternalId}:order:${wmsOrderId}`;
}

async function loadAndLockOmsLines(
  tx: any,
  omsOrderId: number,
  adjustments: ShopifyRefundLineAdjustment[],
): Promise<OmsLineStateRow[]> {
  const externalIds = adjustments.map((adjustment) => adjustment.externalLineItemId);
  const result = await tx.execute(sql`
    SELECT
      ol.id,
      ol.external_line_item_id,
      ol.channel_observed_quantity,
      ol.paid_quantity,
      ol.authority_fulfillable_quantity,
      ol.cancelled_quantity,
      ol.refunded_quantity,
      ol.authorization_status,
      ol.authorized_at,
      ol.authorized_by_event_id,
      ol.requires_shipping,
      0::int AS refund_cancel_quantity,
      0::int AS refund_other_quantity
    FROM oms.oms_order_lines ol
    WHERE ol.order_id = ${omsOrderId}
      AND ol.external_line_item_id = ANY(
        ARRAY[${sql.join(externalIds, sql`, `)}]::text[]
      )
    FOR UPDATE OF ol
  `);
  const rows = rowsOf<OmsLineStateRow>(result);
  const rowCountsByExternalId = new Map<string, number>();
  for (const row of rows) {
    const externalId = String(row.external_line_item_id);
    rowCountsByExternalId.set(externalId, (rowCountsByExternalId.get(externalId) ?? 0) + 1);
  }
  const duplicated = Array.from(rowCountsByExternalId.entries())
    .filter(([, count]) => count > 1)
    .map(([externalId]) => externalId);
  if (duplicated.length > 0) {
    throw new RefundsCreateBadPayloadError(
      `refund line(s) map to multiple OMS lines on order ${omsOrderId}: ${duplicated.join(", ")}`,
    );
  }
  const found = new Set(rows.map((row) => String(row.external_line_item_id)));
  const missing = externalIds.filter((externalId) => !found.has(externalId));
  if (missing.length > 0) {
    throw new RefundsCreateBadPayloadError(
      `refund line(s) do not map to OMS order ${omsOrderId}: ${missing.join(", ")}`,
    );
  }
  return rows;
}

async function loadRefundAggregates(
  tx: any,
  omsOrderId: number,
  adjustments: ShopifyRefundLineAdjustment[],
): Promise<OmsLineStateRow[]> {
  const externalIds = adjustments.map((adjustment) => adjustment.externalLineItemId);
  const result = await tx.execute(sql`
    SELECT
      ol.id,
      ol.external_line_item_id,
      ol.channel_observed_quantity,
      ol.paid_quantity,
      ol.authority_fulfillable_quantity,
      ol.cancelled_quantity,
      ol.refunded_quantity,
      ol.authorization_status,
      ol.authorized_at,
      ol.authorized_by_event_id,
      ol.requires_shipping,
      COALESCE(SUM(adj.quantity) FILTER (
        WHERE adj.adjustment_type = 'refund'
          AND adj.restock_policy = 'cancel'
      ), 0)::int AS refund_cancel_quantity,
      COALESCE(SUM(adj.quantity) FILTER (
        WHERE adj.adjustment_type = 'refund'
          AND adj.restock_policy <> 'cancel'
      ), 0)::int AS refund_other_quantity
    FROM oms.oms_order_lines ol
    LEFT JOIN oms.order_line_adjustments adj ON adj.order_line_id = ol.id
    WHERE ol.order_id = ${omsOrderId}
      AND ol.external_line_item_id = ANY(
        ARRAY[${sql.join(externalIds, sql`, `)}]::text[]
      )
    GROUP BY ol.id
    ORDER BY ol.id
  `);
  return rowsOf<OmsLineStateRow>(result);
}

async function persistRefundAdjustments(
  tx: any,
  args: {
    omsOrderId: number;
    refundExternalId: string;
    reason: string;
    adjustments: ShopifyRefundLineAdjustment[];
    lineIdByExternalId: Map<string, number>;
  },
): Promise<number> {
  let inserted = 0;
  for (const adjustment of args.adjustments) {
    const orderLineId = args.lineIdByExternalId.get(adjustment.externalLineItemId);
    if (!orderLineId) {
      throw new RefundsCreateBadPayloadError(
        `refund line ${adjustment.externalLineItemId} has no OMS line identity`,
      );
    }
    const result = await tx.execute(sql`
      INSERT INTO oms.order_line_adjustments (
        order_id, order_line_id, external_line_item_id, source,
        source_event_id, adjustment_type, restock_policy, quantity,
        reason, raw_payload
      ) VALUES (
        ${args.omsOrderId}, ${orderLineId}, ${adjustment.externalLineItemId},
        'shopify_webhook', ${args.refundExternalId}, 'refund',
        ${adjustment.restockPolicy}, ${adjustment.quantity}, ${args.reason},
        ${JSON.stringify(adjustment.raw)}::jsonb
      )
      ON CONFLICT (source, source_event_id, external_line_item_id, adjustment_type)
      DO NOTHING
      RETURNING id
    `);
    inserted += rowsOf(result).length;
  }
  return inserted;
}

function deriveAuthorityForRefundLine(line: OmsLineStateRow) {
  return deriveRefundAuthority({
    paidQuantity: Number(line.paid_quantity),
    previousAuthorityFulfillableQuantity: Number(line.authority_fulfillable_quantity),
    cancelledQuantity: Number(line.cancelled_quantity),
    refundCancelQuantity: Number(line.refund_cancel_quantity),
    refundOtherQuantity: Number(line.refund_other_quantity),
  });
}

async function applyOmsLineAuthority(
  tx: any,
  args: {
    omsOrderId: number;
    refundExternalId: string;
    sourceInboxId: number | null;
    now: Date;
    lines: OmsLineStateRow[];
  },
): Promise<{ changed: number; warnings: string[]; lines: OmsLineStateRow[] }> {
  let changed = 0;
  const warnings: string[] = [];

  for (const line of args.lines) {
    const authority = deriveAuthorityForRefundLine(line);
    const stateChanged =
      Number(line.authority_fulfillable_quantity) !== authority.authorityFulfillableQuantity ||
      Number(line.refunded_quantity) !== authority.refundedQuantity ||
      String(line.authorization_status) !== authority.authorizationStatus;

    if (authority.overDispositionQuantity > 0) {
      warnings.push(
        `OMS line ${line.id} has ${authority.overDispositionQuantity} disposition unit(s) beyond paid quantity`,
      );
    }

    if (stateChanged) {
      await tx.execute(sql`
        UPDATE oms.oms_order_lines
        SET authority_fulfillable_quantity = ${authority.authorityFulfillableQuantity},
            refunded_quantity = ${authority.refundedQuantity},
            authorization_status = ${authority.authorizationStatus},
            authorized_at = ${args.now},
            authorized_by_event_id = ${args.refundExternalId},
            authority_source_topic = 'refunds/create',
            authority_source_inbox_id = ${args.sourceInboxId},
            updated_at = ${args.now}
        WHERE id = ${line.id}
          AND order_id = ${args.omsOrderId}
      `);
      changed++;
    }

    const eventAuthority: OmsLineAuthorityState = {
      channelObservedQuantity: Number(line.channel_observed_quantity),
      paidQuantity: Number(line.paid_quantity),
      authorityFulfillableQuantity: authority.authorityFulfillableQuantity,
      authorizationStatus: authority.authorizationStatus,
      authorizedAt: args.now,
      authorizedByEventId: args.refundExternalId,
      authoritySourceTopic: "refunds/create",
      authoritySourceInboxId: args.sourceInboxId,
    };
    await recordOmsLineAuthorityEvent({
      db: tx,
      orderId: args.omsOrderId,
      orderLineId: Number(line.id),
      eventType: "line_updated",
      authority: eventAuthority,
      sourceEventId: args.refundExternalId,
      cancelledQuantity: Number(line.cancelled_quantity),
      refundedQuantity: authority.refundedQuantity,
      previous: {
        channelObservedQuantity: Number(line.channel_observed_quantity),
        paidQuantity: Number(line.paid_quantity),
        authorityFulfillableQuantity: Number(line.authority_fulfillable_quantity),
        authorizationStatus: String(line.authorization_status),
      },
    });

    line.authority_fulfillable_quantity = authority.authorityFulfillableQuantity;
    line.refunded_quantity = authority.refundedQuantity;
    line.authorization_status = authority.authorizationStatus;
  }

  return { changed, warnings, lines: args.lines };
}

async function applyWmsLineState(
  tx: any,
  args: {
    wmsOrderId: number;
    adjustments: ShopifyRefundLineAdjustment[];
    authorityLines: OmsLineStateRow[];
    now: Date;
  },
): Promise<{
  changed: number;
  items: WmsItemState[];
  releaseTargets: Array<{ orderItemId: number; quantity: number }>;
}> {
  const authorityByLineId = new Map(
    args.authorityLines.map((line) => [Number(line.id), Number(line.authority_fulfillable_quantity)]),
  );
  const authorityLineById = new Map(
    args.authorityLines.map((line) => [Number(line.id), line]),
  );
  const adjustmentByExternalId = new Map(
    args.adjustments.map((adjustment) => [adjustment.externalLineItemId, adjustment]),
  );
  const lineIds = args.authorityLines.map((line) => Number(line.id));

  const itemResult = await tx.execute(sql`
    SELECT
      wi.id,
      wi.oms_order_line_id,
      wi.product_id,
      ol.external_line_item_id,
      wi.quantity,
      wi.picked_quantity,
      wi.fulfilled_quantity,
      wi.status,
      wi.short_reason,
      wi.on_hold,
      COALESCE(wi.requires_shipping, 1) <> 0 AS requires_shipping
    FROM wms.order_items wi
    JOIN oms.oms_order_lines ol ON ol.id = wi.oms_order_line_id
    WHERE wi.order_id = ${args.wmsOrderId}
      AND wi.oms_order_line_id = ANY(
        ARRAY[${sql.join(lineIds, sql`, `)}]::bigint[]
      )
    ORDER BY wi.id
    FOR UPDATE OF wi
  `);

  const itemRows = rowsOf<any>(itemResult);
  const itemCountByOmsLineId = new Map<number, number>();
  for (const row of itemRows) {
    const omsOrderLineId = Number(row.oms_order_line_id);
    itemCountByOmsLineId.set(
      omsOrderLineId,
      (itemCountByOmsLineId.get(omsOrderLineId) ?? 0) + 1,
    );
  }
  const duplicateMappings = Array.from(itemCountByOmsLineId.entries())
    .filter(([, count]) => count > 1)
    .map(([omsOrderLineId]) => omsOrderLineId);
  if (duplicateMappings.length > 0) {
    throw new Error(
      `WMS order ${args.wmsOrderId} has duplicate items for OMS line(s): ` +
        duplicateMappings.join(", "),
    );
  }
  const missingShippableMappings = args.authorityLines
    .filter(
      (line) =>
        line.requires_shipping !== false &&
        adjustmentByExternalId.has(String(line.external_line_item_id)) &&
        !itemCountByOmsLineId.has(Number(line.id)),
    )
    .map((line) => String(line.external_line_item_id));
  if (missingShippableMappings.length > 0) {
    throw new Error(
      `WMS order ${args.wmsOrderId} is missing shippable refund line(s): ` +
        missingShippableMappings.join(", "),
    );
  }

  const items: WmsItemState[] = [];
  const releaseTargets: Array<{ orderItemId: number; quantity: number }> = [];
  let changed = 0;

  for (const row of itemRows) {
    const omsOrderLineId = Number(row.oms_order_line_id);
    const externalLineItemId = String(row.external_line_item_id);
    const adjustment = adjustmentByExternalId.get(externalLineItemId);
    if (!adjustment) continue;

    const authorityFulfillableQuantity = authorityByLineId.get(omsOrderLineId) ?? 0;
    const transition = await applyRefundAuthorityToWmsOrderItem(tx, {
      current: {
        id: Number(row.id),
        orderId: args.wmsOrderId,
        quantity: Number(row.quantity ?? 0),
        pickedQuantity: Number(row.picked_quantity ?? 0),
        fulfilledQuantity: Number(row.fulfilled_quantity ?? 0),
        status: String(row.status ?? "pending"),
        shortReason: row.short_reason == null ? null : String(row.short_reason),
        onHold: Boolean(row.on_hold),
      },
      authorityFulfillableQuantity,
      restockPolicy: adjustment.restockPolicy,
    });
    if (transition.changed) changed++;
    const {
      quantity: nextQuantity,
      pickedQuantity,
      fulfilledQuantity,
      status: nextStatus,
    } = transition.item;
    const manualReviewReason = transition.manualReviewReason;

    const item: WmsItemState = {
      id: Number(row.id),
      omsOrderLineId,
      externalLineItemId,
      quantity: nextQuantity,
      pickedQuantity,
      fulfilledQuantity,
      status: nextStatus,
      authorityFulfillableQuantity,
      requiresShipping: Boolean(row.requires_shipping),
      manualReviewReason,
    };
    items.push(item);
    const authorityLine = authorityLineById.get(omsOrderLineId);
    const productVariantId = row.product_id == null ? null : Number(row.product_id);
    if (
      authorityLine &&
      item.requiresShipping &&
      Number.isInteger(productVariantId) &&
      productVariantId! > 0
    ) {
      const releaseQuantity = deriveRefundEventReservationReleaseQuantity({
        line: authorityLine,
        adjustment,
        pickedQuantity,
        fulfilledQuantity,
      });
      if (releaseQuantity > 0) {
        releaseTargets.push({ orderItemId: item.id, quantity: releaseQuantity });
      }
    }
  }

  if (changed > 0) {
    await tx.execute(sql`
      UPDATE wms.orders o
      SET item_count = agg.item_count,
          unit_count = agg.unit_count,
          picked_count = agg.picked_count,
          updated_at = ${args.now}
      FROM (
        SELECT
          order_id,
          COUNT(*)::int AS item_count,
          COALESCE(SUM(quantity), 0)::int AS unit_count,
          COALESCE(SUM(CASE WHEN requires_shipping <> 0 THEN picked_quantity ELSE 0 END), 0)::int AS picked_count
        FROM wms.order_items
        WHERE order_id = ${args.wmsOrderId}
        GROUP BY order_id
      ) agg
      WHERE o.id = agg.order_id
    `);
  }

  return { changed, items, releaseTargets };
}

async function reconcileActiveShipmentItems(
  tx: any,
  args: {
    wmsOrderId: number;
    affectedItems: WmsItemState[];
    now: Date;
    canPushShipment: boolean;
  },
): Promise<ShipmentReconciliationPlan[]> {
  const affectedByOrderItemId = new Map(args.affectedItems.map((item) => [item.id, item]));
  const itemResult = await tx.execute(sql`
    SELECT
      si.id AS shipment_item_id,
      si.shipment_id,
      si.order_item_id,
      si.qty AS current_quantity,
      CASE
        WHEN oi.status IN ('cancelled', 'short') THEN 0
        ELSE GREATEST(
          COALESCE(ol.authority_fulfillable_quantity, oi.quantity)
            - COALESCE(oi.fulfilled_quantity, 0),
          0
        )
      END::int AS remaining_demand
    FROM wms.outbound_shipment_items si
    JOIN wms.outbound_shipments os ON os.id = si.shipment_id
    JOIN wms.order_items oi ON oi.id = si.order_item_id
    LEFT JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
    WHERE os.order_id = ${args.wmsOrderId}
      AND os.status IN ('planned', 'queued', 'labeled')
    ORDER BY si.order_item_id, si.shipment_id, si.id
    FOR UPDATE OF si, os
  `);
  const allocationInput = rowsOf<any>(itemResult).map((row) => ({
    shipmentItemId: Number(row.shipment_item_id),
    shipmentId: Number(row.shipment_id),
    orderItemId: Number(row.order_item_id),
    currentQuantity: Number(row.current_quantity),
    remainingDemand: Number(row.remaining_demand),
  }));
  const allocations = allocateActiveShipmentItems(allocationInput);
  const changedShipmentIds = new Set<number>();
  const reviewReasonByShipmentId = new Map<number, string>();

  for (const allocation of allocations) {
    const affectedItem = affectedByOrderItemId.get(allocation.orderItemId);
    if (affectedItem?.manualReviewReason) {
      reviewReasonByShipmentId.set(allocation.shipmentId, affectedItem.manualReviewReason);
    }
    if (!allocation.changed) continue;
    changedShipmentIds.add(allocation.shipmentId);
    if (allocation.nextQuantity === 0) {
      await tx.execute(sql`
        DELETE FROM wms.outbound_shipment_items
        WHERE id = ${allocation.shipmentItemId}
          AND shipment_id = ${allocation.shipmentId}
      `);
    } else {
      await tx.execute(sql`
        UPDATE wms.outbound_shipment_items
        SET qty = ${allocation.nextQuantity}
        WHERE id = ${allocation.shipmentItemId}
          AND shipment_id = ${allocation.shipmentId}
      `);
    }
  }

  const shipmentResult = await tx.execute(sql`
    SELECT
      os.id,
      os.status,
      COALESCE((
        SELECT SUM(si.qty)::int
        FROM wms.outbound_shipment_items si
        WHERE si.shipment_id = os.id
      ), 0)::int AS remaining_quantity,
      EXISTS (
        SELECT 1
        FROM wms.outbound_shipments sibling
        WHERE sibling.id <> os.id
          AND sibling.order_id = os.order_id
          AND sibling.status IN ('shipped', 'returned', 'lost')
          AND (
            (
              NULLIF(BTRIM(COALESCE(os.shipping_engine, '')), '') IS NOT NULL
              AND sibling.shipping_engine = os.shipping_engine
              AND NULLIF(BTRIM(COALESCE(os.engine_order_ref, '')), '') IS NOT NULL
              AND sibling.engine_order_ref = os.engine_order_ref
            )
            OR (
              os.shipstation_order_id IS NOT NULL
              AND sibling.shipstation_order_id = os.shipstation_order_id
            )
            OR (
              NULLIF(BTRIM(COALESCE(os.shipstation_order_key, '')), '') IS NOT NULL
              AND sibling.shipstation_order_key = os.shipstation_order_key
            )
          )
      ) AS terminal_provider_sibling
    FROM wms.outbound_shipments os
    WHERE os.order_id = ${args.wmsOrderId}
      AND os.status IN ('planned', 'queued', 'labeled')
    ORDER BY os.id
    FOR UPDATE OF os
  `);

  const plans: ShipmentReconciliationPlan[] = [];
  for (const shipment of rowsOf<any>(shipmentResult)) {
    const shipmentId = Number(shipment.id);
    const remainingQuantity = Number(shipment.remaining_quantity ?? 0);
    const contentsChanged = changedShipmentIds.has(shipmentId);
    let reviewReason = reviewReasonByShipmentId.get(shipmentId) ?? null;
    if (contentsChanged && String(shipment.status) === "labeled") {
      reviewReason = reviewReason ?? "refund_after_label";
    }
    if (contentsChanged && String(shipment.status) === "queued" && !args.canPushShipment) {
      reviewReason = reviewReason ?? "refund_repush_unavailable";
    }

    if (reviewReason) {
      await tx.execute(sql`
        UPDATE wms.outbound_shipments
        SET requires_review = true,
            review_reason = ${reviewReason},
            updated_at = ${args.now}
        WHERE id = ${shipmentId}
      `);
    }

    if (!contentsChanged && remainingQuantity > 0 && !reviewReason) continue;
    plans.push({
      shipmentId,
      status: String(shipment.status),
      remainingQuantity,
      contentsChanged,
      skipEngineCancel: Boolean(shipment.terminal_provider_sibling),
      reviewReason,
    });
  }
  return plans;
}

async function createExpectedReturn(
  tx: any,
  args: {
    omsOrderId: number;
    wmsOrderId: number;
    refundExternalId: string;
    refundPayload: Record<string, unknown>;
    adjustments: ShopifyRefundLineAdjustment[];
    wmsItems: WmsItemState[];
    now: Date;
  },
): Promise<{ returnId: number | null; itemsCreated: number; warnings: string[] }> {
  const returnPolicies = new Set(["return", "restock"]);
  const itemByExternalId = new Map(
    args.wmsItems.map((item) => [item.externalLineItemId, item]),
  );
  const eventKey = refundReturnEventKey(args.refundExternalId, args.wmsOrderId);
  const expectedItems: Array<{
    adjustment: ShopifyRefundLineAdjustment;
    item: WmsItemState;
    expectedQuantity: number;
  }> = [];
  const warnings: string[] = [];

  for (const adjustment of args.adjustments) {
    if (!returnPolicies.has(adjustment.restockPolicy)) continue;
    const item = itemByExternalId.get(adjustment.externalLineItemId);
    if (!item) {
      warnings.push(
        `Return policy for line ${adjustment.externalLineItemId} has no WMS item to receive`,
      );
      continue;
    }

    const priorResult = await tx.execute(sql`
      SELECT COALESCE(SUM(ri.expected_qty), 0)::int AS expected_quantity
      FROM wms.return_items ri
      JOIN wms.returns r ON r.id = ri.return_id
      WHERE ri.order_item_id = ${item.id}
        AND COALESCE(r.source_event_key, '') <> ${eventKey}
    `);
    const priorExpected = Number(priorResult?.rows?.[0]?.expected_quantity ?? 0);
    const availableReturnEntitlement = Math.max(item.fulfilledQuantity - priorExpected, 0);
    const expectedQuantity = Math.min(adjustment.quantity, availableReturnEntitlement);
    if (expectedQuantity <= 0) {
      warnings.push(
        `Return policy for line ${adjustment.externalLineItemId} has no unclaimed fulfilled quantity`,
      );
      continue;
    }
    if (expectedQuantity < adjustment.quantity) {
      warnings.push(
        `Return policy for line ${adjustment.externalLineItemId} was capped from ${adjustment.quantity} to ${expectedQuantity} fulfilled unit(s)`,
      );
    }
    expectedItems.push({ adjustment, item, expectedQuantity });
  }

  if (expectedItems.length === 0) {
    return { returnId: null, itemsCreated: 0, warnings };
  }

  const orderItemIds = expectedItems.map(({ item }) => item.id);
  const shipmentResult = await tx.execute(sql`
    SELECT os.id
    FROM wms.outbound_shipments os
    JOIN wms.outbound_shipment_items si ON si.shipment_id = os.id
    WHERE os.order_id = ${args.wmsOrderId}
      AND os.status IN ('shipped', 'returned', 'lost')
      AND si.order_item_id = ANY(
        ARRAY[${sql.join(orderItemIds, sql`, `)}]::int[]
      )
    ORDER BY COALESCE(os.shipped_at, os.updated_at, os.created_at) DESC, os.id DESC
    LIMIT 1
  `);
  const shipmentId = rowsOf<any>(shipmentResult)[0]?.id ?? null;
  const refundedAt = parseRefundTimestamp(args.refundPayload.processed_at, args.now);
  const reason = typeof args.refundPayload.note === "string" && args.refundPayload.note.trim()
    ? args.refundPayload.note.trim().slice(0, 200)
    : "shopify_refund";
  const notes = typeof args.refundPayload.note === "string"
    ? args.refundPayload.note
    : null;

  const expectedReturn = await createExpectedWmsReturn(tx, {
    shipmentId: shipmentId == null ? null : Number(shipmentId),
    orderId: args.wmsOrderId,
    source: "shopify_webhook",
    sourceEventKey: eventKey,
    reason,
    refundExternalId: args.refundExternalId,
    refundedAt,
    notes,
    items: expectedItems.map((expected) => ({
      orderItemId: expected.item.id,
      omsOrderLineId: expected.item.omsOrderLineId,
      externalLineItemId: expected.adjustment.externalLineItemId,
      expectedQuantity: expected.expectedQuantity,
      restockPolicy: expected.adjustment.restockPolicy,
      locationId: expected.adjustment.raw.location_id == null
        ? null
        : String(expected.adjustment.raw.location_id),
    })),
    now: args.now,
  });
  return {
    returnId: expectedReturn.returnId,
    itemsCreated: expectedReturn.items.filter((item) => item.created).length,
    warnings,
  };
}

async function applyInternalRefundState(
  db: any,
  args: {
    omsOrderId: number;
    wmsOrderId: number | null;
    refundExternalId: string;
    refundPayload: Record<string, unknown>;
    adjustments: ShopifyRefundLineAdjustment[];
    sourceInboxId: number | null;
    now: Date;
    canPushShipment: boolean;
    channelId: number;
    recordReturnCase?: ShopifyRefundCascadeHelpers["recordReturnCase"];
  },
): Promise<InternalRefundResult> {
  return db.transaction(async (tx: any) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(${REFUND_LOCK_NAMESPACE}, ${args.omsOrderId})
    `);

    let lines = await loadAndLockOmsLines(tx, args.omsOrderId, args.adjustments);
    const lineIdByExternalId = new Map(
      lines.map((line) => [String(line.external_line_item_id), Number(line.id)]),
    );
    const reason = typeof args.refundPayload.note === "string" && args.refundPayload.note.trim()
      ? args.refundPayload.note.trim()
      : "shopify_refund";
    const insertedAdjustments = await persistRefundAdjustments(tx, {
      omsOrderId: args.omsOrderId,
      refundExternalId: args.refundExternalId,
      reason,
      adjustments: args.adjustments,
      lineIdByExternalId,
    });

    lines = await loadRefundAggregates(tx, args.omsOrderId, args.adjustments);
    const authorityResult = await applyOmsLineAuthority(tx, {
      omsOrderId: args.omsOrderId,
      refundExternalId: args.refundExternalId,
      sourceInboxId: args.sourceInboxId,
      now: args.now,
      lines,
    });

    if (!args.wmsOrderId) {
      return {
        insertedAdjustments,
        authorityChanges: authorityResult.changed,
        wmsLineChanges: 0,
        releaseTargets: [],
        shipmentPlans: [],
        returnId: null,
        returnItemsCreated: 0,
        warnings: authorityResult.warnings,
      };
    }

    const wmsResult = await applyWmsLineState(tx, {
      wmsOrderId: args.wmsOrderId,
      adjustments: args.adjustments,
      authorityLines: authorityResult.lines,
      now: args.now,
    });
    await refreshOmsLineMaterializedQuantities(tx, {
      omsOrderId: args.omsOrderId,
      updatedAt: args.now,
    });
    const shipmentPlans = await reconcileActiveShipmentItems(tx, {
      wmsOrderId: args.wmsOrderId,
      affectedItems: wmsResult.items,
      now: args.now,
      canPushShipment: args.canPushShipment,
    });
    const expectedReturn = await createExpectedReturn(tx, {
      omsOrderId: args.omsOrderId,
      wmsOrderId: args.wmsOrderId,
      refundExternalId: args.refundExternalId,
      refundPayload: args.refundPayload,
      adjustments: args.adjustments,
      wmsItems: wmsResult.items,
      now: args.now,
    });
    if (expectedReturn.returnId !== null && args.recordReturnCase) {
      await args.recordReturnCase({
        tx,
        channelId: args.channelId,
        omsOrderId: args.omsOrderId,
        wmsOrderId: args.wmsOrderId,
        wmsReturnId: expectedReturn.returnId,
        refundExternalId: args.refundExternalId,
        now: args.now,
      });
    }

    return {
      insertedAdjustments,
      authorityChanges: authorityResult.changed,
      wmsLineChanges: wmsResult.changed,
      releaseTargets: wmsResult.releaseTargets,
      shipmentPlans,
      returnId: expectedReturn.returnId,
      returnItemsCreated: expectedReturn.itemsCreated,
      warnings: [...authorityResult.warnings, ...expectedReturn.warnings],
    };
  });
}

function requireRepairText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} cannot be blank`);
  if (normalized.length > maxLength) {
    throw new Error(`${field} cannot exceed ${maxLength} characters`);
  }
  return normalized;
}

async function assertPersistedRefundAdjustments(
  tx: any,
  args: {
    omsOrderId: number;
    refundExternalId: string;
    adjustments: readonly ShopifyRefundLineAdjustment[];
  },
): Promise<void> {
  const externalIds = args.adjustments.map((adjustment) => adjustment.externalLineItemId);
  const uniqueExternalIds = new Set(externalIds);
  if (externalIds.length === 0) {
    throw new Error("Historical refund authority repair requires at least one line adjustment");
  }
  if (uniqueExternalIds.size !== externalIds.length) {
    throw new Error("Historical refund authority repair adjustments must have unique line identities");
  }

  const result = await tx.execute(sql`
    SELECT
      external_line_item_id,
      quantity,
      restock_policy
    FROM oms.order_line_adjustments
    WHERE order_id = ${args.omsOrderId}
      AND source = 'shopify_webhook'
      AND source_event_id = ${args.refundExternalId}
      AND adjustment_type = 'refund'
      AND external_line_item_id = ANY(
        ARRAY[${sql.join(externalIds, sql`, `)}]::text[]
      )
    ORDER BY external_line_item_id
  `);
  const persistedByExternalId = new Map(
    rowsOf<any>(result).map((row) => [String(row.external_line_item_id), row]),
  );
  for (const adjustment of args.adjustments) {
    const persisted = persistedByExternalId.get(adjustment.externalLineItemId);
    if (
      !persisted
      || Number(persisted.quantity) !== adjustment.quantity
      || String(persisted.restock_policy) !== adjustment.restockPolicy
    ) {
      throw new Error(
        `Persisted Shopify refund fact does not match repair input for line ${adjustment.externalLineItemId}`,
      );
    }
  }
}

async function auditPersistedRefundAuthorityRepair(
  tx: any,
  args: {
    runId: string;
    operator: string;
    reason: string;
    now: Date;
    lines: readonly OmsLineStateRow[];
  },
): Promise<number> {
  let inserted = 0;
  for (const line of args.lines) {
    const authority = deriveAuthorityForRefundLine(line);
    if (authority.overDispositionQuantity > 0) {
      throw new Error(
        `OMS line ${line.id} has ${authority.overDispositionQuantity} disposition unit(s) beyond paid quantity`,
      );
    }
    const stateChanged =
      Number(line.authority_fulfillable_quantity) !== authority.authorityFulfillableQuantity
      || Number(line.refunded_quantity) !== authority.refundedQuantity
      || String(line.authorization_status) !== authority.authorizationStatus;
    if (!stateChanged) continue;

    const beforeRow = { ...line };
    const afterRow = {
      ...line,
      authority_fulfillable_quantity: authority.authorityFulfillableQuantity,
      refunded_quantity: authority.refundedQuantity,
      authorization_status: authority.authorizationStatus,
      updated_at: args.now,
    };
    await recordOmsWmsAuthorityCleanupAudit(tx, {
      runId: args.runId,
      operation: "historical-refund-authority-repair",
      sourceTable: "oms.oms_order_lines",
      sourceId: Number(line.id),
      action: "update",
      reason: args.reason,
      beforeRow,
      afterRow,
      operator: args.operator,
      createdAt: args.now,
    });
    inserted++;
  }
  return inserted;
}

async function assertHistoricalRefundWmsState(
  tx: any,
  args: {
    wmsOrderId: number;
    lines: readonly OmsLineStateRow[];
  },
): Promise<void> {
  const lineIds = args.lines.map((line) => Number(line.id));
  const result = await tx.execute(sql`
    SELECT
      item.id,
      item.oms_order_line_id,
      item.status,
      item.quantity,
      item.picked_quantity,
      item.fulfilled_quantity
    FROM wms.order_items item
    WHERE item.order_id = ${args.wmsOrderId}
      AND item.oms_order_line_id = ANY(
        ARRAY[${sql.join(lineIds, sql`, `)}]::bigint[]
      )
    ORDER BY item.id
    FOR UPDATE OF item
  `);
  const rows = rowsOf<any>(result);
  const rowsByLineId = new Map<number, any[]>();
  for (const row of rows) {
    const lineId = Number(row.oms_order_line_id);
    rowsByLineId.set(lineId, [...(rowsByLineId.get(lineId) ?? []), row]);
  }

  for (const line of args.lines) {
    const mapped = rowsByLineId.get(Number(line.id)) ?? [];
    if (line.requires_shipping !== false && mapped.length !== 1) {
      throw new Error(
        `Historical refund authority repair requires exactly one WMS item for OMS line ${line.id}; found ${mapped.length}`,
      );
    }
    for (const item of mapped) {
      const status = String(item.status ?? "");
      const pickedQuantity = Number(item.picked_quantity ?? 0);
      const fulfilledQuantity = Number(item.fulfilled_quantity ?? 0);
      const validCancelledState =
        status === "cancelled" && pickedQuantity === 0 && fulfilledQuantity === 0;
      const validProjectedShipmentState =
        status === "completed"
        && fulfilledQuantity > 0
        && pickedQuantity >= fulfilledQuantity;
      if (!validCancelledState && !validProjectedShipmentState) {
        throw new Error(
          `OMS line ${line.id} has unsafe historical WMS state ` +
          `status=${status} picked=${pickedQuantity} fulfilled=${fulfilledQuantity}`,
        );
      }
    }
  }
}

/**
 * Reconcile line authority from already-persisted Shopify refund facts.
 *
 * This is intentionally narrower than applyShopifyRefundCascade: it does not
 * create adjustments, release reservations, mutate active shipment plans, or
 * create returns. Callers must select only historical terminal rows whose
 * operational side effects were already applied.
 */
export async function reconcilePersistedShopifyRefundAuthority(
  db: any,
  input: ReconcilePersistedShopifyRefundAuthorityInput,
): Promise<ReconcilePersistedShopifyRefundAuthorityResult> {
  const refundExternalId = requireRepairText(
    input.refundExternalId,
    "refundExternalId",
    100,
  );
  const operator = requireRepairText(input.audit.operator, "audit.operator", 120);
  const reason = requireRepairText(input.audit.reason, "audit.reason", 2_000);
  const adjustments = input.adjustments.map((adjustment) => ({ ...adjustment }));

  return db.transaction(async (tx: any) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(${REFUND_LOCK_NAMESPACE}, ${input.omsOrderId})
    `);
    await assertPersistedRefundAdjustments(tx, {
      omsOrderId: input.omsOrderId,
      refundExternalId,
      adjustments,
    });
    await loadAndLockOmsLines(tx, input.omsOrderId, adjustments);
    const lines = await loadRefundAggregates(tx, input.omsOrderId, adjustments);
    await assertHistoricalRefundWmsState(tx, {
      wmsOrderId: input.wmsOrderId,
      lines,
    });
    const auditedChanges = await auditPersistedRefundAuthorityRepair(tx, {
      runId: input.audit.runId,
      operator,
      reason,
      now: input.now,
      lines,
    });
    const authorityResult = await applyOmsLineAuthority(tx, {
      omsOrderId: input.omsOrderId,
      refundExternalId,
      sourceInboxId: input.sourceInboxId ?? null,
      now: input.now,
      lines,
    });
    if (authorityResult.changed !== auditedChanges) {
      throw new Error(
        `Historical refund authority repair changed ${authorityResult.changed} line(s) after auditing ${auditedChanges}`,
      );
    }
    await refreshOmsLineMaterializedQuantities(tx, {
      omsOrderId: input.omsOrderId,
      updatedAt: input.now,
    });

    return Object.freeze({
      authorityChanges: authorityResult.changed,
      wmsLineChanges: 0,
      warnings: Object.freeze([...authorityResult.warnings]),
    });
  });
}

export async function applyShopifyRefundCascade(
  db: any,
  refundPayload: unknown,
  helpers: ShopifyRefundCascadeHelpers,
  options: ShopifyRefundCascadeOptions,
): Promise<ApplyShopifyRefundCascadeResult> {
  const now = options.now ?? new Date();
  const logPrefix = options.logPrefix ?? "[applyShopifyRefundCascade]";
  if (!refundPayload || typeof refundPayload !== "object" || Array.isArray(refundPayload)) {
    throw new RefundsCreateBadPayloadError("refund payload missing or not an object");
  }
  const payload = refundPayload as Record<string, unknown>;
  if (payload.id === null || payload.id === undefined || String(payload.id).trim() === "") {
    throw new RefundsCreateBadPayloadError("refund payload missing `id`");
  }
  if (
    payload.order_id === null ||
    payload.order_id === undefined ||
    String(payload.order_id).trim() === ""
  ) {
    throw new RefundsCreateBadPayloadError("refund payload missing `order_id`");
  }

  const refundExternalId = String(payload.id);
  const adjustments = extractRefundLineAdjustments(payload.refund_line_items);
  const omsOrder = await helpers.resolveOmsOrder(db, {
    shopifyOrderId: payload.order_id as string | number,
    channelId: options.channelId,
  });
  if (!omsOrder) {
    return {
      outcome: "order_not_tracked",
      refundExternalId,
      returnExpected: false,
      restocked: false,
      adjustedLines: 0,
      releasedReservationQuantity: 0,
      cancelledShipments: 0,
      repushedShipments: 0,
      flaggedShipments: 0,
      warnings: [],
    };
  }

  if (adjustments.length === 0) {
    return {
      outcome: "financial_only",
      refundExternalId,
      omsOrderId: omsOrder.id,
      returnExpected: false,
      restocked: false,
      adjustedLines: 0,
      releasedReservationQuantity: 0,
      cancelledShipments: 0,
      repushedShipments: 0,
      flaggedShipments: 0,
      warnings: [],
    };
  }

  const wmsOrderResult = await db.execute(sql`
    SELECT id
    FROM wms.orders
    WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(omsOrder.id)})
       OR (source = 'shopify' AND source_table_id = ${String(omsOrder.id)})
    ORDER BY id
    LIMIT 1
  `);
  const wmsOrderIdRaw = rowsOf<any>(wmsOrderResult)[0]?.id;
  const wmsOrderId = wmsOrderIdRaw == null ? null : Number(wmsOrderIdRaw);

  const internal = await applyInternalRefundState(db, {
    omsOrderId: omsOrder.id,
    wmsOrderId,
    refundExternalId,
    refundPayload: payload,
    adjustments,
    sourceInboxId: options.sourceInboxId ?? null,
    now,
    canPushShipment: typeof helpers.pushShipment === "function",
    channelId: options.channelId,
    recordReturnCase: helpers.recordReturnCase,
  });

  let releasedReservationQuantity = 0;
  if (internal.releaseTargets.length > 0 && !helpers.releaseOrderItemReservation) {
    throw new Error(
      `Line-level reservation release is not configured for refund ${refundExternalId}`,
    );
  }
  for (const target of internal.releaseTargets) {
    const release = await helpers.releaseOrderItemReservation!({
      orderId: wmsOrderId!,
      orderItemId: target.orderItemId,
      quantity: target.quantity,
      sourceEventId: refundExternalId,
      reason: `Shopify line refund ${refundExternalId}`,
      userId: "system:shopify_refund",
    });
    releasedReservationQuantity += Number(release?.releasedQuantity ?? 0);
  }

  let cancelledShipments = 0;
  let repushedShipments = 0;
  let flaggedShipments = 0;
  for (const plan of internal.shipmentPlans) {
    if (plan.reviewReason) flaggedShipments++;
    if (plan.remainingQuantity <= 0) {
      const cancelled = await markShipmentCancelled(
        db,
        plan.shipmentId,
        plan.skipEngineCancel
          ? "refund_retired_provider_covered_shipment"
          : "refund_fully_cancelled",
        {
          now,
          skipEngineCancel: plan.skipEngineCancel,
          engineCancel: helpers.shippingEngine
            ? async (ref) => { await helpers.shippingEngine!.cancel(ref); }
            : undefined,
          shipstation: helpers.shipstation
            ? {
                removeFromList: async (shipstationOrderId: number) => {
                  await helpers.shipstation!.cancelOrder(shipstationOrderId);
                },
              }
            : undefined,
        },
      );
      if (cancelled.changed) cancelledShipments++;
      continue;
    }

    if (
      plan.contentsChanged &&
      plan.status === "queued" &&
      typeof helpers.pushShipment === "function"
    ) {
      await helpers.pushShipment(plan.shipmentId);
      repushedShipments++;
    }
  }

  if (cancelledShipments > 0 && wmsOrderId) {
    await recomputeOrderStatusFromShipments(db, wmsOrderId, { now });
  }

  for (const warning of internal.warnings) {
    console.warn(`${logPrefix} ${warning}`);
  }

  const changed =
    internal.insertedAdjustments > 0 ||
    internal.authorityChanges > 0 ||
    internal.wmsLineChanges > 0 ||
    internal.returnItemsCreated > 0 ||
    releasedReservationQuantity > 0 ||
    cancelledShipments > 0 ||
    repushedShipments > 0;
  const outcome: ApplyShopifyRefundCascadeOutcome = !wmsOrderId
    ? "wms_order_not_found"
    : internal.returnId
      ? "return_expected"
      : changed
        ? "line_dispositions_applied"
        : "idempotent_skip";

  return {
    outcome,
    refundExternalId,
    omsOrderId: omsOrder.id,
    wmsOrderId: wmsOrderId ?? undefined,
    returnId: internal.returnId,
    returnExpected: internal.returnId !== null,
    restocked: false,
    adjustedLines: Math.max(internal.authorityChanges, internal.wmsLineChanges),
    releasedReservationQuantity,
    cancelledShipments,
    repushedShipments,
    flaggedShipments,
    warnings: internal.warnings,
  };
}

export const __test__ = {
  deriveRefundEventReservationReleaseQuantity,
  applyInternalRefundState,
  createExpectedReturn,
  reconcileActiveShipmentItems,
};
