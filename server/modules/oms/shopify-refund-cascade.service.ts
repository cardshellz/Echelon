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
}

export interface ShopifyRefundCascadeOptions {
  channelId: number;
  sourceInboxId?: number | null;
  now?: Date;
  logPrefix?: string;
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
    const authority = deriveRefundAuthority({
      paidQuantity: Number(line.paid_quantity),
      previousAuthorityFulfillableQuantity: Number(line.authority_fulfillable_quantity),
      cancelledQuantity: Number(line.cancelled_quantity),
      refundCancelQuantity: Number(line.refund_cancel_quantity),
      refundOtherQuantity: Number(line.refund_other_quantity),
    });
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
  const adjustmentByExternalId = new Map(
    args.adjustments.map((adjustment) => [adjustment.externalLineItemId, adjustment]),
  );
  const lineIds = args.authorityLines.map((line) => Number(line.id));

  const itemResult = await tx.execute(sql`
    SELECT
      wi.id,
      wi.oms_order_line_id,
      ol.external_line_item_id,
      wi.quantity,
      wi.picked_quantity,
      wi.fulfilled_quantity,
      wi.status,
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
    const quantity = Number(row.quantity ?? 0);
    const pickedQuantity = Number(row.picked_quantity ?? 0);
    const fulfilledQuantity = Number(row.fulfilled_quantity ?? 0);
    const status = String(row.status ?? "pending");
    const physicalFloor = Math.max(pickedQuantity, fulfilledQuantity);
    const refundAfterPick = pickedQuantity > authorityFulfillableQuantity && pickedQuantity > fulfilledQuantity;
    const preserveHistoricalQuantity = status === "completed" || status === "short";
    const nextQuantity = preserveHistoricalQuantity
      ? quantity
      : Math.max(authorityFulfillableQuantity, physicalFloor);
    let nextStatus = status;
    let nextShortReason: string | null = null;
    let nextOnHold = false;

    if (refundAfterPick) {
      nextStatus = "short";
      nextShortReason = "refund_after_pick";
      nextOnHold = true;
    } else if (fulfilledQuantity > authorityFulfillableQuantity) {
      // Physical fulfillment is historical fact. Keep the WMS line terminal while
      // the OMS authority records that no further units may be fulfilled.
      nextStatus = "completed";
    } else if (
      authorityFulfillableQuantity === 0 &&
      pickedQuantity === 0 &&
      fulfilledQuantity === 0 &&
      status !== "short" &&
      status !== "completed"
    ) {
      nextStatus = "cancelled";
    }

    const manualReviewReason = refundAfterPick
      ? "refund_after_pick"
      : adjustment.restockPolicy === "unknown"
        ? "refund_unknown_restock_policy"
        : null;

    const rowChanged =
      nextQuantity !== quantity ||
      nextStatus !== status ||
      nextShortReason !== null ||
      nextOnHold;
    if (rowChanged) {
      await tx.execute(sql`
        UPDATE wms.order_items
        SET quantity = ${nextQuantity},
            status = ${nextStatus},
            short_reason = CASE
              WHEN ${nextShortReason}::text IS NOT NULL THEN ${nextShortReason}
              ELSE short_reason
            END,
            on_hold = CASE WHEN ${nextOnHold} THEN true ELSE on_hold END
        WHERE id = ${Number(row.id)}
          AND order_id = ${args.wmsOrderId}
      `);
      changed++;
    }

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
    releaseTargets.push({ orderItemId: item.id, quantity: adjustment.quantity });
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

  const insertedReturn = await tx.execute(sql`
    INSERT INTO wms.returns (
      shipment_id, order_id, source, source_event_key, reason,
      refund_external_id, restocked, status, received_at, refunded_at,
      notes, created_at, updated_at
    ) VALUES (
      ${shipmentId}, ${args.wmsOrderId}, 'shopify_webhook', ${eventKey},
      ${reason}, ${args.refundExternalId}, false, 'expected', NULL,
      ${refundedAt}, ${notes}, ${args.now}, ${args.now}
    )
    ON CONFLICT (source_event_key) WHERE NULLIF(BTRIM(source_event_key), '') IS NOT NULL
    DO NOTHING
    RETURNING id
  `);
  let returnId = rowsOf<any>(insertedReturn)[0]?.id;
  if (!returnId) {
    const existingReturn = await tx.execute(sql`
      SELECT id
      FROM wms.returns
      WHERE source_event_key = ${eventKey}
      LIMIT 1
      FOR UPDATE
    `);
    returnId = rowsOf<any>(existingReturn)[0]?.id;
  }
  if (!returnId) {
    throw new Error(`Could not resolve expected return for ${eventKey}`);
  }

  let itemsCreated = 0;
  for (const expected of expectedItems) {
    const locationId = expected.adjustment.raw.location_id == null
      ? null
      : String(expected.adjustment.raw.location_id);
    const insertedItem = await tx.execute(sql`
      INSERT INTO wms.return_items (
        return_id, order_item_id, oms_order_line_id,
        external_line_item_id, sku, expected_qty, received_qty,
        restock_policy, location_id, status, created_at, updated_at
      )
      SELECT
        ${Number(returnId)}, ${expected.item.id}, ${expected.item.omsOrderLineId},
        ${expected.adjustment.externalLineItemId},
        (SELECT sku FROM wms.order_items WHERE id = ${expected.item.id}),
        ${expected.expectedQuantity}, 0, ${expected.adjustment.restockPolicy},
        ${locationId}, 'expected', ${args.now}, ${args.now}
      WHERE NOT EXISTS (
        SELECT 1
        FROM wms.return_items existing
        WHERE existing.return_id = ${Number(returnId)}
          AND existing.external_line_item_id = ${expected.adjustment.externalLineItemId}
      )
      RETURNING id
    `);
    itemsCreated += rowsOf(insertedItem).length;
  }

  return { returnId: Number(returnId), itemsCreated, warnings };
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
  applyInternalRefundState,
  createExpectedReturn,
  reconcileActiveShipmentItems,
};
