/**
 * OMS Shopify Webhooks — Direct Shopify → OMS order ingestion
 *
 * Registered BEFORE auth middleware and JSON body parser.
 * Uses express.raw() for HMAC verification, then parses JSON manually.
 *
 * Endpoints:
 *   POST /api/oms/webhooks/orders/paid       — New paid order
 *   POST /api/oms/webhooks/orders/updated     — Order updated
 *   POST /api/oms/webhooks/orders/cancelled   — Order cancelled
 *   POST /api/oms/webhooks/orders/fulfilled   — Order fulfilled
 *   POST /api/oms/webhooks/refunds/create     — Refund created
 */

import { createHmac } from "crypto";
import type { Request, Response, Express } from "express";
import * as crypto from "crypto";
import { sql, eq, and, ilike } from "drizzle-orm";
import { applyChannelFulfillment } from "./channel-fulfillment.service";
import type { OmsService, OrderData, LineItemData } from "./oms.service";
import { omsOrders, omsOrderLines, omsOrderEvents, productVariants, channelConnections, webhookRetryQueue } from "@shared/schema";
import { db } from "../../db";
import { pushToMissionControl } from "./mc-push";
import { enrichOrderWithMemberTier } from "./member-tier-enrichment";
import { normalizeShopifyLineItems } from "./shopify-line-item-normalizer";
import rateLimit from "express-rate-limit";
import { createDefaultShopifyAdminClient, type ShopifyAdminGraphQLClient } from "../shopify/admin-gql-client";
import {
  buildShopifyWebhookInboxInput,
  markWebhookFailed,
  markWebhookProcessing,
  markWebhookSucceeded,
  recordWebhookReceived,
  type WebhookInboxReceipt,
} from "./webhook-inbox.service";
import {
  enqueueOmsWmsSyncRetry,
  enqueueShipStationShipmentPushRetry,
} from "./webhook-retry.worker";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[OMS Shopify Webhook]";

async function ensureOmsOrderQueuedForWmsSync(
  wmsSyncService: any,
  omsOrderId: number,
  label: string,
): Promise<void> {
  try {
    const wmsOrderId = await wmsSyncService.syncOmsOrderToWms(omsOrderId);
    if (!wmsOrderId) {
      // `null` = sync intentionally skipped (order already final/fulfilled out-of-band) —
      // a no-op, not a failure. Don't throw (that re-queues and dead-letters a harmless skip).
      console.log(`${LOG_PREFIX} WMS sync skipped for ${label} — already fulfilled out-of-band; no-op`);
      return;
    }
    console.log(`${LOG_PREFIX} Synced ${label} to WMS (wms=${wmsOrderId})`);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    console.error(`${LOG_PREFIX} WMS sync failed for ${label}: ${message}`);
    await enqueueOmsWmsSyncRetry(
      db,
      omsOrderId,
      error instanceof Error ? error : new Error(message),
    );
  }
}

// ---------------------------------------------------------------------------
// Types for injected services
// ---------------------------------------------------------------------------

interface WmsServices {
  reservation: {
    reserveOrder: (orderId: number) => Promise<any>;
    releaseOrderReservation: (orderId: number, reason: string) => Promise<any>;
  };
  fulfillmentRouter: {
    routeOrder: (ctx: any) => Promise<any>;
    assignWarehouseToOrder: (orderId: number, routing: any) => Promise<void>;
  };
  slaMonitor: {
    setSLAForOrder: (orderId: number) => Promise<void>;
  };
}

interface ShipStationService {
  isConfigured: () => boolean;
  pushShipment?: (shipmentId: number) => Promise<any>;
  markAsShipped: (shipstationOrderId: number, opts?: {
    shipDate?: Date | string;
    trackingNumber?: string | null;
    carrierCode?: string | null;
    notifyCustomer?: boolean;
  }) => Promise<{ alreadyInState: boolean } | void>;
  cancelOrder: (shipstationOrderId: number) => Promise<{ alreadyInState: boolean } | void>;
}

// ---------------------------------------------------------------------------
// HMAC Verification
// ---------------------------------------------------------------------------

function verifyShopifyHmac(rawBody: Buffer, hmacHeader: string | undefined): boolean {
  if (!hmacHeader) return false;
  // Try both app API secret and admin webhook secret
  const secrets = [process.env.SHOPIFY_API_SECRET, process.env.SHOPIFY_WEBHOOK_SECRET].filter(Boolean) as string[];
  for (const secret of secrets) {
    const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    try {
      if (crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmacHeader))) return true;
    } catch {
      if (computed === hmacHeader) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shopify payload → OMS OrderData mapping
// ---------------------------------------------------------------------------

function dollarsToCents(value: string | number | undefined | null): number {
  if (value === null || value === undefined) return 0;
  return Math.round(parseFloat(String(value)) * 100);
}

// ---------------------------------------------------------------------------
// C22b — Shopify fraud-risk extraction (§6 Group E, Decision D3)
// ---------------------------------------------------------------------------
//
// Shopify exposes risk in two shapes depending on Admin API version:
//
//   - Modern (2024-10+): `risk_assessments` array, each entry carrying
//     `risk_level` (LOW/MEDIUM/HIGH), optional `recommendation`, optional
//     numeric `score`, and a `facts` array.
//   - Legacy: a single `risk` object with `level` + `recommendation` and
//     no numeric score.
//
// We collect whichever shape is present, defensively, and fall back to
// NULL on absent / malformed data. Severity ordering for the modern
// payload picks the highest-risk assessment so a single HIGH assessment
// can't be hidden by a LOW one.
//
// Pure: no DB, no network, no globals. Exported via __test__ for unit
// tests (Rule #9, Rule #13).

const RISK_LEVEL_SEVERITY: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function normalizeRiskLevel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed;
}

function normalizeRiskRecommendation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed;
}

function parseRiskScore(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return String(parsed);
  }
  return null;
}

export interface ExtractedRisk {
  riskLevel: string | null;
  riskScore: string | null;
  riskRecommendation: string | null;
  riskFacts: unknown;
}

function extractShopifyRisk(shopifyOrder: any): ExtractedRisk {
  const empty: ExtractedRisk = {
    riskLevel: null,
    riskScore: null,
    riskRecommendation: null,
    riskFacts: null,
  };
  if (!shopifyOrder || typeof shopifyOrder !== "object") return empty;

  // Modern payload: risk_assessments array.
  const assessments = (shopifyOrder as any).risk_assessments;
  if (Array.isArray(assessments) && assessments.length > 0) {
    let bestLevel: string | null = null;
    let bestSeverity = -1;
    let bestRecommendation: string | null = null;
    let bestScore: string | null = null;

    for (const a of assessments) {
      if (!a || typeof a !== "object") continue;
      const level = normalizeRiskLevel((a as any).risk_level ?? (a as any).level);
      const severity = level !== null ? RISK_LEVEL_SEVERITY[level] ?? -1 : -1;
      if (severity > bestSeverity) {
        bestSeverity = severity;
        bestLevel = level;
        bestRecommendation = normalizeRiskRecommendation((a as any).recommendation);
        bestScore = parseRiskScore((a as any).score);
      }
    }

    return {
      riskLevel: bestLevel,
      riskScore: bestScore,
      riskRecommendation: bestRecommendation,
      riskFacts: assessments,
    };
  }

  // Legacy payload: single risk object with level + recommendation.
  const legacy = (shopifyOrder as any).risk;
  if (legacy && typeof legacy === "object") {
    const level = normalizeRiskLevel(legacy.level);
    const recommendation = normalizeRiskRecommendation(legacy.recommendation);
    if (level === null && recommendation === null) {
      return empty;
    }
    return {
      riskLevel: level,
      riskScore: parseRiskScore(legacy.score),
      riskRecommendation: recommendation,
      riskFacts: legacy,
    };
  }

  return empty;
}

// Exposed for unit testing the extractor in isolation. Keeping the
// helper private to the module avoids leaking an internal contract;
// `__test__` is the conventional escape hatch in this codebase
// (mirrors fulfillment-push.service.ts).
/**
 * Cascade a Shopify orders/cancelled event through the per-shipment C19
 * helpers. Pre-label shipments cancel cleanly (with SS removeFromList
 * if pushed). Post-label shipments are flagged `requires_review` +
 * `on_hold` per Overlord's "Option B" decision — operator decides
 * void/ship/intercept. After the cascade, recomputes order-level
 * warehouse_status from the shipment states.
 *
 * Plan ref: shipstation-flow-refactor-plan.md §6 Commit 28.
 *
 * Returns the per-shipment outcomes for logging + tests.
 */
export async function cascadeShopifyCancelToShipments(
  db: any,
  wmsOrderId: number,
  helpers: {
    handleCustomerCancelOnShipment: (
      db: any,
      shipmentId: number,
      opts?: any,
    ) => Promise<
      | { mode: "cancelled"; wmsOrderId: number }
      | { mode: "requires_review"; shipmentId: number }
      | { mode: "noop"; reason: string }
    >;
    recomputeOrderStatusFromShipments: (
      db: any,
      wmsOrderId: number,
    ) => Promise<{ warehouseStatus: string; changed: boolean }>;
  },
  opts: {
    now?: Date;
    shipstation?: { removeFromList?: (id: number) => Promise<void> };
    logPrefix?: string;
  } = {},
): Promise<{
  hadShipments: boolean;
  cascadeResults: Array<{ shipmentId: number; mode: string; error?: string }>;
  rollupChanged?: boolean;
}> {
  const logPrefix = opts.logPrefix ?? "[cascadeShopifyCancelToShipments]";
  const now = opts.now ?? new Date();

  // Find all non-terminal shipments for this WMS order
  const shipmentsResult: any = await db.execute(sql`
    SELECT id
    FROM wms.outbound_shipments
    WHERE order_id = ${wmsOrderId}
      AND status NOT IN ('cancelled', 'voided', 'returned', 'lost')
    ORDER BY id ASC
  `);
  const shipmentRows: Array<{ id: number }> = shipmentsResult?.rows ?? [];

  if (shipmentRows.length === 0) {
    return { hadShipments: false, cascadeResults: [] };
  }

  const cascadeResults: Array<{ shipmentId: number; mode: string; error?: string }> = [];
  for (const { id: shipmentId } of shipmentRows) {
    try {
      const result = await helpers.handleCustomerCancelOnShipment(db, shipmentId, {
        shipstation: opts.shipstation,
        now,
      });
      cascadeResults.push({ shipmentId, mode: result.mode });
    } catch (e: any) {
      console.error(
        `${logPrefix} handleCustomerCancelOnShipment failed for shipment ${shipmentId}: ${e.message}`,
      );
      cascadeResults.push({ shipmentId, mode: "error", error: e.message });
    }
  }

  // Roll up order status from cascaded shipment states
  let rollupChanged: boolean | undefined;
  try {
    const result = await helpers.recomputeOrderStatusFromShipments(db, wmsOrderId);
    rollupChanged = result.changed;
  } catch (e: any) {
    console.error(
      `${logPrefix} recomputeOrderStatusFromShipments failed for order ${wmsOrderId}: ${e.message}`,
    );
  }

  return { hadShipments: true, cascadeResults, rollupChanged };
}

/**
 * Full order cancellation cascade — single path used by orders/cancelled,
 * orders/updated (with cancelled_at), and the reconciliation sweep.
 *
 * Steps: release inventory reservations → cancel shipments (+ SS) →
 * cancel WMS order → log OMS event.
 */
export async function cancelOrderCascade(
  db: any,
  omsOrderId: number,
  opts: {
    wmsServices: WmsServices | null;
    shipStationService: ShipStationService | null;
    source: string;
    reason: string;
    logPrefix?: string;
  },
): Promise<{ cascadeDetails: Record<string, any> | undefined }> {
  const LOG = opts.logPrefix ?? "[CancelCascade]";
  const now = new Date();
  let cancelCascadeDetails: Record<string, any> | undefined;

  const wmsOrderResult = await db.execute<{ id: number }>(sql`
    SELECT id FROM wms.orders
    WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(omsOrderId)})
       OR (source = 'shopify' AND source_table_id = ${String(omsOrderId)})
  `);
  const wmsOrderRows = wmsOrderResult.rows ?? [];

  if (wmsOrderRows.length === 0) {
    return { cascadeDetails: { noWmsOrder: true } };
  }

  const rollupModule = await import("../orders/shipment-rollup");
  const { cancelOrder: cancelWmsOrder } = await import("../orders/order-status-core");

  const ssAdapter = opts.shipStationService
    ? {
        removeFromList: async (ssOrderId: number) => {
          try {
            await opts.shipStationService!.cancelOrder(ssOrderId);
          } catch (e: any) {
            console.error(`${LOG} SS cancel failed for ssOrderId=${ssOrderId}: ${e.message}`);
            throw e;
          }
        },
      }
    : undefined;

  for (const wmsRow of wmsOrderRows) {
    if (opts.wmsServices) {
      try {
        await opts.wmsServices.reservation.releaseOrderReservation(
          wmsRow.id,
          opts.source,
        );
        console.log(`${LOG} Released reservations for WMS order ${wmsRow.id}`);
      } catch (e: any) {
        console.error(`${LOG} Failed to release reservations for WMS ${wmsRow.id}: ${e.message}`);
        try {
          await db.insert(omsOrderEvents).values({
            orderId: omsOrderId,
            eventType: "cancel_release_failed",
            details: {
              wmsOrderId: wmsRow.id,
              error: e?.message ?? String(e),
              requiresReview: true,
            },
          });
        } catch (_dlErr) {}
      }
    }

    const cascade = await cascadeShopifyCancelToShipments(
      db,
      wmsRow.id,
      {
        handleCustomerCancelOnShipment: rollupModule.handleCustomerCancelOnShipment,
        recomputeOrderStatusFromShipments: rollupModule.recomputeOrderStatusFromShipments,
      },
      { now, shipstation: ssAdapter, logPrefix: LOG },
    );

    if (cascade.hadShipments) {
      cancelCascadeDetails = {
        wmsOrderId: wmsRow.id,
        shipmentOutcomes: cascade.cascadeResults,
        rollupChanged: cascade.rollupChanged,
      };
      console.log(`${LOG} cancel cascade for WMS ${wmsRow.id}: ${JSON.stringify(cascade.cascadeResults)}`);
    } else {
      await cancelWmsOrder(db, wmsRow.id, opts.source);
      cancelCascadeDetails = { wmsOrderId: wmsRow.id, noShipments: true };
    }
  }

  await db.insert(omsOrderEvents).values({
    orderId: omsOrderId,
    eventType: "cancelled",
    details: {
      source: opts.source,
      reason: opts.reason,
      cancelledAt: now.toISOString(),
      ...cancelCascadeDetails,
    },
  });

  return { cascadeDetails: cancelCascadeDetails };
}

/**
 * Apply a Shopify `refunds/create` payload as a return-record + optional
 * restock against the WMS side. C29 (Group F).
 *
 * Behavior:
 *  1. Validate payload has `id` (refund external id) and `order_id`.
 *     Malformed → throws `BadPayloadError` (caller maps to 400).
 *  2. Resolve OMS order. If not in OMS → outcome `order_not_tracked` (no DB writes).
 *  3. Resolve WMS order via `wms.orders.oms_fulfillment_order_id` /
 *     legacy `source_table_id`. If no WMS order → `wms_order_not_found`.
 *  4. Resolve most recent shipment for the WMS order. Per migration 062
 *     `wms.returns.shipment_id` is NOT NULL — if no shipment exists the
 *     return cannot be persisted; we return `no_shipment_to_associate`
 *     instead. (Capturing pre-shipment refunds is deferred to a later C
 *     once the schema accepts NULL shipment_id.)
 *  5. Idempotency: SELECT-then-INSERT keyed on `refund_external_id` for
 *     the same order. Duplicate → outcome `idempotent_skip`.
 *  6. Insert `wms.returns` row with `restocked` reflecting whether any
 *     refund line item carried `restock=true` or `restock_type='return'`.
 *  7. If `helpers.restock` is provided AND any line was flagged for
 *     restock, invoke it once with the refund context. Failures are
 *     logged but don't roll back the return record (C30 will add a
 *     formal retry queue for the restock leg).
 *
 * Pure of HTTP concerns: HMAC verification + 200 response + error → 500
 * mapping all live in the route handler. This helper just talks to db.
 *
 * Plan ref: shipstation-flow-refactor-plan.md §6 Commit 29.
 */
export class RefundsCreateBadPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundsCreateBadPayloadError";
  }
}

export type ApplyShopifyRefundCascadeOutcome =
  | "return_recorded"
  | "idempotent_skip"
  | "order_not_tracked"
  | "wms_order_not_found"
  | "no_shipment_to_associate";

export interface ApplyShopifyRefundCascadeResult {
  outcome: ApplyShopifyRefundCascadeOutcome;
  refundExternalId: string;
  omsOrderId?: number;
  wmsOrderId?: number;
  shipmentId?: number | null;
  restocked: boolean;
  restockInvoked: boolean;
  restockError?: string;
  adjustedLines?: number;
  cancelledShipments?: number;
  repushedShipments?: number;
  flaggedShipments?: number;
}

type ShopifyRefundLineAdjustment = {
  externalLineItemId: string;
  quantity: number;
  restockPolicy: "no_restock" | "return" | "restock" | "cancel" | "unknown";
  raw: any;
};

function normalizeRefundRestockPolicy(line: any): ShopifyRefundLineAdjustment["restockPolicy"] {
  const restockType = typeof line?.restock_type === "string" ? line.restock_type : null;
  if (restockType === "return") return "return";
  if (restockType === "restock") return "restock";
  if (restockType === "cancel") return "cancel";
  if (restockType === "no_restock") return "no_restock";
  if (line?.restock === true) return "restock";
  if (line?.restock === false) return "no_restock";
  return "unknown";
}

function extractRefundLineAdjustments(refundLineItems: Array<any>): ShopifyRefundLineAdjustment[] {
  const adjustments: ShopifyRefundLineAdjustment[] = [];
  for (const line of refundLineItems) {
    const rawExternalId = line?.line_item_id ?? line?.line_item?.id;
    const quantity = Number(line?.quantity ?? 0);
    if (rawExternalId === undefined || rawExternalId === null) continue;
    if (!Number.isInteger(quantity) || quantity <= 0) continue;
    adjustments.push({
      externalLineItemId: String(rawExternalId),
      quantity,
      restockPolicy: normalizeRefundRestockPolicy(line),
      raw: line,
    });
  }
  return adjustments;
}

async function persistRefundLineAdjustments(
  db: any,
  args: {
    omsOrderId: number;
    refundExternalId: string;
    reason: string | null;
    adjustments: ShopifyRefundLineAdjustment[];
  },
): Promise<number> {
  let inserted = 0;
  for (const adjustment of args.adjustments) {
    const result: any = await db.execute(sql`
      INSERT INTO oms.order_line_adjustments (
        order_id, order_line_id, external_line_item_id, source,
        source_event_id, adjustment_type, restock_policy, quantity,
        reason, raw_payload
      )
      SELECT
        ${args.omsOrderId},
        (
          SELECT id FROM oms.oms_order_lines
          WHERE order_id = ${args.omsOrderId}
            AND external_line_item_id = ${adjustment.externalLineItemId}
          LIMIT 1
        ),
        ${adjustment.externalLineItemId},
        'shopify_webhook',
        ${args.refundExternalId},
        'refund',
        ${adjustment.restockPolicy},
        ${adjustment.quantity},
        ${args.reason},
        ${JSON.stringify(adjustment.raw)}::jsonb
      ON CONFLICT (source, source_event_id, external_line_item_id, adjustment_type)
      DO NOTHING
      RETURNING id
    `);
    inserted += result?.rows?.length ?? 0;
  }
  return inserted;
}

async function applyRefundLineAdjustmentsToWms(
  db: any,
  args: {
    wmsOrderId: number;
    adjustments: ShopifyRefundLineAdjustment[];
    now: Date;
    shipstation?: { cancelOrder: (shipstationOrderId: number) => Promise<unknown> };
    shippingEngine?: { cancel: (ref: { engine: string; engineOrderRef: string; engineShipmentRef?: string }) => Promise<unknown> };
    // Re-push a shipment to the engine after its contents changed (reduced by a
    // partial refund). Wired from the route; if absent, the shipment is flagged.
    pushShipment?: (shipmentId: number) => Promise<unknown>;
  },
): Promise<{ adjustedLines: number; cancelledShipments: number; repushedShipments: number; flaggedShipments: number }> {
  let adjustedLines = 0;
  const affectedExternalIds = args.adjustments.map((a) => a.externalLineItemId);
  if (affectedExternalIds.length === 0) {
    return { adjustedLines, cancelledShipments: 0, repushedShipments: 0, flaggedShipments: 0 };
  }

  const quantityResult: any = await db.execute(sql`
    WITH matched_items AS (
      SELECT
        wi.id AS order_item_id,
        wi.quantity AS order_item_quantity,
        COALESCE(SUM(adj.quantity), 0)::int AS adjusted_quantity
      FROM wms.order_items wi
      JOIN oms.oms_order_lines ol ON ol.id = wi.oms_order_line_id
      LEFT JOIN oms.order_line_adjustments adj
        ON adj.order_line_id = ol.id
       AND adj.adjustment_type IN ('refund', 'cancel')
      WHERE wi.order_id = ${args.wmsOrderId}
        AND ol.external_line_item_id = ANY(ARRAY[${sql.join(affectedExternalIds, sql`, `)}]::text[])
      GROUP BY wi.id, wi.quantity
    ),
    updated_shipment_items AS (
      UPDATE wms.outbound_shipment_items si
      SET qty = GREATEST(0, mi.order_item_quantity - mi.adjusted_quantity)
      FROM matched_items mi
      WHERE si.order_item_id = mi.order_item_id
        AND si.shipment_id IN (
          SELECT os.id FROM wms.outbound_shipments os
          WHERE os.order_id = ${args.wmsOrderId}
            -- Reduce contents for all PRE-SHIP shipments (was 'planned' only) so
            -- the re-push / operator review reflects the true remaining items.
            AND os.status IN ('planned', 'queued', 'labeled')
        )
      RETURNING si.id
    )
    UPDATE wms.order_items wi
    SET status = CASE
          WHEN COALESCE(wi.picked_quantity, 0) = 0
           AND COALESCE(wi.fulfilled_quantity, 0) = 0
           AND mi.adjusted_quantity >= wi.quantity
          THEN 'cancelled'
          ELSE wi.status
        END
    FROM matched_items mi
    WHERE wi.id = mi.order_item_id
    RETURNING wi.id
  `);
  adjustedLines = quantityResult?.rows?.length ?? 0;

  // A refund is a PAYMENT state, not a fulfillment action. The line-item
  // quantities were just reduced above. Now reconcile each affected PRE-SHIP
  // shipment to physical reality — a refund NEVER "holds" a shipment:
  //   - empty (all its items refunded) -> cancel the shipment (+ cancel the SS order)
  //   - queued, items remain           -> re-push the SS order with the reduced contents
  //   - labeled, items remain          -> flag for review; an associate must physically
  //                                       find the printed-but-unshipped package and fix it
  //   - planned, items remain          -> nothing (qty already reduced; never pushed)
  // Shipped/terminal shipments are excluded (a refund after ship is payment-only; #659).
  const affectedResult: any = await db.execute(sql`
    SELECT os.id, os.status,
           os.shipping_engine, os.engine_order_ref, os.engine_shipment_ref,
           os.shipstation_order_id, os.shipstation_order_key,
           (SELECT COALESCE(SUM(x.qty), 0)::int
              FROM wms.outbound_shipment_items x
             WHERE x.shipment_id = os.id) AS remaining_qty
    FROM wms.outbound_shipments os
    WHERE os.order_id = ${args.wmsOrderId}
      AND os.status IN ('planned', 'queued', 'labeled')
      AND EXISTS (
        SELECT 1 FROM wms.outbound_shipment_items si
        JOIN wms.order_items wi ON wi.id = si.order_item_id
        JOIN oms.oms_order_lines ol ON ol.id = wi.oms_order_line_id
        WHERE si.shipment_id = os.id
          AND ol.external_line_item_id = ANY(ARRAY[${sql.join(affectedExternalIds, sql`, `)}]::text[])
      )
    ORDER BY os.id
  `);
  const affectedRows: Array<{
    id: number;
    status: string;
    shipping_engine: string | null;
    engine_order_ref: string | null;
    engine_shipment_ref: string | null;
    shipstation_order_id: number | null;
    shipstation_order_key: string | null;
    remaining_qty: number;
  }> = affectedResult?.rows ?? [];

  let cancelledShipments = 0;
  let repushedShipments = 0;
  let flaggedShipments = 0;

  const flagForReview = async (shipmentId: number, reason: string) => {
    await db.execute(sql`
      UPDATE wms.outbound_shipments
      SET requires_review = true, review_reason = ${reason}, updated_at = ${args.now}
      WHERE id = ${shipmentId}
    `);
  };

  const { markShipmentCancelled, recomputeOrderStatusFromShipments } =
    await import("../orders/shipment-rollup");

  for (const row of affectedRows) {
    try {
      if (row.remaining_qty <= 0) {
        // Nothing left to ship -> cancel the shipment. markShipmentCancelled
        // engine-cancels the SS order for queued/labeled/on_hold rows.
        await markShipmentCancelled(db, row.id, "refund_fully_cancelled", {
          now: args.now,
          engineCancel: args.shippingEngine
            ? async (ref: { engine: string; engineOrderRef: string; engineShipmentRef?: string }) => {
                await args.shippingEngine!.cancel(ref);
              }
            : undefined,
          shipstation: args.shipstation
            ? { removeFromList: async (ssId: number) => { await args.shipstation!.cancelOrder(ssId); } }
            : undefined,
        });
        cancelledShipments++;
      } else if (row.status === "queued") {
        // Pre-ship, no label: re-sync the SS order to the reduced contents.
        if (args.pushShipment) {
          await args.pushShipment(row.id);
          repushedShipments++;
        } else {
          await flagForReview(row.id, "refund_repush_unavailable");
          flaggedShipments++;
        }
      } else if (row.status === "labeled") {
        // A label was printed but the package has not shipped (no ship-notify):
        // an associate must physically find it and pull the item / re-label.
        await flagForReview(row.id, "refund_after_label");
        flaggedShipments++;
      }
      // planned + items remain: qty already reduced; nothing else to do.
    } catch (err: any) {
      console.error(
        `[applyRefundLineAdjustmentsToWms] reconcile failed for shipment ${row.id} ` +
          `(status=${row.status}, remaining=${row.remaining_qty}): ${err?.message ?? err}`,
      );
      try {
        await flagForReview(row.id, "refund_reconcile_failed");
        flaggedShipments++;
      } catch (flagErr: any) {
        console.error(
          `[applyRefundLineAdjustmentsToWms] could not even flag shipment ${row.id} for review: ${flagErr?.message ?? flagErr}`,
        );
      }
    }
  }

  // Cancels changed shipment statuses -> roll the order status up from them.
  if (cancelledShipments > 0) {
    try {
      await recomputeOrderStatusFromShipments(db, args.wmsOrderId, { now: args.now });
    } catch (err: any) {
      console.error(
        `[applyRefundLineAdjustmentsToWms] order recompute failed for ${args.wmsOrderId}: ${err?.message ?? err}`,
      );
    }
  }

  return { adjustedLines, cancelledShipments, repushedShipments, flaggedShipments };
}

export async function applyShopifyRefundCascade(
  db: any,
  refundPayload: any,
  helpers: {
    /**
     * Resolve OMS order id by shopify order id (numeric or GID) +
     * channel id. Returning `null` means the order is not tracked in
     * OMS — the cascade short-circuits with `order_not_tracked`.
     */
    resolveOmsOrder: (
      db: any,
      args: { shopifyOrderId: string | number; channelId: number },
    ) => Promise<{ id: number } | null>;
    /**
     * Optional restock hook. Called once per refund if any line item is
     * flagged for restock. Implementation owns the per-line fan-out.
     * Failures are caught + logged; they do not abort the return-record
     * insert.
     */
    restock?: (
      db: any,
      ctx: {
        wmsOrderId: number;
        omsOrderId: number;
        refundLineItems: Array<any>;
        refundPayload: any;
      },
    ) => Promise<void>;
    shipstation?: { cancelOrder: (shipstationOrderId: number) => Promise<unknown> };
    shippingEngine?: { cancel: (ref: { engine: string; engineOrderRef: string; engineShipmentRef?: string }) => Promise<unknown> };
    pushShipment?: (shipmentId: number) => Promise<unknown>;
  },
  opts: {
    channelId: number;
    now?: Date;
    logPrefix?: string;
  },
): Promise<ApplyShopifyRefundCascadeResult> {
  const logPrefix = opts.logPrefix ?? "[applyShopifyRefundCascade]";
  const now = opts.now ?? new Date();

  // ── 1. Validate payload ────────────────────────────────────────────
  if (!refundPayload || typeof refundPayload !== "object") {
    throw new RefundsCreateBadPayloadError("refund payload missing or not an object");
  }
  const refundExternalIdRaw = refundPayload.id;
  const shopifyOrderIdRaw = refundPayload.order_id;
  if (refundExternalIdRaw === undefined || refundExternalIdRaw === null) {
    throw new RefundsCreateBadPayloadError("refund payload missing `id`");
  }
  if (shopifyOrderIdRaw === undefined || shopifyOrderIdRaw === null) {
    throw new RefundsCreateBadPayloadError("refund payload missing `order_id`");
  }
  const refundExternalId = String(refundExternalIdRaw);

  const refundLineItems: Array<any> = Array.isArray(refundPayload.refund_line_items)
    ? refundPayload.refund_line_items
    : [];
  const restockLines = refundLineItems.filter(
    (li: any) =>
      li &&
      (li.restock === true || li.restock_type === "return" || li.restock_type === "restock"),
  );
  const anyRestock = restockLines.length > 0;
  const lineAdjustments = extractRefundLineAdjustments(refundLineItems);

  // ── 2. Resolve OMS order ───────────────────────────────────────────
  const oms = await helpers.resolveOmsOrder(db, {
    shopifyOrderId: shopifyOrderIdRaw,
    channelId: opts.channelId,
  });
  if (!oms) {
    return {
      outcome: "order_not_tracked",
      refundExternalId,
      restocked: false,
      restockInvoked: false,
    };
  }
  const omsOrderId = oms.id;

  // ── 3. Resolve WMS order ───────────────────────────────────────────
  const wmsOrderRes: any = await db.execute(sql`
    SELECT id FROM wms.orders
    WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(omsOrderId)})
       OR (source = 'shopify' AND source_table_id = ${String(omsOrderId)})
    LIMIT 1
  `);
  const wmsRows: Array<{ id: number }> = wmsOrderRes?.rows ?? [];
  if (wmsRows.length === 0) {
    return {
      outcome: "wms_order_not_found",
      refundExternalId,
      omsOrderId,
      restocked: false,
      restockInvoked: false,
    };
  }
  const wmsOrderId = wmsRows[0].id;

  const persistedAdjustments = await persistRefundLineAdjustments(db, {
    omsOrderId,
    refundExternalId,
    reason: (refundPayload.note as string | undefined) ?? "shopify_refund",
    adjustments: lineAdjustments,
  });
  const wmsAdjustmentResult = await applyRefundLineAdjustmentsToWms(db, {
    wmsOrderId,
    adjustments: lineAdjustments,
    now,
    shipstation: helpers.shipstation,
    shippingEngine: helpers.shippingEngine,
    pushShipment: helpers.pushShipment,
  });

  // ── 5. Idempotency check (do this before shipment resolution to
  //    short-circuit cleanly on retries even if the order has since
  //    been shipped) ─────────────────────────────────────────────────
  const existingRes: any = await db.execute(sql`
    SELECT id FROM wms.returns
    WHERE refund_external_id = ${refundExternalId}
      AND order_id = ${wmsOrderId}
    LIMIT 1
  `);
  if ((existingRes?.rows?.length ?? 0) > 0) {
    return {
      outcome: "idempotent_skip",
      refundExternalId,
      omsOrderId,
      wmsOrderId,
      restocked: false,
      restockInvoked: false,
      adjustedLines: persistedAdjustments + wmsAdjustmentResult.adjustedLines,
      cancelledShipments: wmsAdjustmentResult.cancelledShipments,
      repushedShipments: wmsAdjustmentResult.repushedShipments,
      flaggedShipments: wmsAdjustmentResult.flaggedShipments,
    };
  }

  // ── 4. Resolve most-recent shipment ────────────────────────────────
  const shipmentRes: any = await db.execute(sql`
    SELECT id FROM wms.outbound_shipments
    WHERE order_id = ${wmsOrderId}
    ORDER BY id DESC
    LIMIT 1
  `);
  const shipmentRows: Array<{ id: number }> = shipmentRes?.rows ?? [];
  if (shipmentRows.length === 0) {
    // Schema requires a NOT NULL shipment_id, so we cannot persist a
    // return row without one. Surface as a distinct outcome so the
    // route handler can log + leave Shopify happy.
    console.warn(
      `${logPrefix} no shipment found for wmsOrder=${wmsOrderId}; cannot persist return ` +
        `row (refund_external_id=${refundExternalId}). schema requires shipment_id NOT NULL.`,
    );
    return {
      outcome: "no_shipment_to_associate",
      refundExternalId,
      omsOrderId,
      wmsOrderId,
      shipmentId: null,
      restocked: false,
      restockInvoked: false,
    };
  }
  const shipmentId = shipmentRows[0].id;

  // ── 6. Insert wms.returns row ──────────────────────────────────────
  const reason = (refundPayload.note as string | undefined) ?? "shopify_refund";
  const notes = (refundPayload.note as string | undefined) ?? null;
  const refundedAt = refundPayload.processed_at
    ? new Date(refundPayload.processed_at)
    : now;
  const source = "shopify_webhook";

  const returnInsertRes: any = await db.execute(sql`
    INSERT INTO wms.returns (
      shipment_id, order_id, source, reason,
      refund_external_id, restocked, status,
      received_at, refunded_at, notes
    ) VALUES (
      ${shipmentId}, ${wmsOrderId}, ${source}, ${reason},
      ${refundExternalId}, ${anyRestock}, ${anyRestock ? "expected" : "closed"},
      NULL, ${refundedAt}, ${notes}
    )
    RETURNING id
  `);
  const returnId: number | undefined = returnInsertRes?.rows?.[0]?.id;

  // Open per-line "expected" return rows for lines the channel flagged for restock
  // (restock_type=return/restock). These await physical receipt; the return-to-stock
  // path (ReturnsService.processReturn) reconciles received_qty and restocks on-hand.
  // cancel/no_restock lines get no return_items (no physical return expected).
  const returnAdjustments = lineAdjustments.filter(
    (a) => a.restockPolicy === "return" || a.restockPolicy === "restock",
  );
  if (returnId != null && returnAdjustments.length > 0) {
    const returnItemRows = returnAdjustments.map((a) => ({
      ext_id: a.externalLineItemId,
      qty: a.quantity,
      policy: a.restockPolicy,
      loc: a.raw?.location_id != null ? String(a.raw.location_id) : null,
    }));
    await db.execute(sql`
      INSERT INTO wms.return_items
        (return_id, order_item_id, oms_order_line_id, external_line_item_id, sku, expected_qty, restock_policy, location_id, status)
      SELECT ${returnId}, wi.id, wi.oms_order_line_id, x.ext_id, wi.sku, x.qty, x.policy, x.loc, 'expected'
      FROM jsonb_to_recordset(${JSON.stringify(returnItemRows)}::jsonb) AS x(ext_id text, qty int, policy text, loc text)
      LEFT JOIN oms.oms_order_lines ol ON ol.external_line_item_id = x.ext_id AND ol.order_id = ${omsOrderId}
      LEFT JOIN wms.order_items wi ON wi.oms_order_line_id = ol.id AND wi.order_id = ${wmsOrderId}
    `);
  }

  // ── 7. Conditional restock ────────────────────────────────────────
  let restockInvoked = false;
  let restockError: string | undefined;
  if (anyRestock && helpers.restock) {
    restockInvoked = true;
    try {
      await helpers.restock(db, {
        wmsOrderId,
        omsOrderId,
        refundLineItems: restockLines,
        refundPayload,
      });
    } catch (e: any) {
      restockError = e?.message || String(e);
      console.error(
        `${logPrefix} restock helper failed for wmsOrder=${wmsOrderId} ` +
          `(refund_external_id=${refundExternalId}): ${restockError}`,
      );
      // D-REFUNDREL: Persist dead-letter so ops can find unreleased inventory.
      try {
        await db.insert(omsOrderEvents).values({
          orderId: omsOrderId,
          eventType: "refund_restock_failed",
          details: {
            wmsOrderId,
            refundExternalId,
            error: restockError,
            requiresReview: true,
          },
        });
      } catch (_dlErr) {
        // Structured log above is our trace
      }
    }
  }

  return {
    outcome: "return_recorded",
    refundExternalId,
    omsOrderId,
    wmsOrderId,
    shipmentId,
    restocked: anyRestock,
    restockInvoked,
    restockError,
    adjustedLines: persistedAdjustments + wmsAdjustmentResult.adjustedLines,
    cancelledShipments: wmsAdjustmentResult.cancelledShipments,
    repushedShipments: wmsAdjustmentResult.repushedShipments,
    flaggedShipments: wmsAdjustmentResult.flaggedShipments,
  };
}

/**
 * Decide, on a Shopify orders/updated webhook, whether the order is being
 * cancelled by the channel vs merely already-terminal on our side.
 *
 * `cancelNow` (drives cancelOrderCascade) is derived ONLY from the Shopify
 * payload — cancelled_at, or a refunded/voided financial_status. It must NEVER
 * depend on our own existing OMS status: doing so created a self-perpetuating
 * loop where an order wrongly cancelled by another path got RE-cancelled by
 * every subsequent orders/updated webhook (#57977 accumulated 8 cascades on a
 * paid+fulfilled order).
 *
 * `isFinal` (drives the reconcile / address-change SKIPS) still treats an
 * already-terminal OMS order as final so a routine update doesn't re-activate a
 * genuinely-cancelled order — but it does not trigger the cancel cascade.
 *
 * Pure: no DB, no network. Exported via __test__.
 */
export function deriveOmsUpdateFinality(
  payload: { cancelled_at?: unknown; financial_status?: string | null },
  existingStatus: string | null | undefined,
): { cancelNow: boolean; isFinal: boolean } {
  const cancelNow =
    Boolean(payload.cancelled_at) ||
    payload.financial_status === "refunded" ||
    payload.financial_status === "voided";
  const isFinal =
    cancelNow || existingStatus === "cancelled" || existingStatus === "refunded";
  return { cancelNow, isFinal };
}

export const __test__ = {
  extractShopifyRisk,
  cascadeShopifyCancelToShipments,
  applyShopifyRefundCascade,
  applyRefundLineAdjustmentsToWms,
  extractRefundLineAdjustments,
  RefundsCreateBadPayloadError,
  mapShopifyLineFulfillmentStatus,
  deriveOmsUpdateFinality,
};

function mapShopifyOrderToOrderData(shopifyOrder: any): OrderData {
  const shipping = shopifyOrder.shipping_address || {};
  const customer = shopifyOrder.customer || {};

  // Use normalizer to extract line items with full discount splitting
  const discountApplications = shopifyOrder.discount_applications || [];
  const normalizedItems = normalizeShopifyLineItems(
    shopifyOrder.line_items || [], 
    discountApplications,
    shopifyOrder.order_number
  );

  const lineItems: LineItemData[] = normalizedItems.map((item) => ({
    externalLineItemId: item.externalLineItemId,
    externalProductId: item.externalProductId,
    sku: item.sku,
    title: item.title,
    variantTitle: item.variantTitle,
    quantity: item.quantity,
    paidPriceCents: item.paidPriceCents,
    totalCents: item.totalCents,
    taxCents: 0, // Tax handled at order level
    discountCents: item.discountCents,
    requiresShipping: item.requiresShipping,
  }));

  // Financial status
  let financialStatus = shopifyOrder.financial_status || "paid";

  // Fulfillment status
  let fulfillmentStatus = shopifyOrder.fulfillment_status || "unfulfilled";

  // OMS status
  let status = "pending";
  if (shopifyOrder.cancelled_at) {
    status = "cancelled";
  } else if (fulfillmentStatus === "fulfilled") {
    status = "shipped";
  } else if (financialStatus === "paid" || financialStatus === "partially_paid") {
    status = "confirmed";
  }

  const customerName =
    shipping.name ||
    `${customer.first_name || ""} ${customer.last_name || ""}`.trim() ||
    shopifyOrder.name;

  // C22b — capture fraud risk from the webhook payload (§6 Group E D3).
  // Defensive: if no risk data is present we leave all fields null.
  const risk = extractShopifyRisk(shopifyOrder);

  return {
    externalOrderNumber: shopifyOrder.name || shopifyOrder.order_number?.toString(),
    status,
    financialStatus,
    fulfillmentStatus,
    riskLevel: risk.riskLevel,
    riskScore: risk.riskScore,
    riskRecommendation: risk.riskRecommendation,
    riskFacts: risk.riskFacts,
    customerName,
    customerEmail: shopifyOrder.email || customer.email,
    customerPhone: shipping.phone || customer.phone,
    // Channel-agnostic customer id — for Shopify this is the Shopify customer id.
    externalCustomerId: customer.id != null ? String(customer.id) : undefined,
    shipToName: shipping.name,
    shipToCompany: shipping.company || null,
    shipToAddress1: shipping.address1,
    shipToAddress2: shipping.address2,
    shipToCity: shipping.city,
    shipToState: shipping.province_code || shipping.province,
    shipToZip: shipping.zip,
    shipToCountry: shipping.country_code || shipping.country,
    shippingMethod: shopifyOrder.shipping_lines?.[0]?.title || null,
    shippingMethodCode: shopifyOrder.shipping_lines?.[0]?.code || null,
    // Card Shellz only offers 'standard' today. When expedited/overnight
    // tiers launch, map from shipping_lines[0].code here.
    shippingServiceLevel: "standard" as const,
    subtotalCents: dollarsToCents(shopifyOrder.subtotal_price),
    shippingCents: (shopifyOrder.shipping_lines || []).reduce(
      (sum: number, s: any) => sum + dollarsToCents(s.price), 0
    ),
    taxCents: dollarsToCents(shopifyOrder.total_tax),
    discountCents: dollarsToCents(shopifyOrder.total_discounts),
    totalCents: dollarsToCents(shopifyOrder.total_price),
    currency: shopifyOrder.currency || "USD",
    rawPayload: shopifyOrder,
    notes: shopifyOrder.note || undefined,
    tags: shopifyOrder.tags ? shopifyOrder.tags.split(",").map((t: string) => t.trim()) : undefined,
    orderedAt: shopifyOrder.created_at ? new Date(shopifyOrder.created_at) : new Date(),
    lineItems,
  };
}

function mapShopifyLineFulfillmentStatus(
  lineItem: any,
  orderFulfillmentStatus?: string | null,
): "fulfilled" | "partial" | "unfulfilled" {
  const rawStatus = String(lineItem?.fulfillment_status ?? "").trim().toLowerCase();
  if (rawStatus === "fulfilled") return "fulfilled";
  if (rawStatus === "partial" || rawStatus === "partially_fulfilled") return "partial";
  if (rawStatus === "unfulfilled") return "unfulfilled";

  const rawOrderStatus = String(orderFulfillmentStatus ?? "").trim().toLowerCase();
  const fulfillableQuantity = Number(lineItem?.fulfillable_quantity);
  if (
    rawOrderStatus === "fulfilled" &&
    Number.isFinite(fulfillableQuantity) &&
    fulfillableQuantity <= 0
  ) {
    return "fulfilled";
  }

  return "unfulfilled";
}

// ---------------------------------------------------------------------------
/**
 * Return the numeric Shopify order ID from a webhook payload, stripping
 * the GID prefix if present.
 *
 * Background: the shopify-bridge path uses numeric format
 * (shopify_orders.id) and OMS's (channel_id, external_order_id) unique
 * constraint depends on consistent format. If we store GID here and
 * numeric there, we get duplicate OMS rows for the same Shopify order
 * (~470 historical dupes pre-fix).
 *
 * Plan ref: post-refactor C39 fix.
 */
export function getExternalOrderId(shopifyOrder: any): string {
  const raw = shopifyOrder?.admin_graphql_api_id || shopifyOrder?.id;
  if (raw === undefined || raw === null) {
    throw new Error("getExternalOrderId: missing admin_graphql_api_id and id on payload");
  }
  const s = String(raw).trim();
  const PREFIX = "gid://shopify/Order/";
  if (s.startsWith(PREFIX)) {
    return s.substring(PREFIX.length);
  }
  return s;
}

type CanonicalShipTo = {
  name: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
};

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function canonicalShipToFromShopifyUpdate(shopifyOrder: any, existing: any): CanonicalShipTo {
  const shipping = shopifyOrder?.shipping_address && typeof shopifyOrder.shipping_address === "object"
    ? shopifyOrder.shipping_address
    : {};
  const customerName =
    `${shopifyOrder?.customer?.first_name || ""} ${shopifyOrder?.customer?.last_name || ""}`.trim();

  return {
    name: cleanString(shipping.name) || cleanString(customerName) || existing.shipToName || existing.customerName || null,
    company: nullableString(shipping.company) ?? existing.shipToCompany ?? null,
    address1: cleanString(shipping.address1) || existing.shipToAddress1 || null,
    address2: nullableString(shipping.address2) ?? existing.shipToAddress2 ?? null,
    city: cleanString(shipping.city) || existing.shipToCity || null,
    state: cleanString(shipping.province_code) || cleanString(shipping.province) || existing.shipToState || null,
    zip: cleanString(shipping.zip) || existing.shipToZip || null,
    country: cleanString(shipping.country_code) || cleanString(shipping.country) || existing.shipToCountry || null,
  };
}

function differentNullable(a: unknown, b: unknown): boolean {
  // Normalize so only a MATERIAL change registers: treat null/undefined/"" as equal,
  // trim, and case-fold. A raw !== flagged null-vs-empty (blank company/address2),
  // case, and whitespace as "changed" — the source of the false-positive
  // address-change reviews (≈93% of them were blank-field mismatches).
  const norm = (x: unknown) => String(x ?? "").trim().toLowerCase();
  return norm(a) !== norm(b);
}

function wmsAddressChanged(row: any, next: CanonicalShipTo): boolean {
  return (
    differentNullable(row.shipping_name, next.name) ||
    differentNullable(row.shipping_company, next.company) ||
    differentNullable(row.shipping_address, next.address1) ||
    differentNullable(row.shipping_address2, next.address2) ||
    differentNullable(row.shipping_city, next.city) ||
    differentNullable(row.shipping_state, next.state) ||
    differentNullable(row.shipping_postal_code, next.zip) ||
    differentNullable(row.shipping_country, next.country)
  );
}

// Register Webhook Routes
// ---------------------------------------------------------------------------
//
// §6 C9b: legacy `createWmsOrderFromShopify` direct-write helper was
// deleted. Shopify → WMS now goes exclusively through
// wmsSyncService.syncOmsOrderToWms. If wmsSyncService is unwired the
// webhook handlers throw loudly so the missing wiring is diagnosable.

export function registerOmsWebhooks(
  app: Express,
  omsService: OmsService,
  wmsServices: WmsServices | null,
  shipStationService: ShipStationService | null,
  wmsSyncService?: any, // WmsSyncService - will be set from server/index.ts
  shippingEngine?: { cancel: (ref: { engine: string; engineOrderRef: string; engineShipmentRef?: string }) => Promise<unknown> } | null,
) {
  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // Limit each IP to 100 webhook requests per `window`
    message: "Too many webhooks from this IP, please try again later",
    standardHeaders: true,
    legacyHeaders: false,
  });

  // C22b — lazily create a single default Shopify Admin GraphQL client
  // for FO ID population at ingest. Lazy because tests don't need it and
  // because the env may not be wired at module-load time.
  let _shopifyAdminClient: ShopifyAdminGraphQLClient | null = null;
  function getShopifyAdminClient(): ShopifyAdminGraphQLClient {
    if (_shopifyAdminClient === null) {
      _shopifyAdminClient = createDefaultShopifyAdminClient();
    }
    return _shopifyAdminClient;
  }

  // Helper: verify HMAC using rawBody from express.json verify callback, return parsed body or null
  function verifyAndParse(req: Request, res: Response): any | null {
    const hmac = req.headers["x-shopify-hmac-sha256"] as string | undefined;
    // rawBody is set by the global express.json({ verify }) middleware
    const rawBody = (req as any).rawBody as Buffer | undefined;

    // Allow internal worker bypass
    if (req.headers["x-internal-retry"] === process.env.SESSION_SECRET) {
      return req.body;
    }

    if (!rawBody || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      console.warn(`${LOG_PREFIX} Empty or missing rawBody`);
      res.status(200).send("ok"); // Return 200 to prevent retries
      return null;
    }

    if (rawBody && !verifyShopifyHmac(rawBody as Buffer, hmac)) {
      const s = process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_WEBHOOK_SECRET;
      if (s) {
        const computed = crypto.createHmac("sha256", s).update(rawBody as Buffer).digest("base64");
        console.warn(`${LOG_PREFIX} HMAC debug: expected=${computed.substring(0,20)}... got=${(hmac||"").substring(0,20)}... secret_len=${s.length} body_len=${(rawBody as Buffer).length} rawBody_type=${typeof rawBody} is_buffer=${Buffer.isBuffer(rawBody)}`);
      }
      console.warn(`${LOG_PREFIX} HMAC verification failed`);
      res.status(401).send("Unauthorized");
      return null;
    }

    // Body is already parsed by express.json()
    if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
      return req.body;
    }

    // Fallback: parse from raw
    try {
      return JSON.parse(rawBody.toString("utf8"));
    } catch (err) {
      console.error(`${LOG_PREFIX} JSON parse failed:`, err);
      res.status(200).send("ok");
      return null;
    }
  }


  function isInternalRetry(req: Request): boolean {
    return req.headers["x-internal-retry"] === process.env.SESSION_SECRET;
  }

  function acknowledgeAccepted(req: Request, res: Response): void {
    if (!isInternalRetry(req)) {
      res.status(200).send("ok");
    }
  }

  function acknowledgeProcessed(_req: Request, res: Response): void {
    if (!res.headersSent) {
      res.status(200).send("ok");
    }
  }

  async function handleProcessingFailure(
    req: Request,
    res: Response,
    args: { provider: string; topic: string; payload: any; error: any; sourceInboxId: number },
  ): Promise<void> {
    if (isInternalRetry(req)) {
      if (!res.headersSent) {
        res.status(500).send(args.error?.message || "webhook retry failed");
      }
      return;
    }

    // sourceInboxId links the retry row back to its webhook_inbox row so the
    // retry worker can mirror the terminal outcome (succeeded/dead) onto the
    // inbox. Without it, the inbox row stays 'failed' forever even after a
    // successful retry, and ops dashboards report a permanent false positive.
    await db.insert(webhookRetryQueue).values({
      provider: args.provider,
      topic: args.topic,
      payload: args.payload,
      sourceInboxId: args.sourceInboxId,
      lastError: args.error?.message || String(args.error),
    });
  }

  async function handleWmsAddressChange(
    wmsOrderId: number,
    now: Date,
    label: string,
  ): Promise<void> {
    const shipmentResult: any = await db.execute(sql`
      SELECT id
      FROM wms.outbound_shipments
      WHERE order_id = ${wmsOrderId}
        AND status NOT IN ('cancelled', 'voided', 'returned', 'lost', 'on_hold')
      ORDER BY id
    `);
    const shipments: Array<{ id: number }> = shipmentResult?.rows ?? [];
    if (shipments.length === 0) return;

    const rollupModule = await import("../orders/shipment-rollup");
    for (const shipment of shipments) {
      const result = await rollupModule.handleAddressChangeOnShipment(db, shipment.id, { now });
      if (result.mode !== "can_repush") {
        console.log(
          `${LOG_PREFIX} address change for ${label} shipment ${shipment.id}: ${result.mode}`,
        );
        continue;
      }

      if (shipStationService?.isConfigured() && typeof shipStationService.pushShipment === "function") {
        try {
          await shipStationService.pushShipment(shipment.id);
          console.log(
            `${LOG_PREFIX} re-pushed shipment ${shipment.id} after address change for ${label}`,
          );
        } catch (err: any) {
          await enqueueShipStationShipmentPushRetry(
            db,
            shipment.id,
            err instanceof Error ? err : new Error(err?.message ?? String(err)),
          );
        }
      } else {
        await enqueueShipStationShipmentPushRetry(
          db,
          shipment.id,
          new Error(`address changed for ${label}; ShipStation push unavailable`),
        );
      }
    }
  }

  async function receiveShopifyWebhook(
    req: Request,
    res: Response,
    topic: string,
    payload: any,
  ): Promise<{ receipt: WebhookInboxReceipt; shouldProcess: boolean } | null> {
    try {
      const receipt = await recordWebhookReceived(
        db,
        buildShopifyWebhookInboxInput(req, topic, payload),
      );

      if (!receipt.inserted && receipt.status === "succeeded") {
        console.log(`${LOG_PREFIX} ${topic} duplicate already succeeded (inbox=${receipt.id}), skipping`);
        acknowledgeProcessed(req, res);
        return { receipt, shouldProcess: false };
      }

      if (!receipt.inserted && receipt.status === "processing" && !isInternalRetry(req)) {
        console.log(`${LOG_PREFIX} ${topic} duplicate already processing (inbox=${receipt.id}), skipping`);
        acknowledgeProcessed(req, res);
        return { receipt, shouldProcess: false };
      }

      await markWebhookProcessing(db, receipt.id);
      return { receipt, shouldProcess: true };
    } catch (err: any) {
      console.error(`${LOG_PREFIX} ${topic} inbox write failed: ${err?.message ?? String(err)}`);
      if (!res.headersSent) {
        res.status(500).send("webhook inbox unavailable");
      }
      return null;
    }
  }

  async function markInboxSucceeded(receipt: WebhookInboxReceipt): Promise<void> {
    await markWebhookSucceeded(db, receipt.id);
  }

  async function markInboxFailed(receipt: WebhookInboxReceipt, err: any): Promise<void> {
    try {
      await markWebhookFailed(db, receipt.id, err);
    } catch (markErr: any) {
      console.error(
        `${LOG_PREFIX} failed to mark webhook inbox ${receipt.id} failed: ${markErr?.message ?? String(markErr)}`,
      );
    }
  }



  // Helper: Get dynamic Channel ID
  async function getChannelId(req: Request, shopifyOrder?: any): Promise<number | null> {
    const domain = (req.headers["x-shopify-shop-domain"] as string) || (shopifyOrder && shopifyOrder.shop_domain) || "";
    if (!domain) return null;

    const [conn] = await db
      .select({ channelId: channelConnections.channelId })
      .from(channelConnections)
      .where(ilike(channelConnections.shopDomain, `%${domain}%`))
      .limit(1);

    return conn ? conn.channelId : null;
  }

  // =========================================================================
  // 1. POST /api/oms/webhooks/orders/paid
  // =========================================================================
  app.post("/api/oms/webhooks/orders/paid", webhookLimiter, async (req: Request, res: Response) => {
    const shopifyOrder = verifyAndParse(req, res);
    if (!shopifyOrder) return;

    // Persist before ACK so Shopify can retry if the durable inbox is down.
    const inbox = await receiveShopifyWebhook(req, res, "orders/paid", shopifyOrder);
    if (!inbox || !inbox.shouldProcess) return;

    acknowledgeAccepted(req, res);

    const externalOrderId = getExternalOrderId(shopifyOrder);
    console.log(`${LOG_PREFIX} orders/paid → ${shopifyOrder.name || externalOrderId}`);

    try {
      const channelId = await getChannelId(req, shopifyOrder);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Dedup: check OMS first
      const orderData = mapShopifyOrderToOrderData(shopifyOrder);
      const omsOrder = await omsService.ingestOrder(channelId, externalOrderId, orderData);

      // Check if newly created (within last 5 seconds)
      const isNew = omsOrder.createdAt && (Date.now() - new Date(omsOrder.createdAt).getTime()) < 5000;
      if (!isNew) {
        console.log(`${LOG_PREFIX} Order ${shopifyOrder.name} already exists in OMS (id=${omsOrder.id}), ensuring routing`);
      }

      // Enrich with member tier (non-blocking, logs errors)
      if (isNew) {
        enrichOrderWithMemberTier(omsOrder.id, omsOrder.customerEmail || '').catch(err => {
          console.error(`${LOG_PREFIX} Member tier enrichment failed:`, err);
        });
      }

      // Sync to WMS via sync service. §6 C9b: legacy
      // createWmsOrderFromShopify fallback removed (unreachable in
      // prod per Overlord Q2 decision). If wmsSyncService is absent
      // we fail loudly so the missing wiring is diagnosable.
      if (!wmsSyncService) {
        throw new Error("wmsSyncService required; legacy createWmsOrderFromShopify fallback removed (§6 C9b)");
      }
      await ensureOmsOrderQueuedForWmsSync(
        wmsSyncService,
        omsOrder.id,
        shopifyOrder.name || externalOrderId,
      );

      // OMS-level reservation (delegates to WMS reservation service).
      // A near-simultaneous orders/updated webhook can create the OMS order
      // before orders/paid finishes. In that case, do not treat "already
      // exists" as routed; if no warehouse is assigned yet, finish the paid
      // routing path now.
      if (!omsOrder.warehouseId) {
        try {
          await omsService.reserveInventory(omsOrder.id);
          await omsService.assignWarehouse(omsOrder.id);
        } catch (e: any) {
          console.error(`${LOG_PREFIX} Post-ingest processing failed for ${shopifyOrder.name}: ${e.message}`);
        }
      } else {
        console.log(`${LOG_PREFIX} Order ${shopifyOrder.name} already has warehouse_id=${omsOrder.warehouseId}`);
      }

      // The post-ingest reservation / warehouse assignment path changes
      // the exact state WMS needs. Run the idempotent sync once more and
      // persist a retry if it cannot create/find the WMS order. This is the
      // hard guarantee against OMS orders getting stuck after assignment
      // with no WMS row and no retry handle.
      await ensureOmsOrderQueuedForWmsSync(
        wmsSyncService,
        omsOrder.id,
        shopifyOrder.name || externalOrderId,
      );

      // C22b — populate Shopify fulfillment-order line item IDs at ingest
      // (§6 Group E D2/D4). Failure is non-fatal: C22c's Path B fallback
      // re-resolves at push time. We swallow errors here so a Shopify GQL
      // hiccup doesn't block ingestion of an otherwise good order.
      try {
        const externalGid = String(
          shopifyOrder.admin_graphql_api_id ??
            (shopifyOrder.id ? `gid://shopify/Order/${shopifyOrder.id}` : externalOrderId),
        );
        const summary = await (omsService as any).populateShopifyFulfillmentOrderIds?.(
          omsOrder.id,
          externalGid,
          getShopifyAdminClient(),
        );
        if (summary) {
          console.log(
            `${LOG_PREFIX} FO IDs populated for ${shopifyOrder.name}: matched=${summary.matched} unmatched=${summary.unmatched} updates=${summary.updates}`,
          );
        }
      } catch (err: any) {
        console.error(
          `${LOG_PREFIX} populateShopifyFulfillmentOrderIds failed for ${shopifyOrder.name}: ${err?.message ?? String(err)} (non-fatal; Path B fallback will retry at push)`,
        );
      }

      console.log(`${LOG_PREFIX} ✅ Processed ${isNew ? "new" : "existing"} order ${shopifyOrder.name} (OMS id=${omsOrder.id})`);
      if (isNew) {
        pushToMissionControl(omsOrder.id, "order.created");
      }
      
      // M18: Trigger real-time backfill bridge
      await db.execute(sql`NOTIFY shopify_order_ingested`);
      await markInboxSucceeded(inbox.receipt);
      acknowledgeProcessed(req, res);
    } catch (err: any) {
      console.error(`${LOG_PREFIX} orders/paid error for ${shopifyOrder.name}: ${err.message}`);
      await markInboxFailed(inbox.receipt, err);
      await handleProcessingFailure(req, res, {
        provider: "shopify",
        topic: "orders/paid",
        payload: shopifyOrder,
        error: err,
        sourceInboxId: inbox.receipt.id,
      });
    }
  });

  // =========================================================================
  // 2. POST /api/oms/webhooks/orders/updated
  // =========================================================================
  app.post("/api/oms/webhooks/orders/updated", webhookLimiter, async (req: Request, res: Response) => {
    const shopifyOrder = verifyAndParse(req, res);
    if (!shopifyOrder) return;

    const inbox = await receiveShopifyWebhook(req, res, "orders/updated", shopifyOrder);
    if (!inbox || !inbox.shouldProcess) return;

    acknowledgeAccepted(req, res);

    const externalOrderId = getExternalOrderId(shopifyOrder);
    console.log(`${LOG_PREFIX} orders/updated → ${shopifyOrder.name || externalOrderId}`);

    try {
      const channelId = await getChannelId(req, shopifyOrder);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Find or create existing OMS order via ingestOrder (UPSERT behavior)
      const orderData = mapShopifyOrderToOrderData(shopifyOrder);
      const existing = await omsService.ingestOrder(channelId, externalOrderId, orderData);


      const nextShipTo = canonicalShipToFromShopifyUpdate(shopifyOrder, existing);
      const now = new Date();
      const isCancelledPayload = Boolean(shopifyOrder.cancelled_at);
      // cancelNow (channel truth) drives the cancel cascade; isFinalOmsState
      // (includes our existing terminal status) drives only the reconcile/
      // address-change skips. See deriveOmsUpdateFinality for why cancelNow must
      // never read existing.status (self-perpetuating re-cancel loop, #57977).
      const { cancelNow: isCancelledByChannel, isFinal: isFinalOmsState } =
        deriveOmsUpdateFinality(shopifyOrder, existing.status);

      // Update OMS order fields
      await db
        .update(omsOrders)
        .set({
          ...(isCancelledPayload
            ? {
                status: "cancelled",
                cancelledAt: shopifyOrder.cancelled_at
                  ? new Date(shopifyOrder.cancelled_at)
                  : now,
              }
            : {}),
          financialStatus: shopifyOrder.financial_status || existing.financialStatus,
          fulfillmentStatus: shopifyOrder.fulfillment_status || existing.fulfillmentStatus,
          customerName:
            nextShipTo.name ||
            `${shopifyOrder.customer?.first_name || ""} ${shopifyOrder.customer?.last_name || ""}`.trim() ||
            existing.customerName,
          customerEmail: shopifyOrder.email || existing.customerEmail,
          shipToName: nextShipTo.name,
          shipToCompany: nextShipTo.company,
          shipToAddress1: nextShipTo.address1,
          shipToAddress2: nextShipTo.address2,
          shipToCity: nextShipTo.city,
          shipToState: nextShipTo.state,
          shipToZip: nextShipTo.zip,
          shipToCountry: nextShipTo.country,
          notes: shopifyOrder.note ?? existing.notes,
          rawPayload: shopifyOrder as any,
          updatedAt: now,
        })
        .where(eq(omsOrders.id, existing.id));

      const wmsOrders = await db.execute<{
        id: number;
        shipping_name: string | null;
        shipping_company: string | null;
        shipping_address: string | null;
        shipping_address2: string | null;
        shipping_city: string | null;
        shipping_state: string | null;
        shipping_postal_code: string | null;
        shipping_country: string | null;
      }>(sql`
        SELECT
          id,
          shipping_name,
          shipping_company,
          shipping_address,
          shipping_address2,
          shipping_city,
          shipping_state,
          shipping_postal_code,
          shipping_country
        FROM wms.orders
        WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(existing.id)})
           OR (source = 'shopify' AND source_table_id = ${String(existing.id)})
      `);
      const wmsOrderRows = wmsOrders.rows;

      if (wmsOrderRows.length > 0) {
        const isPaidNow = shopifyOrder.financial_status === "paid" || shopifyOrder.financial_status === "partially_paid";
        await db.execute(sql`
          UPDATE wms.orders SET
            shipping_name = ${nextShipTo.name},
            shipping_company = ${nextShipTo.company},
            shipping_address = ${nextShipTo.address1},
            shipping_address2 = ${nextShipTo.address2},
            shipping_city = ${nextShipTo.city},
            shipping_state = ${nextShipTo.state},
            shipping_postal_code = ${nextShipTo.zip},
            shipping_country = ${nextShipTo.country || "US"},
            financial_status = ${shopifyOrder.financial_status || "paid"},
            warehouse_status = CASE
              WHEN warehouse_status = 'pending' AND ${isPaidNow} THEN 'ready'
              ELSE warehouse_status
            END,
            customer_name = ${nextShipTo.name || existing.customerName || null},
            customer_email = ${shopifyOrder.email || existing.customerEmail || null}
          WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(existing.id)})
             OR (source = 'shopify' AND source_table_id = ${String(existing.id)})
        `);

        if (isCancelledByChannel) {
          await cancelOrderCascade(db, existing.id, {
            wmsServices,
            shipStationService,
            source: "shopify_order_update_final",
            reason: shopifyOrder.cancel_reason || "order_updated_final_state",
            logPrefix: LOG_PREFIX,
          });
        }
      }

      for (const wmsOrderRow of wmsOrderRows) {
        const didWmsAddressChange = wmsAddressChanged(wmsOrderRow, nextShipTo);

        if (didWmsAddressChange && !isFinalOmsState) {
          await handleWmsAddressChange(
            wmsOrderRow.id,
            now,
            shopifyOrder.name || externalOrderId,
          );
        }
      }

      // Update line items if changed
      const newLineItems = (shopifyOrder.line_items || []) as any[];
      if (newLineItems.length > 0) {
        const normalizedLineItems = normalizeShopifyLineItems(
          newLineItems,
          shopifyOrder.discount_applications || [],
          shopifyOrder.order_number,
        );
        const normalizedLineMap = new Map(
          normalizedLineItems.map((line) => [line.externalLineItemId, line]),
        );

        // Get existing OMS lines
        const existingLines = await db
          .select()
          .from(omsOrderLines)
          .where(eq(omsOrderLines.orderId, existing.id));

        const existingLineMap = new Map(
          existingLines.map((l) => [l.externalLineItemId, l]),
        );

        for (const item of newLineItems) {
          const lineId = String(item.id);
          const existingLine = existingLineMap.get(lineId);
          const normalizedLine = normalizedLineMap.get(lineId);

          // Resolve variant
          let productVariantId: number | null = null;
          if (item.sku) {
            const [variant] = await db
              .select({ id: productVariants.id })
              .from(productVariants)
              .where(eq(productVariants.sku, item.sku.toUpperCase()))
              .limit(1);
            if (variant) productVariantId = variant.id;
          }

          if (existingLine) {
            const fulfillmentStatus = mapShopifyLineFulfillmentStatus(
              item,
              shopifyOrder.fulfillment_status,
            );
            // Update existing line
            await db
              .update(omsOrderLines)
              .set({
                sku: item.sku || existingLine.sku,
                title: item.title || existingLine.title,
                quantity: item.quantity ?? existingLine.quantity,
                fulfillableQuantity: Number.isFinite(Number(item.fulfillable_quantity))
                  ? Number(item.fulfillable_quantity)
                  : existingLine.fulfillableQuantity,
                fulfillmentStatus,
                requiresShipping: normalizedLine?.requiresShipping ?? item.requires_shipping ?? existingLine.requiresShipping,
                paidPriceCents: normalizedLine?.paidPriceCents ?? existingLine.paidPriceCents,
                retailPriceCents: normalizedLine?.retailPriceCents ?? existingLine.retailPriceCents,
                totalPriceCents: normalizedLine?.totalCents ?? existingLine.totalPriceCents,
                totalDiscountCents: normalizedLine?.discountCents ?? (item.total_discount ? dollarsToCents(item.total_discount) : 0),
                planDiscountCents: normalizedLine?.planDiscountCents ?? existingLine.planDiscountCents,
                couponDiscountCents: normalizedLine?.couponDiscountCents ?? existingLine.couponDiscountCents,
                productVariantId: productVariantId || existingLine.productVariantId,
              })
              .where(eq(omsOrderLines.id, existingLine.id));
          } else {
            const fulfillmentStatus = mapShopifyLineFulfillmentStatus(
              item,
              shopifyOrder.fulfillment_status,
            );
            // Insert new line
            await db.insert(omsOrderLines).values({
              orderId: existing.id,
              productVariantId,
              externalLineItemId: lineId,
              sku: item.sku,
              title: item.title,
              variantTitle: item.variant_title,
              name: normalizedLine?.name ?? item.name ?? item.title,
              vendor: normalizedLine?.vendor ?? item.vendor,
              externalProductId: normalizedLine?.externalProductId ?? (item.product_id ? String(item.product_id) : null),
              quantity: item.quantity || 1,
              fulfillableQuantity: Number.isFinite(Number(item.fulfillable_quantity))
                ? Number(item.fulfillable_quantity)
                : null,
              fulfillmentStatus,
              requiresShipping: normalizedLine?.requiresShipping ?? item.requires_shipping ?? true,
              paidPriceCents: normalizedLine?.paidPriceCents ?? 0,
              retailPriceCents: normalizedLine?.retailPriceCents ?? 0,
              totalPriceCents: normalizedLine?.totalCents ?? 0,
              totalDiscountCents: normalizedLine?.discountCents ?? (item.total_discount ? dollarsToCents(item.total_discount) : 0),
              planDiscountCents: normalizedLine?.planDiscountCents ?? 0,
              couponDiscountCents: normalizedLine?.couponDiscountCents ?? 0,
            }).onConflictDoNothing();
          }
        }

        // Zero-out OMS lines that were removed from the Shopify order
        const shopifyLineIds = new Set(newLineItems.map((item: any) => String(item.id)));
        for (const existingLine of existingLines) {
          if (existingLine.externalLineItemId && !shopifyLineIds.has(existingLine.externalLineItemId)) {
            if ((existingLine.quantity || 0) > 0) {
              await db
                .update(omsOrderLines)
                .set({ quantity: 0 })
                .where(eq(omsOrderLines.id, existingLine.id));
              console.log(
                `${LOG_PREFIX} Zeroed removed OMS line ${existingLine.externalLineItemId} (SKU: ${existingLine.sku}) for order ${shopifyOrder.name || externalOrderId}`,
              );
            }
          }
        }

        // Update WMS order items if they exist
        if (wmsOrderRows.length > 0) {
          if (isFinalOmsState) {
            console.log(
              `${LOG_PREFIX} orders/updated skipped WMS reconcile for final order ${shopifyOrder.name || externalOrderId}`,
            );
          } else if (wmsSyncService) {
            await ensureOmsOrderQueuedForWmsSync(
              wmsSyncService,
              existing.id,
              shopifyOrder.name || externalOrderId,
            );
            // Propagate line item edits (qty changes, new items, removed items) to WMS
            try {
              const propagation = await wmsSyncService.propagateOmsEditsToWms(
                existing.id,
                newLineItems,
              );
              if (propagation.updated > 0 || propagation.added > 0 || propagation.removed > 0) {
                console.log(
                  `${LOG_PREFIX} Propagated edits to WMS order ${wmsOrderRows[0].id}: ` +
                  `${propagation.updated} updated, ${propagation.added} added, ${propagation.removed} removed`,
                );
              }
              if (propagation.flaggedForReview.length > 0) {
                console.warn(
                  `${LOG_PREFIX} Order ${shopifyOrder.name || externalOrderId} has items needing manual review:`,
                  propagation.flaggedForReview,
                );
              }
            } catch (propErr: any) {
              console.error(
                `${LOG_PREFIX} WMS edit propagation failed for order ${shopifyOrder.name || externalOrderId}: ${propErr.message}`,
              );
            }
          } else {
            await enqueueOmsWmsSyncRetry(
              db,
              existing.id,
              new Error("orders/updated could not reconcile WMS lines because wmsSyncService is unavailable"),
            );
          }
        } else if (!isFinalOmsState && (shopifyOrder.financial_status === "paid" || shopifyOrder.financial_status === "partially_paid")) {
          if (wmsSyncService) {
            await ensureOmsOrderQueuedForWmsSync(
              wmsSyncService,
              existing.id,
              shopifyOrder.name || externalOrderId,
            );
          } else {
            await enqueueOmsWmsSyncRetry(
              db,
              existing.id,
              new Error("orders/updated saw paid shippable work but wmsSyncService is unavailable"),
            );
          }
        }
      }

      // Log event
      await db.insert(omsOrderEvents).values({
        orderId: existing.id,
        eventType: "updated",
        details: {
          source: "shopify_webhook",
          financialStatus: shopifyOrder.financial_status,
          fulfillmentStatus: shopifyOrder.fulfillment_status,
        },
      });

      console.log(`${LOG_PREFIX} ✅ Updated order ${shopifyOrder.name} (OMS id=${existing.id})`);
      pushToMissionControl(existing.id, "order.updated");

      // M18: Trigger real-time backfill bridge
      await db.execute(sql`NOTIFY shopify_order_ingested`);
      await markInboxSucceeded(inbox.receipt);
      acknowledgeProcessed(req, res);
    } catch (err: any) {
      console.error(`${LOG_PREFIX} orders/updated error for ${shopifyOrder.name}: ${err.message}`);
      await markInboxFailed(inbox.receipt, err);
      await handleProcessingFailure(req, res, {
        provider: "shopify",
        topic: "orders/updated",
        payload: shopifyOrder,
        error: err,
        sourceInboxId: inbox.receipt.id,
      });
    }
  });

  // =========================================================================
  // 3. POST /api/oms/webhooks/orders/cancelled
  // =========================================================================
  app.post("/api/oms/webhooks/orders/cancelled", webhookLimiter, async (req: Request, res: Response) => {
    const shopifyOrder = verifyAndParse(req, res);
    if (!shopifyOrder) return;

    const inbox = await receiveShopifyWebhook(req, res, "orders/cancelled", shopifyOrder);
    if (!inbox || !inbox.shouldProcess) return;

    acknowledgeAccepted(req, res);

    const externalOrderId = getExternalOrderId(shopifyOrder);
    console.log(`${LOG_PREFIX} orders/cancelled → ${shopifyOrder.name || externalOrderId}`);

    try {
      const channelId = await getChannelId(req, shopifyOrder);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Find or create existing OMS order via ingestOrder
      const orderData = mapShopifyOrderToOrderData(shopifyOrder);
      const existing = await omsService.ingestOrder(channelId, externalOrderId, orderData);

      if (existing.status === "cancelled") {
        console.log(`${LOG_PREFIX} Order ${shopifyOrder.name} already cancelled`);
        await markInboxSucceeded(inbox.receipt);
        acknowledgeProcessed(req, res);
        return;
      }

      const now = new Date();

      // Update OMS order
      await db
        .update(omsOrders)
        .set({
          status: "cancelled",
          cancelledAt: now,
          financialStatus: shopifyOrder.financial_status || existing.financialStatus,
          updatedAt: now,
        })
        .where(eq(omsOrders.id, existing.id));

      await cancelOrderCascade(db, existing.id, {
        wmsServices,
        shipStationService,
        source: "shopify_cancel_webhook",
        reason: shopifyOrder.cancel_reason || "cancelled_by_shopify",
        logPrefix: LOG_PREFIX,
      });

      console.log(`${LOG_PREFIX} ✅ Cancelled order ${shopifyOrder.name} (OMS id=${existing.id})`);
      pushToMissionControl(existing.id, "order.cancelled");

      // M18: Trigger real-time backfill bridge
      await db.execute(sql`NOTIFY shopify_order_ingested`);
      await markInboxSucceeded(inbox.receipt);
      acknowledgeProcessed(req, res);
    } catch (err: any) {
      console.error(`${LOG_PREFIX} orders/cancelled error for ${shopifyOrder.name}: ${err.message}`);
      await markInboxFailed(inbox.receipt, err);
      await handleProcessingFailure(req, res, {
        provider: "shopify",
        topic: "orders/cancelled",
        payload: shopifyOrder,
        error: err,
        sourceInboxId: inbox.receipt.id,
      });
    }
  });

  // =========================================================================
  // 4. POST /api/oms/webhooks/orders/fulfilled
  // =========================================================================
  app.post("/api/oms/webhooks/orders/fulfilled", webhookLimiter, async (req: Request, res: Response) => {
    const shopifyOrder = verifyAndParse(req, res);
    if (!shopifyOrder) return;

    const inbox = await receiveShopifyWebhook(req, res, "orders/fulfilled", shopifyOrder);
    if (!inbox || !inbox.shouldProcess) return;

    acknowledgeAccepted(req, res);

    const externalOrderId = getExternalOrderId(shopifyOrder);
    console.log(`${LOG_PREFIX} orders/fulfilled → ${shopifyOrder.name || externalOrderId}`);

    try {
      const channelId = await getChannelId(req, shopifyOrder);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Find or create existing OMS order via ingestOrder
      const orderData = mapShopifyOrderToOrderData(shopifyOrder);
      const existing = await omsService.ingestOrder(channelId, externalOrderId, orderData);

      if (existing.status === "shipped") {
        console.log(`${LOG_PREFIX} Order ${shopifyOrder.name} already shipped`);
        await markInboxSucceeded(inbox.receipt);
        acknowledgeProcessed(req, res);
        return;
      }

      // Extract tracking from fulfillments
      const fulfillments = shopifyOrder.fulfillments || [];
      const latestFulfillment = fulfillments[fulfillments.length - 1];
      const trackingNumber = latestFulfillment?.tracking_number || null;
      const carrier = latestFulfillment?.tracking_company || null;
      const now = new Date();

      // Find WMS order
      const wmsOrder = await db.execute<{ id: number }>(sql`
        SELECT id FROM wms.orders
        WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(existing.id)})
           OR (source = 'shopify' AND source_table_id = ${String(existing.id)})
        LIMIT 1
      `);

      if (wmsOrder.rows.length > 0 && trackingNumber) {
        // Flow through WMS shipment cascade — same path as SHIP_NOTIFY V2.
        // This handles labels bought in Shopify instead of ShipStation.
        await applyChannelFulfillment(db, wmsOrder.rows[0].id, {
          trackingNumber,
          carrier: carrier || "other",
          shipDate: now,
          source: "shopify_fulfilled_webhook",
          sourceFulfillmentId: latestFulfillment?.id ? String(latestFulfillment.id) : null,
        });
      } else {
        // No WMS order or no tracking — update OMS directly
        await db
          .update(omsOrders)
          .set({
            status: "shipped",
            fulfillmentStatus: "fulfilled",
            trackingNumber,
            trackingCarrier: carrier,
            shippedAt: now,
            updatedAt: now,
          })
          .where(eq(omsOrders.id, existing.id));

        await db
          .update(omsOrderLines)
          .set({ fulfillmentStatus: "fulfilled" })
          .where(eq(omsOrderLines.orderId, existing.id));

        if (wmsOrder.rows.length > 0) {
          const { markOrderShipped } = await import("../orders/order-status-core");
          await markOrderShipped(db, wmsOrder.rows[0].id, "shopify_fulfilled_webhook");
        }

        await db.insert(omsOrderEvents).values({
          orderId: existing.id,
          eventType: "shipped",
          details: {
            source: "shopify_fulfilled_webhook",
            trackingNumber,
            carrier,
            fulfillmentId: latestFulfillment?.id,
          },
        });
      }

      // Mirror to ShipStation so the order leaves Awaiting Shipment.
      if (shipStationService?.isConfigured() && existing.shipstationOrderId) {
        try {
          await shipStationService.markAsShipped(existing.shipstationOrderId, {
            shipDate: now,
            trackingNumber,
            carrierCode: carrier?.toLowerCase() || "other",
            notifyCustomer: false,
          });
        } catch (err: any) {
          console.error(`${LOG_PREFIX} ShipStation markAsShipped failed for ${shopifyOrder.name}: ${err.message}`);
        }
      }

      console.log(`${LOG_PREFIX} ✅ Fulfilled order ${shopifyOrder.name} (tracking: ${trackingNumber || "none"})`);
      pushToMissionControl(existing.id, "order.fulfilled");

      // M18: Trigger real-time backfill bridge
      await db.execute(sql`NOTIFY shopify_order_ingested`);
      await markInboxSucceeded(inbox.receipt);
      acknowledgeProcessed(req, res);
    } catch (err: any) {
      console.error(`${LOG_PREFIX} orders/fulfilled error for ${shopifyOrder.name}: ${err.message}`);
      await markInboxFailed(inbox.receipt, err);
      await handleProcessingFailure(req, res, {
        provider: "shopify",
        topic: "orders/fulfilled",
        payload: shopifyOrder,
        error: err,
        sourceInboxId: inbox.receipt.id,
      });
    }
  });

  // =========================================================================
  // 5. POST /api/oms/webhooks/refunds/create
  // =========================================================================
  app.post("/api/oms/webhooks/refunds/create", async (req: Request, res: Response) => {
    const refundPayload = verifyAndParse(req, res);
    if (!refundPayload) return;

    const inbox = await receiveShopifyWebhook(req, res, "refunds/create", refundPayload);
    if (!inbox || !inbox.shouldProcess) return;

    acknowledgeAccepted(req, res);

    // Shopify refund payload has order_id at top level
    const shopifyOrderId = refundPayload.order_id;
    const shopifyOrderGid = `gid://shopify/Order/${shopifyOrderId}`;
    console.log(`${LOG_PREFIX} refunds/create → order ${shopifyOrderId}`);

    try {
      const channelId = await getChannelId(req, refundPayload);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Find OMS order — try GID first, then numeric ID
      let existing = await db
        .select()
        .from(omsOrders)
        .where(
          and(
            eq(omsOrders.channelId, channelId),
            eq(omsOrders.externalOrderId, shopifyOrderGid),
          ),
        )
        .limit(1)
        .then((r: any[]) => r[0]);

      if (!existing) {
        existing = await db
          .select()
          .from(omsOrders)
          .where(
            and(
              eq(omsOrders.channelId, channelId),
              eq(omsOrders.externalOrderId, String(shopifyOrderId)),
            ),
          )
          .limit(1)
          .then((r: any[]) => r[0]);
      }

      if (!existing) {
        console.log(`${LOG_PREFIX} Order ${shopifyOrderId} not in OMS, skipping refund`);
        await markInboxSucceeded(inbox.receipt);
        acknowledgeProcessed(req, res);
        return;
      }

      const now = new Date();

      // Determine financial status
      const refundLineItems = refundPayload.refund_line_items || [];
      const omsLines = await db
        .select()
        .from(omsOrderLines)
        .where(eq(omsOrderLines.orderId, existing.id));

      // Check if full or partial refund
      const totalOrderQty = omsLines.reduce((s: number, l: any) => s + l.quantity, 0);
      const refundedQty = refundLineItems.reduce((s: number, l: any) => s + (l.quantity || 0), 0);
      const financialStatus = refundedQty >= totalOrderQty ? "refunded" : "partially_refunded";

      // Compute refund amount from Shopify transactions (authoritative source)
      const transactions: any[] = Array.isArray(refundPayload.transactions) ? refundPayload.transactions : [];
      const thisRefundCents = transactions.reduce(
        (sum: number, t: any) => sum + dollarsToCents(t.amount),
        0,
      );

      // Per-refund idempotency: the financial update below is INCREMENTAL
      // (prior + this), so a replayed/retried refunds/create webhook must not
      // re-add the same refund. The 'refunded' event row (written in the same
      // transaction as the update) is the marker — keyed by Shopify refund id.
      const refundAlreadyApplied: any = await db.execute(sql`
        SELECT 1 FROM oms.oms_order_events
        WHERE order_id = ${existing.id}
          AND event_type = 'refunded'
          AND details->>'refundId' = ${String(refundPayload.id)}
        LIMIT 1
      `);

      if ((refundAlreadyApplied?.rows?.length ?? 0) > 0) {
        console.log(
          `${LOG_PREFIX} refund ${refundPayload.id} already applied to order ${existing.externalOrderNumber} — skipping financial update, re-running cascade only`,
        );
      } else {
        const priorRefundCents = existing.refundAmountCents ?? 0;
        const newRefundAmountCents = priorRefundCents + thisRefundCents;

        // One transaction: financial update + its idempotency marker commit
        // together, so a crash between them cannot leave a counted-but-
        // unmarked refund that a later retry would double-count.
        await db.transaction(async (tx: any) => {
          await tx
            .update(omsOrders)
            .set({
              financialStatus,
              refundedAt: now,
              refundAmountCents: newRefundAmountCents,
              updatedAt: now,
            })
            .where(eq(omsOrders.id, existing.id));

          await tx.insert(omsOrderEvents).values({
            orderId: existing.id,
            eventType: "refunded",
            details: {
              source: "shopify_webhook",
              refundId: refundPayload.id,
              financialStatus,
              refundedLineItems: refundLineItems.length,
              restockedItems: refundLineItems.filter((li: any) => li.restock === true).length,
              totalRefundAmount: refundPayload.transactions?.reduce(
                (sum: number, t: any) => sum + parseFloat(t.amount || "0"), 0
              ),
            },
          });
        });
      }

      // C29 — record the refund as a wms.returns row (audit trail) and
      // optionally restock. The WMS-side cascade is owned by
      // `applyShopifyRefundCascade`; the existing reservation-release is
      // wired in as the restock hook so behaviour parity with prior
      // commits is preserved. A cascade failure propagates to the outer
      // catch, which queues a retry; that retry skips the financial update
      // (guarded by the 'refunded' event marker above) and re-attempts only
      // this cascade, which is idempotent (returns keyed by
      // refund_external_id, adjustments ON CONFLICT DO NOTHING).
      const cascade = await applyShopifyRefundCascade(
        db,
        refundPayload,
        {
          // OMS already resolved above — short-circuit the helper.
          resolveOmsOrder: async () => ({ id: existing.id }),
          restock: wmsServices
            ? async (_db, ctx) => {
                await wmsServices.reservation.releaseOrderReservation(
                  ctx.wmsOrderId,
                  `Refund restock (${ctx.refundLineItems.length} items, refund=${ctx.refundPayload.id})`,
                );
                console.log(
                  `${LOG_PREFIX} Released reservations for restocked items in order ${existing.externalOrderNumber}`,
                );
              }
            : undefined,
          shipstation: shipStationService
            ? {
                cancelOrder: async (shipstationOrderId: number) => {
                  await shipStationService.cancelOrder(shipstationOrderId);
                },
              }
            : undefined,
          shippingEngine: shippingEngine ?? undefined,
          pushShipment:
            shipStationService?.isConfigured() && typeof shipStationService.pushShipment === "function"
              ? async (shipmentId: number) => {
                  try {
                    await shipStationService!.pushShipment!(shipmentId);
                  } catch (err: any) {
                    await enqueueShipStationShipmentPushRetry(
                      db,
                      shipmentId,
                      err instanceof Error ? err : new Error(err?.message ?? String(err)),
                    );
                  }
                }
              : undefined,
        },
        { channelId, now, logPrefix: LOG_PREFIX },
      );
      console.log(
        `${LOG_PREFIX} refunds/create cascade for order ${existing.externalOrderNumber}: ` +
          `outcome=${cascade.outcome} restocked=${cascade.restocked} ` +
          `restockInvoked=${cascade.restockInvoked} shipmentId=${cascade.shipmentId ?? "null"} ` +
          `adjustedLines=${cascade.adjustedLines ?? 0} cancelled=${cascade.cancelledShipments ?? 0} ` +
            `repushed=${cascade.repushedShipments ?? 0} flagged=${cascade.flaggedShipments ?? 0}`,
      );

      console.log(`${LOG_PREFIX} ✅ Processed refund for order ${existing.externalOrderNumber} → ${financialStatus}`);
      pushToMissionControl(existing.id, "order.refunded");
      await markInboxSucceeded(inbox.receipt);
      acknowledgeProcessed(req, res);
    } catch (err: any) {
      console.error(`${LOG_PREFIX} refunds/create error for order ${shopifyOrderId}: ${err.message}`);
      await markInboxFailed(inbox.receipt, err);
      await handleProcessingFailure(req, res, {
        provider: "shopify",
        topic: "refunds/create",
        payload: refundPayload,
        error: err,
        sourceInboxId: inbox.receipt.id,
      });
    }
  });

  console.log(`${LOG_PREFIX} Registered 5 webhook endpoints`);
}
